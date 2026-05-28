import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleAcknowledge } from "@/lib/p5/acknowledge-handler";
import { engagementFactor } from "@/lib/p5/esc-adapter";
import type { FeedItem } from "@/lib/p5/types";

const feed = (id: string): FeedItem => ({
  id, source: "newsapi", kind: "news", title: id, summary: id,
  publishedAt: "2026-05-27T00:00:00Z", url: "https://x/" + id, rawPayload: {},
});

describe("p5 acknowledge handler", () => {
  let repos: ReturnType<typeof makeRepositories>;
  let goalId: number;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
    goalId = repos.goals.create({ title: "g", rawText: "g" }).id;
  });

  function seedAlert(genomeId = "g1", payloadId = "p1", relevance = 0.9) {
    const signal = repos.signals.create({
      goalId, genomeId, source: "newsapi", kind: "news",
      payload: feed(payloadId), relevanceScore: relevance,
    });
    const alert = repos.alerts.create({
      signalId: signal.id, goalId, impactScore: relevance, message: "m",
    });
    return { signal, alert };
  }

  it("success path: acks an open alert and marks it acknowledged in the DB", () => {
    const { alert } = seedAlert();
    expect(repos.alerts.listOpen(goalId)).toHaveLength(1);
    const result = handleAcknowledge({ alertId: alert.id }, { repos });
    expect(result).toEqual({ ok: true });
    expect(repos.alerts.listOpen(goalId)).toHaveLength(0);
  });

  // Idempotency: better-sqlite3's UPDATE ... WHERE id = ? reports `changes === 1` when the row
  // is matched, regardless of whether the value actually changed. So ack-twice is silently OK
  // (info.changes stays 1), and the repo does NOT throw on the second call. The handler thus
  // returns { ok: true } both times. (If the repo were to switch to a value-change predicate —
  // e.g. WHERE id = ? AND acknowledged = 0 — this would become a 404; flip the assertion then.)
  it("idempotency: acking an already-acked alert silently returns ok", () => {
    const { alert } = seedAlert();
    expect(handleAcknowledge({ alertId: alert.id }, { repos })).toEqual({ ok: true });
    expect(handleAcknowledge({ alertId: alert.id }, { repos })).toEqual({ ok: true });
    expect(repos.alerts.listOpen(goalId)).toHaveLength(0);
  });

  it("unknown id: returns 404 with the repo error message", () => {
    const result = handleAcknowledge({ alertId: 999999 }, { repos });
    expect(result).toEqual({ error: expect.stringContaining("no row with id 999999"), status: 404 });
  });

  it("malformed body: missing alertId -> 400", () => {
    const result = handleAcknowledge({}, { repos });
    expect(result).toMatchObject({ status: 400 });
    expect((result as { error: string }).error).toEqual(expect.any(String));
  });

  it("malformed body: string alertId -> 400", () => {
    const result = handleAcknowledge({ alertId: "abc" }, { repos });
    expect(result).toMatchObject({ status: 400 });
  });

  it("malformed body: negative alertId -> 400", () => {
    const result = handleAcknowledge({ alertId: -1 }, { repos });
    expect(result).toMatchObject({ status: 400 });
  });

  it("malformed body: non-integer alertId -> 400", () => {
    const result = handleAcknowledge({ alertId: 1.5 }, { repos });
    expect(result).toMatchObject({ status: 400 });
  });

  // The point of this whole route: with one open, unacked alert for genome "g1",
  // engagementFactor = (acked + 0.5) / (total + 1) = (0 + 0.5) / (1 + 1) = 0.25.
  // After ack: (1 + 0.5) / (1 + 1) = 0.75. The factor is no longer pinned at the prior.
  it("engagement shift: factor increases after acknowledge (no longer inert)", () => {
    const { alert } = seedAlert("g1");
    const before = engagementFactor(repos, "g1");
    expect(before).toBeCloseTo(0.25, 10);

    const result = handleAcknowledge({ alertId: alert.id }, { repos });
    expect(result).toEqual({ ok: true });

    const after = engagementFactor(repos, "g1");
    expect(after).toBeCloseTo(0.75, 10);
    expect(after).toBeGreaterThan(before);
  });
});
