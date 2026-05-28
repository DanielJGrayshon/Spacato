import { describe, it, expect } from "vitest";
import {
  cosineDistance,
  jaccardDistance,
  makeDistanceFn,
  sigma,
  uniformBelief,
  updateBelief,
  entropy,
  type DistanceFn,
} from "@/lib/s0/belief";
import { contentHash } from "@/lib/util/hash";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (scope: string, more: Partial<GoalInterpretation> = {}): GoalInterpretation =>
  ({ scope, successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d", ...more });

describe("cosineDistance", () => {
  it("returns 0 for identical vectors", () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0);
  });
  it("returns 1 for antipodal vectors", () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(1);
  });
  it("returns 0.5 for orthogonal vectors", () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(0.5);
  });
  it("returns 1 for a zero-magnitude vector", () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
  });
  it("throws on mismatched dimensions", () => {
    expect(() => cosineDistance([1, 2], [1, 2, 3])).toThrow(/mismatched/);
  });
});

describe("jaccardDistance", () => {
  it("returns 0 for identical interpretations", () => {
    const x = gi("marathon training plan");
    expect(jaccardDistance(x, x)).toBe(0);
  });
  it("returns 1 for fully disjoint token sets", () => {
    const a = gi("marathon training plan", {
      successMetric: "finish race", constraints: "weekday", motivation: "health", deadlineShape: "october",
    });
    const b = gi("ferment sourdough bread", {
      successMetric: "tasty crust", constraints: "kitchen tools", motivation: "hobby", deadlineShape: "any",
    });
    expect(jaccardDistance(a, b)).toBe(1);
  });
  it("returns a value in (0, 1) for partial overlap", () => {
    const a = gi("marathon training plan", { successMetric: "finish race" });
    const b = gi("marathon time goal", { successMetric: "finish under four hours" });
    const d = jaccardDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
  it("returns 0 when both interpretations tokenise to the empty set", () => {
    const empty = gi("", { successMetric: "", constraints: "", motivation: "", deadlineShape: "" });
    expect(jaccardDistance(empty, empty)).toBe(0);
  });
});

describe("makeDistanceFn", () => {
  it("uses cosine when both vectors are present in the sidecar", () => {
    const a = gi("marathon race");
    const b = gi("stock market");
    const vectors = {
      [contentHash(a)]: [1, 0],
      [contentHash(b)]: [0, 1],
    };
    const d = makeDistanceFn(vectors);
    expect(d(a, b)).toBeCloseTo(0.5);
  });
  it("falls back to Jaccard when either vector is missing", () => {
    const a = gi("marathon race");
    const b = gi("marathon time");
    const vectors = { [contentHash(a)]: [1, 0] };
    const d = makeDistanceFn(vectors);
    expect(d(a, b)).toBe(jaccardDistance(a, b));
  });
  it("falls back to Jaccard when neither vector is present", () => {
    const a = gi("marathon race");
    const b = gi("marathon time");
    const d = makeDistanceFn({});
    expect(d(a, b)).toBe(jaccardDistance(a, b));
  });
  it("looks up vectors by content (not by reference); property-insertion order doesn't matter", () => {
    // Same logical interpretation, different property-insertion orders.
    const ref: GoalInterpretation = { scope: "x", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };
    const reordered: GoalInterpretation = { deadlineShape: "d", motivation: "mo", constraints: "c", successMetric: "m", scope: "x" };
    const other: GoalInterpretation = { scope: "y", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };
    const vectors = { [contentHash(ref)]: [1, 0], [contentHash(other)]: [0, 1] };
    const d = makeDistanceFn(vectors);
    // If the lookup were reference-based or insertion-order-sensitive, this would Jaccard-fallback instead of cosine.
    expect(d(reordered, other)).toBeCloseTo(0.5);
  });
  it("TAU=0.05: sigma on a fractional distance pair is locked to its expected value", () => {
    // distance(target, A) = 0.3, distance(target, B) = 0.6 → sigma = exp(-0.3/0.05)/(exp(-0.3/0.05)+exp(-0.6/0.05)) ≈ 0.99753.
    const synth: DistanceFn = (_a, b) => (b.scope === "near" ? 0.3 : 0.6);
    const pop = [gi("target"), gi("near"), gi("far")].map((value) => ({ value }));
    expect(sigma(pop, 0, 1, 2, synth)).toBeCloseTo(0.99753, 5);
  });
});

describe("sigma + updateBelief with injected DistanceFn", () => {
  const synth: DistanceFn = (a, b) => (a.scope === b.scope ? 0 : 1);

  it("sigma is 0.5 when both candidates are equidistant from the target", () => {
    const pop = [gi("a"), gi("b"), gi("c")].map((value) => ({ value }));
    expect(sigma(pop, 0, 1, 2, synth)).toBeCloseTo(0.5);
  });

  it("updateBelief shifts weight toward the hypothesis consistent with the answer", () => {
    const pop = [gi("a"), gi("b")].map((value) => ({ value }));
    let belief = uniformBelief(2);
    belief = updateBelief(belief, pop, { a: 0, b: 1 }, "a", synth);
    expect(belief.weights[0]).toBeGreaterThan(belief.weights[1]);
    expect(belief.weights[0] + belief.weights[1]).toBeCloseTo(1);
  });

  it("entropy is maximal for uniform and ~0 for certain", () => {
    expect(entropy(uniformBelief(4))).toBeCloseTo(Math.log(4));
    expect(entropy({ weights: [1, 0, 0, 0] })).toBeCloseTo(0);
  });
});
