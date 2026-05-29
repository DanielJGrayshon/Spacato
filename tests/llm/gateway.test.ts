import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";

const schema = z.object({ answer: z.string() });

function recordedFetch(body: object) {
  return async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
      { status: 200 }
    );
}

describe("llm-gateway", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => { repos = makeRepositories(openDb(":memory:")); });

  it("returns schema-validated structured output", async () => {
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn: recordedFetch({ answer: "hi" }) });
    const out = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    expect(out).toEqual({ answer: "hi" });
  });

  it("strips a ```json markdown fence around the model's JSON before parsing", async () => {
    const fenced = '```json\n{"answer":"hi"}\n```';
    const fetchFn = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: fenced } }] }),
      { status: 200 }
    );
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const out = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    expect(out).toEqual({ answer: "hi" });
  });

  it("strips a bare ``` fence (no language tag) before parsing", async () => {
    const fenced = '```\n{"answer":"hi"}\n```';
    const fetchFn = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: fenced } }] }),
      { status: 200 }
    );
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const out = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    expect(out).toEqual({ answer: "hi" });
  });

  it("strips a fence with an arbitrary language tag (e.g. ```javascript)", async () => {
    const fenced = '```javascript\n{"answer":"hi"}\n```';
    const fetchFn = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: fenced } }] }),
      { status: 200 }
    );
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const out = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    expect(out).toEqual({ answer: "hi" });
  });

  it("requests JSON mode (response_format json_object) in the OpenRouter request body", async () => {
    let capturedBody: string | undefined;
    const fetchFn: typeof fetch = async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"answer":"hi"}' } }] }),
        { status: 200 }
      );
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!) as { response_format?: unknown };
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("wraps a non-JSON OpenRouter response body in an attributable error", async () => {
    const html = "<!DOCTYPE html><html><body>Bad gateway</body></html>";
    const fetchFn = async () => new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await expect(
      gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema })
    ).rejects.toThrow(/non-JSON response body/);
  });

  it("serves the second identical call from cache (no second fetch)", async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return recordedFetch({ answer: "cached" })(); };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const req = { model: "m", messages: [{ role: "user" as const, content: "q" }], schema };
    await gw.complete(req);
    await gw.complete(req);
    expect(calls).toBe(1);
  });

  it("batchComplete resolves all requests", async () => {
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn: recordedFetch({ answer: "b" }) });
    const reqs = [1, 2, 3].map((n) => ({ model: "m", messages: [{ role: "user" as const, content: `q${n}` }], schema }));
    const outs = await gw.batchComplete(reqs);
    expect(outs).toHaveLength(3);
    expect(outs[0]).toEqual({ answer: "b" });
  });

  it("throws an attributable error when the response has no text content", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await expect(
      gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema })
    ).rejects.toThrow(/no text content/);
  });

  it("does not collide cache for different schemas with identical model+messages", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      const body = calls === 1 ? { answer: "a" } : { value: 1 };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const a = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema: z.object({ answer: z.string() }) });
    const b = await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema: z.object({ value: z.number() }) });
    expect(calls).toBe(2);
    expect(a).toEqual({ answer: "a" });
    expect(b).toEqual({ value: 1 });
  });

  it("batchComplete respects maxConcurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "b" }) } }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn, maxConcurrency: 2 });
    const reqs = Array.from({ length: 6 }, (_, n) => ({ model: "m", messages: [{ role: "user" as const, content: `q${n}` }], schema }));
    const outs = await gw.batchComplete(reqs);
    expect(outs).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("embed returns the vector from a recorded response", async () => {
    const fetchFn = async () => new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200 }
    );
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const v = await gw.embed("hello", "test-model");
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  it("embed serves the second identical call from cache (no second fetch)", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await gw.embed("hi", "m");
    await gw.embed("hi", "m");
    expect(calls).toBe(1);
  });

  it("embed throws an attributable error when data[0].embedding is missing", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 });
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await expect(gw.embed("hi", "m")).rejects.toThrow(/no embedding/);
  });

  it("embed throws on non-ok HTTP status", async () => {
    const fetchFn = async () => new Response("nope", { status: 429 });
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await expect(gw.embed("hi", "m")).rejects.toThrow(/embeddings 429/);
  });

  it("embedBatch resolves all requests and respects maxConcurrency", async () => {
    let inFlight = 0, maxInFlight = 0;
    const fetchFn = async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn, maxConcurrency: 2 });
    const out = await gw.embedBatch(["a", "b", "c", "d"], "m");
    expect(out).toHaveLength(4);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("embed and chat completions use distinct cache keys", async () => {
    let chatCalls = 0, embedCalls = 0;
    const fetchFn = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/embeddings")) {
        embedCalls++;
        return new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), { status: 200 });
      }
      chatCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "x" }) } }] }), { status: 200 });
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    await gw.complete({ model: "m", messages: [{ role: "user", content: "q" }], schema });
    await gw.embed("q", "m");
    expect(chatCalls).toBe(1);
    expect(embedCalls).toBe(1);
  });

  it("bypassCache=true skips the cache read and always hits the network", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return recordedFetch({ answer: "fresh" })();
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const req = { model: "m", messages: [{ role: "user" as const, content: "q" }], schema };
    await gw.complete(req);
    await gw.complete({ ...req, bypassCache: true });
    expect(calls).toBe(2);
  });

  it("bypassCache=true skips the cache write so subsequent calls cannot hit cache", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return recordedFetch({ answer: "fresh" })();
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const req = { model: "m", messages: [{ role: "user" as const, content: "q" }], schema, bypassCache: true };
    await gw.complete(req);
    await gw.complete({ ...req, bypassCache: false });
    expect(calls).toBe(2);
  });

  it("bypassCache absent (default false) preserves caching behaviour", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return recordedFetch({ answer: "cached" })();
    };
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
    const req = { model: "m", messages: [{ role: "user" as const, content: "q" }], schema };
    await gw.complete(req);
    await gw.complete(req);
    expect(calls).toBe(1);
  });
});
