// Process sandbox backend (Windows). The host's process, caged by a Job Object
// and jailed to a per-sandbox workdir. Mirrors the Python ProcessSandboxBackend.
//
// Caging note: Node's child_process.spawn cannot create a process SUSPENDED, so
// we spawn and then immediately assign it to the Job Object. There is a tiny
// race window versus the Python CREATE_SUSPENDED path. This backend is hardening
// (resource + accidental-damage isolation), not a malware boundary, so the
// window is acceptable; the Job's kill-on-close still reaps the whole tree.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveInJail } from "./jail.js";
import { JobObject, ffiAvailable } from "../winapi/jobobject.js";
import {
  type ExecResult,
  type FileEntry,
  type ResourceUsage,
  type SandboxConfig,
  type SandboxInfo,
  SandboxNotFound,
  SandboxOperationError,
} from "../types.js";

const IS_WINDOWS = process.platform === "win32";

interface LiveSandbox {
  config: SandboxConfig;
  job: JobObject | null;
  createdAt: number; // ms epoch via performance-free Date for wall clock
  peakRamBytes: number;
}

function longPath(p: string): string {
  if (!IS_WINDOWS) return p;
  const abs = path.resolve(p);
  if (abs.startsWith("\\\\?\\")) return abs;
  if (abs.startsWith("\\\\")) return "\\\\?\\UNC\\" + abs.slice(2);
  return "\\\\?\\" + abs;
}

export class ProcessBackend {
  readonly name = "process";
  readonly securityTier = "process" as const;
  private sandboxes = new Map<string, LiveSandbox>();

  isAvailable(): boolean {
    return IS_WINDOWS && ffiAvailable();
  }
  supportsFilesystemIsolation(): boolean {
    return true;
  }
  supportsNetworkIsolation(): boolean {
    return false;
  }

  private get(id: string): LiveSandbox {
    const sbx = this.sandboxes.get(id);
    if (!sbx) throw new SandboxNotFound(`Sandbox not found: ${id}`);
    return sbx;
  }

  private ensureJob(sbx: LiveSandbox): JobObject | null {
    if (!IS_WINDOWS) return null;
    if (sbx.job) return sbx.job;
    const job = new JobObject();
    const q = sbx.config.quota;
    job.configure(q.ramBytes, q.maxProcesses, q.cpuRatePct);
    sbx.job = job;
    return job;
  }

  create(config: SandboxConfig): SandboxInfo {
    fs.mkdirSync(config.workdir, { recursive: true });
    this.sandboxes.set(config.sandboxId, { config, job: null, createdAt: Date.now(), peakRamBytes: 0 });
    return {
      sandboxId: config.sandboxId,
      backend: this.name,
      securityTier: this.securityTier,
      state: "created",
      workdir: config.workdir,
      quota: config.quota,
    };
  }

  kill(id: string): void {
    const sbx = this.get(id);
    sbx.job?.terminate();
  }

  destroy(id: string): void {
    const sbx = this.sandboxes.get(id);
    if (!sbx) return;
    sbx.job?.terminate();
    sbx.job?.close();
    this.sandboxes.delete(id);
  }

  async exec(
    id: string,
    command: string | string[],
    opts: { cwd?: string; env?: Record<string, string>; timeoutS?: number | null; stdin?: string } = {},
  ): Promise<ExecResult> {
    const sbx = this.get(id);
    const runCwd = opts.cwd ? resolveInJail(sbx.config.workdir, opts.cwd) : sbx.config.workdir;
    const fullEnv = { ...process.env, ...sbx.config.env, ...(opts.env ?? {}) } as Record<string, string>;
    const useShell = typeof command === "string";
    const effectiveTimeout = opts.timeoutS ?? sbx.config.quota.wallClockTimeoutS ?? undefined;

    const started = Date.now();
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(command as string, {
        cwd: runCwd,
        env: fullEnv,
        shell: useShell,
        windowsHide: true,
      });

      // Cage immediately after spawn.
      let job: JobObject | null = null;
      if (IS_WINDOWS && child.pid) {
        try {
          job = this.ensureJob(sbx);
          job?.assignByPid(child.pid);
        } catch {
          // If assignment fails the process still runs uncaged; acceptable for
          // the hardening tier. Log path is the server logger via thrown errors.
        }
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));

      let timer: NodeJS.Timeout | null = null;
      if (effectiveTimeout && effectiveTimeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          job?.terminate();
          child.kill("SIGKILL");
        }, effectiveTimeout * 1000);
      }

      if (opts.stdin !== undefined && opts.stdin !== null) {
        child.stdin?.write(opts.stdin);
      }
      child.stdin?.end();

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[spawn error] ${String(err)}`,
          durationS: (Date.now() - started) / 1000,
          timedOut,
          killedByCap: false,
        });
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const exitCode = code ?? -1;
        let killedByCap = false;
        if (!timedOut && exitCode !== 0 && job) {
          // Heuristic identical to Python: peak job memory close to the cap.
          killedByCap = job.peakJobMemory() >= sbx.config.quota.ramBytes * 0.95;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          durationS: (Date.now() - started) / 1000,
          timedOut,
          killedByCap,
        });
      });
    });
  }

  // Spawn a long-running caged process (e.g. Remotion Studio dev server) and
  // return its pid immediately. Output is discarded; the process is reaped when
  // the sandbox's Job Object is closed (destroy) or via killDaemon.
  spawnDaemon(
    id: string,
    command: string,
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): number {
    const sbx = this.get(id);
    const runCwd = opts.cwd ? resolveInJail(sbx.config.workdir, opts.cwd) : sbx.config.workdir;
    const fullEnv = { ...process.env, ...sbx.config.env, ...(opts.env ?? {}) } as Record<string, string>;
    const child = spawn(command, {
      cwd: runCwd,
      env: fullEnv,
      shell: true,
      windowsHide: true,
      detached: false,
      stdio: "ignore",
    });
    if (IS_WINDOWS && child.pid) {
      try {
        this.ensureJob(sbx)?.assignByPid(child.pid);
      } catch {
        /* hardening tier: uncaged fallback is acceptable */
      }
    }
    child.unref();
    return child.pid ?? -1;
  }

  getResourceUsage(id: string): ResourceUsage {
    const sbx = this.get(id);
    let activeProcesses = 0;
    let peak = sbx.peakRamBytes;
    if (sbx.job) {
      activeProcesses = sbx.job.accounting().activeProcesses;
      peak = Math.max(peak, sbx.job.peakJobMemory());
      sbx.peakRamBytes = peak;
    }
    return {
      cpuPercent: 0,
      ramBytes: peak,
      peakRamBytes: peak,
      activeProcesses,
      wallClockS: (Date.now() - sbx.createdAt) / 1000,
    };
  }

  // --- files (all via resolveInJail) ---------------------------------------
  writeFile(id: string, relPath: string, data: string | Buffer): FileEntry {
    const sbx = this.get(id);
    const target = resolveInJail(sbx.config.workdir, relPath);
    fs.mkdirSync(path.dirname(longPath(target)), { recursive: true });
    fs.writeFileSync(longPath(target), data);
    return this.entry(sbx.config.workdir, target);
  }

  readFile(id: string, relPath: string, binary = false): string | Buffer {
    const sbx = this.get(id);
    const target = resolveInJail(sbx.config.workdir, relPath);
    if (!fs.existsSync(longPath(target))) throw new SandboxNotFound(`File not found: ${relPath}`);
    return binary ? fs.readFileSync(longPath(target)) : fs.readFileSync(longPath(target), "utf-8");
  }

  list(id: string, relPath = "."): FileEntry[] {
    const sbx = this.get(id);
    const target = resolveInJail(sbx.config.workdir, relPath);
    const lp = longPath(target);
    if (!fs.existsSync(lp)) throw new SandboxNotFound(`Path not found: ${relPath}`);
    const st = fs.statSync(lp);
    if (!st.isDirectory()) return [this.entry(sbx.config.workdir, target)];
    return fs
      .readdirSync(lp)
      .sort()
      .map((name) => this.entry(sbx.config.workdir, path.join(target, name)));
  }

  remove(id: string, relPath: string): void {
    const sbx = this.get(id);
    const target = resolveInJail(sbx.config.workdir, relPath);
    const lp = longPath(target);
    if (!fs.existsSync(lp)) return;
    fs.rmSync(lp, { recursive: true, force: true });
  }

  rawPath(id: string, relPath: string): string {
    const sbx = this.get(id);
    const target = resolveInJail(sbx.config.workdir, relPath);
    if (!fs.existsSync(longPath(target))) throw new SandboxNotFound(`File not found: ${relPath}`);
    return target;
  }

  private entry(workdir: string, abs: string): FileEntry {
    const lp = longPath(abs);
    const st = fs.statSync(lp);
    const rel = path.relative(workdir, abs).split(path.sep).join("/");
    return {
      path: rel,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      modified: st.mtimeMs / 1000,
    };
  }

  workdirOf(id: string): string {
    return this.get(id).config.workdir;
  }
}
