# S0 Semantic Distance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Persona:** every worker adopts the canonical role prompt (WORKFLOW.md): senior systems designer, isolation-and-clarity, heuristics-first, real-tested-work-only.
>
> **Code-change hygiene (WORKFLOW.md):** no `// edit:` / `// was:` / `// previously …` / `// NEW —` comments, no `*_v2` / `*_new` / `legacy_*` identifiers, no parallel-clone files. Patch in situ; git is where the previous version lives.
>
> **Branch:** work on a fresh `fix/s0-semantic-distance` branch off `main` (which currently sits at the merged P5 work and the live-found fixes are on `fix/next-build-route-exports` — see the spec preamble for context).

**Goal:** Replace S0's exact-string Hamming `distance()` with OpenRouter-embedding cosine distance, with a token-Jaccard fallback when a vector is missing, so the Bayesian elicitation actually discriminates real LLM-generated free-text interpretations.

**Architecture:** Embeddings are computed eagerly at op-output time and stored in a content-addressed sidecar map (`vectors_json` column on `elicitation_state`). A `DistanceFn` is built once per request from that map and injected into `sigma` / `updateBelief` / `expectedPosteriorEntropy` / `selectQuestion`. The orchestrator owns the embed lifecycle; operators stay pure. Embedding failures degrade gracefully to Jaccard.

**Tech Stack:** TypeScript, Next.js 14, SQLite via `better-sqlite3`, Zod, `node:crypto`. Vitest with the existing recorded-`fetchFn` pattern.

**Spec:** `docs/superpowers/specs/2026-05-28-s0-semantic-distance-design.md`. Section refs below (e.g. §6.3) point into it.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/util/text.ts` | create | Single source of truth for `tokenise` + `STOP_WORDS`. Imported by `p5/relevance.ts` and `s0/belief.ts`. |
| `src/lib/util/hash.ts` | create | `contentHash(value): string` — canonical JSON (sorted keys recursively) → sha256 → first 16 hex chars. Pure, no external deps. |
| `src/lib/p5/relevance.ts` | modify (small) | Import `tokenise` from `@/lib/util/text`; remove the local copy. No behaviour change. |
| `src/lib/llm/gateway.ts` | modify | Add `embed(text, model): Promise<number[]>` and `embedBatch(texts, model): Promise<number[][]>`. POST `https://openrouter.ai/api/v1/embeddings` (overridable via new `embeddingEndpoint` dep). Cache keyed via `promptHash(model, [], "embed:<text>")`. Same bounded-concurrency worker-pool as `batchComplete`. |
| `src/lib/store/schema.sql` | modify | Add `vectors_json TEXT NOT NULL DEFAULT '{}'` column to `elicitation_state`. |
| `src/lib/store/types.ts` | modify | Extend `ElicitationState` with `vectors: Record<string, number[]>`. |
| `src/lib/store/repositories.ts` | modify | `getElicitation` parses `vectors_json`; `elicitations.update` serialises `patch.vectors`. |
| `src/lib/s0/belief.ts` | rewrite | Export `type DistanceFn`, `cosineDistance`, `jaccardDistance`, `makeDistanceFn`. `TAU` becomes exported `const = 0.2`. `sigma` / `updateBelief` take `distance: DistanceFn` as the last argument. The old module-level exact-Hamming `distance` is removed. |
| `src/lib/s0/acquisition.ts` | modify | `expectedPosteriorEntropy` and `selectQuestion` take `distance: DistanceFn` as the last argument. |
| `src/lib/s0/orchestrator.ts` | modify | `OrchestratorState` gains `vectors: Record<string, number[]>`. `startElicitation` and `answerQuestion` take an `embed: (text) => Promise<number[]>` dep. After every `ops.seed/crossover/mutate`, the orchestrator embeds new genomes (via content-hash, skipping cached) and rebuilds the `DistanceFn`. |
| `src/lib/s0/elicit-handler.ts` | modify | `ElicitDeps` gains `embed`. `toState` reads `row.vectors`; `persist` writes `s.vectors`. |
| `src/app/api/elicit/route.ts` | modify (small) | Read `S0_EMBED_MODEL` env var (default `openai/text-embedding-3-small`); build `embed = (t) => gw.embed(t, EMBED_MODEL)`; pass through to `handleElicit`. |

**Import graph stays acyclic.** New utils sit beneath every consumer. No file imports the route. `belief.ts` imports `util/text` (Jaccard) and `util/hash` (sidecar key lookup).

---

## Shared types and signatures used across tasks

```ts
// src/lib/s0/belief.ts (exported)
export type DistanceFn = (a: GoalInterpretation, b: GoalInterpretation) => number;   // [0, 1]
export const TAU = 0.2;
export function cosineDistance(u: number[], v: number[]): number;
export function jaccardDistance(a: GoalInterpretation, b: GoalInterpretation): number;
export function makeDistanceFn(vectors: Record<string, number[]>): DistanceFn;
export function sigma(pop: Genome<GoalInterpretation>[], k: number, i: number, j: number, distance: DistanceFn): number;
export function updateBelief(belief: Belief, pop: Genome<GoalInterpretation>[], q: ElicitationQuestion, answer: "a" | "b", distance: DistanceFn): Belief;

// src/lib/s0/acquisition.ts (exported)
export function expectedPosteriorEntropy(belief: Belief, pop: Genome<GoalInterpretation>[], q: ElicitationQuestion, distance: DistanceFn): number;
export function selectQuestion(belief: Belief, pop: Genome<GoalInterpretation>[], distance: DistanceFn): ElicitationQuestion | null;

// src/lib/s0/orchestrator.ts
export interface OrchestratorState {
  population: Genome<GoalInterpretation>[];
  belief: Belief;
  generation: number;
  pendingQuestion: ElicitationQuestion | null;
  status: "active" | "converged";
  convergedSpec: GoalInterpretation | null;
  vectors: Record<string, number[]>;
}
export async function startElicitation(ops: ElicitationOps, cfg: ElicitationConfig, embed: (text: string) => Promise<number[]>): Promise<OrchestratorState>;
export async function answerQuestion(ops: ElicitationOps, state: OrchestratorState, answer: "a" | "b", cfg: ElicitationConfig, embed: (text: string) => Promise<number[]>): Promise<OrchestratorState>;

// src/lib/s0/elicit-handler.ts
export interface ElicitDeps {
  repos: ReturnType<typeof makeRepositories>;
  ops: ElicitationOps;
  embed: (text: string) => Promise<number[]>;
}
```

---

## Task 1: Shared utils (`util/text.ts`, `util/hash.ts`) and `relevance.ts` refactor

**Files:**
- Create: `src/lib/util/text.ts`
- Create: `src/lib/util/hash.ts`
- Modify: `src/lib/p5/relevance.ts`
- Test: `tests/util/text.test.ts`
- Test: `tests/util/hash.test.ts`

**Context:** The Jaccard fallback in `belief.ts` needs the same tokenizer the relevance pipeline already uses. Rather than duplicate it, extract `tokenise` + `STOP_WORDS` into a shared util module that both consume. `contentHash` is the sidecar key — must be deterministic and key-order-invariant so the same interpretation always hashes to the same key regardless of object literal ordering.

- [ ] **Step 1: Write the failing test for `util/text.ts`** at `tests/util/text.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { tokenise, STOP_WORDS } from "@/lib/util/text";

describe("util/text tokenise", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenise("Hello, World! 123")).toEqual(["hello", "world", "123"]);
  });
  it("drops stop-words and tokens of length <= 1", () => {
    const out = tokenise("the quick brown fox is a fast x");
    expect(out).toEqual(["quick", "brown", "fox", "fast"]);
  });
  it("returns an empty array on whitespace-only input", () => {
    expect(tokenise("   ")).toEqual([]);
  });
  it("STOP_WORDS includes the common ones", () => {
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("of")).toBe(true);
    expect(STOP_WORDS.has("and")).toBe(true);
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run tests/util/text.test.ts`
Expected: FAIL — cannot resolve `@/lib/util/text`.

- [ ] **Step 3: Implement `src/lib/util/text.ts`**

```ts
export const STOP_WORDS = new Set([
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
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run tests/util/text.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Write the failing test for `util/hash.ts`** at `tests/util/hash.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { contentHash } from "@/lib/util/hash";

describe("util/hash contentHash", () => {
  it("is deterministic", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ a: 1, b: 2 }));
  });
  it("is key-order-invariant", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
  it("is recursively key-order-invariant on nested objects", () => {
    expect(contentHash({ a: { y: 1, x: 2 } })).toBe(contentHash({ a: { x: 2, y: 1 } }));
  });
  it("differs for different content", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
  it("returns 16 lowercase hex chars", () => {
    expect(contentHash({ x: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
  it("handles primitives and arrays", () => {
    expect(contentHash([1, 2, 3])).toBe(contentHash([1, 2, 3]));
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1])); // arrays are order-sensitive
  });
});
```

- [ ] **Step 6: Run failing**

Run: `npx vitest run tests/util/hash.test.ts`
Expected: FAIL — cannot resolve `@/lib/util/hash`.

- [ ] **Step 7: Implement `src/lib/util/hash.ts`**

```ts
import { createHash } from "node:crypto";

function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    const obj = v as Record<string, unknown>;
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}
```

- [ ] **Step 8: Run passing**

Run: `npx vitest run tests/util/hash.test.ts`
Expected: PASS (6/6).

- [ ] **Step 9: Refactor `src/lib/p5/relevance.ts` to import the shared tokenizer**

Replace the local `STOP_WORDS` constant and `tokenise` function with an import. The relevant existing block at the top of `relevance.ts`:

```ts
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
```

becomes simply:

```ts
import { tokenise } from "@/lib/util/text";
```

(Keep the rest of the file unchanged. The export-via-re-export is not needed; if any test imported `tokenise` from `relevance.ts`, change it to import from `@/lib/util/text` in the same step. Check `tests/p5/relevance.test.ts` and adjust the import there if needed.)

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS — all existing tests green, including `tests/p5/relevance.test.ts` (the relevance behaviour is unchanged; only the source of `tokenise` moved).

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 12: Commit**

```bash
git add src/lib/util/text.ts src/lib/util/hash.ts src/lib/p5/relevance.ts tests/util/text.test.ts tests/util/hash.test.ts
git commit -m "feat(util): shared tokenise + contentHash; relevance.ts imports tokenise"
```

(If `tests/p5/relevance.test.ts` was modified in step 9, include it in the `git add`.)

---

## Task 2: Gateway `embed` + `embedBatch`

**Files:**
- Modify: `src/lib/llm/gateway.ts`
- Test: `tests/llm/gateway.test.ts` (add tests; existing tests stay)

**Context:** The OpenRouter embeddings API lives at `https://openrouter.ai/api/v1/embeddings` and accepts `{ model, input: string }` (or an array of strings), returning `{ data: [{ embedding: number[] }, ...] }`. Cache via the existing `cache` port keyed by `promptHash(model, [], "embed:" + text)` — empty messages array plus a prefixed `schemaName` slot uniquely identifies an embedding request without colliding with chat completions. Bounded concurrency mirrors `batchComplete`.

- [ ] **Step 1: Write the failing tests** — add these inside the existing `describe("llm-gateway", …)` block in `tests/llm/gateway.test.ts`

```ts
  it("embed returns the vector from a recorded response", async () => {
    const fetchFn = async () => new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200 }
    );
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const v = await gw.embed("hello", "test-model");
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  it("embed serves the second identical call from cache (no second fetch)", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await gw.embed("hi", "m");
    await gw.embed("hi", "m");
    expect(calls).toBe(1);
  });

  it("embed throws an attributable error when data[0].embedding is missing", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 });
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await expect(gw.embed("hi", "m")).rejects.toThrow(/no embedding/);
  });

  it("embed throws on non-ok HTTP status", async () => {
    const fetchFn = async () => new Response("nope", { status: 429 });
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await expect(gw.embed("hi", "m")).rejects.toThrow(/embeddings 429/);
  });

  it("embedBatch resolves all requests and respects maxConcurrency", async () => {
    let inFlight = 0, maxInFlight = 0;
    const fetchFn = async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn, maxConcurrency: 2 });
    const out = await gw.embedBatch(["a", "b", "c", "d"], "m");
    expect(out).toHaveLength(4);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("embed and chat completions use distinct cache keys", async () => {
    let chatCalls = 0, embedCalls = 0;
    const fetchFn = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/embeddings")) {
        embedCalls++;
        return new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), { status: 200 });
      }
      chatCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "x" }) } }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    await gw.embed("q", "m");
    expect(chatCalls).toBe(1);
    expect(embedCalls).toBe(1);
  });
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run tests/llm/gateway.test.ts`
Expected: FAIL — `gw.embed is not a function`.

- [ ] **Step 3: Implement `embed` and `embedBatch` in `src/lib/llm/gateway.ts`**

Extend `GatewayDeps`:

```ts
export interface GatewayDeps {
  apiKey: string;
  cache: CachePort;
  fetchFn?: typeof fetch;
  endpoint?: string;
  embeddingEndpoint?: string;
  maxConcurrency?: number;
}
```

Inside `makeGateway`, after the existing `fetchFn`/`endpoint`/`maxConcurrency` defaults, add:

```ts
  const embeddingEndpoint = deps.embeddingEndpoint ?? "https://openrouter.ai/api/v1/embeddings";
```

After the existing `batchComplete` function and before the `return { ... }`, add:

```ts
  async function embed(text: string, model: string): Promise<number[]> {
    const hash = promptHash(model, [], `embed:${text}`);
    const cached = deps.cache.get(hash, model);
    if (cached !== undefined) return cached as number[];

    const res = await fetchFn(embeddingEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) throw new Error(`OpenRouter embeddings ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec)) {
      throw new Error(`OpenRouter: no embedding in response for model "${model}"`);
    }
    deps.cache.put(hash, model, vec);
    return vec;
  }

  async function embedBatch(texts: string[], model: string): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    let next = 0;
    async function worker(): Promise<void> {
      for (let i = next++; i < texts.length; i = next++) {
        results[i] = await embed(texts[i], model);
      }
    }
    const workerCount = Math.min(maxConcurrency, texts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
```

Change the return statement to include the new functions:

```ts
  return { complete, batchComplete, embed, embedBatch };
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run tests/llm/gateway.test.ts`
Expected: PASS — every existing gateway test still green, plus six new ones.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/lib/llm/gateway.ts tests/llm/gateway.test.ts
git commit -m "feat(llm-gateway): embed + embedBatch (OpenRouter embeddings, cached, bounded-concurrency)"
```

---

## Task 3: Store schema + `ElicitationState.vectors` + repo round-trip

**Files:**
- Modify: `src/lib/store/schema.sql`
- Modify: `src/lib/store/types.ts`
- Modify: `src/lib/store/repositories.ts`
- Test: `tests/store/elicitation-repo.test.ts` (add a round-trip test; keep existing)

**Context:** The sidecar map persists with the elicitation. The `update` patch signature gains a `vectors` field; `get` returns the parsed map. A fresh DB picks up the new column from the updated `schema.sql`; existing local DBs would need a manual `ALTER TABLE` (acceptable v1 stance per the spec §10 OQ-3).

- [ ] **Step 1: Write the failing test** — add to `tests/store/elicitation-repo.test.ts`

```ts
  it("elicitations round-trip the vectors sidecar map", () => {
    const g = repos.goals.create({ title: "x", rawText: "x" });
    const e = repos.elicitations.create(g.id);
    expect(e.vectors).toEqual({});

    repos.elicitations.update(e.id, {
      generation: 1,
      population: [],
      beliefWeights: [],
      pendingQuestion: null,
      status: "active",
      vectors: { "abc123def4567890": [0.1, 0.2, 0.3], "f0e9d8c7b6a59483": [0.4] },
    });

    const reloaded = repos.elicitations.get(e.id)!;
    expect(reloaded.vectors).toEqual({
      "abc123def4567890": [0.1, 0.2, 0.3],
      "f0e9d8c7b6a59483": [0.4],
    });
  });
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run tests/store/elicitation-repo.test.ts`
Expected: FAIL — `vectors` is `undefined` on the returned `ElicitationState`; `update` rejects the `vectors` field.

- [ ] **Step 3: Update `src/lib/store/schema.sql`**

Replace the `elicitation_state` block with:

```sql
CREATE TABLE IF NOT EXISTS elicitation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  generation INTEGER NOT NULL DEFAULT 0,
  population_json TEXT NOT NULL DEFAULT '[]',
  belief_json TEXT NOT NULL DEFAULT '{}',
  pending_question_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  vectors_json TEXT NOT NULL DEFAULT '{}'
);
```

- [ ] **Step 4: Update `src/lib/store/types.ts`** — extend `ElicitationState`

The full file becomes:

```ts
export interface Goal {
  id: number;
  title: string;
  rawText: string;
  convergedSpec: unknown | null;
  status: "eliciting" | "converged";
}

import type { Genome } from "@/lib/esc/core";

export interface GoalInterpretation {
  scope: string;
  successMetric: string;
  constraints: string;
  motivation: string;
  deadlineShape: string;
}

export interface ElicitationQuestion { a: number; b: number; }

export interface ElicitationState {
  id: number;
  goalId: number;
  generation: number;
  population: Genome<GoalInterpretation>[];
  beliefWeights: number[];
  pendingQuestion: ElicitationQuestion | null;
  status: "active" | "converged";
  vectors: Record<string, number[]>;
}
```

- [ ] **Step 5: Update `src/lib/store/repositories.ts`** — `getElicitation` and `elicitations.update`

Locate the existing `getElicitation` helper. Replace its body so the returned object includes `vectors`:

```ts
function getElicitation(db: Db, id: number): ElicitationState | undefined {
  const row = db.prepare("SELECT * FROM elicitation_state WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    goalId: row.goal_id,
    generation: row.generation,
    population: JSON.parse(row.population_json),
    beliefWeights: JSON.parse(row.belief_json),
    pendingQuestion: row.pending_question_json ? JSON.parse(row.pending_question_json) : null,
    status: row.status,
    vectors: row.vectors_json ? JSON.parse(row.vectors_json) : {},
  };
}
```

In the `elicitations.update` definition inside `makeRepositories`, extend the patch type and the SQL:

```ts
      update(id: number, patch: {
        generation: number;
        population: Genome<GoalInterpretation>[];
        beliefWeights: number[];
        pendingQuestion: ElicitationQuestion | null;
        status: "active" | "converged";
        vectors: Record<string, number[]>;
      }): void {
        const info = db.prepare(
          `UPDATE elicitation_state SET generation = ?, population_json = ?, belief_json = ?,
             pending_question_json = ?, status = ?, vectors_json = ? WHERE id = ?`
        ).run(
          patch.generation,
          JSON.stringify(patch.population),
          JSON.stringify(patch.beliefWeights),
          patch.pendingQuestion ? JSON.stringify(patch.pendingQuestion) : null,
          patch.status,
          JSON.stringify(patch.vectors),
          id,
        );
        if (info.changes === 0) throw new Error(`elicitations.update: no row with id ${id}`);
      },
```

`elicitations.create` returns the state from `getElicitation`, which now includes `vectors: {}` thanks to the schema default — no change needed there.

- [ ] **Step 6: Run passing**

Run: `npx vitest run tests/store/elicitation-repo.test.ts`
Expected: PASS — the new round-trip test plus all pre-existing elicitation-repo tests.

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm test`
Expected: One or more pre-existing tests now fail because `elicitations.update` requires `vectors` and the existing callers (`elicit-handler.ts`, the `elicit-route` test) do not pass it. **Do not fix those failures here — they are addressed by Task 6.** Note the failing test names; Task 6 makes them green.

Run: `npm run typecheck`
Expected: `tsc` reports type errors at the call sites in `src/lib/s0/elicit-handler.ts` for the same reason. Same disposition — Task 6 closes them.

- [ ] **Step 8: Commit (with known-fails in the suite, resolved by T6)**

```bash
git add src/lib/store/schema.sql src/lib/store/types.ts src/lib/store/repositories.ts tests/store/elicitation-repo.test.ts
git commit -m "feat(store): add vectors_json sidecar to elicitation_state; round-trip in repo"
```

> **Note for the orchestrator** of the implementation flow: leave T3's known type/test failures in place for T4 and T5 to also work against. T6 closes the loop. Do **not** introduce a temporary shim in T3.

---

## Task 4: `belief.ts` rewrite — `cosineDistance`, `jaccardDistance`, `makeDistanceFn`, `DistanceFn`, signature change

**Files:**
- Rewrite: `src/lib/s0/belief.ts`
- Rewrite: `tests/s0/belief.test.ts`

**Context:** The single point of intervention. The old module-level exact-Hamming `distance` goes away. New primitives: `cosineDistance(u, v)` on equal-length vectors with clamping; `jaccardDistance(a, b)` over the tokenized concatenation of the five fields; `makeDistanceFn(vectors)` returns a `DistanceFn` that prefers cosine when both operands have vectors in the sidecar, else falls back to Jaccard. `sigma` and `updateBelief` take `distance: DistanceFn` as the last parameter — this is the contract change the rest of the system honours.

- [ ] **Step 1: Rewrite `tests/s0/belief.test.ts`** to test the new primitives and the DistanceFn-parameterised sigma/updateBelief

```ts
import { describe, it, expect } from "vitest";
import {
  cosineDistance,
  jaccardDistance,
  makeDistanceFn,
  sigma,
  uniformBelief,
  updateBelief,
  entropy,
  type DistanceFn,
} from "@/lib/s0/belief";
import { contentHash } from "@/lib/util/hash";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string, more: Partial<GoalInterpretation> = {}): GoalInterpretation =>
  ({ scope, successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d", ...more });

describe("cosineDistance", () => {
  it("returns 0 for identical vectors", () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0);
  });
  it("returns 1 for antipodal vectors", () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(1);
  });
  it("returns 0.5 for orthogonal vectors", () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(0.5);
  });
  it("returns 1 for a zero-magnitude vector", () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
  });
  it("throws on mismatched dimensions", () => {
    expect(() => cosineDistance([1, 2], [1, 2, 3])).toThrow(/mismatched/);
  });
});

describe("jaccardDistance", () => {
  it("returns 0 for identical interpretations", () => {
    const x = gi("marathon training plan");
    expect(jaccardDistance(x, x)).toBe(0);
  });
  it("returns 1 for fully disjoint token sets", () => {
    const a = gi("marathon training plan", {
      successMetric: "finish race", constraints: "weekday", motivation: "health", deadlineShape: "october",
    });
    const b = gi("ferment sourdough bread", {
      successMetric: "tasty crust", constraints: "kitchen tools", motivation: "hobby", deadlineShape: "any",
    });
    expect(jaccardDistance(a, b)).toBe(1);
  });
  it("returns a value in (0, 1) for partial overlap", () => {
    const a = gi("marathon training plan", { successMetric: "finish race" });
    const b = gi("marathon time goal", { successMetric: "finish under four hours" });
    const d = jaccardDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
  it("returns 0 when both interpretations tokenise to the empty set", () => {
    const empty = gi("", { successMetric: "", constraints: "", motivation: "", deadlineShape: "" });
    expect(jaccardDistance(empty, empty)).toBe(0);
  });
});

describe("makeDistanceFn", () => {
  it("uses cosine when both vectors are present in the sidecar", () => {
    const a = gi("marathon race");
    const b = gi("stock market");
    const vectors = {
      [contentHash(a)]: [1, 0],
      [contentHash(b)]: [0, 1],
    };
    const d = makeDistanceFn(vectors);
    expect(d(a, b)).toBeCloseTo(0.5);   // orthogonal cosine
  });
  it("falls back to Jaccard when either vector is missing", () => {
    const a = gi("marathon race");
    const b = gi("marathon time");
    const vectors = { [contentHash(a)]: [1, 0] };   // b has no vector
    const d = makeDistanceFn(vectors);
    expect(d(a, b)).toBe(jaccardDistance(a, b));
  });
  it("falls back to Jaccard when neither vector is present", () => {
    const a = gi("marathon race");
    const b = gi("marathon time");
    const d = makeDistanceFn({});
    expect(d(a, b)).toBe(jaccardDistance(a, b));
  });
});

describe("sigma + updateBelief with injected DistanceFn", () => {
  // Synthetic distance: 1 if scopes differ, 0 if equal. Decoupled from any real implementation.
  const synth: DistanceFn = (a, b) => (a.scope === b.scope ? 0 : 1);

  it("sigma is 0.5 when both candidates are equidistant from the target", () => {
    const pop = [gi("a"), gi("b"), gi("c")].map((value) => ({ value }));
    expect(sigma(pop, 0, 1, 2, synth)).toBeCloseTo(0.5);
  });

  it("updateBelief shifts weight toward the hypothesis consistent with the answer", () => {
    const pop = [gi("a"), gi("b")].map((value) => ({ value }));
    let belief = uniformBelief(2);
    belief = updateBelief(belief, pop, { a: 0, b: 1 }, "a", synth);
    expect(belief.weights[0]).toBeGreaterThan(belief.weights[1]);
    expect(belief.weights[0] + belief.weights[1]).toBeCloseTo(1);
  });

  it("entropy is maximal for uniform and ~0 for certain", () => {
    expect(entropy(uniformBelief(4))).toBeCloseTo(Math.log(4));
    expect(entropy({ weights: [1, 0, 0, 0] })).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run tests/s0/belief.test.ts`
Expected: FAIL — imports for `cosineDistance` / `jaccardDistance` / `makeDistanceFn` / `DistanceFn` don't resolve; `sigma` / `updateBelief` don't accept the synthetic distance argument.

- [ ] **Step 3: Rewrite `src/lib/s0/belief.ts`**

Replace the full file content with:

```ts
import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { tokenise } from "@/lib/util/text";
import { contentHash } from "@/lib/util/hash";

export interface Belief { weights: number[]; }
export type DistanceFn = (a: GoalInterpretation, b: GoalInterpretation) => number;

const DIMS: (keyof GoalInterpretation)[] = ["scope", "successMetric", "constraints", "motivation", "deadlineShape"];
export const TAU = 0.2;

export function cosineDistance(u: number[], v: number[]): number {
  if (u.length !== v.length) throw new Error("s0: cosine on mismatched vector dims");
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  if (nu === 0 || nv === 0) return 1;
  const cos = dot / (Math.sqrt(nu) * Math.sqrt(nv));
  const d = (1 - cos) / 2;
  return Math.min(1, Math.max(0, d));
}

export function jaccardDistance(a: GoalInterpretation, b: GoalInterpretation): number {
  const ta = new Set(tokenise(DIMS.map((dim) => a[dim]).join(" ")));
  const tb = new Set(tokenise(DIMS.map((dim) => b[dim]).join(" ")));
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

export function makeDistanceFn(vectors: Record<string, number[]>): DistanceFn {
  return (a, b) => {
    const va = vectors[contentHash(a)];
    const vb = vectors[contentHash(b)];
    return (va && vb) ? cosineDistance(va, vb) : jaccardDistance(a, b);
  };
}

export function sigma(
  pop: Genome<GoalInterpretation>[],
  k: number, i: number, j: number,
  distance: DistanceFn,
): number {
  const ei = Math.exp(-distance(pop[k].value, pop[i].value) / TAU);
  const ej = Math.exp(-distance(pop[k].value, pop[j].value) / TAU);
  return ei / (ei + ej);
}

export function uniformBelief(n: number): Belief {
  return { weights: new Array(n).fill(1 / n) };
}

function normalise(weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) throw new Error("s0 belief: weights collapsed to zero");
  return weights.map((w) => w / sum);
}

export function updateBelief(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
  q: ElicitationQuestion,
  answer: "a" | "b",
  distance: DistanceFn,
): Belief {
  const updated = belief.weights.map((w, k) => {
    const pPreferA = sigma(pop, k, q.a, q.b, distance);
    return w * (answer === "a" ? pPreferA : 1 - pPreferA);
  });
  return { weights: normalise(updated) };
}

export function entropy(belief: Belief): number {
  return -belief.weights.reduce((h, w) => (w > 0 ? h + w * Math.log(w) : h), 0);
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run tests/s0/belief.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Note known failures still in the suite**

Run: `npm test`
Expected: `tests/s0/acquisition.test.ts` now fails (its `selectQuestion` / `expectedPosteriorEntropy` calls have no `distance` argument), as do `tests/s0/elicit-route.test.ts` and `tests/s0/orchestrator.test.ts` (if present). Closed by Tasks 5 and 6. Do not patch them here.

Run: `npm run typecheck`
Expected: type errors at the same call sites — closed by Tasks 5 and 6.

- [ ] **Step 6: Commit (with known-fails, closed by T5/T6)**

```bash
git add src/lib/s0/belief.ts tests/s0/belief.test.ts
git commit -m "feat(s0): cosine/jaccard distance + DistanceFn injection on sigma/updateBelief"
```

---

## Task 5: `acquisition.ts` signature update

**Files:**
- Modify: `src/lib/s0/acquisition.ts`
- Modify: `tests/s0/acquisition.test.ts`

**Context:** `expectedPosteriorEntropy` and `selectQuestion` are pure consumers of `sigma`/`updateBelief`. They take the same `DistanceFn` and pass it through. Tests use a synthetic `DistanceFn` so they exercise the plumbing without depending on either Jaccard or embeddings.

- [ ] **Step 1: Rewrite `tests/s0/acquisition.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { selectQuestion, expectedPosteriorEntropy } from "@/lib/s0/acquisition";
import { uniformBelief, type DistanceFn } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string, metric = "m"): GoalInterpretation =>
  ({ scope, successMetric: metric, constraints: "c", motivation: "mo", deadlineShape: "d" });

// Synthetic distance: 0 if scope+metric equal, 1 otherwise. Identifies "x"/"x" pairs as identical.
const synth: DistanceFn = (a, b) =>
  a.scope === b.scope && a.successMetric === b.successMetric ? 0 : 1;

describe("s0 acquisition with injected DistanceFn", () => {
  it("selects a pair of distinct candidates", () => {
    const pop = [gi("a"), gi("b"), gi("c"), gi("d")].map((value) => ({ value }));
    const q = selectQuestion(uniformBelief(4), pop, synth);
    expect(q).not.toBeNull();
    expect(q!.a).not.toBe(q!.b);
  });

  it("prefers the question that most reduces expected entropy", () => {
    const pop = [gi("a"), gi("b"), gi("x"), gi("x")].map((value) => ({ value }));
    const belief = uniformBelief(4);
    const eInformative = expectedPosteriorEntropy(belief, pop, { a: 0, b: 1 }, synth);
    const eUseless = expectedPosteriorEntropy(belief, pop, { a: 2, b: 3 }, synth);
    expect(eInformative).toBeLessThan(eUseless);
  });

  it("returns null when fewer than two candidates remain", () => {
    expect(selectQuestion({ weights: [1] }, [{ value: gi("a") }], synth)).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing**

Run: `npx vitest run tests/s0/acquisition.test.ts`
Expected: FAIL — `selectQuestion` / `expectedPosteriorEntropy` either reject the extra argument or, if you haven't touched the impl yet, ignore it. (The first run after the test change should clearly fail.)

- [ ] **Step 3: Update `src/lib/s0/acquisition.ts`**

Replace the file content with:

```ts
import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { sigma, updateBelief, entropy, type Belief, type DistanceFn } from "./belief";

export function expectedPosteriorEntropy(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
  q: ElicitationQuestion,
  distance: DistanceFn,
): number {
  const pA = belief.weights.reduce((s, w, k) => s + w * sigma(pop, k, q.a, q.b, distance), 0);
  const hA = entropy(updateBelief(belief, pop, q, "a", distance));
  const hB = entropy(updateBelief(belief, pop, q, "b", distance));
  return pA * hA + (1 - pA) * hB;
}

export function selectQuestion(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
  distance: DistanceFn,
): ElicitationQuestion | null {
  if (pop.length < 2) return null;
  let best: ElicitationQuestion | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < pop.length; i++) {
    for (let j = i + 1; j < pop.length; j++) {
      const score = expectedPosteriorEntropy(belief, pop, { a: i, b: j }, distance);
      if (score < bestScore) { bestScore = score; best = { a: i, b: j }; }
    }
  }
  return best;
}
```

- [ ] **Step 4: Run passing**

Run: `npx vitest run tests/s0/acquisition.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit (orchestrator-level fails still open; T6 closes them)**

```bash
git add src/lib/s0/acquisition.ts tests/s0/acquisition.test.ts
git commit -m "feat(s0): expectedPosteriorEntropy/selectQuestion take DistanceFn"
```

---

## Task 6: Orchestrator embed lifecycle + `elicit-handler` plumbing + integration tests

**Files:**
- Modify: `src/lib/s0/orchestrator.ts`
- Modify: `src/lib/s0/elicit-handler.ts`
- Modify: `tests/s0/elicit-route.test.ts`
- Add: integration test for semantic discrimination (see step 7)

**Context:** This task closes the contract. The orchestrator owns the embedding lifecycle: for each new genome produced by `ops.seed / crossover / mutate`, compute its `contentHash` and `embed` it (only if absent from the sidecar). Build the `DistanceFn` via `makeDistanceFn(state.vectors)` and pass it into `selectQuestion` / `updateBelief`. `OrchestratorState` gains `vectors`; `ElicitDeps` gains `embed`. The existing `elicit-route` test gets an `embed` stub that returns deterministic per-text vectors so its convergence assertion still meaningfully drives the belief update.

- [ ] **Step 1: Update `src/lib/s0/orchestrator.ts`**

Replace the file content with:

```ts
import type { Genome } from "@/lib/esc/core";
import { evolve } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { uniformBelief, updateBelief, entropy, makeDistanceFn, type Belief } from "./belief";
import { selectQuestion } from "./acquisition";
import { contentHash } from "@/lib/util/hash";

export interface ElicitationOps {
  seed(): Promise<Genome<GoalInterpretation>[]>;
  crossover(a: Genome<GoalInterpretation>, b: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>>;
  mutate(g: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>>;
}

export interface ElicitationConfig { maxQuestions: number; entropyThreshold: number; evolveEvery: number; }

export interface OrchestratorState {
  population: Genome<GoalInterpretation>[];
  belief: Belief;
  generation: number;
  pendingQuestion: ElicitationQuestion | null;
  status: "active" | "converged";
  convergedSpec: GoalInterpretation | null;
  vectors: Record<string, number[]>;
}

function mapCandidate(state: OrchestratorState): GoalInterpretation {
  let best = 0;
  for (let k = 1; k < state.belief.weights.length; k++) {
    if (state.belief.weights[k] > state.belief.weights[best]) best = k;
  }
  return state.population[best].value;
}

async function annotate(
  genomes: Genome<GoalInterpretation>[],
  vectors: Record<string, number[]>,
  embed: (text: string) => Promise<number[]>,
): Promise<Record<string, number[]>> {
  const next: Record<string, number[]> = { ...vectors };
  for (const g of genomes) {
    const key = contentHash(g.value);
    if (next[key]) continue;
    try {
      next[key] = await embed(JSON.stringify(g.value));
    } catch (err) {
      console.warn(`s0: embed failed for ${key}; falling back to Jaccard for any pair using this genome:`, String(err));
    }
  }
  return next;
}

function finaliseIfDone(state: OrchestratorState, cfg: ElicitationConfig): OrchestratorState {
  const done = entropy(state.belief) < cfg.entropyThreshold || state.generation >= cfg.maxQuestions;
  if (!done) {
    const distance = makeDistanceFn(state.vectors);
    return { ...state, pendingQuestion: selectQuestion(state.belief, state.population, distance), status: "active" };
  }
  return { ...state, pendingQuestion: null, status: "converged", convergedSpec: mapCandidate(state) };
}

export async function startElicitation(
  ops: ElicitationOps,
  cfg: ElicitationConfig,
  embed: (text: string) => Promise<number[]>,
): Promise<OrchestratorState> {
  const population = await ops.seed();
  const vectors = await annotate(population, {}, embed);
  const belief = uniformBelief(population.length);
  const base: OrchestratorState = {
    population, belief, generation: 0,
    pendingQuestion: null, status: "active", convergedSpec: null, vectors,
  };
  return finaliseIfDone(base, cfg);
}

export async function answerQuestion(
  ops: ElicitationOps,
  state: OrchestratorState,
  answer: "a" | "b",
  cfg: ElicitationConfig,
  embed: (text: string) => Promise<number[]>,
): Promise<OrchestratorState> {
  if (!state.pendingQuestion) return state;
  const distance = makeDistanceFn(state.vectors);
  const belief = updateBelief(state.belief, state.population, state.pendingQuestion, answer, distance);
  let next: OrchestratorState = { ...state, belief, generation: state.generation + 1 };

  if (next.generation % cfg.evolveEvery === 0) {
    const parents = next.population;
    const parentWeights = next.belief.weights;
    const n = parents.length;
    const evolved = await evolve({ crossover: ops.crossover, mutate: ops.mutate }, parents);
    const inherited = evolved.map((_, idx) => {
      if (idx < n) return parentWeights[idx];
      const m = idx - n;
      return (parentWeights[m] + parentWeights[(m + 1) % n]) / 2;
    });
    const ranked = inherited
      .map((w, idx) => ({ w, idx }))
      .sort((x, y) => y.w - x.w)
      .slice(0, n);
    const sum = ranked.reduce((s, r) => s + r.w, 0);
    const newPopulation = ranked.map((r) => evolved[r.idx]);
    const vectorsAfter = await annotate(newPopulation, next.vectors, embed);
    next = {
      ...next,
      population: newPopulation,
      belief: { weights: ranked.map((r) => r.w / sum) },
      vectors: vectorsAfter,
    };
  }
  return finaliseIfDone(next, cfg);
}
```

- [ ] **Step 2: Update `src/lib/s0/elicit-handler.ts`**

Replace the file content with:

```ts
import { makeRepositories } from "@/lib/store/repositories";
import { startElicitation, answerQuestion, type ElicitationOps, type OrchestratorState } from "@/lib/s0/orchestrator";
import type { ElicitationQuestion, ElicitationState } from "@/lib/store/types";

export const CFG = { maxQuestions: 8, entropyThreshold: 0.5, evolveEvery: 3 };

export type ElicitInput =
  | { action: "start"; goalId: number; rawGoal: string }
  | { action: "answer"; elicitationId: number; answer: "a" | "b" };

export interface ElicitResult {
  elicitationId: number;
  question: ElicitationQuestion | null;
  converged: boolean;
}

export interface ElicitDeps {
  repos: ReturnType<typeof makeRepositories>;
  ops: ElicitationOps;
  embed: (text: string) => Promise<number[]>;
}

function toState(row: ElicitationState): OrchestratorState {
  return {
    population: row.population,
    belief: { weights: row.beliefWeights },
    generation: row.generation,
    pendingQuestion: row.pendingQuestion,
    status: row.status,
    convergedSpec: null,
    vectors: row.vectors,
  };
}

function persist(deps: ElicitDeps, id: number, s: OrchestratorState): void {
  deps.repos.elicitations.update(id, {
    generation: s.generation,
    population: s.population,
    beliefWeights: s.belief.weights,
    pendingQuestion: s.pendingQuestion,
    status: s.status,
    vectors: s.vectors,
  });
}

export async function handleElicit(input: ElicitInput, deps: ElicitDeps): Promise<ElicitResult> {
  if (input.action === "start") {
    const e = deps.repos.elicitations.create(input.goalId);
    const state = await startElicitation(deps.ops, CFG, deps.embed);
    persist(deps, e.id, state);
    return { elicitationId: e.id, question: state.pendingQuestion, converged: state.status === "converged" };
  }

  const row = deps.repos.elicitations.get(input.elicitationId);
  if (!row) throw new Error(`elicit: no elicitation ${input.elicitationId}`);
  const next = await answerQuestion(deps.ops, toState(row), input.answer, CFG, deps.embed);
  persist(deps, input.elicitationId, next);
  if (next.status === "converged" && next.convergedSpec) {
    deps.repos.goals.setConvergedSpec(row.goalId, next.convergedSpec);
  }
  return { elicitationId: input.elicitationId, question: next.pendingQuestion, converged: next.status === "converged" };
}
```

- [ ] **Step 3: Update `tests/s0/elicit-route.test.ts`** to pass a deterministic `embed` stub

Replace the file content with:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleElicit } from "@/lib/s0/elicit-handler";
import type { ElicitationOps } from "@/lib/s0/orchestrator";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (s: string): GoalInterpretation => ({ scope: s, successMetric: s, constraints: "c", motivation: "mo", deadlineShape: "d" });

function ops(): ElicitationOps {
  const cands = ["alpha", "bravo", "charlie", "delta"].map((s) => ({ value: gi(s) }));
  return { async seed() { return cands; }, async crossover(a) { return a; }, async mutate(g) { return g; } };
}

// Deterministic per-text vector: 8-d, accumulating char-code residues. Different texts → different vectors.
function makeStubEmbed() {
  return async (text: string): Promise<number[]> => {
    const v = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) v[i % 8] += (text.charCodeAt(i) % 32) / 32;
    return v;
  };
}

describe("elicit route handler", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("starts elicitation, persists state (incl. vectors), returns a question", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    const res = await handleElicit(
      { action: "start", goalId: g.id, rawGoal: "run a marathon" },
      { repos, ops: ops(), embed: makeStubEmbed() },
    );
    expect(res.elicitationId).toBeTypeOf("number");
    expect(res.question).not.toBeNull();
    const row = repos.elicitations.get(res.elicitationId)!;
    expect(row.pendingQuestion).not.toBeNull();
    expect(Object.keys(row.vectors).length).toBe(4);   // each seed genome got embedded
  });

  it("processes answers and converges (the post-embedding belief update meaningfully discriminates)", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    let res = await handleElicit(
      { action: "start", goalId: g.id, rawGoal: "run a marathon" },
      { repos, ops: ops(), embed: makeStubEmbed() },
    );
    // Heuristic answerer: always prefer 'alpha'-rooted candidate when present; else 'a'.
    let guard = 0;
    while (res.question && guard++ < 12) {
      const state = repos.elicitations.get(res.elicitationId)!;
      const aVal = state.population[res.question.a].value.scope;
      const bVal = state.population[res.question.b].value.scope;
      const ans: "a" | "b" = aVal.includes("alpha") ? "a" : bVal.includes("alpha") ? "b" : "a";
      res = await handleElicit(
        { action: "answer", elicitationId: res.elicitationId, answer: ans },
        { repos, ops: ops(), embed: makeStubEmbed() },
      );
    }
    expect(res.converged).toBe(true);
    const spec = repos.goals.get(g.id)!.convergedSpec as GoalInterpretation;
    expect(spec.scope).toBe("alpha");
  });
});
```

- [ ] **Step 4: Run failing**

Run: `npx vitest run tests/s0/elicit-route.test.ts`
Expected: FAIL on the first run if you haven't applied steps 1–2 yet. After applying them, the tests should compile; they pass once the orchestrator embeds, the handler plumbs `embed`, and the repo round-trips `vectors`.

- [ ] **Step 5: Make the route compile by adding `embed` to the route**

The route does not work without an `embed` source. The smallest change here (T7 will polish env var handling): in `src/app/api/elicit/route.ts`, build `const embed = (text: string) => gw.embed(text, "openai/text-embedding-3-small");` and pass `{ repos, ops, embed }` to `handleElicit`. Leave full env-var handling to Task 7; this step exists only so the route compiles.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS — all earlier tasks' tests, the two updated elicit-route tests, the orchestrator + handler now compile against the new signatures.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Add the regression-guard integration test**

Create `tests/s0/distance-regression.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleElicit } from "@/lib/s0/elicit-handler";
import type { ElicitationOps } from "@/lib/s0/orchestrator";
import type { GoalInterpretation } from "@/lib/store/types";

// Four real-LLM-style interpretations with NO exact-token matches across the 5 dimensions —
// the exact-Hamming distance() the old code used would collapse every pairwise distance to ~1.0
// and the belief would barely move. With embedding-based distance, semantically near pairs
// produce small distances and the belief updates meaningfully.
const interpretations: GoalInterpretation[] = [
  { scope: "complete a marathon race",      successMetric: "finishing the marathon",
    constraints: "must train regularly without injury", motivation: "personal achievement and fitness",
    deadlineShape: "exact fixed date of marathon event in 6 months" },
  { scope: "improve running ability",       successMetric: "ability to run 26.2 miles continuously",
    constraints: "requires a structured training plan",  motivation: "challenge self and gain endurance",
    deadlineShape: "target set for 6 months from now" },
  { scope: "invest in a stock portfolio",   successMetric: "5% annual return after fees",
    constraints: "low risk; only blue-chip equities",    motivation: "build long-term savings",
    deadlineShape: "ongoing with quarterly review" },
  { scope: "ferment sourdough bread",        successMetric: "consistent open crumb at home",
    constraints: "kitchen-scale ingredients only",       motivation: "weekend hobby",
    deadlineShape: "no deadline; weekly practice" },
];

// Stub embed: distinct per-text vectors. Marathon-related texts share token-derived axis 0.
function stubEmbed() {
  return async (text: string): Promise<number[]> => {
    const v = [0, 0, 0, 0];
    if (text.includes("marathon") || text.includes("running")) v[0] += 1;
    if (text.includes("stock") || text.includes("portfolio")) v[1] += 1;
    if (text.includes("sourdough") || text.includes("bread"))  v[2] += 1;
    v[3] = text.length / 256;   // small per-text noise to keep vectors distinct
    return v;
  };
}

function ops(): ElicitationOps {
  const seed = interpretations.map((value) => ({ value }));
  return { async seed() { return seed; }, async crossover(a) { return a; }, async mutate(g) { return g; } };
}

describe("S0 semantic-distance regression guard", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("answering toward a marathon interpretation meaningfully drops the weight of the stock-market candidate", async () => {
    const g = repos.goals.create({ title: "x", rawText: "marathon" });
    const start = await handleElicit(
      { action: "start", goalId: g.id, rawGoal: "marathon" },
      { repos, ops: ops(), embed: stubEmbed() },
    );
    expect(start.question).not.toBeNull();

    // Pre-answer: weights are uniform (0.25 each).
    const before = repos.elicitations.get(start.elicitationId)!;
    expect(before.beliefWeights.every((w) => Math.abs(w - 0.25) < 1e-6)).toBe(true);

    // Answer: prefer index 0 (marathon-race) over whatever the system asked about.
    // We force the answer to be the one that points at the marathon-race candidate (index 0).
    const q = start.question!;
    const answer: "a" | "b" = q.a === 0 ? "a" : "b";
    const after = await handleElicit(
      { action: "answer", elicitationId: start.elicitationId, answer },
      { repos, ops: ops(), embed: stubEmbed() },
    );

    const row = repos.elicitations.get(after.elicitationId)!;
    // Stock-market and sourdough candidates (indices 2 and 3) should have lost weight; their
    // sum of weights drops from 0.5 to noticeably less.
    const farSum = row.beliefWeights[2] + row.beliefWeights[3];
    expect(farSum).toBeLessThan(0.45);
  });
});
```

- [ ] **Step 8: Run the regression test**

Run: `npx vitest run tests/s0/distance-regression.test.ts`
Expected: PASS. (If `farSum` is just over 0.45, the question chosen by `selectQuestion` may not have pitted index 0 against a far candidate. The assertion `< 0.45` is conservative; if it fails on a different chosen pair, log the chosen `q` and the resulting `beliefWeights` and adjust the asserted threshold downward only after confirming the math is right.)

- [ ] **Step 9: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS — entire suite (including all earlier tasks).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/lib/s0/orchestrator.ts src/lib/s0/elicit-handler.ts src/app/api/elicit/route.ts tests/s0/elicit-route.test.ts tests/s0/distance-regression.test.ts
git commit -m "feat(s0): orchestrator owns embed lifecycle; DistanceFn flows; regression guard"
```

---

## Task 7: Route env var polish

**Files:**
- Modify: `src/app/api/elicit/route.ts`

**Context:** Task 6 wired a hardcoded `"openai/text-embedding-3-small"` to make the route compile. This task adds the `S0_EMBED_MODEL` env var with the same default, matching the `P5_GENOME_MODEL` / `P5_JUDGE_MODEL` pattern already used by the signals route.

- [ ] **Step 1: Replace the relevant portion of `src/app/api/elicit/route.ts`**

The full file should look like this after the change:

```ts
import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";
import { handleElicit, type ElicitInput } from "@/lib/s0/elicit-handler";

const MODEL = "openai/gpt-4o-mini";
const EMBED_MODEL = process.env.S0_EMBED_MODEL ?? "openai/text-embedding-3-small";

export async function POST(req: NextRequest) {
  const input = (await req.json()) as ElicitInput;
  const repos = makeRepositories(openDb());
  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY ?? "", cache: repos.llmCache });
  const rawGoal = input.action === "start" ? input.rawGoal : "";
  const ops = makeOperators(gw, rawGoal, 4, MODEL);
  const embed = (text: string) => gw.embed(text, EMBED_MODEL);
  const result = await handleElicit(input, { repos, ops, embed });
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Update `.env.local.example`** — add the env var entry below the existing P5 entries

```env
# S0 elicitation — embedding model for semantic distance (default: openai/text-embedding-3-small)
# S0_EMBED_MODEL=openai/text-embedding-3-small
```

- [ ] **Step 3: Run the full suite + typecheck + build**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

Run: `npm run build`
Expected: `Compiled successfully`; `/api/elicit` and `/api/signals` listed as dynamic routes.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/elicit/route.ts .env.local.example
git commit -m "feat(route): S0_EMBED_MODEL env var with text-embedding-3-small default"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — full suite green. Expected count: previous 77 + 6 (gateway embed) + 1 (elicitation-repo vectors) + 12 (new belief: cosine/jaccard/makeDistanceFn) + 4 (acquisition rewritten to use synth distance — net change small; pre-existing 3 tests adapted, no new ones) + 1 (regression guard) ≈ **~95–100 tests**. (The belief test count grows from 4 to 16 because of the new primitives; the acquisition test count stays at 3.)
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean compile.
- [ ] (Optional, manual / out-of-CI) Run the live S0 elicit flow from `c:\dev\Spacato` with a real `OPENROUTER_API_KEY` and observe the first answer meaningfully updates the belief on the marathon goal — the empirical regression check anticipated by spec §9.4.
- [ ] Dispatch a final whole-implementation code review (subagent-driven-development's last step), then `superpowers:finishing-a-development-branch` to decide merge/PR for the `fix/s0-semantic-distance` branch.

---

## Deliberately out of scope (spec §10, do NOT build)

- Belief-weight epsilon floor (HANDOFF §8 deferred).
- Per-field weighting on the embedded text.
- Schema migration mechanism.
- Sidecar pruning of stale interpretation hashes.
- Cross-user warm-start priors (P5 OQ-6).
- Embedding-model swap automation.

---

## Self-review (done by plan author)

**Spec coverage:** §3 architecture/data-flow → Task 6 (orchestrator). §4 file surface — every row matches a task (util/text→T1, util/hash→T1, gateway→T2, schema/types/repos→T3, belief→T4, acquisition→T5, orchestrator/elicit-handler→T6, route→T7). §5 data model → T3. §6 math → T4 (cosine, jaccard, makeDistanceFn, DistanceFn, signatures) and T1 (contentHash). §7 embedding lifecycle → T6 (orchestrator `annotate`). §8 error handling → T6 (try/catch around `embed` falls back to Jaccard) and T4 (cosine throws on dim mismatch; jaccard returns 0 on both-empty). §9 testing — every test row matches a step. **No gap found.**

**Placeholder scan:** every code step contains complete, runnable code; every command has an expected output. No TBD/TODO/"similar to Task N". The only deliberate intermediate state is the cross-task type/test breakage between T3 and T6, called out explicitly with which task closes it.

**Type consistency:** `DistanceFn` defined once in `belief.ts` and imported everywhere. `vectors: Record<string, number[]>` matches across `ElicitationState`, `OrchestratorState`, the repo `update` patch, and `makeDistanceFn`'s argument. `embed: (text: string) => Promise<number[]>` matches across `ElicitDeps`, `startElicitation`, `answerQuestion`, and `annotate`. `contentHash` returns `string` and is consumed only by sidecar key lookup. **Consistent.**

**Code-change hygiene:** no `// edit` / `// was` / `// previously` / `// NEW` comments anywhere in the plan's code blocks. No parallel-clone files (every modification is in-situ; T4 and T5 are full file rewrites of the existing files at the same path, not new files). Identifiers don't carry version suffixes. **Compliant.**
