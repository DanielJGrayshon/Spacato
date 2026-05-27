import { z } from "zod";
import type { LlmRequest } from "@/lib/llm/gateway";
import type { FeedItem, ScoredItem } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

export const KEYWORD_MIN_THRESHOLD = 0.05;

type Gateway = { batchComplete<T>(reqs: LlmRequest<T>[]): Promise<T[]> };

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that",
  "these", "those", "i", "you", "he", "she", "we", "they", "my", "your", "our", "their", "not",
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function extractKeywords(spec: GoalInterpretation): Set<string> {
  const text = [spec.scope, spec.successMetric, spec.constraints, spec.motivation, spec.deadlineShape].join(" ");
  return new Set(tokenise(text));
}

export function keywordScore(item: FeedItem, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;
  const tokens = tokenise(`${item.title} ${item.summary}`);
  const hits = tokens.filter((t) => keywords.has(t)).length;
  return Math.min(hits / keywords.size, 1);
}

const relevanceSchema = z.object({ score: z.number().min(0).max(1), reasoning: z.string().max(120) });
type RelevanceResult = z.infer<typeof relevanceSchema>;

export async function scoreItems(
  items: FeedItem[],
  spec: GoalInterpretation,
  gw: Gateway,
  model: string
): Promise<ScoredItem[]> {
  const keywords = extractKeywords(spec);
  const ks = items.map((i) => keywordScore(i, keywords));

  const gatedIn = items
    .map((item, idx) => ({ item, idx, k: ks[idx] }))
    .filter((x) => x.k >= KEYWORD_MIN_THRESHOLD);

  const sys = { role: "system" as const, content: "You are a relevance judge. Score how directly this item affects the given goal. Reply only with JSON matching the schema." };
  const reqs: LlmRequest<RelevanceResult>[] = gatedIn.map((x) => ({
    model,
    messages: [
      sys,
      { role: "user" as const, content: `Goal spec: ${JSON.stringify(spec)}\nItem title: ${x.item.title}\nItem summary: ${x.item.summary}\nItem kind: ${x.item.kind}` },
    ],
    schema: relevanceSchema,
  }));

  const results = reqs.length ? await gw.batchComplete(reqs) : [];
  const llmByIdx = new Map<number, number>();
  gatedIn.forEach((x, j) => llmByIdx.set(x.idx, results[j].score));

  return items.map((item, idx) => {
    const k = ks[idx];
    // has/get (not `?? null`): a genuine LLM score of 0 is valid and must not be coerced to null.
    const llm = llmByIdx.has(idx) ? llmByIdx.get(idx)! : null;
    const finalScore = llm === null ? k : 0.3 * k + 0.7 * llm;
    return { item, keywordScore: k, llmScore: llm, finalScore };
  });
}
