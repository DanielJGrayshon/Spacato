import type { Gateway } from "@/lib/llm/gateway";
import type { MonthSpan, WeekSpan } from "@/lib/util/calendar";
import {
  monthlyArraySchema,
  weeklyArraySchema,
  dailyArraySchema,
  type MonthlyInit,
  type WeeklyInit,
  type DailyTaskInit,
} from "./types";

export interface P2Operators {
  decomposeGoalToMonthly(goalCtx: string, months: MonthSpan[]): Promise<MonthlyInit[]>;
  decomposeMonthlyToWeekly(goalCtx: string, monthlyCtx: string, weeks: WeekSpan[]): Promise<WeeklyInit[]>;
  decomposeWeeklyToDaily(
    goalCtx: string, monthlyCtx: string, weeklyCtx: string, dates: string[],
  ): Promise<DailyTaskInit[]>;
}

function assertLength<T>(items: T[], expected: number, label: string): T[] {
  if (items.length !== expected) {
    throw new Error(`p2: ${label} returned ${items.length} items, expected ${expected}`);
  }
  return items;
}

const SYSTEM_MONTHLY = `You are a decomposition planner. Given a converged goal and N month spans, produce exactly N monthly objectives (one per span, in chronological order). Output a JSON object with shape {"items":[{"objective":"...","description":"..."}, ...]}. "objective" MUST be a short title (<=120 chars); "description" MUST be 1-3 sentences explaining what success looks like at the end of this month. Do NOT include weights, dates, brand names, or vendor URLs - those are computed deterministically or added by a later concretization step.`;

const SYSTEM_WEEKLY = `You are a decomposition planner. Given a converged goal, a parent monthly objective, and N week spans, produce exactly N weekly objectives (one per span, in chronological order). Output a JSON object with shape {"items":[{"objective":"...","description":"..."}, ...]}. "objective" MUST be a short title (<=120 chars); "description" MUST be 1-3 sentences. Do NOT include weights, dates, brand names, or vendor URLs.`;

const SYSTEM_DAILY = `You are a decomposition planner. Given a converged goal, a parent monthly objective, a parent weekly objective, and N dates, produce exactly N daily tasks (one per date, in chronological order). Output a JSON object with shape {"items":[{"title":"...","description":"...","estimatedMinutes":30}, ...]}. Each daily task is going to be planned around by a calendar packer (P4). Be specific enough to schedule and prepare for - name the activity, the rough form, and the resources someone would already have - but DO NOT include brand-specific recommendations, vendor URLs, tutorial links, or store-specific instructions. Those are added by a later concretization step. Title <=120 chars; description 1-3 sentences; estimatedMinutes is a realistic single-session duration (typically 15-120, never more than 480).`;

function renderMonthlyPrompt(goalCtx: string, months: MonthSpan[]): string {
  const spanLines = months.map((m, i) =>
    `${i + 1}. ${m.startDate} -> ${m.endDate} (month ${i + 1} of ${months.length})`,
  ).join("\n");
  return `GOAL CONTEXT
============
${goalCtx}

MONTH SPANS (produce exactly ${months.length} items, in this order)
====================================================
${spanLines}

EXAMPLE OUTPUT (shape only; content fictional)
{"items":[{"objective":"Build aerobic base","description":"Establish a consistent 4-day-per-week running rhythm with the longest session reaching 90 minutes. Avoid injury via gradual mileage increases."}]}`;
}

function renderWeeklyPrompt(goalCtx: string, monthlyCtx: string, weeks: WeekSpan[]): string {
  const spanLines = weeks.map((w, i) =>
    `${i + 1}. ${w.startDate} -> ${w.endDate} (week ${i + 1} of ${weeks.length})`,
  ).join("\n");
  return `GOAL CONTEXT
============
${goalCtx}

PARENT MONTHLY
==============
${monthlyCtx}

WEEK SPANS (produce exactly ${weeks.length} items, in this order)
====================================================
${spanLines}

EXAMPLE OUTPUT (shape only; content fictional)
{"items":[{"objective":"Base mileage","description":"Three 30-minute easy runs at conversational pace plus one rest day. Focus on consistent rhythm, not pace."}]}`;
}

function renderDailyPrompt(
  goalCtx: string, monthlyCtx: string, weeklyCtx: string, dates: string[],
): string {
  const dateLines = dates.map((d, i) => `${i + 1}. ${d}`).join("\n");
  return `GOAL CONTEXT
============
${goalCtx}

PARENT MONTHLY
==============
${monthlyCtx}

PARENT WEEKLY
=============
${weeklyCtx}

DATES (produce exactly ${dates.length} items, in this order)
====================================================
${dateLines}

EXAMPLE OUTPUT (shape only; content fictional)
{"items":[{"title":"Easy 5k","description":"Conversational pace.","estimatedMinutes":30}]}`;
}

export function makeOperators(gw: Gateway, model: string): P2Operators {
  return {
    async decomposeGoalToMonthly(goalCtx, months) {
      if (months.length === 0) return [];
      const { items } = await gw.complete({
        model,
        bypassCache: true,
        schema: monthlyArraySchema,
        messages: [
          { role: "system", content: SYSTEM_MONTHLY },
          { role: "user",   content: renderMonthlyPrompt(goalCtx, months) },
        ],
      });
      return assertLength(items, months.length, "decomposeGoalToMonthly");
    },

    async decomposeMonthlyToWeekly(goalCtx, monthlyCtx, weeks) {
      if (weeks.length === 0) return [];
      const { items } = await gw.complete({
        model,
        bypassCache: true,
        schema: weeklyArraySchema,
        messages: [
          { role: "system", content: SYSTEM_WEEKLY },
          { role: "user",   content: renderWeeklyPrompt(goalCtx, monthlyCtx, weeks) },
        ],
      });
      return assertLength(items, weeks.length, "decomposeMonthlyToWeekly");
    },

    async decomposeWeeklyToDaily(goalCtx, monthlyCtx, weeklyCtx, dates) {
      if (dates.length === 0) return [];
      const { items } = await gw.complete({
        model,
        bypassCache: true,
        schema: dailyArraySchema,
        messages: [
          { role: "system", content: SYSTEM_DAILY },
          { role: "user",   content: renderDailyPrompt(goalCtx, monthlyCtx, weeklyCtx, dates) },
        ],
      });
      return assertLength(items, dates.length, "decomposeWeeklyToDaily");
    },
  };
}
