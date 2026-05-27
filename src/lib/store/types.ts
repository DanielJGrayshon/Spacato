export interface Goal {
  id: number;
  title: string;
  rawText: string;
  convergedSpec: unknown | null;
  status: "eliciting" | "converged";
}

import type { Genome } from "@/lib/esc/core";

export interface GoalInterpretation {
  scope: string;
  successMetric: string;
  constraints: string;
  motivation: string;
  deadlineShape: string;
}

export interface ElicitationQuestion { a: number; b: number; }

export interface ElicitationState {
  id: number;
  goalId: number;
  generation: number;
  population: Genome<GoalInterpretation>[];
  beliefWeights: number[];
  pendingQuestion: ElicitationQuestion | null;
  status: "active" | "converged";
}
