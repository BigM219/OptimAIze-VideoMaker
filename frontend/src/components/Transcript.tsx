import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectStep } from "../lib/api";

// Renders the director's typed timeline as a live coding-agent transcript —
// the way Claude Code / opencode / Codex show their work: planning, writing
// files (with the code), running commands + their output, and iterating
// through repair turns. Auto-scrolls to the newest step and shows a working
// pulse + elapsed timer while the run is active.

function exitOf(s: ProjectStep): number | undefined {
  return s.exit_code ?? s.exitCode;
}

function langOf(path: string | undefined): string {
  if (!path) return "tsx";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  return "tsx";
}

function FileStep({ s, open }: { s: ProjectStep; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  return (
    <div className="tr-card tr-file">
      <button className="tr-file-head" onClick={() => setExpanded((v) => !v)}>
        <span className="tr-caret">{expanded ? "▾" : "▸"}</span>
        <span className="tr-icon">✎</span>
        <span className="mono tr-path">{s.path ?? s.detail}</span>
        {s.content !== undefined && <span className="tr-bytes">{s.content.length} chars</span>}
      </button>
      {expanded && s.content !== undefined && (
        <pre className={`tr-code lang-${langOf(s.path)}`}>{s.content}</pre>
      )}
    </div>
  );
}

function CommandStep({ s }: { s: ProjectStep }) {
  return (
    <div className="tr-line tr-cmd">
      <span className="tr-prompt">$</span>
      <span className="mono">{s.command ?? s.detail}</span>
    </div>
  );
}

function OutputStep({ s }: { s: ProjectStep }) {
  const code = exitOf(s);
  const ok = code === 0;
  const [open, setOpen] = useState(!ok); // failures open by default
  return (
    <div className="tr-card tr-output">
      <button className="tr-out-head" onClick={() => setOpen((v) => !v)}>
        <span className="tr-caret">{open ? "▾" : "▸"}</span>
        <span className={`tr-exit ${ok ? "ok" : "bad"}`}>exit {code ?? "?"}</span>
        <span className="muted small">{ok ? "succeeded" : "failed"} · click to {open ? "hide" : "show"} output</span>
      </button>
      {open && s.output && <pre className="tr-code tr-stdout">{s.output.trim()}</pre>}
    </div>
  );
}

function PlanStep({ s }: { s: ProjectStep }) {
  return (
    <div className="tr-card tr-plan">
      <div className="tr-plan-head">
        <span className="tr-icon">◆</span> Storyboard planned
      </div>
      <pre className="tr-code">{s.content ?? s.detail}</pre>
    </div>
  );
}

export function Transcript({ steps, state, error }: { steps: ProjectStep[]; state: string; error: string | null }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const active = state === "generating" || state === "rendering" || state === "scaffolding";
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  // Reset/advance the elapsed timer while the run is active.
  useEffect(() => {
    if (!active) return;
    if (steps.length === 0) startRef.current = Date.now();
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [active, steps.length]);

  // Auto-scroll to newest step.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [steps.length]);

  const lastWriteIdx = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].kind === "write_file") return steps[i].index;
    return -1;
  }, [steps]);

  return (
    <div className="transcript">
      <div className="tr-top">
        <span className={`tr-led ${active ? "live" : state === "failed" ? "bad" : "idle"}`} />
        <span className="tr-title">AGENT PROCESS</span>
        <span className="muted small mono tr-state">{state}</span>
        {active && <span className="muted small tr-elapsed">{elapsed}s</span>}
      </div>

      <div className="tr-body">
        {steps.length === 0 && (
          <p className="muted pad">Waiting for the agent to start…</p>
        )}
        {steps.map((s) => {
          const kind = s.kind ?? s.phase;
          if (kind === "plan" || s.phase === "storyboard") return <PlanStep key={s.index} s={s} />;
          if (kind === "write_file" || s.phase === "scene" || s.phase === "assemble")
            return <FileStep key={s.index} s={s} open={s.index === lastWriteIdx} />;
          if (kind === "command") return <CommandStep key={s.index} s={s} />;
          if (kind === "command_output") return <OutputStep key={s.index} s={s} />;
          if (kind === "repair")
            return (
              <div key={s.index} className="tr-line tr-repair">
                <span className="tr-icon">⟳</span> {s.detail}
              </div>
            );
          if (kind === "error")
            return (
              <div key={s.index} className="tr-line tr-err">
                <span className="tr-icon">✕</span> {s.detail}
              </div>
            );
          return (
            <div key={s.index} className="tr-line tr-info">
              <span className="tr-dot" /> <b>{s.phase}</b> {s.detail}
            </div>
          );
        })}
        {active && (
          <div className="tr-working">
            <span className="tr-cursor">▋</span> working…
          </div>
        )}
        {error && (
          <div className="tr-line tr-err">
            <span className="tr-icon">✕</span> {error}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
