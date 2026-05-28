import { describe, it, expect } from "vitest";
import { runToConvergence, step, score, evolve, select, type EscConfig, type EscState } from "@/lib/esc/core";

const TARGET = 42;
function mockConfig(overrides: Partial<EscConfig<number>> = {}): EscConfig<number> {
  return {
    maxGenerations: 100,
    async seed() { return [0, 10, 90, 100].map((v) => ({ value: v })); },
    async crossover(a, b) { return { value: Math.round((a.value + b.value) / 2) }; },
    async mutate(g) { return { value: g.value + (g.value < TARGET ? 1 : -1) }; },
    async fitness(pop) { return pop.map((g) => -Math.abs(g.value - TARGET)); },
    select(pop, scores) {
      return pop.map((g, i) => ({ g, s: scores[i] })).sort((x, y) => y.s - x.s).slice(0, 2).map((x) => x.g);
    },
    converged(state) { return state.bestScore >= -0.0001; },
    ...overrides,
  };
}

async function initialState(cfg: EscConfig<number>): Promise<EscState<number>> {
  const population = await cfg.seed();
  const scores = await cfg.fitness(population);
  return { population, scores, generation: 0, bestScore: Math.max(...scores) };
}

describe("esc-core", () => {
  it("converges to the hidden target with a mock fitness", async () => {
    const final = await runToConvergence(mockConfig());
    expect(final.population.some((g) => g.value === TARGET)).toBe(true);
    expect(final.generation).toBeLessThanOrEqual(100);
  });

  it("throws a clear error on an empty seed population", async () => {
    await expect(runToConvergence(mockConfig({ seed: async () => [] }))).rejects.toThrow(/empty population/);
  });

  it("step advances exactly one generation", async () => {
    const cfg = mockConfig();
    const s1 = await step(cfg, await initialState(cfg));
    expect(s1.generation).toBe(1);
  });

  it("calls fitness exactly once per step (no double evaluation)", async () => {
    let calls = 0;
    const base = mockConfig();
    const cfg = mockConfig({ fitness: async (pop) => { calls++; return base.fitness(pop); } });
    const s0 = await initialState(cfg);
    calls = 0;
    await step(cfg, s0);
    expect(calls).toBe(1);
  });

  it("respects populationSize cap even when select returns the whole population", async () => {
    const cfg = mockConfig({ populationSize: 4, select: (pop) => pop });
    let state = await initialState(cfg);
    state = await step(cfg, state);
    expect(state.population.length).toBe(4);
    state = await step(cfg, state);
    expect(state.population.length).toBe(4);
  });

  it("exposes composable score, select and evolve primitives", async () => {
    const cfg = mockConfig();
    const pop = await cfg.seed();
    const scores = await score(cfg, pop);
    expect(scores).toHaveLength(pop.length);
    const parents = select(cfg, pop, scores);
    const next = await evolve(cfg, parents);
    expect(next.length).toBe(parents.length * 2);
  });

  it("runs all crossovers concurrently rather than serially", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const cfg = mockConfig({
      async crossover(a, b) {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { value: Math.round((a.value + b.value) / 2) };
      },
    });
    const parents = [{ value: 1 }, { value: 2 }];
    const next = await evolve(cfg, parents);
    expect(maxConcurrent).toBe(2);           // both crossovers in flight at once
    expect(next.length).toBe(4);             // [...parents, ...offspring] unchanged
  });
});
