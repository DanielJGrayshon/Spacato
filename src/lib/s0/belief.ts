import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { tokenise } from "@/lib/util/text";
import { contentHash } from "@/lib/util/hash";

export interface Belief { weights: number[]; }
export type DistanceFn = (a: GoalInterpretation, b: GoalInterpretation) => number;

const DIMS: (keyof GoalInterpretation)[] = ["scope", "successMetric", "constraints", "motivation", "deadlineShape"];
export const TAU = 0.2;

export function cosineDistance(u: number[], v: number[]): number {
  if (u.length !== v.length) throw new Error("s0: cosine on mismatched vector dims");
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  if (nu === 0 || nv === 0) return 1;
  const cos = dot / (Math.sqrt(nu) * Math.sqrt(nv));
  const d = (1 - cos) / 2;
  return Math.min(1, Math.max(0, d));
}

export function jaccardDistance(a: GoalInterpretation, b: GoalInterpretation): number {
  const ta = new Set(tokenise(DIMS.map((dim) => a[dim]).join(" ")));
  const tb = new Set(tokenise(DIMS.map((dim) => b[dim]).join(" ")));
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

export function makeDistanceFn(vectors: Record<string, number[]>): DistanceFn {
  return (a, b) => {
    const va = vectors[contentHash(a)];
    const vb = vectors[contentHash(b)];
    return (va && vb) ? cosineDistance(va, vb) : jaccardDistance(a, b);
  };
}

export function sigma(
  pop: Genome<GoalInterpretation>[],
  k: number, i: number, j: number,
  distance: DistanceFn,
): number {
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

export function updateBelief(
  belief: Belief,
  pop: Genome<GoalInterpretation>[],
  q: ElicitationQuestion,
  answer: "a" | "b",
  distance: DistanceFn,
): Belief {
  const updated = belief.weights.map((w, k) => {
    const pPreferA = sigma(pop, k, q.a, q.b, distance);
    return w * (answer === "a" ? pPreferA : 1 - pPreferA);
  });
  return { weights: normalise(updated) };
}

export function entropy(belief: Belief): number {
  return -belief.weights.reduce((h, w) => (w > 0 ? h + w * Math.log(w) : h), 0);
}
