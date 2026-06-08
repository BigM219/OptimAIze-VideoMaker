import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { api, type Project, type FileEntry, type SkillInfo } from "./lib/api";

// Recursively flatten the project's src tree into a sorted file list.
async function loadFiles(projectId: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: FileEntry[] = [];
    try {
      entries = (await api.listFiles(projectId, rel)).entries;
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.is_dir) {
        if (!e.path.includes("node_modules")) await walk(e.path);
      } else if (/\.(tsx?|css|json)$/.test(e.path) && !e.path.includes("node_modules")) {
        out.push(e.path);
      }
    }
  };
  await walk("src");
  return out.sort();
}

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [chat, setChat] = useState<Array<{ role: string; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [studioUrl, setStudioUrl] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const pollRef = useRef<number | null>(null);

  // ---- create / new ----
  const createProject = useCallback(async (prompt: string, requirements: string, goals: string) => {
    setBusy(true);
    try {
      const p = await api.createProject({ prompt, requirements, goals });
      setProject(p);
    } finally {
      setBusy(false);
    }
  }, []);

  // ---- poll project state ----
  useEffect(() => {
    if (!project) return;
    const tick = async () => {
      try {
        const p = await api.getProject(project.id);
        setProject(p);
        setChat(p.chat);
        if (p.state === "ready" || p.state === "failed") {
          setFiles(await loadFiles(p.id));
        }
      } catch {
        /* ignore */
      }
    };
    pollRef.current = window.setInterval(tick, 3000);
    void tick();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [project?.id]);

  // ---- open a file ----
  const openFile = useCallback(
    async (path: string) => {
      if (!project) return;
      setActiveFile(path);
      try {
        const { content } = await api.readFile(project.id, path);
        setCode(content);
        setDirty(false);
      } catch {
        setCode("");
      }
    },
    [project],
  );

  const saveFile = useCallback(async () => {
    if (!project || !activeFile) return;
    await api.writeFile(project.id, activeFile, code);
    setDirty(false);
  }, [project, activeFile, code]);

  const launchStudio = useCallback(async () => {
    if (!project) return;
    const r = await api.launchStudio(project.id);
    setStudioUrl(r.url);
  }, [project]);

  const generate = useCallback(
    async (concept: string) => {
      if (!project) return;
      setBusy(true);
      try {
        await api.generate(project.id, { concept, duration_s: 24 });
      } finally {
        setBusy(false);
      }
    },
    [project],
  );

  const sendChat = useCallback(async () => {
    if (!project || !chatInput.trim()) return;
    const msg = chatInput;
    setChatInput("");
    setChat((c) => [...c, { role: "user", content: msg }]);
    setBusy(true);
    try {
      const r = await api.chat(project.id, msg, activeFile);
      setChat(r.project.chat);
      setFiles(await loadFiles(project.id));
      if (activeFile && r.edited.includes(activeFile)) await openFile(activeFile);
    } finally {
      setBusy(false);
    }
  }, [project, chatInput, activeFile, openFile]);

  const exportVideo = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    try {
      const r = await api.exportVideo(project.id);
      if (r.ok) window.open(api.exportRawUrl(project.id), "_blank");
      else alert("Export failed: " + (r.detail ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }, [project]);

  if (!project) return <Welcome onCreate={createProject} busy={busy} />;

  return (
    <div className="app">
      <header>
        <h1>OptimAIze-VideoMaker</h1>
        <span className="badge">{project.state}</span>
        <span className="muted">{project.id}</span>
        <div className="spacer" />
        <ConceptBar onGenerate={generate} busy={busy || project.state === "generating" || project.state === "rendering"} />
        <button onClick={launchStudio} disabled={project.state !== "ready"}>Live preview</button>
        <button onClick={exportVideo} disabled={busy || project.state !== "ready"}>Export mp4</button>
        <button className="secondary" onClick={() => setShowSettings(true)}>Settings</button>
      </header>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <div className="layout">
        {/* Left: file tree + editor */}
        <div className="pane editor-pane">
          <div className="filetree">
            {files.length === 0 && <div className="muted pad">No files yet. Generate or wait for scaffold…</div>}
            {files.map((f) => (
              <div key={f} className={"file-row" + (f === activeFile ? " active" : "")} onClick={() => openFile(f)}>
                {f.replace(/^src\//, "")}
              </div>
            ))}
          </div>
          <div className="editor">
            <div className="editor-head">
              <span>{activeFile || "(no file)"}</span>
              <button className="small" onClick={saveFile} disabled={!dirty || !activeFile}>
                {dirty ? "Save (hot-reloads)" : "Saved"}
              </button>
            </div>
            <Editor
              height="100%"
              theme="vs-dark"
              language={activeFile.endsWith(".css") ? "css" : activeFile.endsWith(".json") ? "json" : "typescript"}
              value={code}
              onChange={(v) => {
                setCode(v ?? "");
                setDirty(true);
              }}
              options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true }}
            />
          </div>
        </div>

        {/* Center: live preview (Remotion Studio) */}
        <div className="pane preview-pane">
          {studioUrl ? (
            <iframe title="preview" src={studioUrl} className="studio" />
          ) : project.export_path ? (
            <div className="preview-fallback">
              <video src={api.rawUrl(project.id, project.export_path)} controls />
              <p className="muted">Rendered video. Click "Live preview" for the interactive Studio.</p>
            </div>
          ) : (
            <div className="muted pad center">Click "Live preview" to launch Remotion Studio, or generate a concept first.</div>
          )}
        </div>

        {/* Right: code-aware chat + steps */}
        <div className="pane chat-pane">
          <div className="steps">
            <h3>Director steps</h3>
            {project.steps.slice(-8).map((s) => (
              <div key={s.index} className="step">
                <b>{s.phase}</b> {s.detail}
              </div>
            ))}
            {project.error && <div className="step err">error: {project.error}</div>}
          </div>
          <div className="chat-log">
            {chat.map((m, i) => (
              <div key={i} className={"msg " + m.role}>
                <b>{m.role}</b>
                <div>{m.content}</div>
              </div>
            ))}
          </div>
          <div className="chat-input">
            <textarea
              rows={3}
              placeholder="Edit the video by chat — e.g. 'make the title bigger and the plot points blue'. The model sees every file + the goal."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void sendChat();
              }}
            />
            <button onClick={sendChat} disabled={busy || !chatInput.trim()}>
              Send (Ctrl+Enter)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome({ onCreate, busy }: { onCreate: (p: string, r: string, g: string) => void; busy: boolean }) {
  const [prompt, setPrompt] = useState("Linear regression explainer");
  const [requirements, setRequirements] = useState("beginner-friendly, animated scatter + fitted line");
  const [goals, setGoals] = useState("teach fitting a line to data");
  return (
    <div className="welcome">
      <h1>OptimAIze-VideoMaker</h1>
      <p className="muted">Create a Remotion video project. Edit code, preview live, and steer it by chat. The LLM can author a complete educational video from a single concept.</p>
      <label>Title / prompt</label>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <label>Requirements</label>
      <input value={requirements} onChange={(e) => setRequirements(e.target.value)} />
      <label>Goals</label>
      <input value={goals} onChange={(e) => setGoals(e.target.value)} />
      <button onClick={() => onCreate(prompt, requirements, goals)} disabled={busy}>
        {busy ? "Creating…" : "Create project"}
      </button>
    </div>
  );
}

function ConceptBar({ onGenerate, busy }: { onGenerate: (c: string) => void; busy: boolean }) {
  const [concept, setConcept] = useState("Explain linear regression for beginners");
  return (
    <div className="conceptbar">
      <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Concept for a complete video…" />
      <button onClick={() => onGenerate(concept)} disabled={busy}>
        {busy ? "Generating…" : "Generate video"}
      </button>
    </div>
  );
}

// Settings: shows the active video-skill given to the LLM (name, description,
// the always-on core size, and the on-demand rules). Lets the user verify what
// domain knowledge the model is steered with, and read any rule.
function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [skill, setSkill] = useState<SkillInfo | null>(null);
  const [openRule, setOpenRule] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => {
    void api.skills().then((r) => setSkill(r.skills[0] ?? null)).catch(() => setSkill(null));
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings · LLM Skills</h2>
          <button className="small secondary" onClick={onClose}>Close</button>
        </div>
        {!skill ? (
          <p className="muted">Loading…</p>
        ) : !skill.available ? (
          <p className="muted">No skill installed.</p>
        ) : (
          <div className="skill">
            <div className="skill-row"><b>{skill.name}</b> <span className="badge">active</span></div>
            <p className="muted">{skill.description}</p>
            <div className="muted small">
              Always-on core: {skill.core_chars.toLocaleString()} chars · injected into every authoring/editing prompt.
            </div>
            <div className="muted small mono">{skill.path}</div>
            <h3>On-demand rules ({skill.rules.length})</h3>
            <p className="muted small">Loaded per scene by topic. Click to view.</p>
            <div className="rule-list">
              {skill.rules.map((rname) => (
                <span
                  key={rname}
                  className="rule-chip"
                  onClick={() => void api.skillRule(rname).then(setOpenRule).catch(() => {})}
                >
                  {rname.replace(/\.md$/, "")}
                </span>
              ))}
            </div>
            {openRule && (
              <div className="rule-view">
                <div className="modal-head">
                  <b>{openRule.name}</b>
                  <button className="small secondary" onClick={() => setOpenRule(null)}>×</button>
                </div>
                <pre>{openRule.content}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
