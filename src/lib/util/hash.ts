import { createHash } from "node:crypto";

function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    const obj = v as Record<string, unknown>;
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}
