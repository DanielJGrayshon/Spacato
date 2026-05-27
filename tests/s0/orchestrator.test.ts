import { describe, it, expect } from "vitest";
import { startElicitation, answerQuestion, type ElicitationOps } from "@/lib/s0/orchestrator";
import { distance } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string): GoalInterpretation =>
  ({ scope, successMetric: scope, constraints: "c", motivation: "mo", deadlineShape: "d" });

function mockOps(): ElicitationOps {
  const cands = ["a", "b", "c", "d"].map((s) => ({ value: gi(s) }));
  return {
    async seed() { return cands; },
    async crossover(a) { return a; },
    async mutate(g) { return g; },
  };
}

const TARGET = gi("a");
function oracle(pop: { value: GoalInterpretation }[], q: { a: number; b: number }): "a" | "b" {
  return distance(pop[q.a].value, TARGET) <= distance(pop[q.b].value, TARGET) ? "a" : "b";
}

describe("s0 orchestrator", () => {
  it("converges to the target interpretation within a few questions", async () => {
    const cfg = { maxQuestions: 10, entropyThreshold: 0.5, evolveEvery: 999 };
    let state = await startElicitation(mockOps(), cfg);
    let asked = 0;
    while (state.status === "active" && state.pendingQuestion) {
      const ans = oracle(state.population, state.pendingQuestion);
      state = await answerQuestion(mockOps(), state, ans, cfg);
      asked++;
      if (asked > 10) break;
    }
    expect(state.status).toBe("converged");
    expect(state.convergedSpec!.scope).toBe("a");
    expect(asked).toBeLessThanOrEqual(6);
  });

  it("stays bounded and still converges when evolve fires (evolveEvery=2)", async () => {
    const cfg = { maxQuestions: 12, entropyThreshold: 0.5, evolveEvery: 2 };
    let state = await startElicitation(mockOps(), cfg);
    let asked = 0;
    while (state.status === "active" && state.pendingQuestion && asked < 12) {
      state = await answerQuestion(mockOps(), state, oracle(state.population, state.pendingQuestion), cfg);
      asked++;
    }
    expect(state.status).toBe("converged");
    expect(state.convergedSpec!.scope).toBe("a");
    expect(state.population.length).toBeLessThanOrEqual(4); // population stays bounded through evolve
  });
});
