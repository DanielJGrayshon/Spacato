import { describe, it, expect, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { makeOperators } from "./operators";
import type { MonthSpan, WeekSpan } from "@/lib/util/calendar";
import type { Gateway } from "@/lib/llm/gateway";

interface StubGateway extends Omit<Gateway, "complete"> {
  complete: MockedFunction<Gateway["complete"]>;
}

function makeStubGateway(canned: any): StubGateway {
  return {
    complete: vi.fn().mockResolvedValue(canned),
    embed: vi.fn(),
    embedBatch: vi.fn(),
    batchComplete: vi.fn(),
  } as unknown as StubGateway;
}

const months: MonthSpan[] = Array.from({ length: 6 }, (_, i) => ({
  monthIndex: i, startDate: `2026-0${5 + i}-01`, endDate: `2026-0${5 + i}-30`,
}));
const weeks: WeekSpan[] = Array.from({ length: 4 }, (_, i) => ({
  weekIndex: i,
  startDate: `2026-05-${String(1 + i * 7).padStart(2, "0")}`,
  endDate: `2026-05-${String(7 + i * 7).padStart(2, "0")}`,
  dates: Array.from({ length: 7 }, (_, d) =>
    `2026-05-${String(1 + i * 7 + d).padStart(2, "0")}`),
}));

describe("decomposeGoalToMonthly", () => {
  it("calls gw.complete once with bypassCache=true and returns the items array", async () => {
    const canned = { items: months.map((_, i) => ({ objective: `m${i}`, description: "x" })) };
    const gw = makeStubGateway(canned);
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    const result = await ops.decomposeGoalToMonthly("goal-ctx", months);
    expect(gw.complete).toHaveBeenCalledOnce();
    expect(gw.complete.mock.calls[0][0].bypassCache).toBe(true);
    expect(result).toHaveLength(6);
    expect(result[0].objective).toBe("m0");
  });

  it("throws a p2: length error on wrong-length response (transient to withRetry)", async () => {
    const gw = makeStubGateway({ items: [{ objective: "m0", description: "x" }] });
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    await expect(ops.decomposeGoalToMonthly("goal-ctx", months))
      .rejects.toThrowError(/p2: decomposeGoalToMonthly returned 1 items, expected 6/);
  });

  it("includes an explicit JSON-object example in the user prompt", async () => {
    const canned = { items: months.map((_, i) => ({ objective: `m${i}`, description: "x" })) };
    const gw = makeStubGateway(canned);
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    await ops.decomposeGoalToMonthly("goal-ctx", months);
    const userMsg = gw.complete.mock.calls[0][0].messages.find((m: any) => m.role === "user")!.content;
    expect(userMsg).toContain('{"items":');
  });
});

describe("zero-length short-circuit", () => {
  it("returns [] immediately for zero-length input without calling gw.complete", async () => {
    const gw = makeStubGateway({ items: [] });
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    expect(await ops.decomposeGoalToMonthly("ctx", [])).toEqual([]);
    expect(await ops.decomposeMonthlyToWeekly("g", "m", [])).toEqual([]);
    expect(await ops.decomposeWeeklyToDaily("g", "m", "w", [])).toEqual([]);
    expect(gw.complete).not.toHaveBeenCalled();
  });
});

describe("decomposeMonthlyToWeekly", () => {
  it("passes the monthly context into the prompt and returns weeks", async () => {
    const canned = { items: weeks.map((_, i) => ({ objective: `w${i}`, description: "x" })) };
    const gw = makeStubGateway(canned);
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    const result = await ops.decomposeMonthlyToWeekly("goal-ctx", "monthly-ctx", weeks);
    expect(result).toHaveLength(4);
    const userMsg = gw.complete.mock.calls[0][0].messages.find((m: any) => m.role === "user")!.content;
    expect(userMsg).toContain("monthly-ctx");
  });
});

describe("decomposeWeeklyToDaily", () => {
  const dates = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07"];

  it("returns exactly dates.length daily-task inits with estimatedMinutes", async () => {
    const canned = { items: dates.map(() => ({
      title: "t", description: "d", estimatedMinutes: 45,
    })) };
    const gw = makeStubGateway(canned);
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    const result = await ops.decomposeWeeklyToDaily("goal-ctx", "monthly-ctx", "weekly-ctx", dates);
    expect(result).toHaveLength(7);
    expect(result[0].estimatedMinutes).toBe(45);
  });

  it("system prompt forbids brands, vendor URLs, and tutorial links (coarse framing)", async () => {
    const canned = { items: dates.map(() => ({ title: "t", description: "d", estimatedMinutes: 45 })) };
    const gw = makeStubGateway(canned);
    const ops = makeOperators(gw as unknown as Gateway, "openai/gpt-4o-mini");
    await ops.decomposeWeeklyToDaily("goal-ctx", "monthly-ctx", "weekly-ctx", dates);
    const sysMsg = gw.complete.mock.calls[0][0].messages.find((m: any) => m.role === "system")!.content;
    expect(sysMsg).toMatch(/brand-specific/i);
    expect(sysMsg).toMatch(/vendor URL/i);
    expect(sysMsg).toMatch(/tutorial link/i);
    expect(sysMsg).toMatch(/concretization/i);
  });
});
