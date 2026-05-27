import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "@/lib/store/db";
import { makeRepositories } from "@/lib/store/repositories";

describe("plan-store repositories", () => {
  let repos: ReturnType<typeof makeRepositories>;
  beforeEach(() => {
    repos = makeRepositories(openDb(":memory:"));
  });

  it("creates and reads a goal", () => {
    const g = repos.goals.create({ title: "Run a marathon", rawText: "I want to run a marathon" });
    expect(g.id).toBeTypeOf("number");
    expect(repos.goals.get(g.id)?.title).toBe("Run a marathon");
  });

  it("stores converged_spec on a goal", () => {
    const g = repos.goals.create({ title: "x", rawText: "x" });
    repos.goals.setConvergedSpec(g.id, { scope: "narrow" });
    expect(repos.goals.get(g.id)?.convergedSpec).toEqual({ scope: "narrow" });
  });

  it("caches and retrieves an llm response", () => {
    repos.llmCache.put("hash1", "model-a", { ok: true });
    expect(repos.llmCache.get("hash1", "model-a")).toEqual({ ok: true });
    expect(repos.llmCache.get("missing", "model-a")).toBeUndefined();
  });
});
