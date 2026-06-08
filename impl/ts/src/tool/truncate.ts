// Output truncation — see docs/harness-design.md §6.
// Bounds each tool's output so the conversation stays within context. When the
// output exceeds the cap, the full text is written to out/.harness/ (inside the
// jailed workdir) and the returned string keeps the head + a pointer line.

import type { ToolContext } from "./types.js";

export const OUTPUT_CAP = 50 * 1024; // 50 KB default tool-output cap
export const MAX_LINE_LENGTH = 2000; // per-line cap

// Truncate any single line longer than MAX_LINE_LENGTH.
export function capLines(text: string): string {
  if (!text.includes("\n") && text.length <= MAX_LINE_LENGTH) return text;
  return text
    .split("\n")
    .map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + " … (line truncated)" : l))
    .join("\n");
}

// Truncate the whole output to OUTPUT_CAP. If over, persist the full content to
// out/.harness/<tool>-<n>.txt and append a pointer line. Returns the shaped
// output plus truncated/outputPath flags for the result envelope.
export function truncateOutput(
  ctx: ToolContext,
  tool: string,
  text: string,
  cap = OUTPUT_CAP,
): { output: string; truncated: boolean; outputPath?: string } {
  const capped = capLines(text);
  if (Buffer.byteLength(capped, "utf-8") <= cap) {
    return { output: capped, truncated: false };
  }
  // Keep the head (most tool output is most useful at the top).
  const head = capped.slice(0, cap);
  let outputPath: string | undefined;
  try {
    const rel = `out/.harness/${tool}-${Date.now()}.txt`;
    ctx.store.writeFile(ctx.projectId, rel, capped);
    outputPath = rel;
  } catch {
    /* if persisting fails, still return the head */
  }
  const pointer = outputPath
    ? `\n\n(Output truncated to ${Math.round(cap / 1024)} KB. Full output saved to: ${outputPath})`
    : `\n\n(Output truncated to ${Math.round(cap / 1024)} KB.)`;
  return { output: head + pointer, truncated: true, outputPath };
}
