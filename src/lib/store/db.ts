import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function openDb(file = "spacato.sqlite"): Db {
  const db = new Database(file);
  // WAL mode improves concurrent read performance. Note: this pragma is a no-op for :memory: databases.
  db.pragma("journal_mode = WAL");
  // Assumes the process runs from the project root (true for `next dev` and Vitest).
  const schema = readFileSync(path.join(process.cwd(), "src/lib/store/schema.sql"), "utf8");
  db.exec(schema);
  try {
    db.exec("ALTER TABLE goal ADD COLUMN active_decomposition_id INTEGER");
  } catch (err) {
    if (!String((err as Error).message).includes("duplicate column")) throw err;
  }
  return db;
}
