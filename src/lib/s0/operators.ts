import { z } from "zod";
import type { Genome } from "@/lib/esc/core";
import type { GoalInterpretation } from "@/lib/store/types";

type Gateway = { complete<T>(req: { model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; schema: z.ZodType<T> }): Promise<T> };

const interpretationSchema = z.object({
  scope: z.string(), successMetric: z.string(), constraints: z.string(),
  motivation: z.string(), deadlineShape: z.string(),
}).describe("goal-interpretation");

const seedSchema = z.object({ candidates: z.array(interpretationSchema) }).describe("seed-candidates");
const oneSchema = z.object({ interpretation: interpretationSchema }).describe("one-interpretation");

export function makeOperators(gw: Gateway, rawGoal: string, k: number, model: string) {
  const sys = { role: "system" as const, content: "You interpret a user's free-text goal into structured candidate interpretations. Reply only with JSON matching the schema." };
  return {
    async seed(): Promise<Genome<GoalInterpretation>[]> {
      const out = await gw.complete({
        model,
        messages: [sys, { role: "user", content: `Goal: "${rawGoal}". Produce ${k} DISTINCT plausible interpretations across scope, successMetric, constraints, motivation, deadlineShape. Reply ONLY with a JSON OBJECT of the exact shape {"candidates":[{"scope":"...","successMetric":"...","constraints":"...","motivation":"...","deadlineShape":"..."}, ...]} — do NOT return a bare top-level array.` }],
        schema: seedSchema,
      });
      return out.candidates.slice(0, k).map((value) => ({ value }));
    },
    async crossover(a: Genome<GoalInterpretation>, b: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>> {
      const out = await gw.complete({
        model,
        messages: [sys, { role: "user", content: `Blend these two interpretations into one coherent interpretation. A: ${JSON.stringify(a.value)} B: ${JSON.stringify(b.value)}. Reply ONLY with {"interpretation":{"scope":"...","successMetric":"...","constraints":"...","motivation":"...","deadlineShape":"..."}}.` }],
        schema: oneSchema,
      });
      return { value: out.interpretation };
    },
    async mutate(g: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>> {
      const out = await gw.complete({
        model,
        messages: [sys, { role: "user", content: `Perturb ONE dimension of this interpretation to a plausible alternative: ${JSON.stringify(g.value)}. Reply ONLY with {"interpretation":{"scope":"...","successMetric":"...","constraints":"...","motivation":"...","deadlineShape":"..."}}.` }],
        schema: oneSchema,
      });
      return { value: out.interpretation };
    },
  };
}
