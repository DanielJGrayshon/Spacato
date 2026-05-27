# Spacato Phase B — S0 Goal Elicitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a free-text goal into a precise `converged_spec` through a full-Bayesian, human-in-the-loop interactive evolutionary loop that asks a *few* high-information pairwise questions.

**Architecture:** A particle belief over a population of candidate goal-interpretations. The ESC primitives (`score`/`select`/`evolve` from Phase A) evolve the candidates; an LLM (via the Phase-A gateway) implements the seed/crossover/mutate operators; a Bradley–Terry likelihood updates the belief from each pairwise answer; an information-gain acquisition picks the next question. The orchestrator runs the **ask → update → evolve** rhythm and persists state in `elicitation_state`.

**Tech Stack:** TypeScript, Phase-A `esc-core` + `llm-gateway` + `plan-store`, zod, Vitest. Builds on branch `phase-a-foundation` (or a branch off it).

> **Concrete model (decided, no shortcuts):**
> - **Genome** = `GoalInterpretation` with 5 string dimensions: `scope, successMetric, constraints, motivation, deadlineShape`.
> - **Distance** `d(a,b)` = fraction of the 5 dimensions whose string values differ (normalised Hamming, range [0,1]).
> - **Question** = an unordered pair of candidate indices `{a, b}` shown to the user ("which matches what you want?").
> - **Likelihood (Bradley–Terry):** under the hypothesis that candidate `k` is the user's true target, the probability the user prefers candidate `i` over `j` is `σ_k(i,j) = exp(-d(k,i)/τ) / (exp(-d(k,i)/τ) + exp(-d(k,j)/τ))`, temperature `τ = 0.3`.
> - **Belief** = weights `w_k` over candidates (uniform prior). Update on answer "a" (=prefers `i`): `w_k ← w_k · σ_k(i,j)`; on "b": `w_k ← w_k · (1 − σ_k(i,j))`; then normalise.
> - **Acquisition:** pick the pair minimising expected posterior entropy (= max expected information gain), where `P(answer=a) = Σ_k w_k · σ_k(i,j)`.
> - **Convergence:** Shannon entropy of `w` below `0.5` nats, or generation cap. `converged_spec` = the MAP candidate (max weight).

---

### Task 1: `elicitation_state` repository

**Files:**
- Modify: `src/lib/store/repositories.ts` (add `elicitations` repo), `src/lib/store/types.ts` (add types)
- Test: `tests/store/elicitation-repo.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/store/elicitation-repo.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";

describe("elicitation repository", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("creates, reads, and updates elicitation state for a goal", () => {
    const g = repos.goals.create({ title: "x", rawText: "x" });
    const e = repos.elicitations.create(g.id);
    expect(e.generation).toBe(0);
    expect(e.status).toBe("active");

    repos.elicitations.update(e.id, {
      generation: 1,
      population: [{ value: { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" } }],
      beliefWeights: [1],
      pendingQuestion: { a: 0, b: 0 },
      status: "active",
    });
    const loaded = repos.elicitations.get(e.id)!;
    expect(loaded.generation).toBe(1);
    expect(loaded.beliefWeights).toEqual([1]);
    expect(loaded.population[0].value.scope).toBe("s");
    expect(loaded.pendingQuestion).toEqual({ a: 0, b: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/store/elicitation-repo.test.ts`. Expected: FAIL (`repos.elicitations` undefined).

- [ ] **Step 3: Add types** to `src/lib/store/types.ts`

```ts
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
}
```

- [ ] **Step 4: Add the `elicitations` repo** to `src/lib/store/repositories.ts` (inside the object returned by `makeRepositories`)

```ts
    elicitations: {
      create(goalId: number): ElicitationState {
        const info = db.prepare("INSERT INTO elicitation_state (goal_id) VALUES (?)").run(goalId);
        return this.get(Number(info.lastInsertRowid))!;
      },
      get(id: number): ElicitationState | undefined {
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
        };
      },
      update(id: number, patch: {
        generation: number;
        population: Genome<GoalInterpretation>[];
        beliefWeights: number[];
        pendingQuestion: ElicitationQuestion | null;
        status: "active" | "converged";
      }): void {
        const info = db.prepare(
          `UPDATE elicitation_state SET generation = ?, population_json = ?, belief_json = ?,
             pending_question_json = ?, status = ? WHERE id = ?`
        ).run(
          patch.generation,
          JSON.stringify(patch.population),
          JSON.stringify(patch.beliefWeights),
          patch.pendingQuestion ? JSON.stringify(patch.pendingQuestion) : null,
          patch.status,
          id,
        );
        if (info.changes === 0) throw new Error(`elicitations.update: no row with id ${id}`);
      },
    },
```
Add the imports at the top of `repositories.ts`: `import type { ElicitationState, ElicitationQuestion, GoalInterpretation } from "./types";` and `import type { Genome } from "@/lib/esc/core";`.

- [ ] **Step 5: Run** — `npx vitest run tests/store/elicitation-repo.test.ts` → 1 pass; `npm test` → all green.
- [ ] **Step 6: Commit** — `git add src/lib/store tests/store && git commit -m "feat(store): elicitation_state repository"`

---

### Task 2: Genome distance + Bradley–Terry belief model (pure, deterministic)

**Files:**
- Create: `src/lib/s0/belief.ts`
- Test: `tests/s0/belief.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/s0/belief.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { distance, sigma, uniformBelief, updateBelief, entropy } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string): GoalInterpretation =>
  ({ scope, successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" });

describe("s0 belief", () => {
  it("distance is normalised Hamming over 5 dims", () => {
    expect(distance(gi("a"), gi("a"))).toBe(0);
    expect(distance(gi("a"), gi("b"))).toBeCloseTo(0.2); // 1 of 5 dims differ
  });

  it("sigma is 0.5 when both candidates are equidistant from the target", () => {
    const pop = [gi("a"), gi("b"), gi("c")].map((value) => ({ value }));
    // target k=0 (gi a); compare i=1 (b) vs j=2 (c): both differ from a in 1 dim → equal distance
    expect(sigma(pop, 0, 1, 2)).toBeCloseTo(0.5);
  });

  it("updateBelief shifts weight toward the hypothesis consistent with the answer", () => {
    const pop = [gi("a"), gi("b")].map((value) => ({ value }));
    let belief = uniformBelief(2);
    // question between candidates 0 and 1; user prefers 0 ("a"). Hypothesis k=0 (target=a) predicts
    // preferring candidate 0 strongly; hypothesis k=1 predicts preferring candidate 1.
    belief = updateBelief(belief, pop, { a: 0, b: 1 }, "a");
    expect(belief.weights[0]).toBeGreaterThan(belief.weights[1]);
    expect(belief.weights[0] + belief.weights[1]).toBeCloseTo(1);
  });

  it("entropy is maximal for a uniform belief and ~0 for a certain one", () => {
    expect(entropy(uniformBelief(4))).toBeCloseTo(Math.log(4));
    expect(entropy({ weights: [1, 0, 0, 0] })).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/s0/belief.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/s0/belief.ts`

```ts
import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";

export interface Belief { weights: number[]; }

const DIMS: (keyof GoalInterpretation)[] = ["scope", "successMetric", "constraints", "motivation", "deadlineShape"];
const TAU = 0.3;

/** Normalised Hamming distance over the 5 interpretation dimensions. */
export function distance(a: GoalInterpretation, b: GoalInterpretation): number {
  let differ = 0;
  for (const d of DIMS) if (a[d] !== b[d]) differ++;
  return differ / DIMS.length;
}

/** P(user prefers candidate i over candidate j | target = candidate k), Bradley–Terry over distances. */
export function sigma(pop: Genome<GoalInterpretation>[], k: number, i: number, j: number): number {
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

/** Bayesian update: multiply each hypothesis weight by the likelihood of the observed answer. */
export function updateBelief(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
  q: ElicitationQuestion,
  answer: "a" | "b",
): Belief {
  const updated = belief.weights.map((w, k) => {
    const pPreferA = sigma(pop, k, q.a, q.b);
    return w * (answer === "a" ? pPreferA : 1 - pPreferA);
  });
  return { weights: normalise(updated) };
}

export function entropy(belief: Belief): number {
  return -belief.weights.reduce((h, w) => (w > 0 ? h + w * Math.log(w) : h), 0);
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/s0/belief.test.ts` → 4 pass; `npm test` green.
- [ ] **Step 5: Commit** — `git add src/lib/s0/belief.ts tests/s0/belief.test.ts && git commit -m "feat(s0): genome distance + Bradley-Terry belief model"`

---

### Task 3: Information-gain acquisition (pure, deterministic)

**Files:**
- Create: `src/lib/s0/acquisition.ts`
- Test: `tests/s0/acquisition.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/s0/acquisition.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { selectQuestion, expectedPosteriorEntropy } from "@/lib/s0/acquisition";
import { uniformBelief } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string, metric = "m"): GoalInterpretation =>
  ({ scope, successMetric: metric, constraints: "c", motivation: "mo", deadlineShape: "d" });

describe("s0 acquisition", () => {
  it("selects a pair of distinct candidates", () => {
    const pop = [gi("a"), gi("b"), gi("c"), gi("d")].map((value) => ({ value }));
    const q = selectQuestion(uniformBelief(4), pop);
    expect(q).not.toBeNull();
    expect(q!.a).not.toBe(q!.b);
  });

  it("prefers the question that most reduces expected entropy", () => {
    // Two well-separated candidates (0,1) vs two near-identical (2,3 differ from each other in 0 dims).
    const pop = [gi("a"), gi("b"), gi("x"), gi("x")].map((value) => ({ value }));
    const belief = uniformBelief(4);
    const eInformative = expectedPosteriorEntropy(belief, pop, { a: 0, b: 1 });
    const eUseless = expectedPosteriorEntropy(belief, pop, { a: 2, b: 3 });
    expect(eInformative).toBeLessThan(eUseless); // separating 0 vs 1 is more informative
  });

  it("returns null when fewer than two candidates remain credible", () => {
    expect(selectQuestion({ weights: [1] }, [{ value: gi("a") }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/s0/acquisition.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/s0/acquisition.ts`

```ts
import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { sigma, updateBelief, entropy, type Belief } from "./belief";

/** E[ H(posterior) ] over the two possible answers to question q. Lower = more informative. */
export function expectedPosteriorEntropy(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
  q: ElicitationQuestion,
): number {
  // P(answer = "a") = Σ_k w_k · σ_k(a,b)
  const pA = belief.weights.reduce((s, w, k) => s + w * sigma(pop, k, q.a, q.b), 0);
  const hA = entropy(updateBelief(belief, pop, q, "a"));
  const hB = entropy(updateBelief(belief, pop, q, "b"));
  return pA * hA + (1 - pA) * hB;
}

/** Pick the candidate pair that minimises expected posterior entropy (max information gain). */
export function selectQuestion(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
): ElicitationQuestion | null {
  if (pop.length < 2) return null;
  let best: ElicitationQuestion | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < pop.length; i++) {
    for (let j = i + 1; j < pop.length; j++) {
      const score = expectedPosteriorEntropy(belief, pop, { a: i, b: j });
      if (score < bestScore) { bestScore = score; best = { a: i, b: j }; }
    }
  }
  return best;
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/s0/acquisition.test.ts` → 3 pass; `npm test` green.
- [ ] **Step 5: Commit** — `git add src/lib/s0/acquisition.ts tests/s0/acquisition.test.ts && git commit -m "feat(s0): information-gain question acquisition"`

---

### Task 4: LLM operators for the goal-interpretation genome

**Files:**
- Create: `src/lib/s0/operators.ts`
- Test: `tests/s0/operators.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/s0/operators.test.ts` (uses a recorded gateway via injectable `fetchFn`, no network)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";

function gatewayReturning(obj: unknown) {
  const repos = makeRepositories(openDb(":memory:"));
  const fetchFn = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
  return makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
}

const interp = { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };

describe("s0 operators", () => {
  it("seed returns K candidate interpretations", async () => {
    const gw = gatewayReturning({ candidates: [interp, interp, interp] });
    const ops = makeOperators(gw, "free text goal", 3, "model");
    const pop = await ops.seed();
    expect(pop).toHaveLength(3);
    expect(pop[0].value.scope).toBe("s");
  });

  it("crossover and mutate return a single interpretation genome", async () => {
    const gw = gatewayReturning({ interpretation: interp });
    const ops = makeOperators(gw, "free text goal", 3, "model");
    const child = await ops.crossover({ value: interp }, { value: interp });
    expect(child.value.successMetric).toBe("m");
    const mutant = await ops.mutate({ value: interp });
    expect(mutant.value.scope).toBe("s");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/s0/operators.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/s0/operators.ts`

```ts
import { z } from "zod";
import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation } from "@/lib/store/types";

type Gateway = { complete<T>(req: { model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; schema: z.ZodType<T> }): Promise<T> };

const interpretationSchema = z.object({
  scope: z.string(), successMetric: z.string(), constraints: z.string(),
  motivation: z.string(), deadlineShape: z.string(),
}).describe("goal-interpretation");

const seedSchema = z.object({ candidates: z.array(interpretationSchema) }).describe("seed-candidates");
const oneSchema = z.object({ interpretation: interpretationSchema }).describe("one-interpretation");

export function makeOperators(gw: Gateway, rawGoal: string, k: number, model: string) {
  const sys = { role: "system" as const, content: "You interpret a user's free-text goal into structured candidate interpretations. Reply only with JSON matching the schema." };
  return {
    async seed(): Promise<Genome<GoalInterpretation>[]> {
      const out = await gw.complete({
        model,
        messages: [sys, { role: "user", content: `Goal: "${rawGoal}". Produce ${k} DISTINCT plausible interpretations across scope, successMetric, constraints, motivation, deadlineShape.` }],
        schema: seedSchema,
      });
      return out.candidates.slice(0, k).map((value) => ({ value }));
    },
    async crossover(a: Genome<GoalInterpretation>, b: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>> {
      const out = await gw.complete({
        model,
        messages: [sys, { role: "user", content: `Blend these two interpretations into one coherent interpretation. A: ${JSON.stringify(a.value)} B: ${JSON.stringify(b.value)}` }],
        schema: oneSchema,
      });
      return { value: out.interpretation };
    },
    async mutate(g: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>> {
      const out = await gw.complete({
        model,
        messages: [sys, { role: "user", content: `Perturb ONE dimension of this interpretation to a plausible alternative: ${JSON.stringify(g.value)}` }],
        schema: oneSchema,
      });
      return { value: out.interpretation };
    },
  };
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/s0/operators.test.ts` → 2 pass; `npm test` green.
- [ ] **Step 5: Commit** — `git add src/lib/s0/operators.ts tests/s0/operators.test.ts && git commit -m "feat(s0): LLM seed/crossover/mutate operators for goal interpretations"`

---

### Task 5: Orchestrator — the ask → update → evolve loop

**Files:**
- Create: `src/lib/s0/orchestrator.ts`
- Test: `tests/s0/orchestrator.test.ts`

The orchestrator is interactive: it can't call the user, so it exposes two functions — `start` (seed + belief + first question) and `answer` (update belief, maybe evolve, return next question or the converged spec). State is passed in/out (the API route persists it). Tests use deterministic mock operators + a synthetic oracle, asserting convergence to a hidden target within a small number of questions.

- [ ] **Step 1: Write the failing test** — `tests/s0/orchestrator.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { startElicitation, answerQuestion, type ElicitationOps } from "@/lib/s0/orchestrator";
import { distance } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string): GoalInterpretation =>
  ({ scope, successMetric: scope, constraints: "c", motivation: "mo", deadlineShape: "d" });

// Deterministic mock operators: a fixed candidate set, crossover/mutate are no-ops (population fixed).
function mockOps(): ElicitationOps {
  const cands = ["a", "b", "c", "d"].map((s) => ({ value: gi(s) }));
  return {
    async seed() { return cands; },
    async crossover(a) { return a; },
    async mutate(g) { return g; },
  };
}

const TARGET = gi("a");
// Synthetic oracle: always prefers the candidate closer to TARGET.
function oracle(pop: { value: GoalInterpretation }[], q: { a: number; b: number }): "a" | "b" {
  return distance(pop[q.a].value, TARGET) <= distance(pop[q.b].value, TARGET) ? "a" : "b";
}

describe("s0 orchestrator", () => {
  it("converges to the target interpretation within a few questions", async () => {
    let state = await startElicitation(mockOps(), { maxQuestions: 10, entropyThreshold: 0.5, evolveEvery: 999 });
    let asked = 0;
    while (state.status === "active" && state.pendingQuestion) {
      const ans = oracle(state.population, state.pendingQuestion);
      state = await answerQuestion(mockOps(), state, ans, { maxQuestions: 10, entropyThreshold: 0.5, evolveEvery: 999 });
      asked++;
      if (asked > 10) break;
    }
    expect(state.status).toBe("converged");
    expect(state.convergedSpec!.scope).toBe("a");
    expect(asked).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/s0/orchestrator.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/s0/orchestrator.ts`

```ts
import type { Genome } from "@/lib/esc/core";
import { evolve } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { uniformBelief, updateBelief, entropy, type Belief } from "./belief";
import { selectQuestion } from "./acquisition";

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
}

function mapCandidate(state: OrchestratorState): GoalInterpretation {
  let best = 0;
  for (let k = 1; k < state.belief.weights.length; k++) {
    if (state.belief.weights[k] > state.belief.weights[best]) best = k;
  }
  return state.population[best].value;
}

function finaliseIfDone(state: OrchestratorState, cfg: ElicitationConfig): OrchestratorState {
  const done = entropy(state.belief) < cfg.entropyThreshold || state.generation >= cfg.maxQuestions;
  if (!done) {
    return { ...state, pendingQuestion: selectQuestion(state.belief, state.population), status: "active" };
  }
  return { ...state, pendingQuestion: null, status: "converged", convergedSpec: mapCandidate(state) };
}

export async function startElicitation(ops: ElicitationOps, cfg: ElicitationConfig): Promise<OrchestratorState> {
  const population = await ops.seed();
  const belief = uniformBelief(population.length);
  const base: OrchestratorState = { population, belief, generation: 0, pendingQuestion: null, status: "active", convergedSpec: null };
  return finaliseIfDone(base, cfg);
}

export async function answerQuestion(
  ops: ElicitationOps,
  state: OrchestratorState,
  answer: "a" | "b",
  cfg: ElicitationConfig,
): Promise<OrchestratorState> {
  if (!state.pendingQuestion) return state;
  const belief = updateBelief(state.belief, state.population, state.pendingQuestion, answer);
  let next: OrchestratorState = { ...state, belief, generation: state.generation + 1 };

  // ask → update → EVOLVE: periodically refine the candidate set around the credible region.
  if (next.generation % cfg.evolveEvery === 0) {
    const parents = next.population; // keep all; evolve appends offspring
    const evolved = await evolve({ crossover: ops.crossover, mutate: ops.mutate } as any, parents);
    // extend belief with uniform-ish weight for new candidates, then renormalise
    const extra = evolved.length - next.belief.weights.length;
    const avg = next.belief.weights.reduce((s, w) => s + w, 0) / next.belief.weights.length;
    const weights = [...next.belief.weights, ...new Array(Math.max(0, extra)).fill(avg)];
    const sum = weights.reduce((s, w) => s + w, 0);
    next = { ...next, population: evolved, belief: { weights: weights.map((w) => w / sum) } };
  }
  return finaliseIfDone(next, cfg);
}
```

> Note: the `evolve` call passes only `crossover`/`mutate` (the two operators `evolve` actually uses). The `as any` is a deliberate, localised cast because `evolve`'s `EscConfig` type is broader than what this call needs; the spec-reviewer should confirm this is the only such cast and that `evolve` does not touch other config fields. If the reviewer prefers, extract a minimal `EvolveOps` type in `esc-core` at R2.

- [ ] **Step 4: Run** — `npx vitest run tests/s0/orchestrator.test.ts` → 1 pass; `npm test` green.
- [ ] **Step 5: Commit** — `git add src/lib/s0/orchestrator.ts tests/s0/orchestrator.test.ts && git commit -m "feat(s0): elicitation orchestrator (ask-update-evolve loop)"`

---

### Task 6: API route + persistence wiring

**Files:**
- Create: `src/app/api/elicit/route.ts`
- Test: `tests/s0/elicit-route.test.ts`

The route exposes POST actions `{ action: "start", goalId, rawGoal }` and `{ action: "answer", elicitationId, answer }`. It builds the gateway from `process.env.OPENROUTER_API_KEY`, runs the orchestrator, and persists `OrchestratorState` into `elicitation_state` (and writes `converged_spec` to the goal on convergence). The test imports the pure handler with injected deps (gateway + repos) to avoid network/env.

- [ ] **Step 1: Write the failing test** — `tests/s0/elicit-route.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleElicit } from "@/app/api/elicit/route";
import type { ElicitationOps } from "@/lib/s0/orchestrator";
import { distance } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (s: string): GoalInterpretation => ({ scope: s, successMetric: s, constraints: "c", motivation: "mo", deadlineShape: "d" });
function ops(): ElicitationOps {
  const cands = ["a", "b", "c", "d"].map((s) => ({ value: gi(s) }));
  return { async seed() { return cands; }, async crossover(a) { return a; }, async mutate(g) { return g; } };
}

describe("elicit route handler", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("starts elicitation, persists state, and returns a question", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    const res = await handleElicit({ action: "start", goalId: g.id, rawGoal: "run a marathon" }, { repos, ops: ops() });
    expect(res.elicitationId).toBeTypeOf("number");
    expect(res.question).not.toBeNull();
    expect(repos.elicitations.get(res.elicitationId)!.pendingQuestion).not.toBeNull();
  });

  it("processes an answer and eventually converges, writing converged_spec to the goal", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    let res = await handleElicit({ action: "start", goalId: g.id, rawGoal: "run a marathon" }, { repos, ops: ops() });
    const TARGET = gi("a");
    let guard = 0;
    while (res.question && guard++ < 10) {
      const state = repos.elicitations.get(res.elicitationId)!;
      const ans = distance(state.population[res.question.a].value, TARGET) <= distance(state.population[res.question.b].value, TARGET) ? "a" : "b";
      res = await handleElicit({ action: "answer", elicitationId: res.elicitationId, answer: ans }, { repos, ops: ops() });
    }
    expect(res.converged).toBe(true);
    expect(repos.goals.get(g.id)!.convergedSpec).toMatchObject({ scope: "a" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/s0/elicit-route.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `src/app/api/elicit/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";
import { startElicitation, answerQuestion, type ElicitationOps, type OrchestratorState } from "@/lib/s0/orchestrator";
import type { ElicitationQuestion } from "@/lib/store/types";

const CFG = { maxQuestions: 8, entropyThreshold: 0.5, evolveEvery: 3 };
const MODEL = "openai/gpt-4o-mini";

type ElicitInput =
  | { action: "start"; goalId: number; rawGoal: string }
  | { action: "answer"; elicitationId: number; answer: "a" | "b" };

interface Deps { repos: ReturnType<typeof makeRepositories>; ops: ElicitationOps; }

function toState(row: ReturnType<Deps["repos"]["elicitations"]["get"]>): OrchestratorState {
  return {
    population: row!.population,
    belief: { weights: row!.beliefWeights },
    generation: row!.generation,
    pendingQuestion: row!.pendingQuestion,
    status: row!.status,
    convergedSpec: null,
  };
}

function persist(deps: Deps, id: number, s: OrchestratorState) {
  deps.repos.elicitations.update(id, {
    generation: s.generation,
    population: s.population,
    beliefWeights: s.belief.weights,
    pendingQuestion: s.pendingQuestion,
    status: s.status,
  });
}

export async function handleElicit(input: ElicitInput, deps: Deps): Promise<{ elicitationId: number; question: ElicitationQuestion | null; converged: boolean }> {
  if (input.action === "start") {
    const e = deps.repos.elicitations.create(input.goalId);
    const state = await startElicitation(deps.ops, CFG);
    persist(deps, e.id, state);
    return { elicitationId: e.id, question: state.pendingQuestion, converged: state.status === "converged" };
  }
  const row = deps.repos.elicitations.get(input.elicitationId);
  if (!row) throw new Error(`elicit: no elicitation ${input.elicitationId}`);
  const next = await answerQuestion(deps.ops, toState(row), input.answer, CFG);
  persist(deps, input.elicitationId, next);
  if (next.status === "converged" && next.convergedSpec) {
    deps.repos.goals.setConvergedSpec(row.goalId, next.convergedSpec);
  }
  return { elicitationId: input.elicitationId, question: next.pendingQuestion, converged: next.status === "converged" };
}

export async function POST(req: NextRequest) {
  const input = (await req.json()) as ElicitInput;
  const repos = makeRepositories(openDb());
  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY ?? "", cache: repos.llmCache });
  const rawGoal = input.action === "start" ? input.rawGoal : "";
  const ops = makeOperators(gw, rawGoal, 4, MODEL);
  const result = await handleElicit(input, { repos, ops });
  return NextResponse.json(result);
}
```

> Note: on `answer`, `makeOperators` is built with an empty `rawGoal`; that's fine because the orchestrator only calls `crossover`/`mutate` on `answer` (never `seed`). The spec-reviewer should confirm `seed` is never reached on the answer path.

- [ ] **Step 4: Run** — `npx vitest run tests/s0/elicit-route.test.ts` → 2 pass; `npm test` green.
- [ ] **Step 5: Commit** — `git add src/app/api/elicit tests/s0/elicit-route.test.ts && git commit -m "feat(s0): /api/elicit route with persistence and goal convergence"`

---

## Self-review notes

- **Spec coverage (S0, spec §7):** belief model (particles + Bradley–Terry) → Task 2; acquisition (info-gain over pairwise) → Task 3; operators (seed/crossover/mutate, EvoPrompt-style) → Task 4; convergence (entropy threshold, MAP spec) → Tasks 5; ask→update→evolve orchestration using ESC `evolve` → Task 5; persistence + goal `converged_spec` write → Tasks 1, 6.
- **Type consistency:** `GoalInterpretation`, `ElicitationQuestion`, `ElicitationState` defined in Task 1 (`types.ts`) and reused everywhere; `Belief` defined in Task 2 and consumed by Tasks 3/5; `ElicitationOps`/`OrchestratorState` defined in Task 5 and consumed by Task 6; gateway request/`Genome<T>` shapes match Phase A.
- **No placeholders:** every code step has full code; every run step has a command + expected result.
- **Known cast for R2:** the `evolve({crossover,mutate} as any, ...)` cast in Task 5 — flagged for a minimal `EvolveOps` extraction in esc-core at R2 (do not block on it).
- **Heuristics-first:** distance, Bradley–Terry, entropy, acquisition, MAP, persistence are all deterministic; the LLM is confined to the three operators, each batched-capable and cached via the Phase-A gateway.
