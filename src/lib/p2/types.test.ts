import { describe, it, expect } from "vitest";
import {
  monthlyInitSchema,
  weeklyInitSchema,
  dailyTaskInitSchema,
  monthlyArraySchema,
  weeklyArraySchema,
  dailyArraySchema,
} from "./types";

describe("monthlyInitSchema", () => {
  it("accepts a minimal valid shape", () => {
    expect(() => monthlyInitSchema.parse({
      objective: "Build aerobic base",
      description: "Establish 4 sessions per week.",
    })).not.toThrow();
  });
  it("rejects empty objective", () => {
    expect(() => monthlyInitSchema.parse({ objective: "", description: "x" })).toThrow();
  });
  it("rejects 121-char objective", () => {
    expect(() => monthlyInitSchema.parse({ objective: "x".repeat(121), description: "x" })).toThrow();
  });
});

describe("dailyTaskInitSchema", () => {
  it("accepts a minimal valid shape", () => {
    expect(() => dailyTaskInitSchema.parse({
      title: "Long run, 16 miles",
      description: "Steady pace, with hydration plan.",
      estimatedMinutes: 120,
    })).not.toThrow();
  });
  it("rejects zero estimatedMinutes", () => {
    expect(() => dailyTaskInitSchema.parse({
      title: "x", description: "x", estimatedMinutes: 0,
    })).toThrow();
  });
  it("rejects estimatedMinutes > 480", () => {
    expect(() => dailyTaskInitSchema.parse({
      title: "x", description: "x", estimatedMinutes: 481,
    })).toThrow();
  });
});

describe("array wrappers", () => {
  it("monthlyArraySchema rejects a bare top-level array (the §9 risk 1 lesson)", () => {
    expect(() => monthlyArraySchema.parse([
      { objective: "x", description: "x" },
    ])).toThrow();
  });
  it("monthlyArraySchema accepts { items: [...] }", () => {
    expect(() => monthlyArraySchema.parse({
      items: [{ objective: "x", description: "x" }],
    })).not.toThrow();
  });
});
