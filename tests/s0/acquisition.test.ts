import { describe, it, expect } from "vitest";
import { selectQuestion, expectedPosteriorEntropy } from "@/lib/s0/acquisition";
import { uniformBelief } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string, metric = "m"): GoalInterpretation =>
  ({ scope, successMetric: metric, constraints: "c", motivation: "mo", deadlineShape: "d" });

describe("s0 acquisition", () => {
  it("selects a pair of distinct candidates", () => {
    const pop = [gi("a"), gi("b"), gi("c"), gi("d")].map((value) => ({ value }));
    const q = selectQuestion(uniformBelief(4), pop);
    expect(q).not.toBeNull();
    expect(q!.a).not.toBe(q!.b);
  });
  it("prefers the question that most reduces expected entropy", () => {
    const pop = [gi("a"), gi("b"), gi("x"), gi("x")].map((value) => ({ value }));
    const belief = uniformBelief(4);
    const eInformative = expectedPosteriorEntropy(belief, pop, { a: 0, b: 1 });
    const eUseless = expectedPosteriorEntropy(belief, pop, { a: 2, b: 3 });
    expect(eInformative).toBeLessThan(eUseless);
  });
  it("returns null when fewer than two candidates remain", () => {
    expect(selectQuestion({ weights: [1] }, [{ value: gi("a") }])).toBeNull();
  });
});
