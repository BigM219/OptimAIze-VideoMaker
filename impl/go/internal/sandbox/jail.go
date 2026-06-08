// Filesystem jail: resolve a client-supplied relative path strictly inside the
// sandbox workdir. Mirrors the Python resolve_in_jail.
package sandbox

import (
	"path/filepath"
	"strings"

	"optimaize-videomaker-go/internal/types"
)

func resolveInJail(workdir, relPath string) (string, error) {
	if relPath == "" {
		return "", types.PathEscape("Path is required.")
	}
	// Reject absolute paths and drive/UNC roots.
	if filepath.IsAbs(relPath) {
		return "", types.PathEscape("Absolute paths are not allowed: %s", relPath)
	}
	candidate := strings.ReplaceAll(relPath, "\\", "/")
	candidate = strings.TrimLeft(candidate, "/")
	first := candidate
	if idx := strings.IndexByte(candidate, '/'); idx >= 0 {
		first = candidate[:idx]
	}
	if strings.Contains(first, ":") {
		return "", types.PathEscape("Drive-absolute paths are not allowed: %s", relPath)
	}

	root, err := filepath.Abs(workdir)
	if err != nil {
		return "", types.OperationError("bad workdir: %v", err)
	}
	target := filepath.Join(root, filepath.FromSlash(candidate))
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", types.PathEscape("Path escapes the sandbox: %s", relPath)
	}

	// Symlink/reparse check via EvalSymlinks where the path exists.
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		realRoot = root
	}
	if real, err := filepath.EvalSymlinks(target); err == nil {
		rr, err2 := filepath.Rel(realRoot, real)
		if err2 != nil || rr == ".." || strings.HasPrefix(rr, ".."+string(filepath.Separator)) || filepath.IsAbs(rr) {
			return "", types.PathEscape("Path escapes the sandbox via a link: %s", relPath)
		}
	}
	return target, nil
}
