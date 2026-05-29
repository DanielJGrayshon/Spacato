import Database from "better-sqlite3";
import path from "node:path";
import { applyMigrations } from "./migrate";

export type Db = Database.Database;

export function openDb(file = "spacato.sqlite"): Db {
  const db = new Database(file);
  // WAL mode improves concurrent read performance. Note: this pragma is a no-op for :memory: databases.
  db.pragma("journal_mode = WAL");
  // Bring the DB to the latest schema. Idempotent: on an already-current DB this is a single indexed read.
  // The CWD assumption (next dev, vitest) matches what the previous schema.sql loader required.
  applyMigrations(db, path.join(process.cwd(), "src", "lib", "store", "migrations"));
  return db;
}
