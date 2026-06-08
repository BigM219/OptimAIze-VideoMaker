// glob — find project files by pattern (Go parity of glob.ts).
package tool

import (
	"fmt"
	"regexp"
	"strings"
)

const globLimit = 100

// globToRe translates a glob (**, *, ?) to a regexp anchored to the whole path.
func globToRe(glob string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(glob); i++ {
		c := glob[i]
		switch {
		case c == '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				b.WriteString(".*")
				i++
				if i+1 < len(glob) && glob[i+1] == '/' {
					i++
				}
			} else {
				b.WriteString("[^/]*")
			}
		case c == '?':
			b.WriteString("[^/]")
		case strings.ContainsRune(".+^${}()|[]\\", rune(c)):
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return regexp.MustCompile("^$")
	}
	return re
}

// GlobTool finds files by glob pattern.
var GlobTool = Def{
	ID:          "glob",
	Description: "Find files by glob pattern (e.g. src/**/*.tsx, **/Root.tsx). Returns matching project-relative paths. Use to locate files before reading them.",
	Parameters: []Param{
		{Name: "pattern", Type: "string", Description: "Glob pattern (** matches any depth)", Required: true},
		{Name: "path", Type: "string", Description: "Directory to search under (default project root)"},
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
		return map[string]any{"pattern": pat, "path": p}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		pattern := args["pattern"].(string)
		root := args["path"].(string)
		if root == "" {
			root = "."
		}
		re := globToRe(pattern)
		var matched []string
		for _, p := range walkFiles(ctx, root, 5000) {
			if re.MatchString(p) {
				matched = append(matched, p)
			}
		}
		truncated := len(matched) > globLimit
		shown := matched
		if truncated {
			shown = matched[:globLimit]
		}
		output := "No files found"
		if len(shown) > 0 {
			output = strings.Join(shown, "\n")
		}
		if truncated {
			output += fmt.Sprintf("\n\n(Results truncated: showing first %d of %d. Use a more specific pattern.)", globLimit, len(matched))
		}
		return Result{Title: pattern, Output: output, Metadata: map[string]any{"count": len(shown), "truncated": truncated}}, nil
	},
}
