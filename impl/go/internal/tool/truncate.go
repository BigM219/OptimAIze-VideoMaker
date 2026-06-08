// Output truncation (Go parity of tool/truncate.ts). See docs/harness-design.md §6.
package tool

import (
	"fmt"
	"strings"
)

const (
	outputCap     = 50 * 1024 // 50 KB default tool-output cap
	maxLineLength = 2000       // per-line cap
)

// capLines truncates any single line longer than maxLineLength.
func capLines(text string) string {
	if !strings.Contains(text, "\n") && len(text) <= maxLineLength {
		return text
	}
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if len(l) > maxLineLength {
			lines[i] = l[:maxLineLength] + " … (line truncated)"
		}
	}
	return strings.Join(lines, "\n")
}

// truncateOutput bounds output to cap; on overflow it persists the full text to
// out/.harness/ (inside the jailed workdir) and appends a pointer line.
func truncateOutput(ctx *Context, tool, text string, cap int) (output string, truncated bool, outputPath string) {
	capped := capLines(text)
	if len(capped) <= cap {
		return capped, false, ""
	}
	head := capped[:cap]
	rel := fmt.Sprintf("out/.harness/%s-%d.txt", tool, nowNano())
	if err := ctx.Store.WriteFile(ctx.ProjectID, rel, capped); err == nil {
		outputPath = rel
	}
	if outputPath != "" {
		return head + fmt.Sprintf("\n\n(Output truncated to %d KB. Full output saved to: %s)", cap/1024, outputPath), true, outputPath
	}
	return head + fmt.Sprintf("\n\n(Output truncated to %d KB.)", cap/1024), true, ""
}
