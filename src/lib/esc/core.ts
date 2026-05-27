export interface Genome<T> { value: T }
export interface EscState<T> { population: Genome<T>[]; generation: number; bestScore: number; }
export interface EscConfig<T> {
  maxGenerations: number;
  seed(): Promise<Genome<T>[]>;
  crossover(a: Genome<T>, b: Genome<T>): Promise<Genome<T>>;
  mutate(g: Genome<T>): Promise<Genome<T>>;
  fitness(pop: Genome<T>[]): Promise<number[]>;
  select(pop: Genome<T>[], scores: number[]): Genome<T>[];
  converged(state: EscState<T>): boolean;
}

async function breed<T>(cfg: EscConfig<T>, parents: Genome<T>[]): Promise<Genome<T>[]> {
  const children: Genome<T>[] = [...parents];
  for (let i = 0; i < parents.length; i++) {
    const a = parents[i];
    const b = parents[(i + 1) % parents.length];
    children.push(await cfg.mutate(await cfg.crossover(a, b)));
  }
  return children;
}

export async function step<T>(cfg: EscConfig<T>, state: EscState<T>): Promise<EscState<T>> {
  const scores = await cfg.fitness(state.population);
  const parents = cfg.select(state.population, scores);
  const population = await breed(cfg, parents);
  const newScores = await cfg.fitness(population);
  return { population, generation: state.generation + 1, bestScore: Math.max(...newScores) };
}

export async function runToConvergence<T>(cfg: EscConfig<T>): Promise<EscState<T>> {
  const seeded = await cfg.seed();
  const scores = await cfg.fitness(seeded);
  let state: EscState<T> = { population: seeded, generation: 0, bestScore: Math.max(...scores) };
  while (!cfg.converged(state) && state.generation < cfg.maxGenerations) {
    state = await step(cfg, state);
  }
  return state;
}
