// render_scene — render one scene's composition to surface runtime errors early.
// See docs/harness-design.md §5.4. Each scene is its own Remotion <Composition>
// (id === scene id), so we can render just that one with `remotion render <id>`
// without building the whole video. This is where errors like interpolate()ing a
// color string show up — the model reads stderr and fixes the scene.

import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { reqString } from "./validate.js";
import { truncateOutput } from "./truncate.js";

interface Args {
  sceneId: string;
}

export const RenderSceneTool: ToolDef<Args> = {
  id: "render_scene",
  description:
    "Render a single scene's composition to a probe file to check it actually renders (catches runtime errors like interpolating a color with interpolate()). Pass the scene id (PascalCase, matching the composition). Returns OK or the render error to fix.",
  parameters: {
    sceneId: { type: "string", description: "Scene/composition id, e.g. TitleScene", required: true },
  },
  validate(args) {
    const sceneId = reqString(args, "sceneId");
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(sceneId)) {
      throw new Error(`"sceneId" must be a PascalCase identifier (got "${sceneId}").`);
    }
    return { sceneId };
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const out = `out/.probe/${args.sceneId}.mp4`;
    const cmd = `npx --no-install remotion render ${args.sceneId} ${out} --frames=0-0`;
    ctx.log("command", `Render-check ${args.sceneId}`, { kind: "command", command: cmd });
    const r = await ctx.backend.exec(ctx.sandboxId, cmd, { timeoutS: 300 });
    const combined = [r.stdout, r.stderr].filter((s) => s && s.trim() !== "").join("\n");

    if (r.exitCode === 0) {
      ctx.log("command", `${args.sceneId} renders OK`, { kind: "command_output", exitCode: 0, output: combined });
      return {
        title: args.sceneId,
        output: `Scene ${args.sceneId} rendered OK.`,
        metadata: { sceneId: args.sceneId, ok: true },
      };
    }

    ctx.log("command", `${args.sceneId} render failed`, {
      kind: "command_output",
      exitCode: r.exitCode,
      output: combined,
    });
    const shaped = truncateOutput(ctx, "render_scene", combined || "(no output)", 16 * 1024);
    return {
      title: args.sceneId,
      output: `Scene ${args.sceneId} failed to render:\n${shaped.output}`,
      truncated: shaped.truncated,
      outputPath: shaped.outputPath,
      // soft failure: the model should fix the scene and re-render.
      metadata: { sceneId: args.sceneId, error: "render_failed", exit: r.exitCode },
    };
  },
};
