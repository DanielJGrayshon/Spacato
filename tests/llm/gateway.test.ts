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
});
