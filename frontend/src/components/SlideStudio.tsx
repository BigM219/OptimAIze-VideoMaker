import { useEffect, useMemo, useState } from "react";
import { api, type Scene, type Storyboard, type Project } from "../lib/api";

// Self-written studio. Each storyboard scene is its own Remotion <Composition>;
// the backend bundles a @remotion/player site INSIDE the sandbox and serves it,
// and this iframe deep-links to a scene in that bundle (NOT remotion studio).
// Per-frame probing runs server-side after each scene (and on demand via the
// "Probe lại" button); a failing scene shows WHICH frame broke + the stderr.

function statusOf(s: Scene): NonNullable<Scene["status"]> {
  return s.status ?? "pending";
}
function renderErrorOf(s: Scene): string | undefined {
  return s.renderError ?? s.render_error;
}

const LABEL: Record<string, string> = {
  pending: "chờ",
  writing: "đang viết",
  ready: "sẵn sàng",
  error: "lỗi",
};

function SlideThumb({ scene, active, onClick }: { scene: Scene; active: boolean; onClick: () => void }) {
  const st = statusOf(scene);
  return (
    <button className={`ss-thumb ss-thumb--${st}${active ? " active" : ""}`} onClick={onClick}>
      <span className="ss-thumb-id mono">{scene.id}</span>
      <span className={`ss-badge ss-badge--${st}`}>{LABEL[st] ?? st}</span>
    </button>
  );
}

export function SlideStudio({
  project,
  storyboard,
  onProjectUpdate,
}: {
  project: Project;
  storyboard: Storyboard | null;
  onProjectUpdate: (p: Project) => void;
}) {
  const scenes = storyboard?.scenes ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [probing, setProbing] = useState(false);

  const version = project.studio_version ?? 0;

  // Auto-follow the scene the director is actively writing, until the user picks
  // a slide to review.
  const activeIdx = useMemo(() => {
    const writing = scenes.findIndex((s) => statusOf(s) === "writing");
    if (writing >= 0) return writing;
    const lastReady = scenes.map(statusOf).lastIndexOf("ready");
    return lastReady >= 0 ? lastReady : 0;
  }, [scenes]);

  useEffect(() => {
    if (following && scenes[activeIdx]) setSelected(scenes[activeIdx].id);
  }, [following, activeIdx, scenes]);

  if (scenes.length === 0) {
    return (
      <div className="ss-empty muted pad vm-center">
        Slide deck sẽ hiện ở đây — mỗi cảnh là một composition, dựng bằng player tự viết ngay khi code được viết.
      </div>
    );
  }

  const current = scenes.find((s) => s.id === selected) ?? scenes[activeIdx];
  const st = current ? statusOf(current) : "pending";
  const readyCount = scenes.filter((s) => statusOf(s) === "ready").length;
  // Our own player bundle, deep-linked to the selected scene + version-busted so
  // the iframe reloads after each rebuild.
  const frameSrc = current && version > 0 ? api.studioFrameUrl(project.id, current.id, version) : "";

  const reprobe = async () => {
    if (!current || probing) return;
    setProbing(true);
    try {
      const r = await api.probeScene(project.id, current.id);
      onProjectUpdate(r.project);
    } catch {
      /* ignore — transcript shows the error */
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="ss-root">
      <div className="ss-filmstrip">
        {scenes.map((s) => (
          <SlideThumb
            key={s.id}
            scene={s}
            active={s.id === current?.id}
            onClick={() => {
              setFollowing(false);
              setSelected(s.id);
            }}
          />
        ))}
        <span className="ss-progress muted small mono">{readyCount}/{scenes.length} sẵn sàng</span>
      </div>

      {current && (
        <div className="ss-view">
          <div className="ss-view-head">
            <span className="ss-view-title mono">{current.id}</span>
            <span className="muted small">· {current.title}</span>
            <span className={`ss-badge ss-badge--${st}`}>{LABEL[st] ?? st}</span>
            <span className="muted small ss-frames">{current.durationInFrames}f</span>
            <div className="spacer" style={{ flex: 1 }} />
            <button className="ghost-action vm-mini" onClick={reprobe} disabled={probing || st === "writing" || st === "pending"}>
              {probing ? "Đang probe…" : "Probe lại cảnh này"}
            </button>
            {!following && (
              <button className="ghost-action vm-mini" onClick={() => setFollowing(true)}>
                Theo dõi cảnh đang viết
              </button>
            )}
          </div>

          <div className="ss-stage">
            {st === "pending" ? (
              <div className="ss-stage-msg muted">
                <div className="ss-spin-icon">○</div>
                <p>Chờ tới lượt cảnh này.</p>
              </div>
            ) : st === "writing" ? (
              <div className="ss-stage-msg">
                <div className="ss-spinner" />
                <p>Đang viết code cảnh này… slide sẽ hiện ngay khi xong.</p>
              </div>
            ) : version === 0 ? (
              <div className="ss-stage-msg muted">
                <div className="ss-spinner" />
                <p>Đang dựng player…</p>
              </div>
            ) : (
              // ready or error: show the live player. A scene flagged "error"
              // still has a file; the player shows it (it may throw at the broken
              // frame), and the overlay names the exact failing frame.
              <>
                <iframe key={`${current.id}:${version}`} title={current.id} src={frameSrc} className="ss-frame" />
                {st === "error" && renderErrorOf(current) && (
                  <details className="ss-error-strip" open>
                    <summary>Cảnh này lỗi render — {renderErrorOf(current)?.split("\n")[0]}</summary>
                    <pre className="ss-error-log">{renderErrorOf(current)}</pre>
                  </details>
                )}
              </>
            )}
          </div>

          <div className="ss-narration">
            <span className="eyebrow">Nội dung</span>
            <p>{current.narration}</p>
          </div>
        </div>
      )}
    </div>
  );
}
