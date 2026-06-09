// Self-written studio — a custom @remotion/player site bundled INSIDE the sandbox.
// See docs/harness-design.md (studio/frame-error) and the approved plan.
//
// Why bundle in the sandbox (not the frontend): scene code lives in the sandbox's
// own Remotion project, not in the frontend bundle, so <Player component={...}>
// can't import it directly. We generate a tiny player entry next to the scenes,
// bundle it self-contained with esbuild (which Remotion already ships), and serve
// the static output. This replaces the old `remotion studio --port` + iframe.
//
// Hot-reload = rebuild on demand (after each scene / chat-edit / manual refresh),
// returning a version token the frontend appends as ?v= to force the iframe to
// reload. esbuild bundles a handful of small files in a few hundred ms.

import type { ProjectStore, Scene } from "./projects.js";

// The player entry: a React app that renders @remotion/player's <Player> for the
// selected scene (composition). Scene id comes from the ?scene= query param. Each
// scene is its own component (one file per scene under src/scenes/<id>.tsx).
function playerEntry(scenes: Scene[], fps: number, width: number, height: number): string {
  // Only import scenes whose component file exists (ready/error — error still
  // has a file, it just throws at runtime, which the Player error boundary shows).
  const imports = scenes.map((s) => `import { ${s.id} } from "../scenes/${s.id}";`).join("\n");
  const registry = scenes
    .map(
      (s) =>
        `  ${JSON.stringify(s.id)}: { comp: ${s.id}, durationInFrames: ${Math.max(1, s.durationInFrames)}, title: ${JSON.stringify(s.title)} }`,
    )
    .join(",\n");
  return `import React from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@remotion/player";
${imports}

const SCENES = {
${registry}
};
const FPS = ${fps};
const WIDTH = ${width};
const HEIGHT = ${height};

function pickScene() {
  const q = new URLSearchParams(window.location.search);
  const want = q.get("scene");
  if (want && SCENES[want]) return want;
  const keys = Object.keys(SCENES);
  return keys[0];
}

function App() {
  const [sceneId, setSceneId] = React.useState(pickScene());
  const entry = SCENES[sceneId];
  if (!entry) {
    return React.createElement("div", { style: { color: "#ff9bbd", padding: 16, fontFamily: "monospace" } },
      "No scene to preview yet.");
  }
  return React.createElement("div", { style: { display: "flex", flexDirection: "column", height: "100vh", background: "#050712" } },
    React.createElement("div", { style: { padding: "6px 10px", borderBottom: "1px solid rgba(124,247,255,0.22)" } },
      React.createElement("select", {
        value: sceneId,
        onChange: (e) => setSceneId(e.target.value),
        style: { background: "#10122b", color: "#eaf7ff", border: "1px solid rgba(124,247,255,0.3)", padding: "4px 8px", fontFamily: "monospace" },
      }, Object.keys(SCENES).map((id) =>
        React.createElement("option", { key: id, value: id }, id + " — " + SCENES[id].title)))),
    React.createElement("div", { style: { flex: 1, minHeight: 0, display: "grid", placeItems: "center" } },
      React.createElement(Player, {
        key: sceneId,
        component: entry.comp,
        durationInFrames: entry.durationInFrames,
        fps: FPS,
        compositionWidth: WIDTH,
        compositionHeight: HEIGHT,
        controls: true,
        autoPlay: true,
        loop: true,
        style: { width: "100%", height: "100%" },
      })));
}

const el = document.getElementById("root");
createRoot(el).render(React.createElement(App));
`;
}

function playerHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>VideoMaker Studio</title>
<style>html,body,#root{margin:0;height:100%;background:#050712;}</style></head>
<body><div id="root"></div><script src="./bundle.js"></script></body>
</html>`;
}

export interface StudioBuild {
  ok: boolean;
  version: number;
  error?: string;
}

// (Re)build the player bundle inside the sandbox. Writes the entry + html, ensures
// @remotion/player is installed, then bundles with esbuild to out/.studio/bundle.js.
// Returns a version token the frontend uses to bust the iframe cache.
export async function buildStudio(
  store: ProjectStore,
  projectId: string,
  log?: (phase: string, detail: string, extra?: Record<string, unknown>) => void,
): Promise<StudioBuild> {
  const p = store.get(projectId);
  if (!p.sandboxId) return { ok: false, version: 0, error: "no sandbox" };
  if (!p.storyboard) return { ok: false, version: 0, error: "no storyboard yet" };
  const backend = store.manager().backendFor(p.sandboxId);

  // Only include scenes whose component file exists, so the bundle compiles even
  // mid-generation (a not-yet-written scene would be an unresolved import).
  const scenes = p.storyboard.scenes.filter((s) => {
    try {
      store.readFile(projectId, `src/scenes/${s.id}.tsx`);
      return true;
    } catch {
      return false;
    }
  });
  if (scenes.length === 0) return { ok: false, version: 0, error: "no scenes written yet" };

  store.writeFile(projectId, "src/.studio/index.tsx", playerEntry(scenes, p.storyboard.fps, p.storyboard.width, p.storyboard.height));
  store.writeFile(projectId, "src/.studio/index.html", playerHtml());

  // Ensure @remotion/player is present (first build only). It's not part of the
  // blank scaffold. Idempotent — npm install is a no-op if already satisfied.
  log?.("studio", "Ensuring @remotion/player is installed", { kind: "command", command: "npm install @remotion/player" });
  const install = await backend.exec(p.sandboxId, "npm install --no-audit --no-fund @remotion/player", { timeoutS: 600 });
  if (install.exitCode !== 0) {
    return { ok: false, version: 0, error: `install @remotion/player failed: ${(install.stderr || "").slice(0, 400)}` };
  }

  // Bundle the entry self-contained with esbuild (ships with Remotion). The IIFE
  // bundle + bundled JSX keeps the served page dependency-free.
  const bundleCmd =
    `npx --no-install esbuild src/.studio/index.tsx --bundle --outfile=out/.studio/bundle.js ` +
    `--format=iife --jsx=automatic --loader:.tsx=tsx --define:process.env.NODE_ENV='"production"'`;
  log?.("studio", "Bundling player", { kind: "command", command: bundleCmd });
  const bundle = await backend.exec(p.sandboxId, bundleCmd, { timeoutS: 300 });
  if (bundle.exitCode !== 0) {
    log?.("studio", `Studio bundle failed (exit ${bundle.exitCode})`, { kind: "command_output", exitCode: bundle.exitCode, output: (bundle.stdout || "") + "\n" + (bundle.stderr || "") });
    return { ok: false, version: 0, error: (bundle.stderr || "").slice(0, 400) };
  }
  // Copy the html next to the bundle so the served dir is self-contained.
  store.writeFile(projectId, "out/.studio/index.html", playerHtml());

  const version = Date.now();
  p.studioVersion = version;
  log?.("studio", `Player bundle ready (v${version}, ${scenes.length} scenes)`, { kind: "info" });
  return { ok: true, version };
}
