// Concept-driven director loop + code-aware chat. The headline capability:
// turn a single concept (e.g. "explain linear regression") into a complete,
// coherent multi-scene educational video, then let the user refine via chat.

import { OpenRouterClient } from "./agent/llm-client.js";
import { skillCore, skillRulesFor } from "./skills.js";
import type { ProjectStore, Storyboard, Scene } from "./projects.js";

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

const STORYBOARD_SYSTEM = `You are a video director for educational explainer videos built with Remotion.
Given a concept, produce a JSON storyboard. Reply with ONLY a fenced \`\`\`json block:
{
  "title": "string",
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "scenes": [
    {"id": "TitleScene", "title": "...", "durationInFrames": 90, "narration": "on-screen text / spoken line", "visual": "what animates"}
  ]
}
Rules: 4-6 scenes; ids are PascalCase + end with "Scene"; durations sum to roughly the requested length at the given fps; for a data/plot concept include a scene that animates the actual visual (e.g. scatter points appearing then a regression line being drawn).`;

function sceneSystem(rules: string): string {
  const core = skillCore();
  return `You write a single Remotion scene component in TypeScript. Reply with ONLY a fenced \`\`\`tsx block containing one file.
Requirements:
- Export a named React FC matching the scene id, e.g. "export const TitleScene: React.FC = () => {...}".
- Use only "react" and "remotion" imports (AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence).
- Self-contained, no external assets, no audio. Animate with interpolate/spring driven by useCurrentFrame.
- Fill the frame; large readable text; keep it visually consistent with an educational explainer.

You MUST follow these Remotion best practices (domain skill):
${core}${rules ? `\n\nRelevant rules for this scene:${rules}` : ""}`;
}

function rootSource(sb: Storyboard): string {
  const imports = sb.scenes.map((s) => `import {${s.id}} from './scenes/${s.id}';`).join("\n");
  const total = sb.scenes.reduce((n, s) => n + s.durationInFrames, 0);
  const series = sb.scenes
    .map((s) => `      <Series.Sequence durationInFrames={${s.durationInFrames}}>\n        <${s.id} />\n      </Series.Sequence>`)
    .join("\n");
  return `import React from 'react';
import {Composition, Series} from 'remotion';
${imports}

export const Video: React.FC = () => {
  return (
    <Series>
${series}
    </Series>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Video"
      component={Video}
      durationInFrames={${total}}
      fps={${sb.fps}}
      width={${sb.width}}
      height={${sb.height}}
    />
  );
};
`;
}

function indexSource(): string {
  return `import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';
registerRoot(RemotionRoot);
`;
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
  const stepLog = (phase: string, detail: string): void => {
    p.steps.push({ index: p.steps.length, timestamp: Date.now() / 1000, phase, detail });
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
    p.storyboard = sb;
    stepLog("storyboard", `${sb.scenes.length} scenes: ${sb.scenes.map((s) => s.id).join(", ")}`);

    // 2. Author each scene component.
    for (const scene of sb.scenes) {
      stepLog("scene", `Writing src/scenes/${scene.id}.tsx`);
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
        { maxTokens: 2200, temperature: 0.3 },
      );
      const code = extractTsx(resp);
      store.writeFile(projectId, `src/scenes/${scene.id}.tsx`, code);
    }

    // 3. Assemble Root + index.
    stepLog("assemble", "Writing src/Root.tsx and src/index.ts");
    store.writeFile(projectId, "src/Root.tsx", rootSource(sb));
    store.writeFile(projectId, "src/index.ts", indexSource());

    // 4. Self-check render with up to 3 autonomous repair passes.
    const backend = store.manager().backendFor(p.sandboxId);
    p.state = "rendering";
    stepLog("render", "Rendering the assembled video");
    let render = await backend.exec(p.sandboxId, "npx --no-install remotion render Video out/video.mp4", { timeoutS: 1200 });
    const MAX_REPAIRS = 3;
    for (let attempt = 1; attempt <= MAX_REPAIRS && render.exitCode !== 0; attempt++) {
      stepLog("repair", `Render failed (attempt ${attempt}/${MAX_REPAIRS}); asking the model to fix the failing file(s)`);
      const edited = await repairOnce(store, projectId, client, render.stderr + "\n" + render.stdout);
      if (edited.length === 0) {
        stepLog("repair", "Model proposed no file changes; stopping repair.");
        break;
      }
      render = await backend.exec(p.sandboxId, "npx --no-install remotion render Video out/video.mp4", { timeoutS: 1200 });
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
        content: `You fix Remotion build/render errors. Reply with ONLY a fenced \`\`\`json block: {"files":[{"path":"src/...","content":"full file"}],"note":"what you fixed"}. Rewrite only the files that need changing; provide complete file contents.`,
      },
      { role: "user", content: `Render error:\n${errorText.slice(0, 1500)}\n\nProject files:\n${fileBlock.slice(0, 12000)}` },
    ],
    { maxTokens: 2600, temperature: 0.2 },
  );
  return applyEdits(store, projectId, resp);
}

// Code-aware chat: full context (all files + requirements + goals + active file
// + history), model returns file edits, we write them (Studio hot-reloads).
export async function chatEdit(
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
