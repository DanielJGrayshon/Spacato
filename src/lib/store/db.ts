import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function openDb(file = "spacato.sqlite"): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(path.join(process.cwd(), "src/lib/store/schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
