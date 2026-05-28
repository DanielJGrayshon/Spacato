# Spacato — S0 Semantic Distance Design Spec

> Date: 2026-05-28 · Status: **drafted post-live-run** · Repo: github.com/DanielJGrayshon/Spacato
> Parent docs: `docs/superpowers/specs/2026-05-27-esc-s0-p5-design.md`, HANDOFF.md §9 risk #2.
> Agents building this adopt the canonical role prompt (see HANDOFF.md §0).

---

## 1. Overview & scope

Replace S0's exact-string Hamming `distance()` with a **semantic distance** derived from OpenRouter
embeddings of each goal interpretation, with a deterministic **token-Jaccard fallback** when a vector
is missing or embedding fails. Embeddings are computed **eagerly** at op-output time and stored in a
content-addressed **sidecar map** on `ElicitationState`. A `DistanceFn` is injected into the belief
math (`sigma`, `updateBelief`, `expectedPosteriorEntropy`, `selectQuestion`), keeping those functions
distance-agnostic and trivially unit-testable.

**Why now.** The first live OpenRouter elicitation produced four real interpretations for "run a
marathon in 6 months" (finishing-focused / capability / participation / time-goal) that shared **zero
exact-token matches** across the five `GoalInterpretation` dimensions. With the existing exact-string
distance, every pairwise distance collapsed to ≈ 1.0 and the Bayesian belief barely moves on any
answer — natural convergence is practically impossible. HANDOFF §9 risk #2 anticipated exactly this.

**In scope**
- `embed` / `embedBatch` extension on `llm-gateway` (OpenRouter `/embeddings` endpoint, cached).
- `vectors_json` sidecar column on `elicitation_state` + repo round-trip.
- `cosineDistance` + `jaccardDistance` primitives, `makeDistanceFn(vectors)` factory.
- `DistanceFn` parameter on `sigma` / `updateBelief` / `expectedPosteriorEntropy` / `selectQuestion`.
- Orchestrator owns the embedding lifecycle: hash → check sidecar → embed if absent → persist.
- `TAU` recalibration (start 0.2, tunable).

**Out of scope** (deliberately deferred; see §10)
- Belief-weight epsilon floor (HANDOFF §8 deferred item — not blocking at 8–12 question depths).
- Per-field weighting (e.g. scope ranked higher than motivation).
- Convergence-predicate changes.
- A migration mechanism for legacy `elicitation_state` rows without `vectors_json` (v1 stance: column
  default `'{}'` lets old rows continue silently; new rows accumulate vectors).
- Embedding model swap heuristics; we ship one model and a single env-var override.

---

## 2. Goals & non-goals

**Goals**
- A `selectQuestion`/`updateBelief` loop that **actually discriminates** between real LLM-generated
  free-text interpretations. Verified by an integration test that drives `start` + one `answer` with
  deterministic stub vectors and asserts the belief moves in a direction the old exact-Hamming
  distance could not produce.
- Belief math stays a pure functional core. All four belief/acquisition functions remain side-effect
  free; the only new dependency they take is a `DistanceFn` parameter.
- Embedding failures never fail the cycle. Missing vector ⇒ Jaccard fallback for that pair.
- All LLM I/O continues to route through `llm-gateway`, which now caches embeddings the same way it
  caches chat completions (model-keyed, never collides across schemas/inputs).

**Non-goals**
- Replacing the entire elicitation algorithm. Bradley–Terry preference model + info-gain question
  acquisition are unchanged.
- Storing or transmitting embedding vectors anywhere outside the local SQLite + `llm_cache`.
- Cross-goal vector sharing or cross-user warm-start (OQ-6 from P5 still applies and is still out
  of scope).
- Heuristic re-tuning of `acquisition.expectedPosteriorEntropy` or its info-gain definition.

---

## 3. Architecture & data flow

```
seed/crossover/mutate                  orchestrator                                belief / acquisition
  (s0/operators.ts)                    (s0/orchestrator.ts)                        (s0/belief.ts, s0/acquisition.ts)
        │                                       │                                              │
   GoalInterpretation                           │                                              │
        ▼                                       │                                              │
                            ┌──────────────────────────────────────┐                           │
                            │ for each new Genome.value:           │                           │
                            │   key = contentHash(value)           │                           │
                            │   if vectors[key] absent:            │                           │
                            │     try v = await gw.embed(          │                           │
                            │            stringify(value),          │                           │
                            │            S0_EMBED_MODEL)            │                           │
                            │     catch -> warn, skip              │                           │
                            │   vectors[key] = v   (if obtained)   │                           │
                            └──────────────────────────────────────┘                           │
                                                │                                              │
                            distance = makeDistanceFn(vectors):                                │
                              (a, b) => {                                                      │
                                va = vectors[contentHash(a)];                                  │
                                vb = vectors[contentHash(b)];                                  │
                                return (va && vb)                                              │
                                  ? cosineDistance(va, vb)                                     │
                                  : jaccardDistance(a, b);                                     │
                              }                                                                │
                                                ▼                                              ▼
                                       (passed as the new           sigma(pop, k, i, j, distance)
                                        DistanceFn argument         updateBelief(belief, pop, q,
                                        on every call)              answer, distance)
                                                                    selectQuestion(belief, pop,
                                                                    distance)
                                                ▼
                            persist:
                              elicitations.update({
                                ...,
                                vectors: state.vectors   // round-trips as vectors_json
                              })
```

**Eager** (not lazy). `distance()` stays sync; the embedding call is awaited *before* the belief math
runs each step. Tests can construct a `DistanceFn` from any function literal.

**Content-addressed.** The sidecar is keyed by `contentHash(GoalInterpretation)`. Two identical
interpretations dedup naturally. A mutated interpretation produces a new hash → new embedding call →
new sidecar entry. Stale entries are harmless (cheap to keep; eventually pruned when older
elicitations are deleted) but a follow-up sweep can drop keys not currently referenced by `population`
if the table size becomes a concern.

---

## 4. Components & file surface

| File | Change | Responsibility |
|---|---|---|
| `src/lib/llm/gateway.ts` | extend | Add `embed(text, model)` and `embedBatch(texts, model)`. POST `https://openrouter.ai/api/v1/embeddings` (overrideable via the existing `endpoint`/`embeddingEndpoint` dep). Caches by `hash(model, text)` via the same `cache` port. Bounded concurrency same as `batchComplete`. |
| `src/lib/util/text.ts` | create | Move `tokenise` + `STOP_WORDS` here from `p5/relevance.ts`. Both `relevance.ts` and `belief.ts`'s `jaccardDistance` import from this single source. |
| `src/lib/util/hash.ts` | create | Tiny module exporting `contentHash(value): string`. Implementation: `sha256(canonicalJson(value)).slice(0, 16)`. Uses `node:crypto`. `canonicalJson` sorts object keys recursively. |
| `src/lib/store/schema.sql` | modify | Add `vectors_json TEXT NOT NULL DEFAULT '{}'` to `elicitation_state`. Additive; `IF NOT EXISTS` semantics on table creation; pragma `ALTER TABLE … ADD COLUMN` for existing DBs would be a follow-up, but for v1 (single-user local, easy to wipe) the default suffices. |
| `src/lib/store/types.ts` | modify | Extend `ElicitationState` with `vectors: Record<string, number[]>`. |
| `src/lib/store/repositories.ts` | modify | `elicitations.create` / `get` / `update` round-trip `vectors_json` ↔ `state.vectors`. Default to `{}` when absent. |
| `src/lib/s0/belief.ts` | rewrite | Add `cosineDistance(u, v)`, `jaccardDistance(a, b)`, `makeDistanceFn(vectors)`, `type DistanceFn`. Refactor `sigma` / `updateBelief` / (transitively) `expectedPosteriorEntropy` to accept `distance: DistanceFn`. Remove the old exact-Hamming `distance`. `TAU` becomes `exported const` (initial 0.2). |
| `src/lib/s0/acquisition.ts` | modify | `expectedPosteriorEntropy` and `selectQuestion` take `distance: DistanceFn`. |
| `src/lib/s0/orchestrator.ts` | modify | After each `ops.seed / crossover / mutate`, compute `contentHash`, embed-if-absent into `state.vectors`. Build `DistanceFn` via `makeDistanceFn(state.vectors)` and pass into `selectQuestion` / `updateBelief`. Operator boundary stays pure. |
| `src/lib/s0/elicit-handler.ts` | modify (small) | Pass the gateway and embed model through to the orchestrator. |
| `src/app/api/elicit/route.ts` | modify (small) | Read `S0_EMBED_MODEL` env var (default `openai/text-embedding-3-small`); pass through. |

**Import graph** stays acyclic. New util modules sit below `s0/*` and `p5/*` (already imported by
`s0/operators.ts`'s pattern); no cycles introduced.

---

## 5. Data model

### 5.1 `ElicitationState` extension

```ts
export interface ElicitationState {
  id: number;
  goalId: number;
  generation: number;
  population: Genome<GoalInterpretation>[];
  beliefWeights: number[];
  pendingQuestion: ElicitationQuestion | null;
  status: "active" | "converged";
  vectors: Record<string, number[]>;   // content-hash -> embedding vector
}
```

### 5.2 Schema change

```sql
CREATE TABLE IF NOT EXISTS elicitation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  generation INTEGER NOT NULL DEFAULT 0,
  population_json TEXT NOT NULL DEFAULT '[]',
  belief_json TEXT NOT NULL DEFAULT '{}',
  pending_question_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  vectors_json TEXT NOT NULL DEFAULT '{}'
);
```

`IF NOT EXISTS` means existing local DBs do not pick up the new column automatically. The v1 stance:
wipe-and-reinit during development is acceptable (P5 OQ-4 stance). A `migrations/` mechanism is a
later concern.

### 5.3 `vectors_json` payload shape

```json
{
  "a1b2c3d4e5f60718": [0.0312, -0.0145, ..., 0.0089],  // 1536 floats for text-embedding-3-small
  "f0e9d8c7b6a59483": [...]
}
```

Per-elicitation typical size: 4 seed + ~2 offspring per cycle × number of cycles. A 12-cycle session
≈ 4 + 24 = 28 vectors × 1536 floats × 8 bytes ≈ 344 KB. Acceptable in SQLite.

---

## 6. Math & signatures

### 6.1 Content hash

```ts
// src/lib/util/hash.ts
import { createHash } from "node:crypto";

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((v as any)[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}
```

16-hex chars = 64 bits — collision-free at our scale by many orders of magnitude.

### 6.2 Gateway embedding

```ts
// additions to src/lib/llm/gateway.ts
export interface GatewayDeps {
  // ...existing
  embeddingEndpoint?: string;   // default https://openrouter.ai/api/v1/embeddings
}

async function embed(text: string, model: string): Promise<number[]> {
  const hash = promptHash(model, [], `embed:${text}`);   // schema-free; suffix to disambiguate from chat cache
  const cached = deps.cache.get(hash, model);
  if (cached !== undefined) return cached as number[];

  const res = await fetchFn(embeddingEndpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`OpenRouter embeddings ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    throw new Error(`OpenRouter: no embedding in response for model "${model}"`);
  }
  deps.cache.put(hash, model, vec);
  return vec;
}

async function embedBatch(texts: string[], model: string): Promise<number[][]> {
  // bounded-concurrency worker pool — same shape as batchComplete
}
```

### 6.3 Distance primitives

```ts
// src/lib/s0/belief.ts
export type DistanceFn = (a: GoalInterpretation, b: GoalInterpretation) => number;

export function cosineDistance(u: number[], v: number[]): number {
  if (u.length !== v.length) throw new Error("s0: cosine on mismatched vector dims");
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  if (nu === 0 || nv === 0) return 1;          // degenerate; treat as maximally distant
  const cos = dot / (Math.sqrt(nu) * Math.sqrt(nv));
  const d = (1 - cos) / 2;                     // [-1,1] -> [0,1]
  return Math.min(1, Math.max(0, d));          // clamp float bleed
}

export function jaccardDistance(a: GoalInterpretation, b: GoalInterpretation): number {
  const ta = new Set(tokenise([a.scope, a.successMetric, a.constraints, a.motivation, a.deadlineShape].join(" ")));
  const tb = new Set(tokenise([b.scope, b.successMetric, b.constraints, b.motivation, b.deadlineShape].join(" ")));
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

export function makeDistanceFn(vectors: Record<string, number[]>): DistanceFn {
  return (a, b) => {
    const va = vectors[contentHash(a)];
    const vb = vectors[contentHash(b)];
    return (va && vb) ? cosineDistance(va, vb) : jaccardDistance(a, b);
  };
}
```

### 6.4 Belief / acquisition signatures (the contract change)

```ts
// belief.ts
export const TAU = 0.2;                       // tunable
export function sigma(pop, k, i, j, distance: DistanceFn): number;
export function updateBelief(belief, pop, q, answer, distance: DistanceFn): Belief;

// acquisition.ts
export function expectedPosteriorEntropy(belief, pop, q, distance: DistanceFn): number;
export function selectQuestion(belief, pop, distance: DistanceFn): ElicitationQuestion | null;
```

All four functions previously called the module-level `distance(a, b)` directly. They now receive
`distance` as the last parameter. The orchestrator builds it once per request via `makeDistanceFn`.

---

## 7. Embedding lifecycle

The orchestrator owns it. Operators stay pure (`GoalInterpretation` in, `GoalInterpretation` out).

```
orchestrator.startElicitation / answerQuestion:
  1. load state (with sidecar)
  2. ops.seed / crossover / mutate as before
  3. for each new genome:
       k = contentHash(genome.value)
       if (!state.vectors[k]) try {
         state.vectors[k] = await gw.embed(JSON.stringify(genome.value), embedModel)
       } catch (err) { console.warn(...); /* leave absent → Jaccard fallback */ }
  4. distance = makeDistanceFn(state.vectors)
  5. nextQuestion = selectQuestion(belief, pop, distance)
  6. on answer: belief = updateBelief(belief, pop, q, answer, distance)
  7. persist state (population, belief, vectors_json)
```

**Stringification** uses raw `JSON.stringify(genome.value)` (the bare interpretation object). Same
text in → same cache hit; key-order changes are absorbed by `contentHash`'s canonical form, which is
also what the sidecar key uses. The `embed` cache uses the literal stringification (model-keyed), so
key-order *could* theoretically cause a cache miss if a later version of JS reorders keys; in
practice modern V8 preserves insertion order and we always construct interpretations the same way.
Acceptable.

**No batching at v1.** Each new genome is one `embed` call. `embedBatch` exists in the gateway but
the orchestrator calls `embed` per genome for clarity. A later optimisation can collect all new
hashes in a generation and batch them.

---

## 8. Error handling & fallback

| Failure | Behaviour |
|---|---|
| `gw.embed` throws (network, rate-limit, OpenRouter 5xx) | Orchestrator logs a warning, skips that vector. Subsequent `distance(a, b)` for any pair containing that interpretation falls through to `jaccardDistance`. |
| Embedding model returns malformed JSON | `gateway.embed` throws an attributable error (`OpenRouter: no embedding in response`). Same catch path as above. |
| `cosineDistance` called with mismatched dims | Throws — this should never happen (single model in use); surfacing it loudly catches a model-swap or cache-poisoning bug. |
| Tokenisation returns empty set on both operands | `jaccardDistance` returns 0 (defined; means "as similar as we can say without any signal"). This is rare; only if both interpretations are all stop-words. |
| `vectors_json` corrupt / unparseable on read | `elicitations.get` falls back to `{}` and logs a warning. Next cycle re-embeds. |
| Zero-magnitude embedding vector | `cosineDistance` returns 1 (maximally distant). Almost never happens with real models. |

---

## 9. Testing strategy

All deterministic. No real OpenRouter calls in CI. Recorded fetch fixtures mirror the existing
gateway-test pattern.

### 9.1 Unit (no LLM)

| Module | Test |
|---|---|
| `util/text.ts` | `tokenise` matches the behaviour the relevance tests already pin (this is an extraction, not a rewrite). |
| `util/hash.ts` | `contentHash` is deterministic; key-order-invariant (object literal with reordered keys → identical hash); two semantically-different inputs → different hashes. |
| `belief.cosineDistance` | Identical → 0; antipodal → 1; orthogonal → 0.5; mismatched dims → throws. |
| `belief.jaccardDistance` | Identical → 0; disjoint tokens → 1; partial overlap → in `(0, 1)`. Both empty → 0. |
| `belief.makeDistanceFn` | Both vectors present → cosine path; either missing → Jaccard path. |
| `belief.sigma` / `updateBelief` / `entropy` | Existing 8 tests keep their assertions; signatures change to take a synthetic `distance: DistanceFn` (e.g. `(a,b) => a.scope===b.scope ? 0 : 1`). Proves the plumbing without committing to embeddings. |
| `acquisition.expectedPosteriorEntropy` / `selectQuestion` | Same treatment — synthetic distance fn. |

### 9.2 Gateway

| Test |
|---|
| `gw.embed` returns the vector from a recorded `data:[{embedding:[…]}]` response. |
| Identical second `embed(text, model)` call serves from cache (zero extra fetches). |
| `gw.embed` throws an attributable error when `data[0].embedding` is missing. |
| `gw.embedBatch` resolves all requests; respects `maxConcurrency`. |

### 9.3 Integration

| Test |
|---|
| **`elicitations` repo round-trip**: `create / update / get` carries `vectors` losslessly. |
| **Orchestrator embed-on-add**: stub gateway returns a deterministic vector per text; assert every new genome's content-hash ends up in the persisted `state.vectors` and stale keys aren't blown away. |
| **`elicit-handler` semantic discrimination**: drive `start` (4 genomes with stub vectors that span "marathon-finish" vs "stock-market" semantic poles) → one `answer "a"` → assert the belief weight on the semantically-far candidate dropped meaningfully (e.g. ≥ 25%) where exact-Hamming would have left it unchanged. This is the regression guard for the bug we're fixing. |

Expected suite total: **77 → ~86** (≈ +9 new tests). All deterministic.

### 9.4 Manual / live (out of CI)

After merge, run a live elicit cycle against real OpenRouter; observe that on the same "run a
marathon" goal the first answer now meaningfully updates the belief (where it didn't before), and
the second question is informative rather than coincidental.

---

## 10. Open questions / deferred

**OQ-1 — TAU tuning.** Initial value `0.2` is informed but not measured. After the first live
convergence run, evaluate whether the belief moves too fast (one wrong answer collapses) or too slow
(many answers needed). Tune via a single constant; no structural change required.

**OQ-2 — Per-field weighting.** All five fields contribute equally to the concatenated text we embed.
A weighted scheme (e.g. `scope` × 2, `motivation` × 0.5) may improve discrimination once we have
real convergence data. Defer.

**OQ-3 — Schema migration.** `IF NOT EXISTS` on the table won't add `vectors_json` to existing DBs.
Same stance as P5 OQ-4: v1 single-user local; wipe-and-reinit during dev. A `migrations/` mechanism
is a real follow-up before any shared deployment.

**OQ-4 — Sidecar pruning.** Stale entries (vectors for interpretations no longer in the active
population after several generations) live forever in `vectors_json`. Cheap (≈ 12 KB per stale
entry), but a sweep on each `update` keyed by current `population` content-hashes would keep it
tidy. Defer until the table size matters.

**OQ-5 — Belief-weight underflow.** Independent HANDOFF §8 item: belief weights underflow after
~40 updates; current cap is 8. Address separately when convergence depth grows past that horizon.

**OQ-6 — Cross-user warm-start priors.** Same as P5 OQ-6. Not v1.

**OQ-7 — Embedding-model swap and `cosineDistance` dim-mismatch.** When/if we switch models, all
existing vectors become stale. Current behaviour: `cosineDistance` throws on dim mismatch, surfacing
the bug. A clean swap means flushing the embeddings cache + `vectors_json` for active elicitations.
Acceptable manual step at v1; not worth automating yet.

---

## 11. Cost

Live `text-embedding-3-small` at $0.02 per 1M tokens. Concatenated 5-field interpretation ≈ 80 tokens.
- Seed: 4 vectors × 80 tokens × $0.02 / 1M ≈ **$0.0000064** per goal start.
- Per question answered: 1–2 new offspring → 1–2 embeddings ≈ **$0.0000016** per turn.
- A 12-turn elicitation to convergence: well under **one tenth of a cent**.

Negligible.
