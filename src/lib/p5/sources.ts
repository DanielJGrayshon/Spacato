import { z, type ZodType } from "zod";
import type { SourceKey, FeedKind, FeedItem } from "@/lib/p5/types";

export interface SourceConfig {
  key: SourceKey;
  kind: FeedKind;
  baseUrl: string;
  description: string;
  apiKeyEnvVar: string;
  buildUrl(terms: string[], apiKey: string): string;
  responseSchema: ZodType<any>;
  normalise(raw: any): FeedItem[];
}

// --- NewsAPI (news) ---
const newsApiSchema = z.object({
  status: z.string().optional(),
  totalResults: z.number().optional(),
  articles: z.array(
    z.object({
      title: z.string(),
      description: z.string().nullable().optional(),
      url: z.string(),
      publishedAt: z.string(),
      source: z.object({ name: z.string().nullable().optional() }).optional(),
    })
  ),
});

// --- OpenWeatherMap (weather, current conditions) ---
const openWeatherSchema = z.object({
  name: z.string(),
  dt: z.number(),
  weather: z.array(z.object({ id: z.number(), main: z.string(), description: z.string() })).min(1),
  main: z.object({ temp: z.number() }),
});

// --- Alpha Vantage NEWS_SENTIMENT (market) ---
const alphaVantageSchema = z.object({
  feed: z.array(
    z.object({
      title: z.string(),
      summary: z.string().nullable().optional(),
      url: z.string(),
      time_published: z.string(),
    })
  ),
});

export const SOURCES: Record<SourceKey, SourceConfig> = {
  newsapi: {
    key: "newsapi",
    kind: "news",
    baseUrl: "https://newsapi.org",
    description: "NewsAPI — everything search across global news outlets",
    apiKeyEnvVar: "NEWSAPI_KEY",
    buildUrl: (terms, key) =>
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(terms.join(" "))}&pageSize=5&apiKey=${key}`,
    responseSchema: newsApiSchema,
    normalise: (raw: z.infer<typeof newsApiSchema>): FeedItem[] =>
      raw.articles.map((a) => ({
        id: a.url,
        source: "newsapi",
        kind: "news",
        title: a.title,
        summary: a.description ?? "",
        publishedAt: a.publishedAt,
        url: a.url,
        rawPayload: a,
      })),
  },
  openweather: {
    key: "openweather",
    kind: "weather",
    baseUrl: "https://api.openweathermap.org",
    description: "OpenWeatherMap — current weather conditions for a named location",
    apiKeyEnvVar: "OPENWEATHER_KEY",
    buildUrl: (terms, key) =>
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(terms.join(" "))}&appid=${key}`,
    responseSchema: openWeatherSchema,
    normalise: (raw: z.infer<typeof openWeatherSchema>): FeedItem[] => [
      {
        id: `${raw.name}-${raw.dt}`,
        source: "openweather",
        kind: "weather",
        title: `${raw.name} weather: ${raw.weather[0].description}`,
        summary: `${raw.weather[0].main}, ${(raw.main.temp - 273.15).toFixed(1)}°C in ${raw.name}`,
        publishedAt: new Date(raw.dt * 1000).toISOString(),
        rawPayload: raw,
      },
    ],
  },
  alphavantage: {
    key: "alphavantage",
    kind: "market",
    baseUrl: "https://www.alphavantage.co",
    description: "Alpha Vantage NEWS_SENTIMENT — market and financial news by ticker/topic",
    apiKeyEnvVar: "ALPHAVANTAGE_KEY",
    buildUrl: (terms, key) =>
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(terms.join(","))}&apikey=${key}`,
    responseSchema: alphaVantageSchema,
    normalise: (raw: z.infer<typeof alphaVantageSchema>): FeedItem[] =>
      raw.feed.map((f) => ({
        id: f.url,
        source: "alphavantage",
        kind: "market",
        title: f.title,
        summary: f.summary ?? "",
        publishedAt: f.time_published,
        url: f.url,
        rawPayload: f,
      })),
  },
};

// Startup assertion (spec §7.2): every source must be HTTPS. Runs at module import.
for (const cfg of Object.values(SOURCES)) {
  if (!cfg.baseUrl.startsWith("https://")) {
    throw new Error(`sources.ts: source "${cfg.key}" baseUrl must be HTTPS, got "${cfg.baseUrl}"`);
  }
}
