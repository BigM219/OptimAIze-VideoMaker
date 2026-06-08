// websearch — search the web for up-to-date information. See docs/harness-design.md.
// Provider-configurable: Tavily (default) or Exa, selected by WEBSEARCH_PROVIDER
// and the matching API key in env/.env. Without a configured key the tool returns
// an honest "not configured" message instead of failing the loop — the model can
// then proceed without web data rather than retrying blindly.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, optNumber } from "./validate.js";
import { truncateOutput } from "./truncate.js";
import { readEnv } from "./env.js";

interface Args {
  query: string;
  numResults?: number;
}

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const TIMEOUT_MS = 25_000;

interface SearchHit {
  title: string;
  url: string;
  content: string;
}

// Resolve the active provider + key. "tavily" is the default because its free
// tier is generous and the API is simple; "exa" is supported as an alternative.
function resolveProvider(): { provider: "tavily" | "exa" | "none"; key: string } {
  const explicit = readEnv("WEBSEARCH_PROVIDER").toLowerCase();
  const tavily = readEnv("TAVILY_API_KEY");
  const exa = readEnv("EXA_API_KEY");
  if (explicit === "tavily" && tavily) return { provider: "tavily", key: tavily };
  if (explicit === "exa" && exa) return { provider: "exa", key: exa };
  // No explicit choice: use whichever key is present (Tavily preferred).
  if (tavily) return { provider: "tavily", key: tavily };
  if (exa) return { provider: "exa", key: exa };
  return { provider: "none", key: "" };
}

async function searchTavily(query: string, n: number, key: string, signal: AbortSignal): Promise<SearchHit[]> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: n, search_depth: "basic" }),
    signal,
  });
  if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.content ?? "" }));
}

async function searchExa(query: string, n: number, key: string, signal: AbortSignal): Promise<SearchHit[]> {
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: n, contents: { text: { maxCharacters: 1200 } } }),
    signal,
  });
  if (!resp.ok) throw new Error(`Exa HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.text ?? "" }));
}

export const WebSearchTool: ToolDef<Args> = {
  id: "websearch",
  description:
    "Search the web for up-to-date information (current events, recent docs, version-specific facts beyond your training). Returns titles, URLs, and content snippets. Use webfetch afterward to read a specific result in full.",
  parameters: {
    query: { type: "string", description: "The search query", required: true },
    numResults: { type: "number", description: `Number of results (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})` },
  },
  validate(args) {
    const query = reqString(args, "query");
    const numResults = optNumber(args, "numResults");
    return { query, numResults };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const { provider, key } = resolveProvider();
    if (provider === "none") {
      return {
        title: args.query,
        output:
          "Web search is not configured. To enable it, set TAVILY_API_KEY (or EXA_API_KEY) in impl/ts/.env. " +
          "Proceed using your existing knowledge.",
        metadata: { error: "not_configured" },
      };
    }
    const n = Math.min(args.numResults && args.numResults > 0 ? Math.floor(args.numResults) : DEFAULT_RESULTS, MAX_RESULTS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let hits: SearchHit[];
    try {
      hits =
        provider === "tavily"
          ? await searchTavily(args.query, n, key, controller.signal)
          : await searchExa(args.query, n, key, controller.signal);
    } catch (e) {
      clearTimeout(timer);
      const msg = controller.signal.aborted ? "search request timed out" : String((e as Error).message ?? e);
      return { title: args.query, output: `Web search failed: ${msg}`, metadata: { error: "search_failed", provider } };
    }
    clearTimeout(timer);

    if (hits.length === 0) {
      return { title: args.query, output: "No search results found. Try a different query.", metadata: { provider, results: 0 } };
    }
    const body = hits
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.content.replace(/\s+/g, " ").trim().slice(0, 500)}`)
      .join("\n\n");
    const shaped = truncateOutput(ctx, "websearch", `Web search results (${provider}) for "${args.query}":\n\n${body}`);
    return {
      title: args.query,
      output: shaped.output,
      truncated: shaped.truncated,
      outputPath: shaped.outputPath,
      metadata: { provider, results: hits.length },
    };
  },
};
