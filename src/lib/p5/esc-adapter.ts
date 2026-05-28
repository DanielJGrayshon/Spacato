import { score, select, evolve, type Genome, type EscState, type EscConfig } from "@/lib/esc/core";
import type { Repositories } from "@/lib/store/repositories";
import type { QueryGenome, FeedItem, ScoredItem, StoredSignal, Alert } from "@/lib/p5/types";

export const GENOME_PRIOR_SCORE = 0.1;
export const POPULATION_SIZE = 4;

/** Truncation selection: top ceil(n/2) genomes by score (spec §5.7). */
export const selectTop = (pop: Genome<QueryGenome>[], scores: number[]): Genome<QueryGenome>[] =>
  scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.ceil(pop.length / 2))
    .map(({ i }) => pop[i]);

/** Laplace-smoothed engagement: (acked + 0.5) / (total + 1) (spec §5.6). */
export function engagementFactor(repos: Repositories, genomeId: string): number {
  const { acked, total } = repos.alerts.engagementCounts(genomeId);
  return (acked + 0.5) / (total + 1);
}

export interface CycleDeps {
  repos: Repositories;
  ops: {
    seed(): Promise<Genome<QueryGenome>[]>;
    crossover(a: Genome<QueryGenome>, b: Genome<QueryGenome>): Promise<Genome<QueryGenome>>;
    mutate(g: Genome<QueryGenome>): Promise<Genome<QueryGenome>>;
  };
  ingest: (queries: QueryGenome["queries"]) => Promise<FeedItem[]>;
  scoreItems: (items: FeedItem[]) => Promise<ScoredItem[]>;
  raiseAlerts: (signals: StoredSignal[]) => Promise<Alert[]>;
}

const argmax = (xs: number[]): number => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

/** Relevance component of fitness: mean of finalScore weighted by each item's originating
 *  query-term weight (spec §5.1 — weight is "used by fitness"). selectTop then ranks on this
 *  fitness, so weight feeds selection transitively (§5.7). Missing weight defaults to 1. */
const weightedRelevance = (items: ScoredItem[]): number => {
  const wsum = items.reduce((a, si) => a + (si.item.queryWeight ?? 1), 0);
  if (wsum === 0) return 0;
  return items.reduce((a, si) => a + si.finalScore * (si.item.queryWeight ?? 1), 0) / wsum;
};

/** One ingest cycle (spec §5.9). Uses score/select/evolve directly, NOT step():
 *  step() evaluates fitness on the post-evolution offspring and trims by score, which would
 *  lose carry-forward and the offspring floor. This online loop scores the CURRENT population
 *  (fresh score for the fetcher, prior scores carried for the rest), THEN evolves.
 *
 *  Invariant: genome `value.id`s are unique within a population — minted fresh via
 *  crypto.randomUUID() in genome.ts at seed/crossover/mutate, never reused. The fitness
 *  closure and signal attribution below both key on this id and rely on that uniqueness. */
export async function runCycle(goalId: number, deps: CycleDeps): Promise<{ signals: StoredSignal[]; alerts: Alert[] }> {
  const { repos, ops, ingest, scoreItems, raiseAlerts } = deps;

  // 1. LOAD (or seed on first cycle)
  let state = repos.queryGenomeState.get(goalId);
  if (!state) {
    const population = await ops.seed();
    state = { population, scores: population.map(() => GENOME_PRIOR_SCORE), generation: 0, bestScore: GENOME_PRIOR_SCORE };
  }

  // 2. PICK the single top-scoring genome to fetch
  const topIdx = argmax(state.scores);
  const fetchingGenome = state.population[topIdx];
  const fetchingId = fetchingGenome.value.id;

  // 3. FETCH + SCORE items, store EVERY scored item
  const items = await ingest(fetchingGenome.value.queries);
  const scoredItems = await scoreItems(items);
  const signals: StoredSignal[] = scoredItems.map((si) =>
    repos.signals.create({
      goalId,
      genomeId: fetchingId,
      source: si.item.source,
      kind: si.item.kind,
      payload: si.item,
      relevanceScore: si.finalScore,
    })
  );

  // Engagement reflects acknowledged alerts from PAST cycles (spec §5.6). Capture it BEFORE
  // this cycle's raiseAlerts inserts new (unacknowledged) rows, so the fetcher's own fresh
  // alerts don't transiently depress its engagement this generation.
  const fetchingEngagement = engagementFactor(repos, fetchingId);

  // ALERTS (injected — see alert-logic.ts)
  const alerts = await raiseAlerts(signals);

  // 4. SCORE the CURRENT population (carry-forward for non-fetchers; no step())
  const fetchingFitness = weightedRelevance(scoredItems) * fetchingEngagement;
  const cfg: EscConfig<QueryGenome> = {
    maxGenerations: Number.MAX_SAFE_INTEGER,
    populationSize: POPULATION_SIZE,
    seed: ops.seed,
    crossover: ops.crossover,
    mutate: ops.mutate,
    // Precondition: invoked only as score(cfg, state.population) below, so `i` is index-aligned
    // to state.scores. The fetcher is matched by stable id (reorder-safe); carry-forward is by index.
    fitness: async (pop) => pop.map((gen, i) => (gen.value.id === fetchingId ? fetchingFitness : state!.scores[i])),
    select: selectTop,
    converged: () => false,
  };
  const fitnesses = await score(cfg, state.population);

  // 5. SELECT parents, 6. EVOLVE offspring
  const parents = select(cfg, state.population, fitnesses);
  const nextPop = await evolve(cfg, parents);

  // 7. PERSIST: parent fitnesses kept; offspring slots floored to the prior
  const parentScores = parents.map((p) => fitnesses[state!.population.indexOf(p)]);
  const offspringScores = nextPop.slice(parents.length).map(() => GENOME_PRIOR_SCORE);
  const nextScores = [...parentScores, ...offspringScores];
  const nextState: EscState<QueryGenome> = {
    population: nextPop,
    scores: nextScores,
    generation: state.generation + 1,
    // Per-generation max of the persisted scores (not an all-time high-water mark). Nothing
    // in the cycle reads bestScore for decisions — argmax uses `scores`.
    bestScore: Math.max(...nextScores),
  };
  repos.queryGenomeState.save(goalId, nextState);

  // 8. RETURN
  return { signals, alerts };
}
