// JSON-block tool-call protocol — see docs/harness-design.md §3, §7.
// The LLM emits a fenced ```tool_calls``` block; we parse it (with a tolerance
// ladder, since models often produce slightly malformed JSON), and we render
// results back as a ```tool_results``` block.

import type { ToolCall, ToolCallResult } from "./types.js";

export interface ParsedTurn {
  // The model signalled it is finished.
  done: boolean;
  summary?: string;
  // Tool calls to execute this turn (empty when done or when no block found).
  calls: ToolCall[];
  // Set when a tool_calls block was present but could not be parsed — the
  // director feeds this back so the model can correct its formatting.
  parseError?: string;
}

const BLOCK_RE = /```tool_calls\s*\n([\s\S]*?)```/;

// Best-effort repair of common JSON mistakes before JSON.parse:
//   - trailing commas before } or ]
//   - // line comments and /* */ block comments
// We do NOT try to fix unbalanced quotes/braces — that way lies madness; we
// surface a clear error instead and let the model retry.
function looseJsonRepair(s: string): string {
  let out = s;
  // Strip block comments.
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments (but not inside strings — best effort: only when the
  // // is preceded by whitespace or line start, to avoid nuking URLs in values).
  out = out.replace(/(^|\s)\/\/[^\n]*/g, "$1");
  // Remove trailing commas.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out.trim();
}

function tryParse(raw: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    try {
      return { value: JSON.parse(looseJsonRepair(raw)) };
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
  }
}

// Extract and parse the tool_calls block from a model response.
export function parseToolCalls(resp: string): ParsedTurn {
  const m = resp.match(BLOCK_RE);
  if (!m) {
    // No block at all — the director treats this as "no progress" (it may nudge
    // the model or stop after an idle streak).
    return { done: false, calls: [] };
  }
  const { value, error } = tryParse(m[1]);
  if (error || typeof value !== "object" || value === null) {
    return {
      done: false,
      calls: [],
      parseError:
        `The tool_calls block was not valid JSON: ${error ?? "not an object"}. ` +
        `Return exactly one \`\`\`tool_calls\`\`\` block whose body is a JSON object ` +
        `with either {"calls":[...]} or {"done":true,"summary":"..."}.`,
    };
  }
  const obj = value as Record<string, unknown>;
  if (obj.done === true) {
    return {
      done: true,
      summary: typeof obj.summary === "string" ? obj.summary : "",
      calls: [],
    };
  }
  const rawCalls = Array.isArray(obj.calls) ? obj.calls : [];
  const calls: ToolCall[] = [];
  for (const c of rawCalls) {
    if (typeof c !== "object" || c === null) continue;
    const cc = c as Record<string, unknown>;
    if (typeof cc.tool !== "string") continue;
    const args = typeof cc.args === "object" && cc.args !== null ? (cc.args as Record<string, unknown>) : {};
    calls.push({ tool: cc.tool, args });
  }
  if (calls.length === 0) {
    return {
      done: false,
      calls: [],
      parseError:
        `The tool_calls block had no usable calls. Each call needs a string "tool" ` +
        `and an "args" object, e.g. {"calls":[{"tool":"read","args":{"filePath":"src/Root.tsx"}}]}.`,
    };
  }
  return { done: false, calls };
}

// Render executed results as a ```tool_results``` block to append to the
// conversation as the next user message.
export function renderToolResults(results: ToolCallResult[]): string {
  const body = {
    results: results.map((r) => ({
      tool: r.tool,
      ok: r.ok,
      output: r.output,
      ...(r.truncated ? { truncated: true } : {}),
      ...(r.outputPath ? { outputPath: r.outputPath } : {}),
    })),
  };
  return "```tool_results\n" + JSON.stringify(body, null, 2) + "\n```";
}
