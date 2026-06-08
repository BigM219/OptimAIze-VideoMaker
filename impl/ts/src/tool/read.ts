// read — read a project file or list a directory, with line numbers.
// See docs/harness-design.md §5.1. Wraps store.readFile / store.listFiles
// (already jailed). Line numbers let `edit` reference exact spans.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { optNumber, reqString, assertProjectPath } from "./validate.js";
import { truncateOutput, MAX_LINE_LENGTH } from "./truncate.js";

const DEFAULT_LIMIT = 2000;

interface Args {
  filePath: string;
  offset?: number;
  limit?: number;
}

export const ReadTool: ToolDef<Args> = {
  id: "read",
  description:
    "Read a project file (line-numbered) or list a directory. Use before editing so you can reference exact lines. Paths are relative to the project root (e.g. src/scenes/Intro.tsx).",
  parameters: {
    filePath: { type: "string", description: "Relative path to the file or directory", required: true },
    offset: { type: "number", description: "1-based line to start from (file only)" },
    limit: { type: "number", description: `Max lines to read (default ${DEFAULT_LIMIT})` },
  },
  validate(args) {
    const filePath = assertProjectPath(reqString(args, "filePath"));
    return { filePath, offset: optNumber(args, "offset"), limit: optNumber(args, "limit") };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // Directory listing first: if listFiles returns >1 entry or the path has no
    // extension, treat it as a directory.
    const entries = safeList(ctx, args.filePath);
    if (entries && (entries.length !== 1 || entries[0].path !== args.filePath || entries[0].isDir)) {
      const lines = entries
        .filter((e) => !e.path.includes("node_modules"))
        .map((e) => (e.isDir ? `${e.path}/` : e.path));
      const body = `<path>${args.filePath}</path>\n<type>directory</type>\n<entries>\n${lines.join("\n")}\n</entries>`;
      return { title: args.filePath, output: body, metadata: { entries: lines.length } };
    }

    let content: string;
    try {
      content = ctx.store.readFile(ctx.projectId, args.filePath);
    } catch {
      return { title: args.filePath, output: `File not found: ${args.filePath}`, metadata: { error: "not_found" } };
    }

    const all = content.split("\n");
    const offset = Math.max(1, args.offset ?? 1);
    const limit = args.limit ?? DEFAULT_LIMIT;
    if (offset > all.length && !(all.length === 1 && all[0] === "")) {
      return {
        title: args.filePath,
        output: `Offset ${offset} is out of range for this file (${all.length} lines).`,
        metadata: { error: "offset_range" },
      };
    }
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((line, i) => {
        const n = offset + i;
        const capped = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + " … (line truncated)" : line;
        return `${n}: ${capped}`;
      })
      .join("\n");
    const lastLine = offset - 1 + slice.length;
    const trailer =
      lastLine >= all.length
        ? `(End of file - ${all.length} lines)`
        : `(Showing lines ${offset}-${lastLine} of ${all.length}. Use offset=${lastLine + 1} to continue.)`;
    const body = `<path>${args.filePath}</path>\n<type>file</type>\n<content>\n${numbered}\n${trailer}\n</content>`;
    const shaped = truncateOutput(ctx, "read", body);
    return {
      title: args.filePath,
      output: shaped.output,
      truncated: shaped.truncated,
      outputPath: shaped.outputPath,
      metadata: { lines: all.length, offset, shown: slice.length },
    };
  },
};

function safeList(ctx: ToolContext, rel: string): Array<{ path: string; isDir: boolean }> | null {
  try {
    return ctx.store.listFiles(ctx.projectId, rel) as Array<{ path: string; isDir: boolean }>;
  } catch {
    return null;
  }
}
