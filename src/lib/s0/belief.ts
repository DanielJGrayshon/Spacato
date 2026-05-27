import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";

export interface Belief { weights: number[]; }

const DIMS: (keyof GoalInterpretation)[] = ["scope", "successMetric", "constraints", "motivation", "deadlineShape"];
const TAU = 0.3;

export function distance(a: GoalInterpretation, b: GoalInterpretation): number {
  let differ = 0;
  for (const d of DIMS) if (a[d] !== b[d]) differ++;
  return differ / DIMS.length;
}

export function sigma(pop: Genome<GoalInterpretation>[], k: number, i: number, j: number): number {
  const ei = Math.exp(-distance(pop[k].value, pop[i].value) / TAU);
  const ej = Math.exp(-distance(pop[k].value, pop[j].value) / TAU);
  return ei / (ei + ej);
}

export function uniformBelief(n: number): Belief {
  return { weights: new Array(n).fill(1 / n) };
}

function normalise(weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) throw new Error("s0 belief: weights collapsed to zero");
  return weights.map((w) => w / sum);
}

export function updateBelief(belief: Belief, pop: Genome<GoalInterpretation>[], q: ElicitationQuestion, answer: "a" | "b"): Belief {
  const updated = belief.weights.map((w, k) => {
    const pPreferA = sigma(pop, k, q.a, q.b);
    return w * (answer === "a" ? pPreferA : 1 - pPreferA);
  });
  return { weights: normalise(updated) };
}

export function entropy(belief: Belief): number {
  return -belief.weights.reduce((h, w) => (w > 0 ? h + w * Math.log(w) : h), 0);
}
