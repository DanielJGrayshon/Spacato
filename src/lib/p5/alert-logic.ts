import { z } from "zod";
import type { LlmRequest } from "@/lib/llm/gateway";
import type { Repositories } from "@/lib/store/repositories";
import type { StoredSignal, Alert } from "@/lib/p5/types";
import type { GoalInterpretation } from "@/lib/store/types";

export const ALERT_THRESHOLD = 0.75;

type Gateway = { batchComplete<T>(reqs: LlmRequest<T>[]): Promise<T[]> };

const justifySchema = z.object({ justification: z.string().max(160) });
type JustificationResult = z.infer<typeof justifySchema>;

/** True if an OPEN alert for this goal already references a signal with the
 *  same source + payload.id (recurring item across cycles). Spec §8.2.
 *  Loads only the signals referenced by open alerts (bounded by open-alert count),
 *  not the goal's entire signal history. */
function duplicateContentInOpenAlerts(repos: Repositories, signal: StoredSignal): boolean {
  const open = repos.alerts.listOpen(signal.goalId);
  if (open.length === 0) return false;
  const openSignals = repos.signals.listByIds(open.map((a) => a.signalId));
  return openSignals.some((s) => s.payload.id === signal.payload.id && s.source === signal.source);
}

export async function raiseAlerts(
  signals: StoredSignal[],
  spec: GoalInterpretation,
  repos: Repositories,
  gw: Gateway,
  model: string
): Promise<Alert[]> {
  // Two dedup gates: existsOpen guards re-processing the SAME signal row within a process
  // (e.g. a retried call); duplicateContentInOpenAlerts is the cross-cycle guard, since each
  // cycle mints a fresh signal row id for recurring content (same payload.id + source).
  const qualifying = signals.filter(
    (s) =>
      (s.relevanceScore ?? 0) >= ALERT_THRESHOLD &&
      !repos.alerts.existsOpen(s.goalId, s.id) &&
      !duplicateContentInOpenAlerts(repos, s)
  );
  if (qualifying.length === 0) return [];

  const sys = { role: "system" as const, content: "You write one-sentence impact summaries for goal planners. Reply only with JSON." };
  const reqs: LlmRequest<JustificationResult>[] = qualifying.map((s) => ({
    model,
    messages: [
      sys,
      { role: "user" as const, content: `Goal spec: ${JSON.stringify(spec)}\nSignal: ${s.payload.title} — ${s.payload.summary}\nIn one sentence (<= 20 words), explain why this directly affects the goal.` },
    ],
    schema: justifySchema,
  }));
  const justifications = await gw.batchComplete(reqs);

  return qualifying.map((s, i) =>
    repos.alerts.create({ signalId: s.id, goalId: s.goalId, impactScore: s.relevanceScore!, message: justifications[i].justification })
  );
}
