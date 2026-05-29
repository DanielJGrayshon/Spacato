import { z } from "zod";

export interface RetryOpts {
  attempts?: number;
  isTransient?: (err: unknown) => boolean;
  baseDelayMs?: number;
}

export function defaultIsTransient(err: unknown): boolean {
  if (err instanceof z.ZodError) return true;
  if (err instanceof SyntaxError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (msg.startsWith("p2:")) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/(ECONNRESET|ETIMEDOUT|fetch failed|network error)/i.test(msg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const isTransient = opts.isTransient ?? defaultIsTransient;
  const baseDelayMs = opts.baseDelayMs ?? 250;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (i === attempts - 1) break;
      await sleep(baseDelayMs * Math.pow(2, i));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`p2: retry exhausted after ${attempts} attempts: ${msg}`);
}
