import { describe, it, expect, vi } from "vitest";
import { ingest } from "@/lib/p5/feed-ingest";
import type { QueryTerm } from "@/lib/p5/types";

function okResponse(body: unknown) {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}
const env = { NEWSAPI_KEY: "k", OPENWEATHER_KEY: "k", ALPHAVANTAGE_KEY: "k" } as unknown as NodeJS.ProcessEnv;
const newsQuery: QueryTerm = { source: "newsapi", terms: ["solar"], weight: 1 };

describe("feed-ingest", () => {
  it("fetches, validates and normalises a source response", async () => {
    const body = { status: "ok", totalResults: 1, articles: [{ title: "T", description: "D", url: "https://newsapi.org/a", publishedAt: "2026-05-20T00:00:00Z" }] };
    const items = await ingest([newsQuery], { fetchFn: okResponse(body), env });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("T");
    expect(items[0].source).toBe("newsapi");
  });

  it("returns [] (no throw) when the API key is missing", async () => {
    const items = await ingest([newsQuery], { fetchFn: okResponse({}), env: {} as unknown as NodeJS.ProcessEnv });
    expect(items).toEqual([]);
  });

  it("returns [] when the response fails schema validation", async () => {
    const items = await ingest([newsQuery], { fetchFn: okResponse({ articles: "bad" }), env });
    expect(items).toEqual([]);
  });

  it("returns [] when the fetch times out / rejects", async () => {
    const items = await ingest([newsQuery], { fetchFn: async () => { throw new Error("timeout"); }, env });
    expect(items).toEqual([]);
  });

  it("returns [] on a non-ok HTTP status", async () => {
    const items = await ingest([newsQuery], { fetchFn: async () => new Response("nope", { status: 429 }), env });
    expect(items).toEqual([]);
  });

  it("passes redirect:error and an abort signal to fetch", async () => {
    const spy = vi.fn<typeof fetch>(okResponse({ status: "ok", articles: [] }) as unknown as typeof fetch);
    await ingest([newsQuery], { fetchFn: spy, env });
    const opts = spy.mock.calls[0][1] as RequestInit;
    expect(opts.redirect).toBe("error");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("stamps each item with the originating query term's weight", async () => {
    const body = { status: "ok", articles: [{ title: "T", description: "D", url: "https://newsapi.org/a", publishedAt: "2026-05-20T00:00:00Z" }] };
    const items = await ingest([{ source: "newsapi", terms: ["solar"], weight: 3 }], { fetchFn: okResponse(body), env });
    expect(items).toHaveLength(1);
    expect(items[0].queryWeight).toBe(3);
  });
});
