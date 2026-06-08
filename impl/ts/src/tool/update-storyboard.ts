// update_storyboard — let the model restructure the storyboard (add/remove/reorder
// scenes) in a structured way. See docs/harness-design.md §5.4. Writes
// project.storyboard, then rewrites Root.tsx so Studio hot-reloads the new deck.
// Only scenes whose component file already exists are registered in Root (a new
// scene appears once its file is written via write/edit).

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { ToolValidationError } from "./types.js";
import type { Scene } from "../projects.js";
import { rootSource } from "../remotion-source.js";

interface Args {
  scenes: Scene[];
}

function parseScenes(raw: unknown): Scene[] {
  if (!Array.isArray(raw)) {
    throw new ToolValidationError('"scenes" is required and must be an array.');
  }
  const out: Scene[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) {
      throw new ToolValidationError("Each scene must be an object.");
    }
    const o = s as Record<string, unknown>;
    const id = o.id;
    if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
      throw new ToolValidationError(`Each scene needs a PascalCase "id" (got ${JSON.stringify(id)}).`);
    }
    const durationInFrames = typeof o.durationInFrames === "number" ? o.durationInFrames : Number(o.durationInFrames);
    if (!Number.isFinite(durationInFrames) || durationInFrames <= 0) {
      throw new ToolValidationError(`Scene ${id} needs a positive "durationInFrames".`);
    }
    out.push({
      id,
      title: typeof o.title === "string" ? o.title : id,
      durationInFrames: Math.round(durationInFrames),
      narration: typeof o.narration === "string" ? o.narration : "",
      visual: typeof o.visual === "string" ? o.visual : "",
    });
  }
  if (out.length === 0) throw new ToolValidationError("Storyboard must have at least one scene.");
  const ids = new Set<string>();
  for (const s of out) {
    if (ids.has(s.id)) throw new ToolValidationError(`Duplicate scene id: ${s.id}.`);
    ids.add(s.id);
  }
  return out;
}

export const UpdateStoryboardTool: ToolDef<Args> = {
  id: "update_storyboard",
  description:
    "Replace the storyboard's scene list (add, remove, or reorder scenes) and rewrite Root.tsx so Studio reflects the new deck. Each scene: {id (PascalCase), title, durationInFrames, narration, visual}. A scene only renders once its component file exists (write it with the write tool).",
  parameters: {
    scenes: {
      type: "array",
      items: "{id, title, durationInFrames, narration, visual}",
      description: "The full ordered scene list (replaces the current one)",
      required: true,
    },
  },
  validate(args) {
    return { scenes: parseScenes(args.scenes) };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const project = ctx.store.get(ctx.projectId);
    const sb = project.storyboard;
    if (!sb) {
      return {
        title: "storyboard",
        output: "No storyboard exists yet. Generate one before updating it.",
        metadata: { error: "no_storyboard" },
      };
    }
    sb.scenes = args.scenes;
    project.updatedAt = Date.now() / 1000;

    // Register only scenes whose component file already exists, so Root.tsx
    // compiles (Studio hot-reloads). Missing files appear once written.
    const existing = args.scenes.filter((s) => {
      try {
        ctx.store.readFile(ctx.projectId, `src/scenes/${s.id}.tsx`);
        return true;
      } catch {
        return false;
      }
    });
    ctx.store.writeFile(ctx.projectId, "src/Root.tsx", rootSource(sb, existing));
    ctx.log("assemble", `Updated storyboard (${args.scenes.length} scenes)`, {
      kind: "write_file",
      path: "src/Root.tsx",
    });

    const missing = args.scenes.filter((s) => !existing.includes(s));
    const lines = args.scenes.map((s, i) => `  ${i + 1}. ${s.id} (${s.durationInFrames}f) — ${s.title}`).join("\n");
    const note = missing.length
      ? `\n\nScenes still needing a component file: ${missing.map((s) => s.id).join(", ")}.`
      : "";
    return {
      title: "storyboard",
      output: `Storyboard updated (${args.scenes.length} scenes):\n${lines}${note}`,
      metadata: { scenes: args.scenes.length, registered: existing.length },
    };
  },
};
