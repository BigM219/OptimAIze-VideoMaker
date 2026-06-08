// SandboxManager: admission, workdir allocation, lifecycle, snapshot/restore.
// Mirrors the Python manager, including the ~/.optimaize-work root.
package sandbox

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"optimaize-videomaker-go/internal/policy"
	"optimaize-videomaker-go/internal/types"
)

const DefaultBackend = "process"

type Manager struct {
	mu            sync.Mutex
	root          string
	snapshotsRoot string
	backend       *ProcessBackend
	live          map[string]types.SandboxInfo
	profile       string
}

func defaultSandboxRoot() string {
	if v := os.Getenv("OPTIMAIZE_WORK_SANDBOX_ROOT"); v != "" {
		abs, _ := filepath.Abs(v)
		return abs
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".optimaize-work", "sandboxes")
}

func NewManager() *Manager {
	root := defaultSandboxRoot()
	return &Manager{
		root:          root,
		snapshotsRoot: filepath.Join(filepath.Dir(root), "snapshots"),
		backend:       NewProcessBackend(),
		live:          make(map[string]types.SandboxInfo),
	}
}

func (m *Manager) Policy() policy.Policy { return policy.Get(m.profile) }
func (m *Manager) Backend() *ProcessBackend { return m.backend }

func (m *Manager) LiveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.live)
}

func newID(prefix string) string {
	buf := make([]byte, 6)
	_, _ = rand.Read(buf)
	return prefix + hex.EncodeToString(buf)
}

func (m *Manager) ListBackends() []map[string]any {
	type desc struct {
		name, tier string
		avail      bool
		net        bool
	}
	all := []desc{
		{"process", "process", m.backend.IsAvailable(), false},
		{"windows-sandbox", "vm", false, true},
		{"wsl", "container", false, true},
		{"e2b", "remote", false, true},
	}
	out := make([]map[string]any, 0, len(all))
	for _, d := range all {
		out = append(out, map[string]any{
			"name":                d.name,
			"security_tier":       d.tier,
			"available":           d.avail,
			"network_isolation":   d.net,
			"filesystem_isolation": true,
			"default":             d.name == DefaultBackend,
		})
	}
	return out
}

func (m *Manager) Create(backend string, quota *types.SandboxQuota, env map[string]string) (types.SandboxInfo, error) {
	if backend == "" {
		backend = DefaultBackend
	}
	if strings.ToLower(backend) != "process" {
		return types.SandboxInfo{}, types.BackendUnavailable("Backend '%s' is registered but not available on this host.", backend)
	}
	if !m.backend.IsAvailable() {
		return types.SandboxInfo{}, types.BackendUnavailable("The process backend requires Windows.")
	}
	pol := m.Policy()
	q := pol.DefaultQuota()
	if quota != nil {
		q = *quota
	}
	m.mu.Lock()
	adm := policy.CheckAdmission(q.RAMBytes, len(m.live), pol)
	if !adm.OK {
		m.mu.Unlock()
		return types.SandboxInfo{}, types.AdmissionDenied("%s", adm.Reason)
	}
	sid := newID("sbx_")
	workdir := filepath.Join(m.root, sid)
	m.mu.Unlock()

	if err := os.MkdirAll(workdir, 0o755); err != nil {
		return types.SandboxInfo{}, types.OperationError("mkdir workdir: %v", err)
	}
	info, err := m.backend.Create(types.SandboxConfig{
		SandboxID: sid, Workdir: workdir, Quota: q, Backend: "process", Env: env,
	})
	if err != nil {
		return types.SandboxInfo{}, err
	}
	m.mu.Lock()
	m.live[sid] = info
	m.mu.Unlock()
	return info, nil
}

func (m *Manager) Get(id string) (types.SandboxInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	info, ok := m.live[id]
	if !ok {
		return types.SandboxInfo{}, types.SandboxNotFound("Sandbox not found: %s", id)
	}
	return info, nil
}

func (m *Manager) List() []types.SandboxInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]types.SandboxInfo, 0, len(m.live))
	for _, v := range m.live {
		out = append(out, v)
	}
	return out
}

func (m *Manager) Kill(id string) error {
	if _, err := m.Get(id); err != nil {
		return err
	}
	return m.backend.Kill(id)
}

func (m *Manager) Destroy(id string) error {
	info, err := m.Get(id)
	if err != nil {
		return err
	}
	m.backend.Destroy(id)
	m.mu.Lock()
	delete(m.live, id)
	m.mu.Unlock()
	os.RemoveAll(longPath(info.Workdir))
	return nil
}

func (m *Manager) DestroyAll() {
	for _, info := range m.List() {
		_ = m.Destroy(info.SandboxID)
	}
}

func (m *Manager) Snapshot(id string) (string, error) {
	info, err := m.Get(id)
	if err != nil {
		return "", err
	}
	ref := newID("snap_")
	if err := os.MkdirAll(m.snapshotsRoot, 0o755); err != nil {
		return "", types.OperationError("mkdir snapshots: %v", err)
	}
	destZip := filepath.Join(m.snapshotsRoot, ref+".zip")
	if err := SnapshotWorkdir(info.Workdir, destZip); err != nil {
		return "", err
	}
	sidecar := map[string]any{
		"ref": ref, "source_sandbox": id, "backend": info.Backend, "quota": info.Quota,
	}
	data, _ := json.MarshalIndent(sidecar, "", "  ")
	_ = os.WriteFile(filepath.Join(m.snapshotsRoot, ref+".json"), data, 0o644)
	return ref, nil
}

func (m *Manager) Restore(ref string) (types.SandboxInfo, error) {
	srcZip := filepath.Join(m.snapshotsRoot, ref+".zip")
	if _, err := os.Stat(srcZip); err != nil {
		return types.SandboxInfo{}, types.SandboxNotFound("Snapshot not found: %s", ref)
	}
	var quota *types.SandboxQuota
	if data, err := os.ReadFile(filepath.Join(m.snapshotsRoot, ref+".json")); err == nil {
		var meta struct {
			Quota types.SandboxQuota `json:"quota"`
		}
		if json.Unmarshal(data, &meta) == nil {
			quota = &meta.Quota
		}
	}
	info, err := m.Create("process", quota, nil)
	if err != nil {
		return types.SandboxInfo{}, err
	}
	if err := RestoreInto(info.Workdir, srcZip); err != nil {
		return types.SandboxInfo{}, err
	}
	return info, nil
}

func (m *Manager) ListSnapshots() []map[string]any {
	dents, err := os.ReadDir(m.snapshotsRoot)
	if err != nil {
		return []map[string]any{}
	}
	names := []string{}
	for _, d := range dents {
		if strings.HasSuffix(d.Name(), ".zip") {
			names = append(names, d.Name())
		}
	}
	sort.Strings(names)
	out := make([]map[string]any, 0, len(names))
	for _, n := range names {
		ref := strings.TrimSuffix(n, ".zip")
		entry := map[string]any{"ref": ref}
		if fi, err := os.Stat(filepath.Join(m.snapshotsRoot, n)); err == nil {
			entry["size_bytes"] = fi.Size()
		}
		if data, err := os.ReadFile(filepath.Join(m.snapshotsRoot, ref+".json")); err == nil {
			var meta map[string]any
			if json.Unmarshal(data, &meta) == nil {
				for k, v := range meta {
					entry[k] = v
				}
			}
		}
		out = append(out, entry)
	}
	return out
}
