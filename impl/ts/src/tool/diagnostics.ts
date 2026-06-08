// Incremental diagnostics — see docs/harness-design.md §8.
// After a mutating tool (write/edit) runs, the registry can run a fast project
// type-check and splice the errors straight into that tool's output, so the
// model sees compile errors immediately instead of waiting for a render.
// Mirrors opencode's "LSP errors detected in this file" feedback loop.

import type { ToolContext } from "./types.js";

export interface Diagnostic {
  file: string; // project-relative, POSIX
  line: number;
  col: number;
  code: string; // e.g. "TS2304"
  message: string;
}

export type DiagnosticsByFile = Map<string, Diagnostic[]>;

// How many *other* files (beyond the one just edited) we surface errors for,
// matching opencode's MAX_PROJECT_DIAGNOSTICS_FILES.
export const MAX_OTHER_FILES = 5;

// tsc --noEmit emits lines like:
//   src/scenes/Intro.tsx(12,5): error TS2304: Cannot find name 'foo'.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

// Run `tsc --noEmit` in the sandbox and parse the errors by file. Returns an
// empty map on a clean build (or if tsc can't run — diagnostics are advisory,
// never fatal).
export async function typecheck(ctx: ToolContext): Promise<DiagnosticsByFile> {
  const byFile: DiagnosticsByFile = new Map();
  let r;
  try {
    r = await ctx.backend.exec(ctx.sandboxId, "npx --no-install tsc --noEmit -p tsconfig.json", {
      timeoutS: 120,
    });
  } catch {
    return byFile; // tsc unavailable → no diagnostics, don't block the loop
  }
  if (r.exitCode === 0) return byFile; // clean build

  const text = `${r.stdout}\n${r.stderr}`;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(TSC_LINE);
    if (!m) continue;
    const file = normalize(m[1]);
    const diag: Diagnostic = {
      file,
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5].trim(),
    };
    const list = byFile.get(file) ?? [];
    list.push(diag);
    byFile.set(file, list);
  }
  return byFile;
}

function block(diags: Diagnostic[]): string {
  return diags.map((d) => `  ${d.line}:${d.col} ${d.code}: ${d.message}`).join("\n");
}

// Build the text appended to a mutating tool's output: errors for the edited
// file first, then up to MAX_OTHER_FILES other files with errors. Empty string
// when the build is clean.
export function formatDiagnostics(byFile: DiagnosticsByFile, editedFile: string): string {
  if (byFile.size === 0) return "";
  const edited = normalize(editedFile);
  const parts: string[] = [];

  const own = byFile.get(edited);
  if (own && own.length > 0) {
    parts.push(`\n\ntsc errors in this file, please fix:\n${block(own)}`);
  }

  const others = [...byFile.entries()].filter(([f]) => f !== edited).slice(0, MAX_OTHER_FILES);
  if (others.length > 0) {
    const rendered = others.map(([f, diags]) => `${f}:\n${block(diags)}`).join("\n");
    parts.push(`\n\ntsc errors in other files:\n${rendered}`);
  }
  return parts.join("");
}
