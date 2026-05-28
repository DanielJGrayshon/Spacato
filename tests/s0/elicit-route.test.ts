import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleElicit } from "@/lib/s0/elicit-handler";
import type { ElicitationOps } from "@/lib/s0/orchestrator";
import type { GoalInterpretation } from "@/lib/store/types";

const gi = (s: string): GoalInterpretation => ({ scope: s, successMetric: s, constraints: "c", motivation: "mo", deadlineShape: "d" });

function ops(): ElicitationOps {
  const cands = ["alpha", "bravo", "charlie", "delta"].map((s) => ({ value: gi(s) }));
  return { async seed() { return cands; }, async crossover(a) { return a; }, async mutate(g) { return g; } };
}

// Per-text deterministic vector: different texts produce different vectors.
function makeStubEmbed() {
  return async (text: string): Promise<number[]> => {
    const v = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) v[i % 8] += (text.charCodeAt(i) % 32) / 32;
    return v;
  };
}

describe("elicit route handler", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("starts elicitation, persists state (incl. vectors), returns a question", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    const res = await handleElicit(
      { action: "start", goalId: g.id, rawGoal: "run a marathon" },
      { repos, ops: ops(), embed: makeStubEmbed() },
    );
    expect(res.elicitationId).toBeTypeOf("number");
    expect(res.question).not.toBeNull();
    const row = repos.elicitations.get(res.elicitationId)!;
    expect(row.pendingQuestion).not.toBeNull();
    expect(Object.keys(row.vectors).length).toBe(4);
  });

  it("processes answers and converges (the post-embedding belief update meaningfully discriminates)", async () => {
    const g = repos.goals.create({ title: "x", rawText: "run a marathon" });
    let res = await handleElicit(
      { action: "start", goalId: g.id, rawGoal: "run a marathon" },
      { repos, ops: ops(), embed: makeStubEmbed() },
    );
    let guard = 0;
    while (res.question && guard++ < 12) {
      const state = repos.elicitations.get(res.elicitationId)!;
      const aVal = state.population[res.question.a].value.scope;
      const bVal = state.population[res.question.b].value.scope;
      // Content-driven oracle: prefer 'alpha' when present in EITHER operand. When neither operand
      // is 'alpha', alternate to avoid biasing the belief toward whichever literal answer the test
      // would otherwise default to.
      const ans: "a" | "b" =
        aVal.includes("alpha") ? "a"
        : bVal.includes("alpha") ? "b"
        : (guard % 2 === 0 ? "a" : "b");
      res = await handleElicit(
        { action: "answer", elicitationId: res.elicitationId, answer: ans },
        { repos, ops: ops(), embed: makeStubEmbed() },
      );
    }
    expect(res.converged).toBe(true);
    const spec = repos.goals.get(g.id)!.convergedSpec as GoalInterpretation;
    expect(spec.scope).toBe("alpha");
  });
});
