import { NextRequest, NextResponse } from "next/server";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { handleAcknowledge } from "@/lib/p5/acknowledge-handler";

export async function POST(req: NextRequest) {
  const input = (await req.json()) as unknown;
  const repos = makeRepositories(openDb());
  const result = handleAcknowledge(input, { repos });
  if ("ok" in result) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
