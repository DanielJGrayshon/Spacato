import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import type { FeedItem, QueryGenome } from "@/lib/p5/types";
import type { EscState } from "@/lib/esc/core";

const feed = (id: string): FeedItem => ({
  id, source: "newsapi", kind: "news", title: "t", summary: "s",
  publishedAt: "2026-05-27T00:00:00Z", url: "https://x/" + id, rawPayload: {},
});

describe("p5 store repositories", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  function goal() { return repos.goals.create({ title: "g", rawText: "g" }).id; }

  it("creates and lists signals newest-first", () => {
    const g = goal();
    const a = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: 0.4 });
    const b = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("b"), relevanceScore: 0.9 });
    expect(a.id).toBeTypeOf("number");
    const list = repos.signals.listForGoal(g);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[0].payload.id).toBe("b");
    expect(list[0].genomeId).toBe("G1");
  });

  it("updateRelevance changes the score and throws on a missing row", () => {
    const g = goal();
    const s = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: null });
    repos.signals.updateRelevance(s.id, 0.8);
    expect(repos.signals.listForGoal(g)[0].relevanceScore).toBe(0.8);
    expect(() => repos.signals.updateRelevance(99999, 0.1)).toThrow();
  });

  it("creates alerts, lists only open ones, acknowledges, and dedups via existsOpen", () => {
    const g = goal();
    const s = repos.signals.create({ goalId: g, genomeId: "G1", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: 0.9 });
    const al = repos.alerts.create({ signalId: s.id, goalId: g, impactScore: 0.9, message: "m" });
    expect(repos.alerts.existsOpen(g, s.id)).toBe(true);
    expect(repos.alerts.listOpen(g).map((a) => a.id)).toEqual([al.id]);
    repos.alerts.acknowledge(al.id);
    expect(repos.alerts.listOpen(g)).toHaveLength(0);
    expect(repos.alerts.existsOpen(g, s.id)).toBe(false);
    expect(() => repos.alerts.acknowledge(99999)).toThrow();
  });

  it("engagementCounts joins alert->signal on genome_id with Laplace-friendly zeros", () => {
    const g = goal();
    const s1 = repos.signals.create({ goalId: g, genomeId: "GA", source: "newsapi", kind: "news", payload: feed("a"), relevanceScore: 0.9 });
    const s2 = repos.signals.create({ goalId: g, genomeId: "GA", source: "newsapi", kind: "news", payload: feed("b"), relevanceScore: 0.9 });
    const a1 = repos.alerts.create({ signalId: s1.id, goalId: g, impactScore: 0.9, message: "m" });
    repos.alerts.create({ signalId: s2.id, goalId: g, impactScore: 0.9, message: "m" });
    repos.alerts.acknowledge(a1.id);
    expect(repos.alerts.engagementCounts("GA")).toEqual({ acked: 1, total: 2 });
    expect(repos.alerts.engagementCounts("UNKNOWN")).toEqual({ acked: 0, total: 0 });
  });

  it("signals.listByIds returns only the requested rows, [] for empty input", () => {
    const repos = makeRepositories(openDb(":memory:"));
    const goalId = repos.goals.create({ title: "x", rawText: "x" }).id;
    const mk = (pid: string) => repos.signals.create({
      goalId, genomeId: "g", source: "newsapi", kind: "news" as const, relevanceScore: 0.1,
      payload: { id: pid, source: "newsapi", kind: "news", title: pid, summary: "", publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} },
    });
    const a = mk("a"); const b = mk("b"); mk("c");
    expect(repos.signals.listByIds([]).length).toBe(0);
    expect(repos.signals.listByIds([a.id, b.id]).map((s) => s.payload.id).sort()).toEqual(["a", "b"]);
  });

  it("queryGenomeState round-trips and upserts", () => {
    const g = goal();
    expect(repos.queryGenomeState.get(g)).toBeNull();
    const genome: QueryGenome = { id: "G1", queries: [{ source: "newsapi", terms: ["x"], weight: 1 }] };
    const state: EscState<QueryGenome> = { population: [{ value: genome }], scores: [0.1], generation: 0, bestScore: 0.1 };
    repos.queryGenomeState.save(g, state);
    expect(repos.queryGenomeState.get(g)).toEqual(state);
    const next: EscState<QueryGenome> = { ...state, generation: 1, bestScore: 0.5, scores: [0.5] };
    repos.queryGenomeState.save(g, next);
    expect(repos.queryGenomeState.get(g)!.generation).toBe(1);
  });
});
