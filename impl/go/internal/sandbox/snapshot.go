// Snapshot/restore the sandbox workdir as a zip, using Windows extended-length
// paths so deep node_modules survive MAX_PATH. Mirrors the Python implementation,
// including the zip-slip guard on restore.
package sandbox

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"

	"optimaize-videomaker-go/internal/types"
)

func SnapshotWorkdir(workdir, destZip string) error {
	root, _ := filepath.Abs(workdir)
	if err := os.MkdirAll(filepath.Dir(destZip), 0o755); err != nil {
		return types.OperationError("mkdir snapshots: %v", err)
	}
	out, err := os.Create(longPath(destZip))
	if err != nil {
		return types.OperationError("create zip: %v", err)
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	defer zw.Close()

	return filepath.WalkDir(longPath(root), func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil // skip unreadable / dirs (entries created implicitly)
		}
		// Strip any extended-length prefix to compute a portable archive name.
		plain := p
		if strings.HasPrefix(plain, `\\?\UNC\`) {
			plain = `\\` + plain[len(`\\?\UNC\`):]
		} else if strings.HasPrefix(plain, `\\?\`) {
			plain = plain[len(`\\?\`):]
		}
		rel, rerr := filepath.Rel(root, plain)
		if rerr != nil {
			return nil
		}
		rel = strings.ReplaceAll(rel, string(filepath.Separator), "/")
		data, rerr := os.ReadFile(p)
		if rerr != nil {
			return nil // transient/locked; skip like the Python path
		}
		w, werr := zw.Create(rel)
		if werr != nil {
			return nil
		}
		_, _ = w.Write(data)
		return nil
	})
}

func RestoreInto(workdir, srcZip string) error {
	root, _ := filepath.Abs(workdir)
	zr, err := zip.OpenReader(longPath(srcZip))
	if err != nil {
		return types.SandboxNotFound("Snapshot archive not found: %s", srcZip)
	}
	defer zr.Close()

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		target := filepath.Join(root, filepath.FromSlash(f.Name))
		// zip-slip guard.
		rel, rerr := filepath.Rel(root, target)
		if rerr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return types.OperationError("Unsafe path in snapshot: %s", f.Name)
		}
		if err := os.MkdirAll(filepath.Dir(longPath(target)), 0o755); err != nil {
			return types.OperationError("mkdir restore: %v", err)
		}
		rc, oerr := f.Open()
		if oerr != nil {
			return types.OperationError("open member: %v", oerr)
		}
		dst, cerr := os.Create(longPath(target))
		if cerr != nil {
			rc.Close()
			return types.OperationError("create file: %v", cerr)
		}
		_, _ = io.Copy(dst, rc)
		dst.Close()
		rc.Close()
	}
	return nil
}
