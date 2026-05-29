import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./retry";
import { z } from "zod";

describe("withRetry", () => {
  it("returns immediately on first-call success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on a transient error then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("p2: bad length"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on a ZodError", async () => {
    const zerr = new z.ZodError([]);
    const fn = vi.fn()
      .mockRejectedValueOnce(zerr)
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { baseDelayMs: 0 });
    expect(result).toBe("ok");
  });

  it("does NOT retry on a non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("nope"));
    await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow(/nope/);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("throws a wrapped error after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("p2: bad"));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 }))
      .rejects.toThrowError(/p2: retry exhausted after 3 attempts/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honours exponential backoff", async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("p2: bad"))
      .mockRejectedValueOnce(new Error("p2: bad"))
      .mockResolvedValueOnce("ok");
    const promise = withRetry(fn, { attempts: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result).toBe("ok");
    vi.useRealTimers();
  });
});
