# Spacato — P2 Decomposition Design Spec

> Date: 2026-05-28 · Status: **drafted via brainstorming** · Repo: github.com/DanielJGrayshon/Spacato
> Parent docs: `docs/canonical-project-graph.md` (§1, §3), HANDOFF.md §5 step 2.
> Agents building this adopt the canonical role prompt (see HANDOFF.md §0).

> Note: a prior, never-approved P2 spec sat at this path; it was overwritten on 2026-05-28 after a
> fresh brainstorm reset every structural choice (persistence shape, versioning, daily-leaf shape,
> failure handling, cache behaviour, resolution gradient). Git history retains the prior text.

---

## 1. Overview & scope

Decompose a Goal whose `convergedSpec` was produced by S0 into a **versioned, three-layer plan tree** persisted to SQLite: monthly objectives → weekly objectives → daily tasks (each daily task carrying `estimatedMinutes`). Composable per-layer operators each do **one LLM call per parent** and are independently testable; `/api/decompose` composes them end-to-end. Every call to `/api/decompose` creates a new `decomposition` row; `goal.activeDecompositionId` flips on commit. Old decompositions persist for diff/history (P6) without affecting the live plan.

**Resolution gradient.** P2 emits a **coarse-but-actionable** tree across the full horizon — "long run, 16 miles, with hydration plan" rather than "buy [brand] gels from [URL] following [tutorial]". Progressive concretization toward *the exact* (brand names, vendor URLs, tutorial links, vendor-specific instructions) is **P3's responsibility** and fires as a daily task enters the locked 2-week sliding-window. P2's job is structural completeness and actionability-at-a-glance; P3 owns horizon-aware enrichment. The `daily_task.concretization_level` column (`'coarse' | 'concrete'`) is the forward-compat seam — P2 ships `'coarse'` everywhere, P3 will later flip individual tasks to `'concrete'` after enriching them.

**In scope**
- A `decomposition` table + `decomposition_id` on every plan-node row; an additive `goal.active_decomposition_id` column (with defensive `ALTER TABLE` because `IF NOT EXISTS` on a `CREATE TABLE` does not retrofit columns — same gotcha as `vectors_json` and `genome_id`).
- `monthly`, `weekly`, `daily_task` tables with repos following the established `goals`/`signals`/`alerts` style.
- `src/lib/util/calendar.ts` — pure heuristic `buildSkeleton(timeframe, today)` that emits month/week/date spans. Weeks clip on month boundaries.
- `src/lib/p2/operators.ts` — three async functions: `decomposeGoalToMonthly`, `decomposeMonthlyToWeekly`, `decomposeWeeklyToDaily`. Each does one `gw.complete({ schema, bypassCache: true })` call producing a `{ items: [...] }` array of the exact length the calendar skeleton demands. Prompts ship explicit JSON-object shape examples and enumerated-constraint sentences per HANDOFF §6 / §9 risk 1.
- `src/lib/p2/decompose-handler.ts` — the orchestrator: renders the shared goal-context string **once**, runs the three layers via `Promise.all` over siblings (matching the P5 pattern; not `batchComplete`), persists the whole tree in a single `db.transaction`, then flips `activeDecompositionId`. Any layer failure rolls back; no partial trees ever land.
- `src/lib/p2/retry.ts` — `withRetry(fn, { attempts: 3, isTransient })` with `250ms × 2^n` backoff. Used by every operator call.
- `bypassCache?: boolean` extension on `LlmRequest<T>` so each new decomposition version is genuinely fresh (otherwise identical prompts hash to identical trees and "versioning" becomes a no-op).
- `/api/decompose` route: `POST { goalId }` → 400 on bad timeframe, 404 on unconverged goal, 503 on terminal LLM failure with the failed-subtree label, 200 on success with the new `decompositionId` and the tree.

**Out of scope** (deferred — see §10)
- P3's sliding-window re-planner (lock + reweight + trickle-down). P3 will call P2's per-layer operators directly for partial redecomp; the interface contract is fixed here but P3 is its own spec.
- P3's **horizon-aware concretization** of near-window daily tasks. P2 ships `concretization_level = 'coarse'`; P3 owns the upgrade to `'concrete'`. Web fetches, brand lookups, and tutorial-link enrichment all live in P3.
- P4's daily timetable / preset packing. P2 emits `estimatedMinutes`; P4 owns time-block assignment.
- P6 UI surface for displaying or diffing decompositions.
- Schema migration framework (same v1 stance as P5 OQ-4 / semantic-distance OQ-3: wipe-and-reinit during dev; defensive `ALTER TABLE` for additive columns).
- Inactive-decomposition pruning.
- Length-mismatch smart retry (inject previous bad response as a hint).

---

## 2. Goals & non-goals

**Goals**
- `/api/decompose` produces a complete, structurally valid, versioned plan tree for any converged goal in a single round-trip. Verified by an integration test that drives the handler with a stub gateway and asserts the right number of rows in each table, the right FK links, and `goal.activeDecompositionId` flipped.
- Operators stay **pure** (`(prerendered context strings, calendar slice) → children[]`, no DB, no transaction, no embedding). The orchestrator owns all side effects.
- LLM failures never produce a half-tree. Either the whole decomposition commits or none of it does. Verified by a rollback test.
- The cost of one full 6-month decomposition is bounded and predictable: ~35 calls, ~$0.013 at `gpt-4o-mini` rates, ≤ 60 s wall-clock.
- All LLM I/O routes through `llm-gateway`, with cache-bypass scoped narrowly to P2 operators so S0 / P5 / tests retain full caching.

**Non-goals**
- Inferring `estimatedMinutes` from anything other than the LLM's per-task judgment (no historical-data heuristic at v1).
- Web fetches, brand lookups, vendor pricing, or tutorial-link enrichment. All deferred to P3's concretization step.
- A general-purpose migration framework. The `ALTER TABLE` for `active_decomposition_id` is one-shot defensive.
- Streaming partial results to the client. `/api/decompose` is request/response.
- Cross-goal task deduplication (e.g. detecting that two goals both want "long run on Saturday"). P3's job if at all.

---

## 3. Architecture & data flow

```
POST /api/decompose { goalId }
        │
        ▼
  src/lib/p2/decompose-handler.ts
        │
        ├──► calendar.buildSkeleton(goal.timeframe, today)        ← pure heuristic
        │       returns: { months: MonthSpan[],
        │                  weeksByMonth: WeekSpan[][],
        │                  daysByWeek: string[][] }                  (ISO yyyy-mm-dd)
        │
        ├──► goalCtx = renderGoalContext(goal)                    ← rendered ONCE
        │
        ├──► layer1: monthlyInits = await withRetry(() =>
        │              ops.decomposeGoalToMonthly(goalCtx, months))      1 LLM call
        │
        ├──► layer2: weeklyInitsByMonth = await Promise.all(
        │              months.map((m, i) =>
        │                withRetry(() => ops.decomposeMonthlyToWeekly(
        │                  goalCtx,
        │                  renderMonthlyContext(monthlyInits[i], m),
        │                  weeksByMonth[i]))))                          6 LLM calls (∥)
        │
        ├──► layer3: dailyInitsByWeek = await Promise.all(
        │              flatWeeks.map((w, j) =>
        │                withRetry(() => ops.decomposeWeeklyToDaily(
        │                  goalCtx,
        │                  w.parentMonthlyCtx,
        │                  w.weeklyCtx,
        │                  w.dates))))                                 ~28 LLM calls (∥)
        │
        ▼
  inside ONE db.transaction:
    decompositionId = decompositions.create({ goalId })
    monthlyRows  = stamp(monthlyInits, calendar, decompositionId, weights=1/N)
    monthlies.bulkInsert(monthlyRows) -> ids
    weeklyRows   = stamp(weeklyInitsByMonth, calendar, ids, decompositionId, weights=1/M)
    weeklies.bulkInsert(weeklyRows) -> ids
    dailyRows    = stamp(dailyInitsByWeek, calendar, ids, decompositionId, level='coarse')
    dailyTasks.bulkInsert(dailyRows)
    goals.setActiveDecomposition(goalId, decompositionId)
        │
        ▼
  200 { decompositionId, tree }
```

**Topology.** Per-parent LLM calls, sibling-parallel via `Promise.all`. Matches the established P5 precedent (HANDOFF §6: *"P5 genome operators use per-genome `gw.complete()` calls. Concurrency comes from `esc-core.evolve` running each phase via `Promise.all` — not from `batchComplete`. Cleaner operator contract."*). Total ~35 calls for a 6-month plan in 3 waves (1 monthly + 6 weekly + ~28 daily). The existing `gw.maxConcurrency` worker-pool governs actual parallelism — default ≈8 means layer 3 runs in ~4 concurrent sub-waves of ~8.

**Heuristic / LLM split** (heuristics-first per role prompt).
- *Heuristic:* calendar skeleton, week clipping, weight normalisation (`1/N` per parent), retry counting, transaction boundary, bulk insert, active-pointer flip, FK stamping, `concretization_level` defaulting.
- *LLM:* semantic generation of objectives at each layer (title, description, daily `estimatedMinutes`).

**Versioning semantics.** A `decomposition` is a discrete *re-decomposition event* — created on each `/api/decompose` call, write-once for its tree nodes at creation time. P3's later mutations (weight updates, partial redecomp via `decomposeWeeklyToDaily(weeklyId)`, concretization upgrades) happen *inside* the active decomposition's nodes. Cross-version comparison stays meaningful at re-decomposition boundaries.

**Orchestrator owns the lifecycle.** Operators stay pure. The orchestrator is the only module that touches `db`, `withRetry`, and the calendar.

---

## 4. Components & file surface

| File | Change | Responsibility |
|---|---|---|
| `src/lib/util/calendar.ts` | **create** | `buildSkeleton(timeframe, today): CalendarSkeleton`. Parses `"6 months"` / `"by 2026-12-15"` / ISO duration; emits `MonthSpan[]`, `WeekSpan[][]`, `Date[][]` (ISO strings). Week-spans clip on month boundaries (no week straddles two monthlies; clipped 3-day weeks are valid). Pure heuristic; deterministic; no LLM. |
| `src/lib/llm/gateway.ts` | modify (small) | Add `bypassCache?: boolean` to `LlmRequest<T>`. When `true`: skip cache read AND skip cache write. Default `false` — preserves existing behaviour for S0, P5, and all current tests. Only P2 operators set it. |
| `src/lib/store/schema.sql` | modify | Add the four tables + indices below. Add `active_decomposition_id` to fresh-DB `CREATE TABLE goal`. Existing DBs get the column via a defensive `ALTER TABLE goal ADD COLUMN active_decomposition_id INTEGER REFERENCES decomposition(id)` wrapped in a try/catch for "duplicate column name". |
| `src/lib/store/types.ts` | modify | Export `Decomposition`, `Monthly`, `Weekly`, `DailyTask`. Extend `Goal` with `activeDecompositionId: number \| null`. |
| `src/lib/store/repositories.ts` | modify | Add `decompositions{create, getById, listForGoal}`, `monthlies{bulkInsert, listForDecomposition}`, `weeklies{bulkInsert, listForMonthly}`, `dailyTasks{bulkInsert, listForWeekly, listInDateRange}`. Extend `goals` with `setActiveDecomposition(goalId, decompositionId)`. All `bulkInsert`s use a prepared statement + `db.transaction(rows => …)`. |
| `src/lib/p2/types.ts` | **create** | `MonthlyInit`, `WeeklyInit`, `DailyTaskInit` zod schemas + inferred TS types. Each is the LLM's output shape *pre-persistence* (no `id`, no `decomposition_id`, no FK to parent). |
| `src/lib/p2/operators.ts` | **create** | `makeOperators(gw, model): P2Operators`. Three async functions; each one `gw.complete({ schema, bypassCache: true, … })` call. Prompts ship explicit JSON-object example + enumerated-constraint sentence. Pure — no DB, no transaction, no calendar logic. |
| `src/lib/p2/decompose-handler.ts` | **create** | `handleDecompose({ goalId }, deps): Promise<{ decompositionId, tree }>`. Renders shared goal-context string once; runs three layers via `Promise.all` over siblings; wraps each operator call in `withRetry`; single `db.transaction` persists everything + flips active pointer; rollback on any failure. |
| `src/lib/p2/retry.ts` | **create** | `withRetry<T>(fn: () => Promise<T>, opts?: { attempts?: number, isTransient?: (err) => boolean }): Promise<T>`. Reusable; default `attempts = 3`, default `isTransient` matches 5xx / network reset / `SyntaxError` (JSON parse) / `ZodError`. Exponential backoff `250ms × 2^n`. |
| `src/app/api/decompose/route.ts` | **create** | `POST` reads `P2_DECOMPOSE_MODEL` env (default `openai/gpt-4o-mini`); wraps `handleDecompose`. 400 unparseable timeframe; 404 unconverged goal; 503 terminal LLM failure with attribution; 200 success. |

**Efficiency choices baked in.**
- The shared goal-context string is rendered **once** by the orchestrator and passed by value into each operator. Saves CPU at the layer-3 fan-out, and lines up identical prefix bytes across the ~24 layer-3 calls so any provider-side prefix caching (Anthropic does this, OpenAI for ≥ 1024-token prefixes) lights up automatically.
- `Promise.all` over the ~24 layer-3 calls honours `gw.maxConcurrency` — already configurable in `makeGateway`. No new concurrency knob.
- `bulkInsert` per layer = one prepared statement, one transaction. ~200-row decomposition lands in a single transaction; no N round-trips to SQLite.
- Indices are minimal and FK-aligned (§5); the only composite is `daily_task(decomposition_id, date)` for P3's locked-window query.
- Cache bypass is opt-in per request via `bypassCache: true`; rest of the gateway's caching is untouched.

---

## 5. Data model

### 5.1 Schema

```sql
CREATE TABLE IF NOT EXISTS decomposition (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id          INTEGER NOT NULL REFERENCES goal(id),
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS monthly (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  decomposition_id INTEGER NOT NULL REFERENCES decomposition(id),
  month_index      INTEGER NOT NULL,         -- 0..N-1 within decomposition
  start_date       TEXT    NOT NULL,         -- ISO yyyy-mm-dd
  end_date         TEXT    NOT NULL,
  objective        TEXT    NOT NULL,         -- LLM
  description      TEXT    NOT NULL,         -- LLM
  weight           REAL    NOT NULL,         -- initial 1/N; P3-mutable
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
  date                 TEXT    NOT NULL,        -- ISO yyyy-mm-dd
  title                TEXT    NOT NULL,
  description          TEXT    NOT NULL,
  estimated_minutes    INTEGER NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending', -- P3/P4 own
  concretization_level TEXT    NOT NULL DEFAULT 'coarse'   -- P3-mutable: 'coarse' | 'concrete'
);

-- Fresh-DB CREATE TABLE goal includes active_decomposition_id.
-- Existing DBs picked up via a one-shot defensive ALTER in schema init:
--   try ALTER TABLE goal ADD COLUMN active_decomposition_id INTEGER REFERENCES decomposition(id);
--   catch "duplicate column name" -> ignore.

CREATE INDEX IF NOT EXISTS idx_monthly_decomp     ON monthly(decomposition_id);
CREATE INDEX IF NOT EXISTS idx_weekly_monthly     ON weekly(monthly_id);
CREATE INDEX IF NOT EXISTS idx_daily_weekly       ON daily_task(weekly_id);
CREATE INDEX IF NOT EXISTS idx_daily_decomp_date  ON daily_task(decomposition_id, date);
```

Typical 6-month plan: 1 + 6 + ~28 + 184 ≈ **220 rows** total (1 decomposition, 6 monthlies, ~28 weeklies, 184 daily tasks — one per date in the May-28-to-Nov-28 inclusive span). Trivial in SQLite. P3's "give me all daily tasks in the locked 2-week window for this goal" → `WHERE decomposition_id = ? AND date BETWEEN ? AND ?` → composite-index hit.

### 5.2 TypeScript types

```ts
// src/lib/store/types.ts (additions)
export interface Decomposition { id: number; goalId: number; createdAt: number; }

export interface Monthly {
  id: number; decompositionId: number;
  monthIndex: number; startDate: string; endDate: string;
  objective: string; description: string;
  weight: number; progress: number;
}

export interface Weekly {
  id: number; decompositionId: number; monthlyId: number;
  weekIndex: number; startDate: string; endDate: string;
  objective: string; description: string;
  weight: number; progress: number;
}

export interface DailyTask {
  id: number; decompositionId: number; weeklyId: number;
  date: string;
  title: string; description: string;
  estimatedMinutes: number;
  status: "pending" | "done" | "skipped";
  concretizationLevel: "coarse" | "concrete";
}

// Extension to existing Goal
export interface Goal {
  // ...existing
  activeDecompositionId: number | null;
}
```

### 5.3 LLM output shapes (pre-persistence)

```ts
// src/lib/p2/types.ts
export const monthlyInitSchema = z.object({
  objective:   z.string().min(1).max(120),
  description: z.string().min(1).max(400),
});

export const weeklyInitSchema = monthlyInitSchema;

export const dailyTaskInitSchema = z.object({
  title:            z.string().min(1).max(120),
  description:      z.string().min(1).max(400),
  estimatedMinutes: z.number().int().positive().max(480), // 8h sanity cap
});

const wrapItems = <T extends z.ZodTypeAny>(s: T) => z.object({ items: z.array(s) });
export const monthlyArraySchema = wrapItems(monthlyInitSchema);
export const weeklyArraySchema  = wrapItems(weeklyInitSchema);
export const dailyArraySchema   = wrapItems(dailyTaskInitSchema);
```

The `wrapItems` boilerplate is the lesson from §9 risk 1 (HANDOFF): LLMs returning bare top-level arrays trip Zod when the schema wants `{ candidates: [...] }`. P2 standardises on `{ items: [...] }` and the prompts spell it out.

---

## 6. Heuristics & signatures

### 6.1 Calendar skeleton

```ts
// src/lib/util/calendar.ts
export interface MonthSpan { monthIndex: number; startDate: string; endDate: string; }
export interface WeekSpan  { weekIndex: number;  startDate: string; endDate: string; }

export interface CalendarSkeleton {
  months: MonthSpan[];
  weeksByMonth: WeekSpan[][];   // weeksByMonth[i] = weeks within months[i]
  daysByWeek:   string[][];     // flattened in week-traversal order; ISO yyyy-mm-dd
}

export function buildSkeleton(
  timeframe: string,
  today: string,                // ISO yyyy-mm-dd
): CalendarSkeleton;
```

Algorithm.
1. Parse `timeframe`. Accepted forms:
   - `"N months"` (n ∈ ℕ, 1 ≤ n ≤ 36) → `numMonths = N`; `end = today + N calendar months`.
   - `"N weeks"` (n ∈ ℕ, 1 ≤ n ≤ 156) → `end = today + 7N days`; `numMonths = max(1, ceil(N / 4))`.
   - `"by YYYY-MM-DD"` → `end = that date`; `numMonths = max(1, calendarMonthsBetween(today, end))`.
   - Anything else → throws with `"unparseable timeframe: <input>"`.
2. Month spans are **rolling** (not calendar-month-boundary-aligned). For `i in 0..numMonths-1`: `span[i].startDate = today + i calendar months`; `span[i].endDate = min(today + (i+1) calendar months − 1 day, end)`. The last span's `endDate` is clamped to `end`. This gives exactly `numMonths` spans of ~30 days each — matching the user's mental model of "N months from now" rather than producing a sliver-month-at-start artefact.
3. Within each month span: 7-day week spans starting from the span's `startDate`. The final week of a span clips at the span's `endDate` (may be 1–6 days). No week straddles two month-spans. A 30-day span produces 4 full weeks + 1 clipped 2-day week (5 weekly nodes); a 31-day span produces 4 full + 1 clipped 3-day (5 weekly nodes); etc.
4. Within each week span: `daysByWeek[w] = [startDate, …, endDate]` as ISO strings, inclusive.

Worked example for `buildSkeleton("6 months", "2026-05-28")`:
- `numMonths = 6`, `end = 2026-11-28`.
- Spans: `[05-28→06-27, 06-28→07-27, 07-28→08-27, 08-28→09-27, 09-28→10-27, 10-28→11-28]` — 6 spans, each ~30–31 days.
- Weeks per span: 5 (4 full + 1 clipped). Total ~28–30 weeks (varies slightly with month length).
- Total dates: 184 (May 28 through Nov 28 inclusive).

### 6.2 Length assertion

```ts
// src/lib/p2/operators.ts
function assertLength<T>(items: T[], expected: number, label: string): T[] {
  if (items.length !== expected) {
    throw new Error(
      `p2: ${label} returned ${items.length} items, expected ${expected}`,
    );
  }
  return items;
}
```

Thrown errors flow through `withRetry`'s default `isTransient` predicate (any `Error` whose message starts with `"p2: "` is transient — the LLM emitted wrong-length output and a re-draw may succeed).

### 6.3 Retry primitive

```ts
// src/lib/p2/retry.ts
export interface RetryOpts {
  attempts?: number;                                 // default 3
  isTransient?: (err: unknown) => boolean;           // default: 5xx/network/JSON/Zod/p2-length
  baseDelayMs?: number;                              // default 250
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T>;
```

Behaviour: try `fn`; on transient error sleep `baseDelayMs × 2^n` and retry; on non-transient error rethrow immediately; after `attempts` failures rethrow the last error wrapped with `"p2: retry exhausted after N attempts: …"`.

### 6.4 Weight initialisation

Heuristic, no LLM:
- `monthly.weight = 1 / months.length` for every monthly in this decomposition.
- `weekly.weight  = 1 / weeksByMonth[i].length` for every weekly under monthly `i`.
- `daily_task` has no weight (duration `estimated_minutes` is the only quantitative field; weight emerges from duration when P4 packs).

---

## 7. LLM operator contracts

```ts
// src/lib/p2/operators.ts
export interface P2Operators {
  decomposeGoalToMonthly(
    goalCtx: string,
    months: MonthSpan[],
  ): Promise<z.infer<typeof monthlyInitSchema>[]>;

  decomposeMonthlyToWeekly(
    goalCtx: string,
    monthlyCtx: string,
    weeks: WeekSpan[],
  ): Promise<z.infer<typeof weeklyInitSchema>[]>;

  decomposeWeeklyToDaily(
    goalCtx: string,
    monthlyCtx: string,
    weeklyCtx: string,
    dates: string[],
  ): Promise<z.infer<typeof dailyTaskInitSchema>[]>;
}

export function makeOperators(gw: Gateway, model: string): P2Operators;
```

### 7.1 Prompt for `decomposeGoalToMonthly`

```
SYSTEM
You are a decomposition planner. Given a converged goal and N month spans, produce exactly N monthly objectives (one per span, in chronological order). Output a JSON object with shape {"items":[{"objective":"...","description":"..."}, ...]}. "objective" MUST be a short title (≤120 chars). "description" MUST be 1–3 sentences explaining what success looks like at the end of this month. Do NOT include weights, dates, brand names, or vendor URLs — those are computed deterministically or added by a later concretization step.

USER (rendered once by orchestrator)
GOAL CONTEXT
============
Scope: complete marathon training program
Success metric: successfully follow the training plan
Constraints: dedicated training sessions without injury
Motivation: build endurance and stamina
Deadline shape: progress tracked over 6-month training period
Timeframe: 6 months starting 2026-05-28

MONTH SPANS (produce exactly 6 items, in this order)
====================================================
1. 2026-05-28 → 2026-06-27 (month 1 of 6)
2. 2026-06-28 → 2026-07-27 (month 2 of 6)
3. 2026-07-28 → 2026-08-27 (month 3 of 6)
4. 2026-08-28 → 2026-09-27 (month 4 of 6)
5. 2026-09-28 → 2026-10-27 (month 5 of 6)
6. 2026-10-28 → 2026-11-28 (month 6 of 6)

EXAMPLE OUTPUT (shape only; content fictional)
{
  "items": [
    {"objective": "Build aerobic base", "description": "Establish a consistent 4-day-per-week running rhythm with the longest session reaching 90 minutes. Avoid injury via gradual mileage increases."}
  ]
}
```

### 7.2 Prompt for `decomposeMonthlyToWeekly`

Identical structure, scaled context: receives `goalCtx` (verbatim) + `monthlyCtx` (the monthly's objective + description + span dates) + the week spans. Produces `{"items": [{"objective": "...", "description": "..."}, …]}` with exactly `weeks.length` items.

### 7.3 Prompt for `decomposeWeeklyToDaily`

Receives `goalCtx` + `monthlyCtx` + `weeklyCtx` + the dates array. Produces `{"items": [{"title": "...", "description": "...", "estimatedMinutes": N}, …]}` with exactly `dates.length` items, in chronological order.

**Coarse-but-actionable framing** is in the system prompt:

```
This daily task is going to be planned around by a calendar packer (P4). Be specific enough to schedule and prepare for — name the activity, the rough form, and the resources someone would already have — but DO NOT include brand-specific recommendations, vendor URLs, tutorial links, or store-specific instructions. Those are added by a later concretization step. Title ≤120 chars; description 1–3 sentences; estimatedMinutes is a realistic single-session duration (typically 15–120, never more than 480).
```

`estimatedMinutes` is the only LLM-produced quantitative field. Sanity cap 480 minutes (8 h) is enforced by the zod schema; the prompt mentions the typical range without forcing it.

### 7.4 Per-call request shape

```ts
const req: LlmRequest<typeof monthlyArraySchema> = {
  model,
  bypassCache: true,
  schema: monthlyArraySchema,
  messages: [
    { role: "system", content: SYSTEM_MONTHLY },
    { role: "user",   content: renderMonthlyPrompt(goalCtx, months) },
  ],
};
const { items } = await gw.complete(req);
return assertLength(items, months.length, "decomposeGoalToMonthly");
```

`bypassCache: true` is set on **every** P2 operator call. The cache is bypassed in both directions (no read, no write) so versioning produces genuinely fresh trees and retries always hit the provider — no cached half-results.

---

## 8. Decomposition lifecycle

The orchestrator (`handleDecompose`) owns every side effect.

```
handleDecompose({ goalId }, { repos, ops, calendar, today }):
  1. goal = repos.goals.get(goalId)
     if (!goal || !goal.convergedSpec) -> 404 attributable

  2. skeleton = calendar.buildSkeleton(goal.timeframe, today)
     if buildSkeleton throws -> 400 attributable

  3. goalCtx = renderGoalContext(goal)                          // once

  4. monthlyInits = await withRetry(() =>
       ops.decomposeGoalToMonthly(goalCtx, skeleton.months))

  5. weeklyInitsByMonth = await Promise.all(
       skeleton.months.map((m, i) =>
         withRetry(() => ops.decomposeMonthlyToWeekly(
           goalCtx,
           renderMonthlyContext(monthlyInits[i], m),
           skeleton.weeksByMonth[i]))))

  6. // flatten weeks across months, pre-binding parent refs and rendered contexts.
     // Each entry is self-contained: { weeklyInit, weekSpan, dates, parentMonthlyCtx, weeklyCtx }.
     const flatWeeks = flattenWeeksWithParents(skeleton, monthlyInits, weeklyInitsByMonth);

     dailyInitsByWeek = await Promise.all(
       flatWeeks.map((w) =>
         withRetry(() => ops.decomposeWeeklyToDaily(
           goalCtx,
           w.parentMonthlyCtx,
           w.weeklyCtx,
           w.dates))))

  7. db.transaction(() => {
       const decompositionId = repos.decompositions.create({ goalId });

       const monthlyRows = monthlyInits.map((m, i) => stampMonthly(
         m, skeleton.months[i], decompositionId, 1 / monthlyInits.length));
       const monthlyIds = repos.monthlies.bulkInsert(monthlyRows);

       const weeklyRows = flatten(weeklyInitsByMonth).map((w, j) => stampWeekly(
         w, j, monthlyIds, skeleton, decompositionId));
       const weeklyIds  = repos.weeklies.bulkInsert(weeklyRows);

       const dailyRows = flatten(dailyInitsByWeek).map((d, j) => stampDaily(
         d, j, weeklyIds, skeleton, decompositionId, /* concretization_level: */ 'coarse'));
       repos.dailyTasks.bulkInsert(dailyRows);

       repos.goals.setActiveDecomposition(goalId, decompositionId);
     });

  8. return { decompositionId, tree }
```

**Atomicity.** Layers 4–6 happen **outside** the transaction (they're long-running and may sleep on backoff; holding a SQLite transaction across them would deadlock against other readers in `next dev`). Step 7 opens the transaction *after* every LLM call has returned successfully, then commits or rolls back atomically. The `setActiveDecomposition` call is inside the transaction so a constraint failure on it rolls back the whole new tree.

**No partial state ever lands.** If layer 6's `Promise.all` rejects (any one operator call exhausted retries), control never enters the transaction. The previous `activeDecompositionId` and its tree are unchanged.

---

## 9. Error handling & retry

| Failure | Behaviour |
|---|---|
| `gw.complete` throws (network reset, 5xx, timeout) | `withRetry` retries up to **3 total attempts**, backoff `250ms × 2^n`. After exhaustion, the layer's `Promise.all` rejects with `"p2: retry exhausted after 3 attempts: <original>"`. |
| Zod schema validation fails (missing field, wrong type) | Transient — same retry path. Low-temp models often emit valid shape on a redraw. |
| `assertLength` mismatch (e.g. 5 monthlies for 6 spans) | Transient — same retry path. Blind retry at v1; "previous response had K, produce exactly J" hint is OQ-1. |
| One subtree exhausts retries | Whole decomposition fails. Handler returns **503** with attribution naming the subtree (e.g. `"weekly→daily for monthly#3 week#2"`). No partial tree persisted — the transaction is never entered. |
| `calendar.buildSkeleton` throws (unparseable timeframe) | **400** from route, before any LLM call. Saves money. |
| Goal not converged (`convergedSpec === null`) | **404** from handler, before any LLM call. |
| `goals.setActiveDecomposition` throws inside `db.transaction` | Whole transaction rolls back; new decomposition + node rows never visible. `activeDecompositionId` stays on the previous version. |
| Client-side retry of a 503 | Produces a fresh `decompositionId` on success (versioning means re-decompose is always allowed). |
| Zero-length spans (e.g. `"0 months"`) | `calendar.buildSkeleton` throws; 400 from route. |

`isTransient` (the default predicate for `withRetry`):
- `true` for: `error.message` matching `5xx`, `ECONNRESET`/`ETIMEDOUT`/`fetch failed`, `SyntaxError` (JSON parse), `ZodError`, or `Error` whose message begins with `p2:`.
- `false` for: anything else (programming errors, type errors, etc.) — fail fast.

---

## 10. Testing strategy

All deterministic. No live OpenRouter in CI. Manual live run is §10.4.

### 10.1 Unit

| Module | Test |
|---|---|
| `util/calendar.ts` | `buildSkeleton("6 months", "2026-05-28")` → 6 month-spans, ~28 week-spans (5 weeks per span: 4 full + 1 clipped 2–3 day), 184 dates. Edge: `"by 2026-12-15"` → 6 spans ending on Dec 15. Edge: `"3 weeks"` → 1 month-span clipped to 21 days, 3 weeks (4 if `3 weeks` becomes one 21-day span), 21 dates. Edge: `"0 months"` → throws. Edge: `"invalid"` → throws with attributable message. |
| `p2/types.ts` | `monthlyInitSchema` rejects empty `objective`; `dailyTaskInitSchema` rejects `estimatedMinutes ≤ 0` and `> 480`; `wrapItems` rejects bare-array input (the §9 risk 1 lesson, codified). |
| `p2/operators.ts` (×3) | Stub gateway returns deterministic `{items:[…]}` of the right length; verify return shape; verify `bypassCache: true` set on the request; verify zod rejects a stub returning wrong-length `items` (the rejection flows through `withRetry`); verify the prompt contains an explicit JSON-object example. |
| `p2/retry.ts` | Retries 3x on transient then throws wrapped error; doesn't retry on non-transient; honours backoff (mock `setTimeout`); attempt count = 1 when first call succeeds. |

### 10.2 Store

| Test |
|---|
| `decompositions.create` + `getById` round-trip. |
| `monthlies.bulkInsert` is atomic — failing row → none persisted. |
| `goals.setActiveDecomposition` updates `goal.activeDecompositionId`. |
| `dailyTasks.listInDateRange(decompositionId, from, to)` returns the right rows and uses the composite index (verified by `EXPLAIN QUERY PLAN`). |
| Defensive `ALTER TABLE` is idempotent: schema init can run twice without error. |

### 10.3 Integration (orchestrator)

| Test |
|---|
| Stub `ops` returns fixed shape per layer; `today = "2026-05-28"`; assert **~35 LLM calls in 3 waves** (1 monthly + 6 weekly + ~28 daily, exact daily count pinned by the calendar test), tree has 6 monthlies / ~28 weeklies / 184 daily tasks, `goal.activeDecompositionId` updated to the new id. |
| Stub layer-2 `Promise.all` to reject one subtree after retries; assert handler throws `"weekly→daily for monthly#…"` (or `"monthly→weekly for monthly#…"`); assert decomposition / monthly / weekly / daily_task tables are **all empty** for this goal and the goal's `activeDecompositionId` is unchanged from the prior value (or remains null). |
| Two consecutive successful `/api/decompose` runs against the same goal → two `decomposition` rows, `goal.activeDecompositionId` ends on the **second**, both trees coexist in the node tables, and (crucially) the two trees' descriptions differ — proving `bypassCache: true` is doing its job at the gateway. |
| Cache-bypass scope: a parallel S0 elicitation against the same gateway still hits `llm_cache` normally (verified by counting cache puts during the run). |

### 10.4 Manual / live (out of CI)

After merge, run one `POST /api/decompose` for the marathon goal against real OpenRouter. Eyeball: (a) the tree is coherent end-to-end — monthly objectives ladder into weekly objectives ladder into daily tasks; (b) `estimatedMinutes` values are in the 15–120 range with the occasional rest day; (c) **no brand names, vendor URLs, or tutorial links** anywhere — confirms the coarse-but-actionable framing held; (d) cost ≈ $0.013; (e) wall-clock ≤ 60 s. Worth recording the actual tree to `docs/live-runs/2026-MM-DD-p2-marathon.md` for future spec calibrations (the way semantic-distance OQ-1 anticipated).

Expected suite delta: **+24 tests approx.**

---

## 11. Open questions / deferred

**OQ-1 — Length-mismatch smart retry.** Inject the previous bad response + `"produce exactly N items"` into the retry prompt. v1 is blind retry. Upgrade if length-mismatch is empirically common.

**OQ-2 — Per-layer model selection.** All three operators currently use `P2_DECOMPOSE_MODEL`. A future tier could use a stronger model for monthly (where high-level objective quality dominates) and a cheaper one for daily (where individual items matter less). Defer until cost or quality is a measured constraint.

**OQ-3 — Schema migration framework.** Same as P5 OQ-4 / semantic-distance OQ-3. The `active_decomposition_id` column is the third additive schema change running on the wipe-and-reinit-or-defensive-ALTER stance. Worth pulling forward before a fourth.

**OQ-4 — Provider-side prompt caching.** OpenRouter passes through to underlying providers; some (Anthropic, OpenAI for ≥ 1024-token prefixes) support prefix caching. The shared goal-context-string approach means caching would be substantial at the layer-3 fan-out (24 calls sharing a 1–2k-token prefix). v1 doesn't claim or measure this; worth instrumenting once decomposition is on the hot path.

**OQ-5 — Weight initialisation beyond uniform.** LLM-confidence-weighted or description-length-weighted priors might initialise better than `1/N`. Defer until P3 reweighting exposes a real signal.

**OQ-6 — Inactive-decomposition pruning.** Versioning preserves all old decompositions forever. At v1 scale (one user, a dozen goals over a year) that's fine; a sweep of inactive decompositions older than 90 days is a follow-up.

**OQ-7 — `daily_task.status` lifecycle.** P2 ships `'pending'`. P3 mutates to `'done'`/`'skipped'`. The values are declared here for forward-compat; the lifecycle is P3's spec.

**OQ-8 — Horizon-aware concretization (P3's territory; called out here).** As a daily task enters the locked 2-week window, P3 fires a concretization pass that enriches title/description from `'coarse'` toward `'concrete'` — brand names, vendor URLs, tutorial links, store-specific or model-specific instructions. May involve a tool/web fetch. The `concretization_level` column is the seam P2 leaves for P3 to pivot on. P3's spec will define: how the upgrade is triggered (a daily worker walking the 2-week window? a request-time check?); whether enrichment is a fresh LLM call or augments the existing description; how stale concretized entries are refreshed; whether vendor-specific instructions are cached cross-task.

**OQ-9 — Cross-goal task deduplication.** Two goals may both produce "long run on Saturday." Neither P2 nor P3 currently dedupes; P4's packer will surface the conflict at scheduling time. A future heuristic in P3 could detect and merge. Out of scope for both this spec and P3 unless it bites in practice.

---

## 12. Cost

Live `gpt-4o-mini` (input $0.15 / 1M, output $0.60 / 1M as of writing):

- **Layer 1** (1 call): goal context ~250 tokens in + ~6 × 60 tokens out ≈ 250 in / 360 out ≈ $0.00026.
- **Layer 2** (6 calls): each ~400 tokens in + ~5 × 60 tokens out ≈ 6 × (400 in / 300 out) ≈ 2.4k in / 1.8k out ≈ $0.0014.
- **Layer 3** (~28 calls): each ~600 tokens in + ~7 × 80 tokens out ≈ 28 × (600 in / 560 out) ≈ 16.8k in / 15.7k out ≈ $0.0119.

**Total per 6-month decomposition ≈ $0.013** at `gpt-4o-mini` rates. Roughly 2–3× the order of the semantic-distance spec's per-elicitation cost; still negligible per user per goal. Each `/api/decompose` call is a one-off (versioning means it isn't run often per goal); the bulk of P-stack cost remains the recurring P5 cycle.

Wall-clock target: ≤ 60 s end-to-end at the default `gw.maxConcurrency = 8` (layer 3 runs in ~4 concurrent sub-waves of ~8 calls each, each call ≈ 2–3 s).
