import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";
import { handleElicit, type ElicitInput } from "@/lib/s0/elicit-handler";

const MODEL = "openai/gpt-4o-mini";
const EMBED_MODEL = process.env.S0_EMBED_MODEL ?? "openai/text-embedding-3-small";

export async function POST(req: NextRequest) {
  const input = (await req.json()) as ElicitInput;
  const repos = makeRepositories(openDb());
  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY ?? "", cache: repos.llmCache });
  const rawGoal = input.action === "start" ? input.rawGoal : "";
  const ops = makeOperators(gw, rawGoal, 4, MODEL);
  const embed = (text: string) => gw.embed(text, EMBED_MODEL);
  const result = await handleElicit(input, { repos, ops, embed });
  return NextResponse.json(result);
}
