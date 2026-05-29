import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db";

/**
 * A migration that has been applied to a database, returned from
 * `applyMigrations` so callers can log/inspect what ran this boot.
 */
export interface AppliedMigration {
  version: number;
  description: string;
  appliedAt: string;
}

/**
 * Any failure path inside the migrator surfaces as this type so callers can
 * distinguish migrator faults from generic SQLite errors and attribute the
 * blame to a specific file when known.
 */
export class MigratorError extends Error {
  constructor(
    message: string,
    /** Migration filename when the failure can be attributed to one; null otherwise (e.g. dir missing). */
    readonly file: string | null,
    /** Migration version when known; null otherwise. */
    readonly version: number | null,
    /** Wrapped underlying error (typically a SQLite exception). */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MigratorError";
  }
}

interface DiscoveredMigration {
  version: number;
  description: string;
  file: string;
  fullPath: string;
}

const MIGRATION_FILE_RE = /^(\d{3})-([a-z0-9-]+)\.sql$/;

/**
 * Default migrations directory: `<cwd>/src/lib/store/migrations`. The CWD
 * assumption holds for `next dev` and Vitest, both of which run from the
 * project root.
 */
export function defaultMigrationsDir(): string {
  return path.join(process.cwd(), "src", "lib", "store", "migrations");
}

/**
 * Bootstrap the version-log table. This is the ONE statement in the codebase
 * that uses `IF NOT EXISTS`; every other schema change is a numbered file.
 */
function ensureMigrationsTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       description TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
}

/**
 * Read the set of already-applied versions. One indexed scan.
 */
function readApplied(db: Db): Set<number> {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

/**
 * Scan the migrations directory, parse filenames matching the strict
 * `NNN-slug.sql` pattern, sort by version, and reject duplicate versions.
 * Non-matching files (READMEs, swap files, .bak) are silently ignored so the
 * dir is hospitable to incidental editor output.
 */
function discoverMigrations(dir: string): DiscoveredMigration[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new MigratorError(
      `failed to read migrations directory ${dir}: ${(err as Error).message}`,
      null,
      null,
      err,
    );
  }

  const out: DiscoveredMigration[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_FILE_RE.exec(entry.name);
    if (!match) continue;
    out.push({
      version: parseInt(match[1], 10),
      description: match[2],
      file: entry.name,
      fullPath: path.join(dir, entry.name),
    });
  }
  out.sort((a, b) => a.version - b.version);

  // Duplicate versions are an outright authoring error: two files claiming
  // the same slot makes ordering ambiguous. Fail loud rather than guess.
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new MigratorError(
        `duplicate migration version ${out[i].version}: ${out[i - 1].file} and ${out[i].file}`,
        out[i].file,
        out[i].version,
      );
    }
  }
  return out;
}

/**
 * Verify the pending sequence is a contiguous tail starting at
 * `max(applied) + 1` (or 1 if no migrations have been applied yet). A gap
 * usually means a renamed-but-not-resequenced file or a merge artefact.
 */
function assertContiguous(applied: Set<number>, pending: DiscoveredMigration[]): void {
  if (pending.length === 0) return;
  const lastApplied = applied.size === 0 ? 0 : Math.max(...applied);
  for (let i = 0; i < pending.length; i++) {
    const expected = lastApplied + 1 + i;
    if (pending[i].version !== expected) {
      throw new MigratorError(
        `migration version gap: expected ${expected}, found ${pending[i].version} (${pending[i].file})`,
        pending[i].file,
        pending[i].version,
      );
    }
  }
}

/**
 * Apply one migration atomically: the DDL and the version-log INSERT live in
 * a single SQLite transaction. A failure rolls both back, so a partially
 * applied migration never gets recorded.
 */
function runOne(db: Db, m: DiscoveredMigration): AppliedMigration {
  const sql = readFileSync(m.fullPath, "utf8");
  const insertStmt = db.prepare(
    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, datetime('now'))",
  );
  const selectStmt = db.prepare(
    "SELECT applied_at FROM schema_migrations WHERE version = ?",
  );

  const tx = db.transaction(() => {
    db.exec(sql);
    insertStmt.run(m.version, m.description);
  });

  try {
    tx();
  } catch (err) {
    throw new MigratorError(
      `migration ${m.file} failed: ${(err as Error).message}`,
      m.file,
      m.version,
      err,
    );
  }

  const row = selectStmt.get(m.version) as { applied_at: string } | undefined;
  return {
    version: m.version,
    description: m.description,
    appliedAt: row?.applied_at ?? "",
  };
}

/**
 * Bring the database up to the latest on-disk migration. Idempotent: if the
 * DB is already at the tip, returns an empty array having executed zero DDL.
 * The migrations directory defaults to `<cwd>/src/lib/store/migrations`.
 */
export function applyMigrations(
  db: Db,
  migrationsDir: string = defaultMigrationsDir(),
): AppliedMigration[] {
  ensureMigrationsTable(db);
  const applied = readApplied(db);
  const discovered = discoverMigrations(migrationsDir);
  const pending = discovered.filter((m) => !applied.has(m.version));
  assertContiguous(applied, pending);

  const log: AppliedMigration[] = [];
  for (const m of pending) {
    log.push(runOne(db, m));
  }
  return log;
}
