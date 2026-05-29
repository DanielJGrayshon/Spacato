# Spacato — Handoff

> Last updated: 2026-05-29 (P2 decomposition shipped + marathon live-run PASS; tree at `c:\dev\Spacato`).
> This is the single document a fresh contributor (human or agent) reads to resume work. Pair it with
> `WORKFLOW.md` (how we work) and `docs/canonical-project-graph.md` (the design).

---

## 0. Your role (canonical role prompt — adopt it)

> You are a senior systems designer who worked at Google's UK campus (King's Cross, London) during
> 2021–2022, specialising in agentic/LLM planning systems. You design for **isolation and clarity**:
> small units, well-defined interfaces, each independently testable. You are **heuristics-first** —
> deterministic logic does the calendar math, weighting, decay, packing, and dedup; the LLM is invoked
> only where it earns its place, always **batched and cached**. You ship **real, concrete, tested**
> work — never placeholders, never stubs left behind. You state assumptions explicitly and verify
> before claiming done.

The orchestrator holds itself to this too. Subagents are **equal, esteemed colleagues**, not tools.

---

## 1. What Spacato is

A single-user, **local** AI goal-planning web app (Next.js 14 / TypeScript + SQLite + OpenRouter). Core
loop: chat-driven goal elicitation (S0) → decompose into monthly→weekly→daily tasks (P2) → a 2-week
sliding window that locks the near term and reweights/trickle-down-updates the rest (P3) → daily
timetable presets (P4) → a side news/weather/market window with goal-relevant alerts (P5) → all of it
exposed via a web UI (P6). Full design: `docs/canonical-project-graph.md`.

The OpenRouter key lives only server-side (a Next API route); it never enters the browser bundle.

---

## 2. Current state

**Repo:** `github.com/DanielJGrayshon/Spacato`.
**Canonical working tree:** `c:\dev\Spacato`. Any OneDrive copy is stale; OneDrive sync was found to
revert working-tree edits and corrupt concurrent git state in earlier sessions (§9 risk 5). All work
must happen at `c:\dev\Spacato`.

**Branches:**
- `main` — tip `7de30e8`. Phase A foundation + S0 elicitation (with semantic distance) + P5
  news/signals + R1 gateway hardening + P2 decomposition (versioned month→week→day tree) just shipped
  with a successful live marathon run against real OpenRouter. **186 tests green, `npm run typecheck`
  clean, `npm run build` compiles.** (Test count dropped from 188 → 186 on 2026-05-29 after a duplicate
  `gateway.test.ts` was consolidated; three unique `bypassCache` cases were preserved.)

**Built and on `main`:**
- **Foundation:** `src/lib/store` (SQLite), `src/lib/llm` (OpenRouter gateway), `src/lib/esc`
  (evolutionary core), `src/lib/util` (shared `tokenise`+`STOP_WORDS` and `contentHash`).
- **S0 goal elicitation:** `src/lib/s0/*` + `src/app/api/elicit` — full Bayesian pairwise elicitation
  loop with a **semantic distance** (cosine on OpenRouter embeddings, token-Jaccard fallback). Vectors
  live in a content-addressed sidecar on `ElicitationState` (`vectors_json` column). `DistanceFn` is
  injected into `sigma`/`updateBelief`/`expectedPosteriorEntropy`/`selectQuestion` — belief math is
  distance-agnostic. The orchestrator owns the embedding lifecycle (hash → check sidecar →
  `gw.embed` if absent → persist); operators stay pure. `S0_EMBED_MODEL` env var (default
  `openai/text-embedding-3-small`). HANDOFF §9 risk #2 from prior sessions — **closed.**
- **P5 news/signals:** `src/lib/p5/*` (`sources`, `feed-ingest`, `relevance`, `genome`, `esc-adapter`,
  `alert-logic`, `acknowledge-handler`, `types`) + `src/app/api/signals/route.ts` +
  `src/app/api/alerts/acknowledge/route.ts` + `scripts/ack-alert.mjs` (Node-20 ESM CLI caller).
  `esc-core.evolve` runs crossover and mutate phases concurrently (`Promise.all`); `QueryTerm.weight`
  enters fitness as a weighted-relevance mean; content-dedup scoped to open-alert signals via
  `signals.listByIds`. Engagement structurally unblocked by the acknowledge route — `engagementFactor`
  shifts 0.25 → 0.75 after a real ack.
- **Gateway robustness:** `src/lib/llm/gateway.ts` requests `response_format: { type: "json_object" }`,
  strips markdown code-fences (any language tag), wraps non-JSON response bodies with an attributable
  status+snippet error, exposes `embed`/`embedBatch` for the semantic-distance path (cached by a
  distinct key from chat completions; bounded concurrency).
- **Live-discovered operator-prompt fix:** real OpenRouter responses returned bare arrays / literal
  placeholder text — `src/lib/s0/operators.ts` and `src/lib/p5/genome.ts` now ship explicit JSON-shape
  examples and an enumerated-constraint sentence in their prompts so structured-output parsing holds
  against a real provider. Each enum is described as "exactly one of these three string values" rather
  than the pipe-separated regex shorthand the LLM read literally.
- **P2 decomposition:** `src/lib/p2/*` (`types`, `operators`, `retry`, `decompose-handler`) +
  `src/lib/util/calendar.ts` + `src/app/api/decompose/route.ts`. Versioned three-layer plan tree
  (monthly → weekly → daily) persisted to SQLite via `decomposition`, `monthly`, `weekly`, `daily_task`
  tables; `goal.activeDecompositionId` flips on commit. Pure per-layer operators (one `gw.complete`
  call per parent, `bypassCache: true`); orchestrator owns calendar/transaction/retry. LLM I/O bypasses
  the cache for genuine re-decomposition; all other features keep caching. P2 also extended the gateway
  with `LlmRequest.bypassCache?: boolean` (default false).

**Run live to date (against real OpenRouter `gpt-4o-mini`):**
- `POST /api/elicit` and `POST /api/signals` proven end-to-end (interpretation diversity, info-gain
  pair, P5 genome diversity); see git history for the per-feature live notes.
- `POST /api/decompose` for the marathon goal — **P2 marathon live-run PASSED on 2026-05-29.**
  Coherent month→week→day ladder, `estimatedMinutes` in the expected 15–120 range, no brand names or
  vendor URLs (coarse-but-actionable framing held), ≤ 60 s wall-clock, ≈ $0.013. Body and tree
  snapshots at `p2-marathon-*.json` in the repo root.
- Four real shipped bugs found and fixed across the elicit / signals runs (see §9 risk 1).

**Spec'd but not built:** P3 sliding-window re-planner (spec just drafted today with a v1+v2 split —
v1 is lock + reweight + partial redecomp, v2 covers concretization and signal-pressure feeds), P4
timetable presets, P6 the entire web UI. Schema migration framework v1 spec also drafted today
(`docs/superpowers/specs/2026-05-29-schema-migration-framework-v1.md`); intended to land before P3
implementation so P3's new tables go through the framework rather than extending the additive-ALTER
pattern an eighth time. No human-facing UI exists yet; humans exercise the API via `curl` /
`scripts/ack-alert.mjs`.

---

## 3. Architecture & key interfaces

**`src/lib/esc/core.ts`** — generic evolutionary engine (no LLM dependency itself; operators injected):
- Types: `Genome<T> = {value:T}`; `EscState<T> = {population, scores, generation, bestScore}`;
  `EscConfig<T> = {maxGenerations, populationSize?, seed, crossover, mutate, fitness, select, converged}`.
- Composable primitives: `score(cfg, pop)`, `select(cfg, pop, scores)`, `evolve({crossover, mutate}, parents)`
  — **two-phase concurrent**: all crossovers `Promise.all`, then all mutates `Promise.all`; returns
  `[...parents, ...offspring]`, offspring `m` from parents `m` & `(m+1)%n`.
- Lifecycles: `step(cfg, state)` (one generation, one fitness eval, trims to `populationSize`),
  `runToConvergence(cfg)`.

**`src/lib/llm/gateway.ts`** — sole OpenRouter choke-point:
- `makeGateway({apiKey, cache, fetchFn?, endpoint?, embeddingEndpoint?, maxConcurrency?})`
  → `{ complete<T>(req), batchComplete<T>(reqs), embed(text, model), embedBatch(texts, model) }`.
- `LlmRequest<T> = {model, messages, schema}` (zod). Structured output validated; cached by
  schema-fingerprint key; markdown code-fences stripped before `JSON.parse`; non-JSON bodies wrapped
  with status+snippet error; `response_format: { type: "json_object" }` sent on every chat call.
- Embeddings hit `https://openrouter.ai/api/v1/embeddings`; cached by `promptHash(model, [], "embed:" + text)`
  so chat and embed never collide in `llm_cache`.

**`src/lib/store/`** — `openDb(file?)`, `makeRepositories(db)` →
`goals{create,get,setConvergedSpec}`,
`llmCache{get,put}`,
`elicitations{create,get,update}` (with `vectors: Record<string, number[]>` round-trip; `get` falls
back to `{}` and logs a warning on corrupt `vectors_json` per spec §8),
`signals{create,listForGoal,listByIds,updateRelevance}`,
`alerts{create,listOpen,acknowledge,existsOpen,engagementCounts}`,
`queryGenomeState{get,save}`.
Tables in `schema.sql`: `goal`, `elicitation_state` (with `vectors_json`), `external_signal` (with `genome_id`),
`alert`, `llm_cache`, `query_genome_state`.

**`src/lib/util/`** — pure utilities consumed everywhere:
- `text.ts` — `tokenise(text): string[]` (lowercase, split on `/[^a-z0-9]+/`, drop stop-words and
  length-1 tokens) + `STOP_WORDS` set. Imported by `p5/relevance.ts` and `s0/belief.ts:jaccardDistance`.
- `hash.ts` — `contentHash(value): string`. `sha256(canonicalJson(value)).slice(0, 16)` — 64 bits,
  collision-free at our scale, recursively key-order-invariant. Used as the sidecar key for embeddings.

**`src/lib/s0/`** —
- `belief.ts` — `type Belief = {weights: number[]}`, `type DistanceFn = (a,b) => number`, `const TAU = 0.2`.
  `cosineDistance(u, v)` ((1-cos)/2, clamped to [0,1], zero-magnitude → 1, mismatched dims → throws).
  `jaccardDistance(a, b)` (over the 5 dims concatenated, both-empty → 0).
  `makeDistanceFn(vectors)` — cosine when both `contentHash(a)` and `contentHash(b)` are in the sidecar;
  Jaccard otherwise. `sigma(pop, k, i, j, distance)`, `updateBelief(belief, pop, q, answer, distance)`,
  `uniformBelief(n)`, `entropy(belief)`.
- `acquisition.ts` — `expectedPosteriorEntropy(belief, pop, q, distance)`,
  `selectQuestion(belief, pop, distance)`.
- `operators.ts` — `makeOperators(gw, rawGoal, k, model)` → seed/crossover/mutate. Prompts ship
  explicit JSON-object shape examples (live-run hardening — see §9 risk 1).
- `orchestrator.ts` — `startElicitation(ops, cfg, embed)`, `answerQuestion(ops, state, answer, cfg, embed)`.
  `OrchestratorState` now carries `vectors`. Internal `annotate(genomes, vectors, embed)` populates the
  sidecar by `contentHash`; embed failures are caught and the key left absent (`makeDistanceFn` falls
  back to Jaccard for that pair). `evolve+rank+annotate` ordering: only post-rank survivors are embedded.
- `elicit-handler.ts` — `handleElicit(input, deps)`. `ElicitDeps = {repos, ops, embed}`. Round-trips
  `vectors` through `toState` / `persist`.

**`src/lib/p5/`** — `sources.ts` (HTTPS allow-list: NewsAPI / OpenWeather / AlphaVantage; zod-validated),
`feed-ingest.ts` (`ingest(queries, deps?)`, stamps each `FeedItem` with the originating `QueryTerm.weight`),
`relevance.ts` (keyword-gate → batched LLM judge → `finalScore = 0.3·kw + 0.7·llm`),
`genome.ts` (`makeGenomeOperators` — seed/crossover/mutate as per-genome `gw.complete()` calls; identity
via `crypto.randomUUID()`, never reused; prompts hardened to send explicit JSON shape + enumerated
source-string constraint),
`esc-adapter.ts` (`runCycle(goalId, deps)` — primitive-based online loop;
`fitness = weightedRelevance × engagementFactor`; offspring slots floored to `GENOME_PRIOR_SCORE = 0.1`),
`alert-logic.ts` (`raiseAlerts` — threshold 0.75, `existsOpen` + content-dedup scoped via `listByIds`,
batched LLM justification),
`acknowledge-handler.ts` (`handleAcknowledge(input, {repos})` — pure, zod-validated).

**Routes:**
- `src/app/api/elicit/route.ts` — reads `S0_EMBED_MODEL` (default `openai/text-embedding-3-small`),
  builds `embed = (t) => gw.embed(t, EMBED_MODEL)`, passes `{repos, ops, embed}` to `handleElicit`.
- `src/app/api/signals/route.ts` — reads `P5_GENOME_MODEL` / `P5_JUDGE_MODEL`; `POST` wraps `runCycle`.
- `src/app/api/alerts/acknowledge/route.ts` — `POST` wraps `handleAcknowledge`.

**CLI:** `scripts/ack-alert.mjs` — Node-20 ESM (`SPACATO_URL` overrides base URL).

---

## 4. How we work here (see WORKFLOW.md for the full version)

- **Orchestrator + workers, all primed with the role prompt; peers.** One worker owns a task
  end-to-end (TDD, commit, self-review).
- **Anti-bloat:** one worker per task; review only tasks with novel logic/math/integration; fixes go
  to the same worker; prefer heuristics over agents; no check-in theatre.
- **Spec drafting is peer-gated:** drafter writes → a fresh colleague cold-reads and judges "up to
  scratch" → iterate → only then the orchestrator final-reviews.
- **TDD always; frequent commits; verify before claiming done** (run `npm test` AND `npm run typecheck`;
  for routes also `npm run build`).
- **Worker discipline (learned the hard way):** workers must NOT create branches, must NOT use
  `next build` / `npm run typecheck` as the per-task success gate, and must NOT fix issues outside
  their task's file scope. The per-task gate is `npx vitest run <test-file>`. If a worker discovers
  a real problem outside scope it reports and stops — the orchestrator decides whether to spawn a
  separate task.
- **Code-change hygiene (project rule, WORKFLOW.md):** no `// edit:` / `// was:` / `// previously …`
  / `// NEW —` comments; no `*_v2` / `*_new` / `legacy_*` identifiers; no parallel-clone files. Patch
  in situ. Git history is where the previous version lives. Comments explain what the code does now
  and why, not how it changed. The rule is enforced strictly on every PR-equivalent merge.

---

## 5. The next concrete step

In rough order of leverage:

1. **Schema migration framework v1 — implement.** Spec drafted today at
   `docs/superpowers/specs/2026-05-29-schema-migration-framework-v1.md`. Lands `src/lib/store/migrate.ts`
   + `src/lib/store/migrations/001…006-*.sql`, replaces the `try { ALTER TABLE … }` blocks and
   `schema.sql` `readFileSync` in `openDb`. Must land **before** P3 implementation so P3's three new
   tables go through the framework rather than extending the additive-ALTER pattern an eighth time.
   The spec calls out a cutover decision (§10 OQ-2) the implementing worker needs to pick — default
   is wipe-and-reinit-during-cutover, which matches v1's existing dev-DB stance.

2. **P3 plan + implementation.** Spec was just drafted (v1+v2 split documented in the spec). After
   the migration framework lands, plan and build P3 v1: lock the near 2-week window, reweight the
   rest from slippage + signal pressure, partial redecomp where week boundaries shift. P3 reuses the
   P2 operators verbatim for partial redecomp.

3. **P6 spec drafting (shell + S0 chat view first).** The app has no human-facing UI. The S0 chat
   view can be specced and built first because `/api/elicit` is a stable contract; the news side
   window can come right after because `/api/signals` is also stable. Plan/timeline views and the
   daily timetable can wait until P3 data shapes exist on the read side.

4. **CI.** A GitHub Action running `npm test && npm run typecheck && npm run build` to gate pushes.
   One small worker task, high leverage — at least one of the live bugs (the Next route-export issue)
   was a build-only failure tests didn't catch.

5. **Deferred minors** — one tidy commit when appropriate: `queryTermSchema.weight` → `.positive()`
   in `genome.ts`; pulling `queryWeight` out of `FeedItemPayload` (currently persists genome-lineage
   metadata into source-item payload, harmless because nothing reads it back). See §8.

6. **(Open, lower-leverage) Live convergence calibration for `TAU = 0.2`.** Semantic distance §9.4
   anticipated this; not blocking any feature work. Drive S0 to convergence on the marathon goal,
   confirm 3–6 questions to convergence and meaningful first-answer belief shift, tune `TAU` only if
   off. Same `TAU` value documented in §6; no structural change either way.

---

## 6. Key decisions (don't re-litigate without reason)

- Single-user local; Next.js 14 TS; SQLite; OpenRouter key server-side only.
- ESC is a shared primitive backing S0 (converge-once-ish, via orchestrator composing primitives) and
  P5 (online).
- S0 = full Bayesian pairwise elicitation (Bradley–Terry + info-gain acquisition); operators are LLM
  (EvoPrompt pattern).
- **S0 distance is semantic, not lexical.** `cosineDistance` on OpenRouter embeddings of the
  stringified `GoalInterpretation`; deterministic token-Jaccard fallback when a vector is missing or
  `gw.embed` failed. `DistanceFn` is injected into `sigma` / `updateBelief` /
  `expectedPosteriorEntropy` / `selectQuestion` — belief math is a pure functional core with no
  module-level distance. Embeddings live in a content-addressed `vectors: Record<string, number[]>`
  sidecar on `ElicitationState`, persisted as `vectors_json`. Orchestrator owns the embedding
  lifecycle; operators stay pure. `TAU = 0.2`. Out of scope for v1 (deferred — see §8): per-field
  weighting, schema migrations, sidecar pruning, embedding-model swap automation.
- P5 ESC reuse = adaptive query/source selection only; per-item relevance = keyword-gate + batched
  LLM judge (heuristic, not evolution); verified-feed allow-list only.
- P5 genome operators use per-genome `gw.complete()` calls. Concurrency comes from `esc-core.evolve`
  running each phase via `Promise.all` — not from `batchComplete`. Cleaner operator contract.
- `QueryTerm.weight` enters fitness as a weighted mean of `finalScore` and reaches selection
  transitively (selection ranks on that fitness; `selectTop` has no direct weight dependency).
- LLM prompts that mention enumerations describe them as "exactly one of these N string values" —
  pipe-separated regex shorthand inside a JSON example confuses the model into returning the literal
  string. Concrete-example value + separate constraint sentence is the pattern (live-found, §9 risk 1).

---

## 7. Run & test

```bash
# at c:\dev\Spacato
npm install
npm test              # vitest — 186 tests on main
npm run typecheck     # tsc --noEmit — also clean on main
npm run build         # next build — compiles; /api/elicit and /api/signals are dynamic routes
cp .env.local.example .env.local   # then put a real OPENROUTER_API_KEY in it
# Optional for live signal fetches: NEWSAPI_KEY, OPENWEATHER_KEY, ALPHAVANTAGE_KEY
# Optional model overrides: S0_EMBED_MODEL, P5_GENOME_MODEL, P5_JUDGE_MODEL
npm run dev           # next dev — booted live; first elicit + first signals cycle have hit real OpenRouter
```

**Canonical working tree:** `c:\dev\Spacato`. Any OneDrive copy is hazardous (§9 risk 5).

---

## 8. Deferred items (R1/R2/R3 backlog)

**Minor (reviewer-flagged across P5 and S0 work):**
- `src/lib/p5/genome.ts` — `queryTermSchema.weight: z.number()` permits zero/negative; tighten to
  `.positive()`.
- `src/lib/p5/types.ts:17` — `FeedItemPayload = FeedItem` causes `queryWeight` (genome-lineage
  metadata) to persist into `external_signal.payload_json`. Harmless today, forward risk only.
- `src/lib/store/repositories.ts` — `signals.listByIds` re-prepares its statement per call
  (variable-arity `IN`). Benign at current call rates.
- `src/lib/util/hash.ts` — top-level `undefined` argument throws inside `JSON.stringify`/sha256.
  `GoalInterpretation` is 5 strict strings so this never fires today; defensive coercion (`undefined`
  → sentinel string) would harden the function for arbitrary callers. Final-review minor.
- `src/lib/s0/orchestrator.ts` — `if (next[key]) continue;` uses truthy check; `if (key in next)`
  would be stricter. Same effect today; matters if `embed` ever returns a falsy-but-valid value.
- `src/lib/s0/orchestrator.ts` — embeds are issued serially in `annotate`. At `populationSize = 4`
  this is invisible; if cross-user warm-start (OQ-6) ever ships, switch to `gw.embedBatch`.
- `src/lib/s0/orchestrator.ts:50` — embed-failure warning is free-text. A stable filterable string
  (e.g. `"s0.annotate.embed_failed"`) would make production logs grep-able.

**Standing (pre-existing R1/R2):**
- **Store:** cache prepared statements; `SELECT` explicit columns. Schema migration/versioning has a
  drafted v1 spec (§5 step 1); P5 OQ-4 / semantic-distance OQ-3 / P2 OQ-3 all roll up into it.
- **ESC/S0:** belief-weight epsilon floor (underflow >~40 updates; current cap is 8); directional
  `sigma` test.
- **P5 (spec OQs §10):** OQ-1 concrete feed providers concretized but unmonitored for free-tier drift;
  OQ-2 lexical-vs-embedding similarity for the P5 relevance pre-filter; OQ-4 no migration tracking;
  OQ-5 separate model for seed vs judge; OQ-6 cross-user warm-start priors. (OQ-3 — engagement signal
  pinned at the Laplace prior — closed structurally by the acknowledge route.)
- **Semantic distance (spec §10):** OQ-1 `TAU` empirical tuning post-live-convergence; OQ-2 per-field
  weighting (e.g. `scope × 2`, `motivation × 0.5`); OQ-3 schema migration for `vectors_json`;
  OQ-4 sidecar pruning of stale content-hash entries; OQ-5 belief-weight underflow at ~40 updates
  (overlaps the ESC/S0 standing item); OQ-6 cross-user warm-start priors; OQ-7 embedding-model swap +
  `cosineDistance` dim-mismatch (currently throws loudly; acceptable v1 signal).

---

## 9. Known risks (see the retrospective for detail)

1. **The live runs have already happened, and they were productive.** Across two live sessions, four
   real shipped bugs were found and fixed — bugs that all 100+ tests + `tsc --noEmit` missed because
   they only manifest end-to-end:
   - **Route re-exports broke `next build`.** Both `/api/elicit` and `/api/signals` re-exported their
     inner handlers for tests to import — Next App Router forbids non-handler exports. Fix: tests
     import the inner function from its source module; route files export only `POST`. Build now
     compiles.
   - **Gateway choked on markdown-fenced JSON.** Real OpenRouter `gpt-4o-mini` returned
     ` ```json\n[…]\n``` ` and the gateway's `JSON.parse` died on the backticks. Fix: defensive
     `stripJsonFence` (any language tag) + `response_format: { type: "json_object" }` on every chat
     request as a belt-and-braces. Closes a HANDOFF §8 deferred R1 item.
   - **Operator prompts didn't specify the JSON wrapper key.** Seed prompts asked for "produce K
     interpretations" but the schema wanted `{ candidates: [...] }`; the LLM returned a bare top-level
     array and Zod rejected. Fix: prompts now show the exact JSON object shape in line.
   - **Enum example used pipe-separated regex shorthand.** A prompt template wrote
     `"source":"newsapi|openweather|alphavantage"` meaning "one of"; the LLM emitted that literal
     string as the value. Fix: concrete example value (`"source":"newsapi"`) plus a separate
     constraint sentence ("MUST be exactly one of these three string values: …").
   The live run also confirmed S0's exact-string Hamming distance was the brittleness that motivated
   the semantic-distance spec — that work has now landed on `main`. The headline "never run live"
   risk is **closed in spirit**; what remains is the convergence calibration check (§5 step 1).

2. **(closed) S0 semantic distance was mid-build.** Now merged to `main` at `0d4999a`. Replaced by
   §5 step 1: confirm the live convergence properties match the spec.

3. **P5 engagement is wired but unexercised in practice.** The acknowledge route exists and the
   engagement-shift test proves the factor moves 0.25 → 0.75 after a real ack. But until either a
   UI (P6) or `scripts/ack-alert.mjs` actually drives the loop in live use, the factor stays at the
   Laplace prior. Mechanism is no longer the blocker; *exercise* is.

4. **Schema additions still use mixed `IF NOT EXISTS` + defensive `ALTER TABLE`.** Six additive
   events to date: `external_signal.genome_id`, `elicitation_state.vectors_json`,
   `goal.active_decomposition_id`, `goal.timeframe`, the four P2 tables, and the four P2 indices.
   P3 would be the seventh (three new tables). Migration framework v1 spec drafted today
   (§5 step 1, `docs/superpowers/specs/2026-05-29-schema-migration-framework-v1.md`); intended to
   land before P3 implementation. v1 dev stance remains "wipe the DB" (`*.sqlite` is gitignored); a
   stale-DB symptom is a runtime SQL error against a missing column.

5. **The OneDrive copy is hazardous; treat the canonical tree as `c:\dev\Spacato`.** Earlier in the
   project there was a parallel clone inside OneDrive sync. Repeated observations: OneDrive
   periodically restored stale file snapshots over the working tree, faster than edits could be
   committed; `git checkout HEAD -- .` itself was reverted within seconds; concurrent agent commits
   interleaved on the same branch; and the `.git` directory in a syncing folder risks corruption.
   The clone at `c:\dev\Spacato` was made specifically to escape that — it is the source of truth.
   Any OneDrive copy that still exists is a divergence risk; do not commit there.

6. **No CI.** Typecheck/tests/build are manual; nothing gates a push. See §5 step 4.

7. `npm audit` reports vulnerabilities in the pinned Next 14.2.5.

---

## 10. Doc index

**Specs (the authoritative "what we're building" docs):**
- `docs/canonical-project-graph.md` — the two canonical representations + 7-subsystem decomposition +
  decisions.
- `docs/superpowers/specs/2026-05-27-esc-s0-p5-design.md` — first-slice spec.
- `docs/superpowers/specs/2026-05-27-p5-signals-design.md` — P5 spec (built).
- `docs/superpowers/specs/2026-05-28-s0-semantic-distance-design.md` — semantic-distance spec (built).
- `docs/superpowers/specs/2026-05-28-p2-decomposition-design.md` — P2 spec (built; marathon live-run
  PASS 2026-05-29).
- `docs/superpowers/specs/2026-05-29-p3-sliding-window-design.md` — P3 spec (drafted 2026-05-29 with
  v1+v2 split).
- `docs/superpowers/specs/2026-05-29-schema-migration-framework-v1.md` — Schema migration framework
  v1 spec (drafted 2026-05-29; intended to land before P3 implementation).
- `docs/superpowers/R1-review-phase-a.md` — interface review after Phase A.

**Plans (the "how we built it" task lists):**
- `docs/superpowers/plans/2026-05-27-spacato-phase-a-foundation.md` — Phase A plan (built).
- `docs/superpowers/plans/2026-05-27-spacato-phase-b-s0-elicitation.md` — S0 plan (built).
- `docs/superpowers/plans/2026-05-27-spacato-phase-b-p5-signals.md` — P5 plan (built).
- `docs/superpowers/plans/2026-05-28-p5-spec-fidelity.md` — P5 spec-fidelity fixes plan (built).
- `docs/superpowers/plans/2026-05-28-s0-semantic-distance.md` — 7-task TDD plan for semantic distance
  (built and merged 2026-05-28).

**Process:**
- `WORKFLOW.md` — orchestrator/worker conventions + the code-change hygiene rule (no temporal-reference
  comments, no parallel-clone files) referenced throughout this doc.

**Not yet drafted (the next product slice):**
- P4 timetable presets spec — daily scheduling from P3's daily output.
- P6 UI spec — the human-facing surface; recommended first slice is shell + S0 chat view.
