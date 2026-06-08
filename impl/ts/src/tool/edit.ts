// edit — exact string replacement in a project file, no full-file rewrite.
// See docs/harness-design.md §5.1. Ports 3 of opencode's matching strategies
// (Simple → LineTrimmed → BlockAnchor) so the model tolerates small whitespace
// drift without re-sending the whole file. This is the highest-value tool.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, optBool, assertProjectPath } from "./validate.js";
import { ToolValidationError } from "./types.js";

interface Args {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

// A replacer yields candidate substrings of `content` that should be considered
// equal to `find`. The first strategy that produces a usable match wins.
type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

// 1. Exact match.
const simpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

// 2. Line-trimmed: match a run of lines whose trimmed text equals the trimmed
//    search lines (tolerates trailing/leading whitespace differences per line).
const lineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length === 0) return;

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    // Reconstruct the exact original span (including its real whitespace).
    let start = 0;
    for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
    let end = start;
    for (let k = 0; k < searchLines.length; k++) end += originalLines[i + k].length + 1;
    yield content.slice(start, Math.min(end, content.length));
  }
};

// 3. Block-anchor: for blocks of >=3 lines, match on the first and last
//    (trimmed) line only, allowing the middle to differ. Useful when the model
//    paraphrases the interior but the anchors are stable.
const blockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length < 3) return;

  const firstAnchor = searchLines[0].trim();
  const lastAnchor = searchLines[searchLines.length - 1].trim();
  const blockSize = searchLines.length;

  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstAnchor) continue;
    // Allow the closing anchor to drift by ±25% of the block size.
    const maxDelta = Math.max(1, Math.floor(blockSize * 0.25));
    for (let span = blockSize - maxDelta; span <= blockSize + maxDelta; span++) {
      const endIdx = i + span - 1;
      if (endIdx <= i || endIdx >= originalLines.length) continue;
      if (originalLines[endIdx].trim() !== lastAnchor) continue;
      let start = 0;
      for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
      let end = start;
      for (let k = i; k <= endIdx; k++) end += originalLines[k].length + 1;
      yield content.slice(start, Math.min(end, content.length));
    }
  }
};

const STRATEGIES: Replacer[] = [simpleReplacer, lineTrimmedReplacer, blockAnchorReplacer];

// Reject a match whose span is wildly larger than oldString — a sign the
// fuzzy matcher grabbed too much (opencode's isDisproportionateMatch).
function isDisproportionate(matched: string, find: string): boolean {
  const ml = matched.split("\n").length;
  const fl = find.split("\n").length;
  if (ml >= Math.max(fl + 3, fl * 2)) return true;
  if (fl > 1 && matched.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4)) return true;
  return false;
}

// Find all occurrences of `match` (exact substring) in content.
function indicesOf(content: string, match: string): number[] {
  const out: number[] = [];
  let from = 0;
  while (true) {
    const idx = content.indexOf(match, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + Math.max(1, match.length);
  }
  return out;
}

export const EditTool: ToolDef<Args> = {
  id: "edit",
  mutating: true,
  description:
    "Replace an exact string in a file (no full-file rewrite — saves tokens). oldString must match the file exactly (whitespace included); if it appears more than once, add surrounding context or set replaceAll. Read the file first to copy the exact text (omit the line-number prefix).",
  parameters: {
    filePath: { type: "string", description: "Relative path to the file", required: true },
    oldString: { type: "string", description: "Exact text to replace", required: true },
    newString: { type: "string", description: "Replacement text", required: true },
    replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" },
  },
  validate(args) {
    const filePath = assertProjectPath(reqString(args, "filePath"));
    const oldString = reqString(args, "oldString");
    if (typeof args.newString !== "string") {
      throw new ToolValidationError('"newString" is required and must be a string.');
    }
    const newString = args.newString;
    if (oldString === newString) {
      throw new ToolValidationError("No changes to apply: oldString and newString are identical.");
    }
    return { filePath, oldString, newString, replaceAll: optBool(args, "replaceAll") ?? false };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let content: string;
    try {
      content = ctx.store.readFile(ctx.projectId, args.filePath);
    } catch {
      return { title: args.filePath, output: `File not found: ${args.filePath}`, metadata: { error: "not_found" } };
    }

    // Find a matching span using the strategy cascade.
    let matched: string | null = null;
    for (const strategy of STRATEGIES) {
      for (const candidate of strategy(content, args.oldString)) {
        if (candidate === "" || !content.includes(candidate)) continue;
        if (candidate !== args.oldString && isDisproportionate(candidate, args.oldString)) continue;
        const occ = indicesOf(content, candidate);
        if (occ.length === 0) continue;
        if (occ.length > 1 && !args.replaceAll) {
          // Ambiguous on this candidate; let a later (more specific) strategy try,
          // but if it's the exact simple match, report the ambiguity now.
          if (strategy === simpleReplacer) {
            return {
              title: args.filePath,
              output: `Found ${occ.length} matches for oldString. Provide more surrounding context to make it unique, or set replaceAll: true.`,
              metadata: { error: "ambiguous", matches: occ.length },
            };
          }
          continue;
        }
        matched = candidate;
        break;
      }
      if (matched !== null) break;
    }

    if (matched === null) {
      return {
        title: args.filePath,
        output:
          "Could not find oldString in the file. It must match exactly, including whitespace and indentation. Read the file again and copy the exact text (without the line-number prefix).",
        metadata: { error: "no_match" },
      };
    }

    let next: string;
    let count = 0;
    if (args.replaceAll) {
      next = content.split(matched).join(args.newString);
      count = indicesOf(content, matched).length;
    } else {
      const idx = content.indexOf(matched);
      next = content.slice(0, idx) + args.newString + content.slice(idx + matched.length);
      count = 1;
    }

    ctx.store.writeFile(ctx.projectId, args.filePath, next);
    ctx.log("scene", `Edited ${args.filePath} (${count} replacement${count === 1 ? "" : "s"})`, {
      kind: "write_file",
      path: args.filePath,
      content: args.newString,
    });
    return {
      title: args.filePath,
      output: `Edit applied successfully (${count} replacement${count === 1 ? "" : "s"}).`,
      metadata: { filePath: args.filePath, replacements: count },
    };
  },
};
