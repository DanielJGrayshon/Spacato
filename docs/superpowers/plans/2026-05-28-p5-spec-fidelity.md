# P5 Spec-Fidelity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three places where the P5 implementation does less than the `2026-05-27-p5-signals-design.md` spec promises: serial (not batched) genome operators, the inert `QueryTerm.weight` field, and an unbounded cross-cycle dedup scan.

**Architecture:** Three independent fixes. (A) Parallelize `esc-core.evolve` so crossover and mutate run concurrently — honoring §5.3/§5.4's batching intent while keeping §5.9's "use `esc-core.evolve`" mandate; outputs are identical, only timing changes. (B) Thread the originating query term's `weight` from `feed-ingest` onto each `FeedItem`, then make the fitness relevance a weight-weighted mean so `weight` drives both fitness (directly) and selection (transitively, since `selectTop` ranks on that fitness). (C) Add `signals.listByIds` and use it so the content-dedup check loads only open-alert signals instead of the goal's entire signal history.

**Tech Stack:** TypeScript, Next.js 14, Zod, better-sqlite3, Vitest. Path alias `@/` → `src/`. Test command: `npx vitest run`. Typecheck: `npm run typecheck`.

**Audit evidence (why each task exists):**
- Spec §5.2 "seed is the **only** LLM call that is NOT batched"; §5.3/§5.4 say crossover+mutate are batched. Reality: [genome.ts](../../../src/lib/p5/genome.ts) operators call `gw.complete()` and [core.ts:35-43](../../../src/lib/esc/core.ts) `evolve` awaits them strictly serially → 4 sequential round-trips/cycle.
- Spec §5.1 "`weight` … used by fitness and selection." Reality: read nowhere ( `grep .weight` in `src/lib/p5` returns nothing).
- Spec §8.2 content dedup. Reality: [alert-logic.ts:16-23](../../../src/lib/p5/alert-logic.ts) calls `signals.listForGoal(goalId)` with no limit, loading all history each check.

---

### Task A: Parallelize `esc-core.evolve`

**Files:**
- Modify: `src/lib/esc/core.ts:35-43`
- Test: `tests/esc/core.test.ts`

- [ ] **Step 1: Write the failing concurrency test**

Add to `tests/esc/core.test.ts` inside the `describe("esc-core", …)` block:

```ts
it("runs all crossovers concurrently rather than serially", async () => {
  let active = 0;
  let maxConcurrent = 0;
  const cfg = mockConfig({
    async crossover(a, b) {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { value: Math.round((a.value + b.value) / 2) };
    },
  });
  const parents = [{ value: 1 }, { value: 2 }];
  const next = await evolve(cfg, parents);
  expect(maxConcurrent).toBe(2);           // both crossovers in flight at once
  expect(next.length).toBe(4);             // [...parents, ...offspring] unchanged
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/esc/core.test.ts -t "concurrently"`
Expected: FAIL — `maxConcurrent` is `1` under the current serial `for`-loop.

- [ ] **Step 3: Rewrite `evolve` to parallelize each phase**

Replace `src/lib/esc/core.ts:35-43` with:

```ts
/** Composable primitive: next population = parents plus one offspring per parent.
 *  Offspring `m` is produced from `parents[m]` and `parents[(m+1) % n]`, appended after the parents:
 *  the return is `[...parents, ...offspring]` (length `2 * parents.length`).
 *  Crossover for all offspring runs concurrently, then mutate for all offspring runs concurrently —
 *  honouring the P5 spec's batching intent (§5.3/§5.4) without changing operator signatures.
 *  Promise.all preserves index order, so outputs are identical to the previous serial loop. */
export async function evolve<T>(cfg: Pick<EscConfig<T>, "crossover" | "mutate">, parents: Genome<T>[]): Promise<Genome<T>[]> {
  const crossed = await Promise.all(
    parents.map((a, i) => cfg.crossover(a, parents[(i + 1) % parents.length]))
  );
  const offspring = await Promise.all(crossed.map((c) => cfg.mutate(c)));
  return [...parents, ...offspring];
}
```

- [ ] **Step 4: Run the new test plus the existing core suite**

Run: `npx vitest run tests/esc/core.test.ts`
Expected: PASS — concurrency test passes; the existing "exposes composable score, select and evolve primitives", "converges to the hidden target", and "step advances exactly one generation" tests still pass (order-preserving change).

- [ ] **Step 5: Confirm S0 (the other `evolve` consumer) is unaffected**

Run: `npx vitest run`
Expected: PASS — full suite green, confirming S0's `runToConvergence`/`step` path is behavior-identical.

- [ ] **Step 6: Commit**

```bash
git add src/lib/esc/core.ts tests/esc/core.test.ts
git commit -m "perf(esc): parallelize evolve crossover/mutate phases (honors p5 §5.3/§5.4 batching)"
```

---

### Task B: Wire `QueryTerm.weight` into fitness (and thereby selection)

**Files:**
- Modify: `src/lib/p5/types.ts:6-15` (add `queryWeight` to `FeedItem`)
- Modify: `src/lib/p5/feed-ingest.ts:66` (stamp the weight)
- Modify: `src/lib/p5/esc-adapter.ts:35,83` (weighted-mean relevance)
- Test: `tests/p5/feed-ingest.test.ts`, `tests/p5/esc-adapter.test.ts`

- [ ] **Step 1: Write the failing feed-ingest stamping test**

Add to `tests/p5/feed-ingest.test.ts` inside the `describe("feed-ingest", …)` block:

```ts
it("stamps each item with the originating query term's weight", async () => {
  const body = { status: "ok", articles: [{ title: "T", description: "D", url: "https://newsapi.org/a", publishedAt: "2026-05-20T00:00:00Z" }] };
  const items = await ingest([{ source: "newsapi", terms: ["solar"], weight: 3 }], { fetchFn: okResponse(body), env });
  expect(items).toHaveLength(1);
  expect(items[0].queryWeight).toBe(3);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/p5/feed-ingest.test.ts -t "stamps"`
Expected: FAIL — `queryWeight` is `undefined` (and a TS error: property does not exist on `FeedItem`).

- [ ] **Step 3: Add `queryWeight` to the `FeedItem` type**

In `src/lib/p5/types.ts`, change the `FeedItem` interface (lines 6-15) to add the field:

```ts
export interface FeedItem {
  id: string;            // source-assigned unique id (url for news/market, name-dt for weather)
  source: SourceKey;
  kind: FeedKind;
  title: string;
  summary: string;
  publishedAt: string;   // ISO datetime
  url?: string;
  rawPayload: unknown;
  queryWeight?: number;  // relative priority of the genome query term that fetched this item (set by feed-ingest); undefined → treated as 1
}
```

- [ ] **Step 4: Stamp the weight in `feed-ingest`**

In `src/lib/p5/feed-ingest.ts`, change the final return of `ingestOne` (line 66) from:

```ts
  return source.normalise(parsed.data);
```

to:

```ts
  return source.normalise(parsed.data).map((it) => ({ ...it, queryWeight: q.weight }));
```

- [ ] **Step 5: Run to verify the stamping test passes**

Run: `npx vitest run tests/p5/feed-ingest.test.ts`
Expected: PASS — all feed-ingest tests green.

- [ ] **Step 6: Write the failing fitness-weighting test**

Add to `tests/p5/esc-adapter.test.ts` inside the `describe("runCycle online loop", …)` block:

```ts
it("fitness weights item relevance by the originating query term weight", async () => {
  // Two items: a high-relevance item with weight 3, a zero-relevance item with weight 1.
  const scoredWeighted = (): ScoredItem[] => [
    { item: { ...feed("hi"), queryWeight: 3 }, keywordScore: 0, llmScore: 1, finalScore: 1.0 },
    { item: { ...feed("lo"), queryWeight: 1 }, keywordScore: 0, llmScore: 0, finalScore: 0.0 },
  ];
  await runCycle(goalId, deps({ scoreItems: async () => scoredWeighted() }));
  const state = repos.queryGenomeState.get(goalId)!;
  // weighted relevance = (1.0*3 + 0.0*1)/(3+1) = 0.75; engagement prior = 0.5 => fitness 0.375.
  // Plain mean would be 0.5 => fitness 0.25, so this asserts the weighting actually happened.
  expect(Math.max(...state.scores)).toBeCloseTo(0.375, 5);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/p5/esc-adapter.test.ts -t "weights item relevance"`
Expected: FAIL — current plain `mean` yields `0.5 * 0.5 = 0.25`, not `0.375`.

- [ ] **Step 8: Replace the plain mean with a weighted mean in the adapter**

In `src/lib/p5/esc-adapter.ts`, remove the now-unused `mean` helper (line 35) and add a weighted-relevance helper next to `argmax`:

```ts
const argmax = (xs: number[]): number => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

/** Relevance component of fitness: mean of finalScore weighted by each item's originating
 *  query-term weight (spec §5.1 — weight is "used by fitness"). selectTop then ranks on this
 *  fitness, so weight feeds selection transitively (§5.7). Missing weight defaults to 1. */
const weightedRelevance = (items: ScoredItem[]): number => {
  const wsum = items.reduce((a, si) => a + (si.item.queryWeight ?? 1), 0);
  if (wsum === 0) return 0;
  return items.reduce((a, si) => a + si.finalScore * (si.item.queryWeight ?? 1), 0) / wsum;
};
```

Then change the fitness line (currently line 83):

```ts
  const fetchingFitness = mean(scoredItems.map((si) => si.finalScore)) * fetchingEngagement;
```

to:

```ts
  const fetchingFitness = weightedRelevance(scoredItems) * fetchingEngagement;
```

- [ ] **Step 9: Run the adapter suite to verify pass + no regressions**

Run: `npx vitest run tests/p5/esc-adapter.test.ts`
Expected: PASS — the new weighting test passes; the existing "seeds on first cycle …" (0.9 items, implicit weight 1 → weighted mean = plain mean = 0.9) and "a non-zero-index genome …" (fetcher b = 0.45) tests still pass, since equal/absent weights reduce the weighted mean to the plain mean.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS — `queryWeight` is optional, so existing `FeedItem` literals in fixtures remain valid.

- [ ] **Step 11: Commit**

```bash
git add src/lib/p5/types.ts src/lib/p5/feed-ingest.ts src/lib/p5/esc-adapter.ts tests/p5/feed-ingest.test.ts tests/p5/esc-adapter.test.ts
git commit -m "feat(p5): wire QueryTerm.weight into fitness via weighted relevance (spec §5.1)"
```

---

### Task C: Bound the cross-cycle content-dedup scan

**Files:**
- Modify: `src/lib/store/repositories.ts` (add `signals.listByIds`)
- Modify: `src/lib/p5/alert-logic.ts:16-23` (use it)
- Test: `tests/p5/repositories.test.ts`, `tests/p5/alert-logic.test.ts`

- [ ] **Step 1: Write the failing `listByIds` repo test**

Add to `tests/p5/repositories.test.ts` (follow the existing `:memory:` + `makeRepositories` setup used in that file; create a goal first if the file's helper does not):

```ts
it("signals.listByIds returns only the requested rows, [] for empty input", () => {
  const repos = makeRepositories(openDb(":memory:"));
  const goalId = repos.goals.create({ title: "x", rawText: "x" }).id;
  const base = { goalId, genomeId: "g", source: "newsapi", kind: "news" as const, relevanceScore: 0.1 };
  const a = repos.signals.create({ ...base, payload: { id: "a", source: "newsapi", kind: "news", title: "a", summary: "", publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} } });
  const b = repos.signals.create({ ...base, payload: { id: "b", source: "newsapi", kind: "news", title: "b", summary: "", publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} } });
  repos.signals.create({ ...base, payload: { id: "c", source: "newsapi", kind: "news", title: "c", summary: "", publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} } });
  expect(repos.signals.listByIds([]).length).toBe(0);
  expect(repos.signals.listByIds([a.id, b.id]).map((s) => s.payload.id).sort()).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/p5/repositories.test.ts -t "listByIds"`
Expected: FAIL — `repos.signals.listByIds is not a function`.

- [ ] **Step 3: Add `listByIds` to the signals repository**

In `src/lib/store/repositories.ts`, add this method to the `signals: { … }` object (alongside `listForGoal`, before `updateRelevance`):

```ts
      listByIds(ids: number[]): StoredSignal[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`SELECT * FROM external_signal WHERE id IN (${placeholders})`).all(...ids);
        return (rows as any[]).map(rowToSignal);
      },
```

- [ ] **Step 4: Run to verify the repo test passes**

Run: `npx vitest run tests/p5/repositories.test.ts`
Expected: PASS — all repository tests green.

- [ ] **Step 5: Replace the unbounded scan in alert-logic**

In `src/lib/p5/alert-logic.ts`, replace `duplicateContentInOpenAlerts` (lines 16-23) with:

```ts
/** True if an OPEN alert for this goal already references a signal with the
 *  same source + payload.id (recurring item across cycles). Spec §8.2.
 *  Loads only the signals referenced by open alerts (bounded by open-alert count),
 *  not the goal's entire signal history. */
function duplicateContentInOpenAlerts(repos: Repositories, signal: StoredSignal): boolean {
  const open = repos.alerts.listOpen(signal.goalId);
  if (open.length === 0) return false;
  const openSignals = repos.signals.listByIds(open.map((a) => a.signalId));
  return openSignals.some((s) => s.payload.id === signal.payload.id && s.source === signal.source);
}
```

- [ ] **Step 6: Run the alert-logic suite to confirm dedup behavior is unchanged**

Run: `npx vitest run tests/p5/alert-logic.test.ts`
Expected: PASS — existing dedup tests still pass; the only change is which rows are loaded, not the dedup decision.

- [ ] **Step 7: Commit**

```bash
git add src/lib/store/repositories.ts src/lib/p5/alert-logic.ts tests/p5/repositories.test.ts tests/p5/alert-logic.test.ts
git commit -m "perf(p5): scope content-dedup to open-alert signals via signals.listByIds (spec §8.2)"
```

---

### Task D: Reconcile the spec wording with the chosen mechanism

**Files:**
- Modify: `docs/superpowers/specs/2026-05-27-p5-signals-design.md` (§5.2, §5.3, §5.4, §5.7)

- [ ] **Step 1: Update the operator-batching language**

In §5.3 and §5.4, replace "Batched via `batchComplete()`" / "Batched alongside crossover in the same `batchComplete()` call" with a note that operators run **concurrently** via the parallelized `esc-core.evolve` (all crossovers in one phase, all mutates in the next) — same latency benefit as a batch, achieved without changing the operator contract. In §5.2 keep "seed is a single one-shot call," but drop the claim that it is the *only* non-batched call (crossover/mutate use `complete()`, just concurrently).

- [ ] **Step 2: Note the weight semantics in §5.7**

Add one sentence to §5.7: selection ranks on the fitness produced in §5.6, which now incorporates `QueryTerm.weight` via a weighted relevance mean — so `weight` reaches selection transitively rather than appearing in `selectTop` directly.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-27-p5-signals-design.md
git commit -m "docs(p5): reconcile spec wording with parallel-evolve batching and weight-in-fitness"
```

---

## Self-Review

**Spec coverage of the three findings:**
- §5.2/§5.3/§5.4 (batching) → Task A makes operator calls concurrent; Task D reconciles wording. ✓
- §5.1 (`weight` used by fitness and selection) → Task B (fitness directly, selection transitively). ✓
- §8.2 (content dedup) → Task C bounds the scan, decision unchanged. ✓

**Placeholder scan:** every code step contains complete code; every run step has an exact command and expected result. No TBD/TODO. ✓

**Type/name consistency:** `queryWeight` is defined in Task B Step 3 and consumed in Steps 4 & 8; `signals.listByIds` is defined in Task C Step 3 and consumed in Step 5; `weightedRelevance`/`argmax` names match across steps; `evolve` signature unchanged. ✓

**Risk note:** Task A touches `esc-core` shared with S0 — Step 5 runs the full suite specifically to catch any S0 regression. Task A and Task C are independent; Task B depends only on its own files. Task D is docs-only and can run last or be skipped if the spec is treated as frozen.
