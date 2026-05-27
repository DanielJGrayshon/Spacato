import { describe, it, expect } from "vitest";
import { extractKeywords, keywordScore, scoreItems, KEYWORD_MIN_THRESHOLD } from "@/lib/p5/relevance";
import type { FeedItem } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = {
  scope: "run a marathon",
  successMetric: "finish 42km under 4 hours",
  constraints: "weekday evenings only",
  motivation: "personal health",
  deadlineShape: "race in october",
};
const item = (title: string, summary: string): FeedItem => ({
  id: title, source: "newsapi", kind: "news", title, summary, publishedAt: "2026-05-20T00:00:00Z", rawPayload: {},
});

// Gateway stub: returns one RelevanceResult per request, scores set by title prefix.
function judgeStub(scoreByTitle: Record<string, number>) {
  return {
    async batchComplete<T>(reqs: { messages: { content: string }[] }[]): Promise<T[]> {
      return reqs.map((r) => {
        const title = Object.keys(scoreByTitle).find((t) => r.messages.some((m) => m.content.includes(t)))!;
        return { score: scoreByTitle[title], reasoning: "x" } as unknown as T;
      });
    },
  };
}

describe("relevance", () => {
  it("extractKeywords drops stop-words and short tokens", () => {
    const kw = extractKeywords(spec);
    expect(kw.has("marathon")).toBe(true);
    expect(kw.has("a")).toBe(false);   // stop-word / 1-char
    expect(kw.has("the")).toBe(false);
  });

  it("keywordScore is hits/size capped at 1", () => {
    const kw = extractKeywords(spec);
    const hi = keywordScore(item("Marathon training plan", "finish the race under 4 hours"), kw);
    const lo = keywordScore(item("Stock market dips", "shares fell today"), kw);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("blends 0.3*keyword + 0.7*llm for gated-in items", async () => {
    const it1 = item("Marathon training plan", "finish the race under 4 hours");
    const gw = judgeStub({ "Marathon training plan": 1 });
    const [scored] = await scoreItems([it1], spec, gw, "model");
    expect(scored.llmScore).toBe(1);
    expect(scored.finalScore).toBeCloseTo(0.3 * scored.keywordScore + 0.7 * 1, 5);
  });

  it("items below the keyword gate skip the LLM and keep finalScore = keywordScore", async () => {
    const off = item("Quarterly tractor sales", "agricultural equipment demand");
    const gw = judgeStub({});  // should never be consulted
    const [scored] = await scoreItems([off], spec, gw, "model");
    expect(scored.keywordScore).toBeLessThan(KEYWORD_MIN_THRESHOLD);
    expect(scored.llmScore).toBeNull();
    expect(scored.finalScore).toBe(scored.keywordScore);
  });

  it("re-aligns LLM scores to the original item order across mixed gated/un-gated input", async () => {
    const offA = item("zzz aaa", "qqq");                       // gated out (no overlap)
    const onB = item("Marathon training plan", "finish the race under 4 hours"); // gated in
    const offC = item("vvv www", "uuu");                       // gated out (no overlap)
    const gw = judgeStub({ "Marathon training plan": 0.6 });
    const out = await scoreItems([offA, onB, offC], spec, gw, "model");
    expect(out.map((s) => s.item.id)).toEqual(["zzz aaa", "Marathon training plan", "vvv www"]);
    expect(out[0].llmScore).toBeNull();
    expect(out[1].llmScore).toBe(0.6);   // score landed on the correct (middle) item, not index 0
    expect(out[2].llmScore).toBeNull();
  });

  it("returns every item even when none reach the LLM (no batchComplete call)", async () => {
    let called = false;
    const gw = { async batchComplete<T>(): Promise<T[]> { called = true; return []; } };
    const off = item("zzz", "qqq");
    const out = await scoreItems([off], spec, gw, "model");
    expect(out).toHaveLength(1);
    expect(called).toBe(false);
  });
});
