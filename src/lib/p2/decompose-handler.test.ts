import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleDecompose } from "./decompose-handler";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";
import type Database from "better-sqlite3";
import * as calendar from "@/lib/util/calendar";

let db: Database.Database;
let repos: ReturnType<typeof makeRepositories>;

beforeEach(() => {
  db = openDb(":memory:");
  repos = makeRepositories(db);
});

function makeGoal(spec: any, timeframe = "6 months") {
  const goal = repos.goals.create({
    title: "run a marathon",
    rawText: "run a marathon",
    timeframe,
  });
  if (spec !== null) {
    repos.goals.setConvergedSpec(goal.id, spec);
  }
  return repos.goals.get(goal.id)!;
}

function makeStubOps(opts: { failLayer3At?: number } = {}) {
  let dailyCount = 0;
  return {
    decomposeGoalToMonthly: vi.fn(async (_ctx: string, months: any[]) => {
      return months.map((_: any, i: number) => ({
        objective: `m${i}`, description: `monthly ${i}`,
      }));
    }),
    decomposeMonthlyToWeekly: vi.fn(async (_g: string, _m: string, weeks: any[]) => {
      return weeks.map((_: any, i: number) => ({
        objective: `w${i}`, description: `weekly ${i}`,
      }));
    }),
    decomposeWeeklyToDaily: vi.fn(async (_g: string, _m: string, _w: string, dates: string[]) => {
      dailyCount++;
      if (opts.failLayer3At !== undefined && dailyCount === opts.failLayer3At) {
        throw new Error("p2: retry exhausted after 3 attempts: simulated");
      }
      return dates.map(() => ({
        title: "t", description: "d", estimatedMinutes: 45,
      }));
    }),
  };
}

describe("handleDecompose", () => {
  it("persists 6 monthlies, ~28 weeklies, 185 daily tasks for 6-month marathon", async () => {
    const goal = makeGoal({
      scope: "marathon training",
      successMetric: "finish the race",
      constraints: "no injuries",
      motivation: "endurance",
      deadlineShape: "6 months",
    });
    const ops = makeStubOps();
    const result = await handleDecompose(
      { goalId: goal.id },
      { repos, ops, calendar, today: "2026-05-28" },
    );

    expect(result.decompositionId).toBeGreaterThan(0);
    const monthlies = repos.monthlies.listForDecomposition(result.decompositionId);
    expect(monthlies).toHaveLength(6);

    const allWeeklies = monthlies.flatMap((m) => repos.weeklies.listForMonthly(m.id));
    expect(allWeeklies.length).toBeGreaterThanOrEqual(26);
    expect(allWeeklies.length).toBeLessThanOrEqual(30);

    const dailyCount = allWeeklies.reduce(
      (n, w) => n + repos.dailyTasks.listForWeekly(w.id).length, 0,
    );
    expect(dailyCount).toBe(185);

    const goalAfter = repos.goals.get(goal.id);
    expect(goalAfter?.activeDecompositionId).toBe(result.decompositionId);
  });

  it("calls the three operators sibling-parallel: 1 monthly + 6 weekly + ~28 daily", async () => {
    const goal = makeGoal({
      scope: "x", successMetric: "x", constraints: "x", motivation: "x", deadlineShape: "x",
    });
    const ops = makeStubOps();
    await handleDecompose(
      { goalId: goal.id },
      { repos, ops, calendar, today: "2026-05-28" },
    );
    expect(ops.decomposeGoalToMonthly).toHaveBeenCalledOnce();
    expect(ops.decomposeMonthlyToWeekly).toHaveBeenCalledTimes(6);
    const dailyCalls = ops.decomposeWeeklyToDaily.mock.calls.length;
    expect(dailyCalls).toBeGreaterThanOrEqual(26);
    expect(dailyCalls).toBeLessThanOrEqual(30);
  });

  it("rolls back the whole transaction when one layer-3 call fails", async () => {
    const goal = makeGoal({
      scope: "x", successMetric: "x", constraints: "x", motivation: "x", deadlineShape: "x",
    });
    const ops = makeStubOps({ failLayer3At: 5 });
    await expect(handleDecompose(
      { goalId: goal.id },
      { repos, ops, calendar, today: "2026-05-28" },
    )).rejects.toThrow();

    expect(repos.decompositions.listForGoal(goal.id)).toHaveLength(0);
    expect(repos.goals.get(goal.id)?.activeDecompositionId).toBeNull();
  });

  it("throws when the goal has no convergedSpec", async () => {
    const goal = makeGoal(null);
    const ops = makeStubOps();
    await expect(handleDecompose(
      { goalId: goal.id },
      { repos, ops, calendar, today: "2026-05-28" },
    )).rejects.toThrowError(/not converged/);
  });

  it("two consecutive successful runs leave activeDecompositionId on the second", async () => {
    const goal = makeGoal({
      scope: "x", successMetric: "x", constraints: "x", motivation: "x", deadlineShape: "x",
    });
    const ops = makeStubOps();

    const r1 = await handleDecompose(
      { goalId: goal.id }, { repos, ops, calendar, today: "2026-05-28" });
    const r2 = await handleDecompose(
      { goalId: goal.id }, { repos, ops, calendar, today: "2026-05-28" });

    expect(r2.decompositionId).toBeGreaterThan(r1.decompositionId);
    expect(repos.goals.get(goal.id)?.activeDecompositionId).toBe(r2.decompositionId);
    expect(repos.decompositions.listForGoal(goal.id)).toHaveLength(2);
  });
});
