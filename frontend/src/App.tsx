import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { api, type Project, type FileEntry, type SkillInfo, type ModelEntry } from "./lib/api";
import { Transcript } from "./components/Transcript";
import { SlideStudio } from "./components/SlideStudio";

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
  const [showSettings, setShowSettings] = useState(false);
  const pollRef = useRef<number | null>(null);

  // One-shot: a plain-language request is enough. Create the project, wait for
  // scaffold, then auto-generate the whole video from the same sentence — no
  // code knowledge or extra fields needed (the skill carries the how-to).
  const describeAndMake = useCallback(async (request: string) => {
    setBusy(true);
    try {
      const p = await api.createProject({ prompt: request, requirements: "", goals: request });
      setProject(p);
      // poll until the sandbox is scaffolded, then kick off generation
      for (let i = 0; i < 30; i++) {
        const cur = await api.getProject(p.id);
        if (cur.state === "ready") {
          await api.generate(p.id, { concept: request });
          break;
        }
        if (cur.state === "failed") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
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
        // Our self-written studio rebuilds itself after each scene; the slide
        // deck reads studio_version off the polled project to bust the iframe.
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

  if (!project) return <Welcome onMake={describeAndMake} busy={busy} />;

  const working = project.state === "generating" || project.state === "rendering";

  return (
    <div className="vm-app">
      <header className="vm-nav">
        <span className="brand-mark">
          <span className="logo-bracket">[</span>OptimAIze<strong><span>/</span></strong>VideoMaker<span className="logo-bracket">]</span>
        </span>
        <span className={`status-chip${project.state === "ready" ? " status-chip--ok" : ""}`}>{project.state}</span>
        <span className="muted small mono">{project.id}</span>
        <div className="spacer" />
        <ConceptBar onGenerate={generate} busy={busy || working} />
        <button className="secondary-action" onClick={exportVideo} disabled={busy || project.state !== "ready"}>Export mp4</button>
        <button className="ghost-action" onClick={() => setShowSettings(true)}>Settings</button>
      </header>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <div className="vm-layout">
        {/* Left: live coding-agent transcript */}
        <section className="vm-pane vm-pane--transcript">
          <Transcript steps={project.steps} state={project.state} error={project.error} />
        </section>

        {/* Center: slide deck — each scene is a live Studio composition */}
        <section className="vm-pane vm-pane--preview">
          <div className="vm-pane-head"><span className="eyebrow">Slides</span></div>
          <div className="vm-preview-body">
            <SlideStudio
              project={project}
              storyboard={project.storyboard}
              onProjectUpdate={setProject}
            />
          </div>
        </section>

        {/* Right: files + editor + code-aware chat */}
        <section className="vm-pane vm-pane--side">
          <div className="vm-filetree">
            <div className="vm-pane-head"><span className="eyebrow">Files</span></div>
            {files.length === 0 && <div className="muted pad small">No files yet — generating…</div>}
            {files.map((f) => (
              <div key={f} className={"vm-file-row" + (f === activeFile ? " active" : "")} onClick={() => openFile(f)}>
                {f.replace(/^src\//, "")}
              </div>
            ))}
          </div>
          <div className="vm-editor">
            <div className="vm-editor-head">
              <span className="mono small">{activeFile || "(no file)"}</span>
              <button className="ghost-action vm-mini" onClick={saveFile} disabled={!dirty || !activeFile}>
                {dirty ? "Save ↵" : "Saved"}
              </button>
            </div>
            <div className="vm-editor-body">
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
          <div className="vm-chat">
            <div className="vm-chat-log">
              {chat.length === 0 && <div className="muted small pad">Steer the video by chat. The model sees every file + the goal.</div>}
              {chat.map((m, i) => (
                <div key={i} className={"vm-msg vm-msg--" + m.role}>
                  <b>{m.role}</b>
                  <div>{m.content}</div>
                </div>
              ))}
            </div>
            <div className="vm-chat-input">
              <textarea
                rows={2}
                placeholder="e.g. 'đổi tiêu đề sang tiếng Việt và nền tím'…"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void sendChat();
                }}
              />
              <button className="primary-action vm-mini" onClick={sendChat} disabled={busy || !chatInput.trim()}>
                Send
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Welcome({ onMake, busy }: { onMake: (request: string) => void; busy: boolean }) {
  const [request, setRequest] = useState("");
  const example = "Làm cho tôi một video hướng dẫn cơ bản về linear regression, mọi thứ được diễn giải rõ ràng từ công thức đến hình ảnh";
  return (
    <div className="welcome">
      <h1>OptimAIze-VideoMaker</h1>
      <p className="muted">Mô tả video bạn muốn bằng một câu. AI sẽ tự lên kịch bản, viết và dựng video — bạn không cần biết code.</p>
      <textarea
        rows={4}
        value={request}
        placeholder={example}
        onChange={(e) => setRequest(e.target.value)}
      />
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="primary-action" onClick={() => onMake(request.trim() || example)} disabled={busy}>
          {busy ? "Đang tạo…" : "Tạo video"}
        </button>
        <button className="secondary-action" onClick={() => setRequest(example)} disabled={busy}>
          Dùng ví dụ
        </button>
      </div>
    </div>
  );
}

function ConceptBar({ onGenerate, busy }: { onGenerate: (c: string) => void; busy: boolean }) {
  const [concept, setConcept] = useState("Explain linear regression for beginners");
  return (
    <div className="conceptbar">
      <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Concept for a complete video…" />
      <button className="primary-action vm-mini" onClick={() => onGenerate(concept)} disabled={busy}>
        {busy ? "Generating…" : "Generate video"}
      </button>
    </div>
  );
}

// Settings: shows the active video-skill given to the LLM (name, description,
// the always-on core size, and the on-demand rules). Lets the user verify what
// Model manager: add models from any provider (OpenRouter, z.ai, or a custom
// OpenAI-compatible base URL), enable/disable, and set the fallback priority
// order by moving entries up/down. Persisted server-side to models.json.
function ModelManager() {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  // new-entry form
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyEnv, setKeyEnv] = useState("");

  useEffect(() => {
    void api.models().then((r) => setModels(r.models)).catch(() => setModels([]));
  }, []);

  const persist = useCallback(async (next: ModelEntry[]) => {
    setModels(next);
    setSaving(true);
    try {
      await api.saveModels(next);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }, []);

  if (!models) return <p className="muted">Loading models…</p>;

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= models.length) return;
    const next = models.slice();
    [next[i], next[j]] = [next[j], next[i]];
    void persist(next);
  };
  const toggle = (i: number) => {
    const next = models.slice();
    next[i] = { ...next[i], enabled: !next[i].enabled };
    void persist(next);
  };
  const remove = (i: number) => void persist(models.filter((_, k) => k !== i));
  const add = () => {
    if (!model.trim()) return;
    const e: ModelEntry = { model: model.trim(), provider, enabled: true };
    if (provider === "custom") {
      e.baseUrl = baseUrl.trim();
      e.keyEnv = keyEnv.trim();
    }
    void persist([...models, e]);
    setModel("");
    setBaseUrl("");
    setKeyEnv("");
  };

  return (
    <div>
      <div className="modal-head">
        <h3 style={{ margin: 0 }}>Model fallback chain</h3>
        <span className="muted small">{saving ? "saving…" : savedAt ? "saved ✓" : ""}</span>
      </div>
      <p className="muted small">
        Tried top-to-bottom; the first that responds wins. Put fast, reliable models first.
        Disabled models are skipped. Mix providers freely.
      </p>
      <div className="model-list">
        {models.map((m, i) => (
          <div className={`model-row${m.enabled ? "" : " off"}`} key={`${m.provider}:${m.model}:${i}`}>
            <span className="model-ord">{i + 1}</span>
            <input type="checkbox" checked={m.enabled} onChange={() => toggle(i)} title="enabled" />
            <span className="model-name mono">{m.model}</span>
            <span className={`prov prov-${m.provider}`}>{m.provider}</span>
            {m.provider === "custom" && <span className="muted small mono">{m.baseUrl}</span>}
            <span className="model-actions">
              <button className="small secondary" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="small secondary" disabled={i === models.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button className="small danger" onClick={() => remove(i)}>✕</button>
            </span>
          </div>
        ))}
      </div>
      <div className="model-add">
        <input placeholder="model id (e.g. google/gemma-4-31b-it:free)" value={model} onChange={(e) => setModel(e.target.value)} />
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="openrouter">OpenRouter</option>
          <option value="zai">z.ai</option>
          <option value="custom">Custom</option>
        </select>
        {provider === "custom" && (
          <>
            <input placeholder="base URL (OpenAI-compatible)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <input placeholder="API key env var (e.g. MY_KEY)" value={keyEnv} onChange={(e) => setKeyEnv(e.target.value)} />
          </>
        )}
        <button onClick={add}>Add model</button>
      </div>
    </div>
  );
}

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
          <h2>Settings</h2>
          <button className="small secondary" onClick={onClose}>Close</button>
        </div>

        <ModelManager />
        <h3 style={{ marginTop: 18 }}>LLM Skill</h3>
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
