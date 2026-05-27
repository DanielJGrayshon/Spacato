# R1 Interface Review — after Phase A (2026-05-27)

Phase A is built and green (15 tests). Branch `phase-a-foundation`. Commits: scaffold `56ffbe0`,
store `40989da`, gateway `f131626`, esc-core `3cd36a3`.

R1's purpose (spec §12): check the `llm-gateway` / `plan-store` / `esc-core` interfaces against the
**real needs of S0 (elicitation) and P5 (signals)** before writing the Phase-B plans, so the parallel
agents don't fight an engine shaped wrong.

## Verdict

The three modules are clean, well-tested, and correctly bounded. **One genuine design question** and a
short list of **interface-hardening items** should be resolved before Phase B fans out. Nothing here is
a defect in what was built — it's about fit for the next layer.

## The one design question (biggest item)

**Does ESC's monolithic `step` (fitness → select → breed → fitness) fit S0's elicitation rhythm?**
Goal elicitation is *ask a pairwise question → update the Bayesian belief → then evolve*. ESC currently
couples select+breed+fitness into one `step`. S0 needs to interleave a belief-update/question phase
between evolution. Options:
- (a) S0 drives `step` for evolution and does belief/question work in its own layer around it (works, but
  the double-`fitness` call per step is wasteful with LLM-backed fitness);
- (b) split ESC into `score`/`select`/`evolve` sub-steps so consumers compose the rhythm they need;
- (c) add an optional `onGeneration` hook.
Recommendation: **(b)** — small refactor, makes ESC genuinely reusable for both the converge-once
(S0) and online (P5) rhythms, and removes the double-fitness waste.

## Interface-hardening items (carried from per-task reviews)

**esc-core**
- No population-size cap: size is governed entirely by `select` output (`breed` returns `2 × parents`).
  A consumer whose `select` returns `k` gets `2k` next gen. → Add explicit `populationSize` to
  `EscConfig` (or document the "select returns target/2" contract). S0 wants a stable K candidates.
- Double `fitness` call per step (wasteful once fitness is LLM-backed). Folds into the design question.

**llm-gateway**
- **Cache-key schema collision:** key uses `schema.description ?? "schema"`; two undescribed schemas with
  same model+messages collide. → Hash schema identity (e.g. stable serialization of the zod def) or
  require `.describe()`. Matters as soon as S0 + P5 use multiple schemas.
- `batchComplete` has no concurrency cap → bursts trigger OpenRouter 429s. P5 ingests many items. → Add a
  bounded-concurrency limit.
- `res.json()` can throw on a 200 non-JSON body; consider a wrap with attributable error.
- No `response_format`/JSON-mode hint in the request; today it trusts the model to emit JSON.

**plan-store**
- Repositories exist only for `goal` + `llm_cache`. S0 needs an `elicitation_state` repo; P5 needs
  `external_signal` + `alert` repos. → Build these as the first step of each Phase-B plan.
- Perf/polish (non-blocking): prepared statements are recompiled per call (cache them at
  `makeRepositories` time); `SELECT *` → explicit columns in `goals.get`.

## Recommended path

1. Apply a focused **R1 hardening pass** to ESC (design question (b) + populationSize) and gateway
   (cache key + batch concurrency). These are shared and block both consumers.
2. Then write the **P1/S0** and **P5** plans (each starts by adding its store repositories), and run them
   as the parallel Phase-B agents.
