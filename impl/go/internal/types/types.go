// Package types holds the shared domain models and JSON wire shapes.
// The wire format matches the Python module exactly (snake_case keys).
package types

import "fmt"

type SandboxQuota struct {
	CPURatePct        float64 `json:"cpu_rate_pct"`
	RAMBytes          int64   `json:"ram_bytes"`
	MaxProcesses      int     `json:"max_processes"`
	WallClockTimeoutS float64 `json:"wall_clock_timeout_s"`
	Network           string  `json:"network"`
	Integrity         string  `json:"integrity"`
}

type SandboxConfig struct {
	SandboxID string
	Workdir   string
	Quota     SandboxQuota
	Backend   string
	Env       map[string]string
}

type ExecResult struct {
	ExitCode    int     `json:"exit_code"`
	Stdout      string  `json:"stdout"`
	Stderr      string  `json:"stderr"`
	DurationS   float64 `json:"duration_s"`
	TimedOut    bool    `json:"timed_out"`
	KilledByCap bool    `json:"killed_by_cap"`
}

func (r ExecResult) OK() bool {
	return r.ExitCode == 0 && !r.TimedOut && !r.KilledByCap
}

type FileEntry struct {
	Path     string  `json:"path"`
	IsDir    bool    `json:"is_dir"`
	Size     int64   `json:"size"`
	Modified float64 `json:"modified"`
}

type ResourceUsage struct {
	CPUPercent      float64 `json:"cpu_percent"`
	RAMBytes        int64   `json:"ram_bytes"`
	PeakRAMBytes    int64   `json:"peak_ram_bytes"`
	ActiveProcesses int     `json:"active_processes"`
	WallClockS      float64 `json:"wall_clock_s"`
}

type SandboxInfo struct {
	SandboxID    string       `json:"sandbox_id"`
	Backend      string       `json:"backend"`
	SecurityTier string       `json:"security_tier"`
	State        string       `json:"state"`
	Workdir      string       `json:"workdir"`
	Quota        SandboxQuota `json:"quota"`
}

// WorkError carries an HTTP status, mirroring the Python error hierarchy.
type WorkError struct {
	Status  int
	Message string
}

func (e *WorkError) Error() string { return e.Message }

func newErr(status int, format string, args ...any) *WorkError {
	return &WorkError{Status: status, Message: fmt.Sprintf(format, args...)}
}

func BackendUnavailable(format string, args ...any) *WorkError { return newErr(501, format, args...) }
func AdmissionDenied(format string, args ...any) *WorkError     { return newErr(503, format, args...) }
func SandboxNotFound(format string, args ...any) *WorkError     { return newErr(404, format, args...) }
func PathEscape(format string, args ...any) *WorkError          { return newErr(400, format, args...) }
func OperationError(format string, args ...any) *WorkError      { return newErr(500, format, args...) }
