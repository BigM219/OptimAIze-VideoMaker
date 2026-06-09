// bash — run a terminal command inside the project's caged sandbox.
// See docs/harness-design.md §5.3. Wraps backend.exec (already caged by a Job
// Object: RAM/CPU/process caps + jailed workdir), so unlike opencode there is no
// tree-sitter parse or per-command permission prompt. Output is tail-limited.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString, optNumber, optString } from "./validate.js";
import { truncateOutput } from "./truncate.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes, matching opencode's bash default

interface Args {
  command: string;
  description: string;
  timeout?: number; // milliseconds
}

export const BashTool: ToolDef<Args> = {
  id: "bash",
  description:
    "Run a terminal command inside the project sandbox (git, npm, npx, remotion, ls, etc.). The sandbox is resource-capped and jailed to the project workdir. Prefer the read/write/edit/grep/glob tools for file work; use bash for builds, installs, and running commands. Default timeout 120s.",
  parameters: {
    command: { type: "string", description: "The command to execute", required: true },
    description: { type: "string", description: "Optional short description of what this command does (for the transcript)" },
    timeout: { type: "number", description: "Optional timeout in milliseconds (default 120000)" },
  },
  validate(args) {
    const command = reqString(args, "command");
    // description is for the transcript only — don't block the tool if a model
    // omits it; fall back to a truncated form of the command itself.
    const description = optString(args, "description") || command.slice(0, 60);
    return { command, description, timeout: optNumber(args, "timeout") };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = args.timeout && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS;
    ctx.log("command", args.description, { kind: "command", command: args.command });

    const r = await ctx.backend.exec(ctx.sandboxId, args.command, {
      timeoutS: Math.ceil(timeoutMs / 1000),
    });

    const combined = [r.stdout, r.stderr].filter((s) => s && s.trim() !== "").join("\n");
    let body = combined.trim() === "" ? "(no output)" : combined;
    if (r.timedOut) {
      body +=
        `\n\n<shell_metadata>\nCommand terminated after exceeding the ${timeoutMs} ms timeout. ` +
        `If it needs longer and is not waiting for interactive input, retry with a larger timeout.\n</shell_metadata>`;
    } else if (r.killedByCap) {
      body += `\n\n<shell_metadata>\nProcess killed by the sandbox resource cap (RAM/CPU). Reduce memory use or split the work.\n</shell_metadata>`;
    }

    const shaped = truncateOutput(ctx, "bash", body, 30 * 1024);
    ctx.log("command", `exit ${r.exitCode}`, {
      kind: "command_output",
      exitCode: r.exitCode,
      output: combined,
    });
    return {
      title: args.description,
      output: shaped.output,
      truncated: shaped.truncated,
      outputPath: shaped.outputPath,
      // exit code in metadata is informational; a nonzero exit is NOT a soft
      // failure (the model often runs commands expecting nonzero), so we do not
      // set metadata.error here — the model reads the exit line in the output.
      metadata: { exit: r.exitCode, timedOut: r.timedOut, killedByCap: r.killedByCap },
    };
  },
};
