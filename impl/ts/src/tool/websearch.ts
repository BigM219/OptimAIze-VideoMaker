// websearch — search the web for up-to-date information. See docs/harness-design.md.
// Provider order: an API key (Tavily/Exa) if configured, else a keyless scrape of
// DuckDuckGo's HTML endpoint. The scrape path means search works out of the box
// without a key, at the cost of lower reliability (rate-limits, layout drift) — so
// it fails soft (empty/clear message) rather than crashing the agent loop. Set
// WEBSEARCH_PROVIDER=none to disable web search entirely.

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
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Provider = "tavily" | "exa" | "scrape" | "none";

interface SearchHit {
  title: string;
  url: string;
  content: string;
}

// Resolve the active provider + key. An explicit WEBSEARCH_PROVIDER wins; otherwise
// use whichever API key is present (Tavily preferred), and fall back to the keyless
// DuckDuckGo scrape so search works without any configuration. "none" disables it.
function resolveProvider(): { provider: Provider; key: string } {
  const explicit = readEnv("WEBSEARCH_PROVIDER").toLowerCase();
  const tavily = readEnv("TAVILY_API_KEY");
  const exa = readEnv("EXA_API_KEY");
  if (explicit === "none") return { provider: "none", key: "" };
  if (explicit === "scrape") return { provider: "scrape", key: "" };
  if (explicit === "tavily" && tavily) return { provider: "tavily", key: tavily };
  if (explicit === "exa" && exa) return { provider: "exa", key: exa };
  // No explicit choice: prefer a configured API key, else keyless scrape.
  if (tavily) return { provider: "tavily", key: tavily };
  if (exa) return { provider: "exa", key: exa };
  return { provider: "scrape", key: "" };
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

// Keyless search via DuckDuckGo's HTML endpoint (https://html.duckduckgo.com/html/).
// It returns static HTML with far less bot-blocking than Google/Bing, which makes it
// usable for light scraping. Still rate-limited and layout can drift, so the parser
// is defensive and the caller treats failures/empties as soft.
async function searchScrape(query: string, n: number, signal: AbortSignal): Promise<SearchHit[]> {
  const resp = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const html = await resp.text();
  return parseDuckDuckGoHtml(html).slice(0, n);
}

// Decode the &uddg= redirect DuckDuckGo wraps result links in, and basic entities.
function decodeDdgUrl(href: string): string {
  let url = href;
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      url = decodeURIComponent(m[1]);
    } catch {
      url = m[1];
    }
  } else if (href.startsWith("//")) {
    url = "https:" + href;
  }
  return url;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse the DuckDuckGo HTML result page into hits. Exported for unit testing so we
// can verify the parser against a captured fixture without hitting the network.
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Each result is an <a class="result__a" href="...">title</a>; the snippet is the
  // following <a class="result__snippet">...</a>. Match links first, then look for
  // the nearest snippet after each.
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: Array<{ index: number; text: string }> = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push({ index: sm.index, text: stripTags(sm[1]) });
  }

  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const url = decodeDdgUrl(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    // Find the first snippet that appears after this link in the document.
    const after = snippets.find((s) => s.index > lm!.index);
    hits.push({ title, url, content: after ? after.text : "" });
  }
  return hits;
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
          "Web search is disabled (WEBSEARCH_PROVIDER=none). Proceed using your existing knowledge.",
        metadata: { error: "disabled" },
      };
    }
    const n = Math.min(args.numResults && args.numResults > 0 ? Math.floor(args.numResults) : DEFAULT_RESULTS, MAX_RESULTS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    if (ctx.signal) ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
    let hits: SearchHit[];
    try {
      hits =
        provider === "tavily"
          ? await searchTavily(args.query, n, key, controller.signal)
          : provider === "exa"
            ? await searchExa(args.query, n, key, controller.signal)
            : await searchScrape(args.query, n, controller.signal);
    } catch (e) {
      clearTimeout(timer);
      const msg = controller.signal.aborted ? "search request timed out" : String((e as Error).message ?? e);
      // Scrape is best-effort; phrase its failure as soft so the model proceeds.
      const hint = provider === "scrape" ? " (keyless DuckDuckGo scrape — set TAVILY_API_KEY for reliable search)" : "";
      return { title: args.query, output: `Web search failed: ${msg}${hint}`, metadata: { error: "search_failed", provider } };
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
