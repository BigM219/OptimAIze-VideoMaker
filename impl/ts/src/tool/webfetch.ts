// webfetch — fetch a URL and return its content as markdown/text/html.
// See docs/harness-design.md (Web/skill group). Lets the agent pull in external
// reference material (docs, examples) on demand. Runs in the backend process
// (which has network), not the sandbox — so it does not touch store/backend.
//
// No turndown dependency, so HTML→markdown is a small hand-rolled converter:
// strip scripts/styles, turn headings/links/lists/code into markdown, collapse
// whitespace. Good enough to feed the model readable text without the noise.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, optString, optNumber } from "./validate.js";
import { ToolValidationError } from "./types.js";
import { truncateOutput } from "./truncate.js";

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Format = "markdown" | "text" | "html";

interface Args {
  url: string;
  format: Format;
  timeout?: number;
}

// Remove a tag and all its content (script/style/etc.).
function stripElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"), "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html: string): string {
  let s = html;
  for (const tag of ["script", "style", "noscript", "iframe", "svg", "head"]) s = stripElement(s, tag);
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function htmlToMarkdown(html: string): string {
  let s = html;
  for (const tag of ["script", "style", "noscript", "iframe", "svg", "head"]) s = stripElement(s, tag);
  // Headings.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => `\n\n${"#".repeat(Number(lvl))} ${strip(inner)}\n\n`);
  // Code blocks and inline code.
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => `\n\n\`\`\`\n${decodeEntities(strip(inner))}\n\`\`\`\n\n`);
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${strip(inner)}\``);
  // Links.
  s = s.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const text = strip(inner);
    return text ? `[${text}](${href})` : "";
  });
  // List items.
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${strip(inner)}`);
  // Paragraphs / breaks / block ends.
  s = s.replace(/<\/(p|div|section|article|header|footer|ul|ol|tr|h[1-6])>/gi, "\n\n");
  s = s.replace(/<br[^>]*>/gi, "\n");
  // Drop remaining tags, decode, tidy whitespace.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Strip tags from a small inner fragment (used inside replacers).
function strip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export const WebFetchTool: ToolDef<Args> = {
  id: "webfetch",
  description:
    "Fetch a URL and return its content as markdown (default), text, or html. Use to pull in external reference material (API docs, examples). URL must be http(s). Large pages are truncated.",
  parameters: {
    url: { type: "string", description: "The URL to fetch (must start with http:// or https://)", required: true },
    format: { type: "string", description: "markdown | text | html (default markdown)" },
    timeout: { type: "number", description: `Timeout in seconds (max ${MAX_TIMEOUT_S})` },
  },
  validate(args) {
    const url = reqString(args, "url");
    if (!/^https?:\/\//i.test(url)) {
      throw new ToolValidationError('"url" must start with http:// or https://');
    }
    const fmtRaw = optString(args, "format") ?? "markdown";
    if (!["markdown", "text", "html"].includes(fmtRaw)) {
      throw new ToolValidationError('"format" must be one of: markdown, text, html.');
    }
    return { url, format: fmtRaw as Format, timeout: optNumber(args, "timeout") };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = Math.min((args.timeout ?? DEFAULT_TIMEOUT_S) * 1000, MAX_TIMEOUT_S * 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Honour an upstream abort (e.g. the agent loop was cancelled).
    if (ctx.signal) ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

    let resp: Response;
    try {
      resp = await fetch(args.url, {
        headers: { "User-Agent": UA, Accept: "text/html,text/markdown,text/plain,*/*" },
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error).name === "AbortError";
      return {
        title: args.url,
        output: aborted ? `Request timed out after ${timeoutMs / 1000}s.` : `Fetch failed: ${String((e as Error).message ?? e)}`,
        metadata: { error: "fetch_failed" },
      };
    }
    clearTimeout(timer);

    if (!resp.ok) {
      return {
        title: args.url,
        output: `HTTP ${resp.status} ${resp.statusText} fetching ${args.url}`,
        metadata: { error: "http_error", status: resp.status },
      };
    }

    const lenHeader = Number(resp.headers.get("content-length") ?? "0");
    if (lenHeader > MAX_RESPONSE_BYTES) {
      return { title: args.url, output: `Response too large (${lenHeader} bytes, limit ${MAX_RESPONSE_BYTES}).`, metadata: { error: "too_large" } };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const raw = await resp.text();
    if (Buffer.byteLength(raw, "utf-8") > MAX_RESPONSE_BYTES) {
      return { title: args.url, output: `Response too large (exceeds ${MAX_RESPONSE_BYTES} bytes).`, metadata: { error: "too_large" } };
    }

    const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
    let body: string;
    if (!isHtml || args.format === "html") {
      body = raw;
    } else if (args.format === "text") {
      body = htmlToText(raw);
    } else {
      body = htmlToMarkdown(raw);
    }

    const shaped = truncateOutput(ctx, "webfetch", body);
    return {
      title: `${args.url} (${contentType || "?"})`,
      output: shaped.output,
      truncated: shaped.truncated,
      outputPath: shaped.outputPath,
      metadata: { url: args.url, format: args.format, contentType },
    };
  },
};
