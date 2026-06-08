// Shared recursive file walk over the jailed project tree, used by glob/grep.
// Reuses store.listFiles (already jailed); skips node_modules and dot-dirs.

import type { ToolContext } from "./types.js";

export interface WalkEntry {
  path: string; // POSIX-relative to project root
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|\.harness)(\/|$)/;

// Depth-first list of all files under `root` (default "."), bounded by `cap`.
export function walkFiles(ctx: ToolContext, root = ".", cap = 5000): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    if (out.length >= cap) return;
    let entries: Array<{ path: string; isDir: boolean }>;
    try {
      entries = ctx.store.listFiles(ctx.projectId, rel) as Array<{ path: string; isDir: boolean }>;
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (SKIP_DIR.test("/" + e.path)) continue;
      if (e.isDir) visit(e.path);
      else out.push(e.path);
    }
  };
  visit(root);
  return out;
}
