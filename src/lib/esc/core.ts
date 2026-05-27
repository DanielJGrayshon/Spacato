export interface Genome<T> { value: T }
export interface EscState<T> { population: Genome<T>[]; scores: number[]; generation: number; bestScore: number; }
export interface EscConfig<T> {
  maxGenerations: number;
  /** Optional cap. If set, step() trims the population to the top-scoring `populationSize` each generation. */
  populationSize?: number;
  seed(): Promise<Genome<T>[]>;
  crossover(a: Genome<T>, b: Genome<T>): Promise<Genome<T>>;
  mutate(g: Genome<T>): Promise<Genome<T>>;
  fitness(pop: Genome<T>[]): Promise<number[]>;
  select(pop: Genome<T>[], scores: number[]): Genome<T>[];
  converged(state: EscState<T>): boolean;
}

function maxScore(scores: number[]): number {
  if (scores.length === 0) {
    throw new Error("esc-core: empty population — seed() or select() returned no genomes");
  }
  return Math.max(...scores);
}

/** Composable primitive: evaluate fitness for a population. */
export async function score<T>(cfg: EscConfig<T>, population: Genome<T>[]): Promise<number[]> {
  return cfg.fitness(population);
}

/** Composable primitive: choose parents from a scored population. */
export function select<T>(cfg: EscConfig<T>, population: Genome<T>[], scores: number[]): Genome<T>[] {
  return cfg.select(population, scores);
}

/** Composable primitive: next population = parents plus one offspring per parent.
 *  Offspring `m` is produced from `parents[m]` and `parents[(m+1) % n]`, appended after the parents:
 *  the return is `[...parents, ...offspring]` (length `2 * parents.length`). */
export async function evolve<T>(cfg: Pick<EscConfig<T>, "crossover" | "mutate">, parents: Genome<T>[]): Promise<Genome<T>[]> {
  const offspring: Genome<T>[] = [];
  for (let i = 0; i < parents.length; i++) {
    const a = parents[i];
    const b = parents[(i + 1) % parents.length];
    offspring.push(await cfg.mutate(await cfg.crossover(a, b)));
  }
  return [...parents, ...offspring];
}

function trimToPopulationSize<T>(
  cfg: EscConfig<T>,
  genomes: Genome<T>[],
  scores: number[],
): { genomes: Genome<T>[]; scores: number[] } {
  if (!cfg.populationSize || genomes.length <= cfg.populationSize) return { genomes, scores };
  const ranked = scores
    .map((s, i) => ({ s, i }))
    .sort((x, y) => y.s - x.s)
    .slice(0, cfg.populationSize);
  return { genomes: ranked.map((r) => genomes[r.i]), scores: ranked.map((r) => r.s) };
}

/** One generation, composed from the primitives. Evaluates fitness ONCE (on the new population). */
export async function step<T>(cfg: EscConfig<T>, state: EscState<T>): Promise<EscState<T>> {
  const parents = select(cfg, state.population, state.scores);
  const evolved = await evolve(cfg, parents);
  const evolvedScores = await score(cfg, evolved);
  const { genomes, scores } = trimToPopulationSize(cfg, evolved, evolvedScores);
  return { population: genomes, scores, generation: state.generation + 1, bestScore: maxScore(scores) };
}

export async function runToConvergence<T>(cfg: EscConfig<T>): Promise<EscState<T>> {
  const population = await cfg.seed();
  const scores = await score(cfg, population);
  let state: EscState<T> = { population, scores, generation: 0, bestScore: maxScore(scores) };
  while (!cfg.converged(state) && state.generation < cfg.maxGenerations) {
    state = await step(cfg, state);
  }
  return state;
}
