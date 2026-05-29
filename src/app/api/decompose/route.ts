import { NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/p2/operators";
import * as calendar from "@/lib/util/calendar";
import { handleDecompose } from "@/lib/p2/decompose-handler";
import { mapErrorToStatus } from "./error-mapping";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof (body as { goalId?: unknown })?.goalId !== "number") {
    return NextResponse.json({ error: "goalId (number) is required" }, { status: 400 });
  }

  const { goalId } = body as { goalId: number };

  try {
    const db = openDb(process.env.SPACATO_DB_PATH);
    const repos = makeRepositories(db);
    const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY!, cache: repos.llmCache });
    const model = process.env.P2_DECOMPOSE_MODEL ?? "openai/gpt-4o-mini";
    const ops = makeOperators(gw, model);
    const today = new Date().toISOString().slice(0, 10);

    const result = await handleDecompose({ goalId }, { repos, ops, calendar, today });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = (err as Error).message;
    return NextResponse.json({ error: msg }, { status: mapErrorToStatus(msg) });
  }
}
