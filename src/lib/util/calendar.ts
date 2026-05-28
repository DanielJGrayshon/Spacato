export interface MonthSpan {
  monthIndex: number;
  startDate: string;   // ISO yyyy-mm-dd, inclusive
  endDate: string;     // ISO yyyy-mm-dd, inclusive
}

export interface WeekSpan {
  weekIndex: number;  // per-month-local: restarts at 0 for each month
  startDate: string;
  endDate: string;
  dates: string[];    // ISO yyyy-mm-dd, every day in the week (inclusive)
}

export interface CalendarSkeleton {
  months: MonthSpan[];
  weeksByMonth: WeekSpan[][];
  // daysByWeek removed — derive via skel.weeksByMonth.flatMap(ws => ws.flatMap(w => w.dates))
}

const MS_PER_DAY = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  const targetMonth = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  d.setUTCDate(1);                      // park on day 1 to avoid overflow
  d.setUTCMonth(targetMonth);
  const daysInTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInTarget));
  return isoDate(d);
}

function daysBetweenInclusive(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / MS_PER_DAY) + 1;
}

interface ParsedTimeframe {
  numMonths: number;
  end: string;
}

function parseTimeframe(input: string, today: string): ParsedTimeframe {
  const trimmed = input.trim();

  const months = /^(\d+)\s+months?$/i.exec(trimmed);
  if (months) {
    const n = Number(months[1]);
    if (n < 1 || n > 36) throw new Error(`p2.calendar: out-of-range months: ${n}`);
    // end is today + N calendar months (inclusive); last span is clamped to this date
    return { numMonths: n, end: addMonths(today, n) };
  }

  const weeks = /^(\d+)\s+weeks?$/i.exec(trimmed);
  if (weeks) {
    const n = Number(weeks[1]);
    if (n < 1 || n > 156) throw new Error(`p2.calendar: out-of-range weeks: ${n}`);
    const end = addDays(today, n * 7 - 1);
    return { numMonths: Math.max(1, Math.ceil(n / 4)), end };
  }

  const byDate = /^by\s+(\d{4}-\d{2}-\d{2})$/i.exec(trimmed);
  if (byDate) {
    const end = byDate[1];
    if (end < today) throw new Error(`p2.calendar: by-date in the past: ${end}`);
    // count how many calendar months fit before end is reached
    let n = 0;
    while (addDays(addMonths(today, n + 1), -1) < end) n++;
    return { numMonths: Math.max(1, n + 1), end };
  }

  throw new Error(`unparseable timeframe: ${input}`);
}

export function buildSkeleton(timeframe: string, today: string): CalendarSkeleton {
  const { numMonths, end } = parseTimeframe(timeframe, today);

  const months: MonthSpan[] = [];
  for (let i = 0; i < numMonths; i++) {
    const start = addMonths(today, i);
    // Last span always clamps to end so the full timeframe is covered exactly.
    // Non-last spans also clamp down if the computed endOfSpan overshoots end.
    const isLast = i === numMonths - 1;
    let endOfSpan = addDays(addMonths(today, i + 1), -1);
    // end = addMonths(today, n) is inclusive; addDays(..., -1) above lands one day short on the final span, so clamp explicitly.
    if (isLast || endOfSpan > end) endOfSpan = end;
    months.push({ monthIndex: i, startDate: start, endDate: endOfSpan });
  }

  const weeksByMonth: WeekSpan[][] = [];
  for (const m of months) {
    const weeks: WeekSpan[] = [];
    let cursor = m.startDate;
    let localWeekIndex = 0;
    while (cursor <= m.endDate) {
      let weekEnd = addDays(cursor, 6);
      if (weekEnd > m.endDate) weekEnd = m.endDate;

      const dates: string[] = [];
      const dayCount = daysBetweenInclusive(cursor, weekEnd);
      for (let d = 0; d < dayCount; d++) dates.push(addDays(cursor, d));

      weeks.push({ weekIndex: localWeekIndex++, startDate: cursor, endDate: weekEnd, dates });
      cursor = addDays(weekEnd, 1);
    }
    weeksByMonth.push(weeks);
  }

  return { months, weeksByMonth };
}
