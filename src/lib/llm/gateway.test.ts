import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { makeGateway } from "./gateway";

/** Build a fake fetch Response whose body is the given object serialised as JSON. */
function makeJsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

/** Minimal no-op cache that never hits. */
function makeCache() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    put: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Happy-path: cache miss → fetch → parse → cache write
// ---------------------------------------------------------------------------

describe("complete – cache miss then store", () => {
  it("fetches when cache misses and stores the parsed result", async () => {
    const cache = makeCache();
    const fetchFn = vi.fn().mockResolvedValue(
      makeJsonResponse({
        choices: [{ message: { content: '{"answer":99}' } }],
      }),
    );
    const gw = makeGateway({ apiKey: "test", cache, fetchFn });

    const result = await gw.complete({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.number() }),
    });

    expect(result).toEqual({ answer: 99 });
    expect(cache.get).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Happy-path: cache hit → return immediately without fetch
// ---------------------------------------------------------------------------

describe("complete – cache hit", () => {
  it("returns cached value without calling fetch", async () => {
    const cache = {
      get: vi.fn().mockReturnValue({ answer: 55 }),
      put: vi.fn(),
    };
    const fetchFn = vi.fn();
    const gw = makeGateway({ apiKey: "test", cache, fetchFn });

    const result = await gw.complete({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({ answer: z.number() }),
    });

    expect(result).toEqual({ answer: 55 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bypassCache
// ---------------------------------------------------------------------------

describe("bypassCache", () => {
  it("does not read from cache when bypassCache is true", async () => {
    const cache = {
      get: vi.fn().mockReturnValue("should-not-be-used"),
      put: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse({
      choices: [{ message: { content: '{"value":42}' } }],
    }));
    const gw = makeGateway({
      apiKey: "test", cache, fetchFn,
    });

    const schema = z.object({ value: z.number() });
    const result = await gw.complete({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      schema,
      bypassCache: true,
    });

    expect(result).toEqual({ value: 42 });
    expect(cache.get).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not write to cache when bypassCache is true", async () => {
    const cache = { get: vi.fn().mockReturnValue(undefined), put: vi.fn() };
    const fetchFn = vi.fn().mockResolvedValue(makeJsonResponse({
      choices: [{ message: { content: '{"value":1}' } }],
    }));
    const gw = makeGateway({ apiKey: "test", cache, fetchFn });

    await gw.complete({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ value: z.number() }),
      bypassCache: true,
    });

    expect(cache.put).not.toHaveBeenCalled();
  });

  it("uses the cache normally when bypassCache is false or absent", async () => {
    const cache = {
      get: vi.fn().mockReturnValue({ value: 7 }),
      put: vi.fn(),
    };
    const fetchFn = vi.fn();
    const gw = makeGateway({ apiKey: "test", cache, fetchFn });

    const result = await gw.complete({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ value: z.number() }),
      // bypassCache omitted — defaults to false
    });

    expect(result).toEqual({ value: 7 });
    expect(cache.get).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
