// HTTP API for OptimAIze-VideoMaker (Hono). Port 8003, routes under /api/v1/vm.
// Reuses the sandbox file ops via the ProjectStore; adds project lifecycle,
// Remotion Studio launch, concept-driven generation, code-aware chat, export.

import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getProjectStore } from "./projects.js";
import { generateConcept, chatEdit } from "./director.js";
import { getSandboxPolicy, policyToWire } from "./policy.js";
import { skillInfo, skillRule } from "./skills.js";
import { getModels, setModels, type ModelEntry } from "./models-config.js";
import { WorkError } from "./types.js";

const SERVICE = "OptimAIze VideoMaker API";
const VERSION = "0.1.0";

function requireApiKey(c: { req: { header(n: string): string | undefined } }): void {
  const expected = (process.env.OPTIMAIZE_API_KEY ?? "").trim();
  if (!expected) return;
  const got = c.req.header("X-API-Key");
  if (!got || got !== expected) {
    const e = new WorkError("Missing or invalid API key.");
    e.status = 401;
    throw e;
  }
}

function projectWire(p: ReturnType<ReturnType<typeof getProjectStore>["get"]>): Record<string, unknown> {
  return {
    id: p.id,
    sandbox_id: p.sandboxId,
    prompt: p.prompt,
    requirements: p.requirements,
    goals: p.goals,
    state: p.state,
    studio_url: p.studioUrl,
    storyboard: p.storyboard,
    export_path: p.exportPath,
    error: p.error,
    steps: p.steps,
    chat: p.chat,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function buildApp(webDir: string): Hono {
  const app = new Hono();
  app.use("*", cors());
  app.onError((err, c) => {
    const status = err instanceof WorkError ? err.status : 500;
    return c.json({ detail: String(err.message ?? err) }, status as 400);
  });

  app.get("/health", (c) => c.json({ ok: true, service: SERVICE, version: VERSION }));
  app.get("/", (c) => {
    try {
      return c.html(fs.readFileSync(path.join(webDir, "index.html"), "utf-8"));
    } catch {
      return c.text("OptimAIze-VideoMaker. Frontend not built yet.", 200);
    }
  });

  const vm = new Hono();
  vm.use("*", async (c, next) => {
    requireApiKey(c);
    await next();
  });

  vm.get("/health", (c) =>
    c.json({ ok: true, service: SERVICE, version: VERSION, platform: process.platform }),
  );
  vm.get("/runtime-config", (c) => c.json({ policy: policyToWire(getSandboxPolicy()) }));

  // Skills surfaced for the settings/config UI: what domain knowledge the LLM
  // is given. The skill lives at .optimaize/skills/video-skills.
  vm.get("/skills", (c) => c.json({ skills: [skillInfo()] }));
  vm.get("/skills/rule", (c) => {
    const name = c.req.query("name");
    if (!name) return c.json({ detail: "name is required" }, 400);
    const body = skillRule(name);
    if (body === null) return c.json({ detail: "rule not found" }, 404);
    return c.json({ name, content: body });
  });

  // Model fallback chain: users can add models from any provider (OpenRouter,
  // z.ai, or a custom OpenAI-compatible base URL) and set the priority order.
  vm.get("/models", (c) => c.json({ models: getModels() }));
  vm.put("/models", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { models?: ModelEntry[] };
    if (!Array.isArray(b.models)) return c.json({ detail: "models[] required" }, 400);
    return c.json({ models: setModels(b.models) });
  });

  const store = getProjectStore();

  vm.get("/projects", (c) => c.json({ projects: store.list().map(projectWire) }));
  vm.post("/projects", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { prompt?: string; requirements?: string; goals?: string };
    const p = store.create(b.prompt ?? "", b.requirements ?? "", b.goals ?? "");
    return c.json(projectWire(p));
  });
  vm.get("/projects/:id", (c) => c.json(projectWire(store.get(c.req.param("id")))));

  vm.get("/projects/:id/files", (c) => {
    const rel = c.req.query("path") ?? ".";
    return c.json({ entries: store.listFiles(c.req.param("id"), rel) });
  });
  vm.get("/projects/:id/files/content", (c) => {
    const p = c.req.query("path");
    if (!p) return c.json({ detail: "path is required" }, 400);
    return c.json({ path: p, content: store.readFile(c.req.param("id"), p) });
  });
  vm.post("/projects/:id/files", async (c) => {
    const b = (await c.req.json()) as { path: string; content?: string };
    const entry = store.writeFile(c.req.param("id"), b.path, b.content ?? "");
    return c.json(entry as Record<string, unknown>);
  });
  vm.get("/projects/:id/files/raw", (c) => {
    const p = c.req.query("path");
    if (!p) return c.json({ detail: "path is required" }, 400);
    const abs = store.rawPath(c.req.param("id"), p);
    return serveFileWithRange(c, abs);
  });

  vm.post("/projects/:id/studio", (c) => {
    const r = store.launchStudio(c.req.param("id"));
    return c.json({ ok: true, ...r });
  });

  vm.post("/projects/:id/generate", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => ({}))) as { concept?: string; audience?: string; duration_s?: number };
    // Fire-and-forget; poll the project for progress.
    void generateConcept(store, id, b.concept ?? store.get(id).prompt, b.audience ?? "", b.duration_s ?? 30);
    return c.json(projectWire(store.get(id)));
  });

  vm.post("/projects/:id/chat", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => ({}))) as { message?: string; active_file?: string };
    const r = await chatEdit(store, id, b.message ?? "", b.active_file ?? "");
    return c.json({ ok: true, ...r, project: projectWire(store.get(id)) });
  });

  vm.post("/projects/:id/export", async (c) => {
    const id = c.req.param("id");
    const p = store.get(id);
    if (!p.sandboxId) return c.json({ detail: "no sandbox" }, 400);
    const backend = store.manager().backendFor(p.sandboxId);
    // Synchronous render (deps already installed); returns when mp4 is ready.
    const r = await backend.exec(p.sandboxId, "npx --no-install remotion render Video out/video.mp4", { timeoutS: 1200 });
    if (r.exitCode !== 0) return c.json({ ok: false, detail: r.stderr.slice(0, 400) }, 500);
    p.exportPath = "out/video.mp4";
    return c.json({ ok: true, export_path: p.exportPath });
  });
  vm.get("/projects/:id/export/raw", (c) => {
    const p = store.get(c.req.param("id"));
    if (!p.exportPath) return c.json({ detail: "not exported yet" }, 404);
    return serveFileWithRange(c, store.rawPath(p.id, p.exportPath));
  });

  app.route("/api/v1/vm", vm);
  return app;
}

function serveFileWithRange(c: any, abs: string) {
  const total = fs.statSync(abs).size;
  const mime = guessMime(abs);
  const range = c.req.header("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      const chunk = fs.readFileSync(abs).subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunk.length),
        },
      });
    }
  }
  return new Response(fs.readFileSync(abs), {
    status: 200,
    headers: { "Content-Type": mime, "Accept-Ranges": "bytes", "Content-Length": String(total) },
  });
}

function guessMime(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", json: "application/json", txt: "text/plain", html: "text/html",
    js: "text/javascript", css: "text/css",
  };
  return map[ext] ?? "application/octet-stream";
}
