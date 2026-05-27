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
    const req = { model: "m", messages: [{ role: "user", content: "q" }], schema };
    await gw.complete(req);
    await gw.complete(req);
    expect(calls).toBe(1);
  });

  it("batchComplete resolves all requests", async () => {
    const gw = makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn: recordedFetch({ answer: "b" }) });
    const reqs = [1, 2, 3].map((n) => ({ model: "m", messages: [{ role: "user", content: `q${n}` }], schema }));
    const outs = await gw.batchComplete(reqs);
    expect(outs).toHaveLength(3);
    expect(outs[0]).toEqual({ answer: "b" });
  });
});
