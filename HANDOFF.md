# Spacato — Handoff

> Last updated: 2026-05-28 (semantic-distance plan T1–T4 in flight; canonical tree migrated to `c:\dev\Spacato`).
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

A single-user, **local** AI goal-planning web app (Next.js/TypeScript + SQLite + OpenRouter). Core loop:
chat-driven goal elicitation → decompose into monthly→weekly→daily tasks → a 2-week sliding window that
locks the near term and reweights/trickle-down-updates the rest → daily timetable presets → a side
news/weather/market window with goal-relevant alerts. Full design: `docs/canonical-project-graph.md`.

The OpenRouter key lives only server-side (a Next API route); it never enters the browser bundle.

---

## 2. Current state

**Repo:** github.com/DanielJGrayshon/Spacato. **Canonical working tree:** `c:\dev\Spacato`
(the prior OneDrive clone at `c:\Users\danie\OneDrive\…\MathsCloner` was reconciled and removed —
parallel clones are now banned by `WORKFLOW.md` §"Code-change hygiene").

**Branches on origin:**
- `main` — tip `688f7db`. Phase A foundation + S0 elicitation + P5 news/signals (spec-fidelity-fixed) +
  R1 gateway hardening + Next tsconfig + `next build` route-export fix + `/api/alerts/acknowledge` route
  + the live-discovered operator-prompt fix (`4922091`, see §9 risk 1). **89 tests green,
  `npm run typecheck` clean.** Local and remote in sync.
- `fix/s0-semantic-distance` — tip `5bbf8b7`. In-flight implementation of the semantic-distance plan
  (spec: `docs/superpowers/specs/2026-05-28-s0-semantic-distance-design.md`, 426 lines; plan:
  `docs/superpowers/plans/2026-05-28-s0-semantic-distance.md`, 7 tasks). T1–T4 committed
  (`dfba468` shared utils + `relevance.ts` refactor; `505a354` gateway `embed`/`embedBatch`;
  `7364246` `vectors_json` sidecar + repo round-trip; `5bbf8b7` `belief.ts` rewrite —
  `cosineDistance`/`jaccardDistance`/`makeDistanceFn`/`DistanceFn`). Currently mid-T5:
  6 failing tests + 7 typecheck errors are the expected cascade — `acquisition.ts`,
  `orchestrator.ts`, `elicit-handler.ts`, and `tests/s0/{elicit-route,orchestrator}.test.ts` still
  call the old 4-arg `sigma`/`updateBelief` or import the removed `distance` symbol. T5 closes those.

**Built and on `main`:**
- **Foundation:** `src/lib/store` (SQLite), `src/lib/llm` (OpenRouter gateway), `src/lib/esc` (evolutionary core).
- **S0 goal elicitation:** `src/lib/s0/*` + `src/app/api/elicit` — full Bayesian pairwise elicitation loop.
  Distance metric on `main` is still the original exact-string Hamming (`distance()` over 5 dims); the
  semantic-distance rewrite is on `fix/s0-semantic-distance` (above).
- **P5 news/signals:** `src/lib/p5/*` (`sources`, `feed-ingest`, `relevance`, `genome`, `esc-adapter`,
  `alert-logic`, `acknowledge-handler`, `types`) + `src/app/api/signals/route.ts` +
  `src/app/api/alerts/acknowledge/route.ts` + `scripts/ack-alert.mjs` (Node-20 ESM CLI caller, native
  fetch). `esc-core.evolve` runs crossover and mutate phases concurrently (`Promise.all`); `QueryTerm.weight`
  is consumed via a weighted-relevance mean in the ESC fitness; content-dedup is scoped to open-alert signals
  via `signals.listByIds`. Engagement leg structurally unblocked by the acknowledge route — 0.25 → 0.75 after
  a real ack.
- **Gateway robustness:** `src/lib/llm/gateway.ts` sets `response_format: { type: "json_object" }`, strips
  markdown code-fences (any language tag), and wraps non-JSON response bodies with an attributable
  status+snippet error instead of an opaque `SyntaxError`.
- **Live-discovered operator-prompt fix (`4922091`):** real OpenRouter output returned bare arrays /
  literal placeholder text — `src/lib/s0/operators.ts` now ships explicit JSON-shape examples in the
  prompts so structured-output parsing holds against a real provider.

**Spec'd and in flight:** S0 semantic distance (spec drafted post-live-run; plan committed; T1–T4 done,
T5–T7 remaining — see §5 and `fix/s0-semantic-distance` branch).

**Not started:** P2 decomposition (month→week→day), P3 sliding-window re-planner, P4 timetable presets,
P6 the entire web UI. The app has had at least one live elicitation cycle against real OpenRouter (the
evidence motivating the semantic-distance spec — see §9 risk 1), but there is still no UI; humans
exercise the API directly via `curl` / `scripts/ack-alert.mjs`.

---

## 3. Architecture & key interfaces (the API surface you build against)

**`src/lib/esc/core.ts`** — generic LLM-operator evolutionary engine (no LLM dependency itself; operators injected):
- Types: `Genome<T> = {value:T}`; `EscState<T> = {population, scores, generation, bestScore}`;
  `EscConfig<T> = {maxGenerations, populationSize?, seed, crossover, mutate, fitness, select, converged}`.
- Composable primitives: `score(cfg, pop)`, `select(cfg, pop, scores)`, `evolve(cfg|{crossover,mutate}, parents)`
  — **two-phase concurrent**: all crossovers `Promise.all`, then all mutates `Promise.all`; returns
  `[...parents, ...offspring]`, offspring `m` from parents `m` & `(m+1)%n`. Index order preserved.
- Lifecycles: `step(cfg, state)` (one generation, one fitness eval, trims to `populationSize`), `runToConvergence(cfg)`.

**`src/lib/llm/gateway.ts`** — sole OpenRouter choke-point:
- `makeGateway({apiKey, cache, fetchFn?, endpoint?, maxConcurrency?})` → `{ complete<T>(req), batchComplete<T>(reqs) }`.
- `LlmRequest<T> = {model, messages, schema}` (zod). Structured output validated; cached by schema-fingerprint key;
  `batchComplete` bounded-concurrency. Injectable `fetchFn` → offline tests.
- Outgoing requests carry `response_format: { type: "json_object" }` so providers that honour it return strict JSON.
  Belt-and-braces: a markdown code-fence stripper handles any opening ```` ```<tag> ```` and closing ```` ``` ````
  defensively before `JSON.parse`. A non-JSON response body (e.g. HTML auth/gateway-error page) is wrapped with
  a status+snippet error rather than surfacing as an opaque `SyntaxError`.

**`src/lib/store/`** — `openDb(file?)`, `makeRepositories(db)` → `goals{create,get,setConvergedSpec}`,
`llmCache{get,put}`, `elicitations{create,get,update}`, **`signals{create,listForGoal,listByIds,updateRelevance}`,
`alerts{create,listOpen,acknowledge,existsOpen,engagementCounts}`, `queryGenomeState{get,save}`**.
Tables in `schema.sql`: `goal`, `elicitation_state`, `external_signal` (with `genome_id`), `alert`, `llm_cache`,
`query_genome_state`.

**`src/lib/s0/`** (on `main`) — `belief.ts` (`distance, sigma, uniformBelief, updateBelief, entropy` —
exact-string Hamming `distance` over 5 dims), `acquisition.ts` (`selectQuestion, expectedPosteriorEntropy`),
`operators.ts` (`makeOperators` → seed/crossover/mutate; prompts ship explicit JSON-shape examples after
the live-run hardening in `4922091`), `orchestrator.ts` (`startElicitation, answerQuestion`, `ElicitationOps`,
`OrchestratorState`). **`src/app/api/elicit`** — `handleElicit(input, deps)` (pure, testable) + `POST` wrapper.

**`src/lib/s0/` (on `fix/s0-semantic-distance`, in flight)** — `belief.ts` exports `cosineDistance`,
`jaccardDistance`, `makeDistanceFn`, `type DistanceFn`, `TAU = 0.2`; `sigma` and `updateBelief` take a
`distance: DistanceFn` as their last argument (the exact-Hamming `distance` is gone). T5 will thread the
same `DistanceFn` through `acquisition.ts`'s `expectedPosteriorEntropy`/`selectQuestion`; T6 will own the
embed lifecycle inside `orchestrator.ts` (hash → check sidecar → `gw.embed` if absent → persist) and pipe
the gateway and embed model through `elicit-handler.ts`. See the spec/plan in §10 for the full surface.

**`src/lib/util/` (on `fix/s0-semantic-distance`, in flight)** — `text.ts` (shared `tokenise` +
`STOP_WORDS`, used by both `p5/relevance.ts` and `s0/belief.ts:jaccardDistance`) and `hash.ts`
(`contentHash(value)` = `sha256(canonicalJson(value)).slice(0, 16)` — 64-bit, collision-free at our scale,
key-order-invariant). Net effect on `main` when merged: `p5/relevance.ts` stops defining `tokenise`
locally and imports it from `util/text`; everything else is additive.

**`src/lib/p5/`** — `sources.ts` (HTTPS allow-list: NewsAPI / OpenWeather / AlphaVantage; zod-validated per-source),
`feed-ingest.ts` (`ingest(queries, deps?)` — stamps each `FeedItem` with the originating `QueryTerm.weight`),
`relevance.ts` (`scoreItems` — keyword-gate → batched LLM judge → `finalScore = 0.3·kw + 0.7·llm`),
`genome.ts` (`makeGenomeOperators` — seed/crossover/mutate as one-genome `gw.complete()` calls; identity via
`crypto.randomUUID()`, never reused), `esc-adapter.ts` (`runCycle(goalId, deps)` — primitive-based online loop;
fitness = `weightedRelevance × engagementFactor`; offspring slots initialised to `GENOME_PRIOR_SCORE = 0.1`),
`alert-logic.ts` (`raiseAlerts` — threshold `0.75`, `existsOpen` + `duplicateContentInOpenAlerts` (scoped via
`listByIds`), batched LLM justification), `acknowledge-handler.ts` (`handleAcknowledge(input, {repos})` —
pure, zod-validated; returns `{ok:true} | {error,status:400|404}`).
**`src/app/api/signals/route.ts`** — `POST` wraps `runCycle`; one ingest cycle per request.
**`src/app/api/alerts/acknowledge/route.ts`** — `POST` wraps `handleAcknowledge`; flips `alert.acknowledged = 1`.
**`scripts/ack-alert.mjs`** — Node-20 ESM CLI caller (native fetch, no deps); `node scripts/ack-alert.mjs <id>`,
`SPACATO_URL` overrides base URL.

---

## 4. How we work here (see WORKFLOW.md for the full version)

- **Orchestrator + workers, all primed with the role prompt; peers.** One worker owns a task end-to-end (TDD, commit, self-review).
- **Anti-bloat:** one worker per task; review only tasks with novel logic/math/integration; fixes go to the same worker; prefer heuristics over agents; no check-in theatre.
- **Spec drafting is peer-gated:** drafter writes → a fresh colleague cold-reads and judges "up to scratch" → iterate → only then the orchestrator final-reviews.
- **TDD always; frequent commits; verify before claiming done** (run `npm test` AND `npm run typecheck`).
- **Worker discipline learned the hard way (2026-05-28):** workers must NOT create branches, must NOT
  run `next build` or `npm run typecheck` as a success gate, and must NOT fix issues outside their
  task's file scope. The success gate is `npx vitest run`. If a worker discovers a real problem outside
  scope, it reports it and stops — the orchestrator decides whether to spawn a separate task. See §9 for
  the cleanup overhead this caused on the P5 spec-fidelity branch.

---

## 5. The next concrete step

Highest leverage, in order:

1. **Finish T5 of the semantic-distance plan** (`fix/s0-semantic-distance`). T4 (`5bbf8b7`) rewrote
   `belief.ts` and changed the `sigma` / `updateBelief` arities; the 7 typecheck errors and 6 failing
   tests are the call-site cascade — `acquisition.ts` lines 6–8 still call `sigma(pop, k, i, j)` with
   4 args, `elicit-handler.ts:34` constructs an `ElicitationState` without the now-required `vectors`,
   `orchestrator.ts:54` calls `updateBelief` without `distance`, and `tests/s0/{elicit-route,orchestrator}.test.ts`
   import the removed `distance` symbol. T5 of the plan resolves these by extending
   `expectedPosteriorEntropy` / `selectQuestion` to take `distance: DistanceFn` and updating each caller
   to supply a stub or `makeDistanceFn(state.vectors)` as appropriate. Gate: `npx vitest run` green again.

2. **T6 of the plan: orchestrator embed lifecycle + `elicit-handler` plumbing + integration tests.**
   On each `seed`/`crossover`/`mutate`, hash each new `genome.value`, check `state.vectors[hash]`, and
   `await gw.embed(JSON.stringify(genome.value), embedModel)` if absent; build
   `distance = makeDistanceFn(state.vectors)` and pass it into `selectQuestion`/`updateBelief`; persist
   `vectors_json` on the elicitation state. Add an integration test (spec §9.3) that drives `start` +
   one `answer` with semantically-spread stub vectors and asserts the belief moves where exact-Hamming
   would have left it pinned.

3. **T7 of the plan: route env-var polish.** `src/app/api/elicit/route.ts` reads `S0_EMBED_MODEL`
   (default `openai/text-embedding-3-small`) and threads gateway + embed-model through to the
   orchestrator. Trivial after T6. Once green, this branch can FF to `main` and risk #2 closes.

4. **Live convergence run.** With semantic distance in, repeat the "run a marathon" elicitation against
   real OpenRouter and confirm the belief actually moves on a single answer (spec §9.4 manual test).
   This validates the OQ-1 `TAU` default and is the load-bearing real-world check on the whole loop.

5. **Deferred minors** — one tidy commit: `queryTermSchema.weight` → `.positive()` in `genome.ts`;
   consider pulling `queryWeight` out of `FeedItemPayload` (it's persisting genome-lineage metadata
   into source-item payload, currently harmless because nothing reads it back). See §8.

6. **The product gaps:** P6 (a UI) so a human can use any of this without `curl` or CLI scripts, and
   P2/P3 (the month→week→day decomposition + sliding-window re-planner that are the product's core
   promise).

---

## 6. Key decisions (don't re-litigate without reason)

- Single-user local; Next.js TS; SQLite; key server-side only.
- ESC is a shared primitive backing S0 (converge-once-ish, via orchestrator composing primitives) and P5 (online).
- S0 = full Bayesian pairwise elicitation (Bradley–Terry + info-gain acquisition); operators are LLM (EvoPrompt pattern).
- P5 ESC reuse = adaptive query/source selection only; per-item relevance = keyword-gate + batched LLM judge (heuristic, not evolution); verified-feed allow-list only.
- P5 genome operators use per-genome `gw.complete()` calls. Concurrency is delivered by `esc-core.evolve`
  running each phase via `Promise.all` — not by `batchComplete`. Same latency benefit; cleaner operator contract.
- `QueryTerm.weight` enters fitness as a weighted mean of `finalScore` and reaches selection transitively
  (selection ranks on that fitness; `selectTop` itself has no direct weight dependency).
- **S0 distance is semantic, not lexical** (spec §1, in flight on `fix/s0-semantic-distance`).
  `cosineDistance` on OpenRouter embeddings of the stringified `GoalInterpretation`; deterministic
  token-Jaccard fallback when a vector is missing or `gw.embed` failed. `DistanceFn` is injected into
  `sigma` / `updateBelief` / `expectedPosteriorEntropy` / `selectQuestion` — belief math stays a pure
  functional core with no module-level distance. Embeddings live in a content-addressed
  `vectors: Record<string, number[]>` sidecar on `ElicitationState`, persisted as `vectors_json` on
  `elicitation_state`. The orchestrator owns the embedding lifecycle (hash → check sidecar → embed if
  absent → persist); operators stay pure. `TAU = 0.2`. Out of scope (deferred, spec §10): per-field
  weighting, schema migrations, sidecar pruning, embedding-model swap automation.

---

## 7. Run & test

```bash
npm install
npm test              # vitest — 89 tests on main (transpiles, does NOT typecheck)
npm run typecheck     # tsc --noEmit — run this too; vitest won't catch type errors. Clean on main.
cp .env.local.example .env.local   # then put a real OPENROUTER_API_KEY in it
npm run dev           # at least one live elicitation cycle has hit real OpenRouter — see §9 risk 1
# npm run build       # structurally unblocked but not yet run end-to-end — see §9 risk 1
```

**Canonical working tree:** `c:\dev\Spacato`. Any other clone is a divergence risk; the OneDrive copy
was reconciled and removed 2026-05-28 (see `WORKFLOW.md` §"Code-change hygiene", "no parallel-clone files").

---

## 8. Deferred items (R1/R2/R3 backlog)

**Minor (reviewer-flagged, deliberately deferred during P5 spec-fidelity merge):**
- `src/lib/p5/genome.ts` — `queryTermSchema.weight: z.number()` permits zero/negative; tighten to `.positive()`.
- `src/lib/p5/types.ts:17` — `FeedItemPayload = FeedItem` causes `queryWeight` (genome-lineage metadata)
  to persist into `external_signal.payload_json`. Harmless today, forward risk only.
- `tests/p5/repositories.test.ts` — `listByIds` test shadows the outer `beforeEach` `repos`.
- `tests/p5/feed-ingest.test.ts` — stamping-test fixture omits `totalResults` (schema field is optional).
- `src/lib/store/repositories.ts` — `listByIds` re-prepares its statement per call (variable-arity `IN`).
  Other repo methods use fixed-SQL prepares. Benign at current call rates.

**Standing (pre-existing R1/R2):**
- **Store:** cache prepared statements; `SELECT` explicit columns; schema migration/versioning (still
  `IF NOT EXISTS` only — see §9 risk 4 on the `genome_id` column and the upcoming `vectors_json` column).
- **ESC/S0:** belief-weight epsilon floor (underflow >~40 updates; we cap at 8); directional `sigma` test.
- **P5 (spec OQs §10):** OQ-1 concrete feed providers concretized but unmonitored for free-tier drift;
  OQ-2 lexical-vs-embedding similarity; OQ-4 no migration tracking; OQ-5 separate model for seed vs judge;
  OQ-6 cross-user warm-start priors. (OQ-3 — engagement signal pinned at the Laplace prior — closed
  structurally by the acknowledge route at commit `091f18b`.)
- **Semantic distance (spec §10, post-T7):** OQ-1 `TAU` tuning (live convergence may show the belief
  moves too fast or too slow at `TAU = 0.2`); OQ-2 per-field weighting (e.g. `scope × 2`, `motivation × 0.5`);
  OQ-3 schema migration for `vectors_json` on legacy DBs (current stance: wipe-and-reinit during dev);
  OQ-4 sidecar pruning of stale content-hash entries; OQ-5 belief-weight underflow at ~40 updates (overlaps
  the ESC/S0 standing item above); OQ-6 cross-user warm-start priors; OQ-7 embedding-model swap +
  `cosineDistance` dim-mismatch (currently throws loudly; acceptable v1 signal).

---

## 9. Known risks (see the retrospective for detail)

1. **`next build` has not been smoked end-to-end.** `next dev` has been run live against real
   OpenRouter — at minimum one elicitation cycle on the "run a marathon in 6 months" goal produced four
   real interpretations (finishing-focused / capability / participation / time-goal) and surfaced two
   live bugs that are now patched: (a) operators returning bare arrays / literal placeholder text instead
   of the schema-conformant JSON we asked for (fix in `4922091`), and (b) the underlying gateway
   robustness items (`response_format: json_object`, code-fence stripping, malformed-body wrapping).
   `next build` has been structurally unblocked (route re-exports removed, tsconfig adopted) but has not
   actually been run; a first build may still surface Next.js-side issues.
2. **S0 semantic distance is mid-build, not yet on `main`.** The original exact-string Hamming `distance()`
   *was* the brittleness that the live "marathon" run exposed — pairwise distances collapsed to ≈ 1.0
   across the 5 free-text dimensions because real LLM interpretations almost never share exact tokens, so
   the Bayesian belief barely moves on any answer. The spec
   (`docs/superpowers/specs/2026-05-28-s0-semantic-distance-design.md`) and 7-task plan
   (`docs/superpowers/plans/2026-05-28-s0-semantic-distance.md`) replace it with cosine-on-embeddings
   plus token-Jaccard fallback. T1–T4 are committed on `fix/s0-semantic-distance` (`5bbf8b7`); T5–T7
   remain (§5). Until that branch merges, `main`'s S0 still uses exact-Hamming and will not converge on
   real LLM output.
3. **P5 engagement is wired but unexercised.** The acknowledge route exists (commit `091f18b`, §3) and the
   engagement-shift test proves the factor moves 0.25 → 0.75 after a real ack. But until either a UI (P6)
   or `scripts/ack-alert.mjs` actually drives the loop in live use, the factor stays at the Laplace prior
   in practice. The *mechanism* is no longer the blocker; *exercise* is. Closes OQ-3 structurally.
4. **Schema columns added via `CREATE TABLE IF NOT EXISTS` + `DEFAULT`.** Affects `external_signal.genome_id`
   today and `elicitation_state.vectors_json` when the semantic-distance branch merges. Any SQLite file
   created before a given column existed will NOT have it — `IF NOT EXISTS` only creates the table on
   first run; it does not `ALTER` an existing table. Wipe the DB (`*.sqlite` is gitignored) or write a
   one-off `ALTER TABLE`. There is still no migration framework (P5 OQ-4 / semantic-distance OQ-3).
5. **Worker discipline + tree hygiene.** Two failure modes observed and patched:
   (a) Earlier in the project, implementer subagents created their own branches and bundled out-of-scope
   `next build` fixes; the §4 discipline notes capture the guardrails that worked
   (`git branch --show-current` as first and last action; explicit prohibition on `tsc`/`next build` as
   success gates; allowed-files list).
   (b) Parallel clones drifted (an old OneDrive copy diverged from `c:\dev\Spacato`, producing two
   independent histories with same-message commits). Reconciled by `git cherry`-driven cherry-pick onto
   `main` + a rebase of the feature branch. The new `WORKFLOW.md` "Code-change hygiene" section codifies
   "no parallel-clone files" so this doesn't recur.
6. **No CI** — typecheck/tests are manual; nothing gates a push.
7. `npm audit` reports vulnerabilities in the pinned Next 14.2.5.

---

## 10. Doc index

- `docs/canonical-project-graph.md` — the two canonical representations + 7-subsystem decomposition + decisions.
- `docs/superpowers/specs/2026-05-27-esc-s0-p5-design.md` — first-slice spec.
- `docs/superpowers/specs/2026-05-27-p5-signals-design.md` — P5 spec (built; reconciled with implementation 2026-05-28).
- `docs/superpowers/specs/2026-05-28-s0-semantic-distance-design.md` — semantic-distance spec (drafted
  post-live-run; in-flight via `fix/s0-semantic-distance`).
- `docs/superpowers/R1-review-phase-a.md` — interface review after Phase A.
- `docs/superpowers/plans/2026-05-27-spacato-phase-a-foundation.md` — Phase A plan (built).
- `docs/superpowers/plans/2026-05-27-spacato-phase-b-s0-elicitation.md` — S0 plan (built).
- `docs/superpowers/plans/2026-05-28-p5-spec-fidelity.md` — P5 spec-fidelity fixes plan (built, merged to `main`).
- `docs/superpowers/plans/2026-05-28-s0-semantic-distance.md` — 7-task TDD plan for the semantic-distance
  spec (T1–T4 committed, T5–T7 pending; see §5).
- `WORKFLOW.md` — orchestrator/worker conventions; the "Code-change hygiene" section is the new
  no-NEW-markers / no-parallel-clone-files rule referenced throughout this doc.
