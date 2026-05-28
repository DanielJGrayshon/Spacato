import { describe, it, expect } from "vitest";
import { contentHash } from "@/lib/util/hash";

describe("util/hash contentHash", () => {
  it("is deterministic", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ a: 1, b: 2 }));
  });
  it("is key-order-invariant", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
  it("is recursively key-order-invariant on nested objects", () => {
    expect(contentHash({ a: { y: 1, x: 2 } })).toBe(contentHash({ a: { x: 2, y: 1 } }));
  });
  it("differs for different content", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
  it("returns 16 lowercase hex chars", () => {
    expect(contentHash({ x: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
  it("handles primitives and arrays", () => {
    expect(contentHash([1, 2, 3])).toBe(contentHash([1, 2, 3]));
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });
});
