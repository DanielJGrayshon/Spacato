import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleElicit } from "@/lib/s0/elicit-handler";
import type { ElicitationOps } from "@/lib/s0/orchestrator";
import type { GoalInterpretation } from "@/lib/store/types";

// Four real-LLM-style interpretations with NO exact-token matches across the 5 dimensions.
// Old exact-Hamming distance would have collapsed every pairwise distance to ~1.0
// and the belief would barely move. Embedding-based distance produces meaningful gradients.
const interpretations: GoalInterpretation[] = [
  { scope: "complete a marathon race",      successMetric: "finishing the marathon",
    constraints: "must train regularly without injury", motivation: "personal achievement and fitness",
    deadlineShape: "exact fixed date of marathon event in 6 months" },
  { scope: "improve running ability",       successMetric: "ability to run 26.2 miles continuously",
    constraints: "requires a structured training plan",  motivation: "challenge self and gain endurance",
    deadlineShape: "target set for 6 months from now" },
  { scope: "invest in a stock portfolio",   successMetric: "5% annual return after fees",
    constraints: "low risk; only blue-chip equities",    motivation: "build long-term savings",
    deadlineShape: "ongoing with quarterly review" },
  { scope: "ferment sourdough bread",        successMetric: "consistent open crumb at home",
    constraints: "kitchen-scale ingredients only",       motivation: "weekend hobby",
    deadlineShape: "no deadline; weekly practice" },
];

// Stub embed: distinct per-text vectors. Marathon/running texts share axis 0; stock/portfolio axis 1; sourdough/bread axis 2.
function stubEmbed() {
  return async (text: string): Promise<number[]> => {
    const v = [0, 0, 0, 0];
    if (text.includes("marathon") || text.includes("running")) v[0] += 1;
    if (text.includes("stock") || text.includes("portfolio")) v[1] += 1;
    if (text.includes("sourdough") || text.includes("bread"))  v[2] += 1;
    v[3] = text.length / 256;
    return v;
  };
}

function ops(): ElicitationOps {
  const seed = interpretations.map((value) => ({ value }));
  return { async seed() { return seed; }, async crossover(a) { return a; }, async mutate(g) { return g; } };
}

describe("S0 semantic-distance regression guard", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("answering toward a marathon interpretation meaningfully drops the weight of the stock-market candidate", async () => {
    const g = repos.goals.create({ title: "x", rawText: "marathon" });
    const start = await handleElicit(
      { action: "start", goalId: g.id, rawGoal: "marathon" },
      { repos, ops: ops(), embed: stubEmbed() },
    );
    expect(start.question).not.toBeNull();

    const before = repos.elicitations.get(start.elicitationId)!;
    expect(before.beliefWeights.every((w) => Math.abs(w - 0.25) < 1e-6)).toBe(true);

    // Answer in favour of the marathon-race candidate (index 0).
    const q = start.question!;
    const answer: "a" | "b" = q.a === 0 ? "a" : "b";
    await handleElicit(
      { action: "answer", elicitationId: start.elicitationId, answer },
      { repos, ops: ops(), embed: stubEmbed() },
    );

    const row = repos.elicitations.get(start.elicitationId)!;
    // The candidates farthest from the marathon pole (indices 2 and 3) should have lost weight.
    const farSum = row.beliefWeights[2] + row.beliefWeights[3];
    expect(farSum).toBeLessThan(0.45);
  });
});
