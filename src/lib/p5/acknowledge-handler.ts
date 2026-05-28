import { z } from "zod";
import type { Repositories } from "@/lib/store/repositories";

/** Input contract: a positive integer alert id. The route layer hands us `unknown`
 *  (a parsed JSON body), so validation lives here, not in the route. */
export const acknowledgeInputSchema = z.object({
  alertId: z.number().int().positive(),
});

export type AcknowledgeInput = z.infer<typeof acknowledgeInputSchema>;

export type AcknowledgeResult =
  | { ok: true }
  | { error: string; status: 400 | 404 };

export interface AcknowledgeDeps {
  repos: Repositories;
}

/** repositories.ts:195 throws `Error("alerts.acknowledge: no row with id N")` when
 *  the UPDATE matches zero rows. We translate *that exact message shape* to a 404
 *  and rethrow anything else so genuine bugs aren't silently swallowed as 404s. */
const MISSING_ROW_PREFIX = "alerts.acknowledge: no row with id ";

export function handleAcknowledge(
  input: unknown,
  deps: AcknowledgeDeps,
): AcknowledgeResult {
  const parsed = acknowledgeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; "), status: 400 };
  }

  try {
    deps.repos.alerts.acknowledge(parsed.data.alertId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith(MISSING_ROW_PREFIX)) {
      return { error: msg, status: 404 };
    }
    throw err;
  }
}
