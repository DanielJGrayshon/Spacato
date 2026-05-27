import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { selectTop, engagementFactor, GENOME_PRIOR_SCORE, runCycle } from "@/lib/p5/esc-adapter";
import type { Genome } from "@/lib/esc/core";
import type { QueryGenome, FeedItem, ScoredItem, Alert } from "@/lib/p5/types";

const g = (id: string): Genome<QueryGenome> => ({ value: { id, queries: [{ source: "newsapi", terms: [id], weight: 1 }] } });
const feed = (id: string): FeedItem => ({ id, source: "newsapi", kind: "news", title: id, summary: id, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} });

describe("esc-adapter pure pieces", () => {
  it("selectTop returns the top ceil(n/2) genomes by score", () => {
    const pop = [g("a"), g("b"), g("c"), g("d")];
    const parents = selectTop(pop, [0.1, 0.9, 0.4, 0.8]);
    expect(parents.map((p) => p.value.id)).toEqual(["b", "d"]);
  });

  it("engagementFactor is Laplace-smoothed", () => {
    const repos = makeRepositories(openDb(":memory:"));
    expect(engagementFactor(repos, "NONE")).toBeCloseTo(0.5, 5); // (0+0.5)/(0+1)
  });
});

describe("runCycle online loop", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "x", rawText: "x" }).id;
  });

  function deps(overrides: Partial<Parameters<typeof runCycle>[1]> = {}) {
    const scored = (items: FeedItem[]): ScoredItem[] =>
      items.map((item) => ({ item, keywordScore: 0.5, llmScore: 0.9, finalScore: 0.9 }));
    return {
      repos,
      ops: {
        async seed(): Promise<Genome<QueryGenome>[]> { return [g("s0"), g("s1"), g("s2"), g("s3")]; },
        async crossover(a: Genome<QueryGenome>): Promise<Genome<QueryGenome>> { return g("x-" + a.value.id); },
        async mutate(m: Genome<QueryGenome>): Promise<Genome<QueryGenome>> { return g("m-" + m.value.id); },
      },
      ingest: async () => [feed("n1"), feed("n2")],
      scoreItems: async (items: FeedItem[]) => scored(items),
      raiseAlerts: async (): Promise<Alert[]> => [],
      ...overrides,
    };
  }

  it("seeds on first cycle, stores all scored items under the fetching genome id, advances to generation 1", async () => {
    const res = await runCycle(goalId, deps());
    expect(res.signals).toHaveLength(2);
    expect(res.signals.every((s) => s.genomeId === "s0")).toBe(true); // topIdx 0 on equal seed scores
    const state = repos.queryGenomeState.get(goalId)!;
    expect(state.generation).toBe(1);
    expect(state.population).toHaveLength(4);
    expect(state.scores.slice(2)).toEqual([GENOME_PRIOR_SCORE, GENOME_PRIOR_SCORE]); // offspring floor
  });

  it("non-fetching genomes carry their prior score forward (no NaN)", async () => {
    await runCycle(goalId, deps());
    const res = await runCycle(goalId, deps());
    const state = repos.queryGenomeState.get(goalId)!;
    expect(state.scores.every((s) => Number.isFinite(s))).toBe(true);
    expect(res.signals.length).toBeGreaterThan(0);
  });
});
