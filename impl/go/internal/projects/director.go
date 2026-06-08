// Concept-driven director loop + code-aware chat (Go). Mirrors the TS director:
// concept -> storyboard -> per-scene components -> assemble Root.tsx -> render
// with autonomous repair; chat edits with full project context.
package projects

import (
	"encoding/json"
	"fmt"
	"strings"

	"optimaize-videomaker-go/internal/agent"
	"optimaize-videomaker-go/internal/skills"
	"optimaize-videomaker-go/internal/types"
)

const storyboardSystem = `You are a video director for educational explainer videos built with Remotion.
Given a concept, produce a JSON storyboard. Reply with ONLY a fenced ` + "```json" + ` block:
{
  "title": "string", "fps": 30, "width": 1920, "height": 1080,
  "scenes": [{"id": "TitleScene", "title": "...", "durationInFrames": 90, "narration": "...", "visual": "..."}]
}
Rules: 4-6 scenes; ids PascalCase ending "Scene"; durations sum to roughly the requested length; for a data/plot concept include a scene that animates the actual visual (scatter points then a fitted line).`

func sceneSystem(rules string) string {
	core := skills.Core()
	// Output contract only — the skill carries all the how-to.
	s := "You write a single Remotion scene component in TypeScript. Reply with ONLY a fenced ```tsx block containing one complete file that exports a named React FC matching the scene id.\n\n" +
		"Follow these best practices:\n" + core
	if rules != "" {
		s += "\n\nRelevant rules for this scene:" + rules
	}
	return s
}

// rootSource builds Root.tsx registering ONE <Composition> per scene plus the
// combined "Video" composition, so Remotion Studio lists every slide and renders
// each directly from code (live, hot-reload). Only the scenes passed in are
// imported/registered, so Studio hot-reloads cleanly as slides are written one
// at a time — a scene whose file doesn't exist yet is simply absent.
func rootSource(sb *Storyboard) string { return rootSourceFor(sb, sb.Scenes) }

func rootSourceFor(sb *Storyboard, scenes []Scene) string {
	var imports, series, perScene strings.Builder
	total := 0
	for _, sc := range scenes {
		imports.WriteString(fmt.Sprintf("import {%s} from './scenes/%s';\n", sc.ID, sc.ID))
		series.WriteString(fmt.Sprintf("      <Series.Sequence durationInFrames={%d}>\n        <%s />\n      </Series.Sequence>\n", sc.DurationInFrames, sc.ID))
		perScene.WriteString(fmt.Sprintf("    <Composition id=\"%s\" component={%s} durationInFrames={%d} fps={%d} width={%d} height={%d} />\n", sc.ID, sc.ID, sc.DurationInFrames, sb.FPS, sb.Width, sb.Height))
		total += sc.DurationInFrames
	}
	combined := ""
	if len(scenes) > 0 {
		combined = fmt.Sprintf("    <Composition id=\"Video\" component={Video} durationInFrames={%d} fps={%d} width={%d} height={%d} />\n", total, sb.FPS, sb.Width, sb.Height)
	}
	return fmt.Sprintf(`import React from 'react';
import {Composition, Series} from 'remotion';
%s
export const Video: React.FC = () => {
  return (
    <Series>
%s    </Series>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
%s%s    </>
  );
};
`, imports.String(), series.String(), combined, perScene.String())
}

const indexSource = `import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';
registerRoot(RemotionRoot);
`

// Generate runs the full director loop on a project (call in a goroutine).
func (s *Store) Generate(pid, concept, audience string, durationS int) {
	p, ok := s.Get(pid)
	if !ok {
		return
	}
	client := agent.NewLLMClient()
	p.setState("generating")

	// 1. Storyboard.
	s.logStep(p, "outline", "Planning storyboard for: "+concept)
	fps := 30
	out, err := client.Chat([]agent.ChatMessage{
		{Role: "system", Content: storyboardSystem},
		{Role: "user", Content: fmt.Sprintf("Concept: %s\nAudience: %s\nTarget length: ~%ds at %dfps. Produce the storyboard.", concept, audience, durationS, fps)},
	}, 1500, 0.4)
	if err != nil {
		p.fail("storyboard: " + err.Error())
		return
	}
	var sb Storyboard
	if err := json.Unmarshal([]byte(extractJSON(out)), &sb); err != nil || len(sb.Scenes) == 0 {
		p.fail("invalid storyboard JSON")
		return
	}
	if sb.FPS == 0 {
		sb.FPS = fps
	}
	if sb.Width == 0 {
		sb.Width = 1920
	}
	if sb.Height == 0 {
		sb.Height = 1080
	}
	for i := range sb.Scenes {
		sb.Scenes[i].Status = "pending"
	}
	p.Storyboard = &sb
	ids := make([]string, len(sb.Scenes))
	for i, sc := range sb.Scenes {
		ids[i] = sc.ID
	}
	s.stepRich(p, Step{Phase: "storyboard", Kind: "plan",
		Detail:  fmt.Sprintf("%s — %d scenes: %s", sb.Title, len(sb.Scenes), strings.Join(ids, ", ")),
		Content: storyboardSummary(&sb)})

	// Studio renders every slide live from code, so launch it up front with an
	// empty Root. As each scene is written we rewrite Root to register the
	// scenes-so-far; Studio hot-reloads and the new slide appears.
	_ = s.WriteFile(pid, "src/index.ts", indexSource)
	_ = s.WriteFile(pid, "src/Root.tsx", rootSourceFor(&sb, nil))
	if url, _, err := s.LaunchStudio(pid); err == nil {
		s.stepRich(p, Step{Phase: "studio", Kind: "info", Detail: "Live Studio on " + url + " — slides appear as they're written."})
	} else {
		s.stepRich(p, Step{Phase: "studio", Kind: "info", Detail: "Studio launch deferred: " + err.Error()})
	}

	// 2. Author each scene. After writing each one, register the
	//    scenes-written-so-far in Root so Studio hot-reloads and that slide
	//    becomes reviewable live — no per-scene mp4, the slide IS the code.
	for i := range sb.Scenes {
		sc := &sb.Scenes[i]
		sc.Status = "writing"
		p.UpdatedAt = now()
		rules := skills.RulesFor(sc.Title+" "+sc.Visual+" "+sc.Narration, 6000)
		resp, err := client.Chat([]agent.ChatMessage{
			{Role: "system", Content: sceneSystem(rules)},
			{Role: "user", Content: fmt.Sprintf("Storyboard: %s\nConcept: %s\n\nWrite scene %q.\nTitle: %s\nDuration: %d frames at %dfps.\nNarration: %s\nVisual: %s\nOne of %d scenes (%s); keep style consistent.",
				sb.Title, concept, sc.ID, sc.Title, sc.DurationInFrames, sb.FPS, sc.Narration, sc.Visual, len(sb.Scenes), strings.Join(ids, ", "))},
		}, 4000, 0.3)
		if err != nil {
			p.fail("scene " + sc.ID + ": " + err.Error())
			return
		}
		code := extractTSX(resp)
		_ = s.WriteFile(pid, "src/scenes/"+sc.ID+".tsx", code)
		s.stepRich(p, Step{Phase: "scene", Kind: "write_file", Detail: "Wrote src/scenes/" + sc.ID + ".tsx",
			Path: "src/scenes/" + sc.ID + ".tsx", Content: code})
		// Register this slide in Studio (hot-reload shows it immediately).
		_ = s.WriteFile(pid, "src/Root.tsx", rootSourceFor(&sb, sb.Scenes[:i+1]))
		sc.Status = "ready"
		p.UpdatedAt = now()
	}

	// 3. Final Root with every scene + the combined Video composition.
	root := rootSource(&sb)
	_ = s.WriteFile(pid, "src/Root.tsx", root)
	s.stepRich(p, Step{Phase: "assemble", Kind: "write_file", Detail: "Wrote src/Root.tsx", Path: "src/Root.tsx", Content: root})

	// 4. Render, then an agentic repair loop: keep feeding the build error back
	//    to the model (with full project + running history) and keep fixing until
	//    it renders or we hit a hard ceiling — the way a coding agent iterates on
	//    its own errors instead of giving up after a fixed number of passes.
	p.setState("rendering")
	renderCmd := "npx --no-install remotion render Video out/video.mp4"
	s.stepRich(p, Step{Phase: "render", Kind: "command", Detail: "Rendering the assembled video", Command: renderCmd})
	r, _ := s.mgr.Backend().Exec(p.SandboxID, renderCmd, "", nil, 1200)
	ec := r.ExitCode
	s.stepRich(p, Step{Phase: "render", Kind: "command_output", Detail: fmt.Sprintf("render exited %d", ec),
		ExitCode: &ec, Output: r.Stdout + "\n" + r.Stderr})
	if r.ExitCode != 0 {
		r = s.repairLoop(pid, client, r)
	}
	if r.ExitCode != 0 {
		p.fail("render failed after repair: " + trim(r.Stderr, 400))
		return
	}
	p.ExportPath = "out/video.mp4"
	p.setState("ready")
	s.stepRich(p, Step{Phase: "done", Kind: "info", Detail: "Concept video rendered to out/video.mp4"})
}

func (p *Project) fail(msg string) {
	p.State = "failed"
	p.Error = msg
	p.UpdatedAt = now()
}

// collect reads all source files for full LLM context.
func (s *Store) collect(pid string) map[string]string {
	out := map[string]string{}
	var walk func(rel string)
	walk = func(rel string) {
		entries, err := s.ListFiles(pid, rel)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.IsDir {
				if !strings.Contains(e.Path, "node_modules") {
					walk(e.Path)
				}
			} else if (strings.HasSuffix(e.Path, ".tsx") || strings.HasSuffix(e.Path, ".ts") || strings.HasSuffix(e.Path, ".css")) && !strings.Contains(e.Path, "node_modules") {
				if c, err := s.ReadFile(pid, e.Path); err == nil {
					out[e.Path] = c
				}
			}
		}
	}
	walk("src")
	return out
}

func fileBlock(files map[string]string) string {
	var b strings.Builder
	for path, content := range files {
		b.WriteString("// FILE: " + path + "\n" + content + "\n\n")
	}
	return b.String()
}

// repairLoop is an agentic, stateful repair: the model sees the latest build
// error and the full source each turn, rewrites whole files, we re-render and
// feed the new error back — repeating until the render passes, the model stops
// proposing changes for two consecutive turns, or a hard ceiling is reached.
// Returns the final ExecResult (ExitCode 0 on success).
const maxRepairTurns = 8

func (s *Store) repairLoop(pid string, client *agent.LLMClient, firstFail types.ExecResult) types.ExecResult {
	p, _ := s.Get(pid)
	messages := []agent.ChatMessage{
		{Role: "system", Content: "You are a Remotion build-fixer working iteratively, like a coding agent. " +
			"Each turn you receive the latest build/render error and the full project source. " +
			"Diagnose the actual cause (often a truncated/unclosed file, a bad import, or a type error), " +
			"then reply with ONLY a fenced ```json block: {\"files\":[{\"path\":\"src/...\",\"content\":\"COMPLETE file content\"}],\"note\":\"what you changed\"}. " +
			"Always return whole files, never fragments. If a file looks truncated, rewrite it complete."},
	}
	lastErr := firstFail.Stderr + "\n" + firstFail.Stdout
	noChange := 0
	r := firstFail
	for turn := 1; turn <= maxRepairTurns; turn++ {
		s.logStep(p, "repair", fmt.Sprintf("Fixing render error (turn %d/%d)", turn, maxRepairTurns))
		fb := fileBlock(s.collect(pid))
		messages = append(messages, agent.ChatMessage{
			Role:    "user",
			Content: "Build error:\n" + trim(lastErr, 2000) + "\n\nProject files:\n" + trim(fb, 16000),
		})
		resp, err := client.Chat(trimRepair(messages), 3000, 0.2)
		if err != nil {
			s.logStep(p, "repair", "LLM unavailable this turn: "+trim(err.Error(), 120))
			noChange++
			if noChange >= 2 {
				return r
			}
			continue
		}
		messages = append(messages, agent.ChatMessage{Role: "assistant", Content: resp})
		edited, note := s.applyEditsWithNote(pid, resp)
		if len(edited) == 0 {
			noChange++
			s.logStep(p, "repair", "Model proposed no file changes this turn.")
			if noChange >= 2 {
				s.logStep(p, "repair", "No progress for 2 turns; stopping repair.")
				return r
			}
			continue
		}
		noChange = 0
		detail := note
		if detail == "" {
			detail = "Rewrote " + strings.Join(edited, ", ")
		}
		s.stepRich(p, Step{Phase: "repair", Detail: detail, Kind: "write_file", Path: edited[0], Content: note})
		r, _ = s.mgr.Backend().Exec(p.SandboxID, "npx --no-install remotion render Video out/video.mp4", "", nil, 1200)
		ec := r.ExitCode
		s.stepRich(p, Step{Phase: "repair", Detail: fmt.Sprintf("Re-render exited %d", ec), Kind: "command_output", ExitCode: &ec, Output: r.Stdout + "\n" + r.Stderr})
		if r.ExitCode == 0 {
			s.stepRich(p, Step{Phase: "repair", Detail: fmt.Sprintf("Fixed after %d turn(s).", turn), Kind: "info"})
			return r
		}
		lastErr = r.Stderr + "\n" + r.Stdout
	}
	return r
}

// trimRepair keeps the repair conversation bounded: system + the last few turns
// (each user turn already carries the full latest source, so old turns are stale).
func trimRepair(messages []agent.ChatMessage) []agent.ChatMessage {
	if len(messages) <= 5 {
		return messages
	}
	out := []agent.ChatMessage{messages[0]}
	return append(out, messages[len(messages)-4:]...)
}

// ChatEdit: full-context code-aware edit. Returns the note + edited paths.
func (s *Store) ChatEdit(pid, message, activeFile string) (string, []string, error) {
	p, ok := s.Get(pid)
	if !ok {
		return "", nil, fmt.Errorf("project not found")
	}
	client := agent.NewLLMClient()
	fb := fileBlock(s.collect(pid))
	ctx := "Project goal: " + p.Goals + "\nRequirements: " + p.Reqs + "\nActive file: " + activeFile + "\n\nAll project files:\n" + trim(fb, 14000)
	resp, err := client.Chat([]agent.ChatMessage{
		{Role: "system", Content: "You are a Remotion coding assistant editing a video project. You see ALL files, the goal, and requirements — keep edits coherent with the whole project. Reply with ONLY a fenced ```json block: {\"files\":[{\"path\":\"src/...\",\"content\":\"full file\"}],\"note\":\"one sentence\"}.\n\nFollow these best practices:\n" + skills.Core()},
		{Role: "user", Content: ctx + "\n\nUser request: " + message},
	}, 2600, 0.3)
	if err != nil {
		return "", nil, err
	}
	edited := s.applyEdits(pid, resp)
	note := noteOf(resp)
	p.Chat = append(p.Chat, map[string]string{"role": "user", "content": message})
	p.Chat = append(p.Chat, map[string]string{"role": "assistant", "content": note})
	p.UpdatedAt = now()
	return note, edited, nil
}

func (s *Store) applyEdits(pid, resp string) []string {
	var parsed struct {
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
	}
	if json.Unmarshal([]byte(extractJSON(resp)), &parsed) != nil {
		return nil
	}
	var edited []string
	for _, f := range parsed.Files {
		if strings.HasPrefix(f.Path, "src/") {
			if err := s.WriteFile(pid, f.Path, f.Content); err == nil {
				edited = append(edited, f.Path)
			}
		}
	}
	return edited
}

func noteOf(resp string) string {
	var o struct {
		Note string `json:"note"`
	}
	if json.Unmarshal([]byte(extractJSON(resp)), &o) == nil && o.Note != "" {
		return o.Note
	}
	return "Applied edits."
}

// applyEditsWithNote applies the model's file edits and returns the edited paths
// plus the model's "note" (what it changed), for the transcript.
func (s *Store) applyEditsWithNote(pid, resp string) ([]string, string) {
	return s.applyEdits(pid, resp), noteOf(resp)
}

// storyboardSummary renders a scene list for the transcript plan card.
func storyboardSummary(sb *Storyboard) string {
	var b strings.Builder
	b.WriteString(sb.Title + "\n")
	for i, sc := range sb.Scenes {
		b.WriteString(fmt.Sprintf("%d. %s (%d frames) — %s\n", i+1, sc.ID, sc.DurationInFrames, sc.Title))
	}
	return b.String()
}
