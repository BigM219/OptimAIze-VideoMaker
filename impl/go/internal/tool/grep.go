// grep — regex content search over the jailed project tree (Go parity of grep.ts).
package tool

import (
	"fmt"
	"regexp"
	"strings"
)

const grepMatchLimit = 100

// includeMatcher translates a simple include pattern (e.g. "*.tsx",
// "*.{ts,tsx}") to a basename matcher. Empty include matches everything.
func includeMatcher(include string) func(string) bool {
	if include == "" {
		return func(string) bool { return true }
	}
	// Expand {a,b} -> (a|b), then escape regex specials except the alternation,
	// then * -> [^/]*, ? -> [^/].
	expanded := regexp.MustCompile(`\{([^}]*)\}`).ReplaceAllStringFunc(include, func(m string) string {
		inner := strings.TrimSuffix(strings.TrimPrefix(m, "{"), "}")
		return "(" + strings.ReplaceAll(inner, ",", "|") + ")"
	})
	var b strings.Builder
	b.WriteString("^")
	for _, r := range expanded {
		switch r {
		case '*':
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		case '(', ')', '|':
			b.WriteRune(r)
		case '.', '+', '^', '$', '{', '}', '[', ']', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return func(string) bool { return true }
	}
	return func(p string) bool {
		base := p
		if i := strings.LastIndex(p, "/"); i >= 0 {
			base = p[i+1:]
		}
		return re.MatchString(base)
	}
}

// GrepTool searches file contents by regular expression.
var GrepTool = Def{
	ID:          "grep",
	Description: `Search file contents by regular expression across the project. Returns file paths with line numbers and the matching lines. Use include to filter files (e.g. "*.tsx").`,
	Parameters: []Param{
		{Name: "pattern", Type: "string", Description: "Regex to search for in file contents", Required: true},
		{Name: "path", Type: "string", Description: "Directory to search under (default: project root)"},
		{Name: "include", Type: "string", Description: `File filter, e.g. "*.tsx" or "*.{ts,tsx}"`},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		pat, err := reqString(args, "pattern")
		if err != nil {
			return nil, err
		}
		p, err := optString(args, "path")
		if err != nil {
			return nil, err
		}
		inc, err := optString(args, "include")
		if err != nil {
			return nil, err
		}
		return map[string]any{"pattern": pat, "path": p, "include": inc}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		pattern := args["pattern"].(string)
		root := args["path"].(string)
		if root == "" {
			root = "."
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return Result{Title: pattern, Output: "Invalid regex: " + err.Error(), Metadata: map[string]any{"error": "bad_regex"}}, nil
		}
		matchFile := includeMatcher(args["include"].(string))

		type fileHits struct {
			path  string
			lines []string
		}
		var perFile []fileHits
		total := 0
		truncated := false
		for _, f := range walkFiles(ctx, root, 5000) {
			if !matchFile(f) {
				continue
			}
			content, err := ctx.Store.ReadFile(ctx.ProjectID, f)
			if err != nil {
				continue
			}
			var hits []string
			for i, line := range strings.Split(content, "\n") {
				if re.MatchString(line) {
					total++
					if total > grepMatchLimit {
						truncated = true
						break
					}
					if len(line) > maxLineLength {
						line = line[:maxLineLength] + " …"
					}
					hits = append(hits, fmt.Sprintf("  Line %d: %s", i+1, line))
				}
			}
			if len(hits) > 0 {
				perFile = append(perFile, fileHits{f, hits})
			}
			if truncated {
				break
			}
		}
		if total == 0 {
			return Result{Title: pattern, Output: "No files found", Metadata: map[string]any{"matches": 0}}, nil
		}
		header := fmt.Sprintf("Found %d matches", total)
		if truncated {
			header += fmt.Sprintf(" (showing first %d)", grepMatchLimit)
		}
		var b strings.Builder
		b.WriteString(header)
		for _, pf := range perFile {
			b.WriteString("\n\n" + pf.path + ":\n" + strings.Join(pf.lines, "\n"))
		}
		return Result{Title: pattern, Output: b.String(), Metadata: map[string]any{"matches": total, "truncated": truncated}}, nil
	},
}
