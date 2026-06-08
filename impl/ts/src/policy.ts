// Resource governance: mirror the Python resource_policy.
// Targets: dev ~= 50% utilization, prod ~= 80% (per project rules).

import os from "node:os";
import type { SandboxQuota } from "./types.js";

const PROFILE_TARGETS: Record<string, number> = { dev: 0.5, prod: 0.8 };
const DEFAULT_PROFILE = "dev";
const DEFAULT_MAX_SANDBOXES: Record<string, number> = { dev: 2, prod: 4 };
const MIN_RAM_BYTES_PER_SANDBOX = 256 * 1024 * 1024;
const MIN_CPU_RATE_PCT = 5.0;

export interface SandboxResourcePolicy {
  profile: string;
  targetPct: number;
  physicalCores: number;
  totalRamGb: number;
  availableRamGb: number;
  maxConcurrentSandboxes: number;
  cpuBudgetPct: number;
  ramBudgetBytes: number;
  perSandboxCpuPct: number;
  perSandboxRamBytes: number;
}

export function resolveProfile(): string {
  const raw = (process.env.OPTIMAIZE_ENV ?? "").trim().toLowerCase();
  if (raw === "prod" || raw === "production") return "prod";
  if (raw === "dev" || raw === "development" || raw === "local") return "dev";
  if (raw) console.warn(`Unknown OPTIMAIZE_ENV=${raw}; defaulting to dev.`);
  return DEFAULT_PROFILE;
}

function physicalCores(): number {
  // Node has no logical/physical split; os.cpus() is logical. Assume 2-way SMT.
  const logical = os.cpus().length || 2;
  return Math.max(1, Math.floor(logical / 2));
}

function totalRamGb(): number {
  return os.totalmem() / 1024 ** 3;
}

function availableRamGb(): number {
  return os.freemem() / 1024 ** 3;
}

function maxSandboxes(profile: string): number {
  const override = process.env.OPTIMAIZE_WORK_MAX_SANDBOXES;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 1) return n;
    console.warn(`Invalid OPTIMAIZE_WORK_MAX_SANDBOXES=${override}; ignoring.`);
  }
  return DEFAULT_MAX_SANDBOXES[profile] ?? 2;
}

export function getSandboxPolicy(profile?: string): SandboxResourcePolicy {
  const prof = profile ?? resolveProfile();
  const target = PROFILE_TARGETS[prof] ?? PROFILE_TARGETS[DEFAULT_PROFILE];
  const cores = physicalCores();
  const totalRam = totalRamGb();
  const maxN = maxSandboxes(prof);

  const cpuBudgetPct = Math.round(100.0 * target * 100) / 100;
  const ramBudgetBytes = Math.floor(totalRam * target * 1024 ** 3);
  const perCpu = Math.max(MIN_CPU_RATE_PCT, Math.round((cpuBudgetPct / maxN) * 100) / 100);
  const perRam = Math.max(MIN_RAM_BYTES_PER_SANDBOX, Math.floor(ramBudgetBytes / maxN));

  return {
    profile: prof,
    targetPct: target,
    physicalCores: cores,
    totalRamGb: totalRam,
    availableRamGb: availableRamGb(),
    maxConcurrentSandboxes: maxN,
    cpuBudgetPct,
    ramBudgetBytes,
    perSandboxCpuPct: perCpu,
    perSandboxRamBytes: perRam,
  };
}

export function defaultQuota(
  policy: SandboxResourcePolicy,
  opts: Partial<Pick<SandboxQuota, "maxProcesses" | "wallClockTimeoutS" | "network" | "integrity">> = {},
): SandboxQuota {
  return {
    cpuRatePct: policy.perSandboxCpuPct,
    ramBytes: policy.perSandboxRamBytes,
    maxProcesses: opts.maxProcesses ?? 64,
    wallClockTimeoutS: opts.wallClockTimeoutS ?? 300.0,
    network: opts.network ?? "none",
    integrity: opts.integrity ?? "low",
  };
}

export interface AdmissionResult {
  ok: boolean;
  reason: string;
}

export function checkAdmission(
  requestedRamBytes: number,
  liveSandboxes: number,
  policy: SandboxResourcePolicy,
): AdmissionResult {
  if (liveSandboxes >= policy.maxConcurrentSandboxes) {
    return {
      ok: false,
      reason: `Concurrency cap reached: ${liveSandboxes}/${policy.maxConcurrentSandboxes} sandboxes live (${policy.profile} profile).`,
    };
  }
  if (requestedRamBytes > policy.ramBudgetBytes) {
    return {
      ok: false,
      reason: `Requested ~${(requestedRamBytes / 1024 ** 3).toFixed(2)} GB exceeds the ${policy.profile} budget of ~${(policy.ramBudgetBytes / 1024 ** 3).toFixed(2)} GB.`,
    };
  }
  const availableBytes = Math.floor(policy.availableRamGb * 1024 ** 3);
  if (requestedRamBytes > availableBytes) {
    return {
      ok: false,
      reason: `Requested ~${(requestedRamBytes / 1024 ** 3).toFixed(2)} GB but only ~${(availableBytes / 1024 ** 3).toFixed(2)} GB is free right now.`,
    };
  }
  return { ok: true, reason: `OK: ~${(requestedRamBytes / 1024 ** 3).toFixed(2)} GB within ${policy.profile} budget.` };
}

export function policyToWire(p: SandboxResourcePolicy): Record<string, unknown> {
  return {
    profile: p.profile,
    target_pct: p.targetPct,
    physical_cores: p.physicalCores,
    total_ram_gb: Math.round(p.totalRamGb * 100) / 100,
    available_ram_gb: Math.round(p.availableRamGb * 100) / 100,
    max_concurrent_sandboxes: p.maxConcurrentSandboxes,
    cpu_budget_pct: p.cpuBudgetPct,
    ram_budget_bytes: p.ramBudgetBytes,
    per_sandbox_cpu_pct: p.perSandboxCpuPct,
    per_sandbox_ram_bytes: p.perSandboxRamBytes,
  };
}
