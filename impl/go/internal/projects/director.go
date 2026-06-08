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
	s := "You write a single Remotion scene component in TypeScript. Reply with ONLY a fenced ```tsx block containing one file.\n" +
		"Requirements:\n- Export a named React FC matching the scene id.\n- Use only \"react\" and \"remotion\" imports (AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence).\n- Self-contained, no external assets, no audio. Fill the frame; large readable text.\n\n" +
		"You MUST follow these best practices:\n" + core
	if rules != "" {
		s += "\n\nRelevant rules for this scene:" + rules
	}
	return s
}

func rootSource(sb *Storyboard) string {
	var imports, series strings.Builder
	total := 0
	for _, sc := range sb.Scenes {
		imports.WriteString(fmt.Sprintf("import {%s} from './scenes/%s';\n", sc.ID, sc.ID))
		series.WriteString(fmt.Sprintf("      <Series.Sequence durationInFrames={%d}>\n        <%s />\n      </Series.Sequence>\n", sc.DurationInFrames, sc.ID))
		total += sc.DurationInFrames
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
    <Composition id="Video" component={Video} durationInFrames={%d} fps={%d} width={%d} height={%d} />
  );
};
`, imports.String(), series.String(), total, sb.FPS, sb.Width, sb.Height)
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
	p.Storyboard = &sb
	ids := make([]string, len(sb.Scenes))
	for i, sc := range sb.Scenes {
		ids[i] = sc.ID
	}
	s.logStep(p, "storyboard", fmt.Sprintf("%d scenes: %s", len(sb.Scenes), strings.Join(ids, ", ")))

	// 2. Author each scene.
	for _, sc := range sb.Scenes {
		s.logStep(p, "scene", "Writing src/scenes/"+sc.ID+".tsx")
		rules := skills.RulesFor(sc.Title+" "+sc.Visual+" "+sc.Narration, 6000)
		resp, err := client.Chat([]agent.ChatMessage{
			{Role: "system", Content: sceneSystem(rules)},
			{Role: "user", Content: fmt.Sprintf("Storyboard: %s\nConcept: %s\n\nWrite scene %q.\nTitle: %s\nDuration: %d frames at %dfps.\nNarration: %s\nVisual: %s\nOne of %d scenes (%s); keep style consistent.",
				sb.Title, concept, sc.ID, sc.Title, sc.DurationInFrames, sb.FPS, sc.Narration, sc.Visual, len(sb.Scenes), strings.Join(ids, ", "))},
		}, 2200, 0.3)
		if err != nil {
			p.fail("scene " + sc.ID + ": " + err.Error())
			return
		}
		_ = s.WriteFile(pid, "src/scenes/"+sc.ID+".tsx", extractTSX(resp))
	}

	// 3. Assemble.
	s.logStep(p, "assemble", "Writing src/Root.tsx and src/index.ts")
	_ = s.WriteFile(pid, "src/Root.tsx", rootSource(&sb))
	_ = s.WriteFile(pid, "src/index.ts", indexSource)

	// 4. Render with up to 3 repair passes.
	p.setState("rendering")
	s.logStep(p, "render", "Rendering the assembled video")
	r, _ := s.mgr.Backend().Exec(p.SandboxID, "npx --no-install remotion render Video out/video.mp4", "", nil, 1200)
	for attempt := 1; attempt <= 3 && r.ExitCode != 0; attempt++ {
		s.logStep(p, "repair", fmt.Sprintf("Render failed (attempt %d/3); asking the model to fix the file(s)", attempt))
		edited := s.repairOnce(pid, client, r.Stderr+"\n"+r.Stdout)
		if len(edited) == 0 {
			break
		}
		r, _ = s.mgr.Backend().Exec(p.SandboxID, "npx --no-install remotion render Video out/video.mp4", "", nil, 1200)
	}
	if r.ExitCode != 0 {
		p.fail("render failed after repair: " + trim(r.Stderr, 400))
		return
	}
	p.ExportPath = "out/video.mp4"
	p.setState("ready")
	s.logStep(p, "done", "Concept video rendered to out/video.mp4")
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

func (s *Store) repairOnce(pid string, client *agent.LLMClient, errText string) []string {
	fb := fileBlock(s.collect(pid))
	resp, err := client.Chat([]agent.ChatMessage{
		{Role: "system", Content: "You fix Remotion build/render errors. Reply with ONLY a fenced ```json block: {\"files\":[{\"path\":\"src/...\",\"content\":\"full file\"}],\"note\":\"...\"}. Provide complete file contents."},
		{Role: "user", Content: "Render error:\n" + trim(errText, 1500) + "\n\nProject files:\n" + trim(fb, 12000)},
	}, 2600, 0.2)
	if err != nil {
		return nil
	}
	return s.applyEdits(pid, resp)
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
