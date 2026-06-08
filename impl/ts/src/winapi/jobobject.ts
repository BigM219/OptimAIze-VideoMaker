// Windows Job Object + NtResumeProcess via koffi FFI.
// Equivalent of the Python winapi/{job_object,process_launch}.py ctypes layer.
//
// A Job Object caps a process tree: CPU rate hard cap, job memory limit, active
// process limit, and kill-on-job-close so stragglers are reaped on destroy.
// Cage-before-execute: a child is created SUSPENDED, assigned to the job, then
// resumed with NtResumeProcess (we hold the process handle, not a thread handle).

import koffi from "koffi";

const IS_WINDOWS = process.platform === "win32";

// --- Win32 constants -------------------------------------------------------
export const CREATE_SUSPENDED = 0x00000004;
export const CREATE_NO_WINDOW = 0x08000000;
export const CREATE_NEW_PROCESS_GROUP = 0x00000200;
export const SUSPENDED_CREATION_FLAGS = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;

const JobObjectBasicAccountingInformation = 1;
const JobObjectExtendedLimitInformation = 9;
const JobObjectCpuRateControlInformation = 15;

const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x00000001;
const JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x00000004;

// --- struct definitions (koffi) -------------------------------------------
// Sizes/fields match winnt.h on x64.
koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
  PerProcessUserTimeLimit: "int64",
  PerJobUserTimeLimit: "int64",
  LimitFlags: "uint32",
  MinimumWorkingSetSize: "size_t",
  MaximumWorkingSetSize: "size_t",
  ActiveProcessLimit: "uint32",
  Affinity: "size_t",
  PriorityClass: "uint32",
  SchedulingClass: "uint32",
});
koffi.struct("IO_COUNTERS", {
  ReadOperationCount: "uint64",
  WriteOperationCount: "uint64",
  OtherOperationCount: "uint64",
  ReadTransferCount: "uint64",
  WriteTransferCount: "uint64",
  OtherTransferCount: "uint64",
});
koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
  BasicLimitInformation: "JOBOBJECT_BASIC_LIMIT_INFORMATION",
  IoInfo: "IO_COUNTERS",
  ProcessMemoryLimit: "size_t",
  JobMemoryLimit: "size_t",
  PeakProcessMemoryUsed: "size_t",
  PeakJobMemoryUsed: "size_t",
});
koffi.struct("JOBOBJECT_BASIC_ACCOUNTING_INFORMATION", {
  TotalUserTime: "int64",
  TotalKernelTime: "int64",
  ThisPeriodTotalUserTime: "int64",
  ThisPeriodTotalKernelTime: "int64",
  TotalPageFaultCount: "uint32",
  TotalProcesses: "uint32",
  ActiveProcesses: "uint32",
  TotalTerminatedProcesses: "uint32",
});
koffi.struct("JOBOBJECT_CPU_RATE_CONTROL_INFORMATION", {
  ControlFlags: "uint32",
  CpuRate: "uint32", // union with Weight/Min-Max; CpuRate is the field we use
});

let kernel32: koffi.IKoffiLib | null = null;
let ntdll: koffi.IKoffiLib | null = null;

// kernel32 functions
let CreateJobObjectW: koffi.KoffiFunction;
let SetInformationJobObject: koffi.KoffiFunction;
let QueryInformationJobObject: koffi.KoffiFunction;
let AssignProcessToJobObject: koffi.KoffiFunction;
let TerminateJobObject: koffi.KoffiFunction;
let CloseHandle: koffi.KoffiFunction;
let OpenProcess: koffi.KoffiFunction;
let NtResumeProcess: koffi.KoffiFunction;

const PROCESS_ALL_ACCESS = 0x1f0fff;

function ensureLoaded(): void {
  if (!IS_WINDOWS) throw new Error("Job Object FFI is Windows-only.");
  if (kernel32) return;
  kernel32 = koffi.load("kernel32.dll");
  ntdll = koffi.load("ntdll.dll");

  CreateJobObjectW = kernel32.func("void* CreateJobObjectW(void* lpJobAttributes, void* lpName)");
  SetInformationJobObject = kernel32.func(
    "bool SetInformationJobObject(void* hJob, int JobObjectInformationClass, void* lpJobObjectInformation, uint32 cbJobObjectInformationLength)",
  );
  QueryInformationJobObject = kernel32.func(
    "bool QueryInformationJobObject(void* hJob, int JobObjectInformationClass, void* lpJobObjectInformation, uint32 cbJobObjectInformationLength, void* lpReturnLength)",
  );
  AssignProcessToJobObject = kernel32.func("bool AssignProcessToJobObject(void* hJob, void* hProcess)");
  TerminateJobObject = kernel32.func("bool TerminateJobObject(void* hJob, uint32 uExitCode)");
  CloseHandle = kernel32.func("bool CloseHandle(void* hObject)");
  OpenProcess = kernel32.func("void* OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)");
  // NtResumeProcess(HANDLE) -> NTSTATUS
  NtResumeProcess = ntdll.func("long NtResumeProcess(void* ProcessHandle)");
}

export function ffiAvailable(): boolean {
  if (!IS_WINDOWS) return false;
  try {
    ensureLoaded();
    return true;
  } catch {
    return false;
  }
}

export class JobObject {
  private handle: unknown;
  private closed = false;

  constructor() {
    ensureLoaded();
    this.handle = CreateJobObjectW(null, null);
    if (!this.handle) throw new Error("CreateJobObjectW failed.");
  }

  configure(ramBytes: number, maxProcesses: number, cpuRatePct: number): void {
    // Extended limit: kill-on-close + die-on-exception + job memory + active processes.
    const ext = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0n,
        PerJobUserTimeLimit: 0n,
        LimitFlags:
          JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
          JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
          JOB_OBJECT_LIMIT_JOB_MEMORY |
          JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: Math.max(1, Math.floor(maxProcesses)),
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0n,
        WriteOperationCount: 0n,
        OtherOperationCount: 0n,
        ReadTransferCount: 0n,
        WriteTransferCount: 0n,
        OtherTransferCount: 0n,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: Math.floor(ramBytes),
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };
    const extSize = koffi.sizeof("JOBOBJECT_EXTENDED_LIMIT_INFORMATION");
    const extBuf = Buffer.alloc(extSize);
    koffi.encode(extBuf, "JOBOBJECT_EXTENDED_LIMIT_INFORMATION", ext);
    if (!SetInformationJobObject(this.handle, JobObjectExtendedLimitInformation, extBuf, extSize)) {
      throw new Error("SetInformationJobObject (extended limit) failed.");
    }

    // CPU rate hard cap: CpuRate is in 1/100 of a percent of total machine CPU.
    const cpuRate = Math.max(1, Math.min(10000, Math.round(cpuRatePct * 100)));
    const cpu = { ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, CpuRate: cpuRate };
    const cpuSize = koffi.sizeof("JOBOBJECT_CPU_RATE_CONTROL_INFORMATION");
    const cpuBuf = Buffer.alloc(cpuSize);
    koffi.encode(cpuBuf, "JOBOBJECT_CPU_RATE_CONTROL_INFORMATION", cpu);
    if (!SetInformationJobObject(this.handle, JobObjectCpuRateControlInformation, cpuBuf, cpuSize)) {
      throw new Error("SetInformationJobObject (cpu rate) failed.");
    }
  }

  // Assign a process (by PID) to this job. Node exposes PID, not the HANDLE,
  // so we OpenProcess to get a handle for the assign + resume sequence.
  assignByPid(pid: number): unknown {
    const hProcess = OpenProcess(PROCESS_ALL_ACCESS, false, pid >>> 0);
    if (!hProcess) throw new Error(`OpenProcess(${pid}) failed.`);
    if (!AssignProcessToJobObject(this.handle, hProcess)) {
      CloseHandle(hProcess);
      throw new Error("AssignProcessToJobObject failed.");
    }
    return hProcess;
  }

  accounting(): { activeProcesses: number } {
    const size = koffi.sizeof("JOBOBJECT_BASIC_ACCOUNTING_INFORMATION");
    const buf = Buffer.alloc(size);
    if (!QueryInformationJobObject(this.handle, JobObjectBasicAccountingInformation, buf, size, null)) {
      return { activeProcesses: 0 };
    }
    const acc = koffi.decode(buf, "JOBOBJECT_BASIC_ACCOUNTING_INFORMATION") as { ActiveProcesses: number };
    return { activeProcesses: acc.ActiveProcesses };
  }

  peakJobMemory(): number {
    const size = koffi.sizeof("JOBOBJECT_EXTENDED_LIMIT_INFORMATION");
    const buf = Buffer.alloc(size);
    if (!QueryInformationJobObject(this.handle, JobObjectExtendedLimitInformation, buf, size, null)) {
      return 0;
    }
    const ext = koffi.decode(buf, "JOBOBJECT_EXTENDED_LIMIT_INFORMATION") as { PeakJobMemoryUsed: number };
    return Number(ext.PeakJobMemoryUsed) || 0;
  }

  terminate(exitCode = 1): void {
    if (this.closed || !this.handle) return;
    TerminateJobObject(this.handle, exitCode >>> 0);
  }

  close(): void {
    if (this.closed || !this.handle) return;
    CloseHandle(this.handle); // triggers KILL_ON_JOB_CLOSE
    this.closed = true;
    this.handle = null;
  }
}

// Resume a suspended process by PID via NtResumeProcess.
export function resumeProcessByPid(pid: number): void {
  ensureLoaded();
  const hProcess = OpenProcess(PROCESS_ALL_ACCESS, false, pid >>> 0);
  if (!hProcess) throw new Error(`OpenProcess(${pid}) failed for resume.`);
  try {
    const status = NtResumeProcess(hProcess) as number;
    if (status !== 0) throw new Error(`NtResumeProcess failed: NTSTATUS=0x${(status >>> 0).toString(16)}`);
  } finally {
    CloseHandle(hProcess);
  }
}

export function closeHandle(h: unknown): void {
  if (h) CloseHandle(h);
}
