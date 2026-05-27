import type { Db } from "./db";
import type { Goal, ElicitationState, ElicitationQuestion, GoalInterpretation } from "./types";
import type { Genome } from "@/lib/esc/core";

// Standalone helper — used by both `create` and `get` so `create` never calls `this.get`.
function getGoal(db: Db, id: number): Goal | undefined {
  const row = db.prepare("SELECT * FROM goal WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    rawText: row.raw_text,
    convergedSpec: row.converged_spec_json ? JSON.parse(row.converged_spec_json) : null,
    status: row.status,
  };
}

// Standalone helper — avoids `this`-binding issues when the method is destructured.
function getElicitation(db: Db, id: number): ElicitationState | undefined {
  const row = db.prepare("SELECT * FROM elicitation_state WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    goalId: row.goal_id,
    generation: row.generation,
    population: JSON.parse(row.population_json),
    beliefWeights: JSON.parse(row.belief_json),
    pendingQuestion: row.pending_question_json ? JSON.parse(row.pending_question_json) : null,
    status: row.status,
  };
}

export function makeRepositories(db: Db) {
  return {
    goals: {
      create(input: { title: string; rawText: string }): Goal {
        const info = db
          .prepare("INSERT INTO goal (title, raw_text) VALUES (?, ?)")
          .run(input.title, input.rawText);
        const inserted = getGoal(db, Number(info.lastInsertRowid));
        if (!inserted) {
          throw new Error(
            `Goal insert succeeded (rowid ${info.lastInsertRowid}) but could not be read back`
          );
        }
        return inserted;
      },
      get(id: number): Goal | undefined {
        return getGoal(db, id);
      },
      setConvergedSpec(id: number, spec: unknown): void {
        const info = db
          .prepare(
            "UPDATE goal SET converged_spec_json = ?, status = 'converged', updated_at = datetime('now') WHERE id = ?"
          )
          .run(JSON.stringify(spec), id);
        if (info.changes === 0) {
          throw new Error(`setConvergedSpec: no goal found with id ${id}`);
        }
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
    elicitations: {
      create(goalId: number): ElicitationState {
        const info = db.prepare("INSERT INTO elicitation_state (goal_id) VALUES (?)").run(goalId);
        const inserted = getElicitation(db, Number(info.lastInsertRowid));
        if (!inserted) {
          throw new Error(
            `elicitations.create: insert succeeded (rowid ${info.lastInsertRowid}) but could not be read back`
          );
        }
        return inserted;
      },
      get(id: number): ElicitationState | undefined {
        return getElicitation(db, id);
      },
      update(id: number, patch: {
        generation: number;
        population: Genome<GoalInterpretation>[];
        beliefWeights: number[];
        pendingQuestion: ElicitationQuestion | null;
        status: "active" | "converged";
      }): void {
        const info = db.prepare(
          `UPDATE elicitation_state SET generation = ?, population_json = ?, belief_json = ?,
             pending_question_json = ?, status = ? WHERE id = ?`
        ).run(
          patch.generation,
          JSON.stringify(patch.population),
          JSON.stringify(patch.beliefWeights),
          patch.pendingQuestion ? JSON.stringify(patch.pendingQuestion) : null,
          patch.status,
          id,
        );
        if (info.changes === 0) throw new Error(`elicitations.update: no row with id ${id}`);
      },
    },
  };
}
