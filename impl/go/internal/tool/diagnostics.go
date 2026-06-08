// Incremental diagnostics (Go parity of tool/diagnostics.ts). See docs/harness-design.md §8.
// After a mutating tool runs, the registry runs a fast project type-check and
// splices errors into that tool's output so the model sees compile errors at once.
package tool

import (
	"fmt"
	"regexp"
	"strings"
)

const maxOtherFiles = 5

// Diagnostic is one tsc error.
type Diagnostic struct {
	File    string
	Line    int
	Col     int
	Code    string
	Message string
}

// tscLine matches: src/scenes/Intro.tsx(12,5): error TS2304: Cannot find name 'foo'.
var tscLine = regexp.MustCompile(`^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$`)

func normalizeDiagPath(p string) string {
	return strings.TrimPrefix(strings.ReplaceAll(p, "\\", "/"), "./")
}

// typecheck runs `tsc --noEmit` in the sandbox and groups errors by file.
// Returns an empty map on a clean build or if tsc can't run (advisory only).
func typecheck(ctx *Context) map[string][]Diagnostic {
	byFile := map[string][]Diagnostic{}
	r, err := ctx.Backend.Exec(ctx.SandboxID, "npx --no-install tsc --noEmit -p tsconfig.json", "", nil, 120)
	if err != nil || r.ExitCode == 0 {
		return byFile
	}
	text := r.Stdout + "\n" + r.Stderr
	for _, raw := range strings.Split(text, "\n") {
		raw = strings.TrimRight(raw, "\r")
		m := tscLine.FindStringSubmatch(raw)
		if m == nil {
			continue
		}
		file := normalizeDiagPath(m[1])
		line, col := atoi(m[2]), atoi(m[3])
		byFile[file] = append(byFile[file], Diagnostic{File: file, Line: line, Col: col, Code: m[4], Message: strings.TrimSpace(m[5])})
	}
	return byFile
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func diagBlock(diags []Diagnostic) string {
	var b strings.Builder
	for i, d := range diags {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "  %d:%d %s: %s", d.Line, d.Col, d.Code, d.Message)
	}
	return b.String()
}

// formatDiagnostics builds the text appended to a mutating tool's output:
// errors for the edited file first, then up to maxOtherFiles others. Empty
// string when the build is clean.
func formatDiagnostics(byFile map[string][]Diagnostic, editedFile string) string {
	if len(byFile) == 0 {
		return ""
	}
	edited := normalizeDiagPath(editedFile)
	var parts []string
	if own, ok := byFile[edited]; ok && len(own) > 0 {
		parts = append(parts, "\n\ntsc errors in this file, please fix:\n"+diagBlock(own))
	}
	var others []string
	count := 0
	for f, diags := range byFile {
		if f == edited {
			continue
		}
		if count >= maxOtherFiles {
			break
		}
		others = append(others, f+":\n"+diagBlock(diags))
		count++
	}
	if len(others) > 0 {
		parts = append(parts, "\n\ntsc errors in other files:\n"+strings.Join(others, "\n"))
	}
	return strings.Join(parts, "")
}
