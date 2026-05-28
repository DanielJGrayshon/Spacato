import { SOURCES } from "@/lib/p5/sources";
import type { FeedItem, QueryTerm } from "@/lib/p5/types";

export interface IngestDeps {
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Fetch + validate + normalise every QueryTerm, concatenating the results.
 *  Operational failures are logged and skipped (return []); only an allow-list
 *  escape throws. */
export async function ingest(queries: QueryTerm[], deps: IngestDeps = {}): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for (const q of queries) {
    out.push(...(await ingestOne(q, deps)));
  }
  return out;
}

async function ingestOne(q: QueryTerm, deps: IngestDeps): Promise<FeedItem[]> {
  const source = SOURCES[q.source];
  if (!source) {
    console.warn(`feed-ingest: unknown source "${q.source}", skipping`);
    return [];
  }
  const env = deps.env ?? process.env;
  const apiKey = env[source.apiKeyEnvVar];
  if (!apiKey) {
    console.warn(`feed-ingest: missing ${source.apiKeyEnvVar}, skipping source "${q.source}"`);
    return [];
  }

  const url = source.buildUrl(q.terms, apiKey);
  if (!url.startsWith(source.baseUrl)) {
    throw new Error(`feed-ingest: built URL "${url}" escapes allow-list base "${source.baseUrl}"`);
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    console.warn(`feed-ingest: fetch failed for "${q.source}": ${String(err)}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`feed-ingest: "${q.source}" returned HTTP ${res.status}`);
    return [];
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    console.warn(`feed-ingest: "${q.source}" returned non-JSON body: ${String(err)}`);
    return [];
  }

  const parsed = source.responseSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(`feed-ingest: "${q.source}" response failed schema validation`);
    return [];
  }
  return source.normalise(parsed.data).map((it) => ({ ...it, queryWeight: q.weight }));
}
