import { useEffect, useMemo, useState } from "react";
import type { Scene, Storyboard } from "../lib/api";

// A slide deck on top of Remotion Studio. Each storyboard scene is its own
// Remotion <Composition>, so Studio renders it live from code (hot-reload) —
// the slide IS the code, there is no per-scene mp4. Clicking a slide deep-links
// the Studio iframe to that composition (`{studioUrl}/{SceneId}`); the slide
// becomes reviewable the moment its code is written. Status (pending / writing
// / ready / error) updates live as the director works through the storyboard.

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

function SlideThumb({
  scene,
  active,
  onClick,
}: {
  scene: Scene;
  active: boolean;
  onClick: () => void;
}) {
  const st = statusOf(scene);
  return (
    <button className={`ss-thumb ss-thumb--${st}${active ? " active" : ""}`} onClick={onClick}>
      <span className="ss-thumb-id mono">{scene.id}</span>
      <span className={`ss-badge ss-badge--${st}`}>{LABEL[st] ?? st}</span>
    </button>
  );
}

export function SlideStudio({
  storyboard,
  studioUrl,
  onLaunchStudio,
  launching,
}: {
  storyboard: Storyboard | null;
  studioUrl: string | null;
  onLaunchStudio: () => void;
  launching: boolean;
}) {
  const scenes = storyboard?.scenes ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);

  // Auto-follow the scene the director is actively writing, until the user
  // manually picks a slide to review.
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
        Slide deck sẽ hiện ở đây — mỗi cảnh là một composition, xem trực tiếp trong Studio ngay khi code được viết.
      </div>
    );
  }

  const current = scenes.find((s) => s.id === selected) ?? scenes[activeIdx];
  const st = current ? statusOf(current) : "pending";
  const readyCount = scenes.filter((s) => statusOf(s) === "ready").length;
  // Deep-link the Studio iframe straight to the selected composition.
  const frameSrc = studioUrl && current ? `${studioUrl}/${current.id}` : "";

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
            {!following && (
              <button className="ghost-action vm-mini" onClick={() => setFollowing(true)}>
                Theo dõi cảnh đang viết
              </button>
            )}
          </div>

          <div className="ss-stage">
            {!studioUrl ? (
              <div className="ss-stage-msg">
                <p>Studio chưa chạy.</p>
                <button className="primary-action vm-mini" onClick={onLaunchStudio} disabled={launching}>
                  {launching ? "Đang mở Studio…" : "Mở Studio để xem slide"}
                </button>
              </div>
            ) : st === "pending" ? (
              <div className="ss-stage-msg muted">
                <div className="ss-spin-icon">○</div>
                <p>Chờ tới lượt cảnh này.</p>
              </div>
            ) : st === "writing" ? (
              <div className="ss-stage-msg">
                <div className="ss-spinner" />
                <p>Đang viết code cảnh này… slide sẽ hiện ngay khi xong.</p>
              </div>
            ) : (
              // ready or error: show the live composition. A broken scene still
              // renders in Studio (with its error overlay); repair fixes it in
              // place and the iframe hot-reloads.
              <>
                <iframe key={current.id} title={current.id} src={frameSrc} className="ss-frame" />
                {st === "error" && renderErrorOf(current) && (
                  <details className="ss-error-strip">
                    <summary>Cảnh này có lỗi build — đang được sửa dần</summary>
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
