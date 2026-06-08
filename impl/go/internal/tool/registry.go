// Tool registry (Go parity of registry.ts). See docs/harness-design.md §2, §4.
// Holds id → Def, validates args, runs Execute through a shared wrapper: a
// bad-args call becomes an ok:false result (model is asked to rewrite) instead
// of erroring; panics/errors are caught so one failing tool never crashes the
// loop; every call can log a transcript step.
package tool

import (
	"fmt"
	"strings"
)

// builtin tools, in catalog order. Domain tools are appended via NewRegistry's
// extra arg (the projects package supplies them).
func builtinTools() []Def {
	return []Def{ReadTool, WriteTool, EditTool, ListFilesTool, BashTool, GrepTool, GlobTool, RenderSceneTool, ReadSkillRuleTool}
}

type Registry struct {
	tools map[string]Def
	order []string
}

func NewRegistry(extra ...Def) *Registry {
	r := &Registry{tools: map[string]Def{}}
	for _, t := range append(builtinTools(), extra...) {
		if _, ok := r.tools[t.ID]; !ok {
			r.order = append(r.order, t.ID)
		}
		r.tools[t.ID] = t
	}
	return r
}

func (r *Registry) IDs() []string { return append([]string(nil), r.order...) }

func (r *Registry) IsMutating(id string) bool {
	t, ok := r.tools[id]
	return ok && t.Mutating
}

// Execute runs one call through the shared wrapper. Never returns an error —
// always a CallResult the director can render back to the model.
func (r *Registry) Execute(call Call, ctx *Context) CallResult {
	def, ok := r.tools[call.Tool]
	if !ok {
		res, _ := InvalidTool.Execute(map[string]any{"tool": call.Tool, "error": fmt.Sprintf("unknown tool %q", call.Tool)}, ctx)
		return CallResult{Tool: call.Tool, OK: false, Output: res.Output, Title: res.Title}
	}

	args := call.Args
	if args == nil {
		args = map[string]any{}
	}
	validated, err := def.Validate(args)
	if err != nil {
		ctx.LogStep("tool", fmt.Sprintf("%s: invalid args — %s", call.Tool, err.Error()), StepExtra{Kind: "error"})
		return CallResult{
			Tool:   call.Tool,
			OK:     false,
			Output: fmt.Sprintf("The %s tool was called with invalid arguments: %s\nRewrite the input so it satisfies the parameters.", call.Tool, err.Error()),
		}
	}

	res, execErr := safeExecute(def, validated, ctx)
	if execErr != nil {
		ctx.LogStep("tool", fmt.Sprintf("%s: failed — %s", call.Tool, execErr.Error()), StepExtra{Kind: "error"})
		return CallResult{Tool: call.Tool, OK: false, Output: fmt.Sprintf("Tool %s failed: %s", call.Tool, execErr.Error())}
	}
	// A tool may report a soft failure via metadata.error — surface as ok:false.
	_, softFail := res.Metadata["error"]
	return CallResult{
		Tool:       call.Tool,
		OK:         !softFail,
		Output:     res.Output,
		Title:      res.Title,
		Metadata:   res.Metadata,
		Truncated:  res.Truncated,
		OutputPath: res.OutputPath,
	}
}

// safeExecute runs a tool's Execute, converting a panic into an error so one
// misbehaving tool can't take down the agent loop.
func safeExecute(def Def, args map[string]any, ctx *Context) (res Result, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return def.Execute(args, ctx)
}

// RenderDocs renders the tool catalog for the system prompt.
func (r *Registry) RenderDocs() string {
	var b strings.Builder
	for _, id := range r.order {
		t := r.tools[id]
		fmt.Fprintf(&b, "- %s: %s", t.ID, t.Description)
		for _, p := range t.Parameters {
			req := ""
			if p.Required {
				req = " (required)"
			}
			items := ""
			if p.Items != "" {
				items = " of " + p.Items
			}
			fmt.Fprintf(&b, "\n    - %s: %s%s%s — %s", p.Name, p.Type, items, req, p.Description)
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// AppendDiagnostics runs one project type-check (if any mutating call succeeded)
// and splices the errors into the matching mutating results — see §8. Mutates
// results in place.
func (r *Registry) AppendDiagnostics(results []CallResult, ctx *Context) {
	anyMutated := false
	for _, res := range results {
		if res.OK && r.IsMutating(res.Tool) {
			anyMutated = true
			break
		}
	}
	if !anyMutated {
		return
	}
	byFile := typecheck(ctx)
	if len(byFile) == 0 {
		return
	}
	for i := range results {
		if !(results[i].OK && r.IsMutating(results[i].Tool)) {
			continue
		}
		edited, _ := results[i].Metadata["filePath"].(string)
		if text := formatDiagnostics(byFile, edited); text != "" {
			results[i].Output += text
		}
	}
}
