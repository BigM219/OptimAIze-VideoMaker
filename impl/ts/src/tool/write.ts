// write — create or overwrite a project file.
// See docs/harness-design.md §5.1. Wraps store.writeFile (already jailed).
// Incremental diagnostics (Increment C) are appended by the caller, not here.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, assertProjectPath } from "./validate.js";

interface Args {
  filePath: string;
  content: string;
}

export const WriteTool: ToolDef<Args> = {
  id: "write",
  mutating: true,
  description:
    "Create or overwrite a project file with the given content. Path must be under src/, public/, or out/. Prefer `edit` for small changes to an existing file — write sends the whole file.",
  parameters: {
    filePath: { type: "string", description: "Relative path to write (e.g. src/scenes/Intro.tsx)", required: true },
    content: { type: "string", description: "Full file content", required: true },
  },
  validate(args) {
    const filePath = assertProjectPath(reqString(args, "filePath"));
    const content = typeof args.content === "string" ? args.content : "";
    if (typeof args.content !== "string") {
      // content may legitimately be an empty string, so only reject non-strings.
      throw new Error('"content" is required and must be a string.');
    }
    return { filePath, content };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let existed = false;
    try {
      ctx.store.readFile(ctx.projectId, args.filePath);
      existed = true;
    } catch {
      existed = false;
    }
    ctx.store.writeFile(ctx.projectId, args.filePath, args.content);
    ctx.log("scene", `Wrote ${args.filePath}`, {
      kind: "write_file",
      path: args.filePath,
      content: args.content,
    });
    return {
      title: args.filePath,
      output: `Wrote file successfully (${args.content.length} chars).`,
      metadata: { filePath: args.filePath, exists: existed },
    };
  },
};
