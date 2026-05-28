# P2 Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P2 — turn a converged goal into a versioned, three-layer plan tree (monthly → weekly → daily) with composable per-layer LLM operators, deterministic calendar arithmetic, bounded retry, transactional persistence, and a `/api/decompose` route — exactly as specified in `docs/superpowers/specs/2026-05-28-p2-decomposition-design.md`.

**Architecture:** Heuristics-first. Pure `calendar.buildSkeleton` produces month/week/date spans deterministically; three pure operators each do one `gw.complete({ bypassCache: true })` call per parent; the orchestrator runs them sibling-parallel via `Promise.all`, wraps each in `withRetry`, then persists the whole tree inside a single `db.transaction` and flips `goal.activeDecompositionId`. Operators stay pure; the orchestrator owns every side effect. Versioning is per-`/api/decompose`-call; the `decomposition` table + per-row `decomposition_id` is the seam.

**Tech Stack:** TypeScript, Next.js 14 (App Router), vitest, better-sqlite3, zod, OpenRouter via the existing `llm-gateway`.

---

## Read first (every worker, every task)

- `HANDOFF.md` — §0 role prompt, §3 interfaces you'll touch, §4 worker discipline (no `next build`/`tsc` gating, no out-of-scope fixes, no branches, per-task gate is `npx vitest run <file>`), §6 prompt-hardening lessons, §9 risk 1 (live-OpenRouter gotchas already shipped fixes for).
- `WORKFLOW.md` — code-change hygiene (no `// NEW —` / `// was:` / `*_v2` / parallel-clone files; patch in situ).
- `docs/superpowers/specs/2026-05-28-p2-decomposition-design.md` — the spec this plan implements. §3 architecture, §5 data model, §6 heuristics, §7 LLM contracts, §8 lifecycle, §9 errors, §10 testing.
- `docs/canonical-project-graph.md` §1 (Plan Graph node types) and §4 (canonical role prompt — same as HANDOFF §0).

## Role (adopt verbatim)

> You are a senior systems designer who worked at Google's UK campus (King's Cross, London) during 2021–2022, specialising in agentic/LLM planning systems. You design for **isolation and clarity**: small units, well-defined interfaces, each independently testable. You are **heuristics-first** — deterministic logic does the calendar math, weighting, decay, packing, and dedup; the LLM is invoked only where it earns its place, always **batched and cached**. You ship **real, concrete, tested** work — never placeholders, never stubs left behind. You state assumptions explicitly and verify before claiming done.

## Worker discipline (per task)

- Working tree: `c:\dev\Spacato`. Do **not** work in any OneDrive copy.
- Per-task success gate: `npx vitest run <your-test-file>`. **Do not** gate on `next build` or `npm run typecheck`; if either is broken by your change you've gone out of scope.
- If you discover a problem outside this task's listed files, **stop and report**. Do not fix it. The orchestrator will spawn a separate task if warranted.
- Patch **in situ**. No `// NEW —` / `// was:` / temporal-reference comments. No `*_v2` / `*_new` / `legacy_*` identifiers. No parallel-clone files. Git history holds the previous version.
- Do **not** create or delete branches. Do **not** push.
- Commit at the end of your task only after `npx vitest run <your-test-file>` is green. Commit message: conventional-commits style (`feat:`, `test:`, `refactor:`, etc.).

## Task dependency graph

```
T1 calendar       ──┐
T2 bypassCache    ──┤
T3 schema+repos   ──┼──► T5 operators ──► T6 handler ──► T7 route
T4 p2 primitives  ──┘                 ──►
```

T1, T2, T3, T4 are independent and parallelisable. T5 depends on T2 + T4. T6 depends on T1 + T3 + T4 + T5. T7 depends on T6.

---

## Task 1: Calendar skeleton (`src/lib/util/calendar.ts`)

**Files:**
- Create: `src/lib/util/calendar.ts`
- Test:  `src/lib/util/calendar.test.ts`

Implements §6.1 of the spec: parses `"N months"` / `"N weeks"` / `"by YYYY-MM-DD"` and emits rolling month-spans (not calendar-month-boundary-aligned), 7-day weeks within each span (last week clips to span end), inclusive date arrays per week.

- [ ] **Step 1.1 — Write the failing tests.**

  Create `src/lib/util/calendar.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { buildSkeleton } from "./calendar";

  describe("buildSkeleton", () => {
    it("produces 6 rolling month-spans for '6 months' from 2026-05-28", () => {
      const skel = buildSkeleton("6 months", "2026-05-28");
      expect(skel.months).toHaveLength(6);
      expect(skel.months[0]).toEqual({
        monthIndex: 0, startDate: "2026-05-28", endDate: "2026-06-27",
      });
      expect(skel.months[5]).toEqual({
        monthIndex: 5, startDate: "2026-10-28", endDate: "2026-11-28",
      });
    });

    it("emits exactly 185 dates for '6 months' from 2026-05-28", () => {
      const skel = buildSkeleton("6 months", "2026-05-28");
      const allDates = skel.weeksByMonth.flatMap((ws) => ws.flatMap((w) => w.dates));
      expect(allDates).toHaveLength(185);
      expect(allDates[0]).toBe("2026-05-28");
      expect(allDates.at(-1)).toBe("2026-11-28");
    });

    it("clips weeks at month-span boundaries (no week straddles two months)", () => {
      const skel = buildSkeleton("6 months", "2026-05-28");
      for (let i = 0; i < skel.months.length; i++) {
        const monthEnd = skel.months[i].endDate;
        const monthWeeks = skel.weeksByMonth[i];
        const lastWeekOfMonth = monthWeeks.at(-1)!;
        expect(lastWeekOfMonth.endDate <= monthEnd).toBe(true);
        // first week starts on the month's startDate
        expect(monthWeeks[0].startDate).toBe(skel.months[i].startDate);
      }
    });

    it("parses 'by YYYY-MM-DD' form", () => {
      const skel = buildSkeleton("by 2026-12-15", "2026-05-28");
      expect(skel.months.at(-1)!.endDate).toBe("2026-12-15");
      expect(skel.months.length).toBeGreaterThanOrEqual(6);
    });

    it("parses 'N weeks' form with single clipped span", () => {
      const skel = buildSkeleton("3 weeks", "2026-05-28");
      expect(skel.months).toHaveLength(1);
      expect(skel.months[0].startDate).toBe("2026-05-28");
      expect(skel.months[0].endDate).toBe("2026-06-17"); // 2026-05-28 + 21 days = 06-18, minus 1 inclusive = 06-17
      expect(skel.weeksByMonth.flatMap((ws) => ws.flatMap((w) => w.dates))).toHaveLength(21);
    });

    it("throws on unparseable timeframe", () => {
      expect(() => buildSkeleton("forever", "2026-05-28"))
        .toThrowError(/unparseable timeframe: forever/);
    });

    it("throws on zero-length timeframe", () => {
      expect(() => buildSkeleton("0 months", "2026-05-28"))
        .toThrow();
    });
  });
  ```

- [ ] **Step 1.2 — Run the tests, verify they fail.**

  ```
  npx vitest run src/lib/util/calendar.test.ts
  ```
  Expected: every test fails with `Cannot find module './calendar'` (or similar import error).

- [ ] **Step 1.3 — Write the implementation.**

  Create `src/lib/util/calendar.ts`:

  ```ts
  export interface MonthSpan {
    monthIndex: number;
    startDate: string;   // ISO yyyy-mm-dd, inclusive
    endDate: string;     // ISO yyyy-mm-dd, inclusive
  }

  export interface WeekSpan {
    weekIndex: number;       // 0-based, local to its parent month
    startDate: string;
    endDate: string;
    dates: string[];         // ISO yyyy-mm-dd, inclusive
  }

  export interface CalendarSkeleton {
    months: MonthSpan[];
    weeksByMonth: WeekSpan[][];
  }

  const MS_PER_DAY = 86_400_000;

  function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  function addDays(iso: string, days: number): string {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return isoDate(d);
  }

  function addMonths(iso: string, months: number): string {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + months);
    return isoDate(d);
  }

  function daysBetweenInclusive(a: string, b: string): number {
    const da = new Date(a + "T00:00:00Z").getTime();
    const db = new Date(b + "T00:00:00Z").getTime();
    return Math.round((db - da) / MS_PER_DAY) + 1;
  }

  interface ParsedTimeframe {
    numMonths: number;
    end: string;
  }

  function parseTimeframe(input: string, today: string): ParsedTimeframe {
    const trimmed = input.trim();

    const months = /^(\d+)\s+months?$/i.exec(trimmed);
    if (months) {
      const n = Number(months[1]);
      if (n < 1 || n > 36) throw new Error(`p2.calendar: out-of-range months: ${n}`);
      return { numMonths: n, end: addDays(addMonths(today, n), -1) };
    }

    const weeks = /^(\d+)\s+weeks?$/i.exec(trimmed);
    if (weeks) {
      const n = Number(weeks[1]);
      if (n < 1 || n > 156) throw new Error(`p2.calendar: out-of-range weeks: ${n}`);
      const end = addDays(today, n * 7 - 1);
      return { numMonths: Math.max(1, Math.ceil(n / 4)), end };
    }

    const byDate = /^by\s+(\d{4}-\d{2}-\d{2})$/i.exec(trimmed);
    if (byDate) {
      const end = byDate[1];
      if (end <= today) throw new Error(`p2.calendar: by-date in the past: ${end}`);
      // calendarMonthsBetween: walk months until we pass end
      let n = 0;
      while (addDays(addMonths(today, n + 1), -1) < end) n++;
      return { numMonths: Math.max(1, n + 1), end };
    }

    throw new Error(`unparseable timeframe: ${input}`);
  }

  export function buildSkeleton(timeframe: string, today: string): CalendarSkeleton {
    const { numMonths, end } = parseTimeframe(timeframe, today);

    const months: MonthSpan[] = [];
    for (let i = 0; i < numMonths; i++) {
      const start = addMonths(today, i);
      let endOfSpan = addDays(addMonths(today, i + 1), -1);
      if (endOfSpan > end) endOfSpan = end;
      months.push({ monthIndex: i, startDate: start, endDate: endOfSpan });
    }

    const weeksByMonth: WeekSpan[][] = [];
    for (const m of months) {
      const weeks: WeekSpan[] = [];
      let cursor = m.startDate;
      let localWeekIndex = 0;
      while (cursor <= m.endDate) {
        let weekEnd = addDays(cursor, 6);
        if (weekEnd > m.endDate) weekEnd = m.endDate;

        const dates: string[] = [];
        const dayCount = daysBetweenInclusive(cursor, weekEnd);
        for (let d = 0; d < dayCount; d++) dates.push(addDays(cursor, d));

        weeks.push({ weekIndex: localWeekIndex++, startDate: cursor, endDate: weekEnd, dates });
        cursor = addDays(weekEnd, 1);
      }
      weeksByMonth.push(weeks);
    }

    return { months, weeksByMonth };
  }
  ```

- [ ] **Step 1.4 — Run the tests, verify they pass.**

  ```
  npx vitest run src/lib/util/calendar.test.ts
  ```
  Expected: all 7 tests green.

- [ ] **Step 1.5 — Commit.**

  ```
  git add src/lib/util/calendar.ts src/lib/util/calendar.test.ts
  git commit -m "feat(p2): calendar.buildSkeleton with rolling month-spans and week-clipping"
  ```

---

## Task 2: Gateway `bypassCache` option (`src/lib/llm/gateway.ts`)

**Files:**
- Modify: `src/lib/llm/gateway.ts`
- Modify: `src/lib/llm/gateway.test.ts` (add new tests; do not change existing ones)

Adds a per-request `bypassCache?: boolean` flag on `LlmRequest<T>`. When `true`, `complete()` skips the cache read AND the cache write. Default `false` — existing S0/P5 paths and tests stay caching-on.

- [ ] **Step 2.1 — Familiarise yourself with the current shape.**

  Read `src/lib/llm/gateway.ts` and `src/lib/llm/gateway.test.ts`. Identify the `LlmRequest<T>` type and the `complete<T>` function's existing cache read/write path (around the `promptHash` / `cache.get` / `cache.put` calls). Do not modify anything yet.

- [ ] **Step 2.2 — Write the failing tests.**

  Append to `src/lib/llm/gateway.test.ts`:

  ```ts
  describe("bypassCache", () => {
    it("does not read from cache when bypassCache is true", async () => {
      const cache = {
        get: vi.fn().mockReturnValue("should-not-be-used"),
        put: vi.fn(),
      };
      const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse({
        choices: [{ message: { content: '{"value":42}' } }],
      }));
      const gw = makeGateway({
        apiKey: "test", cache, fetchFn,
      });

      const schema = z.object({ value: z.number() });
      const result = await gw.complete({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        schema,
        bypassCache: true,
      });

      expect(result).toEqual({ value: 42 });
      expect(cache.get).not.toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it("does not write to cache when bypassCache is true", async () => {
      const cache = { get: vi.fn().mockReturnValue(undefined), put: vi.fn() };
      const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse({
        choices: [{ message: { content: '{"value":1}' } }],
      }));
      const gw = makeGateway({ apiKey: "test", cache, fetchFn });

      await gw.complete({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        schema: z.object({ value: z.number() }),
        bypassCache: true,
      });

      expect(cache.put).not.toHaveBeenCalled();
    });

    it("uses the cache normally when bypassCache is false or absent", async () => {
      const cache = {
        get: vi.fn().mockReturnValue({ value: 7 }),
        put: vi.fn(),
      };
      const fetchFn = vi.fn();
      const gw = makeGateway({ apiKey: "test", cache, fetchFn });

      const result = await gw.complete({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        schema: z.object({ value: z.number() }),
        // bypassCache omitted — defaults to false
      });

      expect(result).toEqual({ value: 7 });
      expect(cache.get).toHaveBeenCalledOnce();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
  ```

  If `makeJsonResponse` does not already exist as a helper in this test file, mirror the pattern other tests in this file use to fake an HTTP response.

- [ ] **Step 2.3 — Run the new tests, verify they fail.**

  ```
  npx vitest run src/lib/llm/gateway.test.ts -t bypassCache
  ```
  Expected: the three new tests fail (probably with the bypassCache field being ignored — cache.get still called, or schema rejecting unknown field, depending on current shape).

- [ ] **Step 2.4 — Modify the gateway.**

  In `src/lib/llm/gateway.ts`:

  1. Extend the `LlmRequest<T>` type:
     ```ts
     export interface LlmRequest<T extends z.ZodTypeAny> {
       // ...existing fields
       bypassCache?: boolean;   // when true: skip cache read AND skip cache write
     }
     ```

  2. In the `complete` implementation, gate the cache read on `!req.bypassCache`:
     ```ts
     if (!req.bypassCache) {
       const cached = deps.cache.get(hash, req.model);
       if (cached !== undefined) return req.schema.parse(cached);
     }
     ```

  3. Gate the cache write on the same flag:
     ```ts
     if (!req.bypassCache) {
       deps.cache.put(hash, req.model, parsed);
     }
     ```

  Make no other changes. Do not rename anything; do not refactor unrelated code.

- [ ] **Step 2.5 — Run the new tests, verify they pass; run the full gateway suite, verify nothing regressed.**

  ```
  npx vitest run src/lib/llm/gateway.test.ts
  ```
  Expected: every test green (the three new bypassCache tests plus all previously-passing tests).

- [ ] **Step 2.6 — Commit.**

  ```
  git add src/lib/llm/gateway.ts src/lib/llm/gateway.test.ts
  git commit -m "feat(llm): add bypassCache option for per-request cache skipping"
  ```

---

## Task 3: Schema, types, and decomposition repos

**Files:**
- Modify: `src/lib/store/schema.sql`
- Modify: `src/lib/store/db.ts` (or wherever schema is applied — add the defensive `ALTER TABLE goal` block)
- Modify: `src/lib/store/types.ts`
- Modify: `src/lib/store/repositories.ts`
- Create: `src/lib/store/repositories.test.ts` extension OR new file `src/lib/store/decomposition-repos.test.ts`

Implements §5 of the spec: four new tables (`decomposition`, `monthly`, `weekly`, `daily_task`) with indices; an additive `goal.active_decomposition_id` column via defensive `ALTER TABLE`; TS interfaces; four new repos following the established `goals`/`signals`/`alerts` pattern.

- [ ] **Step 3.1 — Familiarise yourself with the existing schema and repo style.**

  Read `src/lib/store/schema.sql`, `src/lib/store/types.ts`, `src/lib/store/repositories.ts`, and `src/lib/store/db.ts`. Note how the `goals`, `signals`, `alerts` repos are structured (factory `makeRepositories(db)` returning typed objects). Note how the schema is applied at `openDb()` time.

- [ ] **Step 3.2 — Write the failing tests.**

  Create `src/lib/store/decomposition-repos.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach } from "vitest";
  import { openDb } from "./db";
  import { makeRepositories } from "./repositories";
  import type Database from "better-sqlite3";

  let db: Database.Database;
  let repos: ReturnType<typeof makeRepositories>;

  beforeEach(() => {
    db = openDb(":memory:");
    repos = makeRepositories(db);
  });

  describe("decompositions repo", () => {
    it("create + getById round-trips", () => {
      const goalId = repos.goals.create({
        rawGoal: "marathon",
        convergedSpec: null,
      }).id;
      const dec = repos.decompositions.create({ goalId });
      expect(dec.id).toBeGreaterThan(0);
      const fetched = repos.decompositions.getById(dec.id);
      expect(fetched?.goalId).toBe(goalId);
    });

    it("listForGoal returns rows in creation order", () => {
      const goalId = repos.goals.create({ rawGoal: "g", convergedSpec: null }).id;
      const d1 = repos.decompositions.create({ goalId });
      const d2 = repos.decompositions.create({ goalId });
      const rows = repos.decompositions.listForGoal(goalId);
      expect(rows.map((r) => r.id)).toEqual([d1.id, d2.id]);
    });
  });

  describe("monthlies / weeklies / dailyTasks bulkInsert", () => {
    function setup() {
      const goalId = repos.goals.create({ rawGoal: "g", convergedSpec: null }).id;
      const decompositionId = repos.decompositions.create({ goalId }).id;
      return { goalId, decompositionId };
    }

    it("monthlies.bulkInsert is atomic and returns ids in order", () => {
      const { decompositionId } = setup();
      const ids = repos.monthlies.bulkInsert([
        { decompositionId, monthIndex: 0, startDate: "2026-05-28", endDate: "2026-06-27",
          objective: "Build base", description: "...", weight: 1 / 6, progress: 0 },
        { decompositionId, monthIndex: 1, startDate: "2026-06-28", endDate: "2026-07-27",
          objective: "Add intensity", description: "...", weight: 1 / 6, progress: 0 },
      ]);
      expect(ids).toHaveLength(2);
      const rows = repos.monthlies.listForDecomposition(decompositionId);
      expect(rows.map((r) => r.monthIndex)).toEqual([0, 1]);
    });

    it("dailyTasks.listInDateRange filters by decomposition and inclusive date range", () => {
      const { decompositionId } = setup();
      const [monthlyId] = repos.monthlies.bulkInsert([
        { decompositionId, monthIndex: 0, startDate: "2026-05-28", endDate: "2026-06-27",
          objective: "x", description: "", weight: 1, progress: 0 },
      ]);
      const [weeklyId] = repos.weeklies.bulkInsert([
        { decompositionId, monthlyId, weekIndex: 0,
          startDate: "2026-05-28", endDate: "2026-06-03",
          objective: "y", description: "", weight: 1, progress: 0 },
      ]);
      repos.dailyTasks.bulkInsert([
        { decompositionId, weeklyId, date: "2026-05-28", title: "a", description: "",
          estimatedMinutes: 30, status: "pending", concretizationLevel: "coarse" },
        { decompositionId, weeklyId, date: "2026-05-30", title: "b", description: "",
          estimatedMinutes: 45, status: "pending", concretizationLevel: "coarse" },
        { decompositionId, weeklyId, date: "2026-06-03", title: "c", description: "",
          estimatedMinutes: 60, status: "pending", concretizationLevel: "coarse" },
      ]);
      const inRange = repos.dailyTasks.listInDateRange(decompositionId, "2026-05-29", "2026-06-02");
      expect(inRange.map((d) => d.date)).toEqual(["2026-05-30"]);
    });
  });

  describe("goals.setActiveDecomposition", () => {
    it("updates the goal's activeDecompositionId", () => {
      const g = repos.goals.create({ rawGoal: "g", convergedSpec: null });
      const d = repos.decompositions.create({ goalId: g.id });
      expect(repos.goals.get(g.id)?.activeDecompositionId).toBeNull();
      repos.goals.setActiveDecomposition(g.id, d.id);
      expect(repos.goals.get(g.id)?.activeDecompositionId).toBe(d.id);
    });
  });

  describe("schema init is idempotent", () => {
    it("opening a DB twice does not error on the defensive ALTER", () => {
      const db1 = openDb(":memory:");
      const db2 = openDb(":memory:");  // separate :memory: instance — exercises init path twice
      expect(() => makeRepositories(db1)).not.toThrow();
      expect(() => makeRepositories(db2)).not.toThrow();
    });
  });
  ```

- [ ] **Step 3.3 — Run the failing tests.**

  ```
  npx vitest run src/lib/store/decomposition-repos.test.ts
  ```
  Expected: every test fails (repos don't exist yet; schema lacks the tables).

- [ ] **Step 3.4 — Extend the schema.**

  Append to `src/lib/store/schema.sql`:

  ```sql
  CREATE TABLE IF NOT EXISTS decomposition (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id          INTEGER NOT NULL REFERENCES goal(id),
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS monthly (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    decomposition_id INTEGER NOT NULL REFERENCES decomposition(id),
    month_index      INTEGER NOT NULL,
    start_date       TEXT    NOT NULL,
    end_date         TEXT    NOT NULL,
    objective        TEXT    NOT NULL,
    description      TEXT    NOT NULL,
    weight           REAL    NOT NULL,
    progress         REAL    NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS weekly (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    decomposition_id INTEGER NOT NULL REFERENCES decomposition(id),
    monthly_id       INTEGER NOT NULL REFERENCES monthly(id),
    week_index       INTEGER NOT NULL,
    start_date       TEXT    NOT NULL,
    end_date         TEXT    NOT NULL,
    objective        TEXT    NOT NULL,
    description      TEXT    NOT NULL,
    weight           REAL    NOT NULL,
    progress         REAL    NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS daily_task (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    decomposition_id     INTEGER NOT NULL REFERENCES decomposition(id),
    weekly_id            INTEGER NOT NULL REFERENCES weekly(id),
    date                 TEXT    NOT NULL,
    title                TEXT    NOT NULL,
    description          TEXT    NOT NULL,
    estimated_minutes    INTEGER NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'pending',
    concretization_level TEXT    NOT NULL DEFAULT 'coarse'
  );

  CREATE INDEX IF NOT EXISTS idx_monthly_decomp    ON monthly(decomposition_id);
  CREATE INDEX IF NOT EXISTS idx_weekly_monthly    ON weekly(monthly_id);
  CREATE INDEX IF NOT EXISTS idx_daily_weekly      ON daily_task(weekly_id);
  CREATE INDEX IF NOT EXISTS idx_daily_decomp_date ON daily_task(decomposition_id, date);
  ```

  Also update the existing `CREATE TABLE goal` block to include the new column:

  ```sql
  -- inside CREATE TABLE goal (...)
  active_decomposition_id INTEGER REFERENCES decomposition(id)
  ```

  In `src/lib/store/db.ts` (or wherever `openDb` applies the schema), add a defensive ALTER after the schema runs:

  ```ts
  try {
    db.exec("ALTER TABLE goal ADD COLUMN active_decomposition_id INTEGER REFERENCES decomposition(id)");
  } catch (err) {
    // ignore "duplicate column" — fresh DBs already have the column via CREATE TABLE
    if (!String((err as Error).message).includes("duplicate column")) throw err;
  }
  ```

- [ ] **Step 3.5 — Extend types.**

  In `src/lib/store/types.ts`:

  ```ts
  export interface Decomposition {
    id: number;
    goalId: number;
    createdAt: number;
  }

  export interface Monthly {
    id: number;
    decompositionId: number;
    monthIndex: number;
    startDate: string;
    endDate: string;
    objective: string;
    description: string;
    weight: number;
    progress: number;
  }

  export interface Weekly {
    id: number;
    decompositionId: number;
    monthlyId: number;
    weekIndex: number;
    startDate: string;
    endDate: string;
    objective: string;
    description: string;
    weight: number;
    progress: number;
  }

  export interface DailyTask {
    id: number;
    decompositionId: number;
    weeklyId: number;
    date: string;
    title: string;
    description: string;
    estimatedMinutes: number;
    status: "pending" | "done" | "skipped";
    concretizationLevel: "coarse" | "concrete";
  }
  ```

  Extend the existing `Goal` interface:

  ```ts
  export interface Goal {
    // ...existing fields
    activeDecompositionId: number | null;
  }
  ```

  Define the LLM-output / pre-persistence "init" types co-located with the persisted types or in `src/lib/p2/types.ts` — Task 4 owns the `Init` shapes. For now in `src/lib/store/types.ts`, also export the input-row shapes the repos expect (the persisted types minus `id`):

  ```ts
  export type MonthlyRowInit  = Omit<Monthly,  "id">;
  export type WeeklyRowInit   = Omit<Weekly,   "id">;
  export type DailyTaskRowInit = Omit<DailyTask, "id">;
  export type DecompositionInit = Pick<Decomposition, "goalId">;
  ```

- [ ] **Step 3.6 — Extend repositories.**

  In `src/lib/store/repositories.ts`, follow the existing factory pattern. Add (and return from `makeRepositories`):

  ```ts
  const decompositions = {
    create(input: DecompositionInit): Decomposition {
      const row = db.prepare(
        "INSERT INTO decomposition (goal_id) VALUES (?) RETURNING id, goal_id, created_at"
      ).get(input.goalId) as any;
      return { id: row.id, goalId: row.goal_id, createdAt: row.created_at };
    },
    getById(id: number): Decomposition | null {
      const row = db.prepare(
        "SELECT id, goal_id, created_at FROM decomposition WHERE id = ?"
      ).get(id) as any;
      return row ? { id: row.id, goalId: row.goal_id, createdAt: row.created_at } : null;
    },
    listForGoal(goalId: number): Decomposition[] {
      const rows = db.prepare(
        "SELECT id, goal_id, created_at FROM decomposition WHERE goal_id = ? ORDER BY id"
      ).all(goalId) as any[];
      return rows.map((r) => ({ id: r.id, goalId: r.goal_id, createdAt: r.created_at }));
    },
  };

  function bulkInsertMonthly(rows: MonthlyRowInit[]): number[] {
    const stmt = db.prepare(
      `INSERT INTO monthly (decomposition_id, month_index, start_date, end_date,
                            objective, description, weight, progress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    );
    const ids: number[] = [];
    db.transaction((rs: MonthlyRowInit[]) => {
      for (const r of rs) {
        const { id } = stmt.get(
          r.decompositionId, r.monthIndex, r.startDate, r.endDate,
          r.objective, r.description, r.weight, r.progress,
        ) as any;
        ids.push(id);
      }
    })(rows);
    return ids;
  }

  const monthlies = {
    bulkInsert: bulkInsertMonthly,
    listForDecomposition(decompositionId: number): Monthly[] {
      const rows = db.prepare(
        `SELECT id, decomposition_id, month_index, start_date, end_date,
                objective, description, weight, progress
         FROM monthly WHERE decomposition_id = ? ORDER BY month_index`
      ).all(decompositionId) as any[];
      return rows.map(rowToMonthly);
    },
  };

  // ... weeklies + dailyTasks follow the same shape; mirror bulkInsertMonthly
  ```

  Add `goals.setActiveDecomposition(goalId, decompositionId)`:

  ```ts
  setActiveDecomposition(goalId: number, decompositionId: number): void {
    db.prepare("UPDATE goal SET active_decomposition_id = ? WHERE id = ?")
      .run(decompositionId, goalId);
  },
  ```

  Update `goals.get` to read and return `active_decomposition_id` as `activeDecompositionId`.

  Mirror the bulkInsert pattern exactly for `weeklies.bulkInsert(rows: WeeklyRowInit[])` and `dailyTasks.bulkInsert(rows: DailyTaskRowInit[])`. Add `weeklies.listForMonthly(monthlyId)`, `dailyTasks.listForWeekly(weeklyId)`, and:

  ```ts
  listInDateRange(decompositionId: number, from: string, to: string): DailyTask[] {
    const rows = db.prepare(
      `SELECT id, decomposition_id, weekly_id, date, title, description,
              estimated_minutes, status, concretization_level
       FROM daily_task
       WHERE decomposition_id = ? AND date BETWEEN ? AND ?
       ORDER BY date`
    ).all(decompositionId, from, to) as any[];
    return rows.map(rowToDailyTask);
  },
  ```

  Pick row-mapping helper names (`rowToMonthly`, `rowToWeekly`, `rowToDailyTask`) and keep them private at module scope — same way the existing repos handle snake-case-to-camel mapping.

  Also add this export at the bottom of `repositories.ts` (Task 6 depends on it):

  ```ts
  export type Repositories = ReturnType<typeof makeRepositories>;
  ```

  And add a `runInTransaction` method to the returned repositories object so the orchestrator in Task 6 can wrap its persist function atomically:

  ```ts
  return {
    goals, decompositions, monthlies, weeklies, dailyTasks,
    // ...all the existing repos (llmCache, elicitations, signals, alerts, queryGenomeState)
    runInTransaction(fn: () => void): void {
      db.transaction(fn)();
    },
  };
  ```

  **Out-of-scope finding to watch for.** If the existing `Goal` interface does **not** carry a `timeframe: string` field (HANDOFF §3 and the spec's §6.1 both assume it does), that's an S0 omission and Task 6 will need it. Confirm via `Grep` against `src/lib/store/types.ts` and `src/lib/s0/`. If absent, stop and report — do not silently add it in this task. The Goal+timeframe contract is S0's territory.

- [ ] **Step 3.7 — Run the failing tests; iterate until green.**

  ```
  npx vitest run src/lib/store/decomposition-repos.test.ts
  ```
  Expected: every test green. If a test fails, the most likely cause is a `decompositionId` not threading through correctly, or `activeDecompositionId` not surfacing on `goals.get`. Fix in place; do not edit the tests.

- [ ] **Step 3.8 — Run the rest of the store suite, verify no regression.**

  ```
  npx vitest run src/lib/store/
  ```
  Expected: every previously-passing test still green.

- [ ] **Step 3.9 — Commit.**

  ```
  git add src/lib/store/schema.sql src/lib/store/db.ts src/lib/store/types.ts src/lib/store/repositories.ts src/lib/store/decomposition-repos.test.ts
  git commit -m "feat(store): decomposition/monthly/weekly/daily_task schema + repos"
  ```

---

## Task 4: P2 primitives — retry + init schemas

**Files:**
- Create: `src/lib/p2/retry.ts`
- Create: `src/lib/p2/retry.test.ts`
- Create: `src/lib/p2/types.ts`
- Create: `src/lib/p2/types.test.ts`

Pure utilities; no external deps beyond `zod` and `vitest`. Tiny enough to ship together as one task.

- [ ] **Step 4.1 — Write the failing retry tests.**

  Create `src/lib/p2/retry.test.ts`:

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { withRetry } from "./retry";
  import { z } from "zod";

  describe("withRetry", () => {
    it("returns immediately on first-call success", async () => {
      const fn = vi.fn().mockResolvedValue(42);
      const result = await withRetry(fn);
      expect(result).toBe(42);
      expect(fn).toHaveBeenCalledOnce();
    });

    it("retries on a transient error then succeeds", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("p2: bad length"))
        .mockResolvedValueOnce("ok");
      const result = await withRetry(fn, { baseDelayMs: 0 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries on a ZodError", async () => {
      const zerr = new z.ZodError([]);
      const fn = vi.fn()
        .mockRejectedValueOnce(zerr)
        .mockResolvedValueOnce("ok");
      const result = await withRetry(fn, { baseDelayMs: 0 });
      expect(result).toBe("ok");
    });

    it("does NOT retry on a non-transient error", async () => {
      const fn = vi.fn().mockRejectedValue(new TypeError("nope"));
      await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow(/nope/);
      expect(fn).toHaveBeenCalledOnce();
    });

    it("throws a wrapped error after exhausting attempts", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("p2: bad"));
      await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 }))
        .rejects.toThrowError(/p2: retry exhausted after 3 attempts/);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("honours exponential backoff", async () => {
      vi.useFakeTimers();
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("p2: bad"))
        .mockRejectedValueOnce(new Error("p2: bad"))
        .mockResolvedValueOnce("ok");
      const promise = withRetry(fn, { attempts: 3, baseDelayMs: 100 });
      // first retry after 100ms × 2^0 = 100ms
      await vi.advanceTimersByTimeAsync(100);
      // second retry after 100ms × 2^1 = 200ms
      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;
      expect(result).toBe("ok");
      vi.useRealTimers();
    });
  });
  ```

- [ ] **Step 4.2 — Run retry tests, verify they fail.**

  ```
  npx vitest run src/lib/p2/retry.test.ts
  ```
  Expected: every test fails on `Cannot find module './retry'`.

- [ ] **Step 4.3 — Write the retry implementation.**

  Create `src/lib/p2/retry.ts`:

  ```ts
  import { z } from "zod";

  export interface RetryOpts {
    attempts?: number;
    isTransient?: (err: unknown) => boolean;
    baseDelayMs?: number;
  }

  export function defaultIsTransient(err: unknown): boolean {
    if (err instanceof z.ZodError) return true;
    if (err instanceof SyntaxError) return true;
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    if (msg.startsWith("p2:")) return true;
    if (/\b5\d\d\b/.test(msg)) return true;
    if (/(ECONNRESET|ETIMEDOUT|fetch failed|network error)/i.test(msg)) return true;
    return false;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOpts = {},
  ): Promise<T> {
    const attempts = opts.attempts ?? 3;
    const isTransient = opts.isTransient ?? defaultIsTransient;
    const baseDelayMs = opts.baseDelayMs ?? 250;

    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) throw err;
        if (i === attempts - 1) break;
        await sleep(baseDelayMs * Math.pow(2, i));
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`p2: retry exhausted after ${attempts} attempts: ${msg}`);
  }
  ```

- [ ] **Step 4.4 — Run retry tests, verify they pass.**

  ```
  npx vitest run src/lib/p2/retry.test.ts
  ```
  Expected: all 6 tests green.

- [ ] **Step 4.5 — Write the failing init-schema tests.**

  Create `src/lib/p2/types.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    monthlyInitSchema,
    weeklyInitSchema,
    dailyTaskInitSchema,
    monthlyArraySchema,
    weeklyArraySchema,
    dailyArraySchema,
  } from "./types";

  describe("monthlyInitSchema", () => {
    it("accepts a minimal valid shape", () => {
      expect(() => monthlyInitSchema.parse({
        objective: "Build aerobic base",
        description: "Establish 4 sessions per week.",
      })).not.toThrow();
    });
    it("rejects empty objective", () => {
      expect(() => monthlyInitSchema.parse({ objective: "", description: "x" })).toThrow();
    });
    it("rejects 121-char objective", () => {
      expect(() => monthlyInitSchema.parse({ objective: "x".repeat(121), description: "x" })).toThrow();
    });
  });

  describe("dailyTaskInitSchema", () => {
    it("accepts a minimal valid shape", () => {
      expect(() => dailyTaskInitSchema.parse({
        title: "Long run, 16 miles",
        description: "Steady pace, with hydration plan.",
        estimatedMinutes: 120,
      })).not.toThrow();
    });
    it("rejects zero estimatedMinutes", () => {
      expect(() => dailyTaskInitSchema.parse({
        title: "x", description: "x", estimatedMinutes: 0,
      })).toThrow();
    });
    it("rejects estimatedMinutes > 480", () => {
      expect(() => dailyTaskInitSchema.parse({
        title: "x", description: "x", estimatedMinutes: 481,
      })).toThrow();
    });
  });

  describe("array wrappers", () => {
    it("monthlyArraySchema rejects a bare top-level array (the §9 risk 1 lesson)", () => {
      expect(() => monthlyArraySchema.parse([
        { objective: "x", description: "x" },
      ])).toThrow();
    });
    it("monthlyArraySchema accepts { items: [...] }", () => {
      expect(() => monthlyArraySchema.parse({
        items: [{ objective: "x", description: "x" }],
      })).not.toThrow();
    });
  });
  ```

- [ ] **Step 4.6 — Run types tests, verify they fail.**

  ```
  npx vitest run src/lib/p2/types.test.ts
  ```
  Expected: every test fails on import error.

- [ ] **Step 4.7 — Write the init schemas.**

  Create `src/lib/p2/types.ts`:

  ```ts
  import { z } from "zod";

  export const monthlyInitSchema = z.object({
    objective:   z.string().min(1).max(120),
    description: z.string().min(1).max(400),
  });

  export const weeklyInitSchema = monthlyInitSchema;

  export const dailyTaskInitSchema = z.object({
    title:            z.string().min(1).max(120),
    description:      z.string().min(1).max(400),
    estimatedMinutes: z.number().int().positive().max(480),
  });

  const wrapItems = <T extends z.ZodTypeAny>(s: T) => z.object({ items: z.array(s) });

  export const monthlyArraySchema = wrapItems(monthlyInitSchema);
  export const weeklyArraySchema  = wrapItems(weeklyInitSchema);
  export const dailyArraySchema   = wrapItems(dailyTaskInitSchema);

  export type MonthlyInit   = z.infer<typeof monthlyInitSchema>;
  export type WeeklyInit    = z.infer<typeof weeklyInitSchema>;
  export type DailyTaskInit = z.infer<typeof dailyTaskInitSchema>;
  ```

- [ ] **Step 4.8 — Run types tests, verify they pass.**

  ```
  npx vitest run src/lib/p2/types.test.ts
  ```
  Expected: all 8 tests green.

- [ ] **Step 4.9 — Commit.**

  ```
  git add src/lib/p2/retry.ts src/lib/p2/retry.test.ts src/lib/p2/types.ts src/lib/p2/types.test.ts
  git commit -m "feat(p2): retry helper and init zod schemas"
  ```

---

## Task 5: P2 operators (`src/lib/p2/operators.ts`)

**Files:**
- Create: `src/lib/p2/operators.ts`
- Create: `src/lib/p2/operators.test.ts`

Depends on **Task 2** (`bypassCache`) and **Task 4** (init schemas). Three async functions; each one `gw.complete({ schema, bypassCache: true })` call. Operators are pure — no DB, no transaction, no calendar logic.

- [ ] **Step 5.1 — Write the failing tests.**

  Create `src/lib/p2/operators.test.ts`:

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { makeOperators } from "./operators";
  import type { MonthSpan, WeekSpan } from "@/lib/util/calendar";

  function makeStubGateway(canned: any) {
    return {
      complete: vi.fn().mockResolvedValue(canned),
      embed: vi.fn(),
      embedBatch: vi.fn(),
      batchComplete: vi.fn(),
    } as any;
  }

  const months: MonthSpan[] = Array.from({ length: 6 }, (_, i) => ({
    monthIndex: i, startDate: `2026-0${5 + i}-01`, endDate: `2026-0${5 + i}-30`,
  }));
  const weeks: WeekSpan[] = Array.from({ length: 4 }, (_, i) => ({
    weekIndex: i, startDate: `2026-05-${1 + i * 7}`, endDate: `2026-05-${7 + i * 7}`,
  }));

  describe("decomposeGoalToMonthly", () => {
    it("calls gw.complete once with bypassCache=true and returns the items array", async () => {
      const canned = { items: months.map((_, i) => ({ objective: `m${i}`, description: "x" })) };
      const gw = makeStubGateway(canned);
      const ops = makeOperators(gw, "openai/gpt-4o-mini");
      const result = await ops.decomposeGoalToMonthly("goal-ctx", months);
      expect(gw.complete).toHaveBeenCalledOnce();
      expect(gw.complete.mock.calls[0][0].bypassCache).toBe(true);
      expect(result).toHaveLength(6);
      expect(result[0].objective).toBe("m0");
    });

    it("throws a p2: length error on wrong-length response (transient to withRetry)", async () => {
      const gw = makeStubGateway({ items: [{ objective: "m0", description: "x" }] });
      const ops = makeOperators(gw, "openai/gpt-4o-mini");
      await expect(ops.decomposeGoalToMonthly("goal-ctx", months))
        .rejects.toThrowError(/p2: decomposeGoalToMonthly returned 1 items, expected 6/);
    });

    it("includes an explicit JSON-object example in the user prompt", async () => {
      const canned = { items: months.map((_, i) => ({ objective: `m${i}`, description: "x" })) };
      const gw = makeStubGateway(canned);
      const ops = makeOperators(gw, "openai/gpt-4o-mini");
      await ops.decomposeGoalToMonthly("goal-ctx", months);
      const userMsg = gw.complete.mock.calls[0][0].messages.find((m: any) => m.role === "user").content;
      expect(userMsg).toContain('{"items":');
    });
  });

  describe("decomposeMonthlyToWeekly", () => {
    it("passes the monthly context into the prompt and returns weeks", async () => {
      const canned = { items: weeks.map((_, i) => ({ objective: `w${i}`, description: "x" })) };
      const gw = makeStubGateway(canned);
      const ops = makeOperators(gw, "openai/gpt-4o-mini");
      const result = await ops.decomposeMonthlyToWeekly("goal-ctx", "monthly-ctx", weeks);
      expect(result).toHaveLength(4);
      const userMsg = gw.complete.mock.calls[0][0].messages.find((m: any) => m.role === "user").content;
      expect(userMsg).toContain("monthly-ctx");
    });
  });

  describe("decomposeWeeklyToDaily", () => {
    const dates = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07"];

    it("returns exactly dates.length daily-task inits with estimatedMinutes", async () => {
      const canned = { items: dates.map(() => ({
        title: "t", description: "d", estimatedMinutes: 45,
      })) };
      const gw = makeStubGateway(canned);
      const ops = makeOperators(gw, "openai/gpt-4o-mini");
      const result = await ops.decomposeWeeklyToDaily("goal-ctx", "monthly-ctx", "weekly-ctx", dates);
      expect(result).toHaveLength(7);
      expect(result[0].estimatedMinutes).toBe(45);
    });

    it("includes the coarse-but-actionable framing in the system prompt", async () => {
      const canned = { items: dates.map(() => ({ title: "t", description: "d", estimatedMinutes: 45 })) };
      const gw = makeStubGateway(canned);
      const ops = makeOperators(gw, "openai/gpt-4o-mini");
      await ops.decomposeWeeklyToDaily("goal-ctx", "monthly-ctx", "weekly-ctx", dates);
      const sysMsg = gw.complete.mock.calls[0][0].messages.find((m: any) => m.role === "system").content;
      expect(sysMsg).toMatch(/coarse|brand|vendor|concret/i);
    });
  });
  ```

- [ ] **Step 5.2 — Run operator tests, verify they fail.**

  ```
  npx vitest run src/lib/p2/operators.test.ts
  ```
  Expected: every test fails on import error.

- [ ] **Step 5.3 — Write the implementation.**

  Create `src/lib/p2/operators.ts`:

  ```ts
  import type { z } from "zod";
  import type { Gateway } from "@/lib/llm/gateway";
  import type { MonthSpan, WeekSpan } from "@/lib/util/calendar";
  import {
    monthlyInitSchema,
    weeklyInitSchema,
    dailyTaskInitSchema,
    monthlyArraySchema,
    weeklyArraySchema,
    dailyArraySchema,
    type MonthlyInit,
    type WeeklyInit,
    type DailyTaskInit,
  } from "./types";

  export interface P2Operators {
    decomposeGoalToMonthly(goalCtx: string, months: MonthSpan[]): Promise<MonthlyInit[]>;
    decomposeMonthlyToWeekly(goalCtx: string, monthlyCtx: string, weeks: WeekSpan[]): Promise<WeeklyInit[]>;
    decomposeWeeklyToDaily(
      goalCtx: string, monthlyCtx: string, weeklyCtx: string, dates: string[],
    ): Promise<DailyTaskInit[]>;
  }

  function assertLength<T>(items: T[], expected: number, label: string): T[] {
    if (items.length !== expected) {
      throw new Error(`p2: ${label} returned ${items.length} items, expected ${expected}`);
    }
    return items;
  }

  const SYSTEM_MONTHLY = `\
  You are a decomposition planner. Given a converged goal and N month spans, produce exactly N \
  monthly objectives (one per span, in chronological order). Output a JSON object with shape \
  {"items":[{"objective":"...","description":"..."}, ...]}. "objective" MUST be a short title \
  (<=120 chars); "description" MUST be 1-3 sentences explaining what success looks like at the \
  end of this month. Do NOT include weights, dates, brand names, or vendor URLs - those are \
  computed deterministically or added by a later concretization step.`;

  const SYSTEM_WEEKLY = `\
  You are a decomposition planner. Given a converged goal, a parent monthly objective, and N week \
  spans, produce exactly N weekly objectives (one per span, in chronological order). Output a JSON \
  object with shape {"items":[{"objective":"...","description":"..."}, ...]}. "objective" MUST be \
  a short title (<=120 chars); "description" MUST be 1-3 sentences. Do NOT include weights, dates, \
  brand names, or vendor URLs.`;

  const SYSTEM_DAILY = `\
  You are a decomposition planner. Given a converged goal, a parent monthly objective, a parent \
  weekly objective, and N dates, produce exactly N daily tasks (one per date, in chronological \
  order). Output a JSON object with shape \
  {"items":[{"title":"...","description":"...","estimatedMinutes":N}, ...]}. \
  Each daily task is going to be planned around by a calendar packer (P4). Be specific enough to \
  schedule and prepare for - name the activity, the rough form, and the resources someone would \
  already have - but DO NOT include brand-specific recommendations, vendor URLs, tutorial links, \
  or store-specific instructions. Those are added by a later concretization step. Title <=120 \
  chars; description 1-3 sentences; estimatedMinutes is a realistic single-session duration \
  (typically 15-120, never more than 480).`;

  function renderMonthlyPrompt(goalCtx: string, months: MonthSpan[]): string {
    const spanLines = months.map((m, i) =>
      `${i + 1}. ${m.startDate} -> ${m.endDate} (month ${i + 1} of ${months.length})`,
    ).join("\n");
    return `GOAL CONTEXT
  ============
  ${goalCtx}

  MONTH SPANS (produce exactly ${months.length} items, in this order)
  ====================================================
  ${spanLines}

  EXAMPLE OUTPUT (shape only; content fictional)
  {"items":[{"objective":"Build aerobic base","description":"Establish a consistent rhythm."}]}`;
  }

  function renderWeeklyPrompt(goalCtx: string, monthlyCtx: string, weeks: WeekSpan[]): string {
    const spanLines = weeks.map((w, i) =>
      `${i + 1}. ${w.startDate} -> ${w.endDate} (week ${i + 1} of ${weeks.length})`,
    ).join("\n");
    return `GOAL CONTEXT
  ============
  ${goalCtx}

  PARENT MONTHLY
  ==============
  ${monthlyCtx}

  WEEK SPANS (produce exactly ${weeks.length} items, in this order)
  ====================================================
  ${spanLines}

  EXAMPLE OUTPUT (shape only; content fictional)
  {"items":[{"objective":"Base mileage","description":"Three 30-minute easy runs."}]}`;
  }

  function renderDailyPrompt(
    goalCtx: string, monthlyCtx: string, weeklyCtx: string, dates: string[],
  ): string {
    const dateLines = dates.map((d, i) => `${i + 1}. ${d}`).join("\n");
    return `GOAL CONTEXT
  ============
  ${goalCtx}

  PARENT MONTHLY
  ==============
  ${monthlyCtx}

  PARENT WEEKLY
  =============
  ${weeklyCtx}

  DATES (produce exactly ${dates.length} items, in this order)
  ====================================================
  ${dateLines}

  EXAMPLE OUTPUT (shape only; content fictional)
  {"items":[{"title":"Easy 5k","description":"Conversational pace.","estimatedMinutes":30}]}`;
  }

  export function makeOperators(gw: Gateway, model: string): P2Operators {
    return {
      async decomposeGoalToMonthly(goalCtx, months) {
        const { items } = await gw.complete({
          model,
          bypassCache: true,
          schema: monthlyArraySchema,
          messages: [
            { role: "system", content: SYSTEM_MONTHLY },
            { role: "user",   content: renderMonthlyPrompt(goalCtx, months) },
          ],
        });
        return assertLength(items, months.length, "decomposeGoalToMonthly");
      },

      async decomposeMonthlyToWeekly(goalCtx, monthlyCtx, weeks) {
        const { items } = await gw.complete({
          model,
          bypassCache: true,
          schema: weeklyArraySchema,
          messages: [
            { role: "system", content: SYSTEM_WEEKLY },
            { role: "user",   content: renderWeeklyPrompt(goalCtx, monthlyCtx, weeks) },
          ],
        });
        return assertLength(items, weeks.length, "decomposeMonthlyToWeekly");
      },

      async decomposeWeeklyToDaily(goalCtx, monthlyCtx, weeklyCtx, dates) {
        const { items } = await gw.complete({
          model,
          bypassCache: true,
          schema: dailyArraySchema,
          messages: [
            { role: "system", content: SYSTEM_DAILY },
            { role: "user",   content: renderDailyPrompt(goalCtx, monthlyCtx, weeklyCtx, dates) },
          ],
        });
        return assertLength(items, dates.length, "decomposeWeeklyToDaily");
      },
    };
  }
  ```

- [ ] **Step 5.4 — Run operator tests, verify they pass.**

  ```
  npx vitest run src/lib/p2/operators.test.ts
  ```
  Expected: all 6 tests green.

- [ ] **Step 5.5 — Commit.**

  ```
  git add src/lib/p2/operators.ts src/lib/p2/operators.test.ts
  git commit -m "feat(p2): three per-layer LLM operators (monthly/weekly/daily)"
  ```

---

## Task 6: Decompose handler (`src/lib/p2/decompose-handler.ts`)

**Files:**
- Create: `src/lib/p2/decompose-handler.ts`
- Create: `src/lib/p2/decompose-handler.test.ts`

Depends on **Tasks 1, 3, 4, 5**. Orchestrator owns every side effect: renders the shared goal-context string once, runs three layers via `Promise.all`, wraps each operator call in `withRetry`, persists everything inside one `db.transaction`, then flips `goal.activeDecompositionId`.

- [ ] **Step 6.1 — Write the failing tests.**

  Create `src/lib/p2/decompose-handler.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";
  import { handleDecompose } from "./decompose-handler";
  import { openDb } from "@/lib/store/db";
  import { makeRepositories } from "@/lib/store/repositories";
  import type Database from "better-sqlite3";
  import * as calendar from "@/lib/util/calendar";

  let db: Database.Database;
  let repos: ReturnType<typeof makeRepositories>;

  beforeEach(() => {
    db = openDb(":memory:");
    repos = makeRepositories(db);
  });

  function makeGoal(spec: any, timeframe = "6 months") {
    return repos.goals.create({
      rawGoal: "run a marathon",
      convergedSpec: spec,
      timeframe,
    });
  }

  function makeStubOps(opts: { monthlyCalls?: number, failLayer3At?: number } = {}) {
    let monthlyCount = 0;
    let weeklyCount = 0;
    let dailyCount = 0;
    return {
      decomposeGoalToMonthly: vi.fn(async (_ctx, months) => {
        monthlyCount++;
        return months.map((_: any, i: number) => ({
          objective: `m${i}`, description: `monthly ${i}`,
        }));
      }),
      decomposeMonthlyToWeekly: vi.fn(async (_g, _m, weeks) => {
        weeklyCount++;
        return weeks.map((_: any, i: number) => ({
          objective: `w${i}`, description: `weekly ${i}`,
        }));
      }),
      decomposeWeeklyToDaily: vi.fn(async (_g, _m, _w, dates) => {
        dailyCount++;
        if (opts.failLayer3At !== undefined && dailyCount === opts.failLayer3At) {
          throw new Error("p2: retry exhausted after 3 attempts: simulated");
        }
        return dates.map(() => ({
          title: "t", description: "d", estimatedMinutes: 45,
        }));
      }),
    };
  }

  describe("handleDecompose", () => {
    it("persists 6 monthlies, ~28 weeklies, 185 daily tasks for 6-month marathon", async () => {
      const goal = makeGoal({
        scope: "marathon training",
        successMetric: "finish the race",
        constraints: "no injuries",
        motivation: "endurance",
        deadlineShape: "6 months",
      });
      const ops = makeStubOps();
      const result = await handleDecompose(
        { goalId: goal.id },
        { repos, ops, calendar, today: "2026-05-28" },
      );

      expect(result.decompositionId).toBeGreaterThan(0);
      const monthlies = repos.monthlies.listForDecomposition(result.decompositionId);
      expect(monthlies).toHaveLength(6);

      const allWeeklies = monthlies.flatMap((m) => repos.weeklies.listForMonthly(m.id));
      expect(allWeeklies.length).toBeGreaterThanOrEqual(26);
      expect(allWeeklies.length).toBeLessThanOrEqual(30);

      const dailyCount = allWeeklies.reduce(
        (n, w) => n + repos.dailyTasks.listForWeekly(w.id).length, 0,
      );
      expect(dailyCount).toBe(185);

      const goalAfter = repos.goals.get(goal.id);
      expect(goalAfter?.activeDecompositionId).toBe(result.decompositionId);
    });

    it("calls the three operators sibling-parallel: 1 monthly + 6 weekly + ~28 daily", async () => {
      const goal = makeGoal({
        scope: "x", successMetric: "x", constraints: "x", motivation: "x", deadlineShape: "x",
      });
      const ops = makeStubOps();
      await handleDecompose(
        { goalId: goal.id },
        { repos, ops, calendar, today: "2026-05-28" },
      );
      expect(ops.decomposeGoalToMonthly).toHaveBeenCalledOnce();
      expect(ops.decomposeMonthlyToWeekly).toHaveBeenCalledTimes(6);
      const dailyCalls = ops.decomposeWeeklyToDaily.mock.calls.length;
      expect(dailyCalls).toBeGreaterThanOrEqual(26);
      expect(dailyCalls).toBeLessThanOrEqual(30);
    });

    it("rolls back the whole transaction when one layer-3 call fails", async () => {
      const goal = makeGoal({
        scope: "x", successMetric: "x", constraints: "x", motivation: "x", deadlineShape: "x",
      });
      const ops = makeStubOps({ failLayer3At: 5 });
      await expect(handleDecompose(
        { goalId: goal.id },
        { repos, ops, calendar, today: "2026-05-28" },
      )).rejects.toThrow();

      expect(repos.decompositions.listForGoal(goal.id)).toHaveLength(0);
      expect(repos.goals.get(goal.id)?.activeDecompositionId).toBeNull();
    });

    it("throws when the goal has no convergedSpec", async () => {
      const goal = makeGoal(null);
      const ops = makeStubOps();
      await expect(handleDecompose(
        { goalId: goal.id },
        { repos, ops, calendar, today: "2026-05-28" },
      )).rejects.toThrowError(/not converged/);
    });

    it("two consecutive successful runs leave activeDecompositionId on the second", async () => {
      const goal = makeGoal({
        scope: "x", successMetric: "x", constraints: "x", motivation: "x", deadlineShape: "x",
      });
      const ops = makeStubOps();

      const r1 = await handleDecompose(
        { goalId: goal.id }, { repos, ops, calendar, today: "2026-05-28" });
      const r2 = await handleDecompose(
        { goalId: goal.id }, { repos, ops, calendar, today: "2026-05-28" });

      expect(r2.decompositionId).toBeGreaterThan(r1.decompositionId);
      expect(repos.goals.get(goal.id)?.activeDecompositionId).toBe(r2.decompositionId);
      expect(repos.decompositions.listForGoal(goal.id)).toHaveLength(2);
    });
  });
  ```

  Note on `goals.create`: extend the existing `goals.create` signature to accept `timeframe` if it doesn't already. If `Goal.timeframe` is not in the existing schema, this is an out-of-scope finding — **stop and report**.

- [ ] **Step 6.2 — Run handler tests, verify they fail.**

  ```
  npx vitest run src/lib/p2/decompose-handler.test.ts
  ```
  Expected: every test fails on `Cannot find module './decompose-handler'` or related.

- [ ] **Step 6.3 — Write the implementation.**

  Create `src/lib/p2/decompose-handler.ts`:

  ```ts
  import type { Repositories } from "@/lib/store/repositories";
  import type { Goal, MonthlyRowInit, WeeklyRowInit, DailyTaskRowInit }
    from "@/lib/store/types";
  import type { P2Operators } from "./operators";
  import type * as calendarModule from "@/lib/util/calendar";
  import { withRetry } from "./retry";

  export interface DecomposeDeps {
    repos: Repositories;
    ops: P2Operators;
    calendar: typeof calendarModule;
    today: string;
  }

  export interface DecomposeResult {
    decompositionId: number;
    tree: {
      monthlies: ReturnType<Repositories["monthlies"]["listForDecomposition"]>;
      weeklies: ReturnType<Repositories["weeklies"]["listForMonthly"]>[];
      dailyTasks: ReturnType<Repositories["dailyTasks"]["listForWeekly"]>[];
    };
  }

  function renderGoalContext(goal: Goal): string {
    const s = goal.convergedSpec!;
    return `Scope: ${s.scope}
  Success metric: ${s.successMetric}
  Constraints: ${s.constraints}
  Motivation: ${s.motivation}
  Deadline shape: ${s.deadlineShape}
  Timeframe: ${goal.timeframe}`;
  }

  function renderMonthlyContext(m: { objective: string; description: string },
                                span: { startDate: string; endDate: string }): string {
    return `Objective: ${m.objective}\nDescription: ${m.description}\nSpan: ${span.startDate} -> ${span.endDate}`;
  }

  function renderWeeklyContext(w: { objective: string; description: string },
                               span: { startDate: string; endDate: string }): string {
    return `Objective: ${w.objective}\nDescription: ${w.description}\nSpan: ${span.startDate} -> ${span.endDate}`;
  }

  export async function handleDecompose(
    input: { goalId: number },
    deps: DecomposeDeps,
  ): Promise<DecomposeResult> {
    const goal = deps.repos.goals.get(input.goalId);
    if (!goal || !goal.convergedSpec) {
      throw new Error(`p2: goal ${input.goalId} not converged`);
    }

    let skeleton: ReturnType<typeof deps.calendar.buildSkeleton>;
    try {
      skeleton = deps.calendar.buildSkeleton(goal.timeframe, deps.today);
    } catch (err) {
      throw new Error(`p2: ${(err as Error).message}`);
    }

    const goalCtx = renderGoalContext(goal);

    // Layer 1
    const monthlyInits = await withRetry(() =>
      deps.ops.decomposeGoalToMonthly(goalCtx, skeleton.months));

    // Layer 2 - sibling-parallel
    const weeklyInitsByMonth = await Promise.all(
      skeleton.months.map((m, i) =>
        withRetry(() => deps.ops.decomposeMonthlyToWeekly(
          goalCtx,
          renderMonthlyContext(monthlyInits[i], m),
          skeleton.weeksByMonth[i],
        )),
      ),
    );

    // Flatten layer-3 fan-out with all parent refs prepared up front.
    // WeekSpan.dates carries the ISO date array directly (T1 refactor: I-2 from code review).
    interface FlatWeek {
      monthIndex: number;
      weekIndexInMonth: number;
      weeklyInit: { objective: string; description: string };
      weekSpan: { startDate: string; endDate: string; dates: string[] };
      parentMonthlyCtx: string;
      weeklyCtx: string;
    }
    const flatWeeks: FlatWeek[] = [];
    for (let i = 0; i < skeleton.months.length; i++) {
      const monthlyCtxStr = renderMonthlyContext(monthlyInits[i], skeleton.months[i]);
      for (let j = 0; j < skeleton.weeksByMonth[i].length; j++) {
        const weekSpan = skeleton.weeksByMonth[i][j];
        const weeklyInit = weeklyInitsByMonth[i][j];
        flatWeeks.push({
          monthIndex: i,
          weekIndexInMonth: j,
          weeklyInit,
          weekSpan,
          parentMonthlyCtx: monthlyCtxStr,
          weeklyCtx: renderWeeklyContext(weeklyInit, weekSpan),
        });
      }
    }

    // Layer 3 - sibling-parallel
    const dailyInitsByWeek = await Promise.all(
      flatWeeks.map((w) =>
        withRetry(() => deps.ops.decomposeWeeklyToDaily(
          goalCtx, w.parentMonthlyCtx, w.weeklyCtx, w.weekSpan.dates,
        )),
      ),
    );

    // Persist transactionally via the runInTransaction helper exposed by repositories.ts
    // (added in Task 3 if absent; see the note below).
    let decompositionId = 0;

    const persist = () => {
      decompositionId = deps.repos.decompositions.create({ goalId: input.goalId }).id;

      const monthlyRows: MonthlyRowInit[] = monthlyInits.map((m, i) => ({
        decompositionId,
        monthIndex: i,
        startDate: skeleton.months[i].startDate,
        endDate: skeleton.months[i].endDate,
        objective: m.objective,
        description: m.description,
        weight: 1 / monthlyInits.length,
        progress: 0,
      }));
      const monthlyIds = deps.repos.monthlies.bulkInsert(monthlyRows);

      const weeklyRows: WeeklyRowInit[] = [];
      const weeklyOwnerIdx: number[] = [];
      for (let i = 0; i < skeleton.months.length; i++) {
        const monthlyId = monthlyIds[i];
        const weeks = skeleton.weeksByMonth[i];
        const weeklyInits = weeklyInitsByMonth[i];
        for (let j = 0; j < weeks.length; j++) {
          weeklyRows.push({
            decompositionId,
            monthlyId,
            weekIndex: weeks[j].weekIndex,
            startDate: weeks[j].startDate,
            endDate: weeks[j].endDate,
            objective: weeklyInits[j].objective,
            description: weeklyInits[j].description,
            weight: 1 / weeks.length,
            progress: 0,
          });
          weeklyOwnerIdx.push(i);
        }
      }
      const weeklyIds = deps.repos.weeklies.bulkInsert(weeklyRows);

      const dailyRows: DailyTaskRowInit[] = [];
      for (let g = 0; g < flatWeeks.length; g++) {
        const weeklyId = weeklyIds[g];
        const dates = flatWeeks[g].dates;
        const inits = dailyInitsByWeek[g];
        for (let k = 0; k < dates.length; k++) {
          dailyRows.push({
            decompositionId,
            weeklyId,
            date: dates[k],
            title: inits[k].title,
            description: inits[k].description,
            estimatedMinutes: inits[k].estimatedMinutes,
            status: "pending",
            concretizationLevel: "coarse",
          });
        }
      }
      deps.repos.dailyTasks.bulkInsert(dailyRows);

      deps.repos.goals.setActiveDecomposition(input.goalId, decompositionId);
    };

    // Use the transaction helper exposed by repositories.ts (add `runInTransaction` in Task 3 if absent).
    deps.repos.runInTransaction(persist);

    // Build the tree result.
    const monthlies = deps.repos.monthlies.listForDecomposition(decompositionId);
    const weeklies = monthlies.map((m) => deps.repos.weeklies.listForMonthly(m.id));
    const dailyTasks = weeklies.flat().map((w) => deps.repos.dailyTasks.listForWeekly(w.id));

    return {
      decompositionId,
      tree: { monthlies, weeklies, dailyTasks },
    };
  }
  ```

  **Note for the worker:** If `repos.runInTransaction` does not exist on the existing `Repositories` shape, add it in this task to `src/lib/store/repositories.ts`:

  ```ts
  return {
    // ...existing repos
    runInTransaction(fn: () => void): void {
      db.transaction(fn)();
    },
  };
  ```

  Add `runInTransaction` to the `Repositories` type / `makeRepositories` return.

- [ ] **Step 6.4 — Run handler tests, verify they pass.**

  ```
  npx vitest run src/lib/p2/decompose-handler.test.ts
  ```
  Expected: all 5 tests green. The exact weekly/daily counts depend on `calendar.buildSkeleton` — the tests assert a range for weeklies and pin 185 for dailies, matching the calendar test.

- [ ] **Step 6.5 — Commit.**

  ```
  git add src/lib/p2/decompose-handler.ts src/lib/p2/decompose-handler.test.ts src/lib/store/repositories.ts
  git commit -m "feat(p2): decompose-handler orchestrates 3-layer fan-out with transactional persist"
  ```

---

## Task 7: `/api/decompose` route

**Files:**
- Create: `src/app/api/decompose/route.ts`
- Create: `src/app/api/decompose/route.test.ts`

Depends on **Task 6**. Thin route wrapper: reads `P2_DECOMPOSE_MODEL` (default `openai/gpt-4o-mini`), instantiates gateway and ops, calls `handleDecompose`, maps errors to HTTP status codes per §9 of the spec.

- [ ] **Step 7.1 — Write the failing tests.**

  Create `src/app/api/decompose/route.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { mapErrorToStatus } from "./route";

  describe("mapErrorToStatus", () => {
    it("returns 404 for not-converged errors", () => {
      expect(mapErrorToStatus("p2: goal 7 not converged")).toBe(404);
    });

    it("returns 400 for unparseable timeframe errors", () => {
      expect(mapErrorToStatus("p2: unparseable timeframe: forever")).toBe(400);
    });

    it("returns 400 for out-of-range timeframe errors", () => {
      expect(mapErrorToStatus("p2.calendar: out-of-range months: 99")).toBe(400);
    });

    it("returns 503 for retry-exhausted LLM failures", () => {
      expect(mapErrorToStatus("p2: retry exhausted after 3 attempts: ECONNRESET")).toBe(503);
    });

    it("returns 500 for everything else", () => {
      expect(mapErrorToStatus("kaboom")).toBe(500);
      expect(mapErrorToStatus("")).toBe(500);
    });
  });
  ```

  Note on coverage: the end-to-end POST → handler → response shape is covered by Task 6's integration tests (which already drive `handleDecompose` directly) and by the orchestrator's live run. Testing the route's HTTP wrapper here would require either spinning up real DB/gateway (heavy) or vi.mocking the handler module (fragile with bound imports). The pure error-mapping helper is what's worth unit-testing.

- [ ] **Step 7.2 — Run route tests, verify they fail.**

  ```
  npx vitest run src/app/api/decompose/route.test.ts
  ```
  Expected: every test fails on import error.

- [ ] **Step 7.3 — Write the route.**

  Create `src/app/api/decompose/route.ts`:

  ```ts
  import { NextResponse } from "next/server";
  import { openDb } from "@/lib/store/db";
  import { makeRepositories } from "@/lib/store/repositories";
  import { makeGateway } from "@/lib/llm/gateway";
  import { makeOperators } from "@/lib/p2/operators";
  import * as calendar from "@/lib/util/calendar";
  import { handleDecompose } from "@/lib/p2/decompose-handler";

  // Pure error→HTTP status mapping. Exported as a *function* (not a route export name) so the
  // unit tests in route.test.ts can hit it directly. `next build` only validates POST/GET/etc as
  // route handlers (HANDOFF §9 risk 1); arbitrary additional exports from a route file are fine
  // as long as their names don't collide with Next's reserved handler names.
  export function mapErrorToStatus(msg: string): number {
    if (/not converged/.test(msg)) return 404;
    if (/unparseable timeframe|out-of-range/.test(msg)) return 400;
    if (/retry exhausted/.test(msg)) return 503;
    return 500;
  }

  export async function POST(req: Request): Promise<Response> {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (typeof body?.goalId !== "number") {
      return NextResponse.json({ error: "goalId (number) is required" }, { status: 400 });
    }

    try {
      const db = openDb(process.env.SPACATO_DB_PATH);
      const repos = makeRepositories(db);
      const apiKey = process.env.OPENROUTER_API_KEY!;
      const gw = makeGateway({ apiKey, cache: repos.llmCache });
      const model = process.env.P2_DECOMPOSE_MODEL ?? "openai/gpt-4o-mini";
      const ops = makeOperators(gw, model);
      const today = new Date().toISOString().slice(0, 10);

      const result = await handleDecompose({ goalId: body.goalId }, { repos, ops, calendar, today });
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      const msg = (err as Error).message;
      return NextResponse.json({ error: msg }, { status: mapErrorToStatus(msg) });
    }
  }
  ```

  **Note on the inner-handler export.** Per HANDOFF §9 risk 1, Next App Router routes must not re-export inner handlers as `default` / arbitrary names because `next build` rejects them. Test imports must reach in via the source module directly. Verify by reading `src/app/api/signals/route.ts` for the established pattern. If that file already exports an inner request handler differently (e.g. with a different name), mirror that exact pattern here.

- [ ] **Step 7.4 — Run route tests, verify they pass.**

  ```
  npx vitest run src/app/api/decompose/route.test.ts
  ```
  Expected: all 4 tests green.

- [ ] **Step 7.5 — Run the full vitest suite, verify the work integrates cleanly.**

  ```
  npx vitest run
  ```
  Expected: every previously-green test still green; the new tests add ~24 to the suite total. **Per worker discipline you do not gate on `next build` or `tsc`** — the orchestrator runs those at integration time.

- [ ] **Step 7.6 — Commit.**

  ```
  git add src/app/api/decompose/route.ts src/app/api/decompose/route.test.ts
  git commit -m "feat(api): POST /api/decompose with attributed error codes (400/404/503/200)"
  ```

---

## Out-of-CI live run (orchestrator does this; not a worker task)

After the orchestrator merges all seven tasks and confirms `npm test`, `npm run typecheck`, and `npm run build` are green:

```bash
# from c:\dev\Spacato, with OPENROUTER_API_KEY in .env.local
npm run dev
# in a second shell:
curl -s -X POST http://localhost:3000/api/decompose \
  -H 'Content-Type: application/json' \
  -d '{"goalId": <the converged marathon goal id from the S0 live convergence run>}'
```

Eyeball per §10.4 of the spec: tree is coherent end-to-end, `estimatedMinutes` values are in the 15–120 range, no brand names / vendor URLs / tutorial links anywhere, cost ≈ $0.013 in the OpenRouter dashboard, wall-clock ≤ 60 s. Record the tree to `docs/live-runs/2026-MM-DD-p2-marathon.md` for spec calibration evidence.

---

## Self-review (orchestrator's checklist after worker review)

Spec coverage map:

| Spec section | Task |
|---|---|
| §1 in-scope: calendar | T1 |
| §1 in-scope: gateway bypassCache | T2 |
| §1 in-scope: schema/types/repos | T3 |
| §1 in-scope: retry | T4 (with T5) |
| §1 in-scope: types/zod schemas | T4 |
| §1 in-scope: three operators | T5 |
| §1 in-scope: orchestrator + transactional persist | T6 |
| §1 in-scope: route | T7 |
| §3 architecture: per-parent fan-out via Promise.all | T6 (tested) |
| §5 data model: 4 tables + indices + column | T3 |
| §5 data model: TS interfaces | T3 |
| §5 data model: init schemas | T4 |
| §6 calendar algorithm: rolling spans + week clipping | T1 (tested) |
| §6 retry semantics | T4 (tested) |
| §6 weight init = 1/N | T6 (in persist) |
| §7 operator contracts | T5 |
| §7 prompt shape (explicit JSON example + enumerated constraint) | T5 (tested for monthly + daily) |
| §7 bypassCache on every P2 call | T5 (tested) |
| §8 lifecycle: layers outside tx, persist inside tx | T6 (tested via rollback test) |
| §9 errors: 400/404/503/200 mapping | T7 (tested) |
| §9 errors: transactional rollback | T6 (tested) |
| §10 testing: ~24 new tests | T1+T2+T3+T4+T5+T6+T7 total ≈ 7+3+6+14+6+5+4 = ~45 tests (above target — coverage richer than minimum) |
| §10.4 manual live run | orchestrator step (above) |

No spec section is unmapped. No task references an identifier defined nowhere (every type, repo method, and helper appears in the task that creates it). No "TBD" / "TODO" anywhere in this plan.
