export interface Goal {
  id: number;
  title: string;
  rawText: string;
  convergedSpec: unknown | null;
  status: "eliciting" | "converged";
  activeDecompositionId: number | null;
  timeframe: string;
}

export interface Decomposition {
  id: number;
  goalId: number;
  createdAt: string;
}

export interface Monthly {
  id: number;
  decompositionId: number;
  monthIndex: number;
  startDate: string;
  endDate: string;
  objective: string;
  description: string;
  weight: number;
  progress: number;
}

export interface Weekly {
  id: number;
  decompositionId: number;
  monthlyId: number;
  weekIndex: number;
  startDate: string;
  endDate: string;
  objective: string;
  description: string;
  weight: number;
  progress: number;
}

export interface DailyTask {
  id: number;
  decompositionId: number;
  weeklyId: number;
  date: string;
  title: string;
  description: string;
  estimatedMinutes: number;
  status: "pending" | "done" | "skipped";
  concretizationLevel: "coarse" | "concrete";
}

export type MonthlyRowInit   = Omit<Monthly,  "id">;
export type WeeklyRowInit    = Omit<Weekly,   "id">;
export type DailyTaskRowInit = Omit<DailyTask, "id">;
export type DecompositionInit = Pick<Decomposition, "goalId">;

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
  vectors: Record<string, number[]>;
}
