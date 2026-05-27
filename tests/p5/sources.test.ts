import { describe, it, expect } from "vitest";
import { SOURCES } from "@/lib/p5/sources";

describe("p5 sources allow-list", () => {
  it("every source is HTTPS and buildUrl stays within baseUrl", () => {
    for (const cfg of Object.values(SOURCES)) {
      expect(cfg.baseUrl.startsWith("https://")).toBe(true);
      const url = cfg.buildUrl(["alpha", "beta"], "KEY");
      expect(url.startsWith(cfg.baseUrl)).toBe(true);
      expect(url).toContain("KEY");
    }
  });

  it("newsapi.buildUrl url-encodes the joined query", () => {
    const url = SOURCES.newsapi.buildUrl(["clean", "energy"], "K");
    expect(url).toContain("q=clean%20energy");
  });

  it("newsapi.normalise turns a validated response into FeedItems", () => {
    const raw = {
      status: "ok",
      totalResults: 1,
      articles: [
        { title: "Solar surges", description: "PV deployment up", url: "https://newsapi.org/a/1", publishedAt: "2026-05-20T10:00:00Z", source: { name: "Wire" } },
      ],
    };
    const parsed = SOURCES.newsapi.responseSchema.parse(raw);
    const items = SOURCES.newsapi.normalise(parsed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "https://newsapi.org/a/1", source: "newsapi", kind: "news", title: "Solar surges", summary: "PV deployment up" });
  });

  it("openweather.normalise produces one weather FeedItem", () => {
    const raw = { name: "Exeter", dt: 1716200000, weather: [{ id: 800, main: "Clear", description: "clear sky" }], main: { temp: 289.1 } };
    const parsed = SOURCES.openweather.responseSchema.parse(raw);
    const items = SOURCES.openweather.normalise(parsed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "openweather", kind: "weather", title: "Exeter weather: clear sky" });
  });

  it("alphavantage.normalise maps NEWS_SENTIMENT feed to market FeedItems", () => {
    const raw = { feed: [{ title: "Rates held", summary: "Central bank holds", url: "https://www.alphavantage.co/n/1", time_published: "20260520T100000" }] };
    const parsed = SOURCES.alphavantage.responseSchema.parse(raw);
    const items = SOURCES.alphavantage.normalise(parsed);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "alphavantage", kind: "market", title: "Rates held" });
  });

  it("responseSchema rejects malformed payloads", () => {
    expect(() => SOURCES.newsapi.responseSchema.parse({ articles: "nope" })).toThrow();
  });
});
