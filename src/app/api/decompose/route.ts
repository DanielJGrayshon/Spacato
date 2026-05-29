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

  // Minor 3: reject 0 / negative / non-integer goalIds before they reach the handler.
  const goalId = (body as { goalId?: unknown })?.goalId;
  if (typeof goalId !== "number" || !Number.isInteger(goalId) || goalId <= 0) {
    return NextResponse.json(
      { error: "goalId must be a positive integer" },
      { status: 400 },
    );
  }

  // I-2: explicit env-var guard — surfaces a clear 500 rather than "Bearer undefined" → opaque 401.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY not configured" },
      { status: 500 },
    );
  }

  try {
    const db = openDb(process.env.SPACATO_DB_PATH);
    const repos = makeRepositories(db);
    const gw = makeGateway({ apiKey, cache: repos.llmCache });
    const model = process.env.P2_DECOMPOSE_MODEL ?? "openai/gpt-4o-mini";
    const ops = makeOperators(gw, model);
    // UTC midnight matches calendar.ts's UTC-anchored arithmetic.
    // Trade-off: users in non-UTC timezones may see the first day of their plan as "tomorrow".
    const today = new Date().toISOString().slice(0, 10);

    const result = await handleDecompose({ goalId }, { repos, ops, calendar, today });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // I-1: coerce non-Error throws (strings, plain objects) to a message string
    // before passing to mapErrorToStatus — avoids /regex/.test(undefined) crash.
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: mapErrorToStatus(msg) });
  }
}
