import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { runCycle } from "@/lib/p5/esc-adapter";
import { makeGenomeOperators } from "@/lib/p5/genome";
import { ingest } from "@/lib/p5/feed-ingest";
import { scoreItems } from "@/lib/p5/relevance";
import { raiseAlerts } from "@/lib/p5/alert-logic";
import type { GoalInterpretation } from "@/lib/store/types";

const SEED_MODEL = process.env.P5_GENOME_MODEL ?? "openai/gpt-4o-mini";
const JUDGE_MODEL = process.env.P5_JUDGE_MODEL ?? "openai/gpt-4o-mini";

export async function POST(req: NextRequest) {
  const { goalId } = (await req.json()) as { goalId: number };
  const repos = makeRepositories(openDb());

  const goal = repos.goals.get(goalId);
  if (!goal || !goal.convergedSpec) {
    return NextResponse.json({ error: `goal ${goalId} not found or not converged` }, { status: 400 });
  }
  const spec = goal.convergedSpec as GoalInterpretation;

  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY ?? "", cache: repos.llmCache });
  const ops = makeGenomeOperators(gw, spec, 4, SEED_MODEL);

  const result = await runCycle(goalId, {
    repos,
    ops,
    ingest: (queries) => ingest(queries),
    scoreItems: (items) => scoreItems(items, spec, gw, JUDGE_MODEL),
    raiseAlerts: (signals) => raiseAlerts(signals, spec, repos, gw, JUDGE_MODEL),
  });

  return NextResponse.json(result);
}
