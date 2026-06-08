// Domain tools that don't need the Storyboard type (Go parity of render-scene.ts
// and read-skill-rule.ts). See docs/harness-design.md §5.4. update_storyboard
// lives in the projects package because it mutates the Storyboard.
package tool

import (
	"fmt"
	"regexp"

	"optimaize-videomaker-go/internal/skills"
)

var pascalRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)

// RenderSceneTool renders one scene's composition to surface runtime errors early.
var RenderSceneTool = Def{
	ID: "render_scene",
	Description: "Render a single scene's composition to a probe file to check it actually renders (catches runtime errors like interpolating a color with interpolate()). " +
		"Pass the scene id (PascalCase, matching the composition). Returns OK or the render error to fix.",
	Parameters: []Param{
		{Name: "sceneId", Type: "string", Description: "Scene/composition id, e.g. TitleScene", Required: true},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		id, err := reqString(args, "sceneId")
		if err != nil {
			return nil, err
		}
		if !pascalRe.MatchString(id) {
			return nil, validationErr("%q must be a PascalCase identifier (got %q).", "sceneId", id)
		}
		return map[string]any{"sceneId": id}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		sceneID := args["sceneId"].(string)
		out := fmt.Sprintf("out/.probe/%s.mp4", sceneID)
		cmd := fmt.Sprintf("npx --no-install remotion render %s %s --frames=0-0", sceneID, out)
		ctx.LogStep("command", "Render-check "+sceneID, StepExtra{Kind: "command", Command: cmd})
		r, err := ctx.Backend.Exec(ctx.SandboxID, cmd, "", nil, 300)
		if err != nil {
			return Result{}, err
		}
		combined := joinNonEmpty(r.Stdout, r.Stderr)
		if r.ExitCode == 0 {
			zero := 0
			ctx.LogStep("command", sceneID+" renders OK", StepExtra{Kind: "command_output", ExitCode: &zero, Output: combined})
			return Result{Title: sceneID, Output: "Scene " + sceneID + " rendered OK.", Metadata: map[string]any{"sceneId": sceneID, "ok": true}}, nil
		}
		ec := r.ExitCode
		ctx.LogStep("command", sceneID+" render failed", StepExtra{Kind: "command_output", ExitCode: &ec, Output: combined})
		if combined == "" {
			combined = "(no output)"
		}
		shaped, truncated, outputPath := truncateOutput(ctx, "render_scene", combined, 16*1024)
		return Result{
			Title:      sceneID,
			Output:     "Scene " + sceneID + " failed to render:\n" + shaped,
			Truncated:  truncated,
			OutputPath: outputPath,
			Metadata:   map[string]any{"sceneId": sceneID, "error": "render_failed", "exit": r.ExitCode},
		}, nil
	},
}

// ReadSkillRuleTool loads one on-demand skill rule by name.
var ReadSkillRuleTool = Def{
	ID: "read_skill_rule",
	Description: "Load one on-demand Remotion skill rule by file name (e.g. timing.md, transitions.md) for targeted best-practice guidance. " +
		"The available rule names are shown in the system prompt.",
	Parameters: []Param{
		{Name: "name", Type: "string", Description: "Rule file name, e.g. timing.md", Required: true},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		name, err := reqString(args, "name")
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": name}, nil
	},
	Execute: func(args map[string]any, _ *Context) (Result, error) {
		name := args["name"].(string)
		if len(name) < 3 || name[len(name)-3:] != ".md" {
			name += ".md"
		}
		body, ok := skills.Rule(name)
		if !ok {
			info := skills.Info()
			available := ""
			if rules, ok := info["rules"].([]string); ok {
				available = fmt.Sprintf("%v", rules)
			}
			return Result{Title: name, Output: fmt.Sprintf("Rule %q not found. Available rules: %s.", name, available), Metadata: map[string]any{"error": "not_found"}}, nil
		}
		return Result{Title: name, Output: fmt.Sprintf("<skill_rule name=%q>\n%s\n</skill_rule>", name, body), Metadata: map[string]any{"name": name}}, nil
	},
}

func joinNonEmpty(parts ...string) string {
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += "\n"
		}
		out += p
	}
	return out
}
