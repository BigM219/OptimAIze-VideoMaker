// Per-frame render probe — see docs/harness-design.md (studio/frame-error).
// Remotion render errors are frame-dependent: interpolating a color string throws
// "... is not a supported scale, translate, or rotate value" only at frames where
// the interpolated value crosses a threshold, so rendering frame 0 alone (the old
// render_scene check) can pass while frame 60 fails. probeScene samples a handful
// of representative frames via `remotion still` (one PNG per frame, no encoder),
// fails fast on the first frame that errors, and reports WHICH frame + the stderr
// so the agent can fix the exact failure.

import type { ProjectStore } from "./projects.js";
import { capStep, type Scene } from "./projects.js";

export interface ProbeResult {
  ok: boolean;
  // Frames actually rendered (sampled), in order.
  framesTested: number[];
  // Set when ok === false: the first frame that failed + its trimmed stderr.
  failedFrame?: number;
  error?: string;
  // Relative path of the last successfully rendered PNG (for a static thumbnail).
  lastPng?: string;
}

// Choose a small, representative set of frames to probe. Frame-dependent errors
// usually surface as an interpolated value crosses its range, so we sample the
// start, quarter points, and the last frame rather than only frame 0. Capped at 5
// stills/scene to stay cheap.
export function sampleFrames(durationInFrames: number): number[] {
  const last = Math.max(0, durationInFrames - 1);
  if (last === 0) return [0];
  const raw = [0, Math.round(last * 0.25), Math.round(last * 0.5), Math.round(last * 0.75), last];
  // Dedupe + sort ascending (short scenes collapse to fewer frames).
  return [...new Set(raw)].sort((a, b) => a - b);
}

// Render one scene's composition at `frame` to a throwaway PNG. Returns the
// ExecResult-ish { exitCode, stderr } so the caller can fail-fast.
async function stillAt(
  store: ProjectStore,
  projectId: string,
  sceneId: string,
  frame: number,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const p = store.get(projectId);
  if (!p.sandboxId) throw new Error("Project has no sandbox.");
  const backend = store.manager().backendFor(p.sandboxId);
  const out = `out/.probe/${sceneId}-${frame}.png`;
  // `still` renders a single frame to PNG with no video encoder — faster than
  // `render --frames=N-N`. --scale=0.5 halves the work; a render error still
  // throws regardless of scale.
  const cmd = `npx --no-install remotion still ${sceneId} ${out} --frame=${frame} --image-format=png --scale=0.5`;
  const r = await backend.exec(p.sandboxId, cmd, { timeoutS: 120 });
  return { exitCode: r.exitCode, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

// Probe a scene across sampled frames, failing fast on the first error. Emits a
// transcript step per probe so the UI shows the command + outcome (with frame).
export async function probeScene(
  store: ProjectStore,
  projectId: string,
  scene: Scene,
  log?: (phase: string, detail: string, extra?: Record<string, unknown>) => void,
): Promise<ProbeResult> {
  const frames = sampleFrames(scene.durationInFrames);
  const tested: number[] = [];
  let lastPng: string | undefined;
  for (const frame of frames) {
    log?.("probe", `Probe ${scene.id} @ frame ${frame}`, {
      kind: "command",
      command: `remotion still ${scene.id} --frame=${frame}`,
      frame,
    });
    let r: { exitCode: number; stderr: string; stdout: string };
    try {
      r = await stillAt(store, projectId, scene.id, frame);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      log?.("probe", `Probe ${scene.id} @ frame ${frame} could not run`, {
        kind: "command_output",
        exitCode: -1,
        output: msg,
        frame,
      });
      return { ok: false, framesTested: tested, failedFrame: frame, error: capStep(msg) };
    }
    tested.push(frame);
    if (r.exitCode !== 0) {
      const combined = [r.stdout, r.stderr].filter((s) => s && s.trim() !== "").join("\n");
      log?.("probe", `Probe ${scene.id} failed at frame ${frame} (exit ${r.exitCode})`, {
        kind: "command_output",
        exitCode: r.exitCode,
        output: combined,
        frame,
      });
      return { ok: false, framesTested: tested, failedFrame: frame, error: capStep(combined) };
    }
    lastPng = `out/.probe/${scene.id}-${frame}.png`;
  }
  log?.("probe", `Probe ${scene.id} OK (${tested.length} frames)`, {
    kind: "command_output",
    exitCode: 0,
    output: `Frames ${tested.join(", ")} all rendered.`,
  });
  return { ok: true, framesTested: tested, lastPng };
}
