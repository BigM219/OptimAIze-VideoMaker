// Shared domain types for the OptimAIze-Work sandbox + agent.
// Mirrors the Python module's dataclasses so the HTTP contract is identical.

export type SecurityTier = "process" | "container" | "vm" | "remote";
export type NetworkMode = "none" | "allowed";
export type IntegrityLevel = "untrusted" | "low" | "medium";
export type SandboxState = "created" | "running" | "destroyed";

export interface SandboxQuota {
  cpuRatePct: number; // -> Job Object CPU rate hard cap (percent of total machine CPU)
  ramBytes: number; // -> Job Object JobMemoryLimit
  maxProcesses: number; // -> Job Object ActiveProcessLimit
  wallClockTimeoutS: number | null;
  network: NetworkMode;
  integrity: IntegrityLevel;
}

export interface SandboxConfig {
  sandboxId: string;
  workdir: string;
  quota: SandboxQuota;
  backend: string;
  env: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationS: number;
  timedOut: boolean;
  killedByCap: boolean;
}

export interface FileEntry {
  path: string; // relative, POSIX separators
  isDir: boolean;
  size: number;
  modified: number; // epoch seconds
}

export interface ResourceUsage {
  cpuPercent: number;
  ramBytes: number;
  peakRamBytes: number;
  activeProcesses: number;
  wallClockS: number;
}

export interface SandboxInfo {
  sandboxId: string;
  backend: string;
  securityTier: SecurityTier;
  state: SandboxState;
  workdir: string;
  quota: SandboxQuota;
}

// JSON serialization helpers: the wire format uses snake_case to match the
// Python module exactly, so existing clients / the shared web UI work unchanged.

export function quotaToWire(q: SandboxQuota): Record<string, unknown> {
  return {
    cpu_rate_pct: q.cpuRatePct,
    ram_bytes: q.ramBytes,
    max_processes: q.maxProcesses,
    wall_clock_timeout_s: q.wallClockTimeoutS,
    network: q.network,
    integrity: q.integrity,
  };
}

export function infoToWire(info: SandboxInfo): Record<string, unknown> {
  return {
    sandbox_id: info.sandboxId,
    backend: info.backend,
    security_tier: info.securityTier,
    state: info.state,
    workdir: info.workdir,
    quota: quotaToWire(info.quota),
  };
}

export function execResultToWire(r: ExecResult): Record<string, unknown> {
  return {
    exit_code: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    duration_s: r.durationS,
    timed_out: r.timedOut,
    killed_by_cap: r.killedByCap,
    ok: r.exitCode === 0 && !r.timedOut && !r.killedByCap,
  };
}

export function fileEntryToWire(e: FileEntry): Record<string, unknown> {
  return { path: e.path, is_dir: e.isDir, size: e.size, modified: e.modified };
}

export function usageToWire(u: ResourceUsage): Record<string, unknown> {
  return {
    cpu_percent: u.cpuPercent,
    ram_bytes: u.ramBytes,
    peak_ram_bytes: u.peakRamBytes,
    active_processes: u.activeProcesses,
    wall_clock_s: u.wallClockS,
  };
}

// Domain errors carry an HTTP status, mirroring the Python error hierarchy.
export class WorkError extends Error {
  status = 500;
}
export class BackendUnavailable extends WorkError {
  status = 501;
}
export class AdmissionDenied extends WorkError {
  status = 503;
}
export class SandboxNotFound extends WorkError {
  status = 404;
}
export class PathEscape extends WorkError {
  status = 400;
}
export class SandboxOperationError extends WorkError {
  status = 500;
}
