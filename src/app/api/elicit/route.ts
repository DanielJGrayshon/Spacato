import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";
import { handleElicit, type ElicitInput } from "@/lib/s0/elicit-handler";

const MODEL = "openai/gpt-4o-mini";

export async function POST(req: NextRequest) {
  const input = (await req.json()) as ElicitInput;
  const repos = makeRepositories(openDb());
  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY ?? "", cache: repos.llmCache });
  const rawGoal = input.action === "start" ? input.rawGoal : "";
  const ops = makeOperators(gw, rawGoal, 4, MODEL);
  const embed = (text: string) => gw.embed(text, "openai/text-embedding-3-small");
  const result = await handleElicit(input, { repos, ops, embed });
  return NextResponse.json(result);
}
