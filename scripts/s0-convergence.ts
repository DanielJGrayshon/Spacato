// Drive S0 elicitation to convergence against real OpenRouter, in-process.
//
// Anticipated by docs/superpowers/specs/2026-05-28-s0-semantic-distance-design.md §9.4
// and HANDOFF.md §5 step 1 (OQ-1 TAU calibration).
//
// Run via:   npx vite-node -c vitest.config.ts scripts/s0-convergence.ts
//   - vitest.config.ts is reused so the "@" alias resolves the same way tests do.
//   - .env.local is parsed inline (single key OPENROUTER_API_KEY).
//
// What this does:
//   1. Constructs a real OpenRouter gateway and an in-memory SQLite store.
//   2. Calls handleElicit("start") for the goal "run a marathon in 6 months".
//   3. Loops handleElicit("answer", ...), picking the candidate whose text leans
//      more toward "finish the race, time doesn't matter" each turn.
//   4. After every step, prints generation, belief.weights, entropy, the offered
//      pair, the chosen answer, and the two candidate interpretations.
//   5. On convergence: prints final question count + the winning interpretation.
//
// This script is intended for manual operator use; it costs real money (negligible
// per the spec §11) and is not run in CI.

import { readFileSync } from "node:fs";
import path from "node:path";

import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import { makeGateway } from "@/lib/llm/gateway";
import { makeOperators } from "@/lib/s0/operators";
import { handleElicit } from "@/lib/s0/elicit-handler";
import { entropy } from "@/lib/s0/belief";
import type { ElicitationState, GoalInterpretation } from "@/lib/store/types";

const CHAT_MODEL = "openai/gpt-4o-mini";
const EMBED_MODEL = process.env.S0_EMBED_MODEL ?? "openai/text-embedding-3-small";
const RAW_GOAL = "run a marathon in 6 months";
const MAX_ANSWERS = 12; // hard ceiling > CFG.maxQuestions (8) so we always see the converge flag

// Parse .env.local just enough to pick up OPENROUTER_API_KEY. We deliberately
// don't add a dotenv dep — there's a single key and we know the file format.
function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (process.env[key] === undefined) process.env[key] = val.trim();
  }
}

// Lean toward "finish the race, time doesn't matter": +1 per token suggesting
// finishing/participation, -1 per token suggesting timed performance. The driver
// picks whichever option (a or b) scores higher; ties break to 'a'.
const FINISH_TOKENS = new Set([
  "finish", "finishing", "finished", "complete", "completion", "completing",
  "participate", "participation", "participating", "cross", "crossing",
  "any", "regardless", "untimed",
]);
const TIME_TOKENS = new Set([
  "time", "timed", "fast", "faster", "pace", "pb", "qualify", "qualifying",
  "sub", "personal", "best", "record", "speed", "minutes", "hours",
]);

function scoreInterpretation(g: GoalInterpretation): number {
  const text = [g.scope, g.successMetric, g.constraints, g.motivation, g.deadlineShape]
    .join(" ")
    .toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    if (FINISH_TOKENS.has(w)) score += 1;
    if (TIME_TOKENS.has(w)) score -= 1;
  }
  return score;
}

function pickAnswer(a: GoalInterpretation, b: GoalInterpretation): "a" | "b" {
  return scoreInterpretation(a) >= scoreInterpretation(b) ? "a" : "b";
}

function fmtWeights(ws: number[]): string {
  return "[" + ws.map((w) => w.toFixed(4)).join(", ") + "]";
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY missing from .env.local");
  }

  const db = openDb(":memory:");
  const repos = makeRepositories(db);
  const gw = makeGateway({ apiKey: process.env.OPENROUTER_API_KEY, cache: repos.llmCache });

  // Create a goal row so the elicitation can attach to it.
  const goal = repos.goals.create({ title: RAW_GOAL, rawText: RAW_GOAL });
  console.log(`[setup] goal id=${goal.id} title=${JSON.stringify(goal.title)}`);
  console.log(`[setup] chat=${CHAT_MODEL} embed=${EMBED_MODEL}`);

  const ops = makeOperators(gw, RAW_GOAL, 4, CHAT_MODEL);
  const embed = (text: string) => gw.embed(text, EMBED_MODEL);
  const deps = { repos, ops, embed };

  console.log("\n[start] handleElicit(start)…");
  const startRes = await handleElicit({ action: "start", goalId: goal.id, rawGoal: RAW_GOAL }, deps);
  let row = repos.elicitations.get(startRes.elicitationId) as ElicitationState;
  const priorWeights = [...row.beliefWeights];
  console.log(`[start] elicitationId=${startRes.elicitationId} converged=${startRes.converged}`);
  console.log(`[start] prior weights = ${fmtWeights(priorWeights)}`);
  console.log(`[start] prior entropy = ${entropy({ weights: priorWeights }).toFixed(4)}`);
  console.log(`[start] population:`);
  row.population.forEach((g, i) => console.log(`  [${i}] ${JSON.stringify(g.value)}`));
  if (!startRes.question) {
    console.log("[start] no pending question (already converged?); aborting.");
    return;
  }
  console.log(`[start] first pair = {a:${startRes.question.a}, b:${startRes.question.b}}`);

  let firstAnswerWeights: number[] | null = null;
  let questionCount = 0;
  let converged = startRes.converged;

  while (!converged && questionCount < MAX_ANSWERS) {
    row = repos.elicitations.get(startRes.elicitationId) as ElicitationState;
    const pending = row.pendingQuestion;
    if (!pending) {
      console.log("[loop] no pending question; bailing out.");
      break;
    }
    const candA = row.population[pending.a].value;
    const candB = row.population[pending.b].value;
    const answer = pickAnswer(candA, candB);
    questionCount++;

    console.log(`\n[Q${questionCount}] pair = {a:${pending.a}, b:${pending.b}}`);
    console.log(`  A: ${JSON.stringify(candA)}  (score=${scoreInterpretation(candA)})`);
    console.log(`  B: ${JSON.stringify(candB)}  (score=${scoreInterpretation(candB)})`);
    console.log(`  -> choosing "${answer}"`);

    const res = await handleElicit({ action: "answer", elicitationId: startRes.elicitationId, answer }, deps);
    converged = res.converged;
    row = repos.elicitations.get(startRes.elicitationId) as ElicitationState;
    const w = [...row.beliefWeights];
    console.log(`  posterior weights = ${fmtWeights(w)}`);
    console.log(`  posterior entropy = ${entropy({ weights: w }).toFixed(4)}`);
    if (firstAnswerWeights === null) firstAnswerWeights = w;
    if (!converged && res.question) {
      console.log(`  next pair = {a:${res.question.a}, b:${res.question.b}}`);
    }
  }

  console.log(`\n[done] converged=${converged} after ${questionCount} question(s)`);
  if (firstAnswerWeights) {
    const before = priorWeights;
    const after = firstAnswerWeights;
    const maxDelta = Math.max(...before.map((b, i) => Math.abs(b - after[i])));
    console.log(`[done] first-answer max |delta| = ${maxDelta.toFixed(4)}`);
    console.log(`[done] entropy delta (prior - post1) = ${(entropy({ weights: before }) - entropy({ weights: after })).toFixed(4)}`);
  }
  const goalAfter = repos.goals.get(goal.id);
  console.log(`[done] goal status = ${goalAfter?.status}`);
  if (goalAfter?.convergedSpec) {
    console.log(`[done] convergedSpec = ${JSON.stringify(goalAfter.convergedSpec)}`);
  }
  const finalRow = repos.elicitations.get(startRes.elicitationId) as ElicitationState;
  const finalW = finalRow.beliefWeights;
  let winIdx = 0;
  for (let i = 1; i < finalW.length; i++) if (finalW[i] > finalW[winIdx]) winIdx = i;
  console.log(`[done] winning candidate idx=${winIdx} weight=${finalW[winIdx].toFixed(4)}`);
  console.log(`[done] winning interpretation = ${JSON.stringify(finalRow.population[winIdx].value)}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
