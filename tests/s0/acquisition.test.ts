import { describe, it, expect } from "vitest";
import { selectQuestion, expectedPosteriorEntropy } from "@/lib/s0/acquisition";
import { uniformBelief, type DistanceFn } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string, metric = "m"): GoalInterpretation =>
  ({ scope, successMetric: metric, constraints: "c", motivation: "mo", deadlineShape: "d" });

// 0 if scope+metric equal, 1 otherwise. The (scope="x", metric="m") duplicates are "identical" pairs.
const synth: DistanceFn = (a, b) =>
  a.scope === b.scope && a.successMetric === b.successMetric ? 0 : 1;

describe("s0 acquisition with injected DistanceFn", () => {
  it("selects a pair of distinct candidates", () => {
    const pop = [gi("a"), gi("b"), gi("c"), gi("d")].map((value) => ({ value }));
    const q = selectQuestion(uniformBelief(4), pop, synth);
    expect(q).not.toBeNull();
    expect(q!.a).not.toBe(q!.b);
  });

  it("prefers the question that most reduces expected entropy", () => {
    const pop = [gi("a"), gi("b"), gi("x"), gi("x")].map((value) => ({ value }));
    const belief = uniformBelief(4);
    const eInformative = expectedPosteriorEntropy(belief, pop, { a: 0, b: 1 }, synth);
    const eUseless = expectedPosteriorEntropy(belief, pop, { a: 2, b: 3 }, synth);
    expect(eInformative).toBeLessThan(eUseless);
  });

  it("returns null when fewer than two candidates remain", () => {
    expect(selectQuestion({ weights: [1] }, [{ value: gi("a") }], synth)).toBeNull();
  });
});
