export function mapErrorToStatus(msg: string): number {
  if (/not converged/.test(msg)) return 404;
  if (/unparseable timeframe|out-of-range/.test(msg)) return 400;
  if (/retry exhausted/.test(msg)) return 503;
  return 500;
}
