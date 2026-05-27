import { describe, it, expect } from "vitest";
import { runToConvergence, step, type EscConfig, type EscState } from "@/lib/esc/core";

const TARGET = 42;
function mockConfig(): EscConfig<number> {
  return {
    maxGenerations: 100,
    async seed() { return [0, 10, 90, 100].map((v) => ({ value: v })); },
    async crossover(a, b) { return { value: Math.round((a.value + b.value) / 2) }; },
    async mutate(g) { return { value: g.value + (g.value < TARGET ? 1 : -1) }; },
    async fitness(pop) { return pop.map((g) => -Math.abs(g.value - TARGET)); },
    select(pop, scores) {
      return pop
        .map((g, i) => ({ g, s: scores[i] }))
        .sort((x, y) => y.s - x.s)
        .slice(0, 2)
        .map((x) => x.g);
    },
    converged(state: EscState<number>) { return state.bestScore >= -0.0001; },
  };
}

describe("esc-core", () => {
  it("converges to the hidden target with a mock fitness", async () => {
    const final = await runToConvergence(mockConfig());
    expect(final.population.some((g) => g.value === TARGET)).toBe(true);
    expect(final.generation).toBeLessThanOrEqual(100);
  });

  it("throws a clear error on an empty seed population", async () => {
    const cfg = { ...mockConfig(), seed: async () => [] };
    await expect(runToConvergence(cfg)).rejects.toThrow(/empty population/);
  });

  it("step advances exactly one generation", async () => {
    const cfg = mockConfig();
    const seeded = await cfg.seed();
    const scores = await cfg.fitness(seeded);
    const s0: EscState<number> = { population: seeded, generation: 0, bestScore: Math.max(...scores) };
    const s1 = await step(cfg, s0);
    expect(s1.generation).toBe(1);
  });
});
