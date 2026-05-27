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
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** One ingest cycle (spec §5.9). Uses score/select/evolve directly — never step(). */
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

  // ALERTS (injected — see alert-logic.ts)
  const alerts = await raiseAlerts(signals);

  // 4. SCORE the CURRENT population (carry-forward for non-fetchers; no step())
  const fetchingFitness = mean(scoredItems.map((si) => si.finalScore)) * engagementFactor(repos, fetchingId);
  const cfg: EscConfig<QueryGenome> = {
    maxGenerations: Number.MAX_SAFE_INTEGER,
    populationSize: POPULATION_SIZE,
    seed: ops.seed,
    crossover: ops.crossover,
    mutate: ops.mutate,
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
    bestScore: Math.max(...nextScores),
  };
  repos.queryGenomeState.save(goalId, nextState);

  // 8. RETURN
  return { signals, alerts };
}
