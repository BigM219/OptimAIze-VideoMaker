// Concept-driven director loop + code-aware chat. The headline capability:
// turn a single concept (e.g. "explain linear regression") into a complete,
// coherent multi-scene educational video, then let the user refine via chat.

import { OpenRouterClient } from "./agent/llm-client.js";
import { skillCore, skillRulesFor, skillInfo } from "./skills.js";
import { capStep, type ProjectStore, type Storyboard, type Scene, type ProjectStep } from "./projects.js";
import type { ExecResult } from "./types.js";
import { rootSource, indexSource } from "./remotion-source.js";
import { runAgent } from "./tool/agent-loop.js";
import { buildStudio } from "./studio.js";
import { probeScene, type ProbeResult } from "./probe.js";

function extractJson(text: string): string | null {
  const parts = text.split("```");
  for (let i = 1; i < parts.length; i += 2) {
    let chunk = parts[i].trimStart();
    if (/^json/i.test(chunk)) chunk = chunk.slice(4);
    chunk = chunk.trim();
    if (chunk.startsWith("{") || chunk.startsWith("[")) return chunk;
  }
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s !== -1 && e > s) return text.slice(s, e + 1);
  return null;
}

// Append a progress step to a project (module-level so the repair loop and the
// generate loop share one timeline the UI polls).
function pushStep(p: { steps: ProjectStep[]; updatedAt: number }, phase: string, detail: string, extra: Partial<ProjectStep> = {}): void {
  p.steps.push({
    index: p.steps.length,
    timestamp: Date.now() / 1000,
    phase,
    detail,
    ...extra,
    content: capStep(extra.content),
    output: capStep(extra.output),
  });
  p.updatedAt = Date.now() / 1000;
}

const STORYBOARD_SYSTEM = `Plan an educational explainer video. Reply with ONLY a fenced \`\`\`json block in this shape:
{
  "title": "string", "fps": 30, "width": 1920, "height": 1080,
  "scenes": [
    {"id": "TitleScene", "title": "...", "durationInFrames": 90, "narration": "on-screen / spoken line", "visual": "what animates"}
  ]
}
Scene ids are PascalCase ending in "Scene"; durations sum to roughly the requested length at the given fps.

Follow this skill:
${skillCore()}`;

function sceneSystem(rules: string): string {
  const core = skillCore();
  // The domain knowledge (how to write good Remotion) lives in the skill, not
  // here. Keep only the mechanical output contract the parser depends on.
  return `Write one Remotion scene component in TypeScript. Reply with ONLY a fenced \`\`\`tsx block containing the single complete file. Export a named React FC whose name matches the scene id.

Follow this skill:
${core}${rules ? `\n\nRelevant rules for this scene:${rules}` : ""}`;
}

function extractTsx(text: string): string {
  const parts = text.split("```");
  for (let i = 1; i < parts.length; i += 2) {
    let chunk = parts[i].trimStart();
    if (/^(tsx|typescript|ts|jsx)/i.test(chunk)) chunk = chunk.replace(/^\w+/, "");
    chunk = chunk.trim();
    if (chunk.includes("export const") || chunk.includes("import")) return chunk;
  }
  return text.trim();
}

// Run the full director loop on a project. Mutates project state/steps.
export async function generateConcept(
  store: ProjectStore,
  projectId: string,
  concept: string,
  audience: string,
  durationS: number,
): Promise<void> {
  const p = store.get(projectId);
  if (!p.sandboxId) throw new Error("Project has no sandbox.");
  const client = new OpenRouterClient();
  p.state = "generating";
  const stepLog = (phase: string, detail: string, extra: Partial<import("./projects.js").ProjectStep> = {}): void => {
    p.steps.push({
      index: p.steps.length,
      timestamp: Date.now() / 1000,
      phase,
      detail,
      ...extra,
      content: capStep(extra.content),
      output: capStep(extra.output),
    });
    p.updatedAt = Date.now() / 1000;
  };

  try {
    // 1. Outline / storyboard.
    stepLog("outline", `Planning storyboard for: ${concept}`);
    const fps = 30;
    const targetFrames = Math.max(fps * 8, Math.round(durationS * fps));
    const outlineResp = await client.chat(
      [
        { role: "system", content: STORYBOARD_SYSTEM },
        { role: "user", content: `Concept: ${concept}\nAudience: ${audience || "beginners"}\nTarget length: ~${durationS}s at ${fps}fps (~${targetFrames} frames total). Produce the storyboard.` },
      ],
      { maxTokens: 1500, temperature: 0.4 },
    );
    const sbJson = extractJson(outlineResp);
    if (!sbJson) throw new Error("Director did not return a storyboard JSON.");
    const sb = JSON.parse(sbJson) as Storyboard;
    sb.fps = sb.fps || fps;
    sb.width = sb.width || 1920;
    sb.height = sb.height || 1080;
    if (!Array.isArray(sb.scenes) || sb.scenes.length === 0) throw new Error("Storyboard has no scenes.");
    for (const s of sb.scenes) s.status = "pending";
    p.storyboard = sb;
    stepLog("storyboard", `Storyboard: ${sb.title} — ${sb.scenes.length} scenes`, {
      kind: "plan",
      content: sb.scenes.map((s, i) => `${i + 1}. ${s.id} (${s.durationInFrames}f) — ${s.title}\n   ${s.narration}`).join("\n"),
    });

    // Our self-written studio bundles a @remotion/player site from the scenes
    // written so far. Start with an empty Root; after each scene probes clean we
    // rebuild the player bundle so the new slide appears (hot-reload via ?v=).
    const backend = store.manager().backendFor(p.sandboxId);
    store.writeFile(projectId, "src/index.ts", indexSource());
    store.writeFile(projectId, "src/Root.tsx", rootSource(sb, []));

    // 2. Author each scene component. After writing each one, register the
    //    scenes-written-so-far in Root so Studio hot-reloads and that slide
    //    becomes reviewable live — no per-scene mp4, the slide IS the code.
    const written: Scene[] = [];
    for (const scene of sb.scenes) {
      scene.status = "writing";
      p.updatedAt = Date.now() / 1000;
      // Pull in the best-practice rules relevant to this scene's visual/title.
      const rules = skillRulesFor(`${scene.title} ${scene.visual} ${scene.narration}`);
      const resp = await client.chat(
        [
          { role: "system", content: sceneSystem(rules) },
          {
            role: "user",
            content:
              `Storyboard title: ${sb.title}\nConcept: ${concept}\nAudience: ${audience || "beginners"}\n\n` +
              `Write the scene component "${scene.id}".\nTitle: ${scene.title}\nDuration: ${scene.durationInFrames} frames at ${sb.fps}fps.\nNarration/on-screen: ${scene.narration}\nVisual: ${scene.visual}\n\n` +
              `It is one of ${sb.scenes.length} scenes (${sb.scenes.map((s) => s.id).join(", ")}); keep the style consistent.`,
          },
        ],
        { maxTokens: 4000, temperature: 0.3 },
      );
      const code = extractTsx(resp);
      store.writeFile(projectId, `src/scenes/${scene.id}.tsx`, code);
      stepLog("scene", `Wrote src/scenes/${scene.id}.tsx`, { kind: "write_file", path: `src/scenes/${scene.id}.tsx`, content: code });
      // Register this slide in Studio (hot-reload shows it immediately).
      written.push(scene);
      store.writeFile(projectId, "src/Root.tsx", rootSource(sb, written));

      // Per-frame probe: render a handful of sampled frames as stills to catch
      // frame-dependent errors (e.g. interpolate() on a color) that only surface
      // past frame 0. On failure, run a scene-scoped repair right away — feed the
      // exact failing frame + stderr back to the model — instead of waiting for
      // the final full-video render to discover it.
      const probe = await probeScene(store, projectId, scene, (phase, detail, extra) => stepLog(phase, detail, extra));
      if (probe.ok) {
        scene.status = "ready";
      } else {
        scene.status = "error";
        scene.renderError = `frame ${probe.failedFrame}: ${probe.error ?? "render failed"}`;
        const fixed = await repairScene(store, projectId, client, scene, probe);
        scene.status = fixed ? "ready" : "error";
        if (fixed) scene.renderError = undefined;
      }
      // Rebuild the self-written player bundle so this slide shows up live.
      if (scene.status === "ready") {
        try {
          await buildStudio(store, projectId, (phase, detail, extra) => stepLog(phase, detail, extra));
        } catch (e) {
          stepLog("studio", `Studio rebuild deferred: ${String((e as Error).message ?? e)}`, { kind: "info" });
        }
      }
      p.updatedAt = Date.now() / 1000;
    }

    // 3. Final Root with every scene + the combined Video composition.
    const rootCode = rootSource(sb);
    store.writeFile(projectId, "src/Root.tsx", rootCode);
    stepLog("assemble", "Wrote src/Root.tsx", { kind: "write_file", path: "src/Root.tsx", content: rootCode });

    // 4. Self-check render, then an agentic repair loop: keep feeding the build
    //    error back to the model (with full project + running history) and keep
    //    fixing until it renders or we hit a hard ceiling — the way Claude /
    //    Codex / Antigravity iterate on their own errors instead of giving up.
    p.state = "rendering";
    const renderCmd = "npx --no-install remotion render Video out/video.mp4";
    stepLog("render", renderCmd, { kind: "command", command: renderCmd });
    let render = await backend.exec(p.sandboxId, renderCmd, { timeoutS: 1200 });
    stepLog("render", `Render exited ${render.exitCode}`, { kind: "command_output", exitCode: render.exitCode, output: render.stdout + "\n" + render.stderr });

    if (render.exitCode !== 0) {
      const ok = await repairLoop(store, projectId, client, backend, () =>
        backend.exec(p.sandboxId!, "npx --no-install remotion render Video out/video.mp4", { timeoutS: 1200 }),
        render,
      );
      if (ok) render = ok;
    }
    if (render.exitCode !== 0) throw new Error(`render failed after repair: ${render.stderr.slice(0, 400)}`);

    p.exportPath = "out/video.mp4";
    p.state = "ready";
    stepLog("done", "Concept video rendered to out/video.mp4");
  } catch (e) {
    p.state = "failed";
    p.error = String((e as Error).message ?? e);
    stepLog("error", p.error);
  }
}

// Agentic repair: a stateful conversation. The model sees the build error and
// all source on each turn, rewrites files, we re-render, and feed the new error
// back — repeating until the render passes, the model stops proposing changes
// across consecutive turns, or a hard ceiling is reached. Returns the successful
// ExecResult, or null if it never recovers.
const MAX_REPAIR_TURNS = 8;
async function repairLoop(
  store: ProjectStore,
  projectId: string,
  client: OpenRouterClient,
  _backend: unknown,
  rerender: () => Promise<ExecResult>,
  firstFail: ExecResult,
): Promise<ExecResult | null> {
  const p = store.get(projectId);
  const messages: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content:
        `You are a Remotion build-fixer working iteratively, like a coding agent. ` +
        `Each turn you receive the latest build/render error and the full project source. ` +
        `Diagnose the actual cause (often a truncated/unclosed file, a bad import, a type error, ` +
        `or a Remotion runtime misuse such as interpolating a color string with interpolate()), ` +
        `then reply with ONLY a fenced \`\`\`json block: {"files":[{"path":"src/...","content":"COMPLETE file content"}],"note":"what you changed"}. ` +
        `Always return whole files, never fragments. If a file looks truncated, rewrite it complete.\n\n` +
        `Follow these Remotion best practices (the same rules the scenes were written against):\n${skillCore()}`,
    },
  ];
  let lastErr = firstFail.stderr + "\n" + firstFail.stdout;
  let noChangeStreak = 0;

  for (let turn = 1; turn <= MAX_REPAIR_TURNS; turn++) {
    pushStep(p, "repair", `Diagnosing render error (turn ${turn}/${MAX_REPAIR_TURNS})`, { kind: "repair" });
    const fileBlock = Object.entries(collect(store, projectId))
      .map(([path, content]) => `// FILE: ${path}\n${content}`)
      .join("\n\n");
    messages.push({
      role: "user",
      content: `Build error:\n${lastErr.slice(0, 2000)}\n\nProject files:\n${fileBlock.slice(0, 16000)}`,
    });
    const resp = await client.chat(trimRepair(messages), { maxTokens: 3000, temperature: 0.2 });
    messages.push({ role: "assistant", content: resp });
    const { edited, note } = applyEditsWithNote(store, projectId, resp);
    if (edited.length === 0) {
      noChangeStreak += 1;
      pushStep(p, "repair", "Model proposed no file changes this turn.", { kind: "repair" });
      if (noChangeStreak >= 2) {
        pushStep(p, "repair", "No progress for 2 turns; stopping repair.", { kind: "repair" });
        return null;
      }
      continue;
    }
    noChangeStreak = 0;
    pushStep(p, "repair", note || `Rewrote ${edited.join(", ")}`, { kind: "write_file", path: edited[0], content: note });
    const r = await rerender();
    pushStep(p, "repair", `Re-render exited ${r.exitCode}`, { kind: "command_output", exitCode: r.exitCode, output: r.stdout + "\n" + r.stderr });
    if (r.exitCode === 0) {
      pushStep(p, "repair", `Fixed after ${turn} turn(s).`, { kind: "info" });
      return r;
    }
    lastErr = r.stderr + "\n" + r.stdout;
  }
  return null;
}

// Scene-scoped repair: when a per-frame probe fails, fix that scene right away by
// feeding the failing frame + stderr to the model and re-probing — reusing the
// generic repairLoop with a probe-shaped rerender closure. Returns true once the
// scene probes clean, false if it never recovers within the ceiling.
async function repairScene(
  store: ProjectStore,
  projectId: string,
  client: OpenRouterClient,
  scene: Scene,
  firstProbe: ProbeResult,
): Promise<boolean> {
  // Adapt probeScene to the ExecResult shape repairLoop's rerender expects:
  // exitCode 0 when the scene probes clean, 1 with the failing frame + stderr.
  const p = store.get(projectId);
  const probeAsExec = async (): Promise<ExecResult> => {
    const r = await probeScene(store, projectId, scene, (phase, detail, extra) => pushStep(p, phase, detail, extra));
    if (r.ok) return { exitCode: 0, stdout: "", stderr: "", durationS: 0, timedOut: false, killedByCap: false };
    return {
      exitCode: 1,
      stdout: "",
      stderr: `frame ${r.failedFrame}: ${r.error ?? "render failed"}`,
      durationS: 0,
      timedOut: false,
      killedByCap: false,
    };
  };
  const seed: ExecResult = {
    exitCode: 1,
    stdout: "",
    stderr: `frame ${firstProbe.failedFrame}: ${firstProbe.error ?? "render failed"}`,
    durationS: 0,
    timedOut: false,
    killedByCap: false,
  };
  const ok = await repairLoop(store, projectId, client, null, probeAsExec, seed);
  return ok !== null;
}

// Keep the repair conversation bounded: system + the last few turns (each turn's
// user message already carries the full latest source, so old turns are stale).
function trimRepair(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  if (messages.length <= 5) return messages;
  return [messages[0], ...messages.slice(-4)];
}

// One repair pass: give the model the build error + all source, let it rewrite
// files. Returns the list of files it changed (empty if it proposed nothing).
async function repairOnce(store: ProjectStore, projectId: string, client: OpenRouterClient, errorText: string): Promise<string[]> {
  const files = collect(store, projectId);
  const fileBlock = Object.entries(files)
    .map(([path, content]) => `// FILE: ${path}\n${content}`)
    .join("\n\n");
  const resp = await client.chat(
    [
      {
        role: "system",
        content: `You fix Remotion build/render errors. Reply with ONLY a fenced \`\`\`json block: {"files":[{"path":"src/...","content":"full file"}],"note":"what you fixed"}. Rewrite only the files that need changing; provide complete file contents.\n\nFollow these Remotion best practices:\n${skillCore()}`,
      },
      { role: "user", content: `Render error:\n${errorText.slice(0, 1500)}\n\nProject files:\n${fileBlock.slice(0, 12000)}` },
    ],
    { maxTokens: 2600, temperature: 0.2 },
  );
  return applyEdits(store, projectId, resp);
}

// Code-aware chat: full context (all files + requirements + goals + active file
// + history), model returns file edits, we write them (Studio hot-reloads).
// Code-aware chat now runs the agentic tool loop (Increment E): the model
// reads/greps/edits/render-checks step by step instead of rewriting whole files
// in one shot. Falls back to the old single-shot applyEdits path if the project
// has no sandbox (can't run tools) or the loop produces nothing usable.
export async function chatEdit(
  store: ProjectStore,
  projectId: string,
  message: string,
  activeFile: string,
): Promise<{ note: string; edited: string[] }> {
  const p = store.get(projectId);
  const client = new OpenRouterClient();

  if (!p.sandboxId) return chatEditLegacy(store, projectId, message, activeFile);

  const backend = store.manager().backendFor(p.sandboxId);
  const storyboardLine = p.storyboard
    ? `Storyboard scenes: ${JSON.stringify(p.storyboard.scenes.map((s) => ({ id: s.id, title: s.title })))}\n`
    : "";
  // List the on-demand skill rules so the model knows what it can pull via
  // read_skill_rule (it carries only the always-on core by default).
  const rules = skillInfo().rules;
  const ruleLine = rules.length
    ? `On-demand skill rules (load with read_skill_rule when relevant): ${rules.join(", ")}\n`
    : "";
  const systemPrompt =
    `You are a Remotion coding assistant editing an existing video project with tools. ` +
    `Make the smallest coherent change that satisfies the user, keeping the whole project consistent.\n\n` +
    `Project goal: ${p.goals || p.prompt}\n` +
    `Requirements: ${p.requirements || "(none)"}\n` +
    storyboardLine +
    ruleLine +
    `Active file: ${activeFile || "(none)"}\n\n` +
    `Follow these Remotion best practices:\n${skillCore()}`;

  const edited: string[] = [];
  try {
    const result = await runAgent({
      store,
      projectId,
      backend,
      sandboxId: p.sandboxId,
      client,
      systemPrompt,
      userGoal: message,
      log: (phase, detail, extra) => pushStep(p, phase, detail, extra),
      maxTurns: 10,
    });
    edited.push(...result.edited);
    const note = result.summary || (edited.length ? `Edited ${edited.join(", ")}.` : "No changes made.");
    p.chat.push({ role: "user", content: message });
    p.chat.push({ role: "assistant", content: note });
    p.updatedAt = Date.now() / 1000;
    return { note, edited };
  } catch (e) {
    pushStep(p, "error", `Agent loop failed, falling back: ${String((e as Error).message ?? e)}`, { kind: "error" });
    return chatEditLegacy(store, projectId, message, activeFile);
  }
}

// Legacy single-shot chat edit (pre-harness). Kept as a fallback for the
// no-sandbox case and if the agent loop errors out, so chat never hard-fails.
async function chatEditLegacy(
  store: ProjectStore,
  projectId: string,
  message: string,
  activeFile: string,
): Promise<{ note: string; edited: string[] }> {
  const p = store.get(projectId);
  const client = new OpenRouterClient();
  const files = collect(store, projectId);
  const fileBlock = Object.entries(files)
    .map(([path, content]) => `// FILE: ${path}\n${content}`)
    .join("\n\n");
  const ctx =
    `Project goal: ${p.goals || p.prompt}\n` +
    `Requirements: ${p.requirements || "(none)"}\n` +
    (p.storyboard ? `Storyboard: ${JSON.stringify(p.storyboard.scenes.map((s) => ({ id: s.id, title: s.title })))}\n` : "") +
    `Active file: ${activeFile || "(none)"}\n\n` +
    `All project files:\n${fileBlock.slice(0, 14000)}`;

  const history = p.chat.slice(-6);
  const resp = await client.chat(
    [
      {
        role: "system",
        content: `You are a Remotion coding assistant editing a video project. You see ALL project files, the goal, requirements, and storyboard — keep edits coherent with the whole project, not just the active file. Reply with ONLY a fenced \`\`\`json block: {"files":[{"path":"src/...","content":"full file content"}],"note":"one-sentence explanation"}.\n\nFollow these Remotion best practices:\n${skillCore()}`,
      },
      ...history,
      { role: "user", content: `${ctx}\n\nUser request: ${message}` },
    ],
    { maxTokens: 2600, temperature: 0.3 },
  );
  const edited = applyEdits(store, projectId, resp);
  const note = noteOf(resp);
  p.chat.push({ role: "user", content: message });
  p.chat.push({ role: "assistant", content: note });
  p.updatedAt = Date.now() / 1000;
  return { note, edited };
}

function collect(store: ProjectStore, projectId: string): Record<string, string> {
  // Reuse the store's private collector via the public file ops.
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    let entries: Array<{ path: string; isDir: boolean }> = [];
    try {
      entries = store.listFiles(projectId, rel) as Array<{ path: string; isDir: boolean }>;
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDir) {
        if (!e.path.includes("node_modules")) walk(e.path);
      } else if (/\.(tsx?|css|json)$/.test(e.path) && !e.path.includes("node_modules")) {
        try {
          out[e.path] = store.readFile(projectId, e.path);
        } catch {
          /* skip */
        }
      }
    }
  };
  walk("src");
  return out;
}

function applyEdits(store: ProjectStore, projectId: string, resp: string): string[] {
  const json = extractJson(resp);
  if (!json) return [];
  let parsed: { files?: Array<{ path: string; content: string }> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const edited: string[] = [];
  for (const f of parsed.files ?? []) {
    if (f.path && typeof f.content === "string" && f.path.startsWith("src/")) {
      try {
        store.writeFile(projectId, f.path, f.content);
        edited.push(f.path);
      } catch {
        /* jail rejects bad paths */
      }
    }
  }
  return edited;
}

// Like applyEdits, but also surfaces the model's "note" so the transcript can
// show what the repair turn changed (coding-agent style).
function applyEditsWithNote(store: ProjectStore, projectId: string, resp: string): { edited: string[]; note: string } {
  const json = extractJson(resp);
  if (!json) return { edited: [], note: "" };
  let parsed: { files?: Array<{ path: string; content: string }>; note?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    return { edited: [], note: "" };
  }
  const edited: string[] = [];
  for (const f of parsed.files ?? []) {
    if (f.path && typeof f.content === "string" && f.path.startsWith("src/")) {
      try {
        store.writeFile(projectId, f.path, f.content);
        edited.push(f.path);
      } catch {
        /* jail rejects bad paths */
      }
    }
  }
  return { edited, note: typeof parsed.note === "string" ? parsed.note : "" };
}

function noteOf(resp: string): string {
  const json = extractJson(resp);
  if (json) {
    try {
      const o = JSON.parse(json) as { note?: string };
      if (o.note) return o.note;
    } catch {
      /* ignore */
    }
  }
  return "Applied edits.";
}
