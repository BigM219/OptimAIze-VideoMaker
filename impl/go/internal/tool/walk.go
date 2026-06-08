// Shared recursive file walk over the jailed project tree (Go parity of walk.ts).
package tool

import "regexp"

var skipDir = regexp.MustCompile(`(^|/)(node_modules|\.git|\.harness)(/|$)`)

// walkFiles returns a depth-first list of all files under root, bounded by cap.
func walkFiles(ctx *Context, root string, cap int) []string {
	var out []string
	var visit func(rel string)
	visit = func(rel string) {
		if len(out) >= cap {
			return
		}
		entries, err := ctx.Store.ListFiles(ctx.ProjectID, rel)
		if err != nil {
			return
		}
		for _, e := range entries {
			if len(out) >= cap {
				return
			}
			if skipDir.MatchString("/" + e.Path) {
				continue
			}
			if e.IsDir {
				visit(e.Path)
			} else {
				out = append(out, e.Path)
			}
		}
	}
	visit(root)
	return out
}
