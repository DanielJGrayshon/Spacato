import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "./db";
import { makeRepositories } from "./repositories";
import type Database from "better-sqlite3";

let db: Database.Database;
let repos: ReturnType<typeof makeRepositories>;

beforeEach(() => {
  db = openDb(":memory:");
  repos = makeRepositories(db);
});

describe("decompositions repo", () => {
  it("create + getById round-trips", () => {
    const goalId = repos.goals.create({ title: "marathon", rawText: "Run a marathon" }).id;
    const dec = repos.decompositions.create({ goalId });
    expect(dec.id).toBeGreaterThan(0);
    const fetched = repos.decompositions.getById(dec.id);
    expect(fetched?.goalId).toBe(goalId);
  });

  it("listForGoal returns rows in creation order", () => {
    const goalId = repos.goals.create({ title: "g", rawText: "g" }).id;
    const d1 = repos.decompositions.create({ goalId });
    const d2 = repos.decompositions.create({ goalId });
    const rows = repos.decompositions.listForGoal(goalId);
    expect(rows.map((r) => r.id)).toEqual([d1.id, d2.id]);
  });
});

describe("monthlies / weeklies / dailyTasks bulkInsert", () => {
  function setup() {
    const goalId = repos.goals.create({ title: "g", rawText: "g" }).id;
    const decompositionId = repos.decompositions.create({ goalId }).id;
    return { goalId, decompositionId };
  }

  it("monthlies.bulkInsert is atomic and returns ids in order", () => {
    const { decompositionId } = setup();
    const ids = repos.monthlies.bulkInsert([
      { decompositionId, monthIndex: 0, startDate: "2026-05-28", endDate: "2026-06-27",
        objective: "Build base", description: "...", weight: 1 / 6, progress: 0 },
      { decompositionId, monthIndex: 1, startDate: "2026-06-28", endDate: "2026-07-27",
        objective: "Add intensity", description: "...", weight: 1 / 6, progress: 0 },
    ]);
    expect(ids).toHaveLength(2);
    const rows = repos.monthlies.listForDecomposition(decompositionId);
    expect(rows.map((r) => r.monthIndex)).toEqual([0, 1]);
  });

  it("dailyTasks.listInDateRange filters by decomposition and inclusive date range", () => {
    const { decompositionId } = setup();
    const [monthlyId] = repos.monthlies.bulkInsert([
      { decompositionId, monthIndex: 0, startDate: "2026-05-28", endDate: "2026-06-27",
        objective: "x", description: "", weight: 1, progress: 0 },
    ]);
    const [weeklyId] = repos.weeklies.bulkInsert([
      { decompositionId, monthlyId, weekIndex: 0,
        startDate: "2026-05-28", endDate: "2026-06-03",
        objective: "y", description: "", weight: 1, progress: 0 },
    ]);
    repos.dailyTasks.bulkInsert([
      { decompositionId, weeklyId, date: "2026-05-28", title: "a", description: "",
        estimatedMinutes: 30, status: "pending", concretizationLevel: "coarse" },
      { decompositionId, weeklyId, date: "2026-05-30", title: "b", description: "",
        estimatedMinutes: 45, status: "pending", concretizationLevel: "coarse" },
      { decompositionId, weeklyId, date: "2026-06-03", title: "c", description: "",
        estimatedMinutes: 60, status: "pending", concretizationLevel: "coarse" },
    ]);
    const inRange = repos.dailyTasks.listInDateRange(decompositionId, "2026-05-29", "2026-06-02");
    expect(inRange.map((d) => d.date)).toEqual(["2026-05-30"]);
  });
});

describe("goals.setActiveDecomposition", () => {
  it("updates the goal's activeDecompositionId", () => {
    const g = repos.goals.create({ title: "g", rawText: "g" });
    const d = repos.decompositions.create({ goalId: g.id });
    expect(repos.goals.get(g.id)?.activeDecompositionId).toBeNull();
    repos.goals.setActiveDecomposition(g.id, d.id);
    expect(repos.goals.get(g.id)?.activeDecompositionId).toBe(d.id);
  });
});

describe("schema init is idempotent", () => {
  it("opening a DB twice does not error on the defensive ALTER", () => {
    const db1 = openDb(":memory:");
    const db2 = openDb(":memory:");
    expect(() => makeRepositories(db1)).not.toThrow();
    expect(() => makeRepositories(db2)).not.toThrow();
  });
});
