// grep — regex content search over the jailed project tree.
// See docs/harness-design.md §5.2. Pure-JS (no dependency on rg being present
// in the sandbox); walks files via walk.ts and matches each line.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, optString } from "./validate.js";
import { walkFiles } from "./walk.js";
import { MAX_LINE_LENGTH } from "./truncate.js";

interface Args {
  pattern: string;
  path?: string;
  include?: string;
}

const MATCH_LIMIT = 100;

// Translate a simple include pattern (e.g. "*.tsx", "*.{ts,tsx}") to a RegExp.
function includeMatcher(include: string | undefined): (p: string) => boolean {
  if (!include) return () => true;
  // Expand {a,b} alternations, then * → [^/]*, ? → [^/].
  const expanded = include.replace(/\{([^}]*)\}/g, (_m, inner: string) => `(${inner.split(",").join("|")})`);
  const re = new RegExp(
    "^" + expanded.replace(/[.+^${}()|[\]\\]/g, (c) => (c === "{" || c === "}" || c === "(" || c === ")" || c === "|" ? c : "\\" + c)).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$",
  );
  return (p: string) => re.test(p.split("/").pop() ?? p);
}

export const GrepTool: ToolDef<Args> = {
  id: "grep",
  description:
    "Search file contents by regular expression across the project. Returns file paths with line numbers and the matching lines. Use include to filter files (e.g. \"*.tsx\").",
  parameters: {
    pattern: { type: "string", description: "Regex to search for in file contents", required: true },
    path: { type: "string", description: "Directory to search under (default: project root)" },
    include: { type: "string", description: 'File filter, e.g. "*.tsx" or "*.{ts,tsx}"' },
  },
  validate(args) {
    return { pattern: reqString(args, "pattern"), path: optString(args, "path"), include: optString(args, "include") };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      return {
        title: args.pattern,
        output: `Invalid regex: ${String((e as Error).message ?? e)}`,
        metadata: { error: "bad_regex" },
      };
    }
    const matchFile = includeMatcher(args.include);
    const files = walkFiles(ctx, args.path ?? ".").filter(matchFile);

    const perFile: Array<{ path: string; lines: Array<{ n: number; text: string }> }> = [];
    let total = 0;
    let truncated = false;
    for (const f of files) {
      let content: string;
      try {
        content = ctx.store.readFile(ctx.projectId, f);
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const hits: Array<{ n: number; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          total++;
          if (total > MATCH_LIMIT) {
            truncated = true;
            break;
          }
          const text = lines[i].length > MAX_LINE_LENGTH ? lines[i].slice(0, MAX_LINE_LENGTH) + " …" : lines[i];
          hits.push({ n: i + 1, text });
        }
      }
      if (hits.length > 0) perFile.push({ path: f, lines: hits });
      if (truncated) break;
    }

    if (total === 0) {
      return { title: args.pattern, output: "No files found", metadata: { matches: 0 } };
    }
    const header = `Found ${total} matches${truncated ? ` (showing first ${MATCH_LIMIT})` : ""}`;
    const body = perFile
      .map((pf) => `\n${pf.path}:\n` + pf.lines.map((l) => `  Line ${l.n}: ${l.text}`).join("\n"))
      .join("\n");
    return {
      title: args.pattern,
      output: header + "\n" + body,
      metadata: { matches: total, truncated },
    };
  },
};
