# Spacato Phase A — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sequential foundation — `llm-gateway`, `plan-store`, `esc-core` — so the two Phase-B consumers (S0 elicitation, P5 signals) can be built in parallel on top of validated interfaces.

**Architecture:** A Next.js (TypeScript) app. `plan-store` owns SQLite (better-sqlite3) with typed repositories. `llm-gateway` is the only module that touches OpenRouter, with content-addressed caching, structured (zod-validated) output, batching, and model routing; it takes an injectable `fetch` so tests never hit the network. `esc-core` is a generic LLM-operator evolutionary engine whose operators and fitness are injected, so its loop is tested deterministically with a mock target.

**Tech Stack:** Next.js 14 (app router, TypeScript), better-sqlite3, zod, Vitest. Package manager: npm.

> Scope note: this plan is **Phase A only**. S0 and P5 get their own plans after revision gate R1 (spec §12).

---

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.mjs`, `.env.local.example`
- Create: `src/lib/.gitkeep`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "spacato",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "better-sqlite3": "11.1.2",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "@types/node": "20.14.13",
    "@types/react": "18.3.3",
    "@types/better-sqlite3": "7.6.11",
    "vitest": "2.0.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "tests", "next-env.d.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`, `next.config.mjs`, `.env.local.example`**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

`next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
const nextConfig = { experimental: { serverComponentsExternalPackages: ["better-sqlite3"] } };
export default nextConfig;
```

`.env.local.example`:
```
OPENROUTER_API_KEY=sk-or-replace-me
```

- [ ] **Step 4: Write the smoke test** — `tests/smoke.test.ts`

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs the test runner", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Install and run the smoke test**

Run: `npm install && npx vitest run tests/smoke.test.ts`
Expected: 1 passing test.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts next.config.mjs .env.local.example tests/smoke.test.ts
git commit -m "chore: scaffold Next.js + Vitest project"
```

---

### Task 2: `plan-store` — SQLite schema + typed repositories

**Files:**
- Create: `src/lib/store/schema.sql`, `src/lib/store/db.ts`, `src/lib/store/repositories.ts`, `src/lib/store/types.ts`
- Test: `tests/store/repositories.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/store/repositories.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";

describe("plan-store repositories", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
  });

  it("creates and reads a goal", () => {
    const g = repos.goals.create({ title: "Run a marathon", rawText: "I want to run a marathon" });
    expect(g.id).toBeTypeOf("number");
    expect(repos.goals.get(g.id)?.title).toBe("Run a marathon");
  });

  it("stores converged_spec on a goal", () => {
    const g = repos.goals.create({ title: "x", rawText: "x" });
    repos.goals.setConvergedSpec(g.id, { scope: "narrow" });
    expect(repos.goals.get(g.id)?.convergedSpec).toEqual({ scope: "narrow" });
  });

  it("caches and retrieves an llm response", () => {
    repos.llmCache.put("hash1", "model-a", { ok: true });
    expect(repos.llmCache.get("hash1", "model-a")).toEqual({ ok: true });
    expect(repos.llmCache.get("missing", "model-a")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/repositories.test.ts`
Expected: FAIL — cannot find module `@/lib/store/db`.

- [ ] **Step 3: Write `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS goal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  converged_spec_json TEXT,
  status TEXT NOT NULL DEFAULT 'eliciting',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS elicitation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  generation INTEGER NOT NULL DEFAULT 0,
  population_json TEXT NOT NULL DEFAULT '[]',
  belief_json TEXT NOT NULL DEFAULT '{}',
  pending_question_json TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS external_signal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  relevance_score REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alert (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES external_signal(id),
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  impact_score REAL NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_cache (
  prompt_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (prompt_hash, model)
);
```

- [ ] **Step 4: Write `db.ts` and `types.ts`**

`src/lib/store/types.ts`:
```ts
export interface Goal {
  id: number;
  title: string;
  rawText: string;
  convergedSpec: unknown | null;
  status: string;
}
```

`src/lib/store/db.ts`:
```ts
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function openDb(file = "spacato.sqlite"): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(path.join(process.cwd(), "src/lib/store/schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
```

- [ ] **Step 5: Write `repositories.ts`**

```ts
import type { Db } from "./db";
import type { Goal } from "./types";

export function makeRepositories(db: Db) {
  return {
    goals: {
      create(input: { title: string; rawText: string }): Goal {
        const info = db
          .prepare("INSERT INTO goal (title, raw_text) VALUES (?, ?)")
          .run(input.title, input.rawText);
        return this.get(Number(info.lastInsertRowid))!;
      },
      get(id: number): Goal | undefined {
        const row = db.prepare("SELECT * FROM goal WHERE id = ?").get(id) as any;
        if (!row) return undefined;
        return {
          id: row.id,
          title: row.title,
          rawText: row.raw_text,
          convergedSpec: row.converged_spec_json ? JSON.parse(row.converged_spec_json) : null,
          status: row.status,
        };
      },
      setConvergedSpec(id: number, spec: unknown): void {
        db.prepare(
          "UPDATE goal SET converged_spec_json = ?, status = 'converged', updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(spec), id);
      },
    },
    llmCache: {
      get(hash: string, model: string): unknown | undefined {
        const row = db
          .prepare("SELECT response_json FROM llm_cache WHERE prompt_hash = ? AND model = ?")
          .get(hash, model) as any;
        return row ? JSON.parse(row.response_json) : undefined;
      },
      put(hash: string, model: string, response: unknown): void {
        db.prepare(
          "INSERT OR REPLACE INTO llm_cache (prompt_hash, model, response_json) VALUES (?, ?, ?)"
        ).run(hash, model, JSON.stringify(response));
      },
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/store/repositories.test.ts`
Expected: 3 passing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/store tests/store
git commit -m "feat(store): SQLite schema and typed goal/llm-cache repositories"
```

---

### Task 3: `llm-gateway` — OpenRouter with caching, structured output, batching

**Files:**
- Create: `src/lib/llm/gateway.ts`, `src/lib/llm/hash.ts`
- Test: `tests/llm/gateway.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/llm/gateway.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";

const schema = z.object({ answer: z.string() });

function recordedFetch(body: object) {
  return async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
      { status: 200 }
    );
}

describe("llm-gateway", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("returns schema-validated structured output", async () => {
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn: recordedFetch({ answer: "hi" }) });
    const out = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    expect(out).toEqual({ answer: "hi" });
  });

  it("serves the second identical call from cache (no second fetch)", async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return recordedFetch({ answer: "cached" })(); };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const req = { model: "m", messages: [{ role: "user", content: "q" }], schema };
    await gw.complete(req);
    await gw.complete(req);
    expect(calls).toBe(1);
  });

  it("batchComplete resolves all requests", async () => {
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn: recordedFetch({ answer: "b" }) });
    const reqs = [1, 2, 3].map((n) => ({ model: "m", messages: [{ role: "user", content: `q${n}` }], schema }));
    const outs = await gw.batchComplete(reqs);
    expect(outs).toHaveLength(3);
    expect(outs[0]).toEqual({ answer: "b" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/gateway.test.ts`
Expected: FAIL — cannot find module `@/lib/llm/gateway`.

- [ ] **Step 3: Write `hash.ts`**

```ts
import { createHash } from "node:crypto";

export function promptHash(model: string, messages: unknown, schemaName: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, messages, schemaName }))
    .digest("hex");
}
```

- [ ] **Step 4: Write `gateway.ts`**

```ts
import type { ZodType } from "zod";
import { promptHash } from "./hash";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
export interface LlmRequest<T> { model: string; messages: ChatMessage[]; schema: ZodType<T>; }
export interface CachePort {
  get(hash: string, model: string): unknown | undefined;
  put(hash: string, model: string, response: unknown): void;
}
export interface GatewayDeps {
  apiKey: string;
  cache: CachePort;
  fetchFn?: typeof fetch;
  endpoint?: string;
}

export function makeGateway(deps: GatewayDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = deps.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";

  async function complete<T>(req: LlmRequest<T>): Promise<T> {
    const hash = promptHash(req.model, req.messages, req.schema.description ?? "schema");
    const cached = deps.cache.get(hash, req.model);
    if (cached !== undefined) return req.schema.parse(cached);

    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: req.model, messages: req.messages }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const json: any = await res.json();
    const content = json.choices?.[0]?.message?.content;
    const parsed = req.schema.parse(JSON.parse(content));
    deps.cache.put(hash, req.model, parsed);
    return parsed;
  }

  async function batchComplete<T>(reqs: LlmRequest<T>[]): Promise<T[]> {
    return Promise.all(reqs.map(complete));
  }

  return { complete, batchComplete };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/llm/gateway.test.ts`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm tests/llm
git commit -m "feat(llm): OpenRouter gateway with caching, structured output, batching"
```

---

### Task 4: `esc-core` — generic LLM-operator evolutionary engine

**Files:**
- Create: `src/lib/esc/core.ts`
- Test: `tests/esc/core.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/esc/core.test.ts`

Uses a deterministic mock config (no LLM): genomes are numbers, fitness is closeness to a hidden target, operators are arithmetic. Verifies the loop converges and that `step` advances one generation.

```ts
import { describe, it, expect } from "vitest";
import { runToConvergence, step, type EscConfig, type EscState } from "@/lib/esc/core";

const TARGET = 42;
function mockConfig(): EscConfig<number> {
  return {
    maxGenerations: 100,
    async seed() { return [0, 10, 90, 100].map((v) => ({ value: v })); },
    async crossover(a, b) { return { value: Math.round((a.value + b.value) / 2) }; },
    async mutate(g) { return { value: g.value + (g.value < TARGET ? 1 : -1) }; },
    async fitness(pop) { return pop.map((g) => -Math.abs(g.value - TARGET)); },
    select(pop, scores) {
      return pop
        .map((g, i) => ({ g, s: scores[i] }))
        .sort((x, y) => y.s - x.s)
        .slice(0, 2)
        .map((x) => x.g);
    },
    converged(state: EscState<number>) { return state.bestScore >= -0.0001; },
  };
}

describe("esc-core", () => {
  it("converges to the hidden target with a mock fitness", async () => {
    const final = await runToConvergence(mockConfig());
    expect(final.population.some((g) => g.value === TARGET)).toBe(true);
    expect(final.generation).toBeLessThanOrEqual(100);
  });

  it("step advances exactly one generation", async () => {
    const cfg = mockConfig();
    const seeded = await cfg.seed();
    const scores = await cfg.fitness(seeded);
    const s0: EscState<number> = { population: seeded, generation: 0, bestScore: Math.max(...scores) };
    const s1 = await step(cfg, s0);
    expect(s1.generation).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/esc/core.test.ts`
Expected: FAIL — cannot find module `@/lib/esc/core`.

- [ ] **Step 3: Write `core.ts`**

```ts
export interface Genome<T> { value: T }
export interface EscState<T> { population: Genome<T>[]; generation: number; bestScore: number; }
export interface EscConfig<T> {
  maxGenerations: number;
  seed(): Promise<Genome<T>[]>;
  crossover(a: Genome<T>, b: Genome<T>): Promise<Genome<T>>;
  mutate(g: Genome<T>): Promise<Genome<T>>;
  fitness(pop: Genome<T>[]): Promise<number[]>;
  select(pop: Genome<T>[], scores: number[]): Genome<T>[];
  converged(state: EscState<T>): boolean;
}

async function breed<T>(cfg: EscConfig<T>, parents: Genome<T>[]): Promise<Genome<T>[]> {
  const children: Genome<T>[] = [...parents];
  for (let i = 0; i < parents.length; i++) {
    const a = parents[i];
    const b = parents[(i + 1) % parents.length];
    children.push(await cfg.mutate(await cfg.crossover(a, b)));
  }
  return children;
}

export async function step<T>(cfg: EscConfig<T>, state: EscState<T>): Promise<EscState<T>> {
  const scores = await cfg.fitness(state.population);
  const parents = cfg.select(state.population, scores);
  const population = await breed(cfg, parents);
  const newScores = await cfg.fitness(population);
  return { population, generation: state.generation + 1, bestScore: Math.max(...newScores) };
}

export async function runToConvergence<T>(cfg: EscConfig<T>): Promise<EscState<T>> {
  const seeded = await cfg.seed();
  const scores = await cfg.fitness(seeded);
  let state: EscState<T> = { population: seeded, generation: 0, bestScore: Math.max(...scores) };
  while (!cfg.converged(state) && state.generation < cfg.maxGenerations) {
    state = await step(cfg, state);
  }
  return state;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/esc/core.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests from Tasks 1–4 passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/esc tests/esc
git commit -m "feat(esc): generic LLM-operator evolutionary core with converge-once and step lifecycles"
```

---

## Revision gate R1 (per spec §12)

After Task 4, **stop and review**: do the `llm-gateway`, `plan-store`, and `esc-core` interfaces hold up against the real needs of S0 and P5? Amend the spec and these interfaces before writing the Phase-B plans (S0 elicitation, P5 signals). Only then write those two plans.

## Self-review notes

- **Spec coverage (Phase A):** §4 store → Task 2; §5 gateway → Task 3; §6 esc-core → Task 4; §10 testing (mock fitness, recorded responses) → Tasks 3–4; §11 key handling (server-only, injectable fetch) → Task 3. S0 (§7) and P5 (§8) are deferred to post-R1 plans by design.
- **Type consistency:** `Genome<T>`, `EscConfig<T>`, `EscState<T>` defined once in Task 4 and used consistently; `CachePort` in Task 3 matches the `llmCache` repo shape from Task 2 (`get(hash, model)`, `put(hash, model, response)`).
- **No placeholders:** every code step contains full code; every run step has an exact command and expected result.
