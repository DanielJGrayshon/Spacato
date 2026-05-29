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

  it("does NOT retry on an inner exhaustion error (avoids self-referential nested retry)", async () => {
    const innerExhaustion = new Error("p2: retry exhausted after 3 attempts: original cause");
    const fn = vi.fn().mockRejectedValue(innerExhaustion);
    await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow(/p2: retry exhausted/);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("preserves the original error as `cause` on exhaustion", async () => {
    const orig = new Error("p2: bad payload");
    const fn = vi.fn().mockRejectedValue(orig);
    try {
      await withRetry(fn, { attempts: 2, baseDelayMs: 0 });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/p2: retry exhausted/);
      expect((err as Error).cause).toBe(orig);
    }
  });

  it("does NOT treat arbitrary 3-digit numbers as 5xx errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("failed to find 500 widgets"));
    await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow(/500 widgets/);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("DOES treat OpenRouter 5xx as transient", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("OpenRouter 503 Service Unavailable"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
