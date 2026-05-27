import { describe, it, expect } from "vitest";
import { distance, sigma, uniformBelief, updateBelief, entropy } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string): GoalInterpretation =>
  ({ scope, successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" });

describe("s0 belief", () => {
  it("distance is normalised Hamming over 5 dims", () => {
    expect(distance(gi("a"), gi("a"))).toBe(0);
    expect(distance(gi("a"), gi("b"))).toBeCloseTo(0.2);
  });
  it("sigma is 0.5 when both candidates are equidistant from the target", () => {
    const pop = [gi("a"), gi("b"), gi("c")].map((value) => ({ value }));
    expect(sigma(pop, 0, 1, 2)).toBeCloseTo(0.5);
  });
  it("updateBelief shifts weight toward the hypothesis consistent with the answer", () => {
    const pop = [gi("a"), gi("b")].map((value) => ({ value }));
    let belief = uniformBelief(2);
    belief = updateBelief(belief, pop, { a: 0, b: 1 }, "a");
    expect(belief.weights[0]).toBeGreaterThan(belief.weights[1]);
    expect(belief.weights[0] + belief.weights[1]).toBeCloseTo(1);
  });
  it("entropy is maximal for uniform and ~0 for certain", () => {
    expect(entropy(uniformBelief(4))).toBeCloseTo(Math.log(4));
    expect(entropy({ weights: [1, 0, 0, 0] })).toBeCloseTo(0);
  });
});
