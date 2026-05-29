import type { Repositories } from "@/lib/store/repositories";
import type { Goal, Monthly, Weekly, DailyTask, MonthlyRowInit, WeeklyRowInit, DailyTaskRowInit }
  from "@/lib/store/types";
import type { P2Operators } from "./operators";
import type * as calendarModule from "@/lib/util/calendar";
import { withRetry } from "./retry";

export interface DecomposeDeps {
  repos: Repositories;
  ops: P2Operators;
  calendar: typeof calendarModule;
  today: string;
}

export interface DecomposeResult {
  decompositionId: number;
  tree: {
    monthlies: Monthly[];
    weeklies: Weekly[][];
    dailyTasks: DailyTask[][];
  };
}

interface FlatWeek {
  weekSpan: { startDate: string; endDate: string; dates: string[] };
  parentMonthlyCtx: string;
  weeklyCtx: string;
}

function renderGoalContext(goal: Goal): string {
  const s = goal.convergedSpec as Record<string, string>;
  return `Scope: ${s.scope}
Success metric: ${s.successMetric}
Constraints: ${s.constraints}
Motivation: ${s.motivation}
Deadline shape: ${s.deadlineShape}
Timeframe: ${goal.timeframe}`;
}

function renderMonthlyContext(
  m: { objective: string; description: string },
  span: { startDate: string; endDate: string },
): string {
  return `Objective: ${m.objective}
Description: ${m.description}
Span: ${span.startDate} -> ${span.endDate}`;
}

function renderWeeklyContext(
  w: { objective: string; description: string },
  span: { startDate: string; endDate: string },
): string {
  return `Objective: ${w.objective}
Description: ${w.description}
Span: ${span.startDate} -> ${span.endDate}`;
}

export async function handleDecompose(
  input: { goalId: number },
  deps: DecomposeDeps,
): Promise<DecomposeResult> {
  const goal = deps.repos.goals.get(input.goalId);
  if (!goal || !goal.convergedSpec) {
    throw new Error(`p2: goal ${input.goalId} not converged`);
  }

  let skeleton: ReturnType<typeof deps.calendar.buildSkeleton>;
  try {
    skeleton = deps.calendar.buildSkeleton(goal.timeframe, deps.today);
  } catch (err) {
    throw new Error(`p2: ${(err as Error).message}`, { cause: err });
  }

  const goalCtx = renderGoalContext(goal);

  // Layer 1
  const monthlyInits = await withRetry(() =>
    deps.ops.decomposeGoalToMonthly(goalCtx, skeleton.months));

  // Layer 2 — sibling-parallel per month
  const weeklyInitsByMonth = await Promise.all(
    skeleton.months.map((m, i) =>
      withRetry(() => deps.ops.decomposeMonthlyToWeekly(
        goalCtx,
        renderMonthlyContext(monthlyInits[i], m),
        skeleton.weeksByMonth[i],
      )),
    ),
  );

  const flatWeeks: FlatWeek[] = [];
  for (let i = 0; i < skeleton.months.length; i++) {
    const monthlyCtxStr = renderMonthlyContext(monthlyInits[i], skeleton.months[i]);
    for (let j = 0; j < skeleton.weeksByMonth[i].length; j++) {
      const weekSpan = skeleton.weeksByMonth[i][j];
      flatWeeks.push({
        weekSpan,
        parentMonthlyCtx: monthlyCtxStr,
        weeklyCtx: renderWeeklyContext(weeklyInitsByMonth[i][j], weekSpan),
      });
    }
  }

  // Layer 3 — sibling-parallel per week
  const dailyInitsByWeek = await Promise.all(
    flatWeeks.map((w) =>
      withRetry(() => deps.ops.decomposeWeeklyToDaily(
        goalCtx, w.parentMonthlyCtx, w.weeklyCtx, w.weekSpan.dates,
      )),
    ),
  );

  // Persist
  const decompositionId = deps.repos.runInTransaction(() => {
    const newId = deps.repos.decompositions.create({ goalId: input.goalId }).id;

    const monthlyRows: MonthlyRowInit[] = monthlyInits.map((m, i) => ({
      decompositionId: newId,
      monthIndex: i,
      startDate: skeleton.months[i].startDate,
      endDate: skeleton.months[i].endDate,
      objective: m.objective,
      description: m.description,
      weight: 1 / monthlyInits.length,
      progress: 0,
    }));
    const monthlyIds = deps.repos.monthlies.bulkInsert(monthlyRows);

    const weeklyRows: WeeklyRowInit[] = [];
    for (let i = 0; i < skeleton.months.length; i++) {
      const monthlyId = monthlyIds[i];
      const weeks = skeleton.weeksByMonth[i];
      const weeklyInits = weeklyInitsByMonth[i];
      for (let j = 0; j < weeks.length; j++) {
        weeklyRows.push({
          decompositionId: newId,
          monthlyId,
          weekIndex: weeks[j].weekIndex,
          startDate: weeks[j].startDate,
          endDate: weeks[j].endDate,
          objective: weeklyInits[j].objective,
          description: weeklyInits[j].description,
          weight: 1 / weeks.length,
          progress: 0,
        });
      }
    }
    const weeklyIds = deps.repos.weeklies.bulkInsert(weeklyRows);

    const dailyRows: DailyTaskRowInit[] = [];
    for (let g = 0; g < flatWeeks.length; g++) {
      const weeklyId = weeklyIds[g];
      const dates = flatWeeks[g].weekSpan.dates;
      const inits = dailyInitsByWeek[g];
      for (let k = 0; k < dates.length; k++) {
        dailyRows.push({
          decompositionId: newId,
          weeklyId,
          date: dates[k],
          title: inits[k].title,
          description: inits[k].description,
          estimatedMinutes: inits[k].estimatedMinutes,
          status: "pending",
          concretizationLevel: "coarse",
        });
      }
    }
    deps.repos.dailyTasks.bulkInsert(dailyRows);

    deps.repos.goals.setActiveDecomposition(input.goalId, newId);

    return newId;
  });

  const monthlies = deps.repos.monthlies.listForDecomposition(decompositionId);
  const weeklies = monthlies.map((m) => deps.repos.weeklies.listForMonthly(m.id));
  const dailyTasks = weeklies.flat().map((w) => deps.repos.dailyTasks.listForWeekly(w.id));

  return {
    decompositionId,
    tree: { monthlies, weeklies, dailyTasks },
  };
}
