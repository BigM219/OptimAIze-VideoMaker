// read_skill_rule — load one on-demand skill rule by name.
// See docs/harness-design.md §5.4. Lets the model pull the exact best-practice
// rule it needs (e.g. interpolate, transitions) instead of always carrying the
// full SKILL.md. Wraps skills.skillRule (which jails the name to *.md).

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString } from "./validate.js";
import { skillRule, skillInfo } from "../skills.js";

interface Args {
  name: string;
}

export const ReadSkillRuleTool: ToolDef<Args> = {
  id: "read_skill_rule",
  description:
    "Load one on-demand Remotion skill rule by file name (e.g. timing.md, transitions.md) for targeted best-practice guidance. List the available rule names with no-args is not supported — the rule names are shown in the system prompt.",
  parameters: {
    name: { type: "string", description: "Rule file name, e.g. timing.md", required: true },
  },
  validate(args) {
    return { name: reqString(args, "name") };
  },
  async execute(args, _ctx: ToolContext): Promise<ToolResult> {
    // Tolerate the model omitting the .md suffix.
    const name = args.name.endsWith(".md") ? args.name : `${args.name}.md`;
    const body = skillRule(name);
    if (body === null) {
      const info = skillInfo();
      const available = info.rules.join(", ");
      return {
        title: name,
        output: `Rule "${name}" not found. Available rules: ${available || "(none)"}.`,
        metadata: { error: "not_found" },
      };
    }
    return {
      title: name,
      output: `<skill_rule name="${name}">\n${body.trim()}\n</skill_rule>`,
      metadata: { name },
    };
  },
};
