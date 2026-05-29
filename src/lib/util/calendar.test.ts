import { describe, it, expect } from "vitest";
import { buildSkeleton } from "./calendar";

describe("buildSkeleton", () => {
  it("produces 6 rolling month-spans for '6 months' from 2026-05-28", () => {
    const skel = buildSkeleton("6 months", "2026-05-28");
    expect(skel.months).toHaveLength(6);
    expect(skel.months[0]).toEqual({
      monthIndex: 0, startDate: "2026-05-28", endDate: "2026-06-27",
    });
    expect(skel.months[5]).toEqual({
      monthIndex: 5, startDate: "2026-10-28", endDate: "2026-11-28",
    });
  });

  it("emits exactly 185 dates for '6 months' from 2026-05-28", () => {
    const skel = buildSkeleton("6 months", "2026-05-28");
    const allDates = skel.weeksByMonth.flatMap(ws => ws.flatMap(w => w.dates));
    expect(allDates).toHaveLength(185);
    expect(allDates[0]).toBe("2026-05-28");
    expect(allDates.at(-1)).toBe("2026-11-28");
  });

  it("clips weeks at month-span boundaries (no week straddles two months)", () => {
    const skel = buildSkeleton("6 months", "2026-05-28");
    for (let i = 0; i < skel.months.length; i++) {
      const monthEnd = skel.months[i].endDate;
      const monthWeeks = skel.weeksByMonth[i];
      const lastWeekOfMonth = monthWeeks.at(-1)!;
      expect(lastWeekOfMonth.endDate <= monthEnd).toBe(true);
      // first week starts on the month's startDate
      expect(monthWeeks[0].startDate).toBe(skel.months[i].startDate);
    }
  });

  it("parses 'by YYYY-MM-DD' form", () => {
    const skel = buildSkeleton("by 2026-12-15", "2026-05-28");
    expect(skel.months.at(-1)!.endDate).toBe("2026-12-15");
    expect(skel.months.length).toBeGreaterThanOrEqual(6);
  });

  it("parses 'N weeks' form with single clipped span", () => {
    const skel = buildSkeleton("3 weeks", "2026-05-28");
    expect(skel.months).toHaveLength(1);
    expect(skel.months[0].startDate).toBe("2026-05-28");
    expect(skel.months[0].endDate).toBe("2026-06-17"); // 2026-05-28 + 21 days = 06-18, minus 1 inclusive = 06-17
    expect(skel.weeksByMonth.flatMap(ws => ws.flatMap(w => w.dates))).toHaveLength(21);
  });

  it("throws on unparseable timeframe", () => {
    expect(() => buildSkeleton("forever", "2026-05-28"))
      .toThrowError(/unparseable timeframe: forever/);
  });

  it("throws on zero-length timeframe", () => {
    expect(() => buildSkeleton("0 months", "2026-05-28"))
      .toThrow();
  });

  it("addMonths clamps to month-end when the start day exceeds the target month's length", () => {
    // Indirect test via buildSkeleton starting Jan 31
    const skel = buildSkeleton("3 months", "2026-01-31");
    expect(skel.months[0].startDate).toBe("2026-01-31");
    expect(skel.months[1].startDate).toBe("2026-02-28"); // clamped, not 2026-03-03
    expect(skel.months[2].startDate).toBe("2026-03-31");
  });

  it("'by YYYY-MM-DD' accepts a same-day deadline as a degenerate one-day horizon", () => {
    const skel = buildSkeleton("by 2026-05-28", "2026-05-28");
    expect(skel.months).toHaveLength(1);
    expect(skel.months[0].startDate).toBe("2026-05-28");
    expect(skel.months[0].endDate).toBe("2026-05-28");
    expect(skel.weeksByMonth[0][0].dates).toEqual(["2026-05-28"]);
  });

  it("'8 weeks' produces 2 month-spans (8/4 = 2)", () => {
    const skel = buildSkeleton("8 weeks", "2026-05-28");
    expect(skel.months).toHaveLength(2);
    const allDates = skel.weeksByMonth.flatMap(ws => ws.flatMap(w => w.dates));
    expect(allDates).toHaveLength(56);  // 8 * 7
    expect(allDates[0]).toBe("2026-05-28");
    expect(allDates.at(-1)).toBe("2026-07-22");  // 2026-05-28 + 55 days
  });

  it("throws on zero-length weeks", () => {
    expect(() => buildSkeleton("0 weeks", "2026-05-28")).toThrow();
  });

  it("throws on a 'by YYYY-MM-DD' deadline that is already in the past", () => {
    expect(() => buildSkeleton("by 2024-01-01", "2026-05-28"))
      .toThrowError(/p2\.calendar: by-date in the past: 2024-01-01/);
  });
});
