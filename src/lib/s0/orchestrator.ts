import type { Genome } from "@/lib/esc/core";
import { evolve } from "@/lib/esc/core";
import type { GoalInterpretation, ElicitationQuestion } from "@/lib/store/types";
import { uniformBelief, updateBelief, entropy, type Belief } from "./belief";
import { selectQuestion } from "./acquisition";

export interface ElicitationOps {
  seed(): Promise<Genome<GoalInterpretation>[]>;
  crossover(a: Genome<GoalInterpretation>, b: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>>;
  mutate(g: Genome<GoalInterpretation>): Promise<Genome<GoalInterpretation>>;
}

export interface ElicitationConfig { maxQuestions: number; entropyThreshold: number; evolveEvery: number; }

export interface OrchestratorState {
  population: Genome<GoalInterpretation>[];
  belief: Belief;
  generation: number;
  pendingQuestion: ElicitationQuestion | null;
  status: "active" | "converged";
  convergedSpec: GoalInterpretation | null;
}

function mapCandidate(state: OrchestratorState): GoalInterpretation {
  let best = 0;
  for (let k = 1; k < state.belief.weights.length; k++) {
    if (state.belief.weights[k] > state.belief.weights[best]) best = k;
  }
  return state.population[best].value;
}

function finaliseIfDone(state: OrchestratorState, cfg: ElicitationConfig): OrchestratorState {
  const done = entropy(state.belief) < cfg.entropyThreshold || state.generation >= cfg.maxQuestions;
  if (!done) {
    return { ...state, pendingQuestion: selectQuestion(state.belief, state.population), status: "active" };
  }
  return { ...state, pendingQuestion: null, status: "converged", convergedSpec: mapCandidate(state) };
}

export async function startElicitation(ops: ElicitationOps, cfg: ElicitationConfig): Promise<OrchestratorState> {
  const population = await ops.seed();
  const belief = uniformBelief(population.length);
  const base: OrchestratorState = { population, belief, generation: 0, pendingQuestion: null, status: "active", convergedSpec: null };
  return finaliseIfDone(base, cfg);
}

export async function answerQuestion(
  ops: ElicitationOps,
  state: OrchestratorState,
  answer: "a" | "b",
  cfg: ElicitationConfig,
): Promise<OrchestratorState> {
  if (!state.pendingQuestion) return state;
  const belief = updateBelief(state.belief, state.population, state.pendingQuestion, answer);
  let next: OrchestratorState = { ...state, belief, generation: state.generation + 1 };

  if (next.generation % cfg.evolveEvery === 0) {
    const parents = next.population;
    const parentWeights = next.belief.weights;
    const n = parents.length;
    const evolved = await evolve({ crossover: ops.crossover, mutate: ops.mutate }, parents);
    // evolve returns [...parents, ...offspring]; offspring m came from parents[m] and parents[(m+1)%n].
    // Parents keep their earned weight; offspring inherit the mean of their two parents' weights.
    const inherited = evolved.map((_, idx) => {
      if (idx < n) return parentWeights[idx];
      const m = idx - n;
      return (parentWeights[m] + parentWeights[(m + 1) % n]) / 2;
    });
    // Bound the population: keep the top-n by weight, then renormalise.
    const ranked = inherited
      .map((w, idx) => ({ w, idx }))
      .sort((x, y) => y.w - x.w)
      .slice(0, n);
    const sum = ranked.reduce((s, r) => s + r.w, 0);
    next = {
      ...next,
      population: ranked.map((r) => evolved[r.idx]),
      belief: { weights: ranked.map((r) => r.w / sum) },
    };
  }
  return finaliseIfDone(next, cfg);
}
