// glob — find project files by pattern. See docs/harness-design.md §5.2.
// Walks the jailed tree (walk.ts) and matches a glob pattern (**, *, ?) without
// pulling in a dependency. Bounded to 100 results like opencode.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, optString } from "./validate.js";
import { walkFiles } from "./walk.js";

const LIMIT = 100;

interface Args {
  pattern: string;
  path?: string;
}

// Translate a glob to a RegExp. Order matters: handle ** before *.
function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators (and an optional trailing /).
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export const GlobTool: ToolDef<Args> = {
  id: "glob",
  description:
    "Find files by glob pattern (e.g. src/**/*.tsx, **/Root.tsx). Returns matching project-relative paths. Use to locate files before reading them.",
  parameters: {
    pattern: { type: "string", description: "Glob pattern (** matches any depth)", required: true },
    path: { type: "string", description: "Directory to search under (default project root)" },
  },
  validate(args) {
    return { pattern: reqString(args, "pattern"), path: optString(args, "path") };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ?? ".";
    const re = globToRe(args.pattern);
    const all = walkFiles(ctx, root);
    const matched = all.filter((p) => re.test(p));
    const truncated = matched.length > LIMIT;
    const shown = matched.slice(0, LIMIT);
    let output = shown.length === 0 ? "No files found" : shown.join("\n");
    if (truncated) {
      output += `\n\n(Results truncated: showing first ${LIMIT} of ${matched.length}. Use a more specific pattern.)`;
    }
    return { title: args.pattern, output, metadata: { count: shown.length, truncated } };
  },
};
