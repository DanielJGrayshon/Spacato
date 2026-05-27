import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleElicit } from "@/lib/s0/elicit-handler";
import type { ElicitationOps } from "@/lib/s0/orchestrator";
import { distance } from "@/lib/s0/belief";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (s: string): GoalInterpretation => ({ scope: s, successMetric: s, constraints: "c", motivation: "mo", deadlineShape: "d" });
function ops(): ElicitationOps {
  const cands = ["a", "b", "c", "d"].map((s) => ({ value: gi(s) }));
  return { async seed() { return cands; }, async crossover(a) { return a; }, async mutate(g) { return g; } };
}

describe("elicit route handler", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("starts elicitation, persists state, and returns a question", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    const res = await handleElicit({ action: "start", goalId: g.id, rawGoal: "run a marathon" }, { repos, ops: ops() });
    expect(res.elicitationId).toBeTypeOf("number");
    expect(res.question).not.toBeNull();
    expect(repos.elicitations.get(res.elicitationId)!.pendingQuestion).not.toBeNull();
  });

  it("processes answers, converges, and writes converged_spec to the goal", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    let res = await handleElicit({ action: "start", goalId: g.id, rawGoal: "run a marathon" }, { repos, ops: ops() });
    const TARGET = gi("a");
    let guard = 0;
    while (res.question && guard++ < 12) {
      const state = repos.elicitations.get(res.elicitationId)!;
      const ans = distance(state.population[res.question.a].value, TARGET) <= distance(state.population[res.question.b].value, TARGET) ? "a" : "b";
      res = await handleElicit({ action: "answer", elicitationId: res.elicitationId, answer: ans }, { repos, ops: ops() });
    }
    expect(res.converged).toBe(true);
    expect(repos.goals.get(g.id)!.convergedSpec).toMatchObject({ scope: "a" });
  });
});
