# Spacato — Schema Migration Framework v1 Design Spec

> Date: 2026-05-29 · Status: **drafted** · Repo: github.com/DanielJGrayshon/Spacato
> Parent docs: `docs/canonical-project-graph.md`, HANDOFF.md §5 step 6 ("Schema migration framework"),
> P5 OQ-4, semantic-distance OQ-3, P2 OQ-3.
> Agents building this adopt the canonical role prompt (see HANDOFF.md §0).

---

## 1. Motivation

The schema-migration debt has now been deferred across **three shipped features and one drafted one**:

| Feature | Additive change | Mechanism on `main` |
|---|---|---|
| P5 signals | `external_signal.genome_id TEXT NOT NULL DEFAULT ''` | `CREATE TABLE IF NOT EXISTS` + column-with-default. Existing DBs without the column would NOT have it; `IF NOT EXISTS` does not retrofit columns. |
| Semantic distance | `elicitation_state.vectors_json TEXT NOT NULL DEFAULT '{}'` | Same — `CREATE TABLE IF NOT EXISTS` + column-with-default. |
| P2 decomposition | `goal.active_decomposition_id INTEGER`; `goal.timeframe TEXT NOT NULL DEFAULT '6 months'`; new tables `decomposition`, `monthly`, `weekly`, `daily_task` and four indices | Defensive `try { ALTER TABLE … } catch (duplicate column) {…}` blocks in `src/lib/store/db.ts:openDb` — for the goal columns. The new tables piggyback `IF NOT EXISTS`. |
| P3 sliding-window (drafted, not yet built) | New tables `slide_log`, `user_edit`, `slippage_observation` + indices | Spec explicitly leans on the wipe-or-defensive-ALTER stance and calls out that **this debt resolves before the 8th additive event**. |

Across S0, P5, P2, and now P3 we have accumulated:
1. `external_signal.genome_id`
2. `elicitation_state.vectors_json`
3. `goal.active_decomposition_id`
4. `goal.timeframe`
5. P2 tables (`decomposition`, `monthly`, `weekly`, `daily_task`) + indices
6. P3 tables (`slide_log`, `user_edit`, `slippage_observation`) + indices (queued)

Two distinct mechanisms have evolved in `openDb` (`schema.sql` `IF NOT EXISTS` + try/catch defensive `ALTER TABLE`). Both have the same failure mode at scale: a developer with a stale local DB silently runs against an under-schema database until a query fails at runtime against a missing column. The defensive-ALTER pattern also depends on string-matching the SQLite error message — fragile across SQLite versions.

**The seventh additive event has accumulated.** P3 explicitly states it ships on the existing stance only because the framework lands first. This spec defines that framework.

---

## 2. Goals & non-goals

**Goals**
- One deterministic mechanism for every schema change going forward. No more split between `IF NOT EXISTS` in `schema.sql` and try/catch `ALTER TABLE` in `openDb`.
- Versioning the schema in the database itself, so any DB file's current schema version is a single SQL query (`SELECT MAX(version) FROM schema_migrations`).
- Idempotent application — running `openDb` twice on the same DB applies zero migrations the second time.
- Ordered, transactional per migration — a partially applied migration never appears in the version log; rollback on failure is atomic at the SQLite layer.
- A plain-SQL on-disk format under `src/lib/store/migrations/NNN-description.sql` that's diffable in git, runnable from `sqlite3` for spot-checks, and trivial to author.
- Migrations live in source; the framework is responsible only for sequencing, applying, and recording. Authoring a new migration is **one new `.sql` file + one numeric bump**.
- The framework runs on **every** `openDb` call — there is no separate `migrate` script in v1. Single-user local app: boot-time application is the right cost trade.

**Non-goals (v1)**
- **Destructive operations.** No `DROP TABLE`, no `DROP COLUMN`, no `ALTER TYPE` that narrows. (SQLite has no native `DROP COLUMN` pre-3.35, and even on modern versions destructive ops change row layout; doing them safely requires a copy-table dance that's its own spec.)
- **Data backfills that aren't pure SQL.** A migration that needs to call out to TypeScript or the LLM gateway to populate values is v2.
- **Down migrations.** v1 is one-way. Rolling back a bad migration is a manual exercise (restore the DB, fix the migration file, re-run). Single-user local app: the cost of a bad migration is bounded by the size of the dev DB.
- **Parallel/concurrent safety.** Spacato is a single-user local app; the only concurrency is `next dev`'s hot-reload re-opening the DB. v1 relies on SQLite's own per-connection locking; no advisory locks, no leader election.
- **Cross-DB migrations** (e.g. swap SQLite for Postgres). Out of scope; the framework's interface stays narrow enough that swapping the runtime is a separate project.
- **Migration linting** (e.g. rejecting `DROP TABLE` at CI time). v1 trusts authors; v2 may add a precommit check.
- **Sidecar pruning** of stale rows referenced by deferred-items lists. The framework is about schema only; data cleanup is per-feature.

---

## 3. Architecture & data flow

```
openDb(file?)
   │
   ▼
new Database(file); pragma journal_mode = WAL
   │
   ▼
applyMigrations(db, migrationsDir)
   │
   ├─► ensureMigrationsTable(db)                          (CREATE TABLE IF NOT EXISTS schema_migrations)
   ├─► appliedVersions = readApplied(db)                  (SELECT version FROM schema_migrations)
   ├─► pending = discoverMigrations(migrationsDir)
   │     • read files matching /^(\d{3})-([a-z0-9-]+)\.sql$/
   │     • parse version (int) + description (slug)
   │     • sort by version ascending
   │     • filter out versions already in appliedVersions
   │     • assert no gaps (next version === lastApplied + 1, or 1 if none applied)
   │
   ├─► for each pending migration in order:
   │     db.transaction(() => {
   │       db.exec(sqlText)
   │       db.prepare("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, datetime('now'))")
   │         .run(version, description)
   │     })()
   │     • SQLite's BEGIN..COMMIT wraps schema DDL and the version-log insert atomically
   │     • A failing migration aborts the transaction → no schema change, no log row
   │     • The exception propagates with the migration filename attributed
   │
   ▼
return db
```

**Heuristic / LLM split** (heuristics-first per role prompt).
- *Heuristic, every step:* file discovery (regex + sort), version-log read, gap detection, transaction boundary, version-log write, error attribution. No LLM involvement anywhere. Schema is structure; deterministic code owns it.

**Sole integration point.** `src/lib/store/db.ts:openDb`. The defensive `try { ALTER TABLE … }` blocks currently in `openDb` (lines 14–23) are deleted; their effect is moved into numbered migration files (see §6). `schema.sql` is reduced to the **baseline** schema — what the v1 DB looked like before any of the additive changes landed — and becomes migration `001-baseline.sql`.

**Why on boot, not a separate script.** Single-user local app; one process opens the DB at a time (`next dev` or vitest). The cost of running `discoverMigrations` is one `readdirSync` on a directory of <20 files; the cost of querying `schema_migrations` is one indexed `SELECT`. Both are sub-millisecond. A separate `npm run migrate` would only add ceremony.

**Why one transaction per migration, not one transaction for the batch.** Per-migration transactions mean a failure on migration 6 leaves migrations 1–5 applied and recorded — restartable, debuggable. A batch transaction would roll all of them back and force the author to keep re-applying the working ones on every iteration of fixing migration 6. SQLite DDL is transactional, so per-migration atomicity is real.

---

## 4. Components & file surface

| File | Change | Responsibility |
|---|---|---|
| `src/lib/store/migrations/` | **create dir** | Holds the numbered migration files. Read-only at runtime. |
| `src/lib/store/migrations/001-baseline.sql` | **create** | The pre-additive schema — `goal` (without `active_decomposition_id` or `timeframe`), `elicitation_state` (without `vectors_json`), `external_signal` (without `genome_id`), `alert`, `llm_cache`, `query_genome_state`. This is the schema at the `0d4999a` HEAD baseline. |
| `src/lib/store/migrations/002-elicitation-vectors-json.sql` | **create** | `ALTER TABLE elicitation_state ADD COLUMN vectors_json TEXT NOT NULL DEFAULT '{}'`. |
| `src/lib/store/migrations/003-external-signal-genome-id.sql` | **create** | `ALTER TABLE external_signal ADD COLUMN genome_id TEXT NOT NULL DEFAULT ''`. |
| `src/lib/store/migrations/004-goal-active-decomposition.sql` | **create** | `ALTER TABLE goal ADD COLUMN active_decomposition_id INTEGER`. |
| `src/lib/store/migrations/005-goal-timeframe.sql` | **create** | `ALTER TABLE goal ADD COLUMN timeframe TEXT NOT NULL DEFAULT '6 months'`. |
| `src/lib/store/migrations/006-p2-decomposition-tables.sql` | **create** | The four P2 tables (`decomposition`, `monthly`, `weekly`, `daily_task`) + the four indices. Pulled verbatim from current `schema.sql`. |
| `src/lib/store/migrate.ts` | **create** | The migrator. Exports `applyMigrations(db, migrationsDir?)` and `MigratorError`. Pure module — no globals, no logging side effects beyond the attributable error. |
| `src/lib/store/db.ts` | modify | `openDb` deletes the two defensive `try { ALTER TABLE … }` blocks; calls `applyMigrations(db, path.join(process.cwd(), "src/lib/store/migrations"))` immediately after `db.pragma("journal_mode = WAL")`. No more `readFileSync` of `schema.sql` — the migrator does it. |
| `src/lib/store/schema.sql` | **delete** | Its content has split across the six migration files. Single source of truth lives in the `migrations/` directory. |
| `tests/store/migrate.test.ts` | **create** | Unit tests for `applyMigrations` against an `:memory:` DB and a fixture migrations dir. See §8.1. |
| `tests/store/migrate-boot.test.ts` | **create** | Integration test: open a `:memory:` DB pre-seeded to migration 003 state and confirm subsequent migrations apply and the version log advances. See §8.2. |

**No other source file changes.** Repositories, types, route handlers, and feature code all keep the same `Db` they have today; the migrator is invisible to them.

---

## 5. Data model

### 5.1 `schema_migrations` table

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,                       -- 1, 2, 3, … monotonically increasing
  description TEXT    NOT NULL,                           -- slug from the filename ("p2-decomposition-tables")
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now')) -- ISO-8601 UTC, matches the rest of the schema
);
```

Three columns is enough:
- `version` is the integer parsed from the filename's `NNN-` prefix. It is also the primary key, so re-applying the same migration is a primary-key violation (the migrator catches this in development with a clear error; in v1 we never expect it to fire because `discoverMigrations` already filters applied versions before attempting any inserts).
- `description` is the slug from the filename (everything between `NNN-` and `.sql`). It exists for human debugging only — no code reads it. Storing it costs ~30 bytes per row; with one row per migration ever shipped, the table is bounded by lifetime feature count.
- `applied_at` is forensic. When a migration was applied to **this DB file** in particular — useful when a user reports stale behaviour after upgrading.

### 5.2 Filename convention

```
src/lib/store/migrations/NNN-description.sql
                         ^^^ ^^^^^^^^^^^
                          |       |
                          |       └── kebab-case slug, [a-z0-9-]+
                          └── zero-padded 3-digit version, 001..999
```

Examples:
- `001-baseline.sql`
- `002-elicitation-vectors-json.sql`
- `006-p2-decomposition-tables.sql`

Regex: `/^(\d{3})-([a-z0-9-]+)\.sql$/`. Anything in `migrations/` that doesn't match is **ignored** (not erroneous) — accommodates README files, editor swap files, and the like.

Zero-padding to 3 digits keeps `ls`/IDE file listings in sorted order. 999 caps the migration count; the cost of bumping to 4 digits when (if ever) we hit it is a trivial regex change and a one-time rename — recorded here for completeness.

### 5.3 Migration file format

Plain SQL. No frontmatter, no comments-with-meta. Examples:

```sql
-- 002-elicitation-vectors-json.sql
ALTER TABLE elicitation_state ADD COLUMN vectors_json TEXT NOT NULL DEFAULT '{}';
```

```sql
-- 006-p2-decomposition-tables.sql
CREATE TABLE decomposition (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id    INTEGER NOT NULL REFERENCES goal(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- … weekly, daily_task, indices …
```

Note `CREATE TABLE` rather than `CREATE TABLE IF NOT EXISTS`. The whole point of the version log is that we know exactly which migrations have run; `IF NOT EXISTS` would mask a real bug (some prior migration accidentally created the table) by silently no-op-ing. v1 is strict on this — a migration that fails because the table already exists is a real bug worth surfacing. The one exception is migration 001 (the baseline) which `CREATE`s on a fresh DB; we apply it only when the version log is empty, which is checked by the version-log filter before exec. So `001-baseline.sql` also drops `IF NOT EXISTS` and the framework still does the right thing.

### 5.4 TypeScript interface

```ts
// src/lib/store/migrate.ts
export interface AppliedMigration {
  version: number;
  description: string;
  appliedAt: string;
}

export class MigratorError extends Error {
  constructor(
    message: string,
    readonly file: string | null,            // migration filename when known
    readonly version: number | null,         // version when known
    readonly cause?: unknown,                // wrapped SQLite error
  ) {
    super(message);
    this.name = "MigratorError";
  }
}

export function applyMigrations(
  db: Db,
  migrationsDir?: string,                    // defaults to src/lib/store/migrations
): AppliedMigration[];                       // returns the migrations applied THIS call (empty if none pending)
```

The returned `AppliedMigration[]` is the list of migrations applied *during this call* — useful for tests and for any future "boot log" feature. On the common case (DB fully up-to-date) it returns `[]`.

---

## 6. Apply algorithm (detail)

```ts
export function applyMigrations(db: Db, migrationsDir = defaultDir()): AppliedMigration[] {
  ensureMigrationsTable(db);                                // 1
  const applied = readApplied(db);                          // 2
  const discovered = discoverMigrations(migrationsDir);     // 3
  const pending = discovered.filter(m => !applied.has(m.version));
  assertContiguous(applied, pending);                       // 4
  const log: AppliedMigration[] = [];
  for (const m of pending) {                                // 5
    runOne(db, m);
    log.push(m);
  }
  return log;
}
```

### 6.1 `ensureMigrationsTable`

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This is the **only** statement in the codebase that uses `IF NOT EXISTS`. It's a bootstrap — running `applyMigrations` on a brand-new DB needs the version log before any migration runs. The statement itself is not recorded in the version log (it's not a feature migration). After this call, every other schema change is a numbered file.

### 6.2 `readApplied`

```sql
SELECT version, description, applied_at FROM schema_migrations ORDER BY version ASC
```

Returns a `Set<number>` of versions (plus a lookup map for the `AppliedMigration[]` return). One indexed read.

### 6.3 `discoverMigrations`

```ts
function discoverMigrations(dir: string): Migration[] {
  const re = /^(\d{3})-([a-z0-9-]+)\.sql$/;
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name);
  const out: Migration[] = [];
  for (const name of files) {
    const m = re.exec(name);
    if (!m) continue;                                     // ignore non-matching (README, swap files)
    out.push({
      version: parseInt(m[1], 10),
      description: m[2],
      file: name,
      path: path.join(dir, name),
    });
  }
  out.sort((a, b) => a.version - b.version);
  // Reject duplicates — two files both numbered 003- is a developer error worth failing loudly on.
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i-1].version) {
      throw new MigratorError(
        `duplicate migration version ${out[i].version}: ${out[i-1].file} and ${out[i].file}`,
        out[i].file, out[i].version,
      );
    }
  }
  return out;
}
```

### 6.4 `assertContiguous`

Pending versions must be a contiguous tail starting at `max(applied) + 1` (or `1` if none applied). A gap (e.g. 1, 2, 4 with no 3) is a developer error — likely a renamed-but-not-resequenced file, or a merge conflict where two branches each took the next version and only one survived. The migrator refuses to proceed:

```ts
function assertContiguous(applied: Map<number, AppliedMigration>, pending: Migration[]): void {
  if (pending.length === 0) return;
  const lastApplied = applied.size === 0 ? 0 : Math.max(...applied.keys());
  for (let i = 0; i < pending.length; i++) {
    const expected = lastApplied + 1 + i;
    if (pending[i].version !== expected) {
      throw new MigratorError(
        `migration version gap: expected ${expected}, found ${pending[i].version} (${pending[i].file})`,
        pending[i].file, pending[i].version,
      );
    }
  }
}
```

### 6.5 `runOne` — the atomic step

```ts
function runOne(db: Db, m: Migration): void {
  const sql = readFileSync(m.path, "utf8");
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, datetime('now'))"
    ).run(m.version, m.description);
  });
  try {
    tx();
  } catch (err) {
    throw new MigratorError(
      `migration ${m.file} failed: ${(err as Error).message}`,
      m.file, m.version, err,
    );
  }
}
```

SQLite executes the `BEGIN`/`COMMIT` implicitly inside `db.transaction(…)`. DDL inside the transaction is committed or rolled back atomically with the version-log row. If the migration SQL fails, the SQLite transaction is rolled back automatically; the `schema_migrations` row is never inserted; the next run of `openDb` will see the same pending migration and retry.

### 6.6 Idempotency

The migrator is idempotent across runs by construction:
1. `ensureMigrationsTable` is `IF NOT EXISTS`.
2. `readApplied` is a pure read.
3. `discoverMigrations` is a pure read of the filesystem.
4. Migration files filtered by version-already-in-`schema_migrations` are not re-exec'd.
5. A successful run records the row; a failed run does not. The next run sees the same pending list (minus any that succeeded).

The only way to break idempotency is to **edit a migration file after it's been applied**. v1 does not detect this — the version-log row is a name+description, not a content hash. That's intentional (keeps the filesystem auditable as plain SQL diffable in git history) but it's a real foot-gun and is OQ-1.

---

## 7. Failure modes & recovery

| Failure | Behaviour | Recovery |
|---|---|---|
| Migration SQL has a syntax error | `db.transaction` throws; transaction rolled back; no `schema_migrations` row inserted; `MigratorError` thrown attributing the file. | Fix the SQL, re-open the DB; the migrator retries the same migration. |
| Migration SQL conflicts with current schema (e.g. column already exists) | Same as above — the SQLite error propagates wrapped in `MigratorError`. | The DB was modified outside the migration system (manual `sqlite3` session, prior defensive `ALTER TABLE` in pre-framework code). Recovery: either roll back the manual change, or manually `INSERT INTO schema_migrations` to mark the version applied, then re-open. The latter is a documented escape hatch, not an automatic behaviour. |
| Version gap (1, 2, 4 with no 3) | `MigratorError` *before* any migration runs. DB untouched. | Add the missing file, re-open. |
| Duplicate version (two `003-*.sql` files) | `MigratorError` from `discoverMigrations`. DB untouched. | Renumber one of them. |
| Migrations dir missing entirely | `readdirSync` throws; wrapped in `MigratorError` with `file: null, version: null`. | Check working directory; the path is `process.cwd() + "src/lib/store/migrations"`. |
| Process killed mid-migration | SQLite rolls back the open transaction on connection close; the partially-applied migration is gone (assuming WAL is honest, which it is). The version-log row is never inserted because the transaction wasn't committed. | Re-open the DB; the migrator retries the migration. |
| Migration file edited after being applied | Migrator does not detect; the changes are silently ignored on subsequent runs. | OQ-1: optional content hash in the version log. v1 mitigations: code review; treating migration files as append-only in PRs. |
| Two `next dev` processes opening the same DB simultaneously | SQLite's per-connection locking serialises them. The second process either sees the migration already applied (no-op) or waits on the lock. The transaction boundary keeps both safe. | Not a real failure mode for v1's single-user assumption; documented for completeness. |
| Power-loss between migration commit and process continuation | `schema_migrations` row is committed; next process sees migration as applied; correct. | None needed. |

**Manual rollback**, when truly needed: delete the row from `schema_migrations` for the offending version, fix the migration file, restart. This is the documented escape hatch and is not automated in v1 (down migrations are out of scope per §2).

---

## 8. Testing strategy

All deterministic; no LLM; no filesystem mocking — tests write fixture migration files to a tmp dir and read them back.

### 8.1 Unit tests on the migrator

`tests/store/migrate.test.ts`. Fixture migrations live in `os.tmpdir()` directories created per-test and cleaned up after; the SUT is `applyMigrations(db, tmpDir)`.

| Test | Assertion |
|---|---|
| Fresh DB + zero migrations | `applyMigrations` returns `[]`, `schema_migrations` table exists, has zero rows. |
| Fresh DB + one migration (`001-foo.sql` creates a `foo` table) | Returns `[{version:1, description:"foo", appliedAt:…}]`. `foo` table exists. `schema_migrations` has one row, version 1. |
| Fresh DB + three migrations applied in order | Returns three entries in version order. Tables created in order; row count equals 3. |
| Re-running on an up-to-date DB | Returns `[]`. `schema_migrations` row count unchanged. No DDL executed (verify by attaching a mocked `db.exec` counter — actually verified by row-count delta). |
| DB at version 2, new migration `003-bar.sql` added | Returns `[{version:3, …}]`. `schema_migrations` row count is now 3. `bar` table exists. |
| Migration SQL has a syntax error (`CREATE TABEL foo …`) | Throws `MigratorError` whose `file` and `version` are populated. The version-log row is NOT inserted (verified by reading `schema_migrations` after the throw). The `foo` table does NOT exist. The partially-applied state has been rolled back. |
| Duplicate version files (`003-a.sql` + `003-b.sql`) | Throws `MigratorError` with both filenames in the message. No migrations applied; `schema_migrations` unchanged. |
| Version gap (`001`, `002`, `004` — no `003`) | Throws `MigratorError` naming the expected vs actual version. No migrations applied; `schema_migrations` unchanged. |
| Non-matching files in dir (e.g. `README.md`, `.001-foo.sql.swp`) | Silently ignored. Other migrations apply normally. |
| Empty dir | Returns `[]`. `schema_migrations` exists with zero rows. |
| Failure in migration 2 of 3 | Migration 1 is recorded; migration 2 fails and rolls back; migration 3 is never attempted. `schema_migrations` has exactly one row, version 1. Next run with the bug fixed applies 2 and 3 normally. |
| `applyMigrations` is idempotent across N consecutive calls | After N calls, `schema_migrations` row count equals the number of migration files. Only the first call returns a non-empty result. |
| Filename slug appears verbatim in `description` column | `001-elicitation-vectors-json.sql` → `description = "elicitation-vectors-json"`. |

### 8.2 Integration test on real boot

`tests/store/migrate-boot.test.ts`. Tests the production wiring — `openDb(":memory:")` running through the real `src/lib/store/migrations/` directory.

| Test | Assertion |
|---|---|
| Fresh `openDb(":memory:")` applies every migration | `SELECT version FROM schema_migrations ORDER BY version` returns the full sequence 1..N where N is `readdirSync("src/lib/store/migrations").filter(matches-regex).length`. The schema is at the current tip — all known tables exist (`goal`, `elicitation_state`, `external_signal`, `alert`, `llm_cache`, `query_genome_state`, `decomposition`, `monthly`, `weekly`, `daily_task`, `schema_migrations`). All known columns exist on `goal` (including `active_decomposition_id` and `timeframe`). |
| Boot with `schema_migrations` pre-seeded to version 3 | Migrations 1–3 are not re-applied (verified by sentinel: insert a row into a table created by migration 1, then re-boot; the row survives because the table was not re-created). Migrations 4+ are applied. |
| Boot from a DB that already has the full schema but no `schema_migrations` table | The migrator cannot tell this DB apart from a fresh one and will attempt to re-apply migration 1. v1 stance: this only happens once during the cutover from the pre-framework code path; the cutover migration in `src/lib/store/db.ts` is the responsibility of the implementing task, NOT the framework. See §10 OQ-2. |
| Two consecutive `openDb` calls on the same file path | First call applies all migrations; second returns immediately with zero pending. |
| Repository operations against the migrated DB | `makeRepositories(openDb(":memory:"))` produces a working repos object — round-trip a goal, an elicitation_state with vectors, a decomposition + monthly. Proves the migration tip schema is compatible with `repositories.ts`. |

### 8.3 Existing suite

The existing 186 tests continue to pass with the framework in place. The `decomposition-repos.test.ts`, `elicitation-repo.test.ts`, and `repositories.test.ts` already exercise the full schema via `openDb(":memory:")` — they will go through the migrator on every test, confirming end-to-end that the migration files produce the correct schema.

Expected suite delta: **+15 tests approximately** (12 unit on the migrator, 4–5 integration on boot).

---

## 9. Cost

Boot-time overhead per `openDb` call:
- `readdirSync` on `src/lib/store/migrations/` — ~10 files at v1, sub-ms.
- One `CREATE TABLE IF NOT EXISTS schema_migrations` — sub-ms.
- One `SELECT version FROM schema_migrations ORDER BY version ASC` — indexed; sub-ms even at 100s of rows.
- Per pending migration: `readFileSync` + `db.exec` + one `INSERT`. On the common case (DB up-to-date), pending is empty.

**Total per boot on an up-to-date DB: sub-millisecond.** Negligible compared to the existing `next dev` startup or vitest harness setup. No reason to defer migration application to a separate script.

Migration-author cost: write one `.sql` file. No metadata, no boilerplate, no registry update — `discoverMigrations` finds it on next boot.

---

## 10. Open questions / deferred

**OQ-1 — Content hashing migration files.** v1 stores filename + description in the version log but not a hash of the SQL. A developer editing an already-applied migration file in place would silently desync. v2 could add a `content_hash TEXT` column populated at apply time and verified on every boot, with a clear error if the hash on disk no longer matches. The cost is one extra column and a SHA-256 per file per boot (still sub-ms). The reason it's not in v1: it adds complexity to the apply path and creates a recovery dance when a hash mismatch happens (do we fail the boot? do we warn? the right answer isn't obvious). Defer until we have a real incident, or until the team grows beyond one developer and migration-file edits become a real risk.

**OQ-2 — Cutover from the existing pre-framework `openDb`.** When this framework first lands, existing dev DBs will already have the schema at the latest additive state (because the current `openDb` runs all the defensive `ALTER TABLE`s and `IF NOT EXISTS` `CREATE TABLE`s). Those DBs have no `schema_migrations` table. The implementation task will need to ship one of two cutover strategies, called out here for the implementing worker to choose:
   - **(a)** Wipe-and-reinit during the cutover (acceptable since this is a single-user local dev DB and the `*.sqlite` files are gitignored). Simplest and matches the v1 stance HANDOFF §9 risk 4 has been documenting.
   - **(b)** A one-shot bootstrap step inside `openDb`: if `schema_migrations` does not exist AND any of the current tip's tables already do, run `INSERT INTO schema_migrations (version, description) VALUES (1, 'baseline'), (2, 'elicitation-vectors-json'), …` up to the tip without executing the SQL files, then start applying from the next version on subsequent runs. This is the "upgrade existing DB without losing data" path.
   The implementing worker is expected to pick one and document it. (a) is the lower-risk default for a v1 single-user app. If picking (b), it must be tested against a snapshot DB created with the pre-framework `openDb` to confirm the bootstrap correctly skips already-present tables.

**OQ-3 — Down migrations.** v1 is one-way. v2 may add `NNN-description.down.sql` companion files and a `rollback(db, targetVersion)` function. Down migrations have well-known correctness pitfalls (recreating dropped columns with the wrong type, reordering data) and are not worth the complexity until there's a real need.

**OQ-4 — Data-backfill migrations.** A migration that needs to compute values from existing data may need TypeScript or the LLM gateway. v2 could allow `NNN-description.ts` files that export `apply(db: Db, gw?: Gateway): void` alongside the SQL files. v1 keeps it pure SQL — the framework can't know about gateways or any other dependency without leaking app-layer concerns into a store-layer primitive.

**OQ-5 — Migration linting.** A precommit / CI hook that rejects `DROP TABLE`, `DROP COLUMN`, or `ALTER TYPE` in migration files would enforce the v1 additive-only stance mechanically. Trivial to add (regex over the SQL); deferred until the framework has been used in anger and we know what really gets reached for.

**OQ-6 — Cross-DB portability.** The framework assumes `better-sqlite3`. Postgres would want migration files in Postgres-compatible SQL, a different transaction-DDL semantics check, and probably an advisory-lock mechanism. v1 is SQLite-only by design.

**OQ-7 — Migration ordering across feature branches.** Two feature branches each adding migration `007-*.sql` will collide at merge time. The framework rejects the collision loudly (duplicate version, §6.3) but doesn't auto-resolve. v1 stance: the second branch to merge renames its file. This is a standard issue in every migration framework — calling it out as expected, not surprising. The team can adopt the convention "claim your migration number in the PR description" if collisions become frequent.

**OQ-8 — Reference to P3 spec.** The P3 sliding-window spec (`docs/superpowers/specs/2026-05-29-p3-sliding-window-design.md`) introduces three new tables (`slide_log`, `user_edit`, `slippage_observation`) and references this framework as the lander for them. Once both specs are merged the P3 implementation will add migration `007-p3-sliding-window-tables.sql` containing those three table definitions + indices, instead of appending to `schema.sql`. <!-- TODO: confirm migration 007 ownership with the orchestrator — Worker B owns P3 spec concurrently with this framework spec. -->

---

## 11. Checklist (definition of done for the implementing task)

- [ ] `src/lib/store/migrations/` directory created with `001-baseline.sql` through `006-p2-decomposition-tables.sql`. Content matches the current `main` schema verbatim (split sensibly across the six files).
- [ ] `src/lib/store/migrate.ts` exports `applyMigrations` and `MigratorError`. Signatures match §5.4.
- [ ] `src/lib/store/db.ts:openDb` deletes the two defensive `try { ALTER TABLE … }` blocks and the `readFileSync(schema.sql)` block; calls `applyMigrations(db, …)` once after `pragma journal_mode = WAL`.
- [ ] `src/lib/store/schema.sql` deleted from the repo (its content lives in the migration files).
- [ ] `tests/store/migrate.test.ts` covers every row of §8.1.
- [ ] `tests/store/migrate-boot.test.ts` covers every row of §8.2.
- [ ] `npm test` passes (existing 186 + ~15 new = ~201 expected).
- [ ] `npm run typecheck` clean.
- [ ] HANDOFF §5 step 6 ("Schema migration framework") moves from "deferred" to "done"; HANDOFF §9 risk 4 ("Schema columns added via `CREATE TABLE IF NOT EXISTS` + `DEFAULT`") is closed; HANDOFF §8 strikes the P5 OQ-4 / semantic-distance OQ-3 / P2 OQ-3 entries about migrations.
- [ ] Cutover stance from §10 OQ-2 chosen and documented in the implementation PR.
