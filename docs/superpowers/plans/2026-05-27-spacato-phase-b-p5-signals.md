# P5 Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Persona:** every worker adopts the canonical role prompt (WORKFLOW.md / HANDOFF.md §0): senior systems designer, isolation-and-clarity, heuristics-first, real-tested-work-only.
>
> **Branch:** work on `p5-signals` (already checked out). No worktree needed — it is already the isolated feature branch.

**Goal:** Build Spacato's P5 news/signals subsystem — an online ESC loop that fetches verified-feed items per goal, scores their relevance (keyword heuristic + batched LLM judge), stores all of them, and raises deduplicated alerts for high-impact items, exposed via `POST /api/signals`.

**Architecture:** Heuristics-first. Deterministic code does fetch-safety, keyword scoring, thresholding, dedup, and the ESC composable-primitive loop (`score`/`select`/`evolve` — never `step()`/`runToConvergence()`). The LLM is invoked only, always batched + cached, for: genome operators (seed/crossover/mutate), per-item relevance judging, and alert justification. ESC genome state persists per goal so query strategies drift across cycles. All LLM traffic routes through the existing `llm-gateway`; the OpenRouter key stays server-side.

**Tech Stack:** Next.js 14 (TS), SQLite (`better-sqlite3`), Zod, the existing `@/lib/esc/core` primitives and `@/lib/llm/gateway`. Tests: Vitest with `openDb(":memory:")` and the injected-`fetchFn` recorded-response pattern.

**Spec:** `docs/superpowers/specs/2026-05-27-p5-signals-design.md` (approved). Section refs below (e.g. §5.9) point into it.

---

## File Structure

All new P5 code lives in `src/lib/p5/` plus the route. Store changes go into the **existing** store layer (HANDOFF + spec §4: the two repos are added to `makeRepositories()`, not a parallel repositories file).

| File | Responsibility | New/Modified |
|------|----------------|--------------|
| `src/lib/p5/types.ts` | All P5 domain types: `SourceKey`, `FeedKind`, `FeedItem`, `FeedItemPayload`, `ScoredItem`, `QueryTerm`, `QueryGenome`, `StoredSignal`, `Alert`. Pure type module — no runtime logic, no tests. | Create |
| `src/lib/store/schema.sql` | Add `genome_id` column to `external_signal`; add `query_genome_state` table. | Modify |
| `src/lib/store/repositories.ts` | Add `signals`, `alerts`, `queryGenomeState` repos to `makeRepositories()`; export `Repositories` type. | Modify |
| `src/lib/p5/sources.ts` | HTTPS allow-list (`SOURCES`), per-source `buildUrl` + Zod `responseSchema` + `normalise`. Startup HTTPS assertion. | Create |
| `src/lib/p5/feed-ingest.ts` | Safe fetch per `QueryTerm` (allow-list, HTTPS, timeout, schema-validate, normalise). | Create |
| `src/lib/p5/relevance.ts` | `extractKeywords`, `keywordScore`, keyword gate, batched LLM judge, `finalScore`. | Create |
| `src/lib/p5/genome.ts` | `queryGenomeSchema` (Zod) + `makeGenomeOperators` (seed/crossover/mutate, fresh `randomUUID` ids). | Create |
| `src/lib/p5/esc-adapter.ts` | The online cycle (`runCycle`) + ESC pieces: `selectTop`, `engagementFactor`, `GENOME_PRIOR_SCORE`, fitness with carry-forward. **Review point.** | Create |
| `src/lib/p5/alert-logic.ts` | `ALERT_THRESHOLD`, dedup (`existsOpen` + content-level), batched justification, alert creation. | Create |
| `src/app/api/signals/route.ts` | `POST` wrapper: composes deps and calls `runCycle`. Re-exports `runCycle`. | Create |

**Import graph (locked here; deviates from spec §3 where noted).** Spec §3 says "no file imports another P5 file except esc-adapter→genome and route." That is aspirational; the real, minimal graph is:

- `types.ts` — imported by everyone; depends only on `@/lib/esc/core` (for `Genome`/`EscState`).
- `sources.ts` → `types.ts`.
- `feed-ingest.ts` → `sources.ts`, `types.ts`.
- `relevance.ts` → `types.ts`, `@/lib/store/types` (`GoalInterpretation`), gateway types.
- `genome.ts` → `types.ts`, `sources.ts` (source descriptions for prompts).
- `esc-adapter.ts` → `types.ts`, `@/lib/esc/core`, `@/lib/store/repositories` (the `Repositories` type). It receives `ingest`/`scoreItems`/`raiseAlerts`/`ops` as **injected closures** (clean DI seam), so it does NOT statically import feed-ingest/relevance/alert-logic/genome.
- `alert-logic.ts` → `types.ts`, `@/lib/store/types`, gateway types.
- `route.ts` → wires everything (the one place all modules meet).
- `store/repositories.ts` → imports `QueryGenome`, `StoredSignal`, `Alert` from `@/lib/p5/types` (it already imports from `@/lib/esc/core`, so one more type import is consistent).

**DI rationale:** `runCycle` takes `ingest`, `scoreItems`, `raiseAlerts`, and `ops` as injected functions. This keeps the ESC orchestration unit-testable with deterministic stubs (no recorded-fetch gymnastics across five different schemas) and is the project's established "mocks only at true seams" pattern.

---

## Shared type reference (Task 1 creates these — every later task imports them)

```ts
// src/lib/p5/types.ts
import type { Genome, EscState } from "@/lib/esc/core";

export type SourceKey = "newsapi" | "openweather" | "alphavantage";
export type FeedKind = "news" | "weather" | "market";

export interface FeedItem {
  id: string;            // source-assigned unique id (url for news/market, name-dt for weather)
  source: SourceKey;
  kind: FeedKind;
  title: string;
  summary: string;
  publishedAt: string;   // ISO datetime
  url?: string;
  rawPayload: unknown;
}

export type FeedItemPayload = FeedItem;   // the normalised FeedItem is what we persist

export interface ScoredItem {
  item: FeedItem;
  keywordScore: number;     // [0,1]
  llmScore: number | null;  // [0,1], null if it did not pass the keyword gate
  finalScore: number;       // 0.3*keyword + 0.7*llm, or keywordScore if llm null
}

export interface QueryTerm {
  source: SourceKey;
  terms: string[];   // 1-5 terms
  weight: number;
}

export interface QueryGenome {
  id: string;            // stable uuid; minted at seed/crossover/mutate; never reused
  queries: QueryTerm[];  // 2-6 entries
}

export interface StoredSignal {
  id: number;
  goalId: number;
  genomeId: string;
  source: string;
  kind: FeedKind;
  payload: FeedItemPayload;
  relevanceScore: number | null;
  fetchedAt: string;
}

export interface Alert {
  id: number;
  signalId: number;
  goalId: number;
  impactScore: number;
  message: string;
  createdAt: string;
  acknowledged: boolean;
}

// Re-export for downstream convenience
export type { Genome, EscState };
```

There is nothing to test in a pure-type module; later tasks exercise the types through real code.

---

## Task 1: P5 shared types + store layer (schema, repos)

**Files:**
- Create: `src/lib/p5/types.ts` (content above, verbatim)
- Modify: `src/lib/store/schema.sql`
- Modify: `src/lib/store/repositories.ts`
- Test: `tests/p5/repositories.test.ts`

**Context:** The store follows a fixed pattern (see `src/lib/store/repositories.ts`): a standalone `getX(db, id)` helper used by both `create` and `get` (so `create` never calls `this.get`), `makeRepositories(db)` returning an object of sub-repos, and every mutation throwing when `info.changes === 0`. Tests use `makeRepositories(openDb(":memory:"))`. `openDb` runs `schema.sql` with `IF NOT EXISTS`, so additive schema changes are safe. `query_genome_state` is keyed by `goal_id` (one row per goal) and stores a JSON-serialised `EscState<QueryGenome>` (which round-trips through `JSON.parse(JSON.stringify())` losslessly — plain objects only, per spec §4.3).

- [ ] **Step 1: Create `src/lib/p5/types.ts`**

Create the file with the exact content from the "Shared type reference" section above.

- [ ] **Step 2: Modify `src/lib/store/schema.sql`**

Add `genome_id` to the `external_signal` table and append the `query_genome_state` table. The new `external_signal` block becomes:

```sql
CREATE TABLE IF NOT EXISTS external_signal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  genome_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  relevance_score REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

And append at the end of the file:

```sql
CREATE TABLE IF NOT EXISTS query_genome_state (
  goal_id    INTEGER PRIMARY KEY REFERENCES goal(id),
  state_json TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 3: Write the failing test** at `tests/p5/repositories.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import type { FeedItem, QueryGenome } from "@/lib/p5/types";
import type { EscState } from "@/lib/esc/core";

const feed = (id: string): FeedItem => ({
  id, source: "newsapi", kind: "news", title: "t", summary: "s",
  publishedAt: "2026-05-27T00:00:00Z", url: "https://x/" + id, rawPayload: {},
});

describe("p5 store repositories", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  function goal() { return repos.goals.create({ title: "g", rawText: "g" }).id; }

  it("creates and lists signals newest-first", () => {
    const g = goal();
    const a = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: 0.4 });
    const b = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("b"), relevanceScore: 0.9 });
    expect(a.id).toBeTypeOf("number");
    const list = repos.signals.listForGoal(g);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[0].payload.id).toBe("b");
    expect(list[0].genomeId).toBe("G1");
  });

  it("updateRelevance changes the score and throws on a missing row", () => {
    const g = goal();
    const s = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: null });
    repos.signals.updateRelevance(s.id, 0.8);
    expect(repos.signals.listForGoal(g)[0].relevanceScore).toBe(0.8);
    expect(() => repos.signals.updateRelevance(99999, 0.1)).toThrow();
  });

  it("creates alerts, lists only open ones, acknowledges, and dedups via existsOpen", () => {
    const g = goal();
    const s = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: 0.9 });
    const al = repos.alerts.create({ signalId: s.id, goalId: g, impactScore: 0.9, message: "m" });
    expect(repos.alerts.existsOpen(g, s.id)).toBe(true);
    expect(repos.alerts.listOpen(g).map((a) => a.id)).toEqual([al.id]);
    repos.alerts.acknowledge(al.id);
    expect(repos.alerts.listOpen(g)).toHaveLength(0);
    expect(repos.alerts.existsOpen(g, s.id)).toBe(false);
    expect(() => repos.alerts.acknowledge(99999)).toThrow();
  });

  it("engagementCounts joins alert->signal on genome_id with Laplace-friendly zeros", () => {
    const g = goal();
    const s1 = repos.signals.create({ goalId: g, genomeId: "GA", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: 0.9 });
    const s2 = repos.signals.create({ goalId: g, genomeId: "GA", source: "newsapi", kind: "news", payload: feed("b"), relevanceScore: 0.9 });
    const a1 = repos.alerts.create({ signalId: s1.id, goalId: g, impactScore: 0.9, message: "m" });
    repos.alerts.create({ signalId: s2.id, goalId: g, impactScore: 0.9, message: "m" });
    repos.alerts.acknowledge(a1.id);
    expect(repos.alerts.engagementCounts("GA")).toEqual({ acked: 1, total: 2 });
    expect(repos.alerts.engagementCounts("UNKNOWN")).toEqual({ acked: 0, total: 0 });
  });

  it("queryGenomeState round-trips and upserts", () => {
    const g = goal();
    expect(repos.queryGenomeState.get(g)).toBeNull();
    const genome: QueryGenome = { id: "G1", queries: [{ source: "newsapi", terms: ["x"], weight: 1 }] };
    const state: EscState<QueryGenome> = { population: [{ value: genome }], scores: [0.1], generation: 0, bestScore: 0.1 };
    repos.queryGenomeState.save(g, state);
    expect(repos.queryGenomeState.get(g)).toEqual(state);
    const next: EscState<QueryGenome> = { ...state, generation: 1, bestScore: 0.5, scores: [0.5] };
    repos.queryGenomeState.save(g, next);
    expect(repos.queryGenomeState.get(g)!.generation).toBe(1);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/p5/repositories.test.ts`
Expected: FAIL — `repos.signals` (etc.) is undefined.

- [ ] **Step 5: Implement the repos in `src/lib/store/repositories.ts`**

Add these imports at the top (alongside the existing ones):

```ts
import type { EscState } from "@/lib/esc/core";
import type { QueryGenome, StoredSignal, Alert, FeedItemPayload, FeedKind } from "@/lib/p5/types";
```

Add these standalone helpers near the existing `getGoal`/`getElicitation` helpers:

```ts
function rowToSignal(row: any): StoredSignal {
  return {
    id: row.id,
    goalId: row.goal_id,
    genomeId: row.genome_id,
    source: row.source,
    kind: row.kind as FeedKind,
    payload: JSON.parse(row.payload_json) as FeedItemPayload,
    relevanceScore: row.relevance_score,
    fetchedAt: row.fetched_at,
  };
}

function rowToAlert(row: any): Alert {
  return {
    id: row.id,
    signalId: row.signal_id,
    goalId: row.goal_id,
    impactScore: row.impact_score,
    message: row.message,
    createdAt: row.created_at,
    acknowledged: row.acknowledged === 1,
  };
}
```

Inside the object returned by `makeRepositories`, add three properties after `elicitations`:

```ts
    signals: {
      create(input: {
        goalId: number;
        genomeId: string;
        source: string;
        kind: FeedKind;
        payload: FeedItemPayload;
        relevanceScore: number | null;
      }): StoredSignal {
        const info = db
          .prepare(
            "INSERT INTO external_signal (goal_id, genome_id, source, kind, payload_json, relevance_score) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(
            input.goalId,
            input.genomeId,
            input.source,
            input.kind,
            JSON.stringify(input.payload),
            input.relevanceScore
          );
        const row = db.prepare("SELECT * FROM external_signal WHERE id = ?").get(Number(info.lastInsertRowid));
        if (!row) throw new Error(`signals.create: insert ${info.lastInsertRowid} could not be read back`);
        return rowToSignal(row);
      },
      listForGoal(goalId: number, limit?: number): StoredSignal[] {
        const rows =
          limit != null
            ? db.prepare("SELECT * FROM external_signal WHERE goal_id = ? ORDER BY id DESC LIMIT ?").all(goalId, limit)
            : db.prepare("SELECT * FROM external_signal WHERE goal_id = ? ORDER BY id DESC").all(goalId);
        return (rows as any[]).map(rowToSignal);
      },
      updateRelevance(id: number, relevanceScore: number): void {
        const info = db.prepare("UPDATE external_signal SET relevance_score = ? WHERE id = ?").run(relevanceScore, id);
        if (info.changes === 0) throw new Error(`signals.updateRelevance: no row with id ${id}`);
      },
    },
    alerts: {
      create(input: { signalId: number; goalId: number; impactScore: number; message: string }): Alert {
        const info = db
          .prepare("INSERT INTO alert (signal_id, goal_id, impact_score, message) VALUES (?, ?, ?, ?)")
          .run(input.signalId, input.goalId, input.impactScore, input.message);
        const row = db.prepare("SELECT * FROM alert WHERE id = ?").get(Number(info.lastInsertRowid));
        if (!row) throw new Error(`alerts.create: insert ${info.lastInsertRowid} could not be read back`);
        return rowToAlert(row);
      },
      listOpen(goalId: number): Alert[] {
        const rows = db.prepare("SELECT * FROM alert WHERE goal_id = ? AND acknowledged = 0 ORDER BY id DESC").all(goalId);
        return (rows as any[]).map(rowToAlert);
      },
      acknowledge(id: number): void {
        const info = db.prepare("UPDATE alert SET acknowledged = 1 WHERE id = ?").run(id);
        if (info.changes === 0) throw new Error(`alerts.acknowledge: no row with id ${id}`);
      },
      existsOpen(goalId: number, signalId: number): boolean {
        const row = db
          .prepare("SELECT 1 FROM alert WHERE goal_id = ? AND signal_id = ? AND acknowledged = 0 LIMIT 1")
          .get(goalId, signalId);
        return row !== undefined;
      },
      engagementCounts(genomeId: string): { acked: number; total: number } {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN a.acknowledged = 1 THEN 1 ELSE 0 END), 0) AS acked
               FROM alert a JOIN external_signal s ON a.signal_id = s.id
              WHERE s.genome_id = ?`
          )
          .get(genomeId) as any;
        return { acked: Number(row.acked ?? 0), total: Number(row.total ?? 0) };
      },
    },
    queryGenomeState: {
      get(goalId: number): EscState<QueryGenome> | null {
        const row = db.prepare("SELECT state_json FROM query_genome_state WHERE goal_id = ?").get(goalId) as any;
        return row ? (JSON.parse(row.state_json) as EscState<QueryGenome>) : null;
      },
      save(goalId: number, state: EscState<QueryGenome>): void {
        db.prepare(
          `INSERT INTO query_genome_state (goal_id, state_json, updated_at)
             VALUES (?, ?, datetime('now'))
           ON CONFLICT(goal_id) DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')`
        ).run(goalId, JSON.stringify(state));
      },
    },
```

Finally, at the very bottom of the file, export the inferred repositories type for downstream DI:

```ts
export type Repositories = ReturnType<typeof makeRepositories>;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/p5/repositories.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 8: Commit**

```bash
git add src/lib/p5/types.ts src/lib/store/schema.sql src/lib/store/repositories.ts tests/p5/repositories.test.ts
git commit -m "feat(p5): shared types + signals/alerts/queryGenomeState repos and schema"
```

---

## Task 2: Feed source allow-list (`sources.ts`)

**Files:**
- Create: `src/lib/p5/sources.ts`
- Test: `tests/p5/sources.test.ts`

**Context:** `sources.ts` is the security boundary's data half: a fixed `Record<SourceKey, SourceConfig>` of vetted HTTPS providers (spec §7, Assumption A5: NewsAPI / OpenWeatherMap / Alpha Vantage NEWS_SENTIMENT). Each config knows how to build its URL, validate its raw JSON response (Zod), and normalise that response into canonical `FeedItem[]`. A module-load assertion guarantees every `baseUrl` is HTTPS. `buildUrl` must URL-encode terms and produce a URL that starts with `baseUrl` (feed-ingest re-checks this in Task 3).

- [ ] **Step 1: Write the failing test** at `tests/p5/sources.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { SOURCES } from "@/lib/p5/sources";

describe("p5 sources allow-list", () => {
  it("every source is HTTPS and buildUrl stays within baseUrl", () => {
    for (const cfg of Object.values(SOURCES)) {
      expect(cfg.baseUrl.startsWith("https://")).toBe(true);
      const url = cfg.buildUrl(["alpha", "beta"], "KEY");
      expect(url.startsWith(cfg.baseUrl)).toBe(true);
      expect(url).toContain("KEY");
    }
  });

  it("newsapi.buildUrl url-encodes the joined query", () => {
    const url = SOURCES.newsapi.buildUrl(["clean", "energy"], "K");
    expect(url).toContain("q=clean%20energy");
  });

  it("newsapi.normalise turns a validated response into FeedItems", () => {
    const raw = {
      status: "ok",
      totalResults: 1,
      articles: [
        { title: "Solar surges", description: "PV deployment up", url: "https://newsapi.org/a/1", publishedAt: "2026-05-20T10:00:00Z", source: { name: "Wire" } },
      ],
    };
    const parsed = SOURCES.newsapi.responseSchema.parse(raw);
    const items = SOURCES.newsapi.normalise(parsed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "https://newsapi.org/a/1", source: "newsapi", kind: "news", title: "Solar surges", summary: "PV deployment up" });
  });

  it("openweather.normalise produces one weather FeedItem", () => {
    const raw = { name: "Exeter", dt: 1716200000, weather: [{ id: 800, main: "Clear", description: "clear sky" }], main: { temp: 289.1 } };
    const parsed = SOURCES.openweather.responseSchema.parse(raw);
    const items = SOURCES.openweather.normalise(parsed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "openweather", kind: "weather", title: "Exeter weather: clear sky" });
  });

  it("alphavantage.normalise maps NEWS_SENTIMENT feed to market FeedItems", () => {
    const raw = { feed: [{ title: "Rates held", summary: "Central bank holds", url: "https://www.alphavantage.co/n/1", time_published: "20260520T100000" }] };
    const parsed = SOURCES.alphavantage.responseSchema.parse(raw);
    const items = SOURCES.alphavantage.normalise(parsed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "alphavantage", kind: "market", title: "Rates held" });
  });

  it("responseSchema rejects malformed payloads", () => {
    expect(() => SOURCES.newsapi.responseSchema.parse({ articles: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/sources.test.ts`
Expected: FAIL — cannot resolve `@/lib/p5/sources`.

- [ ] **Step 3: Implement `src/lib/p5/sources.ts`**

```ts
import { z, type ZodType } from "zod";
import type { SourceKey, FeedKind, FeedItem } from "@/lib/p5/types";

export interface SourceConfig {
  key: SourceKey;
  kind: FeedKind;
  baseUrl: string;
  description: string;
  apiKeyEnvVar: string;
  buildUrl(terms: string[], apiKey: string): string;
  responseSchema: ZodType<any>;
  normalise(raw: any): FeedItem[];
}

// --- NewsAPI (news) ---
const newsApiSchema = z.object({
  status: z.string().optional(),
  totalResults: z.number().optional(),
  articles: z.array(
    z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
      url: z.string(),
      publishedAt: z.string(),
      source: z.object({ name: z.string().nullable().optional() }).optional(),
    })
  ),
});

// --- OpenWeatherMap (weather, current conditions) ---
const openWeatherSchema = z.object({
  name: z.string(),
  dt: z.number(),
  weather: z.array(z.object({ id: z.number(), main: z.string(), description: z.string() })).min(1),
  main: z.object({ temp: z.number() }),
});

// --- Alpha Vantage NEWS_SENTIMENT (market) ---
const alphaVantageSchema = z.object({
  feed: z.array(
    z.object({
      title: z.string(),
      summary: z.string().nullable().optional(),
      url: z.string(),
      time_published: z.string(),
    })
  ),
});

export const SOURCES: Record<SourceKey, SourceConfig> = {
  newsapi: {
    key: "newsapi",
    kind: "news",
    baseUrl: "https://newsapi.org",
    description: "NewsAPI — everything search across global news outlets",
    apiKeyEnvVar: "NEWSAPI_KEY",
    buildUrl: (terms, key) =>
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(terms.join(" "))}&pageSize=5&apiKey=${key}`,
    responseSchema: newsApiSchema,
    normalise: (raw: z.infer<typeof newsApiSchema>): FeedItem[] =>
      raw.articles.map((a) => ({
        id: a.url,
        source: "newsapi",
        kind: "news",
        title: a.title,
        summary: a.description ?? "",
        publishedAt: a.publishedAt,
        url: a.url,
        rawPayload: a,
      })),
  },
  openweather: {
    key: "openweather",
    kind: "weather",
    baseUrl: "https://api.openweathermap.org",
    description: "OpenWeatherMap — current weather conditions for a named location",
    apiKeyEnvVar: "OPENWEATHER_KEY",
    buildUrl: (terms, key) =>
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(terms.join(" "))}&appid=${key}`,
    responseSchema: openWeatherSchema,
    normalise: (raw: z.infer<typeof openWeatherSchema>): FeedItem[] => [
      {
        id: `${raw.name}-${raw.dt}`,
        source: "openweather",
        kind: "weather",
        title: `${raw.name} weather: ${raw.weather[0].description}`,
        summary: `${raw.weather[0].main}, ${(raw.main.temp - 273.15).toFixed(1)}°C in ${raw.name}`,
        publishedAt: new Date(raw.dt * 1000).toISOString(),
        rawPayload: raw,
      },
    ],
  },
  alphavantage: {
    key: "alphavantage",
    kind: "market",
    baseUrl: "https://www.alphavantage.co",
    description: "Alpha Vantage NEWS_SENTIMENT — market and financial news by ticker/topic",
    apiKeyEnvVar: "ALPHAVANTAGE_KEY",
    buildUrl: (terms, key) =>
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(terms.join(","))}&apikey=${key}`,
    responseSchema: alphaVantageSchema,
    normalise: (raw: z.infer<typeof alphaVantageSchema>): FeedItem[] =>
      raw.feed.map((f) => ({
        id: f.url,
        source: "alphavantage",
        kind: "market",
        title: f.title,
        summary: f.summary ?? "",
        publishedAt: f.time_published,
        url: f.url,
        rawPayload: f,
      })),
  },
};

// Startup assertion (spec §7.2): every source must be HTTPS. Runs at module import.
for (const cfg of Object.values(SOURCES)) {
  if (!cfg.baseUrl.startsWith("https://")) {
    throw new Error(`sources.ts: source "${cfg.key}" baseUrl must be HTTPS, got "${cfg.baseUrl}"`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/sources.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/lib/p5/sources.ts tests/p5/sources.test.ts
git commit -m "feat(p5): HTTPS feed allow-list with buildUrl, response schemas, normalisers"
```

---

## Task 3: Safe feed ingestion (`feed-ingest.ts`)

**Files:**
- Create: `src/lib/p5/feed-ingest.ts`
- Test: `tests/p5/feed-ingest.test.ts`

**Context:** `feed-ingest.ts` is the active half of the security boundary (spec §7.2). For each `QueryTerm` it: looks up the `SourceConfig`, reads the API key from an injectable env, builds the URL, asserts the URL starts with `baseUrl` (throws otherwise — guards against a malformed `buildUrl`), fetches with `redirect: "error"` and an 8s `AbortSignal.timeout`, checks `res.ok`, validates the JSON with `responseSchema.safeParse`, and normalises. **Any operational failure (missing key, timeout, non-ok, schema-invalid) is swallowed → returns `[]` and logs a warning; the cycle continues with other sources.** Only an allow-list escape throws. `fetchFn` and `env` are injected for offline tests (mirrors the gateway's `fetchFn` pattern).

- [ ] **Step 1: Write the failing test** at `tests/p5/feed-ingest.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { ingest } from "@/lib/p5/feed-ingest";
import type { QueryTerm } from "@/lib/p5/types";

function okResponse(body: unknown) {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}
const env = { NEWSAPI_KEY: "k", OPENWEATHER_KEY: "k", ALPHAVANTAGE_KEY: "k" } as NodeJS.ProcessEnv;
const newsQuery: QueryTerm = { source: "newsapi", terms: ["solar"], weight: 1 };

describe("feed-ingest", () => {
  it("fetches, validates and normalises a source response", async () => {
    const body = { status: "ok", totalResults: 1, articles: [{ title: "T", description: "D", url: "https://newsapi.org/a", publishedAt: "2026-05-20T00:00:00Z" }] };
    const items = await ingest([newsQuery], { fetchFn: okResponse(body), env });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("T");
    expect(items[0].source).toBe("newsapi");
  });

  it("returns [] (no throw) when the API key is missing", async () => {
    const items = await ingest([newsQuery], { fetchFn: okResponse({}), env: {} as NodeJS.ProcessEnv });
    expect(items).toEqual([]);
  });

  it("returns [] when the response fails schema validation", async () => {
    const items = await ingest([newsQuery], { fetchFn: okResponse({ articles: "bad" }), env });
    expect(items).toEqual([]);
  });

  it("returns [] when the fetch times out / rejects", async () => {
    const items = await ingest([newsQuery], { fetchFn: async () => { throw new Error("timeout"); }, env });
    expect(items).toEqual([]);
  });

  it("returns [] on a non-ok HTTP status", async () => {
    const items = await ingest([newsQuery], { fetchFn: async () => new Response("nope", { status: 429 }), env });
    expect(items).toEqual([]);
  });

  it("passes redirect:error and an abort signal to fetch", async () => {
    const spy = vi.fn(okResponse({ status: "ok", articles: [] }));
    await ingest([newsQuery], { fetchFn: spy as unknown as typeof fetch, env });
    const opts = spy.mock.calls[0][1] as RequestInit;
    expect(opts.redirect).toBe("error");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/feed-ingest.test.ts`
Expected: FAIL — cannot resolve `@/lib/p5/feed-ingest`.

- [ ] **Step 3: Implement `src/lib/p5/feed-ingest.ts`**

```ts
import { SOURCES } from "@/lib/p5/sources";
import type { FeedItem, QueryTerm } from "@/lib/p5/types";

export interface IngestDeps {
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Fetch + validate + normalise every QueryTerm, concatenating the results.
 *  Operational failures are logged and skipped (return []); only an allow-list
 *  escape throws. */
export async function ingest(queries: QueryTerm[], deps: IngestDeps = {}): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for (const q of queries) {
    out.push(...(await ingestOne(q, deps)));
  }
  return out;
}

async function ingestOne(q: QueryTerm, deps: IngestDeps): Promise<FeedItem[]> {
  const source = SOURCES[q.source];
  if (!source) {
    console.warn(`feed-ingest: unknown source "${q.source}", skipping`);
    return [];
  }
  const env = deps.env ?? process.env;
  const apiKey = env[source.apiKeyEnvVar];
  if (!apiKey) {
    console.warn(`feed-ingest: missing ${source.apiKeyEnvVar}, skipping source "${q.source}"`);
    return [];
  }

  const url = source.buildUrl(q.terms, apiKey);
  if (!url.startsWith(source.baseUrl)) {
    throw new Error(`feed-ingest: built URL "${url}" escapes allow-list base "${source.baseUrl}"`);
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    console.warn(`feed-ingest: fetch failed for "${q.source}": ${String(err)}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`feed-ingest: "${q.source}" returned HTTP ${res.status}`);
    return [];
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    console.warn(`feed-ingest: "${q.source}" returned non-JSON body: ${String(err)}`);
    return [];
  }

  const parsed = source.responseSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(`feed-ingest: "${q.source}" response failed schema validation`);
    return [];
  }
  return source.normalise(parsed.data);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/feed-ingest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/lib/p5/feed-ingest.ts tests/p5/feed-ingest.test.ts
git commit -m "feat(p5): safe feed ingestion (allow-list, https, timeout, schema-validate)"
```

---

## Task 4: Relevance scoring (`relevance.ts`)  — REVIEW POINT (scoring math)

**Files:**
- Create: `src/lib/p5/relevance.ts`
- Test: `tests/p5/relevance.test.ts`

**Context:** Relevance is a deterministic heuristic pipeline with one batched LLM step (spec §6). `extractKeywords` concatenates the five `GoalInterpretation` string fields, lowercases, splits on non-alphanumerics, drops stop-words and 1-char tokens, dedupes. `keywordScore = min(hits / keywords.size, 1)`. Items with `keywordScore < KEYWORD_MIN_THRESHOLD` (0.05) skip the LLM judge (`llmScore = null`) but are still returned in the `ScoredItem[]` (spec A4: gate controls the judge path, not storage). `finalScore = 0.3*keyword + 0.7*llm`, or `keywordScore` when `llmScore` is null. The LLM judge is one `batchComplete<RelevanceResult>()` for all gated-in items. The gateway is injected structurally (only `batchComplete` is needed) — mirrors `s0/operators.ts` which types the gateway structurally.

- [ ] **Step 1: Write the failing test** at `tests/p5/relevance.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { extractKeywords, keywordScore, scoreItems, KEYWORD_MIN_THRESHOLD } from "@/lib/p5/relevance";
import type { FeedItem } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = {
  scope: "run a marathon",
  successMetric: "finish 42km under 4 hours",
  constraints: "weekday evenings only",
  motivation: "personal health",
  deadlineShape: "race in october",
};
const item = (title: string, summary: string): FeedItem => ({
  id: title, source: "newsapi", kind: "news", title, summary, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {},
});

// Gateway stub: returns one RelevanceResult per request, scores set by title prefix.
function judgeStub(scoreByTitle: Record<string, number>) {
  return {
    async batchComplete<T>(reqs: { messages: { content: string }[] }[]): Promise<T[]> {
      return reqs.map((r) => {
        const title = Object.keys(scoreByTitle).find((t) => r.messages.some((m) => m.content.includes(t)))!;
        return { score: scoreByTitle[title], reasoning: "x" } as unknown as T;
      });
    },
  };
}

describe("relevance", () => {
  it("extractKeywords drops stop-words and short tokens", () => {
    const kw = extractKeywords(spec);
    expect(kw.has("marathon")).toBe(true);
    expect(kw.has("a")).toBe(false);   // stop-word / 1-char
    expect(kw.has("the")).toBe(false);
  });

  it("keywordScore is hits/size capped at 1", () => {
    const kw = extractKeywords(spec);
    const hi = keywordScore(item("Marathon training plan", "finish the race under 4 hours"), kw);
    const lo = keywordScore(item("Stock market dips", "shares fell today"), kw);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("blends 0.3*keyword + 0.7*llm for gated-in items", async () => {
    const it1 = item("Marathon training plan", "finish the race under 4 hours");
    const gw = judgeStub({ "Marathon training plan": 1 });
    const [scored] = await scoreItems([it1], spec, gw, "model");
    expect(scored.llmScore).toBe(1);
    expect(scored.finalScore).toBeCloseTo(0.3 * scored.keywordScore + 0.7 * 1, 5);
  });

  it("items below the keyword gate skip the LLM and keep finalScore = keywordScore", async () => {
    const off = item("Quarterly tractor sales", "agricultural equipment demand");
    const gw = judgeStub({});  // should never be consulted
    const [scored] = await scoreItems([off], spec, gw, "model");
    expect(scored.keywordScore).toBeLessThan(KEYWORD_MIN_THRESHOLD);
    expect(scored.llmScore).toBeNull();
    expect(scored.finalScore).toBe(scored.keywordScore);
  });

  it("returns every item even when none reach the LLM (no batchComplete call)", async () => {
    let called = false;
    const gw = { async batchComplete<T>(): Promise<T[]> { called = true; return []; } };
    const off = item("zzz", "qqq");
    const out = await scoreItems([off], spec, gw, "model");
    expect(out).toHaveLength(1);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/relevance.test.ts`
Expected: FAIL — cannot resolve `@/lib/p5/relevance`.

- [ ] **Step 3: Implement `src/lib/p5/relevance.ts`**

```ts
import { z } from "zod";
import type { LlmRequest } from "@/lib/llm/gateway";
import type { FeedItem, ScoredItem } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

export const KEYWORD_MIN_THRESHOLD = 0.05;

type Gateway = { batchComplete<T>(reqs: LlmRequest<T>[]): Promise<T[]> };

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that",
  "these", "those", "i", "you", "he", "she", "we", "they", "my", "your", "our", "their", "not",
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function extractKeywords(spec: GoalInterpretation): Set<string> {
  const text = [spec.scope, spec.successMetric, spec.constraints, spec.motivation, spec.deadlineShape].join(" ");
  return new Set(tokenise(text));
}

export function keywordScore(item: FeedItem, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;
  const tokens = tokenise(`${item.title} ${item.summary}`);
  const hits = tokens.filter((t) => keywords.has(t)).length;
  return Math.min(hits / keywords.size, 1);
}

const relevanceSchema = z.object({ score: z.number().min(0).max(1), reasoning: z.string().max(120) });
type RelevanceResult = z.infer<typeof relevanceSchema>;

export async function scoreItems(
  items: FeedItem[],
  spec: GoalInterpretation,
  gw: Gateway,
  model: string
): Promise<ScoredItem[]> {
  const keywords = extractKeywords(spec);
  const ks = items.map((i) => keywordScore(i, keywords));

  const gatedIn = items
    .map((item, idx) => ({ item, idx, k: ks[idx] }))
    .filter((x) => x.k >= KEYWORD_MIN_THRESHOLD);

  const sys = { role: "system" as const, content: "You are a relevance judge. Score how directly this item affects the given goal. Reply only with JSON matching the schema." };
  const reqs: LlmRequest<RelevanceResult>[] = gatedIn.map((x) => ({
    model,
    messages: [
      sys,
      { role: "user" as const, content: `Goal spec: ${JSON.stringify(spec)}\nItem title: ${x.item.title}\nItem summary: ${x.item.summary}\nItem kind: ${x.item.kind}` },
    ],
    schema: relevanceSchema,
  }));

  const results = reqs.length ? await gw.batchComplete(reqs) : [];
  const llmByIdx = new Map<number, number>();
  gatedIn.forEach((x, j) => llmByIdx.set(x.idx, results[j].score));

  return items.map((item, idx) => {
    const k = ks[idx];
    const llm = llmByIdx.has(idx) ? llmByIdx.get(idx)! : null;
    const finalScore = llm === null ? k : 0.3 * k + 0.7 * llm;
    return { item, keywordScore: k, llmScore: llm, finalScore };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/relevance.test.ts`
Expected: PASS (5 tests). If the "below the keyword gate" item happens to share a token with the spec, adjust the test item's words so its `keywordScore` is genuinely `< 0.05` — the implementation is correct; the fixture must exercise the gate.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/lib/p5/relevance.ts tests/p5/relevance.test.ts
git commit -m "feat(p5): relevance pipeline (keyword gate + batched LLM judge + blended score)"
```

---

## Task 5: Query genome + LLM operators (`genome.ts`)

**Files:**
- Create: `src/lib/p5/genome.ts`
- Test: `tests/p5/genome.test.ts`

**Context:** `genome.ts` defines the Zod schema validating a full `QueryGenome` and the three LLM operators (spec §5.2–5.4), mirroring `s0/operators.ts`. The LLM returns query *bodies* (no id); each operator mints a fresh stable id via `randomUUID()` after parsing — offspring NEVER inherit a parent id (spec §5.3/5.4 identity rule). `seed` uses `complete()` once (the only un-batched call); `crossover`/`mutate` use `complete()` too (the ESC core's `evolve` calls them one offspring at a time — batching across offspring is a later optimisation, not required here). Source descriptions for the prompts come from `SOURCES`. Use `import { randomUUID } from "node:crypto"` for determinism across Next-server and Vitest.

- [ ] **Step 1: Write the failing test** at `tests/p5/genome.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { queryGenomeSchema, makeGenomeOperators } from "@/lib/p5/genome";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };

// Gateway stub: complete() returns a body shaped to whatever the prompt asks for.
function gwStub(bodies: { population?: unknown; queries?: unknown }) {
  return {
    async complete<T>(req: { messages: { content: string }[] }): Promise<T> {
      if (req.messages.some((m) => m.content.includes("DISTINCT query sets"))) {
        return { population: bodies.population } as unknown as T;
      }
      return { queries: bodies.queries } as unknown as T;
    },
  };
}

const term = (s: string) => ({ source: "newsapi", terms: [s], weight: 1 });

describe("genome", () => {
  it("queryGenomeSchema accepts a valid genome and rejects an empty query list", () => {
    expect(queryGenomeSchema.safeParse({ id: "x", queries: [term("a"), term("b")] }).success).toBe(true);
    expect(queryGenomeSchema.safeParse({ id: "x", queries: [] }).success).toBe(false);
  });

  it("seed mints fresh ids and respects populationSize", async () => {
    const gw = gwStub({ population: [{ queries: [term("a"), term("b")] }, { queries: [term("c"), term("d")] }, { queries: [term("e"), term("f")] }] });
    const ops = makeGenomeOperators(gw, spec, 2, "model");
    const pop = await ops.seed();
    expect(pop).toHaveLength(2);
    expect(pop[0].value.id).toBeTypeOf("string");
    expect(pop[0].value.id).not.toBe(pop[1].value.id);
  });

  it("crossover offspring gets a fresh id, not either parent's", async () => {
    const gw = gwStub({ queries: [term("merged1"), term("merged2")] });
    const ops = makeGenomeOperators(gw, spec, 2, "model");
    const a = { value: { id: "PARENT_A", queries: [term("a"), term("b")] } };
    const b = { value: { id: "PARENT_B", queries: [term("c"), term("d")] } };
    const child = await ops.crossover(a, b);
    expect(child.value.id).not.toBe("PARENT_A");
    expect(child.value.id).not.toBe("PARENT_B");
    expect(child.value.queries).toHaveLength(2);
  });

  it("mutate offspring gets a fresh id", async () => {
    const gw = gwStub({ queries: [term("x"), term("y")] });
    const ops = makeGenomeOperators(gw, spec, 2, "model");
    const g = { value: { id: "PARENT", queries: [term("a"), term("b")] } };
    const m = await ops.mutate(g);
    expect(m.value.id).not.toBe("PARENT");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/genome.test.ts`
Expected: FAIL — cannot resolve `@/lib/p5/genome`.

- [ ] **Step 3: Implement `src/lib/p5/genome.ts`**

```ts
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Genome } from "@/lib/esc/core";
import type { QueryGenome } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";
import { SOURCES } from "@/lib/p5/sources";

type Gateway = {
  complete<T>(req: { model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; schema: z.ZodType<T> }): Promise<T>;
};

const queryTermSchema = z.object({
  source: z.enum(["newsapi", "openweather", "alphavantage"]),
  terms: z.array(z.string()).min(1).max(5),
  weight: z.number(),
});

/** Full genome (with id) — used to validate persisted/assembled genomes. */
export const queryGenomeSchema = z.object({
  id: z.string(),
  queries: z.array(queryTermSchema).min(2).max(6),
});

/** Genome body as the LLM returns it (no id; the operator mints one). */
const genomeBodySchema = z.object({ queries: z.array(queryTermSchema).min(2).max(6) });
const seedSchema = z.object({ population: z.array(genomeBodySchema) });

export type GenomeOperators = ReturnType<typeof makeGenomeOperators>;

export function makeGenomeOperators(gw: Gateway, spec: GoalInterpretation, populationSize: number, model: string) {
  const sourceList = Object.values(SOURCES).map((s) => `${s.key}: ${s.description}`).join("\n");
  const sys = { role: "system" as const, content: "You generate search-query sets for a news/signals aggregator. Reply only with JSON matching the schema." };

  return {
    async seed(): Promise<Genome<QueryGenome>[]> {
      const out = await gw.complete({
        model,
        messages: [
          sys,
          { role: "user" as const, content: `Goal spec: ${JSON.stringify(spec)}\nAvailable sources:\n${sourceList}\nProduce ${populationSize} DISTINCT query sets (2-4 queries each) that would surface news, weather, or market events relevant to this goal. Vary them in focus and breadth.` },
        ],
        schema: seedSchema,
      });
      return out.population.slice(0, populationSize).map((body) => ({ value: { id: randomUUID(), queries: body.queries } }));
    },

    async crossover(a: Genome<QueryGenome>, b: Genome<QueryGenome>): Promise<Genome<QueryGenome>> {
      const out = await gw.complete({
        model,
        messages: [
          sys,
          { role: "user" as const, content: `Parent A queries: ${JSON.stringify(a.value.queries)}\nParent B queries: ${JSON.stringify(b.value.queries)}\nMerge into a single coherent query set of 2-4 entries. Remove duplicates. Keep terms most likely to surface goal-relevant signals.` },
        ],
        schema: genomeBodySchema,
      });
      return { value: { id: randomUUID(), queries: out.queries } };
    },

    async mutate(g: Genome<QueryGenome>): Promise<Genome<QueryGenome>> {
      const out = await gw.complete({
        model,
        messages: [
          sys,
          { role: "user" as const, content: `Current genome: ${JSON.stringify(g.value.queries)}\nMutate exactly ONE query term (change its source, refine its terms, or add/remove one term). Goal spec for context: ${JSON.stringify(spec)}` },
        ],
        schema: genomeBodySchema,
      });
      return { value: { id: randomUUID(), queries: out.queries } };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/genome.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/lib/p5/genome.ts tests/p5/genome.test.ts
git commit -m "feat(p5): query genome schema + LLM seed/crossover/mutate operators with stable ids"
```

---

## Task 6: ESC online adapter (`esc-adapter.ts`) — REVIEW POINT (novel online-ESC math)

**Files:**
- Create: `src/lib/p5/esc-adapter.ts`
- Test: `tests/p5/esc-adapter.test.ts`

**Context — read spec §5.5, §5.6, §5.9 carefully; this is the highest-risk unit.** This module runs ONE ingest cycle using the composable primitives `score`/`select`/`evolve` from `@/lib/esc/core` — **never** `step()` or `runToConvergence()` (spec §5.9: `step()` would score post-evolution offspring that didn't gather the data — wrong). The sequence:

1. **LOAD** `repos.queryGenomeState.get(goalId)`; if null, seed a fresh population (`ops.seed()`), scores all `= GENOME_PRIOR_SCORE`, generation 0.
2. **PICK** `topIdx = argmax(state.scores)`; `fetchingGenome = population[topIdx]`. Only this one genome fetches (spec §5.5 — quota cost).
3. **FETCH** `ingest(fetchingGenome.value.queries)` → `FeedItem[]`; `scoreItems(items)` → `ScoredItem[]` (captured in memory); store EVERY scored item via `repos.signals.create(... genomeId: fetchingGenome.value.id, relevanceScore: finalScore)`.
4. **SCORE** `score(cfg, state.population)` where `cfg.fitness` is a closure: for the genome whose `value.id === fetchingGenome.value.id`, fitness = `mean(scoredItems.finalScore) * engagementFactor(id)`; for every other genome at index `i`, fitness = `state.scores[i]` (carry-forward — no NaN, no DB read). Empty fetch → mean is 0.
5. **SELECT** `select(cfg, population, fitnesses)` → top 2 (`selectTop`).
6. **EVOLVE** `evolve(cfg, parents)` → `[...parents, ...offspring]` (length 4). Offspring NOT scored this cycle.
7. **PERSIST** next scores = `[parentFitness0, parentFitness1, GENOME_PRIOR_SCORE, GENOME_PRIOR_SCORE]`; generation+1; `bestScore = max(nextScores)`; `queryGenomeState.save`.
8. **RETURN** `{ signals, alerts }` (alerts come from the injected `raiseAlerts`).

`engagementFactor(repos, id) = (acked + 0.5) / (total + 1)` via `repos.alerts.engagementCounts(id)` (Laplace, spec §5.6). `selectTop` = top `ceil(n/2)` by score. `GENOME_PRIOR_SCORE = 0.1`. `runCycle` takes injected `ops`, `ingest`, `scoreItems`, `raiseAlerts` closures (the DI seam — route binds spec/gw/model into them).

- [ ] **Step 1: Write the failing test** at `tests/p5/esc-adapter.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { selectTop, engagementFactor, GENOME_PRIOR_SCORE, runCycle } from "@/lib/p5/esc-adapter";
import type { Genome } from "@/lib/esc/core";
import type { QueryGenome, FeedItem, ScoredItem, Alert } from "@/lib/p5/types";

const g = (id: string): Genome<QueryGenome> => ({ value: { id, queries: [{ source: "newsapi", terms: [id], weight: 1 }] } });
const feed = (id: string): FeedItem => ({ id, source: "newsapi", kind: "news", title: id, summary: id, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} });

describe("esc-adapter pure pieces", () => {
  it("selectTop returns the top ceil(n/2) genomes by score", () => {
    const pop = [g("a"), g("b"), g("c"), g("d")];
    const parents = selectTop(pop, [0.1, 0.9, 0.4, 0.8]);
    expect(parents.map((p) => p.value.id)).toEqual(["b", "d"]);
  });

  it("engagementFactor is Laplace-smoothed", () => {
    const repos = makeRepositories(openDb(":memory:"));
    expect(engagementFactor(repos, "NONE")).toBeCloseTo(0.5, 5); // (0+0.5)/(0+1)
  });
});

describe("runCycle online loop", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "x", rawText: "x" }).id;
  });

  function deps(overrides: Partial<Parameters<typeof runCycle>[1]> = {}) {
    const scored = (items: FeedItem[]): ScoredItem[] =>
      items.map((item) => ({ item, keywordScore: 0.5, llmScore: 0.9, finalScore: 0.9 }));
    return {
      repos,
      ops: {
        async seed(): Promise<Genome<QueryGenome>[]> { return [g("s0"), g("s1"), g("s2"), g("s3")]; },
        async crossover(a: Genome<QueryGenome>): Promise<Genome<QueryGenome>> { return g("x-" + a.value.id); },
        async mutate(m: Genome<QueryGenome>): Promise<Genome<QueryGenome>> { return g("m-" + m.value.id); },
      },
      ingest: async () => [feed("n1"), feed("n2")],
      scoreItems: async (items: FeedItem[]) => scored(items),
      raiseAlerts: async (): Promise<Alert[]> => [],
      ...overrides,
    };
  }

  it("seeds on first cycle, stores all scored items under the fetching genome id, advances to generation 1", async () => {
    const res = await runCycle(goalId, deps());
    expect(res.signals).toHaveLength(2);
    expect(res.signals.every((s) => s.genomeId === "s0")).toBe(true); // topIdx 0 on equal seed scores
    const state = repos.queryGenomeState.get(goalId)!;
    expect(state.generation).toBe(1);
    expect(state.population).toHaveLength(4);
    expect(state.scores.slice(2)).toEqual([GENOME_PRIOR_SCORE, GENOME_PRIOR_SCORE]); // offspring floor
  });

  it("non-fetching genomes carry their prior score forward (no NaN)", async () => {
    // First cycle to establish state, then a second cycle.
    await runCycle(goalId, deps());
    const res = await runCycle(goalId, deps());
    const state = repos.queryGenomeState.get(goalId)!;
    expect(state.scores.every((s) => Number.isFinite(s))).toBe(true);
    expect(res.signals.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/esc-adapter.test.ts`
Expected: FAIL — cannot resolve `@/lib/p5/esc-adapter`.

- [ ] **Step 3: Implement `src/lib/p5/esc-adapter.ts`**

```ts
import { score, select, evolve, type Genome, type EscState, type EscConfig } from "@/lib/esc/core";
import type { Repositories } from "@/lib/store/repositories";
import type { QueryGenome, FeedItem, ScoredItem, StoredSignal, Alert } from "@/lib/p5/types";

export const GENOME_PRIOR_SCORE = 0.1;
export const POPULATION_SIZE = 4;

/** Truncation selection: top ceil(n/2) genomes by score (spec §5.7). */
export const selectTop = (pop: Genome<QueryGenome>[], scores: number[]): Genome<QueryGenome>[] =>
  scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.ceil(pop.length / 2))
    .map(({ i }) => pop[i]);

/** Laplace-smoothed engagement: (acked + 0.5) / (total + 1) (spec §5.6). */
export function engagementFactor(repos: Repositories, genomeId: string): number {
  const { acked, total } = repos.alerts.engagementCounts(genomeId);
  return (acked + 0.5) / (total + 1);
}

export interface CycleDeps {
  repos: Repositories;
  ops: {
    seed(): Promise<Genome<QueryGenome>[]>;
    crossover(a: Genome<QueryGenome>, b: Genome<QueryGenome>): Promise<Genome<QueryGenome>>;
    mutate(g: Genome<QueryGenome>): Promise<Genome<QueryGenome>>;
  };
  ingest: (queries: QueryGenome["queries"]) => Promise<FeedItem[]>;
  scoreItems: (items: FeedItem[]) => Promise<ScoredItem[]>;
  raiseAlerts: (signals: StoredSignal[]) => Promise<Alert[]>;
}

const argmax = (xs: number[]): number => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** One ingest cycle (spec §5.9). Uses score/select/evolve directly — never step(). */
export async function runCycle(goalId: number, deps: CycleDeps): Promise<{ signals: StoredSignal[]; alerts: Alert[] }> {
  const { repos, ops, ingest, scoreItems, raiseAlerts } = deps;

  // 1. LOAD (or seed on first cycle)
  let state = repos.queryGenomeState.get(goalId);
  if (!state) {
    const population = await ops.seed();
    state = { population, scores: population.map(() => GENOME_PRIOR_SCORE), generation: 0, bestScore: GENOME_PRIOR_SCORE };
  }

  // 2. PICK the single top-scoring genome to fetch
  const topIdx = argmax(state.scores);
  const fetchingGenome = state.population[topIdx];
  const fetchingId = fetchingGenome.value.id;

  // 3. FETCH + SCORE items, store EVERY scored item
  const items = await ingest(fetchingGenome.value.queries);
  const scoredItems = await scoreItems(items);
  const signals: StoredSignal[] = scoredItems.map((si) =>
    repos.signals.create({
      goalId,
      genomeId: fetchingId,
      source: si.item.source,
      kind: si.item.kind,
      payload: si.item,
      relevanceScore: si.finalScore,
    })
  );

  // ALERTS (injected — see alert-logic.ts)
  const alerts = await raiseAlerts(signals);

  // 4. SCORE the CURRENT population (carry-forward for non-fetchers; no step())
  const fetchingFitness = mean(scoredItems.map((si) => si.finalScore)) * engagementFactor(repos, fetchingId);
  const cfg: EscConfig<QueryGenome> = {
    maxGenerations: Number.MAX_SAFE_INTEGER,
    populationSize: POPULATION_SIZE,
    seed: ops.seed,
    crossover: ops.crossover,
    mutate: ops.mutate,
    fitness: async (pop) => pop.map((gen, i) => (gen.value.id === fetchingId ? fetchingFitness : state!.scores[i])),
    select: selectTop,
    converged: () => false,
  };
  const fitnesses = await score(cfg, state.population);

  // 5. SELECT parents, 6. EVOLVE offspring
  const parents = select(cfg, state.population, fitnesses);
  const nextPop = await evolve(cfg, parents);

  // 7. PERSIST: parent fitnesses kept; offspring slots floored to the prior
  const parentScores = parents.map((p) => fitnesses[state!.population.indexOf(p)]);
  const offspringScores = nextPop.slice(parents.length).map(() => GENOME_PRIOR_SCORE);
  const nextScores = [...parentScores, ...offspringScores];
  const nextState: EscState<QueryGenome> = {
    population: nextPop,
    scores: nextScores,
    generation: state.generation + 1,
    bestScore: Math.max(...nextScores),
  };
  repos.queryGenomeState.save(goalId, nextState);

  // 8. RETURN
  return { signals, alerts };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/esc-adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/lib/p5/esc-adapter.ts tests/p5/esc-adapter.test.ts
git commit -m "feat(p5): online ESC adapter (primitive cycle, carry-forward fitness, stable-id attribution)"
```

---

## Task 7: Alert logic (`alert-logic.ts`)

**Files:**
- Create: `src/lib/p5/alert-logic.ts`
- Test: `tests/p5/alert-logic.test.ts`

**Context:** Deterministic threshold + dedup, with one batched LLM justification call (spec §8). A signal qualifies when `relevanceScore >= ALERT_THRESHOLD` (0.75). Two dedup gates before creating an alert: (a) `repos.alerts.existsOpen(goalId, signal.id)` — no second alert for the same stored signal; (b) content-level — skip if any OPEN alert's signal has the same `payload.id` AND `source` (recurring item across cycles), found via `repos.alerts.listOpen` + `repos.signals.listForGoal`. Qualifying signals get ONE batched `batchComplete<JustificationResult>()`; each justification becomes the new alert's `message`. `impactScore = signal.relevanceScore`.

- [ ] **Step 1: Write the failing test** at `tests/p5/alert-logic.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { ALERT_THRESHOLD, raiseAlerts } from "@/lib/p5/alert-logic";
import type { FeedItem, StoredSignal } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };
const feed = (id: string): FeedItem => ({ id, source: "newsapi", kind: "news", title: id, summary: id, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} });

function justifyStub() {
  return { async batchComplete<T>(reqs: unknown[]): Promise<T[]> { return reqs.map(() => ({ justification: "Directly affects the goal." }) as unknown as T); } };
}

describe("alert-logic", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "x", rawText: "x" }).id;
  });

  function signal(id: string, relevance: number): StoredSignal {
    return repos.signals.create({ goalId, genomeId: "G", source: "newsapi", kind: "news", payload: feed(id), relevanceScore: relevance });
  }

  it("raises alerts only for signals at/above the threshold", async () => {
    const hi = signal("hi", 0.9);
    signal("lo", 0.5);
    const alerts = await raiseAlerts([hi, repos.signals.listForGoal(goalId).find((s) => s.payload.id === "lo")!], spec, repos, justifyStub(), "model");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].signalId).toBe(hi.id);
    expect(alerts[0].impactScore).toBe(0.9);
    expect(alerts[0].message).toContain("goal");
  });

  it("skips a signal that already has an open alert (existsOpen dedup)", async () => {
    const s = signal("dup", 0.9);
    await raiseAlerts([s], spec, repos, justifyStub(), "model");
    const second = await raiseAlerts([s], spec, repos, justifyStub(), "model");
    expect(second).toHaveLength(0);
    expect(repos.alerts.listOpen(goalId)).toHaveLength(1);
  });

  it("skips a different signal with identical content while an alert is open (content dedup)", async () => {
    const s1 = signal("same-url", 0.9);
    await raiseAlerts([s1], spec, repos, justifyStub(), "model");
    const s2 = signal("same-url", 0.95); // same payload.id + source, new row
    const out = await raiseAlerts([s2], spec, repos, justifyStub(), "model");
    expect(out).toHaveLength(0);
  });

  it("ALERT_THRESHOLD is 0.75", () => {
    expect(ALERT_THRESHOLD).toBe(0.75);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/alert-logic.test.ts`
Expected: FAIL — cannot resolve `@/lib/p5/alert-logic`.

- [ ] **Step 3: Implement `src/lib/p5/alert-logic.ts`**

```ts
import { z } from "zod";
import type { LlmRequest } from "@/lib/llm/gateway";
import type { Repositories } from "@/lib/store/repositories";
import type { StoredSignal, Alert } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

export const ALERT_THRESHOLD = 0.75;

type Gateway = { batchComplete<T>(reqs: LlmRequest<T>[]): Promise<T[]> };

const justifySchema = z.object({ justification: z.string().max(160) });
type JustificationResult = z.infer<typeof justifySchema>;

/** True if an OPEN alert for this goal already references a signal with the
 *  same source + payload.id (recurring item across cycles). Spec §8.2. */
function duplicateContentInOpenAlerts(repos: Repositories, signal: StoredSignal): boolean {
  const open = repos.alerts.listOpen(signal.goalId);
  if (open.length === 0) return false;
  const openSignalIds = new Set(open.map((a) => a.signalId));
  return repos.signals
    .listForGoal(signal.goalId)
    .some((s) => openSignalIds.has(s.id) && s.payload.id === signal.payload.id && s.source === signal.source);
}

export async function raiseAlerts(
  signals: StoredSignal[],
  spec: GoalInterpretation,
  repos: Repositories,
  gw: Gateway,
  model: string
): Promise<Alert[]> {
  const qualifying = signals.filter(
    (s) =>
      (s.relevanceScore ?? 0) >= ALERT_THRESHOLD &&
      !repos.alerts.existsOpen(s.goalId, s.id) &&
      !duplicateContentInOpenAlerts(repos, s)
  );
  if (qualifying.length === 0) return [];

  const sys = { role: "system" as const, content: "You write one-sentence impact summaries for goal planners. Reply only with JSON." };
  const reqs: LlmRequest<JustificationResult>[] = qualifying.map((s) => ({
    model,
    messages: [
      sys,
      { role: "user" as const, content: `Goal spec: ${JSON.stringify(spec)}\nSignal: ${s.payload.title} — ${s.payload.summary}\nIn one sentence (<= 20 words), explain why this directly affects the goal.` },
    ],
    schema: justifySchema,
  }));
  const justifications = await gw.batchComplete(reqs);

  return qualifying.map((s, i) =>
    repos.alerts.create({ signalId: s.id, goalId: s.goalId, impactScore: s.relevanceScore!, message: justifications[i].justification })
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/alert-logic.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expect clean), then:

```bash
git add src/lib/p5/alert-logic.ts tests/p5/alert-logic.test.ts
git commit -m "feat(p5): alert logic (threshold, existsOpen + content dedup, batched justification)"
```

---

## Task 8: `/api/signals` route + integration smoke test

**Files:**
- Create: `src/app/api/signals/route.ts`
- Test: `tests/p5/signals-route.test.ts`

**Context:** The route mirrors `src/app/api/elicit/route.ts`: read JSON body, open the DB, build the gateway from `process.env.OPENROUTER_API_KEY`, compose the injected closures, and call `runCycle`. It re-exports `runCycle` so the integration test calls the inner function (spec §9.4 — never the HTTP layer). Models come from env with the elicit route's `openai/gpt-4o-mini` default. The integration test injects deterministic `ops`/`ingest`/`scoreItems` and a recorded-`fetchFn` gateway only for the justification step, then asserts: signals created, ≥1 alert created (one fixture item scores above threshold), `queryGenomeState` advanced to generation 1.

- [ ] **Step 1: Write the failing test** at `tests/p5/signals-route.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { runCycle } from "@/app/api/signals/route";
import { raiseAlerts } from "@/lib/p5/alert-logic";
import type { Genome } from "@/lib/esc/core";
import type { QueryGenome, FeedItem, ScoredItem } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = { scope: "run a marathon", successMetric: "finish under 4h", constraints: "evenings", motivation: "health", deadlineShape: "october" };
const g = (id: string): Genome<QueryGenome> => ({ value: { id, queries: [{ source: "newsapi", terms: [id], weight: 1 }] } });
const feed = (id: string): FeedItem => ({ id, source: "newsapi", kind: "news", title: id, summary: id, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} });

function justifyGateway() {
  return {
    async batchComplete<T>(reqs: unknown[]): Promise<T[]> { return reqs.map(() => ({ justification: "Affects the goal." }) as unknown as T); },
  };
}

describe("/api/signals runCycle integration", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "x", rawText: "run a marathon" }).id;
    repos.goals.setConvergedSpec(goalId, spec);
  });

  it("runs one end-to-end cycle: stores signals, raises an alert, advances genome state", async () => {
    const gw = justifyGateway();
    const res = await runCycle(goalId, {
      repos,
      ops: {
        async seed() { return [g("s0"), g("s1"), g("s2"), g("s3")]; },
        async crossover(a) { return g("x-" + a.value.id); },
        async mutate(m) { return g("m-" + m.value.id); },
      },
      ingest: async () => [feed("a"), feed("b")],
      scoreItems: async (items: FeedItem[]): Promise<ScoredItem[]> =>
        items.map((item, i) => ({ item, keywordScore: 0.5, llmScore: i === 0 ? 0.95 : 0.2, finalScore: i === 0 ? 0.9 : 0.2 })),
      raiseAlerts: (signals) => raiseAlerts(signals, spec, repos, gw, "model"),
    });

    expect(res.signals).toHaveLength(2);
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0].impactScore).toBeCloseTo(0.9, 5);
    expect(repos.queryGenomeState.get(goalId)!.generation).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p5/signals-route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/signals/route`.

- [ ] **Step 3: Implement `src/app/api/signals/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { runCycle } from "@/lib/p5/esc-adapter";
import { makeGenomeOperators } from "@/lib/p5/genome";
import { ingest } from "@/lib/p5/feed-ingest";
import { scoreItems } from "@/lib/p5/relevance";
import { raiseAlerts } from "@/lib/p5/alert-logic";
import type { GoalInterpretation } from "@/lib/store/types";

export { runCycle } from "@/lib/p5/esc-adapter";

const SEED_MODEL = process.env.P5_GENOME_MODEL ?? "openai/gpt-4o-mini";
const JUDGE_MODEL = process.env.P5_JUDGE_MODEL ?? "openai/gpt-4o-mini";

export async function POST(req: NextRequest) {
  const { goalId } = (await req.json()) as { goalId: number };
  const repos = makeRepositories(openDb());

  const goal = repos.goals.get(goalId);
  if (!goal || !goal.convergedSpec) {
    return NextResponse.json({ error: `goal ${goalId} not found or not converged` }, { status: 400 });
  }
  const spec = goal.convergedSpec as GoalInterpretation;

  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY ?? "", cache: repos.llmCache });
  const ops = makeGenomeOperators(gw, spec, 4, SEED_MODEL);

  const result = await runCycle(goalId, {
    repos,
    ops,
    ingest: (queries) => ingest(queries),
    scoreItems: (items) => scoreItems(items, spec, gw, JUDGE_MODEL),
    raiseAlerts: (signals) => raiseAlerts(signals, spec, repos, gw, JUDGE_MODEL),
  });

  return NextResponse.json(result);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p5/signals-route.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test` (expect all prior 34 + the new P5 tests green) and `npm run typecheck` (expect clean).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/signals/route.ts tests/p5/signals-route.test.ts
git commit -m "feat(p5): /api/signals route wiring runCycle + end-to-end integration test"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — full suite green (34 prior + P5).
- [ ] `npm run typecheck` — clean.
- [ ] Dispatch a final whole-implementation code review (subagent-driven-development's last step), then `superpowers:finishing-a-development-branch` to decide merge/PR for `p5-signals`.

**Deliberately deferred to the spec's R1/R2 backlog (do NOT build here):** concrete provider tuning beyond the baseline (OQ-1), embedding similarity (OQ-2), cross-user warm-start priors (OQ-6), schema-version migration (OQ-4), per-role model split (OQ-5). The live-network test against real NewsAPI/OpenWeatherMap/Alpha Vantage is manual, not CI (spec §9.5) — and ties into HANDOFF §9 risk #1 (the app has never run live).

---

## Self-review (done by plan author)

**Spec coverage:** §3 module map → Tasks 1–8 (note: `repositories.ts` folded into the existing store file per spec §4, not a separate p5 file — documented in File Structure). §4 repos → Task 1. §4.3 `query_genome_state` + `genome_id` → Task 1 schema steps. §5 genome/operators → Task 5; online cycle §5.9 → Task 6; attribution §5.5 + carry-forward + engagement §5.6 → Task 6. §6 relevance → Task 4. §7 sources/safety → Tasks 2–3. §8 alerts → Task 7. §3.7 route → Task 8. §9 testing strategy → unit tests per task + integration in Task 8. **No gap found.**

**Placeholder scan:** every code step contains complete, runnable code; every command has an expected result. No TBD/TODO.

**Type consistency:** `StoredSignal`/`Alert`/`QueryGenome`/`FeedItem`/`ScoredItem`/`QueryTerm` defined once in `p5/types.ts` (Task 1) and imported everywhere. Repo method names (`signals.create/listForGoal/updateRelevance`, `alerts.create/listOpen/acknowledge/existsOpen/engagementCounts`, `queryGenomeState.get/save`) are used identically in Tasks 6–8. `runCycle`'s `CycleDeps` shape (`repos/ops/ingest/scoreItems/raiseAlerts`) matches Tasks 6 and 8. `makeGenomeOperators` signature matches its call in Task 8. **Consistent.**
