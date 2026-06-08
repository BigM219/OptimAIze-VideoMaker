# OptimAIze-VideoMaker

An OptimAIze child module dedicated to **making videos**. It scaffolds a video
project, lets the LLM author a complete educational video from a single concept,
and gives you a live preview, a multi-file code editor, and a code-aware chat to
refine it — then exports an `.mp4`.

It builds on the sandbox/render/LLM foundation proven in OptimAIze-Work (Windows
Job Object cage + filesystem jail, `npx create-video` scaffolding, headless
render, OpenRouter client with an ordered model fallback, `files/raw` HTTP-Range
serving).

## What it does

- **Concept → complete video.** Give it a concept (e.g. "Explain linear
  regression for beginners"). A multi-step director loop plans a storyboard,
  writes one component per scene, assembles the composition, and renders — with
  autonomous repair passes if a render fails.
- **Live preview.** Launches the video dev studio per project and embeds it in
  the UI; edits hot-reload the preview.
- **Code editor.** A Monaco multi-file editor over the project's `src/`; saves
  write back into the sandbox.
- **Code-aware chat.** Steer the video by chat. Every request carries full
  context — all files, the project goal, requirements, and the storyboard — so
  edits stay coherent with the whole project, not just the open file.
- **Export.** Renders the final `.mp4`, downloadable with HTTP Range support.

## Layout

```
frontend/                # Vite + React + TS: 3-pane UI (editor | preview | chat)
impl/
  ts/                    # Node + Hono backend on port 8003 (reference impl)
  go/                    # Go backend (parity)
.optimaize/skills/
  video-skills/          # domain best-practices skill fed to the LLM
    SKILL.md             # always-on core guidance
    rules/*.md           # topic rules loaded on demand (text, charts, timing, ...)
```

## Backend API (`/api/v1/vm`, port 8003)

- `GET /health`, `GET /runtime-config`
- `POST /projects`, `GET /projects`, `GET /projects/:id`
- `GET /projects/:id/files`, `/files/content`, `POST /files`, `/files/raw` (Range)
- `POST /projects/:id/studio` — launch the live preview studio
- `POST /projects/:id/generate` — concept-driven director loop
- `POST /projects/:id/chat` — code-aware chat edit (full context)
- `POST /projects/:id/export`, `GET /projects/:id/export/raw`

## The video skill

`.optimaize/skills/video-skills/` follows the `.optimaize` skills layout. `SKILL.md`
(the curated core) is injected into every authoring/editing prompt; the
`rules/*.md` files are pulled in on demand per scene by keyword (e.g. a charting
scene gets the chart rule). This gives the model domain knowledge without
flooding the context window.

## LLM model fallback

`OPENROUTER_MODEL` is a comma-separated **ordered fallback list**. The client
tries each model in turn, uses one attempt per model (the list is the
redundancy), and a **session circuit breaker** skips a model after it fails
twice — so a reliably-down or rate-limited model never wastes time again in the
session. Order the list fast-and-reliable first.

## Run (TS)

```bash
cd frontend && npm install && npm run build
cd ../impl/ts && npm install && npm run build && npm start   # serves UI + API on :8003
```

Copy `impl/ts/.env.example` to `impl/ts/.env` and set `OPENROUTER_API_KEY`.

## Security boundary (honest)

The process sandbox is **hardening, not a VM boundary** — it shares the host
kernel. It isolates per-project dependencies and caps resources (dev ~50% /
prod ~80%), but does not contain hostile code.
