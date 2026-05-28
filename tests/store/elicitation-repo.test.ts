import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";

describe("elicitation repository", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("creates, reads, and updates elicitation state for a goal", () => {
    const g = repos.goals.create({ title: "x", rawText: "x" });
    const e = repos.elicitations.create(g.id);
    expect(e.generation).toBe(0);
    expect(e.status).toBe("active");

    repos.elicitations.update(e.id, {
      generation: 1,
      population: [{ value: { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" } }],
      beliefWeights: [1],
      pendingQuestion: { a: 0, b: 0 },
      status: "active",
      vectors: {},
    });
    const loaded = repos.elicitations.get(e.id)!;
    expect(loaded.generation).toBe(1);
    expect(loaded.beliefWeights).toEqual([1]);
    expect(loaded.population[0].value.scope).toBe("s");
    expect(loaded.pendingQuestion).toEqual({ a: 0, b: 0 });
  });

  it("elicitations round-trip the vectors sidecar map", () => {
    const g = repos.goals.create({ title: "x", rawText: "x" });
    const e = repos.elicitations.create(g.id);
    expect(e.vectors).toEqual({});

    repos.elicitations.update(e.id, {
      generation: 1,
      population: [],
      beliefWeights: [],
      pendingQuestion: null,
      status: "active",
      vectors: { "abc123def4567890": [0.1, 0.2, 0.3], "f0e9d8c7b6a59483": [0.4] },
    });

    const reloaded = repos.elicitations.get(e.id)!;
    expect(reloaded.vectors).toEqual({
      "abc123def4567890": [0.1, 0.2, 0.3],
      "f0e9d8c7b6a59483": [0.4],
    });
  });
});
