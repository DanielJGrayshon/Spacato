# Spacato — P3 Sliding-Window Re-planner Design Spec

> Date: 2026-05-29 · Status: **drafted** · Repo: github.com/DanielJGrayshon/Spacato
> Parent docs: `docs/canonical-project-graph.md` (§1 resolution gradient, §3 P2→P3 edge),
> `docs/superpowers/specs/2026-05-28-p2-decomposition-design.md` (input contract, OQ-7, OQ-8).
> Agents building this adopt the canonical role prompt (canonical graph §4b).

---

## 1. Overview & scope

P3 is Spacato's **sliding-window re-planner**. It runs over the live plan tree emitted by P2 — a versioned forest of `monthly → weekly → daily_task` rows rooted at `goal.activeDecompositionId` — and applies three deterministic policies whose composition is the entire feature:

1. **Lock policy.** The 14-day window starting at `today` — the *current week* (the week whose `[startDate, endDate]` contains `today`) and the *next week* (the immediately following week, walking weekly rows in `(monthly_index, week_index)` order) — is **locked**: titles, descriptions, dates, `estimatedMinutes`, and ordering are immutable. The only fields that may mutate inside the lock are `status` (`pending → done|skipped`) and `concretization_level` (`coarse → concrete`, the P2 OQ-8 hand-off).
2. **Reweight policy.** Weekly and monthly weights *outside* the lock are recomputed every cycle from a single deterministic input at v1: **temporal decay** (distance from `today`). The function is a normalised exponential of a linear score, with the lock anchored at its prior weight so reweighting cannot leak into the immutable region. v1 deliberately ships decay-only because the three other planned inputs (slippage, P5 signal pressure, user-edit priority bumps) all require live-data calibration that is not yet in hand — see §15 for the v2 expansion path. Note that user edits are still *consumed* in v1 via the trickle-down policy (priority bumps land as sibling-renormalisation events on unlocked subtrees, and `redecompose-*` edits fire partial redecomp); what is deferred is folding the priority-bump magnitude into the softmax logit. This means v1's deterministic weight changes come from decay plus structural propagation, not from a multi-input softmax.
3. **Trickle-down policy.** Targeted, idempotent edits propagate from a changed weekly to its parent monthly (weight-only) and from a changed monthly to its sibling monthlies (renormalisation only). Structural edits — re-decomposing a future weekly's daily children or a future monthly's weekly children — fire as **partial redecomp** by calling the existing P2 operators (`decomposeMonthlyToWeekly`, `decomposeWeeklyToDaily`) scoped to one parent. Partial redecomps never touch locked rows, even if the lock window has shifted into a row that was previously eligible.

P3 emits an **updated, re-versioned** plan tree by creating a new `decomposition` row, copying forward locked rows verbatim, applying reweights and trickle-down edits to the rest, and flipping `goal.activeDecompositionId` atomically. P2's versioning semantics extend cleanly: a P3 slide is just another `/api/decompose`-style version bump, but driven by deltas, not a full LLM redraw.

**Resolution gradient.** P3 owns the **coarse → concrete** upgrade for daily tasks entering the lock (P2 §1 / OQ-8). On the cycle a task crosses into the 14-day window, its `concretization_level` flips to `'concrete'` and an LLM enrichment pass rewrites title + description with brand-specific recommendations, vendor or tutorial references, and store-specific instructions. The concretization pass is **batched per slide** (one batch per goal) and **cached** via the existing `llm-gateway` cache (no `bypassCache` here — the same coarse task should produce a stable concretized form).

**In scope**
- `src/lib/p3/lock-window.ts` — pure heuristic `computeLockWindow(skeleton, today)` returning `{ lockedWeeklyIds, lockedDailyTaskIds, lockEndDate }`. Operates on the live tree (not the skeleton — the skeleton is rebuilt deterministically from row dates for boundary advance).
- `src/lib/p3/reweight.ts` — pure heuristic `reweight(rows, signals, slippage, edits, today)`. Specified in §6; deterministic; no LLM.
- `src/lib/p3/trickle.ts` — pure heuristic. Given a set of edited weeklies, recompute parent monthlies' weights and sibling renormalisation. Specified in §7; deterministic; idempotent (applying twice == applying once).
- `src/lib/p3/concretize.ts` — batched LLM pass over daily tasks newly entering the lock; uses `gw.batchComplete` (matching P5's relevance batching shape) and the existing cache.
- `src/lib/p3/partial-redecomp.ts` — thin wrapper that calls existing P2 operators (`decomposeMonthlyToWeekly`, `decomposeWeeklyToDaily`) with `bypassCache: true` for one parent at a time. **Re-exports P2 operator types verbatim — no redefinition.**
- `src/lib/p3/slide-handler.ts` — the orchestrator. One slide = one `db.transaction`. Reads active decomposition; runs lock-detect → reweight → trickle → concretize → optional partial-redecomp; writes a new decomposition with copied-forward locked rows and updated everything else; flips active pointer.
- `src/lib/p3/types.ts` — `SlideInput`, `SlideResult`, `ReweightInputs`, `SlippageReport`, `UserEdit`, `ConcretizationDelta`. Zod schemas for LLM input/output where applicable.
- Schema additions (§5): `slide_log`, `user_edit`, `slippage_observation`. All additive; defensive `ALTER TABLE` for any column adds to existing rows; same wipe-and-reinit-or-defensive-ALTER stance as P2 OQ-3.
- `/api/slide` route: `POST { goalId }` → 400 on no active decomposition, 404 on goal missing, 409 if a slide already ran for `today` (idempotency), 503 on terminal LLM failure during concretization or partial redecomp, 200 on success with the new `decompositionId` and the slide log.

**Out of scope** (deferred — see §11)
- Background scheduler that fires `/api/slide` automatically each midnight. v1 is request-driven (same posture as P5 §1).
- P4 daily timetable / preset packing. P3 emits a re-weighted plan tree with concretized locked dailies; P4 owns block assignment.
- Cross-goal task deduplication ("long run on Saturday" colliding across two goals). Surface at P4 packing; merge heuristic is deferred (P2 §11 OQ-9).
- P6 UI for the slide log / diff view.
- Schema migration framework (same v1 stance as P2 OQ-3 / P5 OQ-4).
- Pruning of inactive decompositions (P2 OQ-6 inherited).
- Multi-week lock policies (e.g. 3-week or 1-week locks). v1 is fixed-14-day. The lock-window heuristic is parameterised by `lockWeeks` but the route hard-codes `2`.

---

## 1a. Schema debt

P3 is the third shipped feature to land additive schema changes without a migration framework: S0 added elicitation tables, P2 added the decomposition forest and OQ-3 carve-out, and this spec adds three more (`slide_log`, `user_edit`, `slippage_observation`). The running count of additive `ALTER`/`CREATE` events is now **seven** across three features, and the defensive `ALTER TABLE` stance — wipe-and-reinit in dev, defensive ALTER in any persisted environment — has been carried forward verbatim from P2 OQ-3 / P5 OQ-4 each time.

**This debt resolves before the 8th additive event.** P3 is allowed to ship at seven on the explicit understanding that the next feature touching schema does *not* extend the pattern; it consumes the framework.

A separate spec, **Schema migration framework v1**, is being drafted in parallel by Worker D and is expected to land at `docs/superpowers/specs/2026-05-29-schema-migration-framework-v1.md`. <!-- TODO: confirm final path with orchestrator if Worker D's filename diverges. -->

Cross-references retired by that spec when it lands: this section, P2 OQ-3, and P5 OQ-4. Until then, the three of them are the canonical statement of the debt.

---

## 2. Goals & non-goals

**Goals**
- `/api/slide` produces a complete, structurally valid, re-versioned plan tree for any goal with an active decomposition in a single round-trip. Verified by an integration test driving the handler with stub gateway + stub signals and asserting row counts, FK integrity, locked-row immutability, lock-boundary advance, and `goal.activeDecompositionId` flipped.
- Lock-policy enforcement is **mechanical, not advisory**. The handler refuses to write any row in the new decomposition that mutates a locked field of the prior version (assertion-level invariant; §6.4). Verified by a property test that mutates a random non-status field on a locked row pre-write and asserts the handler throws.
- Reweighting is **deterministic and reproducible**. Same inputs → identical weights, bit-for-bit. Verified by a unit test that runs `reweight` twice on the same inputs and asserts strict equality of the output weight vector. No LLM in the weighting path.
- Trickle-down is **idempotent**. `trickle(trickle(state, edits)) === trickle(state, edits)`. Verified by a property test.
- Concretization is **batched** (`gw.batchComplete` over the set of tasks crossing into the lock this cycle) and **cached** (cache key = `(decompositionId, dailyTaskId, coarseHash)`). Re-running a slide that did no new lock entries produces zero LLM calls — verified by a test that mocks the gateway and asserts the call count.
- Partial redecomp **reuses P2 operators verbatim**. P3 does not redefine any LLM prompt or schema for monthly→weekly or weekly→daily. Verified by import inspection in the test suite.
- Total wall-clock for a steady-state slide (no partial redecomp, ≤7 daily tasks crossing into the lock) ≤ 8 s at default `gw.maxConcurrency`. Concretization-only LLM cost ≤ $0.001 per slide at `gpt-4o-mini` rates (§12).

**Non-goals**
- Re-running S0 elicitation on a goal whose specification has drifted. P3 consumes `convergedSpec` as-is; spec-drift is a future S0-resume problem.
- Re-deriving the calendar skeleton from anything other than `goal.timeframe` + `today`. The skeleton is **rebuilt every slide** from the live `goal.timeframe`; this means a user editing `timeframe` between slides is honoured automatically by the deterministic calendar rebuild, but the rebuild itself is **not** how lock detection works (lock detection reads the prior decomposition's row dates — see §6.1).
- Streaming partial slide results to the client. `/api/slide` is request/response.
- Inferring slippage from anything other than the `slippage_observation` table the orchestrator writes inside the slide transaction. There is no continuous slippage-tracking sidecar at v1.
- Web fetches for concretization (brand-lookup, vendor pricing, tutorial-link enrichment). v1 concretization is a single LLM pass that reads the coarse task and the goal context; it produces concretized prose but does **not** dereference external URLs. Real web-fetch concretization is **deferred to v2 (see §15)** — not an open question, an explicit deferral pending the marathon live run proving prose-only enrichment is the actual bottleneck.
- Re-estimating `estimatedMinutes` during concretization. **Belongs to P4 — out of scope for this spec.** P4 owns block assignment and is the natural home for any duration-revision feedback loop; revising duration in P3 would invalidate P4 packing already done against the prior estimate. Recorded here so it does not resurface as a P3 question.

---

## 3. Architecture & data flow

```
POST /api/slide { goalId }
        │
        ▼
  src/lib/p3/slide-handler.ts
        │
        ├──► goal = repos.goals.get(goalId)                          ← 404 if missing
        │    if (!goal.activeDecompositionId) -> 400 attributable
        │    if (slideLogs.existsForDate(goalId, today)) -> 409      ← idempotency
        │
        ├──► priorTree = repos.readActiveTree(goal)                  ← monthlies, weeklies, dailyTasks
        │
        ├──► skeleton = calendar.buildSkeleton(goal.timeframe, today) ← unchanged from P2
        │
        ├──► lock = lockWindow.compute(priorTree, today, { lockWeeks: 2 })
        │    {
        │      lockedWeeklyIds: Set<number>,
        │      lockedDailyTaskIds: Set<number>,
        │      lockEndDate: string,
        │      crossingDailyTaskIds: Set<number>,    ← newly entering lock this slide
        │      crossingWeeklyIds: Set<number>,
        │    }
        │
        ├──► slippage = slippage.observe(priorTree, today)           ← pure: scans locked dailies for status
        │    repos.slippageObservations.bulkInsert(slippage.rows)
        │
        ├──► signalPressure = signals.aggregate(repos, goalId, today)   ← pure: decayed sum over open alerts
        │
        ├──► userEdits = repos.userEdits.listPendingForGoal(goalId)  ← consumed-and-cleared in transaction
        │
        ├──► reweighted = reweight.apply(priorTree, {
        │       lock, signalPressure, slippage, userEdits, today,
        │    })
        │    // returns: { monthlies: Monthly[], weeklies: Weekly[] } with new weights;
        │    //          locked rows carry forward their PRIOR weight unchanged
        │
        ├──► trickled = trickle.propagate(reweighted, userEdits)
        │    // pure: renormalise parents and siblings of edited subtrees; idempotent
        │
        ├──► concretized = await concretize.batch(
        │       priorTree, lock.crossingDailyTaskIds, goal, gw, model)  ← BATCHED LLM (§8)
        │
        ├──► // Optional partial redecomp: any monthly/weekly that user edits flagged for redraw
        │    redecomped = await partialRedecomp.maybeRun(
        │       trickled, userEdits, goal, ops, today, skeleton, lock)
        │
        ▼
  inside ONE db.transaction:
    newDecompositionId = decompositions.create({ goalId })
    monthlies.bulkInsert(stampMonthlies(trickled, newDecompositionId))    -> ids
    weeklies.bulkInsert(stampWeeklies(trickled, ids, newDecompositionId)) -> ids
    dailyTasks.bulkInsert(stampDailies(
      priorTree, concretized, redecomped, weeklyIds, newDecompositionId, lock))
    slideLogs.create({ goalId, newDecompositionId, today, summary })
    userEdits.markConsumed(userEdits.map(e => e.id))
    goals.setActiveDecomposition(goalId, newDecompositionId)
        │
        ▼
  200 { decompositionId, slideLog }
```

**Topology.** Every stage but `concretize` and `maybeRun` is pure and synchronous. The async stages are bounded:
- **Concretize**: one batched LLM call (via `gw.batchComplete`) over the crossing-tasks set. Typically 0–7 items per slide (at 7 days/week × 1 task/day, with the boundary advance + first-slide bootstrap; see §6.1).
- **Partial redecomp**: at most one `decomposeMonthlyToWeekly` per user-edit-flagged monthly + at most one `decomposeWeeklyToDaily` per user-edit-flagged weekly, sibling-parallel via `Promise.all`. In the steady state (no user edits flagging structural redraws) this is **zero LLM calls**.

This matches the heuristics-first posture: a no-edit, no-crossing slide is **all deterministic** and produces a new decomposition with copied-forward rows whose only delta is reweighted weights on the unlocked tail.

**Heuristic / LLM split.**
- *Heuristic:* lock-window detection; skeleton rebuild; slippage scan; signal-pressure aggregation; reweighting; trickle-down propagation; idempotency check; transaction boundary; bulk insert; active-pointer flip; locked-row invariant assertion.
- *LLM:* (1) concretization of crossing daily tasks (batched, cached); (2) any partial redecomp triggered by a user edit (via P2 operators verbatim).

**Versioning semantics.** Same as P2: each slide creates a new `decomposition` row. P3 *and* P2 contribute to the same `decomposition` table. The `slide_log` row attributes every P3-produced decomposition to a slide event and stores a deterministic summary of what changed (which weights moved, which tasks concretized, which subtrees redecomposed). P6's diff UI reads `slide_log` to render slide-over-slide deltas.

**Orchestrator owns the lifecycle.** Lock/reweight/trickle/slippage are pure and DB-free; concretize and partial-redecomp take a gateway but no DB; only `slide-handler.ts` touches `repos`, `db.transaction`, and `setActiveDecomposition`. This mirrors P2 §3 ("Orchestrator owns the lifecycle").

---

## 4. Components & file surface

| File | Change | Responsibility |
|---|---|---|
| `src/lib/p3/lock-window.ts` | **create** | `computeLockWindow(priorTree, today, opts): LockResult`. Pure. Walks `priorTree.weeklies` in `(month_index, week_index)` order; finds the week containing `today` ("current"); takes that week plus the next one ("next"); returns the set of weekly IDs, the set of daily task IDs covered by those weeks, the lock end date (inclusive), and the **crossing** sets (rows that are in the lock now but were NOT in the lock of the *previous* slide for this goal — read from `slide_log` if any, else "all locked rows are crossing" on the first slide). |
| `src/lib/p3/slippage.ts` | **create** | `observe(priorTree, today): SlippageReport`. Pure. For every daily task with `date < today` and `status === 'pending'`: emit a `SlippageObservation { dailyTaskId, weeklyId, monthlyId, missedMinutes }`. Aggregates `missedMinutes` by `weeklyId` and `monthlyId` for the reweight inputs. |
| `src/lib/p3/signal-pressure.ts` | **create** | `aggregate(repos, goalId, today, opts): SignalPressure`. Pure heuristic over `repos.alerts.listOpen(goalId)`: `pressure = sum over open alerts of impactScore * exp(-ageDays / halfLifeDays)`. Defaults: `halfLifeDays = 7`. Per-goal scalar, scaled into `[0, 1]` by `tanh(pressure / 3)`. P5 already mints alerts with `impactScore ∈ [ALERT_THRESHOLD, 1]`; P3 reads them, does not compute relevance. |
| `src/lib/p3/reweight.ts` | **create** | `apply(priorTree, inputs): ReweightedTree`. Pure. Specified in §6.2. The lock anchor is enforced here: locked weeklies (and the locked weeks' parent monthlies' lock-contribution share) keep their **prior weight** unchanged; only the *unlocked* tail is re-softmaxed. |
| `src/lib/p3/trickle.ts` | **create** | `propagate(reweighted, userEdits): TrickledTree`. Pure, idempotent. Specified in §7. Applies user-edit weight bumps to the affected weeklies, renormalises sibling weeklies under the same monthly, and updates the parent monthly's relative weight against its siblings. **Never touches locked rows.** |
| `src/lib/p3/concretize.ts` | **create** | `batch(priorTree, crossingDailyTaskIds, goal, gw, model): ConcretizationDelta[]`. One `gw.batchComplete<EnrichedDaily>(reqs)` call where `reqs.length === crossingDailyTaskIds.size`. Each request includes the goal context, the daily task's coarse title + description, and asks for an enriched `{title, description}` pair with concrete recommendations. Uses the default cache (NOT `bypassCache`): the same coarse task crossing the lock again in a re-run produces the same enriched output. |
| `src/lib/p3/partial-redecomp.ts` | **create** | `maybeRun(trickled, userEdits, goal, ops, today, skeleton, lock): PartialRedecompDelta`. For each `userEdit` of kind `'redecompose-weekly'` whose target weekly is **outside the lock**: call `ops.decomposeWeeklyToDaily(goalCtx, monthlyCtx, weeklyCtx, dates)` via `withRetry`. For each `userEdit` of kind `'redecompose-monthly'`: similarly call `ops.decomposeMonthlyToWeekly` then expand. Rejects edits targeting locked subtrees with a 400-attributable error. Reuses P2's existing `withRetry` from `@/lib/p2/retry`. |
| `src/lib/p3/slide-handler.ts` | **create** | `handleSlide({ goalId }, deps): Promise<SlideResult>`. Wires it all together. Single `db.transaction`. Atomically: write new decomposition, copy forward locked rows verbatim, write reweighted/trickled/concretized/redecomped rest, write `slide_log`, mark `user_edit` rows consumed, flip `goal.activeDecompositionId`. |
| `src/lib/p3/locked-row-invariant.ts` | **create** | `assertLockedRowsUnchanged(prior, next, lock)`: throws if any locked weekly's `objective/description/weight/startDate/endDate` differs from prior, or any locked daily's `title/description/estimatedMinutes/date` differs (except `concretizationLevel` and the enriched title/description on the *crossing* set, which are the intended mutations). Run inside the transaction, **before** any insert commits. |
| `src/lib/p3/types.ts` | **create** | `SlideInput`, `SlideResult`, `LockResult`, `ReweightInputs`, `SignalPressure`, `SlippageReport`, `SlippageObservation`, `UserEdit`, `UserEditKind`, `ConcretizationDelta`, `PartialRedecompDelta`, `SlideLog`. Zod schemas for `enrichedDailySchema` and `userEditSchema`. |
| `src/lib/store/schema.sql` | modify | Add `slide_log`, `user_edit`, `slippage_observation` tables. Indices listed in §5. No new columns on existing tables. |
| `src/lib/store/types.ts` | modify | Export `SlideLog`, `UserEdit`, `SlippageObservation`. |
| `src/lib/store/repositories.ts` | modify | Add `slideLogs{create, getById, listForGoal, existsForDate}`, `userEdits{create, listPendingForGoal, markConsumed}`, `slippageObservations{bulkInsert, listForGoal}`. Add `repos.readActiveTree(goal)` helper that materialises `{monthlies, weeklies, dailyTasks}` for the goal's active decomposition. |
| `src/app/api/slide/route.ts` | **create** | `POST` reads `P3_CONCRETIZE_MODEL` env (default `openai/gpt-4o-mini`); wraps `handleSlide`. 400 no active decomposition / locked-subtree edit; 404 goal missing; 409 slide already exists for `today`; 503 LLM exhaustion; 200 success. Reuses `mapErrorToStatus`-style attribution. |
| `src/app/api/slide/error-mapping.ts` | **create** | Mirror of `decompose/error-mapping.ts` with the P3-specific message → status map. |
| `src/app/api/user-edits/route.ts` | **create** | `POST { goalId, kind, targetId, payload }` writes a `user_edit` row pending consumption on next slide. Allows the UI (P6) to queue priority bumps and structural redraws between slides. |

**Efficiency choices baked in.**
- The lock window is determined **from the prior tree's row dates**, not from a fresh calendar rebuild. This means a `timeframe` change between slides cannot retroactively un-lock a row that the user is already executing this week. The calendar rebuild is only consulted for **partial redecomp** (which needs date spans for new weeklies it generates).
- Reweight is one linear-time pass over weeklies + one over monthlies. No quadratic interactions.
- Trickle is one BFS up from edited weeklies; each visited row is renormalised once (idempotent because renormalisation reads the trickled-not-edited siblings' weights, not the post-renormalised values, by sourcing all reads from `reweighted` before any writes — §7.2).
- Concretization is a single `batchComplete` per slide. The gateway's existing cache layer carries the load: re-runs on the same coarse task are zero-cost.
- The `slide_log` table acts as P3's idempotency ledger: the `(goal_id, slide_date)` unique index drives the 409 response without a separate lock table.

---

## 5. Data model

### 5.1 Schema additions

```sql
CREATE TABLE IF NOT EXISTS slide_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id                  INTEGER NOT NULL REFERENCES goal(id),
  prior_decomposition_id   INTEGER REFERENCES decomposition(id),
  new_decomposition_id     INTEGER NOT NULL REFERENCES decomposition(id),
  slide_date               TEXT    NOT NULL,   -- ISO yyyy-mm-dd
  lock_start_date          TEXT    NOT NULL,
  lock_end_date            TEXT    NOT NULL,
  crossing_daily_count     INTEGER NOT NULL,
  reweighted_weekly_count  INTEGER NOT NULL,
  trickle_event_count      INTEGER NOT NULL,
  partial_redecomp_count   INTEGER NOT NULL,
  summary_json             TEXT    NOT NULL,   -- structured delta for P6
  created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slide_log_goal_date
  ON slide_log(goal_id, slide_date);
CREATE INDEX IF NOT EXISTS idx_slide_log_goal
  ON slide_log(goal_id, id);

CREATE TABLE IF NOT EXISTS user_edit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id           INTEGER NOT NULL REFERENCES goal(id),
  kind              TEXT    NOT NULL,   -- 'priority-bump' | 'redecompose-weekly' | 'redecompose-monthly'
  target_kind       TEXT    NOT NULL,   -- 'monthly' | 'weekly'
  target_id         INTEGER NOT NULL,   -- row id in monthly/weekly (validated at consume time)
  payload_json      TEXT    NOT NULL,   -- e.g. { "deltaWeight": 0.15 } or { "reason": "..." }
  consumed_slide_id INTEGER REFERENCES slide_log(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_edit_pending
  ON user_edit(goal_id, consumed_slide_id);

CREATE TABLE IF NOT EXISTS slippage_observation (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slide_log_id      INTEGER NOT NULL REFERENCES slide_log(id),
  goal_id           INTEGER NOT NULL,
  daily_task_id     INTEGER NOT NULL REFERENCES daily_task(id),
  weekly_id         INTEGER NOT NULL,
  monthly_id        INTEGER NOT NULL,
  missed_minutes    INTEGER NOT NULL,
  observed_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_slippage_goal_slide
  ON slippage_observation(goal_id, slide_log_id);
```

No additions to `monthly`, `weekly`, `daily_task`, or `goal`. The locked-row invariant (§6.4) makes the lock implicit in the data — there is no `locked` column. Lock membership is computed from `today` and the prior tree's dates, deterministically, every slide.

Why no `locked` column: the lock boundary advances every slide. A column would either drift out of sync with `today` (stale) or require a sweep to maintain (write amplification on every other goal's slide). Computing on read is cheap (binary-searchable on dates) and keeps the schema clean.

A typical 6-month goal sliding once per day for 26 weeks produces ~182 `slide_log` rows and ~26 `slippage_observation` rows on average — well under 10k rows total. Trivial in SQLite.

### 5.2 TypeScript types

```ts
// src/lib/store/types.ts (additions)
export interface SlideLog {
  id: number;
  goalId: number;
  priorDecompositionId: number | null;
  newDecompositionId: number;
  slideDate: string;
  lockStartDate: string;
  lockEndDate: string;
  crossingDailyCount: number;
  reweightedWeeklyCount: number;
  trickleEventCount: number;
  partialRedecompCount: number;
  summaryJson: string;  // P6 parses; P3 emits structured JSON
  createdAt: string;
}

export type UserEditKind = "priority-bump" | "redecompose-weekly" | "redecompose-monthly";
export type UserEditTargetKind = "monthly" | "weekly";

export interface UserEdit {
  id: number;
  goalId: number;
  kind: UserEditKind;
  targetKind: UserEditTargetKind;
  targetId: number;
  payload: unknown;  // schema in p3/types.ts; varies by kind
  consumedSlideId: number | null;
  createdAt: string;
}

export interface SlippageObservation {
  id: number;
  slideLogId: number;
  goalId: number;
  dailyTaskId: number;
  weeklyId: number;
  monthlyId: number;
  missedMinutes: number;
  observedAt: string;
}

export type SlideLogInit            = Omit<SlideLog, "id" | "createdAt">;
export type UserEditInit            = Omit<UserEdit, "id" | "consumedSlideId" | "createdAt">;
export type SlippageObservationInit = Omit<SlippageObservation, "id" | "observedAt">;
```

### 5.3 LLM output shapes

P3 introduces exactly one new LLM-bound schema (concretization). Partial redecomp reuses `monthlyArraySchema` / `weeklyArraySchema` / `dailyArraySchema` from `@/lib/p2/types.ts` — **not redefined**.

```ts
// src/lib/p3/types.ts
import { z } from "zod";

export const enrichedDailySchema = z.object({
  title:       z.string().min(1).max(120),
  description: z.string().min(1).max(400),
});
export type EnrichedDaily = z.infer<typeof enrichedDailySchema>;

export const userEditPayloadSchemas = {
  "priority-bump": z.object({
    deltaWeight: z.number().min(-0.5).max(0.5),  // clamped; absolute, not relative
    reason: z.string().max(160).optional(),
  }),
  "redecompose-weekly": z.object({ reason: z.string().max(160) }),
  "redecompose-monthly": z.object({ reason: z.string().max(160) }),
} as const;
```

`enrichedDailySchema` deliberately mirrors `dailyTaskInitSchema` minus `estimatedMinutes` — concretization rewrites the prose but **does not** revise the time estimate. Re-estimating would invalidate any P4 packing already done against the prior duration; that feedback loop belongs to P4 (see §2 out-of-scope), not P3.

---

## 6. Lock policy

### 6.1 Lock-window detection

```ts
// src/lib/p3/lock-window.ts
export interface LockResult {
  lockedWeeklyIds: Set<number>;
  lockedDailyTaskIds: Set<number>;
  lockStartDate: string;     // = current week's startDate
  lockEndDate: string;       // = next week's endDate (inclusive)
  crossingDailyTaskIds: Set<number>;
  crossingWeeklyIds: Set<number>;
}

export interface LockOpts { lockWeeks: number; }   // v1 hard-codes 2 at the route

export function computeLockWindow(
  priorTree: { weeklies: Weekly[]; dailyTasks: DailyTask[] },
  today: string,
  priorLockEndDate: string | null,   // from most recent slide_log; null on first slide
  opts: LockOpts,
): LockResult;
```

Algorithm.
1. Sort `priorTree.weeklies` by `(decomposition_id is implicit, fixed) startDate`. Define `current` as the unique weekly whose `[startDate, endDate]` contains `today` (inclusive on both ends, lexicographic ISO compare). If `today` is before any weekly (e.g. plan begins tomorrow), `current` is the first weekly; if `today` is after every weekly (post-deadline), `current` is the last weekly and the lock degenerates to a single weekly (and the slide is mostly a no-op).
2. `next` is the weekly immediately following `current` in the sorted order, or `null` if `current` is the last.
3. `lockedWeeklyIds = {current.id, next?.id}.filter(defined)`. `lockedDailyTaskIds = {dailyTask.id | dailyTask.weeklyId in lockedWeeklyIds}`.
4. `lockStartDate = current.startDate`; `lockEndDate = next?.endDate ?? current.endDate`.
5. **Crossing detection.** A daily task is *crossing* this slide iff `lockStartDate ≤ dailyTask.date ≤ lockEndDate` AND (`priorLockEndDate === null` OR `dailyTask.date > priorLockEndDate`). On the first slide for a goal, every locked daily is crossing (bootstrap concretization runs once). A weekly is crossing iff at least one of its daily tasks is crossing.

The `(lockWeeks: 2)` parameter on the LockOpts surface lets later product calls tune to 1-week or 3-week locks per goal without touching the algorithm. The v1 route hard-codes `2` per canonical graph §1's resolution gradient.

### 6.2 Immutable fields under lock

| Row type | Immutable under lock | Mutable under lock |
|---|---|---|
| `monthly` | `startDate`, `endDate`, `objective`, `description` | `weight` (only via trickle-down from a child weekly's reweight; see §7) |
| `weekly` | `startDate`, `endDate`, `objective`, `description`, `weight` | (nothing direct; reweight is anchored — see §6.3) |
| `daily_task` | `date`, `estimatedMinutes`, `weeklyId` | `status` (always — even outside the lock, `status` is mutable by the user); `concretizationLevel` (one-shot `'coarse' → 'concrete'` on crossing); `title`, `description` (one-shot rewrite by concretization on crossing) |

The crossing-set rewrite of `title` and `description` is the **only** semantic mutation permitted on locked daily tasks, and it happens exactly once per task lifetime (the cache key makes a re-run a no-op). Subsequent slides that find the same task in the lock but not the crossing set carry the concretized fields forward verbatim.

### 6.3 Anchored reweight

The reweight function (§7.2) returns a vector over **all** weeklies under a given goal's decomposition. To enforce the lock anchor:

```
for each weekly w in priorTree.weeklies:
  if w.id ∈ lockedWeeklyIds:
    new_weight[w.id] = w.weight         // exact carry-forward
    // its monthly parent's weight contribution is also frozen for that share
  else:
    new_weight[w.id] = softmax_term(w, inputs)

renormalise the unlocked portion so that sum(new_weight) over unlocked == sum(w.weight) over unlocked in prior
// keeps the global sum = 1.0 (since locked weights carried forward exactly,
// and unlocked are renormalised within their own previous mass)
```

This *budget-preserving* renormalisation prevents the unlocked tail from inflating into the locked region's mass when P5 pressure or slippage points strongly at an already-locked weekly. It is the formal version of "the lock means what it says".

### 6.4 Locked-row invariant assertion

Before the new decomposition's rows commit, the orchestrator calls `assertLockedRowsUnchanged(prior, next, lock)`. The assertion compares the prior row's snapshot against the about-to-insert row. If any *immutable-under-lock* field differs, it throws `"p3: locked-row invariant violated: <kind>#<id>.<field>"`. The transaction rolls back.

This is the structural safety net: a future code path that miscomputes the lock cannot silently corrupt the user's committed near-term plan.

---

## 7. Reweight & trickle-down policy

### 7.1 Reweight inputs

v1 ships **decay-only**. The full four-input shape (slippage, signals, user-edit bumps) is specified in §15 as the v2 expansion path. All four coefficients exist in the v1 config struct with three set to zero; this makes v1 → v2 a coefficient change, not a code change (see §15.3).

```ts
// src/lib/p3/types.ts

// SignalPressure and SlippageReport are still computed each slide:
//   - SlippageReport because slippage_observation rows are persisted regardless (raw data
//     for v2 calibration and for the slide log summary).
//   - SignalPressure because the slide log summary surfaces top alert impacts to P6.
// Neither feeds the v1 reweight logit; both flow into the slide_log summary.
export interface SignalPressure {
  goalId: number;
  pressure: number;          // ∈ [0, 1]; tanh-squashed decayed sum over open alerts
  topAlertImpacts: number[]; // for the slide_log summary; not algorithmic at v1
}

export interface SlippageReport {
  byWeeklyId: Record<number, number>;   // weeklyId → missedMinutes in this slide's pre-today window
  byMonthlyId: Record<number, number>;
  rows: SlippageObservationInit[];
}

export interface ReweightInputs {
  lock: LockResult;
  // v1: decay is the only input that drives the softmax logit.
  // The other three are carried in the struct so v2's expansion is a coefficient flip:
  signalPressure: SignalPressure;   // present; coefficient γ = 0 at v1
  slippage: SlippageReport;         // present; coefficient β = 0 at v1
  userEdits: UserEdit[];            // present; coefficient δ = 0 at v1
                                    // (priority-bump magnitudes still consumed by trickle-down — §7.3)
  today: string;
}
```

### 7.2 Reweight function

Per *unlocked* weekly `w`, compute a logit. The coefficient form is kept four-input so v2 is a config flip, but at v1 only α is non-zero:

```
score(w) = α * decay(w, today)
         + β * slippageTerm(w)     // β = 0 at v1
         + γ * signalTerm(w)       // γ = 0 at v1
         + δ * userEditTerm(w)     // δ = 0 at v1

where:
  decay(w, today)        = exp(-max(0, daysUntil(w.startDate, today)) / τ)
                           // weeks far in the future get less attention budget
                           // τ = 28 days (≈ one month half-distance)
  slippageTerm(w)        = slippage.byWeeklyId[w.id] / maxMissed   // computed but unused at v1
  signalTerm(w)          = signalPressure.pressure                  // computed but unused at v1
  userEditTerm(w)        = sum over priority-bump edits whose target subtree contains w
                           of edit.deltaWeight                      // computed but unused at v1
                                                                     // (still applied via trickle — §7.3)
```

Coefficients (v1):

| Coef | Value | Justification |
|---|---|---|
| α (decay) | 1.0 | Anchors the prior shape; weeklies decay toward uniform-by-distance. The only input v1 needs: it captures "near work matters more than far work" deterministically, requires no live-data calibration, and produces a sensible reweight from the very first slide. |
| β (slippage) | **0.0** | Reserved for v2. v1 zero because the slippage cap (§15) needs live data to set, and an uncapped slippage term on the first user who skips a week could distort the entire remaining plan. Slippage is still observed and persisted; v1 just does not let it move weights. |
| γ (signals) | **0.0** | Reserved for v2. v1 zero because P5 alert impact scores have not been observed in production yet, and a goal-wide nudge that fires before we know what alerts actually look like risks pulling every unlocked weekly in the same direction for the wrong reason. |
| δ (user edits) | **0.0** | Reserved for v2. v1 zero in the *softmax logit* — priority-bump magnitudes are still consumed by trickle-down sibling-renormalisation (§7.3), which is the load-bearing path for user intent at v1. The v2 logit term is the *additional* effect of letting a bump also influence the global softmax beyond its immediate siblings. |

**Why decay-only at v1.** The cut is justified on three grounds: (1) decay is the only input whose correct shape is knowable without live production data — the other three need calibration loops that themselves need slides to have run; (2) running a multi-input softmax with un-calibrated coefficients is worse than running a single-input one, because the interactions hide which coefficient is causing any given complaint; (3) user intent (the most important non-decay signal) is still carried at v1, just through trickle-down rather than the softmax — and trickle-down is the more local, more interpretable channel for "I care more about this weekly" anyway. The marathon live run (§10.4) gives us slippage and signal data to calibrate β and γ against; §15 documents how those numbers come on stream.

Then:
```
unlockedMass = sum over locked weeklies of w.weight    // = 1.0 - locked anchored mass
softmax over unlocked: new_weight[w] = unlockedMass * exp(score(w)) / sum_unlocked(exp(score))
```

Monthlies' weights are recomputed at the end by summing their children's new weights:
```
for monthly m:
  if all m's weeklies are locked: new_weight[m] = m.weight   // anchored
  else: new_weight[m] = sum over m.weeklies of new_weight[wk]
```

This makes the monthly weights an emergent property of the weekly weights, consistent with P2 §6.4's initial uniform assignment.

**Determinism.** No `Math.random()`, no time-dependent reads (only `today`, which is an input). Same inputs → same outputs, bitwise. Verified by an equality test.

### 7.3 Trickle-down propagation

Trickle-down is the propagation of **structural** changes (user-edit redecomps, partial-redecomp outputs, and any future P5-triggered child structural edits) up to parent monthly weights and across to sibling weeklies/monthlies.

```ts
// src/lib/p3/trickle.ts
export function propagate(
  reweighted: ReweightedTree,
  userEdits: UserEdit[],
): TrickledTree;
```

Algorithm.
1. **Edge collection.** For each user-edit of kind `priority-bump`: collect the `targetId` into a set `bumped`.
2. **Sibling renormalisation.** For each bumped weekly `w`: read all siblings (same `monthlyId`) from `reweighted` (NOT from the in-progress trickled output — this is what makes the function idempotent), keep the prior monthly's mass intact, and redistribute among siblings using `score(w_i) + (i == bumped ? deltaWeight : 0)` then re-softmax. Locked siblings are anchored.
3. **Parent-monthly update.** For each monthly whose children's weights changed: recompute parent weight = sum of children. If the parent is locked (all children locked), it carries forward.
4. **Sibling-monthly renormalisation.** If a parent monthly's weight changed, renormalise its siblings so the sum of all unlocked monthlies' weights equals `1 - sum(locked monthlies' anchored weights)`.

Steps 1–4 each operate on `reweighted` as the source of truth and write to a fresh `TrickledTree`. Calling `propagate(propagate(reweighted, edits), edits)` is equivalent to `propagate(reweighted, edits)` because the second call re-reads `reweighted` (snapshot semantics), reproducing the same outputs.

**Ordering.** Children → parent (step 3) → sibling-parent renormalisation (step 4). Same ordering every call. No `Set` iteration leakage (use sorted ID order before each step).

---

## 8. Concretization

### 8.1 What it does

For each daily task `t` in `lock.crossingDailyTaskIds`, P3 sends one LLM request asking for an enriched `{title, description}`. The enriched form *may* include:
- Brand-specific recommendations (e.g. specific gel brand, specific shoe model).
- Vendor / tutorial references (e.g. "see the official Couch-to-5K guide").
- Store-specific instructions (e.g. "set Apple Reminders to ping you 15 min before").

It *does not*:
- Dereference URLs (no web fetch at v1; deferred to v2 — see §15 and §2 out-of-scope).
- Change `estimatedMinutes` (which would invalidate downstream packing; belongs to P4 — see §2).
- Change `date` or `weeklyId`.

### 8.2 LLM call

One batched call per slide via `gw.batchComplete`:

```ts
const reqs: LlmRequest<EnrichedDaily>[] = Array.from(crossingDailyTaskIds).map((id) => {
  const t = dailyById.get(id)!;
  return {
    model,
    schema: enrichedDailySchema,
    messages: [
      { role: "system", content: SYSTEM_CONCRETIZE },
      { role: "user",   content: renderConcretizePrompt(goalCtx, monthlyCtx(t), weeklyCtx(t), t) },
    ],
    // bypassCache: OMITTED — default false; cache key includes the coarse task hash,
    //              so re-runs are stable and free.
  };
});
const enriched = await gw.batchComplete(reqs);
```

System prompt:

```
You are a concretization assistant. You receive a coarse daily task that is about to be executed
within the next 14 days. Rewrite its title and description into a concrete, ready-to-execute form
with specific brand recommendations, vendor or tutorial references, and store-specific instructions
the user can act on immediately. Keep estimatedMinutes implicit — do not mention it. Title <=120 chars;
description 1-3 sentences. Reply only with JSON of shape {"title":"...","description":"..."}.
```

### 8.3 Why this earns its place

A purely deterministic concretizer would have to either (a) hardcode brand lists (brittle, dated) or (b) skip enrichment (defeats the purpose). The LLM here turns "easy 5k" into "easy 5k on a flat local route in your Nike Pegasus, using the Strava 'Easy Run' workout template; have water plus one gel ready" — semantic substance that a calendar packer cannot generate. The cost is bounded (≤ 7 calls/slide steady state) and cached (re-runs free).

### 8.4 Failure handling

If `batchComplete` throws after the gateway's own retries (the gateway already wraps OpenRouter with bounded retry per its existing contract), the orchestrator wraps the call in `withRetry` from `@/lib/p2/retry` (default 3 attempts, exponential backoff, transient predicate). On terminal failure, the slide returns 503 — but **only the concretization stage failed**, so the route's error mapping surfaces a distinct message (`"p3: concretization exhausted retries"`). The transaction has not yet opened; no rows are written. The user retries; the cache (which is gateway-level on success) means already-enriched items in a partial success would be free on retry.

---

## 9. Partial redecomp

### 9.1 Surface

```ts
// src/lib/p3/partial-redecomp.ts
export interface PartialRedecompDelta {
  redrawnWeeklies: Array<{ weeklyId: number; newDailies: DailyTaskInit[] }>;
  redrawnMonthlies: Array<{
    monthlyId: number;
    newWeeklies: WeeklyInit[];
    newDailiesByWeek: DailyTaskInit[][];
  }>;
}

export async function maybeRun(
  trickled: TrickledTree,
  userEdits: UserEdit[],
  goal: Goal,
  ops: P2Operators,        // imported from @/lib/p2/operators — verbatim
  today: string,
  skeleton: CalendarSkeleton,
  lock: LockResult,
): Promise<PartialRedecompDelta>;
```

### 9.2 Behaviour

For each `userEdit` of kind `'redecompose-weekly'`:
1. Fetch the target weekly's dates. If any date `≤ lock.lockEndDate`, throw `"p3: redecompose targets locked subtree: weekly#<id>"` (mapped to 400).
2. Otherwise call `ops.decomposeWeeklyToDaily(goalCtx, monthlyCtx, weeklyCtx, dates)` wrapped in `withRetry`. The call uses `bypassCache: true` (inherited from the P2 operator implementation — see P2 §7.4) so the redraw is genuinely fresh.

For each `userEdit` of kind `'redecompose-monthly'`:
1. Fetch the target monthly's `startDate, endDate`. If any falls inside the lock, throw `"p3: redecompose targets locked subtree: monthly#<id>"` (400).
2. Otherwise call `ops.decomposeMonthlyToWeekly(...)` then `ops.decomposeWeeklyToDaily(...)` for each new weekly, sibling-parallel via `Promise.all`. Same retry / backoff posture as P2 §8.

### 9.3 Persistence

Inside the slide transaction, redrawn weeklies/dailies are inserted into the new decomposition with the user-edit-flagged parents pointing at the new IDs; unflagged subtrees carry forward verbatim from the prior decomposition (just stamped with the new `decomposition_id`). The locked subtree is never touched.

---

## 10. Slide lifecycle

```
handleSlide({ goalId }, { repos, ops, gw, model, calendar, today }):
  1. goal = repos.goals.get(goalId)
     if (!goal)                              -> 404
     if (!goal.activeDecompositionId)        -> 400 "no active decomposition"
     if (repos.slideLogs.existsForDate(goalId, today)) -> 409 "slide already exists for today"

  2. priorTree = repos.readActiveTree(goal)

  3. priorLockEnd = repos.slideLogs.latestForGoal(goalId)?.lockEndDate ?? null
     lock = lockWindow.compute(priorTree, today, priorLockEnd, { lockWeeks: 2 })

  4. slippage = slippage.observe(priorTree, today)

  5. signalPressure = signalPressure.aggregate(repos, goalId, today, { halfLifeDays: 7 })

  6. userEdits = repos.userEdits.listPendingForGoal(goalId)
     // Validate: any priority-bump or redecompose-* targeting a locked id -> throw 400.

  7. reweighted = reweight.apply(priorTree, { lock, signalPressure, slippage, userEdits, today })

  8. trickled = trickle.propagate(reweighted, userEdits)

  9. concretized = await withRetry(() =>
       concretize.batch(priorTree, lock.crossingDailyTaskIds, goal, gw, model))
     // returns Map<dailyTaskId, EnrichedDaily>. Empty map if no crossings.

  10. redecomped = await partialRedecomp.maybeRun(
        trickled, userEdits, goal, ops, today, skeleton, lock)
      // empty deltas if no redecompose-* edits.

  11. db.transaction(() => {
        const newDecompositionId = repos.decompositions.create({ goalId }).id;

        // a) carry forward locked rows verbatim, stamped with new decompositionId
        //    (assertLockedRowsUnchanged verifies the carry-forward is faithful before insert)
        const carriedMonthlies = priorTree.monthlies.map(m =>
          stampMonthly(m, newDecompositionId, trickled.weightForMonthly(m.id)));
        const carriedWeeklies = priorTree.weeklies
          .filter(w => !redecomped.replacedWeeklyIds.has(w.id))
          .map(w => stampWeekly(w, newDecompositionId, trickled.weightForWeekly(w.id)));
        const carriedDailies = priorTree.dailyTasks
          .filter(d => !redecomped.replacedDailyTaskIds.has(d.id))
          .map(d => {
            const enriched = concretized.get(d.id);
            return stampDaily(d, newDecompositionId, enriched);   // enriched ⇒ flips concretizationLevel
          });

        invariant.assertLockedRowsUnchanged(priorTree, { carriedMonthlies, carriedWeeklies, carriedDailies }, lock);

        const monthlyIds = repos.monthlies.bulkInsert(carriedMonthlies);
        const monthlyIdMap = mapByPriorMonthlyId(priorTree.monthlies, monthlyIds);
        const weeklyIds = repos.weeklies.bulkInsert(
          rebindMonthlyIds(carriedWeeklies, monthlyIdMap));
        const weeklyIdMap = mapByPriorWeeklyId(carriedWeeklies, weeklyIds);
        repos.dailyTasks.bulkInsert(rebindWeeklyIds(carriedDailies, weeklyIdMap));

        // b) insert redecomp output (already keyed against the new parent ids via newDecompositionId)
        applyRedecomp(redecomped, monthlyIdMap, weeklyIdMap, newDecompositionId, repos);

        const slideLog = repos.slideLogs.create({
          goalId, priorDecompositionId: goal.activeDecompositionId, newDecompositionId,
          slideDate: today, lockStartDate: lock.lockStartDate, lockEndDate: lock.lockEndDate,
          crossingDailyCount: lock.crossingDailyTaskIds.size,
          reweightedWeeklyCount: trickled.changedWeeklyIds.size,
          trickleEventCount: trickled.events.length,
          partialRedecompCount: redecomped.redrawnWeeklies.length + redecomped.redrawnMonthlies.length,
          summaryJson: JSON.stringify(buildSummary(trickled, concretized, redecomped, slippage, signalPressure)),
        });

        repos.slippageObservations.bulkInsert(
          slippage.rows.map(r => ({ ...r, slideLogId: slideLog.id })));

        repos.userEdits.markConsumed(userEdits.map(e => e.id), slideLog.id);

        repos.goals.setActiveDecomposition(goalId, newDecompositionId);

        return { newDecompositionId, slideLog };
      });

  12. return { decompositionId: newDecompositionId, slideLog }
```

**Atomicity.** Steps 9 and 10 (the two async LLM stages) execute **before** the transaction opens — same posture as P2 §8. Step 11 is the atomic write. The invariant assertion fires inside the transaction; a violation rolls back the whole new tree. No partial slide ever lands.

**Concurrency safety (single-user local app).** SQLite's default WAL + the `(goal_id, slide_date)` unique index together prevent a double-slide race within the same `today` — the second insert into `slide_log` fails with a unique-constraint violation, the transaction rolls back, and the route maps that to 409. No additional locking primitive is needed at v1.

---

## 10.4 Live-run protocol

After merge, run end-to-end against real OpenRouter:

1. **Bootstrap.** Pick the marathon goal from P2's live run (per P2 §10.4). Confirm its `activeDecompositionId` is set and the tree exists.
2. **First slide.** `POST /api/slide { goalId }`. Eyeball:
   - The lock spans current week + next week per the calendar arithmetic (compare to `priorTree.weeklies[i].dates`).
   - `crossingDailyCount = lockedDailyTaskIds.size` (first slide = bootstrap crossing).
   - All ~14 locked daily tasks have `concretizationLevel = 'concrete'` and their `title`/`description` now include concrete recommendations (brand names, vendor refs, store-specific tips). Unlocked dailies remain `'coarse'`.
   - Weekly weights outside the lock have been redistributed; weights inside the lock match the prior decomposition's weights bit-for-bit (run a SQL diff: `SELECT id, prior.weight, new.weight FROM ... WHERE id IN locked_ids` should return zero rows where `prior.weight != new.weight`).
   - `monthly.weight` for the parent of the locked weeks is unchanged (no children moved); siblings renormalised.
   - `slide_log` row present; `summary_json` parses; `lock_start_date` == current week start; `lock_end_date` == next week end.
   - Wall-clock ≤ 8 s for ~14 concretizations; cost ≤ $0.001.
3. **Second slide same day.** Re-`POST /api/slide`. Expect **409**. `slide_log` row count unchanged.
4. **Second slide next day** (simulate by overriding `today` via a dev-only `?today=` query param OR by waiting; the test rig prefers the param). Expect 200 with `crossingDailyCount` low (typically 1 — the new day that just entered the next-week tail) or 0 (if the boundary did not advance into new daily rows). Newly-crossed tasks now `'concrete'`; previously-`'concrete'` tasks unchanged. Gateway cache stats: 0 new cache writes for previously-concretized tasks if any get re-checked.
5. **Inject a user edit.** `POST /api/user-edits { goalId, kind:'priority-bump', targetKind:'weekly', targetId: <weekly#3 of month#3>, payload: { deltaWeight: 0.15 } }`. Then `POST /api/slide` next day. Expect that weekly's weight to be higher than before, its siblings' weights lower (sum within the monthly preserved), and the parent monthly's weight up (siblings under the goal renormalised). The `user_edit` row's `consumed_slide_id` is now set.
6. **Inject a structural edit.** `POST /api/user-edits { goalId, kind:'redecompose-weekly', targetId: <weekly#1 of month#5> }`. Slide. Expect that weekly's 7 daily tasks replaced by fresh draws (titles differ from prior); locked-week daily tasks unchanged.
7. **Inject a locked-subtree edit.** `POST /api/user-edits { goalId, kind:'redecompose-weekly', targetId: <weekly in current week> }`. Slide. Expect **400** with message `"p3: redecompose targets locked subtree: weekly#<id>"`. `slide_log` row count unchanged; the edit remains pending (un-consumed).

Record the live trace to `docs/live-runs/2026-MM-DD-p3-marathon.md`. This trace is the calibration input for §15 (v2 reweight): per-slide slippage histograms, observed alert pressure values, and qualitative user-judgment notes feed the v2 coefficient round. v1 has only α (decay) to tune, and α = 1.0 has no degrees of freedom worth a live-data round on its own — the marathon trace exists primarily to seed v2.

Expected suite delta: **+28 tests approx.**

---

## 11. Open questions / deferred

**OQ-1 — Reweight coefficient calibration.** Decay rate τ (currently 28d, inspection-chosen) and, once §15's v2 inputs come online, the slippage cap and the β/γ/δ values themselves. All four sub-questions share a single gate: **needs live data**, target one round of tuning after the first three production slides. Folding them into one question because they share the same calibration source (the marathon trace plus the first three real slides) and the same fitness signal (user-judgment "did this slide feel right"). Could itself become an EvoPrompt-style tuner if the post-v2 parameter space justifies it.

**OQ-2 — Multi-week or per-goal lock policies.** A user might want a 1-week lock on a "build a habit" goal and a 4-week lock on a "study for an exam" goal. `LockOpts.lockWeeks` is parameterised but only `2` is exposed at v1. Surface a per-goal setting once a second product shape is real.

**OQ-3 — Background slide scheduling.** v1 is request-driven (the UI nudges the user, or P6 calls `/api/slide` on first paint each day). A cron / scheduled job that fires `/api/slide` at midnight is a follow-up; needs the same threat model as P5's deferred scheduler.

**OQ-4 — Cross-goal slide ordering.** If the user has multiple goals and slides them in sequence, each goal's reweight is independent (good). But concretization could exhaust a shared OpenRouter rate budget if many goals slide simultaneously. Trivial in single-user v1; flag for multi-user scale-out.

**OQ-5 — `daily_task.status` lifecycle hand-off** (inherited P2 OQ-7). v1: status mutates via the UI (P6) writing `status` directly via a `/api/daily-tasks/:id/status` endpoint. P3 reads `status` for the slippage scan but does not own the write path. Status writes are *the* exception to "no row mutations outside slide" — explicitly carved out.

**OQ-6 — Locked-row carry-forward storage.** v1 duplicates locked rows into each new decomposition (write amplification: ~14 rows per slide × 180 slides ≈ 2.5k rows over a 6-month run). Acceptable, but a `decomposition_node_alias` table that just points at prior rows for locked subtrees would cut the duplication. Defer until row count is a measured concern; the current shape is simpler for diffing.

---

## 12. Cost

Live `gpt-4o-mini` (input $0.15 / 1M, output $0.60 / 1M):

- **Concretization** (≤ 7 calls/slide steady state): each ~400 tokens in + ~80 tokens out ≈ 7 × (400 in / 80 out) ≈ 2.8k in / 560 out ≈ **$0.00076 per slide**.
- **First slide (bootstrap)** concretizes the whole 14-day lock at once (~14 calls): ≈ $0.0015.
- **Partial redecomp** (only when a user edit fires): same per-call rates as P2; a single `redecompose-weekly` is one call ≈ $0.00045. A `redecompose-monthly` is one + ~5 calls ≈ $0.0023. Bounded by the number of pending user edits per slide.

Steady-state cost per slide is dominated by concretization at ≤ $0.001. Daily slides for a 6-month goal sum to ~$0.14 over the full plan — comparable to one P2 decomposition. Negligible.

Wall-clock target: ≤ 8 s end-to-end at default `gw.maxConcurrency = 8` (concretization is one batchComplete sub-wave; reweight + trickle are microsecond-scale).

---

## 13. SOTA grounding

- **GoalAct (2025).** "Continuously updated global plan + hierarchical execution" — directly anchors P3's posture: the plan tree is the global plan, P2 produces the initial version, and every slide is a continuous-update event. The slide log is GoalAct's plan-update history. (Per canonical graph §5: "GoalAct (continuously-updated global plan + hierarchical execution) ≈ our weekly-tick re-planner".)
- **HiPlan (2025).** Milestone guide + stepwise hints. P3's lock = HiPlan's stepwise hint horizon (the concrete near-term), reweight + trickle-down = HiPlan's milestone guide adjustment (the coarse far-term). The lock-boundary advance enacts HiPlan's "hints become milestones, milestones recede into the future" gradient.
- **ReAcTree (2025).** Recursive subgoal tree. P3 inherits ReAcTree's tree shape from P2 and adds the **temporal slicing** dimension ReAcTree doesn't address natively; partial redecomp is ReAcTree's "regenerate-subtree" operation gated by lock policy.
- **EvoPrompt (ICLR 2024).** Used internally by S0 and P5 via ESC. P3 does not (yet — see merged OQ-1 / §15 calibration round) treat reweight coefficients as an evolvable population, but the door is left open: `reweight.apply` is pure, so a future ESC adapter could optimise α/β/γ/δ against a user-judgment fitness signal once v2 brings the latter three off the floor.

ESC primitives explicitly considered for reuse:
- `select`, `score`, `evolve` from `@/lib/esc/core` — **not reused at v1**. P3's reweight is a one-shot deterministic softmax, not a population step. If OQ-1 turns reweight into an evolved process, `score(cfg, weights)` and `select(cfg, weights, fitness)` would map directly. Documented here so a future agent doesn't re-invent the abstraction.
- `withRetry` from `@/lib/p2/retry` — **reused verbatim** for concretization and partial redecomp. Same transient-error predicate, same backoff.
- P2 operators (`decomposeMonthlyToWeekly`, `decomposeWeeklyToDaily`) and their prompts/schemas — **reused verbatim** for partial redecomp. P3 imports them; never redefines them.

---

## 14. Acceptance checklist

A reviewer should be able to tick every box before this lands on `main`.

- [ ] All eight new TypeScript files (`p3/lock-window.ts`, `p3/slippage.ts`, `p3/signal-pressure.ts`, `p3/reweight.ts`, `p3/trickle.ts`, `p3/concretize.ts`, `p3/partial-redecomp.ts`, `p3/slide-handler.ts`) created; each exports the surface specified in §4.
- [ ] `p3/locked-row-invariant.ts` implements `assertLockedRowsUnchanged` per §6.4; integration test proves a deliberately-mutated locked row throws.
- [ ] Three new tables (`slide_log`, `user_edit`, `slippage_observation`) added to `schema.sql` with the indices in §5.1.
- [ ] `repos.readActiveTree(goal)`, `repos.slideLogs.*`, `repos.userEdits.*`, `repos.slippageObservations.*` implemented and unit-tested.
- [ ] `/api/slide` route returns 200/400/404/409/503 per §4. Error-mapping table verified by a route test.
- [ ] `/api/user-edits` route accepts the three `UserEditKind`s; rejects unknown kinds with 400; rejects edits targeting locked subtrees with 400 at slide time (not at edit time — edits are queued and validated on consume).
- [ ] Reweight determinism test: same `(priorTree, inputs)` ⇒ bitwise-identical weight vector across two runs.
- [ ] Trickle idempotency property test: `propagate(propagate(t, edits), edits) === propagate(t, edits)`.
- [ ] Locked-row invariant property test: random mutation of any immutable-under-lock field on a locked row pre-write ⇒ assertion throws ⇒ transaction rolls back ⇒ `activeDecompositionId` unchanged.
- [ ] Idempotency test: two `POST /api/slide` calls on the same day ⇒ second returns 409; `slide_log` row count unchanged.
- [ ] Crossing detection test: first-slide bootstrap concretizes all locked dailies; subsequent slide only concretizes the new day(s) entering the lock; previously-concretized rows carry forward verbatim.
- [ ] Cache-bypass scope test: concretization uses the gateway cache (re-run with same coarse task ⇒ zero new LLM calls). Partial redecomp bypasses cache (re-run produces fresh prose, mirroring P2).
- [ ] Partial-redecomp reuses P2 operators *by import*, not by reimplementation; verified by inspecting `p3/partial-redecomp.ts` for the `from "@/lib/p2/operators"` line.
- [ ] Live-run §10.4 executed against real OpenRouter; trace written to `docs/live-runs/2026-MM-DD-p3-marathon.md`; eyeball checks passed.
- [ ] Cost ≤ $0.001 per steady-state slide; wall-clock ≤ 8 s.
- [ ] Reweight v1 ships with β, γ, δ all at zero in the config struct, exercised by a test that asserts changing slippage / signal pressure / user-edit `deltaWeight` inputs does **not** alter the softmax output at v1 (decay-only invariant). This is the explicit guard that §15 stays a coefficient flip, not a re-implementation.
- [ ] Open Questions OQ-1 through OQ-6 acknowledged; none silently resolved.

---

## 15. V2 — Reweight v2 (imminent)

This section specifies the immediate next iteration of the reweight policy in design-doc detail. v1 ships decay-only; v2 turns on the three additional inputs. **v2 is not a refactor — it is a coefficient flip.** All four inputs already flow through `reweight.apply` at v1 (§7.1, §7.2); the v1 → v2 transition is "set β, γ, δ to their calibrated values in the config struct, ship". The acceptance checklist (§14) includes a guard test that asserts this property holds before v1 lands.

### 15.1 Inputs added at v2

**1. Slippage (β).** Observed locked-window actuals vs plan. `slippageTerm(w) = slippage.byWeeklyId[w.id] / maxMissed`, normalised to `[0, 1]` across the slide's window. The semantic intent: a locked week with un-done daily tasks pulls the *unlocked* tail's weight up — catch-up pressure lands on the next several weeks, not the missed (and now locked-in-past) week. v1 already computes and persists `SlippageReport` rows; v2 just lets β > 0 propagate them into the logit.

Calibration. v2's β should be paired with the **slippage cap** sub-question from OQ-1: a hard `slippageTerm ≤ cap` clamp prevents the pathological "user skips a whole week → catch-up term dominates the entire remaining plan" failure mode. The cap value and β value are calibrated together against the marathon trace and the first three production slides. Inspection-guess starting point: `β = 1.5`, `cap = 0.5`, refined by the calibration round.

**2. P5 signal pressure (γ).** Per-goal decayed sum over open alerts, tanh-squashed into `[0, 1]`. `signalTerm(w) = signalPressure.pressure` — global per goal, so all unlocked weeklies under a goal share the same γ contribution. The semantic intent: a goal with strong signal pressure (P5 alerts firing) gets its unlocked tail pulled toward "act sooner" uniformly; weeklies' relative ordering within the goal is preserved.

The 7-day half-life is already baked into `signal-pressure.ts` at v1 (the `halfLifeDays: 7` parameter passed at §10 step 5). v1 just doesn't read the output for the logit. v2 inspection-guess: `γ = 0.8`, modest because alert impactScores are already above P5's `0.75` threshold — the gating is upstream, so γ should be a nudge not a hammer.

**3. Queued user-edit priority bumps (δ).** v1 consumes priority-bump magnitudes through trickle-down (§7.3) — sibling renormalisation within a monthly. v2 *additionally* folds the bump's `deltaWeight` into the unlocked-tail softmax: `userEditTerm(w) = sum over priority-bump edits whose target subtree contains w of edit.deltaWeight`. The semantic distinction: v1 says "this weekly matters more than its siblings"; v2 says "this weekly matters more than its siblings *and* more than weeklies under other monthlies too".

Inspection-guess: `δ = 1.0`. User edits express explicit intent; once the calibration round shows they don't fight slippage and signals destructively, they should be carried at full strength.

### 15.2 v2 timing

v2 lands **after the first three production slides** have run end-to-end against the marathon goal (per §10.4) and at least one second goal of a different shape (canonical graph §1). The gate is the same gate as OQ-1: all four coefficient questions (τ, β + slippage cap, γ, δ) need live data, and the marathon trace is the seed for the calibration round.

Concretely: v1 ships → marathon goal runs for three slides → second goal added and runs for three slides → calibration round fits coefficients → v2 ships as a config-only diff. Expected gap: days, not weeks, contingent on the live runs producing usable signal.

### 15.3 Migration path (v1 → v2 is dial-up)

The migration is enforced structurally, not merely promised:

1. **All four coefficients live in the v1 config struct.** `ReweightInputs` (§7.1) carries `signalPressure`, `slippage`, and `userEdits` at v1 even though three of the four coefficients are zero. The struct shape does not change between v1 and v2.
2. **The four-input score formula ships at v1.** §7.2's `score(w) = α*decay + β*slippage + γ*signal + δ*userEdit` is the v1 code path. v1 just runs it with three zeros.
3. **v1 includes a guard test** (§14 acceptance checklist) that asserts changing slippage / signal-pressure / `deltaWeight` inputs does **not** change the v1 softmax output. This is the structural enforcement: if anyone ever folds `β = 0` into a "skip the slippage computation entirely" optimisation, the test fails and they fix the optimisation, not the test.
4. **v2 is a single-file config diff** — the coefficient table in §7.2, swapping the three zeros for calibrated values, plus adding the slippage cap constant. No new code paths, no new types, no new tests beyond the calibration assertions.

This is the discipline that makes "imminent v2" a defensible v1 cut rather than a deferral excuse. If a future change to v1 makes the coefficient-flip migration impossible, that change is wrong and the spec is the evidence.

### 15.4 Adjacent v2 items (not coefficient flips)

Two further v1 deferrals land in the same "imminent v2" envelope, but they are *not* coefficient flips — they need code:

- **Web-fetch concretization.** v1 concretization is prose-only (§8); v2 adds an allow-listed HTTP fetch stage that dereferences vendor/tutorial URLs the LLM emits, gated on the marathon live run actually demonstrating prose-only is the bottleneck. This shares P5's threat-model posture for outbound HTTP and should reuse whatever allow-list primitive lands there.
- **The slippage cap constant.** Strictly a config addition rather than a coefficient flip — but it is calibrated jointly with β (§15.1) and ships with v2, not separately.

Both are noted here so the v2 milestone is one coherent shipment rather than three trickling fixes. Background slide scheduling (OQ-3) and the locked-row carry-forward storage rework (OQ-6) are NOT in the v2 envelope — they remain open questions for later product rounds.
