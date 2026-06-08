// invalid — sentinel tool the registry routes to when the model calls an unknown
// tool or supplies bad args. Echoes the error so the loop continues instead of
// crashing. See docs/harness-design.md §5.5 (opencode `invalid`).

import type { ToolDef, ToolContext, ToolResult } from "./types.js";

interface Args {
  tool?: string;
  error?: string;
}

export const InvalidTool: ToolDef<Args> = {
  id: "invalid",
  description: "Do not use.",
  parameters: {},
  validate(args) {
    return { tool: typeof args.tool === "string" ? args.tool : undefined, error: typeof args.error === "string" ? args.error : undefined };
  },
  async execute(args, _ctx: ToolContext): Promise<ToolResult> {
    const detail = args.error ?? "unknown tool or invalid arguments";
    return {
      title: "Invalid tool",
      output: `The tool call was invalid: ${detail}. Available tools are listed in the system prompt — reply with a corrected \`\`\`tool_calls\`\`\` block.`,
      metadata: { invalidTool: args.tool },
    };
  },
};
