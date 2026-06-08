// File operations inside the jail + raw path resolution.
package sandbox

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"optimaize-videomaker-go/internal/types"
)

func (b *ProcessBackend) WriteFile(id, relPath, content string) (types.FileEntry, error) {
	sbx, err := b.get(id)
	if err != nil {
		return types.FileEntry{}, err
	}
	target, err := resolveInJail(sbx.config.Workdir, relPath)
	if err != nil {
		return types.FileEntry{}, err
	}
	if err := os.MkdirAll(filepath.Dir(longPath(target)), 0o755); err != nil {
		return types.FileEntry{}, types.OperationError("mkdir: %v", err)
	}
	if err := os.WriteFile(longPath(target), []byte(content), 0o644); err != nil {
		return types.FileEntry{}, types.OperationError("write: %v", err)
	}
	return entryFor(sbx.config.Workdir, target)
}

func (b *ProcessBackend) ReadFile(id, relPath string) (string, error) {
	sbx, err := b.get(id)
	if err != nil {
		return "", err
	}
	target, err := resolveInJail(sbx.config.Workdir, relPath)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(longPath(target))
	if err != nil {
		return "", types.SandboxNotFound("File not found: %s", relPath)
	}
	return string(data), nil
}

func (b *ProcessBackend) List(id, relPath string) ([]types.FileEntry, error) {
	sbx, err := b.get(id)
	if err != nil {
		return nil, err
	}
	if relPath == "" {
		relPath = "."
	}
	target, err := resolveInJail(sbx.config.Workdir, relPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(longPath(target))
	if err != nil {
		return nil, types.SandboxNotFound("Path not found: %s", relPath)
	}
	if !info.IsDir() {
		e, err := entryFor(sbx.config.Workdir, target)
		if err != nil {
			return nil, err
		}
		return []types.FileEntry{e}, nil
	}
	dents, err := os.ReadDir(longPath(target))
	if err != nil {
		return nil, types.OperationError("readdir: %v", err)
	}
	names := make([]string, 0, len(dents))
	for _, d := range dents {
		names = append(names, d.Name())
	}
	sort.Strings(names)
	out := make([]types.FileEntry, 0, len(names))
	for _, n := range names {
		e, err := entryFor(sbx.config.Workdir, filepath.Join(target, n))
		if err == nil {
			out = append(out, e)
		}
	}
	return out, nil
}

func (b *ProcessBackend) Remove(id, relPath string) error {
	sbx, err := b.get(id)
	if err != nil {
		return err
	}
	target, err := resolveInJail(sbx.config.Workdir, relPath)
	if err != nil {
		return err
	}
	os.RemoveAll(longPath(target))
	return nil
}

// RawPath returns the absolute on-disk path for streaming (after jail check).
func (b *ProcessBackend) RawPath(id, relPath string) (string, error) {
	sbx, err := b.get(id)
	if err != nil {
		return "", err
	}
	target, err := resolveInJail(sbx.config.Workdir, relPath)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(longPath(target)); err != nil {
		return "", types.SandboxNotFound("File not found: %s", relPath)
	}
	return target, nil
}

func entryFor(workdir, abs string) (types.FileEntry, error) {
	info, err := os.Stat(longPath(abs))
	if err != nil {
		return types.FileEntry{}, types.OperationError("stat: %v", err)
	}
	rel, _ := filepath.Rel(workdir, abs)
	rel = strings.ReplaceAll(rel, string(filepath.Separator), "/")
	size := info.Size()
	if info.IsDir() {
		size = 0
	}
	return types.FileEntry{
		Path:     rel,
		IsDir:    info.IsDir(),
		Size:     size,
		Modified: float64(info.ModTime().UnixNano()) / 1e9,
	}, nil
}
