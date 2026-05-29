import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, MigratorError } from "@/lib/store/migrate";

// Each test gets a fresh in-memory DB and a fresh tmp migrations dir so the
// migrator's filesystem reads are real (no mocks) but isolated per case.
function makeDb(): Database.Database {
  return new Database(":memory:");
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

describe("applyMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "spacato-mig-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMig(name: string, sql: string): void {
    writeFileSync(path.join(dir, name), sql, "utf8");
  }

  it("on a fresh DB with no migration files: returns [], schema_migrations table exists with zero rows", () => {
    const db = makeDb();
    const applied = applyMigrations(db, dir);
    expect(applied).toEqual([]);
    expect(tableExists(db, "schema_migrations")).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("applies a single migration end-to-end", () => {
    writeMig("001-foo.sql", "CREATE TABLE foo (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    const applied = applyMigrations(db, dir);
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);
    expect(applied[0].description).toBe("foo");
    expect(applied[0].appliedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(tableExists(db, "foo")).toBe(true);
    const rows = db.prepare("SELECT version, description FROM schema_migrations").all();
    expect(rows).toEqual([{ version: 1, description: "foo" }]);
  });

  it("applies three migrations in version order", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    writeMig("003-c.sql", "CREATE TABLE c (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    const applied = applyMigrations(db, dir);
    expect(applied.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(applied.map((m) => m.description)).toEqual(["a", "b", "c"]);
    for (const t of ["a", "b", "c"]) {
      expect(tableExists(db, t)).toBe(true);
    }
    const count = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(count.c).toBe(3);
  });

  it("is a no-op when run a second time on an up-to-date DB", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    applyMigrations(db, dir);
    const beforeCount = (db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    const secondApplied = applyMigrations(db, dir);
    expect(secondApplied).toEqual([]);
    const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);
  });

  it("applies only newly-added migrations when the DB already holds prior ones", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    applyMigrations(db, dir);
    writeMig("003-bar.sql", "CREATE TABLE bar (id INTEGER PRIMARY KEY);");
    const applied = applyMigrations(db, dir);
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(3);
    expect(applied[0].description).toBe("bar");
    expect(tableExists(db, "bar")).toBe(true);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    expect(count).toBe(3);
  });

  it("rolls back atomically when a migration SQL has a syntax error", () => {
    writeMig("001-good.sql", "CREATE TABLE good (id INTEGER PRIMARY KEY);");
    // Two statements: the first would create `bad`, the second is broken.
    // Both must roll back if better-sqlite3 executes them in one transaction.
    writeMig("002-broken.sql", "CREATE TABLE bad (id INTEGER PRIMARY KEY); CREATE TABEL really_bad (id INTEGER);");
    const db = makeDb();
    expect(() => applyMigrations(db, dir)).toThrow(MigratorError);
    // Migration 1 is committed and recorded.
    expect(tableExists(db, "good")).toBe(true);
    // Migration 2 rolled back: the `bad` table from the first statement of file 2 must not exist.
    expect(tableExists(db, "bad")).toBe(false);
    // The version-log row for 2 is not present.
    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("MigratorError on syntax error carries file and version attribution", () => {
    writeMig("001-broken.sql", "CREATE TABEL x (id INTEGER);");
    const db = makeDb();
    let caught: unknown = null;
    try {
      applyMigrations(db, dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigratorError);
    const err = caught as MigratorError;
    expect(err.file).toBe("001-broken.sql");
    expect(err.version).toBe(1);
    expect(err.cause).toBeDefined();
  });

  it("rejects duplicate version numbers across two files", () => {
    writeMig("003-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("003-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    let caught: unknown = null;
    try {
      applyMigrations(db, dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigratorError);
    const err = caught as MigratorError;
    expect(err.message).toContain("003-a.sql");
    expect(err.message).toContain("003-b.sql");
    expect(err.version).toBe(3);
    // No migrations applied.
    const count = (db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("rejects a version gap in the pending sequence", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    writeMig("004-d.sql", "CREATE TABLE d (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    let caught: unknown = null;
    try {
      applyMigrations(db, dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigratorError);
    const err = caught as MigratorError;
    expect(err.message).toMatch(/expected 3.*found 4/);
    // Strict v1: gap detection must precede any apply, so nothing is recorded.
    const count = (db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    expect(count).toBe(0);
    expect(tableExists(db, "a")).toBe(false);
  });

  it("ignores files in the dir that do not match the migration regex", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("README.md", "# notes");
    writeMig(".001-a.sql.swp", "garbage");
    writeMig("002-b.sql.bak", "garbage");
    writeMig("xx-not-numeric.sql", "garbage");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    const applied = applyMigrations(db, dir);
    expect(applied.map((m) => m.version)).toEqual([1, 2]);
    expect(tableExists(db, "a")).toBe(true);
    expect(tableExists(db, "b")).toBe(true);
  });

  it("returns [] for an empty directory", () => {
    const db = makeDb();
    const applied = applyMigrations(db, dir);
    expect(applied).toEqual([]);
    expect(tableExists(db, "schema_migrations")).toBe(true);
  });

  it("preserves migration 1 when migration 2 fails, then succeeds after fix", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABEL b (id INTEGER);");
    writeMig("003-c.sql", "CREATE TABLE c (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    expect(() => applyMigrations(db, dir)).toThrow(MigratorError);
    // 1 committed; 2 rolled back; 3 never attempted.
    expect(tableExists(db, "a")).toBe(true);
    expect(tableExists(db, "b")).toBe(false);
    expect(tableExists(db, "c")).toBe(false);
    const rows1 = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(rows1).toEqual([{ version: 1 }]);
    // Fix migration 2 and re-run; 2 and 3 should now apply.
    writeFileSync(path.join(dir, "002-b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);", "utf8");
    const applied2 = applyMigrations(db, dir);
    expect(applied2.map((m) => m.version)).toEqual([2, 3]);
    expect(tableExists(db, "b")).toBe(true);
    expect(tableExists(db, "c")).toBe(true);
  });

  it("is idempotent across N consecutive calls", () => {
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    writeMig("003-c.sql", "CREATE TABLE c (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    const first = applyMigrations(db, dir);
    expect(first).toHaveLength(3);
    for (let i = 0; i < 5; i++) {
      const subsequent = applyMigrations(db, dir);
      expect(subsequent).toEqual([]);
    }
    const count = (db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    expect(count).toBe(3);
  });

  it("stores the filename slug verbatim in description", () => {
    writeMig("001-elicitation-vectors-json.sql", "CREATE TABLE x (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    applyMigrations(db, dir);
    const row = db.prepare("SELECT description FROM schema_migrations WHERE version=1").get() as {
      description: string;
    };
    expect(row.description).toBe("elicitation-vectors-json");
  });

  it("wraps a missing-directory failure in MigratorError with null file/version", () => {
    const db = makeDb();
    const missing = path.join(dir, "does-not-exist");
    let caught: unknown = null;
    try {
      applyMigrations(db, missing);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigratorError);
    const err = caught as MigratorError;
    expect(err.file).toBeNull();
    expect(err.version).toBeNull();
  });

  it("rejects a pending sequence that does not begin at lastApplied+1", () => {
    // Pre-seed DB at version 2; then offer 004 only (gap from 3).
    writeMig("001-a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig("002-b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    const db = makeDb();
    applyMigrations(db, dir);
    writeMig("004-d.sql", "CREATE TABLE d (id INTEGER PRIMARY KEY);");
    let caught: unknown = null;
    try {
      applyMigrations(db, dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigratorError);
    const err = caught as MigratorError;
    expect(err.message).toMatch(/expected 3.*found 4/);
    expect(tableExists(db, "d")).toBe(false);
  });
});
