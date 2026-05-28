# Spacato — Handoff

> Last updated: 2026-05-28. This is the single document a fresh contributor (human or agent) reads to
> resume work. Pair it with `WORKFLOW.md` (how we work) and `docs/canonical-project-graph.md` (the design).

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

## 2. Current state (read carefully — "green" ≠ "runs live")

**Repo:** github.com/DanielJGrayshon/Spacato. **Branches:**
- `main` — Phase A foundation + S0 elicitation + **P5 news/signals (built and spec-fidelity-fixed)**.
  **76 tests green, `npm run typecheck` clean.** Local only; not yet pushed since the P5 merge.
- `fix/next-build-route-exports` — **quarantined, active.** Holds the unmerged `next build` fix (route files
  re-export non-handler functions) plus a separate tsconfig adoption commit plus in-progress gateway hardening
  (markdown-fence stripping, an R1 item). Five commits ahead of `main`; two are duplicates of merged work and
  should drop on rebase. See §8 for the commit-by-commit verdict and recommended cull path before merging.
- `phase-a-foundation` — old origin-tracked branch from Phase A; can be deleted once `main` is pushed.

**Built (on `main`):**
- **Foundation:** `src/lib/store` (SQLite), `src/lib/llm` (OpenRouter gateway), `src/lib/esc` (evolutionary core).
- **S0 goal elicitation:** `src/lib/s0/*` + `src/app/api/elicit` — full Bayesian pairwise elicitation loop.
- **P5 news/signals (NEW):** `src/lib/p5/*` (`sources`, `feed-ingest`, `relevance`, `genome`, `esc-adapter`,
  `alert-logic`, `types`) + `src/app/api/signals/route.ts` + `query_genome_state` table + `external_signal.genome_id`
  column + signals/alerts repos. Spec-fidelity pass merged 2026-05-28: `esc-core.evolve` now runs crossover and
  mutate phases concurrently (`Promise.all`); `QueryTerm.weight` is consumed via a weighted-relevance mean
  in the ESC fitness (selection ranks on that, so weight reaches selection transitively); content-dedup is
  scoped to open-alert signals via `signals.listByIds` (no more unbounded `listForGoal` scan).

**Spec'd but NOT built:** none currently.

**Not started:** P2 decomposition (month→week→day), P3 sliding-window re-planner, P4 timetable presets,
**P6 the entire web UI**. ⚠️ **There is no user-facing UI yet and the app has never been run live**
(see §9). Everything is verified by unit/integration tests with mocked/recorded LLM responses — and
`next build` is currently broken until the quarantined route-export fix lands (§8).

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

**`src/lib/store/`** — `openDb(file?)`, `makeRepositories(db)` → `goals{create,get,setConvergedSpec}`,
`llmCache{get,put}`, `elicitations{create,get,update}`, **`signals{create,listForGoal,listByIds,updateRelevance}`,
`alerts{create,listOpen,acknowledge,existsOpen,engagementCounts}`, `queryGenomeState{get,save}`**.
Tables in `schema.sql`: `goal`, `elicitation_state`, `external_signal` (with `genome_id`), `alert`, `llm_cache`,
`query_genome_state`.

**`src/lib/s0/`** — `belief.ts` (`distance, sigma, uniformBelief, updateBelief, entropy`),
`acquisition.ts` (`selectQuestion, expectedPosteriorEntropy`), `operators.ts` (`makeOperators` → seed/crossover/mutate),
`orchestrator.ts` (`startElicitation, answerQuestion`, `ElicitationOps`, `OrchestratorState`).
**`src/app/api/elicit`** — `handleElicit(input, deps)` (pure, testable) + `POST` wrapper.

**`src/lib/p5/`** — `sources.ts` (HTTPS allow-list: NewsAPI / OpenWeather / AlphaVantage; zod-validated per-source),
`feed-ingest.ts` (`ingest(queries, deps?)` — stamps each `FeedItem` with the originating `QueryTerm.weight`),
`relevance.ts` (`scoreItems` — keyword-gate → batched LLM judge → `finalScore = 0.3·kw + 0.7·llm`),
`genome.ts` (`makeGenomeOperators` — seed/crossover/mutate as one-genome `gw.complete()` calls; identity via
`crypto.randomUUID()`, never reused), `esc-adapter.ts` (`runCycle(goalId, deps)` — primitive-based online loop;
fitness = `weightedRelevance × engagementFactor`; offspring slots initialised to `GENOME_PRIOR_SCORE = 0.1`),
`alert-logic.ts` (`raiseAlerts` — threshold `0.75`, `existsOpen` + `duplicateContentInOpenAlerts` (scoped via
`listByIds`), batched LLM justification).
**`src/app/api/signals/route.ts`** — `POST` wraps `runCycle`; one ingest cycle per request.

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

1. **Cull and land `fix/next-build-route-exports`.** Five commits ahead of `main`; the route-export drops
   and the tsconfig adoption are real `next build` unblockers; the gateway markdown-fence strip is a
   deferred R1 item being implemented in parallel. Two commits on the branch (`7609ef4`, `3808cd4`) are
   duplicates of work already on `main` and must drop on rebase. See §8 for the per-commit verdict and the
   recommended interactive-rebase path. Unblocks every downstream concern (P6, deploy, local prod).

2. **Untracked-files hygiene** (5 min). Delete the empty `MathsCloner` file at repo root. Add
   `*.sqlite-shm`, `*.sqlite-wal`, `.coverage` to `.gitignore` (sibling to the existing `*.sqlite`).

3. **`/api/alerts/acknowledge` route + a call site.** P5's engagement factor is structurally pinned near
   the Laplace prior (0.5) for every genome because nothing in the codebase can set `alert.acknowledged = 1`.
   The repo method exists (`alerts.acknowledge(id)`) — it needs a route and any caller. Until this lands,
   P5's selection is relevance-only and the second half of fitness is inert. Cheap.

4. **Deferred minors** — one tidy commit: `queryTermSchema.weight` → `.positive()` in `genome.ts`; consider
   pulling `queryWeight` out of `FeedItemPayload` (it's persisting genome-lineage metadata into source-item
   payload, currently harmless because nothing reads it back). See §8 minor list.

5. **Then the product gaps:** **P6 (a UI)** so a human can use any of this, and **P2/P3** (the
   decomposition + sliding-window that are the product's core promise).

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

---

## 7. Run & test

```bash
npm install
npm test              # vitest — 76 tests (transpiles, does NOT typecheck)
npm run typecheck     # tsc --noEmit — run this too; vitest won't catch type errors. Clean on main.
cp .env.local.example .env.local   # then put a real OPENROUTER_API_KEY in it
# npm run dev          # ⚠️ NEVER ACTUALLY RUN YET — see §9
# npm run build        # ⚠️ CURRENTLY BROKEN on main — see §5 step 1 and §9
```

---

## 8. Deferred items (R1/R2/R3 backlog)

**Quarantined — `fix/next-build-route-exports`. Current commits ahead of `main` (top = newest):**

| Commit | Content | Verdict |
|---|---|---|
| `536c4d5` | `fix(llm-gateway): strip markdown JSON fences` — R1 standing item from this file; live OpenRouter returns fenced JSON | Keep, review |
| `3808cd4` | `docs: refresh HANDOFF.md` — duplicate of `main`'s `dc2fd85` | DROP on rebase (already on main) |
| `ab04ec5` | `chore(next): adopt Next.js tsconfig reconfiguration` — `allowJs`, `noEmit`, `incremental`, `isolatedModules`, `jsx: preserve`, Next plugin, `.next/types/**/*.ts` include | Review/trim — most are standard Next 14; some formatting churn |
| `7609ef4` | `feat(p5): wire QueryTerm.weight into fitness` — duplicate of `main`'s `0f228c3` | DROP on rebase (already on main) |
| `bd86be3` | `fix(next): drop route re-exports + .gitignore + signals-route.test import rewire + feed-ingest ProcessEnv cast` | Split: keep the route-export drops and signals-route test rewire (real `next build` fix); keep the `.gitignore` additions; drop the `as unknown as` ProcessEnv cast (`main` typechecks clean without it) |

Recommended cull path: interactive rebase `bd86be3^..HEAD` — drop `7609ef4` and `3808cd4`; split `bd86be3` to remove the cosmetic ProcessEnv cast; trim `ab04ec5` to the substantive additions; keep `536c4d5` as is. Result: three clean commits (route-build fix, tsconfig adoption, gateway fence-stripping).

**Minor (reviewer-flagged, deliberately deferred during P5 spec-fidelity merge):**
- `src/lib/p5/genome.ts` — `queryTermSchema.weight: z.number()` permits zero/negative; tighten to `.positive()`.
- `src/lib/p5/types.ts:17` — `FeedItemPayload = FeedItem` causes `queryWeight` (genome-lineage metadata)
  to persist into `external_signal.payload_json`. Harmless today, forward risk only.
- `tests/p5/repositories.test.ts` — `listByIds` test shadows the outer `beforeEach` `repos`.
- `tests/p5/feed-ingest.test.ts` — stamping-test fixture omits `totalResults` (schema field is optional).
- `src/lib/store/repositories.ts` — `listByIds` re-prepares its statement per call (variable-arity `IN`).
  Other repo methods use fixed-SQL prepares. Benign at current call rates.

**Standing (pre-existing R1/R2):**
- **Gateway:** request `response_format`/JSON-mode hint; handle markdown-fenced JSON; `res.json()` malformed-body wrap.
- **Store:** cache prepared statements; `SELECT` explicit columns; schema migration/versioning (currently
  `IF NOT EXISTS` only — see §9 risk on the `genome_id` column).
- **ESC/S0:** belief-weight epsilon floor (underflow >~40 updates; we cap at 8); directional `sigma` test.
- **P5 (from spec OQs §10):** OQ-1 concrete feed providers concretized but unmonitored for free-tier drift;
  OQ-2 lexical-vs-embedding similarity; OQ-3 engagement signal is pinned at the Laplace prior until an
  acknowledge route exists (§5 step 3); OQ-4 no migration tracking; OQ-5 separate model for seed vs judge;
  OQ-6 cross-user warm-start priors.

---

## 9. Known risks (see the retrospective for detail)

1. **The app has never been run live.** Tests use mocked/recorded LLM responses. The real OpenRouter prompts
   (S0 operators, P5 seed/crossover/mutate/judge/justify) have never produced real output; `next dev` never executed.
2. **`next build` is broken on `main` right now.** Route re-exports in `src/app/api/elicit/route.ts` and
   `src/app/api/signals/route.ts` violate Next App Router rules. Fix is parked on `fix/next-build-route-exports`;
   see §5 step 1 and §8.
3. **S0 distance metric is brittle for real LLM output.** `distance()` is exact-string Hamming over the 5
   interpretation dimensions. Real LLM interpretations are free-text and rarely string-match, so distances
   collapse to ~1.0 and the belief may barely update. Tests passed only because they used single-token values.
   **This likely needs a semantic distance (embeddings) or enumerated/categorical dimensions before S0 works in practice.**
4. **P5 engagement is structurally inert until an acknowledge route exists.** With no path to set
   `alert.acknowledged = 1`, every genome's `engagementFactor` is `(0+0.5)/(0+1) = 0.5`. Fitness
   collapses to relevance-only. Acceptable per spec OQ-3 but worth knowing.
5. **`external_signal.genome_id` was added via `CREATE TABLE IF NOT EXISTS` + `DEFAULT ''`.** Any SQLite
   file created before this column existed will NOT have it — `IF NOT EXISTS` only creates the table on
   first run; it does not `ALTER` an existing table. Wipe the DB (`*.sqlite` is gitignored) or write a one-off
   `ALTER TABLE`. Per OQ-4 there is no migration framework.
6. **Worker discipline failure mode observed 2026-05-28.** Two consecutive implementer subagents independently
   created their own branches and bundled an out-of-scope `next build` fix into their task commits. The
   orchestrator reconciled via cherry-pick + amend, but it cost real time. The §4 discipline notes capture
   the guardrails that worked (`git branch --show-current` as first and last action; explicit prohibition
   on `tsc`/`next build` as success gates; allowed-files list). Apply them to every implementer dispatch.
7. **No CI** — typecheck/tests are manual; nothing gates a push.
8. `npm audit` reports vulnerabilities in the pinned Next 14.2.5.

---

## 10. Doc index

- `docs/canonical-project-graph.md` — the two canonical representations + 7-subsystem decomposition + decisions.
- `docs/superpowers/specs/2026-05-27-esc-s0-p5-design.md` — first-slice spec.
- `docs/superpowers/specs/2026-05-27-p5-signals-design.md` — P5 spec (built; reconciled with implementation 2026-05-28).
- `docs/superpowers/R1-review-phase-a.md` — interface review after Phase A.
- `docs/superpowers/plans/2026-05-27-spacato-phase-a-foundation.md` — Phase A plan (built).
- `docs/superpowers/plans/2026-05-27-spacato-phase-b-s0-elicitation.md` — S0 plan (built).
- `docs/superpowers/plans/2026-05-28-p5-spec-fidelity.md` — P5 spec-fidelity fixes plan (built, merged to `main`).
- `WORKFLOW.md` — orchestrator/worker conventions.
