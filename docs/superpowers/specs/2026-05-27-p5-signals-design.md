# Spacato — P5 Signals Design Spec

> Date: 2026-05-27 · Status: **revised after peer review (2026-05-27)** · Repo: github.com/DanielJGrayshon/Spacato
> Canonical project graph: `docs/canonical-project-graph.md`
> Parent spec: `docs/superpowers/specs/2026-05-27-esc-s0-p5-design.md`
> Agents building this adopt the **canonical role prompt** (see canonical graph §4b).

---

## 1. Overview & scope

P5 is Spacato's news/signals subsystem. It runs as an async online loop on the server, pulling items
from a configured allow-list of verified external feeds (news, weather, market), scoring each item's
relevance to every active goal, and surfacing high-relevance items to the user as **alerts** in the
side news window.

**In scope for this spec**
- Feed ingestion: safe, schema-validated HTTP fetch from a fixed HTTPS allow-list.
- Per-item relevance scoring: deterministic keyword-overlap heuristic + batched LLM relevance judge.
- ESC query-genome adapter: online composable-primitive loop (using `score`, `select`, `evolve` from
  `esc-core`) that adaptively selects which queries/sources to run per goal, drifting the query set as
  goals progress and news churns.
- Alert logic: deterministic threshold test, dedup, and LLM one-line justification.
- Store repos for `external_signal` and `alert` (the two tables are already in `schema.sql`).
- A Next.js API route `/api/signals` that triggers one ingest cycle and returns fresh signals/alerts for
  a given goal.

**Out of scope**
- The web UI shell and the news side-window component (P6).
- S0 elicitation (separate module, already specced).
- Decomposition / weekly-tick / presets (P2–P4, later specs).
- Push notifications or background scheduled jobs (the first slice drives cycles from the API route;
  scheduling is a later concern).
- Multiple concurrent users, auth, and hosting.

---

## 2. Goals & non-goals

**Goals**
- A runnable loop: given a `converged_spec`, fetch relevant external items, score them, store all
  fetched items with their scores, and raise alerts when a high-scoring item directly affects the goal.
- ESC proven in its **online lifecycle** — the same `esc-core` composable primitives (`score`,
  `select`, `evolve`) used internally by S0's `runToConvergence` are called directly here, one stage
  per ingest cycle. `step()` and `runToConvergence()` are NOT used.
- Heuristics-first: expensive LLM calls are invoked only for per-item relevance judging (batched) and
  alert justification; all structural decisions are deterministic.
- OpenRouter key never in the browser bundle; all LLM calls route through `llm-gateway`.
- External sources restricted to a vetted HTTPS allow-list; every response is schema-validated before
  any data is written to SQLite.

**Non-goals**
- Real-time streaming or WebSocket push.
- Polished UX — the API route is the boundary; rendering is P6.
- Semantic embeddings from a dedicated embedding service (no such service is wired; see §10).
- Automatic source discovery or arbitrary URL fetching.

---

## 3. Architecture

### Module map

```
src/lib/p5/
  feed-ingest.ts      Pull raw items from one allowed source.           (§3.1)
  relevance.ts        Score items against a converged_spec.             (§3.2)
  genome.ts           QueryGenome type + operators (seed/cross/mutate). (§3.3)
  esc-adapter.ts      Online cycle using score/select/evolve primitives.  (§3.4)
  alert-logic.ts      Deterministic threshold, dedup, LLM justification.(§3.5)
  repositories.ts     signals repo + alerts repo (store layer).         (§3.6)

src/app/api/signals/
  route.ts            POST /api/signals — one ingest cycle per call.    (§3.7)
```

Each file has one responsibility. No file imports from another P5 file except `esc-adapter.ts` (which
imports `genome.ts`) and `route.ts` (which wires everything together).

### Data-flow diagram

```
POST /api/signals?goalId=N
  │
  ▼
esc-adapter          (1) load EscState<QueryGenome> from query_genome_state (or seed fresh)
  │                      pick top-scoring genome as the fetching genome for this cycle
  │ fetchingGenome.value.queries  (source, queryTerms) pairs
  ▼
feed-ingest          for each (source, queryTerms): fetch → schema-validate → raw FeedItem[]
  │ FeedItem[]
  ▼
relevance            score each item: keyword-overlap → LLM batchComplete<RelevanceResult> judge
  │ ScoredItem[]
  ▼
repositories         upsert into external_signal (with genome_id = fetchingGenome.value.id); return stored signals
  │ StoredSignal[]
  ▼
alert-logic          for each signal: impact ≥ ALERT_THRESHOLD? → existsOpen dedup
  │                                   → LLM batchComplete<JustificationResult> (separate call)
  │ Alert[] (new)
  ▼
repositories         insert new alert rows
  │
  ▼
esc-adapter          (2) esc-core.score(cfg, state.population) — cfg.fitness closure uses in-memory
                         ScoredItem[] for fetching genome; carries forward prior scores for others (no NaN)
                     (3) esc-core.select(cfg, population, scores) → parent genomes
                     (4) esc-core.evolve(cfg, parents) → next-generation population
                     (5) build nextState; initialise offspring scores to GENOME_PRIOR_SCORE
  │ nextState: EscState<QueryGenome>
  ▼
repositories         queryGenomeState.save(goalId, nextState)
  │
  ▼
return { signals, alerts } to client
```

### Integration with existing infrastructure

| Dependency                 | How P5 uses it                                                                                      |
|----------------------------|-----------------------------------------------------------------------------------------------------|
| `esc-core.score()`         | Evaluates fitness for the **current** population. `cfg.fitness` closure captures the `ScoredItem[]` from step 3 in memory — no DB read for current-cycle relevance. `external_signal` rows (keyed by `genome_id`) are read only for cross-cycle engagement history. |
| `esc-core.select()`        | Deterministic parent selection from the scored current population.                                  |
| `esc-core.evolve()`        | Produces next-generation offspring from the selected parents.                                       |
| `llm-gateway`              | `batchComplete<T>()` for relevance judging (one schema `T`); separate `batchComplete<T>()` for alert justification (different schema `T`); `complete()` for genome seed. |
| `store/db.ts`              | `openDb()` — same SQLite instance as S0; tables shared.                                             |
| `goal.converged_spec_json` | Deserialised into `GoalInterpretation` and passed to `relevance.ts`.                                |
| `schema.sql`               | `external_signal` + `alert` tables already present; `query_genome_state` added by this spec (§4.3).|

---

## 4. Data model — repository method signatures

P5 adds two repositories to `makeRepositories()`, following the existing pattern (standalone helpers,
no `this`, `update` throws on 0 changes).

### 4.1 `signals` repository

```ts
// Standalone helper (mirroring getGoal / getElicitation pattern)
function getSignal(db: Db, id: number): StoredSignal | undefined

// Exported via makeRepositories()
signals: {
  /** Insert a new signal row. Returns the full stored record. */
  create(input: {
    goalId: number;
    genomeId: string;       // QueryGenome.id of the fetching genome; written to genome_id column
    source: string;
    kind: "news" | "weather" | "market";
    payload: FeedItemPayload;
    relevanceScore: number;
  }): StoredSignal;

  /** Fetch all signals for a goal, newest first, optionally limited. */
  listForGoal(goalId: number, limit?: number): StoredSignal[];

  /** Update relevance_score on an existing row (e.g. after LLM judge runs). Throws if row absent. */
  updateRelevance(id: number, relevanceScore: number): void;
}
```

`StoredSignal` mirrors the DB row:

```ts
interface StoredSignal {
  id: number;
  goalId: number;
  genomeId: string;           // stable QueryGenome.id that surfaced this signal
  source: string;
  kind: "news" | "weather" | "market";
  payload: FeedItemPayload;   // parsed from payload_json
  relevanceScore: number | null;
  fetchedAt: string;          // ISO datetime string from SQLite
}
```

### 4.2 `alerts` repository

```ts
function getAlert(db: Db, id: number): Alert | undefined

alerts: {
  /** Insert a new alert row. Returns the full stored record. */
  create(input: {
    signalId: number;
    goalId: number;
    impactScore: number;
    message: string;
  }): Alert;

  /** Fetch all unacknowledged alerts for a goal, newest first. */
  listOpen(goalId: number): Alert[];

  /** Mark an alert acknowledged. Throws if row absent. */
  acknowledge(id: number): void;

  /** Returns true if an open (unacknowledged) alert already exists for this
   *  (goalId, signalId) pair — used by alert-logic.ts for dedup (§8.2). */
  existsOpen(goalId: number, signalId: number): boolean;
}
```

`Alert` mirrors the DB row:

```ts
interface Alert {
  id: number;
  signalId: number;
  goalId: number;
  impactScore: number;
  message: string;
  createdAt: string;
  acknowledged: boolean;
}
```

### 4.3 `queryGenomeState` (genome persistence)

**This is a required build deliverable of this spec.** Adding `query_genome_state` to `schema.sql`
is a named build step — it must be present before `esc-adapter.ts` is written. `external_signal` and
`alert` are already in `schema.sql`; only `query_genome_state` is new.

The ESC online state for P5 is persisted so that drift accumulates across API calls. This requires a
new table (one row per goal):

```sql
-- REQUIRED ADDITION to schema.sql as part of this spec's build
CREATE TABLE IF NOT EXISTS query_genome_state (
  goal_id     INTEGER PRIMARY KEY REFERENCES goal(id),
  state_json  TEXT    NOT NULL,   -- serialised EscState<QueryGenome>
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Required column addition to `external_signal`** (also part of this spec's build step):

```sql
-- Add to the existing external_signal table definition in schema.sql
genome_id  TEXT NOT NULL DEFAULT ''   -- stable QueryGenome.id; set at signal creation time
```

`genome_index` (positional) is **not added**. Attribution uses the stable `genome_id` string
exclusively (see §5.5). The `genome_id` column is used by: (a) `repositories.signals.create()` to
write the attribution, and (b) the engagement history query in `cfg.fitness` (§5.6) to join
`external_signal → alert` for cross-cycle engagement ratios.

`EscState<QueryGenome>` survives a `JSON.parse(JSON.stringify(state))` round-trip without loss:
`EscState<T>` contains only `population: Genome<T>[]`, `scores: number[]`, `generation: number`, and
`bestScore: number`; `Genome<T>` is `{ value: T }`; `QueryGenome` is a plain object tree (including
the `id: string` field). No class instances, no `undefined` fields, no Dates. `JSON.stringify` +
`JSON.parse` is safe.

Repository:

```ts
queryGenomeState: {
  /** Load the genome state for a goal. Returns null if no state yet (first cycle). */
  get(goalId: number): EscState<QueryGenome> | null;

  /** Upsert the genome state after each ingest cycle. */
  save(goalId: number, state: EscState<QueryGenome>): void;
}
```

---

## 5. ESC query-genome

### 5.1 Genome shape

```ts
interface QueryTerm {
  source: SourceKey;       // key into the allow-list (e.g. "newsapi", "openweather", "alphavantage")
  terms: string[];         // 1–5 keyword or phrase terms for the query
  weight: number;          // relative priority; used by fitness and selection
}

interface QueryGenome {
  id: string;              // stable identity — uuid via crypto.randomUUID() (Node built-in, no dep); minted at seed;
                           // offspring receive fresh ids at crossover/mutate; NEVER reused.
  queries: QueryTerm[];    // 2–6 entries; each is one source × term-set pairing
}
```

`QueryGenome` is a plain object tree (no class instances, no Dates, no `undefined` fields). The `id`
field is a plain string and survives the `JSON.parse(JSON.stringify())` round-trip used by
`queryGenomeState` serialisation without loss — no additional handling required.

**Assumption A1:** population size is fixed at 4 genomes per goal (small enough to keep LLM operator
cost low; large enough for meaningful selection). `EscConfig.populationSize = 4`.

### 5.2 Seed operator

The seed operator is called once, on the first ingest cycle for a goal (when `queryGenomeState.get()`
returns null). It uses `llm-gateway.complete()` with a single prompt:

```
System: You generate search-query sets for a news/signals aggregator. Reply only with JSON matching
        the schema.
User:   Goal spec: {converged_spec_json}
        Available sources: {sourceKeys and their descriptions}
        Produce {populationSize} DISTINCT query sets (2–4 queries each) that would surface news,
        weather, or market events relevant to this goal. Vary them in focus and breadth.
```

Schema: `z.object({ population: z.array(queryGenomeSchema) })`.

After the LLM response is parsed, **each genome in the seeded population is assigned a fresh stable
id** before the state is stored:

```ts
const population = parsed.population.map(g => ({ ...g, id: crypto.randomUUID() }));
```

The seed call is a single one-shot `complete()` initialisation. The genome operators (crossover,
mutate) also call `complete()` per genome rather than `batchComplete()`, but they are dispatched
**concurrently** by the parallelised `esc-core.evolve` (see §5.3/§5.4): all crossovers for the
offspring run in one `Promise.all` phase, then all mutates in the next. This yields the same
latency benefit as a batch without changing the operator contract. All calls are cached by the
gateway (same model + messages → same hash).

### 5.3 Crossover operator

Blends two parent genomes by merging their `queries` arrays and asking the LLM to prune to 2–4
coherent, non-overlapping entries:

```
User: Parent A queries: {A.queries}
      Parent B queries: {B.queries}
      Merge into a single coherent query set of 2–4 entries. Remove duplicates.
      Keep terms most likely to surface goal-relevant signals.
```

Implemented as the `crossover` operator passed to `EscConfig`; it calls `llm-gateway.complete()`.
When `evolve()` generates multiple offspring, `esc-core.evolve` runs every offspring's crossover
**concurrently** in a single `Promise.all` phase (the mutate phase follows), so the calls overlap
even though each operator is a one-genome `complete()`.

**Identity rule:** each crossover offspring receives a **freshly minted id** (`crypto.randomUUID()`), independent
of both parents' ids. The offspring is a new genome; it has no claim to either parent's engagement
history:

```ts
const offspring: QueryGenome = { id: crypto.randomUUID(), queries: parsedQueries };
```

### 5.4 Mutate operator

Perturbs one `QueryTerm` in the genome — either swapping the source, replacing one term, or
adding/removing a term:

```
User: Current genome: {genome.queries}
      Mutate exactly ONE query term (change its source, refine its terms, or add/remove one term).
      The goal spec for context: {converged_spec_json}
```

Implemented as the `mutate` operator (a one-genome `complete()` call). `esc-core.evolve` runs all
offspring mutates **concurrently** in a `Promise.all` phase that follows the crossover phase, so the
mutate calls overlap with each other (though not with crossover, since each mutate consumes its
crossover's output).

**Identity rule:** the mutant receives a **freshly minted id** (`crypto.randomUUID()`). Mutation produces a
distinct genome; it does not inherit the parent's engagement history:

```ts
const mutant: QueryGenome = { id: crypto.randomUUID(), queries: parsedQueries };
```

### 5.5 Per-genome signal attribution and empty-fetch handling

**Which genomes fetch each cycle:** only the **single top-scoring genome** (highest `state.scores[i]`)
fetches each cycle. Reason: a populationSize-4 genome set would quadruple API calls to NewsAPI /
OpenWeatherMap / Alpha Vantage on every cycle, burning free-tier quota. For a single local user,
selecting the best-known genome to fetch is the right quality/cost trade-off. All other three genomes
carry their previous scores into the fitness step (see below).

**Attribution:** every `external_signal` row created in a cycle carries a `genome_id` column (TEXT)
recording the stable id of the genome whose queries surfaced it. This is set to
`fetchingGenome.value.id` — the stable string id on the `QueryGenome` object, NOT the genome's
position in the population array. The fitness function and the engagement history query both key on
this column.

> Schema addition to `external_signal`: add `genome_id TEXT NOT NULL DEFAULT ''`. `genome_index` is
> **not added** — positional indexing is unstable across `evolve()` reorderings and is replaced
> entirely by `genome_id`. This is part of the same build step as `query_genome_state` (§4.3).

**Why `genome_id` and not `genome_index`:** after `esc-core.evolve()` the population is rebuilt as
`[parent0, parent1, offspring0, offspring1]`. A given array index therefore points to a different
genome each generation. Keying attribution on the stable `id` field eliminates this bug: a genome
carries the same id for its entire lifetime, regardless of where it sits in the population array.

**Empty-fetch handling (no NaN):** a genome that did not fetch this cycle (all genomes except the top
scorer) has no new `external_signal` rows attributed to it. Its fitness for this cycle is its
**previous score** carried forward from `state.scores[i]`. This is the score already stored in
`EscState`. The fitness function therefore only computes a new score for the fetching genome and
returns the prior scores unchanged for all others. The weighted-relevance helper is never invoked on
an empty set, and it guards `Σweight = 0` by returning 0 — no NaN.

### 5.6 Fitness function

Fitness is `relevance × engagement`, both in [0, 1]:

```
fitness(genome, idx) =
  if genome fetched this cycle:
    weightedRelevance(ScoredItem[] captured in memory from step 3 for this genome)
      = Σ(finalScore × queryWeight) / Σ(queryWeight)        (queryWeight defaults to 1)
    × engagementFactor(genome.value.id)
  else:
    state.scores[idx]   ← carry forward; genome is re-evaluated next cycle when it fetches
```

**Relevance score — read from memory, not the DB.** The `cfg.fitness` closure **captures the
`ScoredItem[]` array** returned by `relevance.ts` in step 3 of the online cycle (see §5.9). The
relevance component for the fetching genome is `weightedRelevance(scoredItems)` — the mean of
`finalScore` weighted by each item's `queryWeight` (§5.1), which reduces to a plain mean when all
weights are equal. For all
non-fetching genomes the fitness function returns `state.scores[i]` unchanged. This avoids any
time-windowed DB query for current-cycle fitness and is unambiguous even across cycles with shared
genome ids.

The `genome_id` stored on `external_signal` rows (§5.5) is used only for the **cross-cycle engagement
history** query described below — it is a longer-horizon read keyed on stable id, not a current-cycle
relevance lookup.

**Engagement factor** — for a single-user local app there is no clickstream. Engagement is captured as:

```
engagementFactor(genomeId) =
  let acked  = COUNT of alert rows with acknowledged = 1
                 WHERE signal.genome_id = genomeId
  let total  = COUNT of alert rows (all)
                 WHERE signal.genome_id = genomeId
  return (acked + 0.5) / (total + 1)   ← Laplace smoothing; prior ≈ 0.5
```

An alert that has been acknowledged (`acknowledged = 1`) signals the user found it valuable. This is a
weak signal (alerts are rare), so the Laplace-smoothed prior sits near 0.5 when no alerts exist yet,
preventing fitness from collapsing to relevance-only.

The engagement query joins `alert` → `external_signal` on `signal_id` and filters by `genome_id` —
the stable string id on `QueryGenome`, not a positional index.

**Assumption A2:** engagement history accumulates over all past cycles, not just the current one. The
fitness function queries the `alert` table for historical signal-to-acknowledgement ratios, keyed on
`genome_id`.

### 5.7 Select operator (deterministic)

Standard truncation selection: the top 2 of 4 genomes by score become parents. This is implemented as
the closure passed to `EscConfig.select`. It is ONLY called via `esc-core.select(cfg, population,
scores)` inside the ingest cycle — it is never called manually outside that context:

```ts
const selectTop = (pop: Genome<QueryGenome>[], scores: number[]): Genome<QueryGenome>[] =>
  scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.ceil(pop.length / 2))
    .map(({ i }) => pop[i]);
```

`QueryTerm.weight` reaches selection **transitively**: `selectTop` ranks purely on the `scores`
array, and those scores are the fitness values produced in §5.6, whose relevance term is now a
`weight`-weighted mean of the fetched items' `finalScore`s. `selectTop` itself takes no direct
dependency on `weight` — a higher-weighted query raises a genome's fitness, which in turn makes it
more likely to be selected.

### 5.8 Converged predicate

P5 **never converges** — the converged predicate is always `false`. It is included in `EscConfig`
because the type requires it, but it is **not called anywhere in the P5 online loop** (it is only used
by `runToConvergence`, which P5 does not call). `maxGenerations` is set to `Number.MAX_SAFE_INTEGER`
for the same reason — it exists on the config but is irrelevant. The loop terminates only when the
API route stops being called:

```ts
converged: (_state: EscState<QueryGenome>) => false,
maxGenerations: Number.MAX_SAFE_INTEGER,
```

### 5.9 Online-cycle cadence — primitive-based, NOT step()

**Critical design point:** `esc-core.step(cfg, state)` evaluates `cfg.fitness` on the
**post-evolution offspring**, not on the genomes that fetched signals in the current cycle. Using
`step()` here would mean fitness is scored on genomes that didn't exist when the data was gathered —
wrong. P5 therefore uses the composable primitives directly.

One ingest cycle per API request to `/api/signals` for a goal. The exact sequence for each cycle is:

```
1. LOAD    queryGenomeState.get(goalId)
           → EscState<QueryGenome> (or seed a fresh state if null — first cycle only)

2. PICK    topIdx = argmax(state.scores)
           fetchingGenome = state.population[topIdx]
           (first-cycle scores are all equal; topIdx = 0 by default)

3. FETCH   feed-ingest: fetchingGenome.value.queries → raw FeedItem[]
           relevance.ts: score items (§6) → ScoredItem[]   [captured in memory for step 4]
           ALL fetched items are stored — there is no score threshold on storage.
           repositories.signals.create(..., genomeId: fetchingGenome.value.id) for EVERY ScoredItem.

4. SCORE   fitnesses = await esc-core.score(cfg, state.population)
           cfg.fitness is a closure that captures the ScoredItem[] from step 3 in memory.
           For the fetching genome: fitness = weightedRelevance(scoredItems)
                                             × engagementFactor(fetchingGenome.value.id)
                  where weightedRelevance = Σ(finalScore × queryWeight) / Σ(queryWeight), default w=1
           For all other genomes i: fitness = state.scores[i]  (carry forward; no DB read)
           → number[] length = populationSize (NO NaN; see §5.5 empty-fetch handling)
           NOTE: the stored genome_id on external_signal rows is used only for cross-cycle
           engagement history (§5.6 engagement query) — NOT for current-cycle relevance lookup.

5. SELECT  parents = esc-core.select(cfg, state.population, fitnesses)
           → top 2 genomes by score (selectTop closure)

6. EVOLVE  nextPop = await esc-core.evolve(cfg, parents)
           → [...parents, ...offspring], length = 4
           offspring are NOT scored this cycle; they fetch next cycle

7. PERSIST nextState: EscState<QueryGenome> = {
             population: nextPop,
             scores: [fitnesses[parentIdx0], fitnesses[parentIdx1], GENOME_PRIOR_SCORE, GENOME_PRIOR_SCORE],
             generation: state.generation + 1,
             bestScore: Math.max(fitnesses[parentIdx0], fitnesses[parentIdx1], GENOME_PRIOR_SCORE),
           }
           NOTE: offspring slots (indices 2 and 3) are initialised to a defined floor score
           (GENOME_PRIOR_SCORE = 0.1) so they participate in argmax next cycle without NaN.
           queryGenomeState.save(goalId, nextState)

8. RETURN  { signals: StoredSignal[], alerts: Alert[] }
```

`esc-core.step()` is **not called**. `cfg.converged` is **not called**. The loop is externally driven:
one cycle per HTTP call, cadence controlled by the client.

**Assumption A3:** the API route is called at most once per minute per goal (client-side polling or
manual refresh). No debounce is implemented in P5; the caller controls cadence.

---

## 6. Per-item relevance heuristic

Relevance scoring is a **heuristic pipeline**, not evolution. It runs after feed items are fetched and
before they are written to `external_signal`.

### 6.1 Input/output

```ts
interface FeedItem {
  id: string;           // source-assigned unique identifier
  source: SourceKey;
  kind: "news" | "weather" | "market";
  title: string;
  summary: string;      // 1–3 sentence summary or description
  publishedAt: string;  // ISO datetime
  url?: string;         // present for news items
  rawPayload: unknown;  // the full validated source response object
}

interface ScoredItem {
  item: FeedItem;
  keywordScore: number;     // [0, 1] — heuristic pass
  llmScore: number | null;  // [0, 1] — LLM judge, null if item filtered out
  finalScore: number;       // used for DB write and alert logic
}
```

### 6.2 Step 1 — keyword-overlap heuristic

Extract a keyword set from `converged_spec`:

```ts
function extractKeywords(spec: GoalInterpretation): Set<string> {
  // Concatenate all five string fields, lowercase, split on whitespace + punctuation,
  // remove stop-words (a small hardcoded list ≤ 40 words), deduplicate.
  // Returns typically 10–30 tokens.
}
```

Score an item:

```ts
function keywordScore(item: FeedItem, keywords: Set<string>): number {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const tokens = tokenise(text);   // same split/stop-word logic
  const hits = tokens.filter(t => keywords.has(t)).length;
  return Math.min(hits / keywords.size, 1);
}
```

**Filter gate:** items with `keywordScore < KEYWORD_MIN_THRESHOLD` (default `0.05`, tunable in
config) **skip the LLM judge** — they are not passed to `batchComplete`. This keeps LLM cost
proportional to feed volume. **Sub-threshold items are NOT discarded from storage** — every fetched
item is stored in `external_signal` (see §5.9 step 3 and §6.4/A4). The keyword gate controls the
LLM judge path only.

**Rationale for lexical approach vs embedding:** no embedding service is wired into the stack. An
OpenRouter embedding model (e.g. `text-embedding-ada-002` via the API) would require a second model
call per item, multiplying cost and latency. For a single-user local app with short `converged_spec`
fields, BM25-style lexical overlap over the spec's five structured string fields captures intent well
enough for the pre-filter. The LLM judge in step 2 corrects false negatives at the cost of only one
batched call. See §10 OQ-2 for the open question.

### 6.3 Step 2 — LLM relevance judge (batched)

For every item that passes the keyword gate, construct a `LlmRequest`:

```
System: You are a relevance judge. Score how directly this item affects the given goal. Reply only
        with JSON matching the schema.
User:   Goal spec: {converged_spec_json}
        Item title: {item.title}
        Item summary: {item.summary}
        Item kind: {item.kind}
```

Schema: `z.object({ score: z.number().min(0).max(1), reasoning: z.string().max(120) })`.

All requests for one ingest cycle are submitted as one `batchComplete<RelevanceResult>()` call.
`batchComplete<T>` takes a single schema type `T` per call; all items within the call share one
response schema. Relevance-judge requests and alert-justification requests therefore use **two
separate** `batchComplete` calls with different `T` (which you already do — this is by design, not a
limitation). Cached by the gateway (identical items never re-judged).

**Model:** a cheap fast model (e.g. `openai/gpt-4o-mini`). The same model constant used in the
elicit route. Configurable via `P5_JUDGE_MODEL` env var.

### 6.4 Final score

```ts
finalScore = 0.3 * keywordScore + 0.7 * llmScore
```

If `llmScore` is null (item did not pass the keyword gate), `finalScore = keywordScore`. This keeps
all fetched items in the `ScoredItem[]` result set ranked, even those that didn't reach the LLM.

**Assumption A4:** items with `keywordScore < KEYWORD_MIN_THRESHOLD` are **stored** in
`external_signal` with `relevance_score = keywordScore` (no LLM call was made for them). They are
not discarded. Storing them means the ESC fitness function (§5.6) still incorporates their low scores
when computing `weightedRelevance(finalScores)` for the fetching genome, correctly penalising genome queries that
surface mostly low-relevance content. The keyword gate decides "send to LLM judge or not"; it does
NOT decide "store or not."

---

## 7. Feed allow-list & security

### 7.1 Allow-list structure

The allow-list is a TypeScript constant in `src/lib/p5/sources.ts`. It is not runtime-configurable
without a code change; no user-supplied URLs are ever used.

```ts
export type SourceKey = "newsapi" | "openweather" | "alphavantage";

export interface SourceConfig {
  key: SourceKey;
  kind: "news" | "weather" | "market";
  baseUrl: string;            // must be HTTPS; validated at startup
  description: string;        // used in LLM seed/mutate prompts
  apiKeyEnvVar: string;       // name of the env var holding the API key
  buildUrl(terms: string[], apiKey: string): string;
  responseSchema: ZodType<unknown>;  // validates the raw HTTP response
}

export const SOURCES: Record<SourceKey, SourceConfig> = {
  newsapi: {
    key: "newsapi",
    kind: "news",
    baseUrl: "https://newsapi.org",
    description: "NewsAPI — top headlines and everything search",
    apiKeyEnvVar: "NEWSAPI_KEY",
    buildUrl: (terms, key) =>
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(terms.join(" "))}&pageSize=5&apiKey=${key}`,
    responseSchema: newsApiResponseSchema,   // zod schema matching NewsAPI JSON
  },
  openweather: { ... },
  alphavantage: { ... },
};
```

**Assumption A5:** the three concrete providers are NewsAPI (news), OpenWeatherMap (weather), and
Alpha Vantage (market). These are listed as open questions (OQ-1) but concretised here as the design
baseline. Replacing a provider means updating one `SourceConfig` entry and its `responseSchema`.

### 7.2 Fetch safety

`feed-ingest.ts` enforces:

1. **URL allow-list check:** before any `fetch()` call, assert that the URL starts with the source's
   `baseUrl`. Any mismatch throws; no redirects followed (`redirect: "error"` in fetch options).
2. **HTTPS only:** `baseUrl` must begin with `https://`; validated when the module is first imported
   (startup assertion).
3. **Response schema validation:** the raw JSON is parsed with `sourceConfig.responseSchema.parse()`.
   Any validation error discards the response and logs a warning; no partial data reaches the store.
4. **Timeout:** 8 seconds per request (`AbortSignal.timeout(8000)`). A timed-out source is skipped;
   the cycle continues with other sources.
5. **API keys:** read from env vars (`process.env[apiKeyEnvVar]`). Missing keys cause a logged warning
   and that source is skipped for the cycle; they do not throw.

### 7.3 FeedItem normalisation

Each `SourceConfig.buildUrl` produces items in source-native JSON. After validation, a per-source
`normalise(raw: unknown): FeedItem[]` function converts to the canonical `FeedItem` shape. This
normaliser lives alongside the `SourceConfig` in `sources.ts` and is tested independently.

---

## 8. Alert logic

### 8.1 Impact score

An alert is raised when a signal's `finalScore` exceeds `ALERT_THRESHOLD` (default `0.75`):

```ts
const ALERT_THRESHOLD = 0.75;   // configurable constant in alert-logic.ts
```

The `impact_score` stored in the `alert` row is the signal's `finalScore`.

**Rationale for threshold placement:** `finalScore` is a weighted blend of a loose keyword signal
(30%) and a calibrated LLM score (70%). A score of 0.75 requires the LLM to rate relevance at ≥
0.96 even when the keyword score is 0 — or, more typically, a combination of moderate keyword overlap
and high LLM confidence. This is a conservative threshold; it is tunable.

### 8.2 Dedup

Before inserting an alert, check for an existing **open** alert for the same `(goal_id, signal_id)`:

```ts
// In alerts repo — used by alert-logic.ts before create()
existsOpen(goalId: number, signalId: number): boolean
```

If `existsOpen` returns true, no new alert is created. This prevents one recurring news item from
flooding the alert table across multiple ingest cycles.

Additionally, a **content-level dedup** check prevents near-duplicate items from different ingest
cycles creating multiple alerts. Before the LLM justification call, check whether any open alert for
this goal has a signal with an identical `item.id` from the same source. If so, skip.

### 8.3 LLM justification

For each signal that passes the threshold and dedup check, generate a one-line justification:

```
System: You write one-sentence impact summaries for goal planners. Reply only with JSON.
User:   Goal spec: {converged_spec_json}
        Signal: {item.title} — {item.summary}
        In one sentence (≤ 20 words), explain why this directly affects the goal.
```

Schema: `z.object({ justification: z.string().max(160) })`.

These calls are **not batched with the relevance judge** (they are rarer and happen after the
threshold filter), but multiple alerts in one cycle are batched together via
`batchComplete<JustificationResult>()`. This is a separate call from the relevance-judge
`batchComplete<RelevanceResult>()` because `batchComplete<T>` requires all items in one call to share
a single schema `T`.

The `justification` string becomes the `alert.message`.

### 8.4 Alert creation flow (complete)

```
for each StoredSignal where finalScore >= ALERT_THRESHOLD:
  if existsOpen(goalId, signal.id): skip
  if duplicateContentInOpenAlerts(goalId, signal.item.id, signal.source): skip
  llmMessage = batchJustify([...all qualifying signals...])
  alerts.create({ signalId, goalId, impactScore: finalScore, message: llmMessage })
```

The batch justify call is one `batchComplete()` invocation per cycle, not one per alert.

---

## 9. Testing strategy

### 9.1 Guiding principle

Every deterministic unit is tested with no LLM dependency. LLM-dependent paths use the gateway's
injectable `fetchFn` with pre-recorded response fixtures, identical to the S0 testing approach.

### 9.2 Unit tests (no LLM)

| File | Test focus |
|------|------------|
| `relevance.ts` | `extractKeywords` on known specs; `keywordScore` against fixture items; verify filter gate rejects low-overlap items. |
| `alert-logic.ts` | Threshold arithmetic; dedup logic against mock alert lists; no LLM calls. |
| `repositories.ts` | `signals.create/listForGoal/updateRelevance` and `alerts.create/listOpen/acknowledge` against an in-memory `:memory:` SQLite DB. |
| `sources.ts` | `buildUrl` output for each source; `normalise` for fixture raw responses from each provider. |
| `genome.ts` | Zod schema parses/rejects valid/invalid `QueryGenome` values. |
| `esc-adapter.ts` | `selectTop` closure produces the top-scoring half given known scores; fitness arithmetic with carry-forward (non-fetching genomes); GENOME_PRIOR_SCORE applied to offspring slots; no `step()` called. |

### 9.3 LLM-dependent tests (recorded responses)

**Relevance judge:** a fixture set of 20 labelled `(GoalInterpretation, FeedItem, expectedRelevance)`
triples, hand-labelled into `high` / `low` bins. Recorded gateway responses are used; the test
asserts that items labelled `high` score above 0.5 and items labelled `low` score below 0.5.

**Genome operators:** recorded responses for one seed call, two crossover calls, and two mutate calls
on a known goal spec. Tests assert the output parses as `QueryGenome` and contains the expected number
of entries.

**Alert justification:** recorded response for one alert call; test asserts `message` is ≤ 160 chars
and non-empty.

### 9.4 Integration test

One end-to-end smoke test using recorded feed responses (fixture JSON for each of the three sources)
and a recorded gateway:

1. Call the route handler (not the HTTP route — the inner async function) with a `goal_id` for a
   seeded test goal.
2. Assert: `external_signal` rows are created; at least one `alert` row is created (fixture data
   includes one item that scores above threshold); `queryGenomeState` is updated to `generation = 1`.

### 9.5 What is not tested here

- Live network calls to NewsAPI / OpenWeatherMap / Alpha Vantage (integration with real providers is
  tested manually, not in CI).
- End-to-end UI rendering (P6).

---

## 10. Open questions

**OQ-1 — Concrete provider selection (resolve at build time)**
The spec assumes NewsAPI (news), OpenWeatherMap (weather), and Alpha Vantage (market) as the three
initial providers. These are widely-used free-tier APIs with stable schemas and clear terms of service
for personal/non-commercial use. Confirm this selection before writing the Zod response schemas.
If a different provider is chosen, only the `SourceConfig` entry and its normaliser change.

**OQ-2 — Lexical heuristic vs embedding similarity (decision deferred, flagged)**
The per-item relevance pre-filter uses keyword-overlap (§6.2). This is cheaper but may miss
semantically related items that use different vocabulary (e.g. "interest rates" when the goal mentions
"mortgage"). An OpenRouter embedding model (`text-embedding-ada-002` or similar) would reduce false
negatives at the cost of one extra API call per item per cycle.
Recommendation for v1: ship lexical, measure false-negative rate on real goals after a week of use,
upgrade to embeddings in a follow-up if the miss rate is unacceptable. The heuristic pre-filter is
isolated in `relevance.ts` and is trivially swappable.

**OQ-3 — Engagement signal strength (single user)**
Fitness mixes relevance and engagement (§5.5). For a single user, `acknowledged` alerts are the only
engagement signal. Early in usage there will be few alerts, making the engagement factor near the
prior (0.5) for all genomes. This means early generations are fitness-flat on engagement and selection
is driven almost entirely by relevance. This is acceptable: the genome will start converging on
relevance-maximising queries and engagement will become meaningful as the user interacts with alerts.
No change to the design is required, but this behaviour should be documented in the UI (P6).

**OQ-4 — `query_genome_state` schema migration strategy**
The spec adds `query_genome_state` (and the `genome_id` column on `external_signal`) to
`schema.sql` as explicit build deliverables (§4.3). `openDb()` runs `schema.sql` with `IF NOT EXISTS`,
so adding the table is non-destructive for existing databases. However, the project currently has no
migration-version tracking. If a later spec modifies the table, there is no mechanism to detect a
stale schema. This is acceptable for v1 (single-user local, easy to wipe and re-init) but should be
addressed before any shared or persistent deployment.

**OQ-5 — Default model for genome operators vs relevance judge**
The spec uses the same model constant (`openai/gpt-4o-mini`) for genome operators (seed/crossover/
mutate) and the relevance judge. A stronger model for seed (called once per goal) and a cheaper one
for repeated judging may improve genome quality without much cost increase. This is a one-constant
change once OpenRouter model pricing is confirmed.

**OQ-6 — Cross-user warm-start priors ("global best") — future extension, NOT a v1 build item**

The two natural insertion points for meta-learned cold-start priors in the current design are:

1. **S0 `uniformBelief(n)` initialisation** — the prior over goal dimensions is currently uniform.
   A meta-learned prior (learned from aggregate usage) could replace this, starting each new goal
   closer to a useful prior and reducing the number of elicitation questions needed to converge.

2. **P5 genome `seed` operator** (§5.2) — the seed LLM prompt currently asks for `populationSize`
   DISTINCT query sets from scratch. A warm-start prior could bias the initial population toward
   query strategies that have historically converged quickly on goals of a similar type.

**Why this is out of scope for v1:** Spacato v1 is intentionally single-user and local — there is no
server, no aggregate data collection, and no mechanism for privacy-preserving aggregation across
users. The warm-start extension requires: (a) opt-in data collection from multiple users, (b) a
privacy-preserving aggregation mechanism (e.g. federated averaging or differential privacy), and (c)
infrastructure to distribute learned priors.

**Known limitation of a single global prior:** the meta-learning literature on cold-start preference
elicitation (e.g. MAML-style approaches, ProtoNets for preference models) warns that a single global
prior generalises poorly across diverse goal types — a prior learned from "train for a marathon"
goals is a bad initialiser for "save for a house deposit" goals. Prefer per-goal-type or clustered
priors (cluster by goal taxonomy or embedding similarity) over a monolithic global prior.

**Forward compatibility:** the current design already supports this extension at both seams without
structural change. `uniformBelief(n)` in S0 and the LLM seed prompt in P5 are isolated, trivially
replaceable with a prior-injecting variant when the infrastructure exists. No v1 code needs to
anticipate this; it is recorded here as a known extension point.
