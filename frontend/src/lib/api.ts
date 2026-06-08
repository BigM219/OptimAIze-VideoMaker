// Typed client for the OptimAIze-VideoMaker backend (/api/v1/vm).

const BASE = "/api/v1/vm";

export interface Scene {
  id: string;
  title: string;
  durationInFrames: number;
  narration: string;
  visual: string;
}
export interface Storyboard {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: Scene[];
}
export interface ProjectStep {
  index: number;
  timestamp: number;
  phase: string;
  detail: string;
}
export interface Project {
  id: string;
  sandbox_id: string | null;
  prompt: string;
  requirements: string;
  goals: string;
  state: string;
  studio_url: string | null;
  storyboard: Storyboard | null;
  export_path: string | null;
  error: string | null;
  steps: ProjectStep[];
  chat: Array<{ role: string; content: string }>;
  created_at: number;
  updated_at: number;
}
export interface FileEntry {
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}
export interface SkillInfo {
  available: boolean;
  name: string;
  description: string;
  path: string;
  core_chars: number;
  rules: string[];
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  listProjects: () => fetch(`${BASE}/projects`).then((r) => j<{ projects: Project[] }>(r)),
  createProject: (body: { prompt: string; requirements: string; goals: string }) =>
    fetch(`${BASE}/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Project>(r)),
  getProject: (id: string) => fetch(`${BASE}/projects/${id}`).then((r) => j<Project>(r)),
  listFiles: (id: string, path = ".") =>
    fetch(`${BASE}/projects/${id}/files?path=${encodeURIComponent(path)}`).then((r) => j<{ entries: FileEntry[] }>(r)),
  readFile: (id: string, path: string) =>
    fetch(`${BASE}/projects/${id}/files/content?path=${encodeURIComponent(path)}`).then((r) => j<{ path: string; content: string }>(r)),
  writeFile: (id: string, path: string, content: string) =>
    fetch(`${BASE}/projects/${id}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) }).then((r) => j<FileEntry>(r)),
  launchStudio: (id: string) =>
    fetch(`${BASE}/projects/${id}/studio`, { method: "POST" }).then((r) => j<{ ok: boolean; url: string; port: number }>(r)),
  generate: (id: string, body: { concept: string; audience?: string; duration_s?: number }) =>
    fetch(`${BASE}/projects/${id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Project>(r)),
  chat: (id: string, message: string, activeFile: string) =>
    fetch(`${BASE}/projects/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, active_file: activeFile }) }).then((r) =>
      j<{ ok: boolean; note: string; edited: string[]; project: Project }>(r),
    ),
  exportVideo: (id: string) => fetch(`${BASE}/projects/${id}/export`, { method: "POST" }).then((r) => j<{ ok: boolean; export_path?: string; detail?: string }>(r)),
  skills: () => fetch(`${BASE}/skills`).then((r) => j<{ skills: SkillInfo[] }>(r)),
  skillRule: (name: string) => fetch(`${BASE}/skills/rule?name=${encodeURIComponent(name)}`).then((r) => j<{ name: string; content: string }>(r)),
  rawUrl: (id: string, path: string) => `${BASE}/projects/${id}/files/raw?path=${encodeURIComponent(path)}&t=${Date.now()}`,
  exportRawUrl: (id: string) => `${BASE}/projects/${id}/export/raw?t=${Date.now()}`,
};
