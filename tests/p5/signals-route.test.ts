import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { runCycle } from "@/app/api/signals/route";
import { raiseAlerts } from "@/lib/p5/alert-logic";
import type { Genome } from "@/lib/esc/core";
import type { QueryGenome, FeedItem, ScoredItem } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = { scope: "run a marathon", successMetric: "finish under 4h", constraints: "evenings", motivation: "health", deadlineShape: "october" };
const g = (id: string): Genome<QueryGenome> => ({ value: { id, queries: [{ source: "newsapi", terms: [id], weight: 1 }] } });
const feed = (id: string): FeedItem => ({ id, source: "newsapi", kind: "news", title: id, summary: id, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} });

function justifyGateway() {
  return {
    async batchComplete<T>(reqs: unknown[]): Promise<T[]> { return reqs.map(() => ({ justification: "Affects the goal." }) as unknown as T); },
  };
}

describe("/api/signals runCycle integration", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "x", rawText: "run a marathon" }).id;
    repos.goals.setConvergedSpec(goalId, spec);
  });

  it("runs one end-to-end cycle: stores signals, raises an alert, advances genome state", async () => {
    const gw = justifyGateway();
    const res = await runCycle(goalId, {
      repos,
      ops: {
        async seed() { return [g("s0"), g("s1"), g("s2"), g("s3")]; },
        async crossover(a) { return g("x-" + a.value.id); },
        async mutate(m) { return g("m-" + m.value.id); },
      },
      ingest: async () => [feed("a"), feed("b")],
      scoreItems: async (items: FeedItem[]): Promise<ScoredItem[]> =>
        items.map((item, i) => ({ item, keywordScore: 0.5, llmScore: i === 0 ? 0.95 : 0.2, finalScore: i === 0 ? 0.9 : 0.2 })),
      raiseAlerts: (signals) => raiseAlerts(signals, spec, repos, gw, "model"),
    });

    expect(res.signals).toHaveLength(2);
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0].impactScore).toBeCloseTo(0.9, 5);
    expect(repos.queryGenomeState.get(goalId)!.generation).toBe(1);
  });
});
