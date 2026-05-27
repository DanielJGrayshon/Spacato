import type { Db } from "./db";
import type { Goal } from "./types";

export function makeRepositories(db: Db) {
  return {
    goals: {
      create(input: { title: string; rawText: string }): Goal {
        const info = db
          .prepare("INSERT INTO goal (title, raw_text) VALUES (?, ?)")
          .run(input.title, input.rawText);
        return this.get(Number(info.lastInsertRowid))!;
      },
      get(id: number): Goal | undefined {
        const row = db.prepare("SELECT * FROM goal WHERE id = ?").get(id) as any;
        if (!row) return undefined;
        return {
          id: row.id,
          title: row.title,
          rawText: row.raw_text,
          convergedSpec: row.converged_spec_json ? JSON.parse(row.converged_spec_json) : null,
          status: row.status,
        };
      },
      setConvergedSpec(id: number, spec: unknown): void {
        db.prepare(
          "UPDATE goal SET converged_spec_json = ?, status = 'converged', updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(spec), id);
      },
    },
    llmCache: {
      get(hash: string, model: string): unknown | undefined {
        const row = db
          .prepare("SELECT response_json FROM llm_cache WHERE prompt_hash = ? AND model = ?")
          .get(hash, model) as any;
        return row ? JSON.parse(row.response_json) : undefined;
      },
      put(hash: string, model: string, response: unknown): void {
        db.prepare(
          "INSERT OR REPLACE INTO llm_cache (prompt_hash, model, response_json) VALUES (?, ?, ?)"
        ).run(hash, model, JSON.stringify(response));
      },
    },
  };
}
