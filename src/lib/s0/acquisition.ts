import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { sigma, updateBelief, entropy, type Belief } from "./belief";

export function expectedPosteriorEntropy(belief: Belief, pop: Genome<GoalInterpretation>[], q: ElicitationQuestion): number {
  const pA = belief.weights.reduce((s, w, k) => s + w * sigma(pop, k, q.a, q.b), 0);
  const hA = entropy(updateBelief(belief, pop, q, "a"));
  const hB = entropy(updateBelief(belief, pop, q, "b"));
  return pA * hA + (1 - pA) * hB;
}

export function selectQuestion(belief: Belief, pop: Genome<GoalInterpretation>[]): ElicitationQuestion | null {
  if (pop.length < 2) return null;
  let best: ElicitationQuestion | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < pop.length; i++) {
    for (let j = i + 1; j < pop.length; j++) {
      const score = expectedPosteriorEntropy(belief, pop, { a: i, b: j });
      if (score < bestScore) { bestScore = score; best = { a: i, b: j }; }
    }
  }
  return best;
}
