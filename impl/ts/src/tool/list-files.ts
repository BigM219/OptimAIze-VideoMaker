// list_files — list the project source tree (POSIX paths, skips node_modules).
// See docs/harness-design.md §5.1. Helps the model orient before reading.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { optString } from "./validate.js";

interface Args {
  path?: string;
}

export const ListFilesTool: ToolDef<Args> = {
  id: "list_files",
  description:
    "List the project source files under a directory (defaults to src). Returns relative POSIX paths, skipping node_modules. Use this to orient before reading or editing.",
  parameters: {
    path: { type: "string", description: "Directory to list (default src)" },
  },
  validate(args) {
    return { path: optString(args, "path") };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ?? "src";
    const found: string[] = [];
    const walk = (rel: string): void => {
      let entries: Array<{ path: string; isDir: boolean }>;
      try {
        entries = ctx.store.listFiles(ctx.projectId, rel) as Array<{ path: string; isDir: boolean }>;
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.path.includes("node_modules")) continue;
        if (e.isDir) walk(e.path);
        else found.push(e.path);
      }
    };
    walk(root);
    found.sort();
    const output = found.length ? found.join("\n") : "No files found";
    return { title: root, output, metadata: { count: found.length } };
  },
};
