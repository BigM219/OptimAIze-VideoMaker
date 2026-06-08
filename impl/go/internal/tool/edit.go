// edit — exact string replacement with a 3-strategy matcher (Go parity of edit.ts).
// See docs/harness-design.md §5.1. Ports Simple → LineTrimmed → BlockAnchor so
// the model tolerates small whitespace drift without re-sending the whole file.
package tool

import (
	"fmt"
	"strings"
)

// A replacer yields candidate substrings of content equal to find under its
// strategy. The first usable match wins.
type replacer func(content, find string) []string

func simpleReplacer(_ , find string) []string { return []string{find} }

func lineTrimmedReplacer(content, find string) []string {
	originalLines := strings.Split(content, "\n")
	searchLines := strings.Split(find, "\n")
	if len(searchLines) > 0 && searchLines[len(searchLines)-1] == "" {
		searchLines = searchLines[:len(searchLines)-1]
	}
	if len(searchLines) == 0 {
		return nil
	}
	var out []string
	for i := 0; i <= len(originalLines)-len(searchLines); i++ {
		match := true
		for j := 0; j < len(searchLines); j++ {
			if strings.TrimSpace(originalLines[i+j]) != strings.TrimSpace(searchLines[j]) {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		start := 0
		for k := 0; k < i; k++ {
			start += len(originalLines[k]) + 1
		}
		end := start
		for k := 0; k < len(searchLines); k++ {
			end += len(originalLines[i+k]) + 1
		}
		if end > len(content) {
			end = len(content)
		}
		out = append(out, content[start:end])
	}
	return out
}

func blockAnchorReplacer(content, find string) []string {
	originalLines := strings.Split(content, "\n")
	searchLines := strings.Split(find, "\n")
	if len(searchLines) > 0 && searchLines[len(searchLines)-1] == "" {
		searchLines = searchLines[:len(searchLines)-1]
	}
	if len(searchLines) < 3 {
		return nil
	}
	firstAnchor := strings.TrimSpace(searchLines[0])
	lastAnchor := strings.TrimSpace(searchLines[len(searchLines)-1])
	blockSize := len(searchLines)
	maxDelta := blockSize / 4
	if maxDelta < 1 {
		maxDelta = 1
	}
	var out []string
	for i := 0; i < len(originalLines); i++ {
		if strings.TrimSpace(originalLines[i]) != firstAnchor {
			continue
		}
		for span := blockSize - maxDelta; span <= blockSize+maxDelta; span++ {
			endIdx := i + span - 1
			if endIdx <= i || endIdx >= len(originalLines) {
				continue
			}
			if strings.TrimSpace(originalLines[endIdx]) != lastAnchor {
				continue
			}
			start := 0
			for k := 0; k < i; k++ {
				start += len(originalLines[k]) + 1
			}
			end := start
			for k := i; k <= endIdx; k++ {
				end += len(originalLines[k]) + 1
			}
			if end > len(content) {
				end = len(content)
			}
			out = append(out, content[start:end])
		}
	}
	return out
}

var editStrategies = []replacer{simpleReplacer, lineTrimmedReplacer, blockAnchorReplacer}

func isDisproportionate(matched, find string) bool {
	ml := len(strings.Split(matched, "\n"))
	fl := len(strings.Split(find, "\n"))
	max3 := fl + 3
	if fl*2 > max3 {
		max3 = fl * 2
	}
	if ml >= max3 {
		return true
	}
	if fl > 1 {
		mt := len(strings.TrimSpace(matched))
		ft := len(strings.TrimSpace(find))
		lim := ft + 500
		if ft*4 > lim {
			lim = ft * 4
		}
		if mt > lim {
			return true
		}
	}
	return false
}

func indicesOf(content, match string) int {
	n := 0
	from := 0
	for {
		idx := strings.Index(content[from:], match)
		if idx == -1 {
			break
		}
		n++
		step := idx + len(match)
		if step < 1 {
			step = 1
		}
		from += step
		if from > len(content) {
			break
		}
	}
	return n
}

// EditTool replaces an exact string in a file (no full-file rewrite).
var EditTool = Def{
	ID: "edit",
	Description: "Replace an exact string in a file (no full-file rewrite — saves tokens). oldString must match the file exactly (whitespace included); " +
		"if it appears more than once, add surrounding context or set replaceAll. Read the file first to copy the exact text (omit the line-number prefix).",
	Mutating: true,
	Parameters: []Param{
		{Name: "filePath", Type: "string", Description: "Relative path to the file", Required: true},
		{Name: "oldString", Type: "string", Description: "Exact text to replace", Required: true},
		{Name: "newString", Type: "string", Description: "Replacement text", Required: true},
		{Name: "replaceAll", Type: "boolean", Description: "Replace all occurrences (default false)"},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		fp, err := reqString(args, "filePath")
		if err != nil {
			return nil, err
		}
		norm, err := assertProjectPath(fp)
		if err != nil {
			return nil, err
		}
		oldString, err := reqString(args, "oldString")
		if err != nil {
			return nil, err
		}
		newString, ok := args["newString"].(string)
		if !ok {
			return nil, validationErr("%q is required and must be a string.", "newString")
		}
		if oldString == newString {
			return nil, validationErr("No changes to apply: oldString and newString are identical.")
		}
		replaceAll, err := optBool(args, "replaceAll")
		if err != nil {
			return nil, err
		}
		return map[string]any{"filePath": norm, "oldString": oldString, "newString": newString, "replaceAll": replaceAll}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		fp := args["filePath"].(string)
		oldString := args["oldString"].(string)
		newString := args["newString"].(string)
		replaceAll := args["replaceAll"].(bool)

		content, err := ctx.Store.ReadFile(ctx.ProjectID, fp)
		if err != nil {
			return Result{Title: fp, Output: "File not found: " + fp, Metadata: map[string]any{"error": "not_found"}}, nil
		}

		matched := ""
		found := false
		for si, strategy := range editStrategies {
			for _, candidate := range strategy(content, oldString) {
				if candidate == "" || !strings.Contains(content, candidate) {
					continue
				}
				if candidate != oldString && isDisproportionate(candidate, oldString) {
					continue
				}
				occ := indicesOf(content, candidate)
				if occ == 0 {
					continue
				}
				if occ > 1 && !replaceAll {
					if si == 0 {
						return Result{Title: fp, Output: fmt.Sprintf("Found %d matches for oldString. Provide more surrounding context to make it unique, or set replaceAll: true.", occ), Metadata: map[string]any{"error": "ambiguous", "matches": occ}}, nil
					}
					continue
				}
				matched = candidate
				found = true
				break
			}
			if found {
				break
			}
		}

		if !found {
			return Result{Title: fp, Output: "Could not find oldString in the file. It must match exactly, including whitespace and indentation. Read the file again and copy the exact text (without the line-number prefix).", Metadata: map[string]any{"error": "no_match"}}, nil
		}

		var next string
		count := 0
		if replaceAll {
			count = indicesOf(content, matched)
			next = strings.ReplaceAll(content, matched, newString)
		} else {
			idx := strings.Index(content, matched)
			next = content[:idx] + newString + content[idx+len(matched):]
			count = 1
		}
		if err := ctx.Store.WriteFile(ctx.ProjectID, fp, next); err != nil {
			return Result{}, err
		}
		plural := "s"
		if count == 1 {
			plural = ""
		}
		ctx.LogStep("scene", fmt.Sprintf("Edited %s (%d replacement%s)", fp, count, plural), StepExtra{Kind: "write_file", Path: fp, Content: newString})
		return Result{Title: fp, Output: fmt.Sprintf("Edit applied successfully (%d replacement%s).", count, plural), Metadata: map[string]any{"filePath": fp, "replacements": count}}, nil
	},
}
