import type { Db } from "./db";
import type { Goal, ElicitationState, ElicitationQuestion, GoalInterpretation } from "./types";
import type { Genome } from "@/lib/esc/core";
import type { EscState } from "@/lib/esc/core";
import type { QueryGenome, StoredSignal, Alert, FeedItemPayload, FeedKind } from "@/lib/p5/types";

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

function rowToSignal(row: any): StoredSignal {
  return {
    id: row.id,
    goalId: row.goal_id,
    genomeId: row.genome_id,
    source: row.source,
    kind: row.kind as FeedKind,
    payload: JSON.parse(row.payload_json) as FeedItemPayload,
    relevanceScore: row.relevance_score,
    fetchedAt: row.fetched_at,
  };
}

function rowToAlert(row: any): Alert {
  return {
    id: row.id,
    signalId: row.signal_id,
    goalId: row.goal_id,
    impactScore: row.impact_score,
    message: row.message,
    createdAt: row.created_at,
    acknowledged: row.acknowledged === 1,
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
    signals: {
      create(input: {
        goalId: number;
        genomeId: string;
        source: string;
        kind: FeedKind;
        payload: FeedItemPayload;
        relevanceScore: number | null;
      }): StoredSignal {
        const info = db
          .prepare(
            "INSERT INTO external_signal (goal_id, genome_id, source, kind, payload_json, relevance_score) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(
            input.goalId,
            input.genomeId,
            input.source,
            input.kind,
            JSON.stringify(input.payload),
            input.relevanceScore
          );
        const row = db.prepare("SELECT * FROM external_signal WHERE id = ?").get(Number(info.lastInsertRowid));
        if (!row) throw new Error(`signals.create: insert ${info.lastInsertRowid} could not be read back`);
        return rowToSignal(row);
      },
      listForGoal(goalId: number, limit?: number): StoredSignal[] {
        const rows =
          limit != null
            ? db.prepare("SELECT * FROM external_signal WHERE goal_id = ? ORDER BY id DESC LIMIT ?").all(goalId, limit)
            : db.prepare("SELECT * FROM external_signal WHERE goal_id = ? ORDER BY id DESC").all(goalId);
        return (rows as any[]).map(rowToSignal);
      },
      updateRelevance(id: number, relevanceScore: number): void {
        const info = db.prepare("UPDATE external_signal SET relevance_score = ? WHERE id = ?").run(relevanceScore, id);
        if (info.changes === 0) throw new Error(`signals.updateRelevance: no row with id ${id}`);
      },
    },
    alerts: {
      create(input: { signalId: number; goalId: number; impactScore: number; message: string }): Alert {
        const info = db
          .prepare("INSERT INTO alert (signal_id, goal_id, impact_score, message) VALUES (?, ?, ?, ?)")
          .run(input.signalId, input.goalId, input.impactScore, input.message);
        const row = db.prepare("SELECT * FROM alert WHERE id = ?").get(Number(info.lastInsertRowid));
        if (!row) throw new Error(`alerts.create: insert ${info.lastInsertRowid} could not be read back`);
        return rowToAlert(row);
      },
      listOpen(goalId: number): Alert[] {
        const rows = db.prepare("SELECT * FROM alert WHERE goal_id = ? AND acknowledged = 0 ORDER BY id DESC").all(goalId);
        return (rows as any[]).map(rowToAlert);
      },
      acknowledge(id: number): void {
        const info = db.prepare("UPDATE alert SET acknowledged = 1 WHERE id = ?").run(id);
        if (info.changes === 0) throw new Error(`alerts.acknowledge: no row with id ${id}`);
      },
      existsOpen(goalId: number, signalId: number): boolean {
        const row = db
          .prepare("SELECT 1 FROM alert WHERE goal_id = ? AND signal_id = ? AND acknowledged = 0 LIMIT 1")
          .get(goalId, signalId);
        return row !== undefined;
      },
      engagementCounts(genomeId: string): { acked: number; total: number } {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN a.acknowledged = 1 THEN 1 ELSE 0 END), 0) AS acked
               FROM alert a JOIN external_signal s ON a.signal_id = s.id
              WHERE s.genome_id = ?`
          )
          .get(genomeId) as any;
        return { acked: Number(row.acked ?? 0), total: Number(row.total ?? 0) };
      },
    },
    queryGenomeState: {
      get(goalId: number): EscState<QueryGenome> | null {
        const row = db.prepare("SELECT state_json FROM query_genome_state WHERE goal_id = ?").get(goalId) as any;
        return row ? (JSON.parse(row.state_json) as EscState<QueryGenome>) : null;
      },
      save(goalId: number, state: EscState<QueryGenome>): void {
        db.prepare(
          `INSERT INTO query_genome_state (goal_id, state_json, updated_at)
             VALUES (?, ?, datetime('now'))
           ON CONFLICT(goal_id) DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')`
        ).run(goalId, JSON.stringify(state));
      },
    },
  };
}

export type Repositories = ReturnType<typeof makeRepositories>;
