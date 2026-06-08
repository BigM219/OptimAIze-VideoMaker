// SandboxManager: admission, workdir allocation, lifecycle, snapshot/restore.
// Mirrors the Python manager, including the deliberate ~/.optimaize-work root
// (never %LOCALAPPDATA% — MSIX-style virtualization breaks child-process CWD).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessBackend } from "./process-backend.js";
import { snapshotWorkdir, restoreInto } from "./snapshot.js";
import {
  type SandboxInfo,
  type SandboxQuota,
  AdmissionDenied,
  BackendUnavailable,
  SandboxNotFound,
  SandboxOperationError,
} from "../types.js";
import { checkAdmission, defaultQuota, getSandboxPolicy, type SandboxResourcePolicy } from "../policy.js";

export const DEFAULT_BACKEND = "process";

interface BackendDescriptor {
  name: string;
  securityTier: string;
  isAvailable(): boolean;
  unavailableReason?(): string;
}

// Stub backends: advertised but always unavailable on this host, same as Python.
class StubBackend implements BackendDescriptor {
  constructor(
    public name: string,
    public securityTier: string,
    private reason: string,
  ) {}
  isAvailable(): boolean {
    return false;
  }
  unavailableReason(): string {
    return this.reason;
  }
}

function defaultSandboxRoot(): string {
  const override = process.env.OPTIMAIZE_WORK_SANDBOX_ROOT;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".optimaize-work", "sandboxes");
}

export class SandboxManager {
  private root: string;
  private snapshotsRoot: string;
  private backend = new ProcessBackend();
  private live = new Map<string, SandboxInfo>();
  private profile?: string;

  constructor(opts: { root?: string; profile?: string } = {}) {
    this.root = opts.root ?? defaultSandboxRoot();
    this.snapshotsRoot = path.join(path.dirname(this.root), "snapshots");
    this.profile = opts.profile;
  }

  policy(): SandboxResourcePolicy {
    return getSandboxPolicy(this.profile);
  }

  liveCount(): number {
    return this.live.size;
  }

  listBackends(): Array<Record<string, unknown>> {
    const descriptors: BackendDescriptor[] = [
      this.backend,
      new StubBackend("windows-sandbox", "vm", "Windows Sandbox (WindowsSandbox.exe) is not enabled on this host."),
      new StubBackend("wsl", "container", "No non-docker WSL distro detected."),
      new StubBackend("e2b", "remote", "E2B_API_KEY is not set."),
    ];
    return descriptors.map((b) => ({
      name: b.name,
      security_tier: b.securityTier,
      available: b.isAvailable(),
      network_isolation: b.name === "process" ? false : true,
      filesystem_isolation: true,
      default: b.name === DEFAULT_BACKEND,
    }));
  }

  create(opts: { backend?: string; quota?: SandboxQuota; env?: Record<string, string>; sandboxId?: string } = {}): SandboxInfo {
    const backendName = (opts.backend ?? DEFAULT_BACKEND).trim().toLowerCase();
    if (backendName !== "process") {
      throw new BackendUnavailable(`Backend '${backendName}' is registered but not available on this host.`);
    }
    if (!this.backend.isAvailable()) {
      throw new BackendUnavailable("The process backend requires Windows with Job Object FFI.");
    }
    const policy = this.policy();
    const quota = opts.quota ?? defaultQuota(policy);

    const admission = checkAdmission(quota.ramBytes, this.live.size, policy);
    if (!admission.ok) throw new AdmissionDenied(admission.reason);

    const sid = opts.sandboxId ?? `sbx_${crypto.randomBytes(6).toString("hex")}`;
    const workdir = path.join(this.root, sid);
    fs.mkdirSync(workdir, { recursive: true });

    const info = this.backend.create({
      sandboxId: sid,
      workdir,
      quota,
      backend: "process",
      env: opts.env ?? {},
    });
    this.live.set(sid, info);
    return info;
  }

  get(id: string): SandboxInfo {
    const info = this.live.get(id);
    if (!info) throw new SandboxNotFound(`Sandbox not found: ${id}`);
    return info;
  }

  backendFor(_id: string): ProcessBackend {
    return this.backend;
  }

  list(): SandboxInfo[] {
    return [...this.live.values()];
  }

  kill(id: string): void {
    this.get(id);
    this.backend.kill(id);
  }

  destroy(id: string): void {
    const info = this.live.get(id);
    if (!info) throw new SandboxNotFound(`Sandbox not found: ${id}`);
    this.backend.destroy(id);
    this.live.delete(id);
    try {
      fs.rmSync(info.workdir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  destroyAll(): void {
    for (const id of [...this.live.keys()]) {
      try {
        this.destroy(id);
      } catch {
        /* swallow */
      }
    }
  }

  async snapshot(id: string): Promise<string> {
    const info = this.get(id);
    const ref = `snap_${crypto.randomBytes(6).toString("hex")}`;
    fs.mkdirSync(this.snapshotsRoot, { recursive: true });
    const destZip = path.join(this.snapshotsRoot, `${ref}.zip`);
    await snapshotWorkdir(info.workdir, destZip);
    const sidecar = {
      ref,
      source_sandbox: id,
      backend: info.backend,
      quota: info.quota,
    };
    fs.writeFileSync(path.join(this.snapshotsRoot, `${ref}.json`), JSON.stringify(sidecar, null, 2), "utf-8");
    return ref;
  }

  async restore(ref: string, quota?: SandboxQuota): Promise<SandboxInfo> {
    const srcZip = path.join(this.snapshotsRoot, `${ref}.zip`);
    if (!fs.existsSync(srcZip)) throw new SandboxNotFound(`Snapshot not found: ${ref}`);
    let restoreQuota = quota;
    const sidecarPath = path.join(this.snapshotsRoot, `${ref}.json`);
    if (!restoreQuota && fs.existsSync(sidecarPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
        if (meta.quota) restoreQuota = meta.quota as SandboxQuota;
      } catch {
        /* fall through to default */
      }
    }
    const info = this.create({ backend: "process", quota: restoreQuota });
    await restoreInto(info.workdir, srcZip);
    return info;
  }

  listSnapshots(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.snapshotsRoot)) return [];
    return fs
      .readdirSync(this.snapshotsRoot)
      .filter((f) => f.endsWith(".zip"))
      .sort()
      .map((f) => {
        const ref = f.slice(0, -4);
        const zipPath = path.join(this.snapshotsRoot, f);
        const entry: Record<string, unknown> = { ref, size_bytes: fs.statSync(zipPath).size };
        const sidecarPath = path.join(this.snapshotsRoot, `${ref}.json`);
        if (fs.existsSync(sidecarPath)) {
          try {
            Object.assign(entry, JSON.parse(fs.readFileSync(sidecarPath, "utf-8")));
          } catch {
            /* ignore */
          }
        }
        return entry;
      });
  }
}

let singleton: SandboxManager | null = null;
export function getManager(): SandboxManager {
  if (!singleton) singleton = new SandboxManager();
  return singleton;
}
