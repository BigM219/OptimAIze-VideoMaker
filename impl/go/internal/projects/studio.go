// Self-written studio (Go parity of impl/ts/src/studio.ts).
// Scene code lives in the sandbox's own Remotion project, not the frontend
// bundle, so <Player component={...}> can't import it directly. We generate a
// tiny @remotion/player entry next to the scenes, bundle it self-contained with
// esbuild (which Remotion ships), and serve the static output. This replaces the
// old `remotion studio --port` + iframe. Rebuild on demand returns a version
// token the frontend appends as ?v= to force the iframe to reload.
package projects

import (
	"fmt"
	"strings"
	"time"
)

// StudioBuild mirrors the TS StudioBuild shape.
type StudioBuild struct {
	OK      bool   `json:"ok"`
	Version int64  `json:"version"`
	Error   string `json:"error,omitempty"`
}

// playerEntry builds the React entry that renders @remotion/player for the
// selected scene (composition), picked from the ?scene= query param.
func playerEntry(scenes []Scene, fps, width, height int) string {
	var imports, registry strings.Builder
	for _, s := range scenes {
		imports.WriteString(fmt.Sprintf("import { %s } from \"../scenes/%s\";\n", s.ID, s.ID))
		dur := s.DurationInFrames
		if dur < 1 {
			dur = 1
		}
		registry.WriteString(fmt.Sprintf("  %q: { comp: %s, durationInFrames: %d, title: %q },\n", s.ID, s.ID, dur, s.Title))
	}
	return fmt.Sprintf(`import React from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@remotion/player";
%s
const SCENES = {
%s};
const FPS = %d;
const WIDTH = %d;
const HEIGHT = %d;

function pickScene() {
  const q = new URLSearchParams(window.location.search);
  const want = q.get("scene");
  if (want && SCENES[want]) return want;
  return Object.keys(SCENES)[0];
}

function App() {
  const [sceneId, setSceneId] = React.useState(pickScene());
  const entry = SCENES[sceneId];
  if (!entry) {
    return React.createElement("div", { style: { color: "#ff9bbd", padding: 16, fontFamily: "monospace" } }, "No scene to preview yet.");
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
        style: { width: "100%%", height: "100%%" },
      })));
}

const el = document.getElementById("root");
createRoot(el).render(React.createElement(App));
`, imports.String(), registry.String(), fps, width, height)
}

func playerHTML() string {
	return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>VideoMaker Studio</title>
<style>html,body,#root{margin:0;height:100%;background:#050712;}</style></head>
<body><div id="root"></div><script src="./bundle.js"></script></body>
</html>`
}

// BuildStudio (re)builds the player bundle inside the sandbox and returns a
// version token the frontend uses to bust the iframe cache.
func (s *Store) BuildStudio(pid string) (StudioBuild, error) {
	p, ok := s.Get(pid)
	if !ok || p.SandboxID == "" {
		return StudioBuild{OK: false, Error: "no sandbox"}, nil
	}
	if p.Storyboard == nil {
		return StudioBuild{OK: false, Error: "no storyboard yet"}, nil
	}
	backend := s.mgr.Backend()

	// Only include scenes whose component file exists, so the bundle compiles even
	// mid-generation (a not-yet-written scene would be an unresolved import).
	var scenes []Scene
	for _, sc := range p.Storyboard.Scenes {
		if _, err := s.ReadFile(pid, "src/scenes/"+sc.ID+".tsx"); err == nil {
			scenes = append(scenes, sc)
		}
	}
	if len(scenes) == 0 {
		return StudioBuild{OK: false, Error: "no scenes written yet"}, nil
	}

	_ = s.WriteFile(pid, "src/.studio/index.tsx", playerEntry(scenes, p.Storyboard.FPS, p.Storyboard.Width, p.Storyboard.Height))
	_ = s.WriteFile(pid, "src/.studio/index.html", playerHTML())

	// Ensure @remotion/player is present (first build only). Idempotent.
	s.stepRich(p, Step{Phase: "studio", Kind: "command", Detail: "Ensuring @remotion/player is installed", Command: "npm install @remotion/player"})
	install, _ := backend.Exec(p.SandboxID, "npm install --no-audit --no-fund @remotion/player", "", nil, 600)
	if install.ExitCode != 0 {
		return StudioBuild{OK: false, Error: "install @remotion/player failed: " + trim(install.Stderr, 400)}, nil
	}

	bundleCmd := "npx --no-install esbuild src/.studio/index.tsx --bundle --outfile=out/.studio/bundle.js " +
		"--format=iife --jsx=automatic --loader:.tsx=tsx --define:process.env.NODE_ENV='\"production\"'"
	s.stepRich(p, Step{Phase: "studio", Kind: "command", Detail: "Bundling player", Command: bundleCmd})
	bundle, _ := backend.Exec(p.SandboxID, bundleCmd, "", nil, 300)
	if bundle.ExitCode != 0 {
		ec := bundle.ExitCode
		s.stepRich(p, Step{Phase: "studio", Kind: "command_output", ExitCode: &ec,
			Detail: fmt.Sprintf("Studio bundle failed (exit %d)", bundle.ExitCode), Output: bundle.Stdout + "\n" + bundle.Stderr})
		return StudioBuild{OK: false, Error: trim(bundle.Stderr, 400)}, nil
	}
	_ = s.WriteFile(pid, "out/.studio/index.html", playerHTML())

	version := time.Now().UnixMilli()
	p.StudioVersion = version
	s.stepRich(p, Step{Phase: "studio", Kind: "info", Detail: fmt.Sprintf("Player bundle ready (v%d, %d scenes)", version, len(scenes))})
	return StudioBuild{OK: true, Version: version}, nil
}
