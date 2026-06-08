// Package winapi wraps the Windows Job Object, GlobalMemoryStatusEx, and
// NtResumeProcess. Equivalent to the Python winapi layer, using x/sys/windows.
package winapi

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Creation flags for a caged child process.
const (
	CREATE_SUSPENDED         = 0x00000004
	CREATE_NO_WINDOW         = 0x08000000
	CREATE_NEW_PROCESS_GROUP = 0x00000200
	SuspendedCreationFlags   = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
)

const (
	classBasicAccounting = 1
	classExtendedLimit   = 9
	classCPURateControl  = 15

	jobLimitActiveProcess            = 0x00000008
	jobLimitJobMemory                = 0x00000200
	jobLimitDieOnUnhandledException  = 0x00000400
	jobLimitKillOnJobClose           = 0x00002000
	jobCPURateControlEnable          = 0x00000001
	jobCPURateControlHardCap         = 0x00000004
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type jobObjectBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

type jobObjectCPURateControlInformation struct {
	ControlFlags uint32
	Value        uint32 // CpuRate (union); we use the hard-cap rate
}

var (
	modkernel32                = windows.NewLazySystemDLL("kernel32.dll")
	modntdll                   = windows.NewLazySystemDLL("ntdll.dll")
	procCreateJobObjectW       = modkernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObj   = modkernel32.NewProc("SetInformationJobObject")
	procQueryInformationJobObj = modkernel32.NewProc("QueryInformationJobObject")
	procAssignProcessToJobObj  = modkernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject     = modkernel32.NewProc("TerminateJobObject")
	procGlobalMemoryStatusEx   = modkernel32.NewProc("GlobalMemoryStatusEx")
	procNtResumeProcess        = modntdll.NewProc("NtResumeProcess")
)

type JobObject struct {
	handle windows.Handle
	closed bool
}

func NewJobObject() (*JobObject, error) {
	h, _, err := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return nil, fmt.Errorf("CreateJobObjectW failed: %v", err)
	}
	return &JobObject{handle: windows.Handle(h)}, nil
}

func (j *JobObject) Configure(ramBytes int64, maxProcesses int, cpuRatePct float64) error {
	if maxProcesses < 1 {
		maxProcesses = 1
	}
	ext := jobObjectExtendedLimitInformation{}
	ext.BasicLimitInformation.LimitFlags = jobLimitKillOnJobClose | jobLimitDieOnUnhandledException |
		jobLimitJobMemory | jobLimitActiveProcess
	ext.BasicLimitInformation.ActiveProcessLimit = uint32(maxProcesses)
	ext.JobMemoryLimit = uintptr(ramBytes)
	ret, _, err := procSetInformationJobObj.Call(
		uintptr(j.handle), classExtendedLimit,
		uintptr(unsafe.Pointer(&ext)), unsafe.Sizeof(ext))
	if ret == 0 {
		return fmt.Errorf("SetInformationJobObject (extended) failed: %v", err)
	}

	rate := int(cpuRatePct*100 + 0.5)
	if rate < 1 {
		rate = 1
	} else if rate > 10000 {
		rate = 10000
	}
	cpu := jobObjectCPURateControlInformation{
		ControlFlags: jobCPURateControlEnable | jobCPURateControlHardCap,
		Value:        uint32(rate),
	}
	ret, _, err = procSetInformationJobObj.Call(
		uintptr(j.handle), uintptr(classCPURateControl),
		uintptr(unsafe.Pointer(&cpu)), unsafe.Sizeof(cpu))
	if ret == 0 {
		return fmt.Errorf("SetInformationJobObject (cpu) failed: %v", err)
	}
	return nil
}

// AssignPid opens the process and assigns it to the job. Returns the handle so
// the caller can resume + later close it.
func (j *JobObject) AssignPid(pid uint32) (windows.Handle, error) {
	h, err := windows.OpenProcess(windows.PROCESS_ALL_ACCESS, false, pid)
	if err != nil {
		return 0, fmt.Errorf("OpenProcess(%d): %v", pid, err)
	}
	ret, _, e := procAssignProcessToJobObj.Call(uintptr(j.handle), uintptr(h))
	if ret == 0 {
		windows.CloseHandle(h)
		return 0, fmt.Errorf("AssignProcessToJobObject: %v", e)
	}
	return h, nil
}

func (j *JobObject) ActiveProcesses() int {
	var acc jobObjectBasicAccountingInformation
	ret, _, _ := procQueryInformationJobObj.Call(
		uintptr(j.handle), uintptr(classBasicAccounting),
		uintptr(unsafe.Pointer(&acc)), unsafe.Sizeof(acc), 0)
	if ret == 0 {
		return 0
	}
	return int(acc.ActiveProcesses)
}

func (j *JobObject) PeakJobMemory() int64 {
	var ext jobObjectExtendedLimitInformation
	ret, _, _ := procQueryInformationJobObj.Call(
		uintptr(j.handle), uintptr(classExtendedLimit),
		uintptr(unsafe.Pointer(&ext)), unsafe.Sizeof(ext), 0)
	if ret == 0 {
		return 0
	}
	return int64(ext.PeakJobMemoryUsed)
}

func (j *JobObject) Terminate(exitCode uint32) {
	if j.closed {
		return
	}
	procTerminateJobObject.Call(uintptr(j.handle), uintptr(exitCode))
}

func (j *JobObject) Close() {
	if j.closed {
		return
	}
	windows.CloseHandle(j.handle) // triggers KILL_ON_JOB_CLOSE
	j.closed = true
}

// ResumeProcess resumes a suspended process by handle via NtResumeProcess.
func ResumeProcess(h windows.Handle) error {
	status, _, _ := procNtResumeProcess.Call(uintptr(h))
	if status != 0 {
		return fmt.Errorf("NtResumeProcess: NTSTATUS=0x%x", status)
	}
	return nil
}

func CloseHandle(h windows.Handle) {
	if h != 0 {
		windows.CloseHandle(h)
	}
}

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// MemGb returns (totalGb, availableGb) via GlobalMemoryStatusEx.
func MemGb() (float64, float64) {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	ret, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	if ret == 0 {
		return 0, 0
	}
	const gb = 1024 * 1024 * 1024
	return float64(m.TotalPhys) / gb, float64(m.AvailPhys) / gb
}
