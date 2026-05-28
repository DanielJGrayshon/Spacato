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
  embeddingEndpoint?: string;
  maxConcurrency?: number;
}

/** Stable structural identity for a schema, so different schemas with the same
 *  model+messages do not collide in the response cache. */
function schemaFingerprint<T>(schema: ZodType<T>): string {
  return JSON.stringify(zodToJsonSchema(schema));
}

/** Some models wrap structured output in a markdown code fence even when asked for
 *  JSON only. Strip an opening ``` with any (or no) language tag and a closing ```
 *  defensively before JSON.parse. */
function stripJsonFence(s: string): string {
  let out = s.trim();
  out = out.replace(/^```[^\n]*\n?/i, "");
  out = out.replace(/\n?\s*```\s*$/i, "");
  return out.trim();
}

export function makeGateway(deps: GatewayDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = deps.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const embeddingEndpoint = deps.embeddingEndpoint ?? "https://openrouter.ai/api/v1/embeddings";
  const maxConcurrency = deps.maxConcurrency ?? 4;

  async function complete<T>(req: LlmRequest<T>): Promise<T> {
    const hash = promptHash(req.model, req.messages, schemaFingerprint(req.schema));
    const cached = deps.cache.get(hash, req.model);
    if (cached !== undefined) return req.schema.parse(cached);

    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const raw = await res.text();
    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = JSON.parse(raw);
    } catch {
      const snippet = raw.slice(0, 120).replace(/\s+/g, " ");
      throw new Error(`OpenRouter: non-JSON response body (status=${res.status}, snippet=${JSON.stringify(snippet)})`);
    }
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

  async function embed(text: string, model: string): Promise<number[]> {
    const hash = promptHash(model, [], `embed:${text}`);
    const cached = deps.cache.get(hash, model);
    if (cached !== undefined) return cached as number[];

    const res = await fetchFn(embeddingEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) throw new Error(`OpenRouter embeddings ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec)) {
      throw new Error(`OpenRouter: no embedding in response for model "${model}"`);
    }
    deps.cache.put(hash, model, vec);
    return vec;
  }

  async function embedBatch(texts: string[], model: string): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    let next = 0;
    async function worker(): Promise<void> {
      for (let i = next++; i < texts.length; i = next++) {
        results[i] = await embed(texts[i], model);
      }
    }
    const workerCount = Math.min(maxConcurrency, texts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  return { complete, batchComplete, embed, embedBatch };
}
