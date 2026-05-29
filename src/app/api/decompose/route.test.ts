// End-to-end POST coverage lives in src/lib/p2/decompose-handler.test.ts.
// This file unit-tests only the pure mapErrorToStatus helper.
import { describe, it, expect } from "vitest";
import { mapErrorToStatus } from "./error-mapping";

describe("mapErrorToStatus", () => {
  it("returns 404 for not-converged errors", () => {
    expect(mapErrorToStatus("p2: goal 7 not converged")).toBe(404);
  });

  it("returns 400 for unparseable timeframe errors", () => {
    expect(mapErrorToStatus("p2: unparseable timeframe: forever")).toBe(400);
  });

  it("returns 400 for out-of-range timeframe errors", () => {
    expect(mapErrorToStatus("p2.calendar: out-of-range months: 99")).toBe(400);
  });

  it("returns 503 for retry-exhausted LLM failures", () => {
    expect(mapErrorToStatus("p2: retry exhausted after 3 attempts: ECONNRESET")).toBe(503);
  });

  it("returns 400 for by-date-in-the-past errors", () => {
    expect(mapErrorToStatus("p2: p2.calendar: by-date in the past: 2024-01-01")).toBe(400);
  });

  it("returns 500 for everything else", () => {
    expect(mapErrorToStatus("kaboom")).toBe(500);
    expect(mapErrorToStatus("")).toBe(500);
  });
});
