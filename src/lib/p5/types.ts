import type { Genome, EscState } from "@/lib/esc/core";

export type SourceKey = "newsapi" | "openweather" | "alphavantage";
export type FeedKind = "news" | "weather" | "market";

export interface FeedItem {
  id: string;            // source-assigned unique id (url for news/market, name-dt for weather)
  source: SourceKey;
  kind: FeedKind;
  title: string;
  summary: string;
  publishedAt: string;   // ISO datetime
  url?: string;
  rawPayload: unknown;
  queryWeight?: number;  // relative priority of the genome query term that fetched this item (set by feed-ingest); undefined → treated as 1
}

export type FeedItemPayload = FeedItem;   // the normalised FeedItem is what we persist

export interface ScoredItem {
  item: FeedItem;
  keywordScore: number;     // [0,1]
  llmScore: number | null;  // [0,1], null if it did not pass the keyword gate
  finalScore: number;       // 0.3*keyword + 0.7*llm, or keywordScore if llm null
}

export interface QueryTerm {
  source: SourceKey;
  terms: string[];   // 1-5 terms
  weight: number;
}

export interface QueryGenome {
  id: string;            // stable uuid; minted at seed/crossover/mutate; never reused
  queries: QueryTerm[];  // 2-6 entries
}

export interface StoredSignal {
  id: number;
  goalId: number;
  genomeId: string;
  source: string;
  kind: FeedKind;
  payload: FeedItemPayload;
  relevanceScore: number | null;
  fetchedAt: string;
}

export interface Alert {
  id: number;
  signalId: number;
  goalId: number;
  impactScore: number;
  message: string;
  createdAt: string;
  acknowledged: boolean;
}

// Re-export for downstream convenience
export type { Genome, EscState };
