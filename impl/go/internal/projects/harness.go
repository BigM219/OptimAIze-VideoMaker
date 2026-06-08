// Harness glue for the projects package (Go parity of the TS director wiring).
// Defines update_storyboard here (it mutates the Storyboard, which lives in this
// package), builds the tool registry with all domain tools, and rewires ChatEdit
// onto the agentic RunAgent loop with a legacy single-shot fallback.
package projects

import (
	"fmt"
	"strings"

	"optimaize-videomaker-go/internal/agent"
	"optimaize-videomaker-go/internal/skills"
	"optimaize-videomaker-go/internal/tool"
)

// updateStoryboardTool lets the model restructure the storyboard (add/remove/
// reorder scenes) and rewrites Root.tsx so Studio hot-reloads the new deck.
func (s *Store) updateStoryboardTool(pid string) tool.Def {
	return tool.Def{
		ID: "update_storyboard",
		Description: "Replace the storyboard's scene list (add, remove, or reorder scenes) and rewrite Root.tsx so Studio reflects the new deck. " +
			"Each scene: {id (PascalCase), title, durationInFrames, narration, visual}. A scene only renders once its component file exists (write it with the write tool).",
		Parameters: []tool.Param{
			{Name: "scenes", Type: "array", Items: "{id, title, durationInFrames, narration, visual}", Description: "The full ordered scene list (replaces the current one)", Required: true},
		},
		Validate: func(args map[string]any) (map[string]any, error) {
			scenes, err := parseScenesArg(args["scenes"])
			if err != nil {
				return nil, err
			}
			return map[string]any{"scenes": scenes}, nil
		},
		Execute: func(args map[string]any, ctx *tool.Context) (tool.Result, error) {
			scenes := args["scenes"].([]Scene)
			p, ok := s.Get(pid)
			if !ok || p.Storyboard == nil {
				return tool.Result{Title: "storyboard", Output: "No storyboard exists yet. Generate one before updating it.", Metadata: map[string]any{"error": "no_storyboard"}}, nil
			}
			p.Storyboard.Scenes = scenes
			p.UpdatedAt = now()

			// Register only scenes whose component file already exists.
			var existing []Scene
			for _, sc := range scenes {
				if _, err := s.ReadFile(pid, "src/scenes/"+sc.ID+".tsx"); err == nil {
					existing = append(existing, sc)
				}
			}
			_ = s.WriteFile(pid, "src/Root.tsx", rootSourceFor(p.Storyboard, existing))
			ctx.LogStep("assemble", fmt.Sprintf("Updated storyboard (%d scenes)", len(scenes)), tool.StepExtra{Kind: "write_file", Path: "src/Root.tsx"})

			var lines []string
			for i, sc := range scenes {
				lines = append(lines, fmt.Sprintf("  %d. %s (%df) — %s", i+1, sc.ID, sc.DurationInFrames, sc.Title))
			}
			var missing []string
			existingSet := map[string]bool{}
			for _, sc := range existing {
				existingSet[sc.ID] = true
			}
			for _, sc := range scenes {
				if !existingSet[sc.ID] {
					missing = append(missing, sc.ID)
				}
			}
			note := ""
			if len(missing) > 0 {
				note = "\n\nScenes still needing a component file: " + strings.Join(missing, ", ") + "."
			}
			return tool.Result{
				Title:    "storyboard",
				Output:   fmt.Sprintf("Storyboard updated (%d scenes):\n%s%s", len(scenes), strings.Join(lines, "\n"), note),
				Metadata: map[string]any{"scenes": len(scenes), "registered": len(existing)},
			}, nil
		},
	}
}

var pascalIDRe = mustPascal()

func mustPascal() func(string) bool {
	// avoid importing regexp twice; simple check
	return func(s string) bool {
		if s == "" {
			return false
		}
		for i, r := range s {
			isAlpha := (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')
			isDigit := r >= '0' && r <= '9'
			if i == 0 && !isAlpha {
				return false
			}
			if i > 0 && !isAlpha && !isDigit {
				return false
			}
		}
		return true
	}
}

func parseScenesArg(raw any) ([]Scene, error) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%q is required and must be an array", "scenes")
	}
	var out []Scene
	ids := map[string]bool{}
	for _, item := range arr {
		o, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("each scene must be an object")
		}
		id, _ := o["id"].(string)
		if !pascalIDRe(id) {
			return nil, fmt.Errorf("each scene needs a PascalCase \"id\" (got %q)", id)
		}
		if ids[id] {
			return nil, fmt.Errorf("duplicate scene id: %s", id)
		}
		ids[id] = true
		dur := 0.0
		switch d := o["durationInFrames"].(type) {
		case float64:
			dur = d
		case int:
			dur = float64(d)
		}
		if dur <= 0 {
			return nil, fmt.Errorf("scene %s needs a positive \"durationInFrames\"", id)
		}
		title, _ := o["title"].(string)
		if title == "" {
			title = id
		}
		narration, _ := o["narration"].(string)
		visual, _ := o["visual"].(string)
		out = append(out, Scene{ID: id, Title: title, DurationInFrames: int(dur), Narration: narration, Visual: visual})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("storyboard must have at least one scene")
	}
	return out, nil
}

// toolContext builds a tool.Context whose Log writes into the project transcript.
func (s *Store) toolContext(p *Project) *tool.Context {
	return &tool.Context{
		ProjectID: p.ID,
		Store:     s,
		Backend:   s.mgr.Backend(),
		SandboxID: p.SandboxID,
		Log: func(phase, detail string, extra tool.StepExtra) {
			s.stepRich(p, Step{
				Phase: phase, Detail: detail,
				Kind: extra.Kind, Path: extra.Path, Content: extra.Content,
				Command: extra.Command, ExitCode: extra.ExitCode, Output: extra.Output,
			})
		},
	}
}

// newRegistry builds the registry with the three domain tools for this project.
func (s *Store) newRegistry(pid string) *tool.Registry {
	return tool.NewRegistry(tool.RenderSceneTool, tool.ReadSkillRuleTool, s.updateStoryboardTool(pid))
}

// ChatEditAgent runs the agentic loop for a chat-driven edit. Falls back to the
// legacy single-shot ChatEdit if there is no sandbox or the loop errors.
func (s *Store) ChatEditAgent(pid, message, activeFile string) (string, []string, error) {
	p, ok := s.Get(pid)
	if !ok {
		return "", nil, fmt.Errorf("project not found")
	}
	if p.SandboxID == "" {
		return s.ChatEdit(pid, message, activeFile)
	}
	storyboardLine := ""
	if p.Storyboard != nil {
		ids := make([]string, len(p.Storyboard.Scenes))
		for i, sc := range p.Storyboard.Scenes {
			ids[i] = sc.ID
		}
		storyboardLine = "Storyboard scenes: " + strings.Join(ids, ", ") + "\n"
	}
	ruleLine := ""
	if info := skills.Info(); info != nil {
		if rules, ok := info["rules"].([]string); ok && len(rules) > 0 {
			ruleLine = "On-demand skill rules you can load with read_skill_rule: " + strings.Join(rules, ", ") + "\n"
		}
	}
	systemPrompt := "You are a Remotion coding assistant editing an existing video project with tools. " +
		"Make the smallest coherent change that satisfies the user, keeping the whole project consistent.\n\n" +
		"Project goal: " + p.Goals + "\nRequirements: " + p.Reqs + "\n" + storyboardLine +
		"Active file: " + activeFile + "\n\n" + ruleLine +
		"Follow these Remotion best practices:\n" + skills.Core()

	res, err := tool.RunAgent(tool.RunOptions{
		Registry:     s.newRegistry(pid),
		Ctx:          s.toolContext(p),
		Client:       agent.NewLLMClient(),
		SystemPrompt: systemPrompt,
		UserGoal:     message,
		MaxTurns:     10,
	})
	if err != nil {
		s.stepRich(p, Step{Phase: "error", Detail: "Agent loop failed, falling back: " + err.Error(), Kind: "error"})
		return s.ChatEdit(pid, message, activeFile)
	}
	note := res.Summary
	if note == "" {
		if len(res.Edited) > 0 {
			note = "Edited " + strings.Join(res.Edited, ", ") + "."
		} else {
			note = "No changes made."
		}
	}
	p.Chat = append(p.Chat, map[string]string{"role": "user", "content": message})
	p.Chat = append(p.Chat, map[string]string{"role": "assistant", "content": note})
	p.UpdatedAt = now()
	return note, res.Edited, nil
}

// ensure interface satisfaction at compile time
var _ tool.Store = (*Store)(nil)
