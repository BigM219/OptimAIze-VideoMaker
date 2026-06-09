// VideoMaker project store + lifecycle + concept-driven director loop.
// A "project" is one Remotion sandbox the user edits, previews (Studio), and
// renders. The director loop is the headline: it turns a single concept into a
// complete multi-scene educational video.

import crypto from "node:crypto";
import { getManager, type SandboxManager } from "./sandbox/manager.js";
import { OpenRouterClient } from "./agent/llm-client.js";

export type ProjectState = "pending" | "scaffolding" | "ready" | "generating" | "rendering" | "failed";

export interface ProjectStep {
  index: number;
  timestamp: number;
  phase: string;
  detail: string;
  // Optional rich fields so the UI can render a coding-agent transcript:
  // what the model wrote, what command ran, and its output.
  kind?: "plan" | "write_file" | "command" | "command_output" | "repair" | "info" | "error";
  path?: string; // write_file: the file path
  content?: string; // write_file: the code written (capped)
  command?: string; // command: the shell command
  exitCode?: number; // command_output: process exit code
  output?: string; // command_output: trimmed stdout+stderr (capped)
  frame?: number; // probe: the frame number a per-frame render check targeted
}

// Cap large transcript payloads so the polled project JSON stays bounded.
export const STEP_FIELD_CAP = 4000;
export function capStep(s: string | undefined, n = STEP_FIELD_CAP): string | undefined {
  if (s === undefined) return undefined;
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

export interface Project {
  id: string;
  sandboxId: string | null;
  prompt: string;
  requirements: string;
  goals: string;
  state: ProjectState;
  studioUrl: string | null;
  studioPort: number | null;
  studioPid: number | null;
  // Version token for the self-written player bundle; bumped on each rebuild so
  // the frontend can bust the iframe cache (?v=<token>).
  studioVersion: number;
  storyboard: Storyboard | null;
  exportPath: string | null;
  error: string | null;
  steps: ProjectStep[];
  chat: Array<{ role: string; content: string }>;
  createdAt: number;
  updatedAt: number;
}

export type SceneStatus = "pending" | "writing" | "ready" | "error";

export interface Scene {
  id: string; // PascalCase component id, e.g. "TitleScene"
  title: string;
  durationInFrames: number;
  narration: string;
  visual: string;
  // Per-scene lifecycle so the UI can review each slide live in Studio as soon
  // as its code is written. Each scene is its own Remotion <Composition>, so
  // Studio renders it directly from code (hot-reload) — no per-scene mp4.
  // "ready" = code written and registered in Studio; "error" = compile/repair
  // pending (set by the repair loop) without blocking the other slides.
  status?: SceneStatus;
  renderError?: string; // trimmed error when status === "error"
}
export interface Storyboard {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: Scene[];
}

const STUDIO_PORT_BASE = 3100;

export class ProjectStore {
  private projects = new Map<string, Project>();
  private mgr: SandboxManager;
  private nextStudioPort = STUDIO_PORT_BASE;

  constructor(mgr?: SandboxManager) {
    this.mgr = mgr ?? getManager();
  }

  manager(): SandboxManager {
    return this.mgr;
  }

  get(id: string): Project {
    const p = this.projects.get(id);
    if (!p) throw new Error(`Project not found: ${id}`);
    return p;
  }
  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  allocStudioPort(): number {
    return this.nextStudioPort++;
  }

  private step(p: Project, phase: string, detail: string, extra: Partial<ProjectStep> = {}): void {
    p.steps.push({
      index: p.steps.length,
      timestamp: Date.now() / 1000,
      phase,
      detail,
      ...extra,
      content: capStep(extra.content),
      output: capStep(extra.output),
    });
    p.updatedAt = Date.now() / 1000;
  }

  // Public transcript logger (by project id) for modules outside this class
  // (studio.ts, probe.ts via the API) to append typed steps.
  logStep(id: string, phase: string, detail: string, extra: Partial<ProjectStep> = {}): void {
    this.step(this.get(id), phase, detail, extra);
  }

  create(prompt: string, requirements: string, goals: string): Project {
    const now = Date.now() / 1000;
    const p: Project = {
      id: `prj_${crypto.randomBytes(6).toString("hex")}`,
      sandboxId: null,
      prompt,
      requirements,
      goals,
      state: "pending",
      studioUrl: null,
      studioPort: null,
      studioPid: null,
      studioVersion: 0,
      storyboard: null,
      exportPath: null,
      error: null,
      steps: [],
      chat: [],
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(p.id, p);
    void this.scaffold(p.id);
    return p;
  }

  // Scaffold a blank Remotion project + install deps in a fresh sandbox.
  private async scaffold(id: string): Promise<void> {
    const p = this.get(id);
    try {
      p.state = "scaffolding";
      const info = this.mgr.create({ backend: "process" });
      p.sandboxId = info.sandboxId;
      const backend = this.mgr.backendFor(info.sandboxId);

      this.step(p, "scaffold", "Scaffolding a blank Remotion project", { kind: "command", command: "npx create-video@latest --blank ." });
      const scaffold = await backend.exec(info.sandboxId, "npx --yes create-video@latest --yes --blank .", { timeoutS: 600 });
      this.step(p, "scaffold", "create-video finished", { kind: "command_output", exitCode: scaffold.exitCode, output: scaffold.stdout + scaffold.stderr });
      if (scaffold.exitCode !== 0) throw new Error(`scaffold failed: ${scaffold.stderr.slice(0, 300)}`);

      this.step(p, "install", "Installing dependencies", { kind: "command", command: "npm install" });
      const install = await backend.exec(info.sandboxId, "npm install --no-audit --no-fund", { timeoutS: 1200 });
      this.step(p, "install", "npm install finished", { kind: "command_output", exitCode: install.exitCode, output: install.stdout + install.stderr });
      if (install.exitCode !== 0) throw new Error(`npm install failed: ${install.stderr.slice(0, 300)}`);

      p.state = "ready";
      this.step(p, "ready", "Project scaffolded and dependencies installed.");
    } catch (e) {
      p.state = "failed";
      p.error = String((e as Error).message ?? e);
      this.step(p, "error", p.error);
    }
  }

  // Launch Remotion Studio (idempotent) and return the URL.
  launchStudio(id: string): { url: string; port: number } {
    const p = this.get(id);
    if (!p.sandboxId) throw new Error("Project has no sandbox yet.");
    if (p.studioUrl && p.studioPort) return { url: p.studioUrl, port: p.studioPort };
    const port = this.allocStudioPort();
    const backend = this.mgr.backendFor(p.sandboxId);
    const pid = backend.spawnDaemon(
      p.sandboxId,
      `npx --no-install remotion studio --port ${port} --no-open`,
    );
    p.studioPort = port;
    p.studioPid = pid;
    p.studioUrl = `http://127.0.0.1:${port}`;
    this.step(p, "studio", `Remotion Studio launched on port ${port} (pid ${pid}).`);
    return { url: p.studioUrl, port };
  }

  // Files (delegate to the sandbox backend's jailed file ops).
  listFiles(id: string, rel = "."): unknown {
    const p = this.get(id);
    if (!p.sandboxId) throw new Error("No sandbox.");
    return this.mgr.backendFor(p.sandboxId).list(p.sandboxId, rel);
  }
  readFile(id: string, rel: string): string {
    const p = this.get(id);
    if (!p.sandboxId) throw new Error("No sandbox.");
    return this.mgr.backendFor(p.sandboxId).readFile(p.sandboxId, rel, false) as string;
  }
  writeFile(id: string, rel: string, content: string): unknown {
    const p = this.get(id);
    if (!p.sandboxId) throw new Error("No sandbox.");
    return this.mgr.backendFor(p.sandboxId).writeFile(p.sandboxId, rel, content);
  }
  rawPath(id: string, rel: string): string {
    const p = this.get(id);
    if (!p.sandboxId) throw new Error("No sandbox.");
    return this.mgr.backendFor(p.sandboxId).rawPath(p.sandboxId, rel);
  }

  // Collect all source files under src/ for full chat/director context.
  private collectSource(id: string): Record<string, string> {
    const p = this.get(id);
    if (!p.sandboxId) return {};
    const backend = this.mgr.backendFor(p.sandboxId);
    const out: Record<string, string> = {};
    const walk = (rel: string): void => {
      let entries: Array<{ path: string; isDir: boolean }> = [];
      try {
        entries = backend.list(p.sandboxId!, rel) as Array<{ path: string; isDir: boolean }>;
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDir) {
          if (!e.path.includes("node_modules")) walk(e.path);
        } else if (/\.(tsx?|css|json)$/.test(e.path) && !e.path.includes("node_modules")) {
          try {
            out[e.path] = backend.readFile(p.sandboxId!, e.path, false) as string;
          } catch {
            /* skip */
          }
        }
      }
    };
    walk("src");
    return out;
  }
}

let store: ProjectStore | null = null;
export function getProjectStore(): ProjectStore {
  if (!store) store = new ProjectStore();
  return store;
}
