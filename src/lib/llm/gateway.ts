import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { promptHash } from "./hash";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
export interface LlmRequest<T> { model: string; messages: ChatMessage[]; schema: ZodType<T>; }
export interface CachePort {
  get(hash: string, model: string): unknown | undefined;
  put(hash: string, model: string, response: unknown): void;
}
export interface GatewayDeps {
  apiKey: string;
  cache: CachePort;
  fetchFn?: typeof fetch;
  endpoint?: string;
  maxConcurrency?: number;
}

/** Stable structural identity for a schema, so different schemas with the same
 *  model+messages do not collide in the response cache. */
function schemaFingerprint<T>(schema: ZodType<T>): string {
  return JSON.stringify(zodToJsonSchema(schema));
}

/** Some models (e.g. OpenAI gpt-4o-mini via OpenRouter) wrap structured output in a
 *  markdown code fence even when asked for JSON only. Strip an opening ```json / ```
 *  and a closing ``` defensively before JSON.parse. */
function stripJsonFence(s: string): string {
  let out = s.trim();
  out = out.replace(/^```(?:json)?\s*\n?/i, "");
  out = out.replace(/\n?\s*```\s*$/i, "");
  return out.trim();
}

export function makeGateway(deps: GatewayDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = deps.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const maxConcurrency = deps.maxConcurrency ?? 4;

  async function complete<T>(req: LlmRequest<T>): Promise<T> {
    const hash = promptHash(req.model, req.messages, schemaFingerprint(req.schema));
    const cached = deps.cache.get(hash, req.model);
    if (cached !== undefined) return req.schema.parse(cached);

    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: req.model, messages: req.messages }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`OpenRouter: no text content in response for model "${req.model}" (content was ${String(content)})`);
    }
    const parsed = req.schema.parse(JSON.parse(stripJsonFence(content)));
    deps.cache.put(hash, req.model, parsed);
    return parsed;
  }

  async function batchComplete<T>(reqs: LlmRequest<T>[]): Promise<T[]> {
    const results: T[] = new Array(reqs.length);
    let next = 0;
    async function worker(): Promise<void> {
      for (let i = next++; i < reqs.length; i = next++) {
        results[i] = await complete(reqs[i]);
      }
    }
    const workerCount = Math.min(maxConcurrency, reqs.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  return { complete, batchComplete };
}
