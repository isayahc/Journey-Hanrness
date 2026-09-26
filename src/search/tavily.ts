import { z } from "zod";

export const searchInput = z.object({
  query: z.string().trim().min(1).max(400),
  maxResults: z.number().int().min(1).max(5).default(5),
}).strict();
export interface SearchSource { title: string; url: string; excerpt: string }
export class SearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export const notConfigured = () => new SearchError("SEARCH_NOT_CONFIGURED", "Web search is unavailable. Add TAVILY_API_KEY to .env and restart the app and OpenCode.");

export class TavilyClient {
  readonly enabled: boolean;
  private key: string;
  constructor(env: NodeJS.ProcessEnv = process.env, private fetcher: typeof fetch = fetch, private timeoutMs = 10_000) {
    this.key = env.TAVILY_API_KEY?.trim() || "";
    this.enabled = !!this.key;
  }
  async search(value: unknown, parentSignal?: AbortSignal): Promise<{ query: string; sources: SearchSource[]; retrievedAt: Date }> {
    if (!this.enabled) throw notConfigured();
    const parsed = searchInput.safeParse(value);
    if (!parsed.success) throw new SearchError("INVALID_SEARCH", "Search requires a query of 1–400 characters and 1–5 results.");
    const { query, maxResults } = parsed.data;
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(parentSignal ? [parentSignal] : [])]);
    try {
      const response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic", topic: "general",
          auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new SearchError("SEARCH_AUTH_FAILED", "Tavily rejected the API key. Check TAVILY_API_KEY and restart the services.");
        if ([429, 432, 433].includes(response.status)) throw new SearchError("SEARCH_LIMIT_REACHED", "Tavily's rate or usage limit was reached. Check the account allowance or try again later.");
        throw new SearchError("SEARCH_PROVIDER_FAILED", "Tavily could not complete the search. Try again later.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 512_000) throw new SearchError("SEARCH_RESPONSE_TOO_LARGE", "The search response was too large. Try a more specific query.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })) }).safeParse(data);
      if (!result.success) throw new Error("Invalid response");
      const sources: SearchSource[] = [];
      for (const item of result.data.results) {
        if (sources.length >= maxResults) break;
        try {
          const url = new URL(item.url);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || item.url.length > 2048) continue;
          sources.push({ title: item.title.slice(0, 200), url: url.toString(), excerpt: item.content.slice(0, 1000) });
        } catch { /* Discard malformed or unsafe source URLs. */ }
      }
      return { query, sources, retrievedAt: new Date() };
    } catch (error) {
      if (error instanceof SearchError) throw error;
      if (signal.aborted) throw new SearchError("SEARCH_TIMEOUT", "The search timed out or was cancelled. Saved progress is unchanged; try again if needed.");
      throw new SearchError("SEARCH_UNAVAILABLE", "Tavily is unreachable or returned an invalid response. Try again later.");
    }
  }
}
