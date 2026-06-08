// Package policy implements resource governance: dev ~= 50% / prod ~= 80%.
// Mirrors the Python resource_policy.
package policy

import (
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"

	"optimaize-videomaker-go/internal/types"
	"optimaize-videomaker-go/internal/winapi"
)

var profileTargets = map[string]float64{"dev": 0.5, "prod": 0.8}

const (
	defaultProfile          = "dev"
	minRAMBytesPerSandbox   = 256 * 1024 * 1024
	minCPURatePct           = 5.0
)

var defaultMaxSandboxes = map[string]int{"dev": 2, "prod": 4}

type Policy struct {
	Profile                string  `json:"profile"`
	TargetPct              float64 `json:"target_pct"`
	PhysicalCores          int     `json:"physical_cores"`
	TotalRAMGb             float64 `json:"total_ram_gb"`
	AvailableRAMGb         float64 `json:"available_ram_gb"`
	MaxConcurrentSandboxes int     `json:"max_concurrent_sandboxes"`
	CPUBudgetPct           float64 `json:"cpu_budget_pct"`
	RAMBudgetBytes         int64   `json:"ram_budget_bytes"`
	PerSandboxCPUPct       float64 `json:"per_sandbox_cpu_pct"`
	PerSandboxRAMBytes     int64   `json:"per_sandbox_ram_bytes"`
}

func ResolveProfile() string {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("OPTIMAIZE_ENV")))
	switch raw {
	case "prod", "production":
		return "prod"
	case "dev", "development", "local", "":
		return "dev"
	default:
		log.Printf("Unknown OPTIMAIZE_ENV=%s; defaulting to dev.", raw)
		return defaultProfile
	}
}

func physicalCores() int {
	// runtime.NumCPU is logical; assume 2-way SMT like the Python fallback.
	n := runtime.NumCPU() / 2
	if n < 1 {
		return 1
	}
	return n
}

func maxSandboxes(profile string) int {
	if v := os.Getenv("OPTIMAIZE_WORK_MAX_SANDBOXES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			return n
		}
		log.Printf("Invalid OPTIMAIZE_WORK_MAX_SANDBOXES=%s; ignoring.", v)
	}
	if n, ok := defaultMaxSandboxes[profile]; ok {
		return n
	}
	return 2
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}

// Get builds the active policy. totalRAMGb/availRAMGb come from the OS probe.
func Get(profile string) Policy {
	if profile == "" {
		profile = ResolveProfile()
	}
	target := profileTargets[profile]
	if target == 0 {
		target = profileTargets[defaultProfile]
	}
	cores := physicalCores()
	totalRAM, availRAM := winapi.MemGb()
	maxN := maxSandboxes(profile)

	cpuBudget := round2(100.0 * target)
	ramBudget := int64(totalRAM * target * 1024 * 1024 * 1024)
	perCPU := round2(cpuBudget / float64(maxN))
	if perCPU < minCPURatePct {
		perCPU = minCPURatePct
	}
	perRAM := ramBudget / int64(maxN)
	if perRAM < minRAMBytesPerSandbox {
		perRAM = minRAMBytesPerSandbox
	}

	return Policy{
		Profile:                profile,
		TargetPct:              target,
		PhysicalCores:          cores,
		TotalRAMGb:             round2(totalRAM),
		AvailableRAMGb:         round2(availRAM),
		MaxConcurrentSandboxes: maxN,
		CPUBudgetPct:           cpuBudget,
		RAMBudgetBytes:         ramBudget,
		PerSandboxCPUPct:       perCPU,
		PerSandboxRAMBytes:     perRAM,
	}
}

func (p Policy) DefaultQuota() types.SandboxQuota {
	return types.SandboxQuota{
		CPURatePct:        p.PerSandboxCPUPct,
		RAMBytes:          p.PerSandboxRAMBytes,
		MaxProcesses:      64,
		WallClockTimeoutS: 300.0,
		Network:           "none",
		Integrity:         "low",
	}
}

type Admission struct {
	OK     bool
	Reason string
}

func CheckAdmission(requestedRAM int64, liveSandboxes int, p Policy) Admission {
	if liveSandboxes >= p.MaxConcurrentSandboxes {
		return Admission{false, "Concurrency cap reached for the " + p.Profile + " profile."}
	}
	if requestedRAM > p.RAMBudgetBytes {
		return Admission{false, "Requested RAM exceeds the " + p.Profile + " budget."}
	}
	availBytes := int64(p.AvailableRAMGb * 1024 * 1024 * 1024)
	if requestedRAM > availBytes {
		return Admission{false, "Not enough free RAM right now."}
	}
	return Admission{true, "OK within " + p.Profile + " budget."}
}
