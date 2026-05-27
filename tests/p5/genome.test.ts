import { describe, it, expect } from "vitest";
import { queryGenomeSchema, makeGenomeOperators } from "@/lib/p5/genome";
import type { GoalInterpretation } from "@/lib/store/types";

const spec: GoalInterpretation = { scope: "s", successMetric: "m", constraints: "c", motivation: "mo", deadlineShape: "d" };

// Gateway stub: complete() returns a body shaped to whatever the prompt asks for.
function gwStub(bodies: { population?: unknown; queries?: unknown }) {
  return {
    async complete<T>(req: { messages: { content: string }[] }): Promise<T> {
      if (req.messages.some((m) => m.content.includes("DISTINCT query sets"))) {
        return { population: bodies.population } as unknown as T;
      }
      return { queries: bodies.queries } as unknown as T;
    },
  };
}

const term = (s: string) => ({ source: "newsapi" as const, terms: [s], weight: 1 });

describe("genome", () => {
  it("queryGenomeSchema accepts a valid genome and rejects an empty query list", () => {
    expect(queryGenomeSchema.safeParse({ id: "x", queries: [term("a"), term("b")] }).success).toBe(true);
    expect(queryGenomeSchema.safeParse({ id: "x", queries: [] }).success).toBe(false);
  });

  it("seed mints fresh ids and respects populationSize", async () => {
    const gw = gwStub({ population: [{ queries: [term("a"), term("b")] }, { queries: [term("c"), term("d")] }, { queries: [term("e"), term("f")] }] });
    const ops = makeGenomeOperators(gw, spec, 2, "model");
    const pop = await ops.seed();
    expect(pop).toHaveLength(2);
    expect(pop[0].value.id).toBeTypeOf("string");
    expect(pop[0].value.id).not.toBe(pop[1].value.id);
  });

  it("crossover offspring gets a fresh id, not either parent's", async () => {
    const gw = gwStub({ queries: [term("merged1"), term("merged2")] });
    const ops = makeGenomeOperators(gw, spec, 2, "model");
    const a = { value: { id: "PARENT_A", queries: [term("a"), term("b")] } };
    const b = { value: { id: "PARENT_B", queries: [term("c"), term("d")] } };
    const child = await ops.crossover(a, b);
    expect(child.value.id).not.toBe("PARENT_A");
    expect(child.value.id).not.toBe("PARENT_B");
    expect(child.value.queries).toHaveLength(2);
  });

  it("mutate offspring gets a fresh id", async () => {
    const gw = gwStub({ queries: [term("x"), term("y")] });
    const ops = makeGenomeOperators(gw, spec, 2, "model");
    const g = { value: { id: "PARENT", queries: [term("a"), term("b")] } };
    const m = await ops.mutate(g);
    expect(m.value.id).not.toBe("PARENT");
  });
});
