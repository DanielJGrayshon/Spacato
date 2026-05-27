import { describe, it, expect } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";

function gatewayReturning(obj: unknown) {
  const repos = makeRepositories(openDb(":memory:"));
  const fetchFn = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
  return makeGateway({ apiKey: "k", cache: repos.llmCache, fetchFn });
}

const interp = { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };

describe("s0 operators", () => {
  it("seed returns K candidate interpretations", async () => {
    const gw = gatewayReturning({ candidates: [interp, interp, interp] });
    const ops = makeOperators(gw, "free text goal", 3, "model");
    const pop = await ops.seed();
    expect(pop).toHaveLength(3);
    expect(pop[0].value.scope).toBe("s");
  });

  it("crossover and mutate return a single interpretation genome", async () => {
    const gw = gatewayReturning({ interpretation: interp });
    const ops = makeOperators(gw, "free text goal", 3, "model");
    const child = await ops.crossover({ value: interp }, { value: interp });
    expect(child.value.successMetric).toBe("m");
    const mutant = await ops.mutate({ value: interp });
    expect(mutant.value.scope).toBe("s");
  });
});
