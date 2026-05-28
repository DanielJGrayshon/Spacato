import { makeRepositories } from "@/lib/store/repositories";
import { startElicitation, answerQuestion, type ElicitationOps, type OrchestratorState } from "@/lib/s0/orchestrator";
import type { ElicitationQuestion, ElicitationState } from "@/lib/store/types";

export const CFG = { maxQuestions: 8, entropyThreshold: 0.5, evolveEvery: 3 };

export type ElicitInput =
  | { action: "start"; goalId: number; rawGoal: string }
  | { action: "answer"; elicitationId: number; answer: "a" | "b" };

export interface ElicitResult {
  elicitationId: number;
  question: ElicitationQuestion | null;
  converged: boolean;
}

export interface ElicitDeps {
  repos: ReturnType<typeof makeRepositories>;
  ops: ElicitationOps;
  embed: (text: string) => Promise<number[]>;
}

function toState(row: ElicitationState): OrchestratorState {
  return {
    population: row.population,
    belief: { weights: row.beliefWeights },
    generation: row.generation,
    pendingQuestion: row.pendingQuestion,
    status: row.status,
    convergedSpec: null,
    vectors: row.vectors,
  };
}

function persist(deps: ElicitDeps, id: number, s: OrchestratorState): void {
  deps.repos.elicitations.update(id, {
    generation: s.generation,
    population: s.population,
    beliefWeights: s.belief.weights,
    pendingQuestion: s.pendingQuestion,
    status: s.status,
    vectors: s.vectors,
  });
}

export async function handleElicit(input: ElicitInput, deps: ElicitDeps): Promise<ElicitResult> {
  if (input.action === "start") {
    const e = deps.repos.elicitations.create(input.goalId);
    const state = await startElicitation(deps.ops, CFG, deps.embed);
    persist(deps, e.id, state);
    return { elicitationId: e.id, question: state.pendingQuestion, converged: state.status === "converged" };
  }

  const row = deps.repos.elicitations.get(input.elicitationId);
  if (!row) throw new Error(`elicit: no elicitation ${input.elicitationId}`);
  const next = await answerQuestion(deps.ops, toState(row), input.answer, CFG, deps.embed);
  persist(deps, input.elicitationId, next);
  if (next.status === "converged" && next.convergedSpec) {
    deps.repos.goals.setConvergedSpec(row.goalId, next.convergedSpec);
  }
  return { elicitationId: input.elicitationId, question: next.pendingQuestion, converged: next.status === "converged" };
}
