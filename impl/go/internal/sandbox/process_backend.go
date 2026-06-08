// Process sandbox backend (Windows). Host process caged by a Job Object and
// jailed to a per-sandbox workdir. Unlike the Node port, Go can create the
// child SUSPENDED, so it does the full cage-before-execute sequence:
// spawn suspended -> assign to job -> NtResumeProcess. Mirrors the Python backend.
package sandbox

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"optimaize-videomaker-go/internal/types"
	"optimaize-videomaker-go/internal/winapi"
)

type liveSandbox struct {
	config    types.SandboxConfig
	job       *winapi.JobObject
	createdAt time.Time
	peakRAM   int64
	mu        sync.Mutex
}

type ProcessBackend struct {
	mu        sync.Mutex
	sandboxes map[string]*liveSandbox
}

func NewProcessBackend() *ProcessBackend {
	return &ProcessBackend{sandboxes: make(map[string]*liveSandbox)}
}

func (b *ProcessBackend) Name() string         { return "process" }
func (b *ProcessBackend) SecurityTier() string { return "process" }
func (b *ProcessBackend) IsAvailable() bool    { return true }

func longPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if len(abs) >= 4 && abs[:4] == `\\?\` {
		return abs
	}
	if len(abs) >= 2 && abs[:2] == `\\` {
		return `\\?\UNC\` + abs[2:]
	}
	return `\\?\` + abs
}

func (b *ProcessBackend) get(id string) (*liveSandbox, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	sbx, ok := b.sandboxes[id]
	if !ok {
		return nil, types.SandboxNotFound("Sandbox not found: %s", id)
	}
	return sbx, nil
}

func (b *ProcessBackend) ensureJob(sbx *liveSandbox) (*winapi.JobObject, error) {
	sbx.mu.Lock()
	defer sbx.mu.Unlock()
	if sbx.job != nil {
		return sbx.job, nil
	}
	job, err := winapi.NewJobObject()
	if err != nil {
		return nil, err
	}
	q := sbx.config.Quota
	if err := job.Configure(q.RAMBytes, q.MaxProcesses, q.CPURatePct); err != nil {
		job.Close()
		return nil, err
	}
	sbx.job = job
	return job, nil
}

func (b *ProcessBackend) Create(config types.SandboxConfig) (types.SandboxInfo, error) {
	if err := os.MkdirAll(config.Workdir, 0o755); err != nil {
		return types.SandboxInfo{}, types.OperationError("mkdir workdir: %v", err)
	}
	b.mu.Lock()
	b.sandboxes[config.SandboxID] = &liveSandbox{config: config, createdAt: time.Now()}
	b.mu.Unlock()
	return types.SandboxInfo{
		SandboxID:    config.SandboxID,
		Backend:      "process",
		SecurityTier: "process",
		State:        "created",
		Workdir:      config.Workdir,
		Quota:        config.Quota,
	}, nil
}

func (b *ProcessBackend) Kill(id string) error {
	sbx, err := b.get(id)
	if err != nil {
		return err
	}
	if sbx.job != nil {
		sbx.job.Terminate(1)
	}
	return nil
}

func (b *ProcessBackend) Destroy(id string) {
	b.mu.Lock()
	sbx, ok := b.sandboxes[id]
	if ok {
		delete(b.sandboxes, id)
	}
	b.mu.Unlock()
	if ok && sbx.job != nil {
		sbx.job.Terminate(1)
		sbx.job.Close()
	}
}

func (b *ProcessBackend) Workdir(id string) (string, error) {
	sbx, err := b.get(id)
	if err != nil {
		return "", err
	}
	return sbx.config.Workdir, nil
}

// SpawnDaemon launches a long-running caged process (e.g. Remotion Studio) and
// returns its pid immediately. Output is discarded; reaped when the Job closes.
func (b *ProcessBackend) SpawnDaemon(id, command string, cwd string, env map[string]string) (int, error) {
	sbx, err := b.get(id)
	if err != nil {
		return 0, err
	}
	runCwd := sbx.config.Workdir
	if cwd != "" {
		if runCwd, err = resolveInJail(sbx.config.Workdir, cwd); err != nil {
			return 0, err
		}
	}
	cmd := exec.Command("cmd.exe", "/c", command)
	cmd.Dir = runCwd
	cmd.Env = mergeEnv(sbx.config.Env, env)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: winapi.SuspendedCreationFlags}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := uint32(cmd.Process.Pid)
	if job, jerr := b.ensureJob(sbx); jerr == nil {
		if h, aerr := job.AssignPid(pid); aerr == nil {
			winapi.ResumeProcess(h)
			winapi.CloseHandle(h)
		} else {
			resumeByPid(pid)
		}
	} else {
		resumeByPid(pid)
	}
	go func() { _ = cmd.Wait() }() // reap when it eventually exits
	return int(pid), nil
}

// Exec runs a shell command (via cmd /c) caged in the job, jailed to the workdir.
func (b *ProcessBackend) Exec(id, command string, cwd string, env map[string]string, timeoutS float64) (types.ExecResult, error) {
	sbx, err := b.get(id)
	if err != nil {
		return types.ExecResult{}, err
	}
	runCwd := sbx.config.Workdir
	if cwd != "" {
		runCwd, err = resolveInJail(sbx.config.Workdir, cwd)
		if err != nil {
			return types.ExecResult{}, err
		}
	}
	if timeoutS == 0 {
		timeoutS = sbx.config.Quota.WallClockTimeoutS
	}

	cmd := exec.Command("cmd.exe", "/c", command)
	cmd.Dir = runCwd
	cmd.Env = mergeEnv(sbx.config.Env, env)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: winapi.SuspendedCreationFlags}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	started := time.Now()
	if err := cmd.Start(); err != nil {
		return types.ExecResult{ExitCode: -1, Stderr: err.Error(), DurationS: time.Since(started).Seconds()}, nil
	}

	// Cage BEFORE the child runs any instruction.
	pid := uint32(cmd.Process.Pid)
	if job, jerr := b.ensureJob(sbx); jerr == nil {
		if h, aerr := job.AssignPid(pid); aerr == nil {
			winapi.ResumeProcess(h)
			winapi.CloseHandle(h)
		} else {
			// Assign failed; resume anyway so the command can run (uncaged).
			resumeByPid(pid)
		}
	} else {
		resumeByPid(pid)
	}

	timedOut := false
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	if timeoutS > 0 {
		select {
		case <-done:
		case <-time.After(time.Duration(timeoutS * float64(time.Second))):
			timedOut = true
			if sbx.job != nil {
				sbx.job.Terminate(1)
			}
			cmd.Process.Kill()
			<-done
		}
	} else {
		<-done
	}

	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	} else {
		exitCode = -1
	}
	killedByCap := false
	if !timedOut && exitCode != 0 && sbx.job != nil {
		killedByCap = sbx.job.PeakJobMemory() >= int64(float64(sbx.config.Quota.RAMBytes)*0.95)
	}
	return types.ExecResult{
		ExitCode:    exitCode,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
		DurationS:   time.Since(started).Seconds(),
		TimedOut:    timedOut,
		KilledByCap: killedByCap,
	}, nil
}

func resumeByPid(pid uint32) {
	h, err := windows.OpenProcess(windows.PROCESS_ALL_ACCESS, false, pid)
	if err != nil {
		return
	}
	winapi.ResumeProcess(h)
	winapi.CloseHandle(h)
}

func mergeEnv(base, extra map[string]string) []string {
	m := map[string]string{}
	for _, kv := range os.Environ() {
		m[splitKey(kv)] = splitVal(kv)
	}
	for k, v := range base {
		m[k] = v
	}
	for k, v := range extra {
		m[k] = v
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

func splitKey(kv string) string {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i]
		}
	}
	return kv
}
func splitVal(kv string) string {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[i+1:]
		}
	}
	return ""
}

func (b *ProcessBackend) Usage(id string) (types.ResourceUsage, error) {
	sbx, err := b.get(id)
	if err != nil {
		return types.ResourceUsage{}, err
	}
	active, peak := 0, sbx.peakRAM
	if sbx.job != nil {
		active = sbx.job.ActiveProcesses()
		if p := sbx.job.PeakJobMemory(); p > peak {
			peak = p
			sbx.peakRAM = p
		}
	}
	return types.ResourceUsage{
		CPUPercent:      0,
		RAMBytes:        peak,
		PeakRAMBytes:    peak,
		ActiveProcesses: active,
		WallClockS:      time.Since(sbx.createdAt).Seconds(),
	}, nil
}
