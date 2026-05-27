import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { ALERT_THRESHOLD, raiseAlerts } from "@/lib/p5/alert-logic";
import type { FeedItem, StoredSignal } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };
const feed = (id: string): FeedItem => ({ id, source: "newsapi", kind: "news", title: id, summary: id, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {} });

function justifyStub() {
  return { async batchComplete<T>(reqs: unknown[]): Promise<T[]> { return reqs.map(() => ({ justification: "Directly affects the goal." }) as unknown as T); } };
}

describe("alert-logic", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "x", rawText: "x" }).id;
  });

  function signal(id: string, relevance: number): StoredSignal {
    return repos.signals.create({ goalId, genomeId: "G", source: "newsapi", kind: "news", payload: feed(id), relevanceScore: relevance });
  }

  it("raises alerts only for signals at/above the threshold", async () => {
    const hi = signal("hi", 0.9);
    signal("lo", 0.5);
    const alerts = await raiseAlerts([hi, repos.signals.listForGoal(goalId).find((s) => s.payload.id === "lo")!], spec, repos, justifyStub(), "model");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].signalId).toBe(hi.id);
    expect(alerts[0].impactScore).toBe(0.9);
    expect(alerts[0].message).toContain("goal");
  });

  it("skips a signal that already has an open alert (existsOpen dedup)", async () => {
    const s = signal("dup", 0.9);
    await raiseAlerts([s], spec, repos, justifyStub(), "model");
    const second = await raiseAlerts([s], spec, repos, justifyStub(), "model");
    expect(second).toHaveLength(0);
    expect(repos.alerts.listOpen(goalId)).toHaveLength(1);
  });

  it("skips a different signal with identical content while an alert is open (content dedup)", async () => {
    const s1 = signal("same-url", 0.9);
    await raiseAlerts([s1], spec, repos, justifyStub(), "model");
    const s2 = signal("same-url", 0.95); // same payload.id + source, new row
    const out = await raiseAlerts([s2], spec, repos, justifyStub(), "model");
    expect(out).toHaveLength(0);
  });

  it("ALERT_THRESHOLD is 0.75", () => {
    expect(ALERT_THRESHOLD).toBe(0.75);
  });
});
