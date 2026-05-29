// P2 live-run driver: goal-agnostic. Given a JSON fixture describing a converged
// goal (title, rawText, timeframe, 5-field convergedSpec), this script:
//
//   1. Seeds the goal into a dedicated SQLite file (so the dev DB is untouched).
//   2. Spawns `next dev` as a child process against that SQLite file.
//   3. Polls the dev server until `/api/decompose` is reachable, then POSTs.
//   4. Tears the child down.
//   5. Writes a goal-agnostic live-run markdown report to docs/live-runs/.
//
// Usage:
//   npx vite-node -c vitest.config.ts scripts/p2-live-run.ts <fixture.json> [--out <path>]
//
// Example:
//   npx vite-node -c vitest.config.ts scripts/p2-live-run.ts \
//     scripts/fixtures/p2-marathon-goal.json
//
// Anticipated by docs/superpowers/specs/2026-05-28-p2-decomposition-design.md §10.4.
// Costs real money (~$0.013 / run for the marathon-shape fixture).
//
// Heuristics-first: the script does the deterministic plumbing (seed, spawn,
// poll, POST, doc). No LLM call here — the dev server still drives /api/decompose.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";

const DEV_PORT = Number(process.env.P2_LIVE_PORT ?? 3457);
const MODEL = process.env.P2_DECOMPOSE_MODEL ?? "openai/gpt-4o-mini";
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
const POST_TIMEOUT_MS = 120_000;

interface Fixture {
  title: string;
  rawText: string;
  timeframe: string;
  convergedSpec: {
    scope: string;
    successMetric: string;
    constraints: string;
    motivation: string;
    deadlineShape: string;
  };
}

interface CliArgs {
  fixturePath: string;
  outPath: string | undefined;
}

interface PostResult {
  status: number | undefined;
  body: unknown;
  err: string | undefined;
  elapsedMs: number;
}

function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (process.env[key] === undefined) process.env[key] = val.trim();
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let fixturePath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") {
      outPath = args[++i];
    } else if (a.startsWith("--out=")) {
      outPath = a.slice("--out=".length);
    } else if (!fixturePath) {
      fixturePath = a;
    } else {
      throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (!fixturePath) {
    throw new Error(
      "usage: p2-live-run.ts <fixture.json> [--out <path>]\n" +
        "       fixture must contain { title, rawText, timeframe, convergedSpec{5 fields} }",
    );
  }
  return { fixturePath, outPath };
}

function loadFixture(fixturePath: string): Fixture {
  const raw = readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<Fixture>;
  const missing: string[] = [];
  if (!parsed.title) missing.push("title");
  if (!parsed.rawText) missing.push("rawText");
  if (!parsed.timeframe) missing.push("timeframe");
  const spec = parsed.convergedSpec as Fixture["convergedSpec"] | undefined;
  if (!spec) {
    missing.push("convergedSpec");
  } else {
    for (const k of [
      "scope",
      "successMetric",
      "constraints",
      "motivation",
      "deadlineShape",
    ] as const) {
      if (!spec[k]) missing.push(`convergedSpec.${k}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`fixture missing required fields: ${missing.join(", ")}`);
  }
  return parsed as Fixture;
}

// Deterministic slug: lowercase, alphanumeric + hyphen, collapse runs, trim ends.
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "goal";
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function seedGoal(
  dbPath: string,
  fx: Fixture,
): { goalId: number; status: string | undefined } {
  const db = openDb(dbPath);
  const repos = makeRepositories(db);
  const goal = repos.goals.create({
    title: fx.title,
    rawText: fx.rawText,
    timeframe: fx.timeframe,
  });
  repos.goals.setConvergedSpec(goal.id, fx.convergedSpec);
  const seeded = repos.goals.get(goal.id);
  // Better-sqlite3 handles close idempotently; we drop the handle so next dev can open it.
  db.close();
  return { goalId: goal.id, status: seeded?.status };
}

function spawnDevServer(dbPath: string): ChildProcess {
  // On Windows, npx is `npx.cmd`. Use shell:true so we don't have to hunt the binary.
  const child = spawn(
    "npx",
    ["next", "dev", "-p", String(DEV_PORT)],
    {
      env: {
        ...process.env,
        SPACATO_DB_PATH: dbPath,
        P2_DECOMPOSE_MODEL: MODEL,
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[next] ${b}`));
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[next!] ${b}`));
  return child;
}

async function waitForReady(port: number): Promise<void> {
  const url = `http://localhost:${port}/api/decompose`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // A GET on a POST-only route returns 405 once the server is up; that's our "ready" signal.
      const res = await fetch(url, { method: "GET" });
      if (res.status === 405 || res.status === 200 || res.status === 400) return;
    } catch {
      // connection refused — server not up yet
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(`dev server not ready on :${port} within ${READY_TIMEOUT_MS}ms`);
}

async function postDecompose(port: number, goalId: number): Promise<PostResult> {
  const url = `http://localhost:${port}/api/decompose`;
  const t0 = Date.now();
  let status: number | undefined;
  let body: unknown;
  let err: string | undefined;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goalId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { rawText: text };
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  return { status, body, err, elapsedMs: Date.now() - t0 };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    // On Windows, spawn(..., { shell: true }) wraps the command in cmd.exe, so
    // child.pid is the shell — SIGTERM kills the wrapper but orphans `next dev`.
    // Use taskkill /T to terminate the entire process tree. POSIX uses SIGTERM
    // + SIGKILL fallback.
    if (process.platform === "win32" && child.pid !== undefined) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 3000);
    }
  });
}

interface DocInputs {
  fx: Fixture;
  fixturePath: string;
  dbPath: string;
  goalId: number;
  status: string | undefined;
  today: string;
  port: number;
  model: string;
  post: PostResult;
}

function shapeSummary(body: unknown): string {
  if (!body || typeof body !== "object") return "n/a";
  const b = body as {
    tree?: { monthlies?: unknown[]; weeklies?: unknown[]; dailyTasks?: unknown[] };
  };
  // weeklies and dailyTasks are arrays grouped by parent (array-of-arrays).
  // Flatten one level to get a flat count comparable to the spec/marathon doc.
  const flatLen = (a: unknown[] | undefined): number => {
    if (!a) return 0;
    return a.reduce<number>((n, x) => n + (Array.isArray(x) ? x.length : 1), 0);
  };
  const m = b.tree?.monthlies?.length ?? 0;
  const w = flatLen(b.tree?.weeklies);
  const d = flatLen(b.tree?.dailyTasks);
  return `${m} monthlies / ${w} weeklies / ${d} daily tasks`;
}

function buildDoc(inp: DocInputs): string {
  const { fx, fixturePath, dbPath, goalId, status, today, port, model, post } = inp;
  const bodyJson = JSON.stringify(post.body, null, 2);
  const shape = shapeSummary(post.body);
  return `# P2 live-run — ${fx.title}, ${today}

> Generated by \`scripts/p2-live-run.ts\` from fixture \`${fixturePath}\`.
> Out-of-CI; costs real money. Anticipated by \`docs/superpowers/specs/2026-05-28-p2-decomposition-design.md\` §10.4.

## Inputs

| field | value |
|---|---|
| Endpoint | \`POST http://localhost:${port}/api/decompose\` |
| Request body | \`{ "goalId": ${goalId} }\` |
| Model (\`P2_DECOMPOSE_MODEL\`) | \`${model}\` |
| Today (server clock) | \`${today}\` (UTC) |
| DB | \`${dbPath}\` (dedicated; not the working DB) |
| Fixture | \`${fixturePath}\` |

### Goal as run (seeded converged)

| field | value |
|---|---|
| \`title\` | ${fx.title} |
| \`rawText\` | ${fx.rawText} |
| \`timeframe\` | ${fx.timeframe} |
| \`status\` | ${status ?? "unknown"} |
| \`convergedSpec.scope\` | ${fx.convergedSpec.scope} |
| \`convergedSpec.successMetric\` | ${fx.convergedSpec.successMetric} |
| \`convergedSpec.constraints\` | ${fx.convergedSpec.constraints} |
| \`convergedSpec.motivation\` | ${fx.convergedSpec.motivation} |
| \`convergedSpec.deadlineShape\` | ${fx.convergedSpec.deadlineShape} |

## Run metrics

| metric | value |
|---|---|
| HTTP status | \`${post.status ?? "n/a"}\` |
| Wall-clock | ${(post.elapsedMs / 1000).toFixed(2)} s |
| Tree shape | ${shape} |
${post.err ? `| Error | \`${post.err}\` |\n` : ""}
## Full response body

\`\`\`json
${bodyJson}
\`\`\`

## Reproduction

\`\`\`bash
npx vite-node -c vitest.config.ts scripts/p2-live-run.ts ${fixturePath}
\`\`\`
`;
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY missing from .env.local");
  }
  const { fixturePath, outPath } = parseArgs(process.argv);
  const fx = loadFixture(fixturePath);

  const today = todayISO();
  const slug = slugify(fx.title);
  const dbPath = `spacato-${slug}-${today}.sqlite`;
  const resolvedOut = outPath ?? `docs/live-runs/${today}-p2-${slug}.md`;

  // Fresh DB every run — if a previous attempt left one behind, drop it so seed
  // always yields goalId=1 and the doc's request-body table stays predictable.
  for (const suffix of ["", "-shm", "-wal"]) {
    const f = `${dbPath}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }

  console.log(`[live-run] fixture=${fixturePath}`);
  console.log(`[live-run] db=${dbPath}`);
  console.log(`[live-run] out=${resolvedOut}`);
  console.log(`[live-run] model=${MODEL} port=${DEV_PORT} today=${today}`);

  const { goalId, status } = seedGoal(dbPath, fx);
  console.log(`[seed] goalId=${goalId} status=${status}`);

  const child = spawnDevServer(dbPath);
  let post: PostResult;
  try {
    console.log(`[dev] waiting for :${DEV_PORT} (timeout ${READY_TIMEOUT_MS}ms)…`);
    await waitForReady(DEV_PORT);
    console.log(`[dev] ready; POSTing goalId=${goalId}`);
    post = await postDecompose(DEV_PORT, goalId);
    console.log(
      `[POST] status=${post.status} elapsedMs=${post.elapsedMs}` +
        (post.err ? ` err=${post.err}` : ""),
    );
  } finally {
    console.log(`[dev] tearing down child pid=${child.pid}`);
    await killChild(child);
  }

  mkdirSync(path.dirname(resolvedOut), { recursive: true });
  const doc = buildDoc({
    fx,
    fixturePath,
    dbPath,
    goalId,
    status,
    today,
    port: DEV_PORT,
    model: MODEL,
    post,
  });
  writeFileSync(resolvedOut, doc);
  console.log(`[doc] wrote ${resolvedOut} (${doc.length} chars)`);

  if (post.err) process.exit(1);
  if (post.status !== 200) process.exit(2);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
