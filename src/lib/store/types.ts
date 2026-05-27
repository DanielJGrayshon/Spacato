export interface Goal {
  id: number;
  title: string;
  rawText: string;
  convergedSpec: unknown | null;
  status: "eliciting" | "converged";
}
