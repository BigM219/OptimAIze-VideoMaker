// Tool registry — see docs/harness-design.md §2, §4.
// Holds id → ToolDef, validates args, runs execute() through a shared wrapper
// that mirrors opencode's tool.ts: a bad-args call becomes an ok:false result
// (model is asked to rewrite) instead of throwing; exceptions are caught so one
// failing tool never crashes the agent loop; every call logs a transcript step.

import type { ToolCall, ToolCallResult, ToolContext, ToolDef } from "./types.js";
import { ToolValidationError } from "./types.js";
import { ReadTool } from "./read.js";
import { WriteTool } from "./write.js";
import { EditTool } from "./edit.js";
import { ListFilesTool } from "./list-files.js";
import { BashTool } from "./bash.js";
import { GrepTool } from "./grep.js";
import { GlobTool } from "./glob.js";
import { InvalidTool } from "./invalid.js";
import { typecheck, formatDiagnostics } from "./diagnostics.js";

// Ordered list of built-in tools. Increment D appends domain tools.
const BUILTIN: ToolDef<any>[] = [ReadTool, WriteTool, EditTool, ListFilesTool, BashTool, GrepTool, GlobTool];

export class ToolRegistry {
  private tools = new Map<string, ToolDef<any>>();

  constructor(extra: ToolDef<any>[] = []) {
    for (const t of [...BUILTIN, ...extra]) this.tools.set(t.id, t);
  }

  ids(): string[] {
    return [...this.tools.keys()];
  }

  // Run one tool call through the shared wrapper. Never throws — always returns
  // a ToolCallResult the director can render back to the model.
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolCallResult> {
    const def = this.tools.get(call.tool);
    if (!def) {
      const r = await InvalidTool.execute(
        { tool: call.tool, error: `unknown tool "${call.tool}"` },
        ctx,
      );
      return { tool: call.tool, ok: false, output: r.output, title: r.title };
    }

    let validated: unknown;
    try {
      validated = def.validate(call.args ?? {});
    } catch (e) {
      const detail = e instanceof ToolValidationError ? e.message : String((e as Error).message ?? e);
      ctx.log("tool", `${call.tool}: invalid args — ${detail}`, { kind: "error" });
      return {
        tool: call.tool,
        ok: false,
        output: `The ${call.tool} tool was called with invalid arguments: ${detail}\nRewrite the input so it satisfies the parameters.`,
      };
    }

    try {
      const result = await def.execute(validated, ctx);
      // A tool may report a soft failure (operation didn't apply) by setting
      // metadata.error instead of throwing — surface it as ok:false so the
      // model knows to retry, while still showing the explanatory output.
      const softFail = typeof result.metadata?.error === "string";
      return {
        tool: call.tool,
        ok: !softFail,
        output: result.output,
        title: result.title,
        metadata: result.metadata,
        truncated: result.truncated,
        outputPath: result.outputPath,
      };
    } catch (e) {
      const detail = String((e as Error).message ?? e);
      ctx.log("tool", `${call.tool}: failed — ${detail}`, { kind: "error" });
      return { tool: call.tool, ok: false, output: `Tool ${call.tool} failed: ${detail}` };
    }
  }

  // True if the named tool mutates files (write/edit). The director uses this to
  // decide whether a diagnostics pass is worth running after a turn.
  isMutating(toolId: string): boolean {
    return this.tools.get(toolId)?.mutating === true;
  }

  // Run one project type-check and append the errors to the matching mutating
  // tool results, so the model sees compile errors in the same turn it edited —
  // see docs/harness-design.md §8. Runs at most once per turn (tsc is costly),
  // only when a mutating call actually succeeded. Mutates `results` in place.
  async appendDiagnostics(results: ToolCallResult[], ctx: ToolContext): Promise<void> {
    const mutated = results.filter((r) => r.ok && this.isMutating(r.tool));
    if (mutated.length === 0) return;
    const byFile = await typecheck(ctx);
    if (byFile.size === 0) return;
    for (const r of mutated) {
      const edited = typeof r.metadata?.filePath === "string" ? r.metadata.filePath : "";
      const text = formatDiagnostics(byFile, edited);
      if (text) r.output += text;
    }
  }

  // Render the tool catalog for the system prompt: id, description, params.
  renderDocs(): string {
    const blocks: string[] = [];
    for (const t of this.tools.values()) {
      const params = Object.entries(t.parameters)
        .map(([name, spec]) => {
          const req = spec.required ? " (required)" : "";
          const items = spec.items ? ` of ${spec.items}` : "";
          return `    - ${name}: ${spec.type}${items}${req} — ${spec.description}`;
        })
        .join("\n");
      blocks.push(`- ${t.id}: ${t.description}${params ? "\n" + params : ""}`);
    }
    return blocks.join("\n");
  }
}
