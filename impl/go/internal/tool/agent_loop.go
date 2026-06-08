// RunAgent — the agentic tool loop (Go parity of agent-loop.ts).
// See docs/harness-design.md §9. The LLM only returns text, so each turn we send
// the conversation, parse a ```tool_calls``` block, execute the calls through the
// registry, splice in incremental diagnostics, and feed a ```tool_results``` block
// back as the next user message — until the model signals done, stalls, or hits
// the turn ceiling.
package tool

import (
	"optimaize-videomaker-go/internal/agent"
)

const (
	maxToolTurns = 12
	maxIdle      = 2 // consecutive turns with no tool calls before we stop
)

// Chatter is the subset of *agent.LLMClient the loop needs.
type Chatter interface {
	Chat(messages []agent.ChatMessage, maxTokens int, temperature float64) (string, error)
}

// RunResult reports why the loop ended and what it changed.
type RunResult struct {
	Summary string
	Turns   int
	Stop    string // "done" | "idle" | "max_turns" | "error"
	Edited  []string
}

// RunOptions configures one agentic run.
type RunOptions struct {
	Registry      *Registry
	Ctx           *Context
	Client        Chatter
	SystemPrompt  string
	UserGoal      string
	MaxTurns      int
	HistoryWindow int
}

func protocolDoc(r *Registry) string {
	return "" +
		"You work by calling tools. Each turn, reply with EXACTLY ONE fenced code block tagged tool_calls whose body is a JSON object.\n\n" +
		"To act, list one or more calls (they run in parallel):\n" +
		"```tool_calls\n" +
		`{ "calls": [ { "tool": "read", "args": { "filePath": "src/Root.tsx" } } ] }` + "\n" +
		"```\n\n" +
		"When the goal is fully done, finish with:\n" +
		"```tool_calls\n" +
		`{ "done": true, "summary": "what you accomplished" }` + "\n" +
		"```\n\n" +
		"Rules: emit only the tool_calls block (a short reasoning line before it is fine). " +
		"Read a file before editing it. Prefer `edit` over `write` for small changes. " +
		"After editing a scene, use `render_scene` to verify it renders. " +
		"Results come back in a tool_results block; read them before the next step.\n\n" +
		"Available tools:\n" + r.RenderDocs()
}

func trimHistory(messages []agent.ChatMessage, window int) []agent.ChatMessage {
	if len(messages) <= window+1 {
		return messages
	}
	out := make([]agent.ChatMessage, 0, window+1)
	out = append(out, messages[0])
	out = append(out, messages[len(messages)-window:]...)
	return out
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// RunAgent drives the loop. Never returns an error for normal stop conditions;
// only a non-nil error if the LLM call itself fails irrecoverably.
func RunAgent(opts RunOptions) (RunResult, error) {
	reg := opts.Registry
	if reg == nil {
		reg = NewRegistry()
	}
	maxTurns := opts.MaxTurns
	if maxTurns <= 0 {
		maxTurns = maxToolTurns
	}
	window := opts.HistoryWindow
	if window <= 0 {
		window = 8
	}

	messages := []agent.ChatMessage{
		{Role: "system", Content: opts.SystemPrompt + "\n\n" + protocolDoc(reg)},
		{Role: "user", Content: opts.UserGoal},
	}

	var editedAll []string
	idleStreak := 0

	for turn := 1; turn <= maxTurns; turn++ {
		resp, err := opts.Client.Chat(messages, 4000, 0.3)
		if err != nil {
			return RunResult{Summary: "(llm error)", Turns: turn - 1, Stop: "error", Edited: dedupe(editedAll)}, err
		}
		messages = append(messages, agent.ChatMessage{Role: "assistant", Content: resp})

		parsed := ParseToolCalls(resp)

		if parsed.Done {
			opts.Ctx.LogStep("done", orDefault(parsed.Summary, "Agent finished."), StepExtra{Kind: "info"})
			return RunResult{Summary: parsed.Summary, Turns: turn, Stop: "done", Edited: dedupe(editedAll)}, nil
		}

		if len(parsed.Calls) == 0 {
			idleStreak++
			if idleStreak >= maxIdle {
				return RunResult{Summary: "(stopped: no progress)", Turns: turn, Stop: "idle", Edited: dedupe(editedAll)}, nil
			}
			nudge := parsed.ParseError
			if nudge == "" {
				nudge = `No tool_calls block found. Emit one ` + "```tool_calls```" + ` block with {"calls":[...]} or {"done":true,"summary":"..."}.`
			}
			messages = append(messages, agent.ChatMessage{Role: "user", Content: nudge})
			continue
		}
		idleStreak = 0

		results := make([]CallResult, len(parsed.Calls))
		for i, c := range parsed.Calls {
			results[i] = reg.Execute(c, opts.Ctx)
		}
		reg.AppendDiagnostics(results, opts.Ctx)

		for _, r := range results {
			if r.OK && reg.IsMutating(r.Tool) {
				if fp, ok := r.Metadata["filePath"].(string); ok {
					editedAll = append(editedAll, fp)
				}
			}
		}

		messages = append(messages, agent.ChatMessage{Role: "user", Content: RenderToolResults(results)})
		messages = trimHistory(messages, window)
	}

	return RunResult{Summary: "(stopped: max turns)", Turns: maxTurns, Stop: "max_turns", Edited: dedupe(editedAll)}, nil
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
