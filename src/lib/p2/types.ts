import { z } from "zod";

export const monthlyInitSchema = z.object({
  objective:   z.string().min(1).max(120),
  description: z.string().min(1).max(400),
});

export const weeklyInitSchema = monthlyInitSchema;

export const dailyTaskInitSchema = z.object({
  title:            z.string().min(1).max(120),
  description:      z.string().min(1).max(400),
  estimatedMinutes: z.number().int().positive().max(480),
});

const wrapItems = <T extends z.ZodTypeAny>(s: T) => z.object({ items: z.array(s) });

export const monthlyArraySchema = wrapItems(monthlyInitSchema);
export const weeklyArraySchema  = wrapItems(weeklyInitSchema);
export const dailyArraySchema   = wrapItems(dailyTaskInitSchema);

export type MonthlyInit   = z.infer<typeof monthlyInitSchema>;
export type WeeklyInit    = z.infer<typeof weeklyInitSchema>;
export type DailyTaskInit = z.infer<typeof dailyTaskInitSchema>;
