# Spacato — Handoff

> Last updated: 2026-05-27. This is the single document a fresh contributor (human or agent) reads to
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
- `main` — Phase A foundation + S0 elicitation. **34 tests green, `npm run typecheck` clean.** Pushed.
- `p5-signals` — adds the **P5 design spec only** (no P5 code yet) + `HANDOFF.md`/`WORKFLOW.md` updates. Pushed.

**Built (on `main`):**
- **Foundation:** `src/lib/store` (SQLite), `src/lib/llm` (OpenRouter gateway), `src/lib/esc` (evolutionary core).
- **S0 goal elicitation:** `src/lib/s0/*` + `src/app/api/elicit` — full Bayesian pairwise elicitation loop.

**Spec'd but NOT built:** P5 (news/signals) — spec at `docs/superpowers/specs/2026-05-27-p5-signals-design.md`,
peer-gated + reviewed, ready to become a plan.

**Not started:** P2 decomposition (month→week→day), P3 sliding-window re-planner, P4 timetable presets,
**P6 the entire web UI**. ⚠️ **There is no user-facing UI yet and the app has never been run live**
(see §7 and §9). Everything is verified by unit/integration tests with mocked/recorded LLM responses.

---

## 3. Architecture & key interfaces (the API surface you build against)

**`src/lib/esc/core.ts`** — generic LLM-operator evolutionary engine (no LLM dependency itself; operators injected):
- Types: `Genome<T> = {value:T}`; `EscState<T> = {population, scores, generation, bestScore}`;
  `EscConfig<T> = {maxGenerations, populationSize?, seed, crossover, mutate, fitness, select, converged}`.
- Composable primitives: `score(cfg, pop)`, `select(cfg, pop, scores)`, `evolve(cfg|{crossover,mutate}, parents)` (returns `[...parents, ...offspring]`, offspring `m` from parents `m` & `(m+1)%n`).
- Lifecycles: `step(cfg, state)` (one generation, one fitness eval, trims to `populationSize`), `runToConvergence(cfg)`.

**`src/lib/llm/gateway.ts`** — sole OpenRouter choke-point:
- `makeGateway({apiKey, cache, fetchFn?, endpoint?, maxConcurrency?})` → `{ complete<T>(req), batchComplete<T>(reqs) }`.
- `LlmRequest<T> = {model, messages, schema}` (zod). Structured output validated; cached by schema-fingerprint key; `batchComplete` bounded-concurrency. Injectable `fetchFn` → offline tests.

**`src/lib/store/`** — `openDb(file?)`, `makeRepositories(db)` → `goals{create,get,setConvergedSpec}`,
`llmCache{get,put}`, `elicitations{create,get,update}`. Tables in `schema.sql`: `goal`, `elicitation_state`,
`external_signal`, `alert`, `llm_cache`. (P5 adds `query_genome_state` + `genome_id` col + signals/alerts repos.)

**`src/lib/s0/`** — `belief.ts` (`distance, sigma, uniformBelief, updateBelief, entropy`),
`acquisition.ts` (`selectQuestion, expectedPosteriorEntropy`), `operators.ts` (`makeOperators` → seed/crossover/mutate),
`orchestrator.ts` (`startElicitation, answerQuestion`, `ElicitationOps`, `OrchestratorState`).
**`src/app/api/elicit`** — `handleElicit(input, deps)` (pure, testable) + `POST` wrapper.

---

## 4. How we work here (see WORKFLOW.md for the full version)

- **Orchestrator + workers, all primed with the role prompt; peers.** One worker owns a task end-to-end (TDD, commit, self-review).
- **Anti-bloat:** one worker per task; review only tasks with novel logic/math/integration; fixes go to the same worker; prefer heuristics over agents; no check-in theatre.
- **Spec drafting is peer-gated:** drafter writes → a fresh colleague cold-reads and judges "up to scratch" → iterate → only then the orchestrator final-reviews.
- **TDD always; frequent commits; verify before claiming done** (run `npm test` AND `npm run typecheck`).

---

## 5. The next concrete step

Build **P5** from its approved spec: write `docs/superpowers/plans/2026-05-27-spacato-phase-b-p5-signals.md`
(bite-sized TDD tasks), then implement on the `p5-signals` branch via the lean worker workflow. The spec's
build order: store repos (+ `query_genome_state`, `genome_id`) → `sources.ts` → `feed-ingest.ts` →
`relevance.ts` → `genome.ts` → `esc-adapter.ts` → `alert-logic.ts` → `/api/signals` route.

After P5: the highest-value gap is **P6 (a UI) so a human can actually use any of this**, and **P2/P3**
(the decomposition + sliding-window that are the product's core promise).

---

## 6. Key decisions (don't re-litigate without reason)

- Single-user local; Next.js TS; SQLite; key server-side only.
- ESC is a shared primitive backing S0 (converge-once-ish, via orchestrator composing primitives) and P5 (online).
- S0 = full Bayesian pairwise elicitation (Bradley–Terry + info-gain acquisition); operators are LLM (EvoPrompt pattern).
- P5 ESC reuse = adaptive query/source selection only; per-item relevance = keyword-gate + batched LLM judge (heuristic, not evolution); verified-feed allow-list only.

---

## 7. Run & test

```bash
npm install
npm test              # vitest — 34 tests (transpiles, does NOT typecheck)
npm run typecheck     # tsc --noEmit — run this too; vitest won't catch type errors
cp .env.local.example .env.local   # then put a real OPENROUTER_API_KEY in it
# npm run dev          # ⚠️ NEVER ACTUALLY RUN YET — see §9
```

---

## 8. Deferred items (R1/R2 backlog)

- **Gateway:** request `response_format`/JSON-mode hint; handle markdown-fenced JSON; `res.json()` malformed-body wrap.
- **Store:** cache prepared statements; `SELECT` explicit columns; schema migration/versioning (currently `IF NOT EXISTS` only).
- **ESC/S0:** belief-weight epsilon floor (underflow >~40 updates; we cap at 8); directional `sigma` test.
- **P5 (from spec OQs):** concrete feed providers; lexical-vs-embedding similarity; engagement thinness; cross-user warm-start priors (OQ-6).

---

## 9. Known risks (see the retrospective for detail)

1. **The app has never been run live.** Tests use mocked/recorded LLM responses. The real OpenRouter prompts
   (S0 operators, P5 judge) have never produced real output; `next dev`/`next build` never executed.
2. **S0 distance metric is brittle for real LLM output.** `distance()` is exact-string Hamming over the 5
   interpretation dimensions. Real LLM interpretations are free-text and rarely string-match, so distances
   collapse to ~1.0 and the belief may barely update. Tests passed only because they used single-token values.
   **This likely needs a semantic distance (embeddings) or enumerated/categorical dimensions before S0 works in practice.**
3. **No CI** — typecheck/tests are manual; nothing gates a push.
4. `npm audit` reports vulnerabilities in the pinned Next 14.2.5.

---

## 10. Doc index

- `docs/canonical-project-graph.md` — the two canonical representations + 7-subsystem decomposition + decisions.
- `docs/superpowers/specs/2026-05-27-esc-s0-p5-design.md` — first-slice spec.
- `docs/superpowers/specs/2026-05-27-p5-signals-design.md` — P5 spec (approved).
- `docs/superpowers/R1-review-phase-a.md` — interface review after Phase A.
- `docs/superpowers/plans/2026-05-27-spacato-phase-a-foundation.md` — Phase A plan (built).
- `docs/superpowers/plans/2026-05-27-spacato-phase-b-s0-elicitation.md` — S0 plan (built).
- `WORKFLOW.md` — orchestrator/worker conventions.
