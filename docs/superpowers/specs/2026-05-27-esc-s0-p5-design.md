# Spacato — First-Slice Design Spec: ESC Core + S0 Elicitation + P5 Signals

> Date: 2026-05-27 · Status: **awaiting user review** · Repo: github.com/DanielJGrayshon/Spacato
> Canonical project graph: `docs/canonical-project-graph.md`
> Agents building this adopt the **canonical role prompt** (see canonical graph §4b).

## 1. Overview & scope

Spacato is a single-user, local AI goal-planning app (Next.js/TypeScript, SQLite, OpenRouter).
This spec covers the **first buildable slice**: the shared evolutionary engine and its first two
consumers.

**In scope**
- `llm-gateway` — OpenRouter access, batching, caching, structured output.
- `esc-core` — generic LLM-operator evolutionary search engine (online-capable).
- `plan-store` — SQLite schema + typed repositories for this slice's entities.
- `s0-elicitation` — full Bayesian active goal elicitation, producing a `converged_spec`.
- `p5-signals` — verified-feed ingest, ESC-driven source selection, relevance scoring, alerts.

**Out of scope (later specs):** decomposition (month→week→day), 2-week sliding-window re-planner,
timetable presets, the full web UI shell. A **minimal** dev UI (a single page to drive elicitation and
view signals) is in scope only as a test harness, not the product UI.

## 2. Goals & non-goals

**Goals**
- A runnable loop: free-text goal → ≤ a handful of pairwise questions → stored `converged_spec`.
- A second runnable loop: goal → adaptively-selected verified feeds → relevance-scored items → alerts.
- ESC proven reusable by *two* consumers with different lifecycles (converge-once vs online).
- Heuristics-first; LLM calls batched and cached; OpenRouter key never in the browser bundle.

**Non-goals**
- Multi-user, auth, hosting, billing.
- Polished UX (deferred to UI-shell spec).
- Decomposition/scheduling logic (deferred).

## 3. Architecture

```
Browser (Next.js client)
  └── dev harness page  ── fetch ──►  Next API routes (server)
                                        ├── /api/elicit   → s0-elicitation
                                        ├── /api/signals  → p5-signals
                                        └── /api/llm/*     → llm-gateway (key lives here only)
server modules:
  s0-elicitation ─┐
  p5-signals ─────┤── esc-core ── llm-gateway
                  └── plan-store (SQLite)
```

All five units are server-side TypeScript modules with explicit interfaces. The client never holds the
OpenRouter key; every model call passes through `/api/llm/*`.

## 4. Data model (`plan-store`, SQLite)

Tables for this slice (later specs add monthly/weekly/day/preset tables):

- `goal(id, title, raw_text, converged_spec_json, status, created_at, updated_at)`
- `elicitation_state(id, goal_id, generation, population_json, belief_json, pending_question_json, status)`
- `external_signal(id, goal_id, source, kind, payload_json, relevance_score, fetched_at)`
- `alert(id, signal_id, goal_id, impact_score, message, created_at, acknowledged)`
- `llm_cache(prompt_hash, model, response_json, created_at)` — gateway response cache.

Repositories expose typed CRUD; no raw SQL leaks past `plan-store`. Migrations are plain SQL files run
at startup.

## 5. `llm-gateway`

- Single choke point for OpenRouter. Reads key from server env (`OPENROUTER_API_KEY`), never exposed.
- **Structured output:** every call takes a JSON schema; responses validated before return.
- **Batching:** a `batchComplete(requests[])` that coalesces independent prompts in one round-trip where
  the model/endpoint allows, else bounded-concurrency fan-out.
- **Caching:** content-addressed by `(prompt_hash, model)` in `llm_cache`; deterministic tests hit cache.
- **Model routing:** a small policy map (cheap model for operators/judging, stronger for seeding).

## 6. `esc-core` (the shared engine)

Generic over a genome type `T`:

```ts
interface Genome<T> { value: T }
interface EscConfig<T> {
  seed(ctx): Promise<Genome<T>[]>;            // LLM-backed
  crossover(a: Genome<T>, b: Genome<T>): Promise<Genome<T>>;  // LLM, batched
  mutate(g: Genome<T>): Promise<Genome<T>>;   // LLM, batched
  fitness(pop: Genome<T>[]): Promise<number[]>;// pluggable (S0: belief-driven; P5: relevance)
  select(pop, scores): Genome<T>[];           // deterministic
  converged(state): boolean;                  // deterministic
}
```

- **Lifecycles:** `runToConvergence(config)` (S0) and `step(config, state)` for an externally-driven
  online loop (P5). Same operators, different wrappers.
- **Deterministic parts** (selection, elitism, scheduling) have no LLM dependency → unit-testable with a
  **mock fitness** that rewards proximity to a hidden target genome.

## 7. `s0-elicitation` — full Bayesian active elicitation (no shortcuts)

Genome = structured goal interpretation across dimensions: `scope, success_metric, constraints,
motivation, deadline_shape` (extensible). Built **componentwise** (each independently testable, parallel
subagents per the build plan):

1. **Belief model** — posterior weight per candidate (particle representation of the LLM-generated
   population). Update via a **Bradley–Terry / logistic** preference likelihood from each pairwise answer.
2. **Acquisition** — select the next pairwise comparison maximising **expected information gain
   (mutual information)** over the posterior; tie-break / sanity-check against **setwise minimax regret**.
3. **Operators** — ESC `seed/crossover/mutate` evolve the population between question rounds.
4. **Convergence** — posterior **entropy** below threshold, or explicit user confirm. Emits
   `converged_spec` written to `goal.converged_spec_json`.

Budget guard: surface ≤1–2 questions per generation; hard cap on total questions with graceful
"best-so-far" finalisation.

**SOTA basis:** EvoPrompt (LLM operators), BOPE / setwise-minimax-regret / entropy-pursuit (acquisition),
NeurIPS-2024 deep Bayesian active learning for LLM preferences. (Refs in canonical graph §5.)

## 8. `p5-signals` — verified feeds, ESC source selection, alerts

- **Source allow-list:** only verified/secure feeds (e.g. reputable news APIs over HTTPS, a weather API,
  a market-data API). Allow-list is config; no arbitrary URL fetching.
- **ESC reuse (online lifecycle):** genome = a *query/source-filter set* per goal; fitness = relevance ×
  implicit engagement; `esc-core.step` adapts the query set over time as goals/news drift.
- **Per-item relevance (heuristic, not evolution):** embedding similarity to `converged_spec` +
  an LLM relevance judge (batched). Score stored on `external_signal`.
- **Alerts:** deterministic threshold on relevance/impact → `alert` row. "Directly affects goal" = score
  above a high threshold + LLM one-line justification.

## 9. Build sequencing & parallelisation

- **Phase A (sequential):** `llm-gateway` → `plan-store` → `esc-core`. Shared state; built first.
- **Phase B (parallel, role-primed subagents):** `s0-elicitation` ‖ `p5-signals`.
- Within `s0-elicitation`, the four components (§7) may be built by parallel subagents against agreed
  interfaces.

## 10. Testing strategy

- `esc-core`: deterministic loop tests via mock fitness (hidden-target genome); convergence guaranteed.
- `llm-gateway`: recorded-response cache → deterministic, no live calls in CI.
- `s0-elicitation`: belief update + acquisition tested on synthetic preference oracles (known utility);
  assert question-count stays low and posterior entropy falls.
- `p5-signals`: relevance judge against a small hand-labelled fixture set; alert thresholds unit-tested.
- One end-to-end smoke test per loop using recorded LLM responses.

## 11. Security & key handling

- `OPENROUTER_API_KEY` in `.env.local` (gitignored), read only server-side in `llm-gateway`.
- External feeds restricted to a vetted HTTPS allow-list; responses schema-validated before storage.
- No secrets in client bundle; no arbitrary outbound fetch.

## 12. Revision stages

Per the user's "with revision stages if needed":
- **R0** spec review (this document) → user sign-off.
- **R1** after Phase A: review ESC/gateway/store interfaces against real usage before Phase B fans out.
- **R2** after Phase B: review elicitation question-count and relevance quality; tune thresholds.
Each stage may loop back and amend this spec.

## 13. Open questions (resolve at R1 unless flagged)

- Exact verified-feed providers for P5 (news/weather/market) — pick concrete APIs at R1.
- Default OpenRouter models for seed vs operator vs judge roles.
- Genome dimension list for goal interpretation — may extend after first real goals.
