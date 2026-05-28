import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Genome } from "@/lib/esc/core";
import type { QueryGenome } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";
import { SOURCES } from "@/lib/p5/sources";

type Gateway = {
  complete<T>(req: { model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; schema: z.ZodType<T> }): Promise<T>;
};

const queryTermSchema = z.object({
  source: z.enum(["newsapi", "openweather", "alphavantage"]),
  terms: z.array(z.string()).min(1).max(5),
  weight: z.number(),
});

/** Full genome (with id) — used to validate persisted/assembled genomes. */
export const queryGenomeSchema = z.object({
  id: z.string(),
  queries: z.array(queryTermSchema).min(2).max(6),
});

/** Genome body as the LLM returns it (no id; the operator mints one). */
const genomeBodySchema = z.object({ queries: z.array(queryTermSchema).min(2).max(6) });
const seedSchema = z.object({ population: z.array(genomeBodySchema) });

export type GenomeOperators = ReturnType<typeof makeGenomeOperators>;

export function makeGenomeOperators(gw: Gateway, spec: GoalInterpretation, populationSize: number, model: string) {
  const sourceList = Object.values(SOURCES).map((s) => `${s.key}: ${s.description}`).join("\n");
  const sys = { role: "system" as const, content: "You generate search-query sets for a news/signals aggregator. Reply only with JSON matching the schema." };

  const shapeRule = `The "source" field MUST be exactly one of these three string values: "newsapi", "openweather", or "alphavantage".`;

  return {
    async seed(): Promise<Genome<QueryGenome>[]> {
      const out = await gw.complete({
        model,
        messages: [
          sys,
          { role: "user" as const, content: `Goal spec: ${JSON.stringify(spec)}\nAvailable sources:\n${sourceList}\nProduce ${populationSize} DISTINCT query sets (2-4 queries each) that would surface news, weather, or market events relevant to this goal. Vary them in focus and breadth.\nReply ONLY with a JSON OBJECT shaped exactly like {"population":[{"queries":[{"source":"newsapi","terms":["..."],"weight":1}, ...]}, ...]}; do NOT return a bare top-level array. ${shapeRule}` },
        ],
        schema: seedSchema,
      });
      return out.population.slice(0, populationSize).map((body) => ({ value: { id: randomUUID(), queries: body.queries } }));
    },

    async crossover(a: Genome<QueryGenome>, b: Genome<QueryGenome>): Promise<Genome<QueryGenome>> {
      const out = await gw.complete({
        model,
        messages: [
          sys,
          { role: "user" as const, content: `Parent A queries: ${JSON.stringify(a.value.queries)}\nParent B queries: ${JSON.stringify(b.value.queries)}\nMerge into a single coherent query set of 2-4 entries. Remove duplicates. Keep terms most likely to surface goal-relevant signals.\nReply ONLY with a JSON OBJECT shaped exactly like {"queries":[{"source":"newsapi","terms":["..."],"weight":1}, ...]}. ${shapeRule}` },
        ],
        schema: genomeBodySchema,
      });
      return { value: { id: randomUUID(), queries: out.queries } };
    },

    async mutate(g: Genome<QueryGenome>): Promise<Genome<QueryGenome>> {
      const out = await gw.complete({
        model,
        messages: [
          sys,
          { role: "user" as const, content: `Current genome: ${JSON.stringify(g.value.queries)}\nMutate exactly ONE query term (change its source, refine its terms, or add/remove one term). Goal spec for context: ${JSON.stringify(spec)}\nReply ONLY with a JSON OBJECT shaped exactly like {"queries":[{"source":"newsapi","terms":["..."],"weight":1}, ...]}. ${shapeRule}` },
        ],
        schema: genomeBodySchema,
      });
      return { value: { id: randomUUID(), queries: out.queries } };
    },
  };
}
