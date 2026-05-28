import { describe, it, expect } from "vitest";
import { tokenise, STOP_WORDS } from "@/lib/util/text";

describe("util/text tokenise", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenise("Hello, World! 123")).toEqual(["hello", "world", "123"]);
  });
  it("drops stop-words and tokens of length <= 1", () => {
    const out = tokenise("the quick brown fox is a fast x");
    expect(out).toEqual(["quick", "brown", "fox", "fast"]);
  });
  it("returns an empty array on whitespace-only input", () => {
    expect(tokenise("   ")).toEqual([]);
  });
  it("STOP_WORDS includes the common ones", () => {
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("of")).toBe(true);
    expect(STOP_WORDS.has("and")).toBe(true);
  });
});
