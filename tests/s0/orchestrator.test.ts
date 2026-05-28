import { describe, it, expect } from "vitest";
import { startElicitation, answerQuestion, type ElicitationOps } from "@/lib/s0/orchestrator";
import { makeDistanceFn } from "@/lib/s0/belief";
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

// Deterministic embed stub: each scope letter maps to an orthogonal one-hot vector.
// The orchestrator calls JSON.stringify(genome.value), which contains "scope":"<letter>".
function makeStubEmbed() {
  return async (text: string): Promise<number[]> => {
    const m = text.match(/"scope":"(\w)"/);
    const idx = m ? Math.max(0, m[1].charCodeAt(0) - "a".charCodeAt(0)) : 0;
    const v = new Array(8).fill(0);
    if (idx < v.length) v[idx] = 1;
    return v;
  };
}

const TARGET = gi("a");

describe("s0 orchestrator", () => {
  it("converges to the target interpretation within a few questions", async () => {
    const cfg = { maxQuestions: 10, entropyThreshold: 0.5, evolveEvery: 999 };
    const embed = makeStubEmbed();
    let state = await startElicitation(mockOps(), cfg, embed);
    let asked = 0;
    while (state.status === "active" && state.pendingQuestion) {
      const distance = makeDistanceFn(state.vectors);
      const q = state.pendingQuestion;
      const ans = distance(state.population[q.a].value, TARGET) <= distance(state.population[q.b].value, TARGET) ? "a" : "b";
      state = await answerQuestion(mockOps(), state, ans, cfg, embed);
      asked++;
      if (asked > 10) break;
    }
    expect(state.status).toBe("converged");
    expect(state.convergedSpec!.scope).toBe("a");
    expect(asked).toBeLessThanOrEqual(6);
  });

  it("stays bounded and still converges when evolve fires (evolveEvery=2)", async () => {
    const cfg = { maxQuestions: 12, entropyThreshold: 0.5, evolveEvery: 2 };
    const embed = makeStubEmbed();
    let state = await startElicitation(mockOps(), cfg, embed);
    let asked = 0;
    while (state.status === "active" && state.pendingQuestion && asked < 12) {
      const distance = makeDistanceFn(state.vectors);
      const q = state.pendingQuestion;
      const ans = distance(state.population[q.a].value, TARGET) <= distance(state.population[q.b].value, TARGET) ? "a" : "b";
      state = await answerQuestion(mockOps(), state, ans, cfg, embed);
      asked++;
    }
    expect(state.status).toBe("converged");
    expect(state.convergedSpec!.scope).toBe("a");
    expect(state.population.length).toBeLessThanOrEqual(4);
  });
});
