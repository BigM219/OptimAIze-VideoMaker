// Parity tests for the Go harness — mirror the TS verify-harness*.mjs checks so
// the two implementations behave identically (parser, edit matcher, glob/grep,
// the agent loop's stop conditions).
package tool

import (
	"strings"
	"testing"

	"optimaize-videomaker-go/internal/agent"
	"optimaize-videomaker-go/internal/types"
)

// --- fakes -----------------------------------------------------------------

type fakeStore struct{ files map[string]string }

func newFakeStore() *fakeStore { return &fakeStore{files: map[string]string{}} }

func (f *fakeStore) ReadFile(_, rel string) (string, error) {
	if c, ok := f.files[rel]; ok {
		return c, nil
	}
	return "", &ValidationError{Msg: "not found"}
}
func (f *fakeStore) WriteFile(_, rel, content string) error { f.files[rel] = content; return nil }
func (f *fakeStore) ListFiles(_, rel string) ([]types.FileEntry, error) {
	// Return all files under rel as flat entries (good enough for walk/read tests).
	var out []types.FileEntry
	seen := map[string]bool{}
	prefix := rel
	if prefix == "." || prefix == "" {
		prefix = ""
	} else {
		prefix = strings.TrimSuffix(rel, "/") + "/"
	}
	for p := range f.files {
		if prefix != "" && !strings.HasPrefix(p, prefix) {
			continue
		}
		rest := strings.TrimPrefix(p, prefix)
		seg := strings.SplitN(rest, "/", 2)
		if len(seg) == 2 {
			dir := prefix + seg[0]
			if !seen[dir] {
				seen[dir] = true
				out = append(out, types.FileEntry{Path: dir, IsDir: true})
			}
		} else {
			out = append(out, types.FileEntry{Path: p, IsDir: false})
		}
	}
	return out, nil
}

type fakeBackend struct {
	exit   int
	stdout string
	stderr string
}

func (b *fakeBackend) Exec(_, _, _ string, _ map[string]string, _ float64) (types.ExecResult, error) {
	return types.ExecResult{ExitCode: b.exit, Stdout: b.stdout, Stderr: b.stderr}, nil
}

func newCtx(s Store, b Backend) *Context {
	return &Context{ProjectID: "p", Store: s, Backend: b, SandboxID: "sb"}
}

// --- protocol --------------------------------------------------------------

func TestParseToolCalls(t *testing.T) {
	resp := "reasoning\n```tool_calls\n{\"calls\":[{\"tool\":\"read\",\"args\":{\"filePath\":\"src/Root.tsx\"}}]}\n```"
	p := ParseToolCalls(resp)
	if p.Done || len(p.Calls) != 1 || p.Calls[0].Tool != "read" {
		t.Fatalf("clean parse failed: %+v", p)
	}
	if p.Calls[0].Args["filePath"] != "src/Root.tsx" {
		t.Fatalf("args not parsed: %+v", p.Calls[0].Args)
	}

	done := ParseToolCalls("```tool_calls\n{\"done\":true,\"summary\":\"all good\"}\n```")
	if !done.Done || done.Summary != "all good" {
		t.Fatalf("done signal failed: %+v", done)
	}

	// tolerance ladder: trailing comma + // comment
	loose := ParseToolCalls("```tool_calls\n{\"calls\":[{\"tool\":\"read\",\"args\":{\"filePath\":\"a\"}},]} // go\n```")
	if len(loose.Calls) != 1 {
		t.Fatalf("tolerance ladder failed: %+v", loose)
	}

	if none := ParseToolCalls("just prose"); none.Done || len(none.Calls) != 0 || none.ParseError != "" {
		t.Fatalf("no-block should be empty: %+v", none)
	}

	if bad := ParseToolCalls("```tool_calls\n{not json\n```"); bad.ParseError == "" {
		t.Fatalf("malformed should set ParseError")
	}
}

// --- edit matcher ----------------------------------------------------------

func TestEditStrategies(t *testing.T) {
	s := newFakeStore()
	ctx := newCtx(s, &fakeBackend{})

	// exact
	s.files["src/a.txt"] = "hello world\nsecond line\n"
	res := runEdit(t, ctx, "src/a.txt", "hello world", "hi world", false)
	if _, bad := res.Metadata["error"]; bad {
		t.Fatalf("exact edit should succeed: %+v", res)
	}
	if !strings.Contains(s.files["src/a.txt"], "hi world") {
		t.Fatalf("exact edit not applied: %q", s.files["src/a.txt"])
	}

	// line-trimmed (trailing whitespace drift)
	s.files["src/b.txt"] = "  const x = 1;   \n  const y = 2;\n"
	res = runEdit(t, ctx, "src/b.txt", "const x = 1;", "const x = 42;", false)
	if _, bad := res.Metadata["error"]; bad {
		t.Fatalf("line-trimmed edit should succeed: %+v", res)
	}
	if !strings.Contains(s.files["src/b.txt"], "42") {
		t.Fatalf("line-trimmed edit not applied: %q", s.files["src/b.txt"])
	}

	// block-anchor (middle differs)
	s.files["src/c.txt"] = "function f() {\n  return OLD_MIDDLE;\n}\n"
	res = runEdit(t, ctx, "src/c.txt", "function f() {\n  return DIFFERENT;\n}", "function f() {\n  return NEW;\n}", false)
	if _, bad := res.Metadata["error"]; bad {
		t.Fatalf("block-anchor edit should succeed: %+v", res)
	}
	if !strings.Contains(s.files["src/c.txt"], "NEW") {
		t.Fatalf("block-anchor edit not applied: %q", s.files["src/c.txt"])
	}

	// ambiguous (two exact matches, no replaceAll) → soft error
	s.files["src/d.txt"] = "x\nx\n"
	res = runEdit(t, ctx, "src/d.txt", "x", "y", false)
	if res.Metadata["error"] != "ambiguous" {
		t.Fatalf("ambiguous should soft-fail: %+v", res)
	}

	// replaceAll
	res = runEdit(t, ctx, "src/d.txt", "x", "y", true)
	if _, bad := res.Metadata["error"]; bad {
		t.Fatalf("replaceAll should succeed: %+v", res)
	}
	if s.files["src/d.txt"] != "y\ny\n" {
		t.Fatalf("replaceAll not applied: %q", s.files["src/d.txt"])
	}

	// no match
	res = runEdit(t, ctx, "src/a.txt", "NONEXISTENT", "z", false)
	if res.Metadata["error"] != "no_match" {
		t.Fatalf("no-match should soft-fail: %+v", res)
	}
}

func runEdit(t *testing.T, ctx *Context, fp, oldS, newS string, all bool) Result {
	t.Helper()
	args, err := EditTool.Validate(map[string]any{"filePath": fp, "oldString": oldS, "newString": newS, "replaceAll": all})
	if err != nil {
		t.Fatalf("validate failed: %v", err)
	}
	res, err := EditTool.Execute(args, ctx)
	if err != nil {
		t.Fatalf("execute failed: %v", err)
	}
	return res
}

// --- glob / grep -----------------------------------------------------------

func TestGlobGrep(t *testing.T) {
	s := newFakeStore()
	s.files["src/scenes/Intro.tsx"] = "import {interpolate} from 'remotion';\nconst x = 1;\n"
	s.files["src/scenes/Outro.tsx"] = "const y = 2;\n"
	s.files["src/Root.tsx"] = "export const Root = 1;\n"
	s.files["src/styles.css"] = ".a { color: red; }\n"
	ctx := newCtx(s, &fakeBackend{})

	// glob recursive
	res := runTool(t, GlobTool, ctx, map[string]any{"pattern": "src/**/*.tsx"})
	for _, want := range []string{"src/scenes/Intro.tsx", "src/scenes/Outro.tsx", "src/Root.tsx"} {
		if !strings.Contains(res.Output, want) {
			t.Fatalf("glob missing %s: %s", want, res.Output)
		}
	}
	if strings.Contains(res.Output, ".css") {
		t.Fatalf("glob should exclude css: %s", res.Output)
	}

	// glob specific
	res = runTool(t, GlobTool, ctx, map[string]any{"pattern": "**/Root.tsx"})
	if !strings.Contains(res.Output, "src/Root.tsx") {
		t.Fatalf("glob **/Root.tsx failed: %s", res.Output)
	}

	// grep with include
	res = runTool(t, GrepTool, ctx, map[string]any{"pattern": "interpolate", "include": "*.tsx"})
	if !strings.Contains(res.Output, "Intro.tsx") || !strings.Contains(res.Output, "Found 1 matches") {
		t.Fatalf("grep failed: %s", res.Output)
	}

	// grep bad regex → soft error
	res = runTool(t, GrepTool, ctx, map[string]any{"pattern": "("})
	if res.Metadata["error"] != "bad_regex" {
		t.Fatalf("bad regex should soft-fail: %+v", res)
	}
}

func runTool(t *testing.T, def Def, ctx *Context, raw map[string]any) Result {
	t.Helper()
	args, err := def.Validate(raw)
	if err != nil {
		t.Fatalf("%s validate failed: %v", def.ID, err)
	}
	res, err := def.Execute(args, ctx)
	if err != nil {
		t.Fatalf("%s execute failed: %v", def.ID, err)
	}
	return res
}

// --- registry + agent loop -------------------------------------------------

// scriptedClient returns canned responses in order, ignoring the prompt.
type scriptedClient struct {
	replies []string
	i       int
}

func (c *scriptedClient) Chat(_ []agent.ChatMessage, _ int, _ float64) (string, error) {
	if c.i >= len(c.replies) {
		return "no more", nil
	}
	r := c.replies[c.i]
	c.i++
	return r, nil
}

func TestRunAgentLoop(t *testing.T) {
	s := newFakeStore()
	s.files["src/a.txt"] = "old\n"
	ctx := newCtx(s, &fakeBackend{})
	reg := NewRegistry()

	// turn 1: read; turn 2: edit; turn 3: done
	client := &scriptedClient{replies: []string{
		"```tool_calls\n{\"calls\":[{\"tool\":\"read\",\"args\":{\"filePath\":\"src/a.txt\"}}]}\n```",
		"```tool_calls\n{\"calls\":[{\"tool\":\"edit\",\"args\":{\"filePath\":\"src/a.txt\",\"oldString\":\"old\",\"newString\":\"new\"}}]}\n```",
		"```tool_calls\n{\"done\":true,\"summary\":\"changed a.txt\"}\n```",
	}}
	res, err := RunAgent(RunOptions{Registry: reg, Ctx: ctx, Client: client, SystemPrompt: "sys", UserGoal: "change it", MaxTurns: 10})
	if err != nil {
		t.Fatalf("RunAgent error: %v", err)
	}
	if res.Stop != "done" || res.Turns != 3 {
		t.Fatalf("expected done in 3 turns: %+v", res)
	}
	if res.Summary != "changed a.txt" {
		t.Fatalf("summary not captured: %q", res.Summary)
	}
	if s.files["src/a.txt"] != "new\n" {
		t.Fatalf("edit not applied: %q", s.files["src/a.txt"])
	}
	if len(res.Edited) != 1 || res.Edited[0] != "src/a.txt" {
		t.Fatalf("edited not tracked: %+v", res.Edited)
	}

	// idle stop: two prose replies
	idle := &scriptedClient{replies: []string{"just thinking", "still thinking"}}
	r2, _ := RunAgent(RunOptions{Registry: reg, Ctx: ctx, Client: idle, SystemPrompt: "sys", UserGoal: "x", MaxTurns: 10})
	if r2.Stop != "idle" {
		t.Fatalf("expected idle stop: %+v", r2)
	}

	// max_turns: always emits a call, never done
	spin := &scriptedClient{replies: make([]string, 0)}
	for i := 0; i < 20; i++ {
		spin.replies = append(spin.replies, "```tool_calls\n{\"calls\":[{\"tool\":\"read\",\"args\":{\"filePath\":\"src/a.txt\"}}]}\n```")
	}
	r3, _ := RunAgent(RunOptions{Registry: reg, Ctx: ctx, Client: spin, SystemPrompt: "sys", UserGoal: "x", MaxTurns: 3})
	if r3.Stop != "max_turns" || r3.Turns != 3 {
		t.Fatalf("expected max_turns at 3: %+v", r3)
	}
}

// --- diagnostics -----------------------------------------------------------

func TestAppendDiagnostics(t *testing.T) {
	s := newFakeStore()
	// backend returns a tsc error for the edited file
	b := &fakeBackend{exit: 2, stdout: "src/a.txt(3,5): error TS2304: Cannot find name 'foo'.\n"}
	ctx := newCtx(s, b)
	reg := NewRegistry()

	results := []CallResult{
		{Tool: "write", OK: true, Output: "Wrote file successfully.", Metadata: map[string]any{"filePath": "src/a.txt"}},
		{Tool: "read", OK: true, Output: "<content>", Metadata: map[string]any{}},
	}
	reg.AppendDiagnostics(results, ctx)
	if !strings.Contains(results[0].Output, "TS2304") {
		t.Fatalf("diagnostics not spliced into write: %q", results[0].Output)
	}
	if strings.Contains(results[1].Output, "TS2304") {
		t.Fatalf("diagnostics should not touch read: %q", results[1].Output)
	}

	// no mutating tool → tsc skipped (backend would error if called, but it's a
	// clean read-only turn, so output stays unchanged)
	readOnly := []CallResult{{Tool: "read", OK: true, Output: "x", Metadata: map[string]any{}}}
	reg.AppendDiagnostics(readOnly, ctx)
	if readOnly[0].Output != "x" {
		t.Fatalf("read-only turn should be untouched: %q", readOnly[0].Output)
	}
}
