# Harness Reference — opencode & openwork

How opencode exposes an agentic tool harness to an LLM, and how openwork
relates to it. This is a study reference for designing our own harness
(see `harness-design.md`). All paths below are under
`opencode/packages/opencode/src/tool/` unless noted.

---

## 1. Top-level finding: openwork has no harness of its own

OpenWork runs entirely on **opencode's** harness. Verified directly, not just
from `AGENTS.md`:

- `openwork/apps/app/src/components/tools/*.tsx` are **UI renderers only** —
  they display an already-executed tool call (`part.input` / `part.output`) in
  a panel. No `execute`, no schema, no tool definition.
- `openwork/apps/app/src/lib/build-in-tools.ts` is **type-only** — it mirrors
  opencode's tool input/output shapes as TypeScript interfaces plus
  `is*ToolPart` type guards, and treats every tool as an opaque
  `dynamic-tool` part streamed from the opencode server.
- The only LLM-facing tools openwork *authors* are **app-integration tools**,
  registered through opencode's plugin API in
  `openwork/apps/server/src/opencode-plugins/openwork-extensions-preview.ts`:
  `openwork_extension_list_actions`, `openwork_extension_call`,
  `openwork_ui_snapshot`, `openwork_ui_list_actions`,
  `openwork_ui_execute_action`, `openwork_browser_open_url`. These control the
  desktop app / extensions / built-in browser. They are layered *on top of*
  opencode's harness, not a replacement for it.

**Conclusion:** the real harness = opencode's tool set. The rest of this doc
describes that.

---

## 2. How opencode defines a tool

Every tool is built with `Tool.define(id, Effect)` (`tool.ts`). It returns a
`Tool.Def`:

```ts
interface Def {
  id: string
  description: string                 // model-facing text (from the .txt file)
  parameters: Schema.Struct           // Effect Schema -> JSON Schema for the LLM
  jsonSchema?: JSONSchema7            // explicit override (plugin tools, task)
  execute(args, ctx): Effect<ExecuteResult>
  formatValidationError?(error): string
}

interface ExecuteResult {
  title: string                       // short label for the UI
  output: string                      // the text the LLM reads back
  metadata: Record<string, any>       // structured data for the UI / telemetry
  attachments?: FilePart[]            // images / PDFs as data: URLs
}
```

Each tool is two files: `<id>.ts` (schema + logic) and `<id>.txt` (the
description the model sees).

### Shared wrapper behavior (`tool.ts` `wrap`, lines 99–149)

Every tool inherits, for free:

1. **Argument decoding** via `Schema.decodeUnknownEffect(parameters)`. On
   failure it raises `InvalidArgumentsError` (tag `ToolInvalidArgumentsError`)
   whose model-facing message is:
   > The {tool} tool was called with invalid arguments: {detail}.
   > Please rewrite the input so it satisfies the expected schema.
2. **Automatic output truncation** — unless `result.metadata.truncated` is
   already set, `output` is run through `truncate.output(...)` per-agent;
   `metadata.truncated` and (if cut) `metadata.outputPath` are appended.
3. **OpenTelemetry span** `Tool.execute` with `tool.name`, `session.id`,
   `message.id`, optional `tool.call_id`.

### Permission gating

Most tools call `ctx.ask({ permission, patterns, always, metadata })` before
acting. Permission names: `read` → `read`; `write`/`edit`/`apply_patch` →
`edit`; `glob` → `glob`; `grep` → `grep`; `bash` → `bash` (+
`external_directory`); `task` → `task`; `todowrite` → `todowrite`; `lsp` →
`lsp`; `webfetch`/`websearch`/`skill` → own name. `skill` uses
`always: [name]` (per-skill allow); most others use `always: ["*"]`.

### Registry (`registry.ts`)

Builds the active tool list. Notable: `apply_patch` is enabled **only for GPT
models** (`gpt-` and not `oss`/`gpt-4`); for those models `edit`/`write` are
disabled, and vice-versa. `websearch` only when a provider is available.
`lsp`/`plan_exit` behind experimental flags. Plugin tools and project-local
`tool/`,`tools/` `.js`/`.ts` files are discovered and merged.

---

## 3. The tools (input / output / behavior)

### File manipulation

#### `read`
- **Input:** `filePath`\* (string, absolute), `offset` (int, 1-based, opt),
  `limit` (int, opt; default **2000** lines).
- **Output:** XML-wrapped, line-numbered:
  ```
  <path>{abs}</path>
  <type>file</type>
  <content>
  1: first line
  2: second line
  ({trailer})
  </content>
  ```
  Line prefix is `"{n}: "` (no zero-pad — *not* `cat -n`). Trailer reports
  cap/remaining/EOF and the next `offset`. Directories list entries (one per
  line, `/` suffix for subdirs). Images/PDFs return `attachments` with a
  `data:{mime};base64,...` URL and `output` = `"Image read successfully"`.
- **Limits / errors:** 50 KB output cap; per-line cap 2000 chars; binary
  detection (NUL byte, >30% non-printable, or known binary extension) →
  `Cannot read binary file`. `File not found: {path}` (with fuzzy "Did you
  mean" suggestions); `Offset {n} is out of range`.
- **Side effects:** warms the file in Search + LSP `touchFile`.

#### `write`
- **Input:** `content`\* (string), `filePath`\* (string, absolute).
- **Output:** `"Wrote file successfully."` + appended LSP diagnostics (this
  file, then up to **5** other files with errors). `metadata: { diagnostics,
  filepath, exists }`.
- **Notable:** "must Read first" is only an instruction in the `.txt`; **not**
  enforced in code. Uses `edit` permission. Preserves BOM, runs formatter,
  emits filesystem events.

#### `edit`
- **Input:** `filePath`\*, `oldString`\*, `newString`\*, `replaceAll` (bool,
  default false).
- **Output:** `"Edit applied successfully."` + LSP diagnostics.
  `metadata: { diagnostics, diff, filediff{additions,deletions} }`.
- **Notable:** a **9-strategy cascade** matcher tolerates whitespace/indent
  drift — `SimpleReplacer` → `LineTrimmedReplacer` → `BlockAnchorReplacer` →
  `WhitespaceNormalizedReplacer` → `IndentationFlexibleReplacer` →
  `EscapeNormalizedReplacer` → `TrimmedBoundaryReplacer` →
  `ContextAwareReplacer` → `MultiOccurrenceReplacer`. Rejects a match whose
  span is disproportionately larger than `oldString`. Per-file semaphore lock.
  `oldString === ""` + existing file → error; + missing file → creates it.
  Errors: `Could not find oldString...`, `Found multiple matches...`.
- Line-ending aware (normalizes `\r\n`, converts back before writing).

#### `apply_patch`
- **Input:** `patchText`\* — a stripped diff format:
  ```
  *** Begin Patch
  *** Add File: path        (every following line prefixed +)
  *** Delete File: path
  *** Update File: path      (@@ context, -/+ change lines; optional *** Move to: path)
  *** End Patch
  ```
- **Output:** `"Success. Updated the following files:"` + `A|D|M {relpath}`
  lines + LSP diagnostics per changed file.
  `metadata: { diff, files[]{filePath,type,patch,additions,deletions,movePath}, diagnostics }`.
- **Notable:** **GPT-only** in the registry. One permission prompt for the
  whole patch. Add normalizes trailing newline; move = write-new + remove-old.

#### `glob`
- **Input:** `pattern`\* (string), `path` (string, opt; default = project dir).
- **Output:** newline-joined paths; `"No files found"` if empty; **limit 100**
  with a truncation note. `metadata: { count, truncated }`.

#### `grep`
- **Input:** `pattern`\* (regex), `path` (opt), `include` (opt, e.g.
  `"*.{ts,tsx}"`).
- **Output:** `"Found {n} matches"`; per file a `{abs}:` header then
  `  Line {n}: {text}` (line text capped at 2000 chars). **Limit 100** matches.
  `metadata: { matches, truncated }`. Reports partial/next-page/regex-fallback.

### Execution / control

#### `bash` (internal module name "shell", id kept as `bash`)
- **Input:** `command`\* (string), `timeout` (ms, opt), `workdir` (string, opt
  — use instead of `cd`), `description`\* (string, 5–10 words).
- **Output:** captured stdout/stderr tail-limited; `"(no output)"` if empty;
  `<shell_metadata>` block appended on timeout/abort.
  `metadata: { output, exit, description, truncated, outputPath? }`.
- **Notable:** **description is dynamic per shell** (bash / PowerShell 7 /
  Windows PowerShell 5.1 / cmd) — built by `ShellPrompt.render`. Default
  timeout **120000 ms (2 min)**; metadata preview cap 30000 bytes; streams to a
  file when output is large. Parses the command with tree-sitter to collect
  file/dir args and asks `external_directory` + `bash` permissions. Tells the
  model to use the specialized file tools rather than `cat/grep/find/sed`.

#### `task`
- **Input:** `description`\*, `prompt`\*, `subagent_type`\*, `task_id` (opt —
  resume a prior subagent session), `command` (opt), `background` (opt, only
  exposed when `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`).
- **Output:** `<task id=... state=...><task_result|task_error>{text}</...></task>`.
  `metadata: { parentSessionId, sessionId, model, background?, jobId? }`.
- **Notable:** child has `todowrite` + `task` disabled unless its agent
  permission grants them. The TaskTool description is augmented at runtime with
  the available subagent list (`describeTask`). Background → notified on
  completion; the model is told not to poll.

#### `todowrite`
- **Input:** `todos`\* — array of `{ content, status, priority }` (all plain
  strings; valid values described but not schema-enforced).
- **Output:** pretty-printed JSON of the array. `title: "{n} todos"` (counts
  non-completed). **Overwrites** the session todo list (not a merge).

#### `question`
- **Input:** `questions`\* — array of `{ question, header, custom (default
  true), options[{label,description}], multiple? }`.
- **Output:** `"User has answered your questions: ..."` joining
  `"<q>"="<answers>"`. Returns arrays of selected labels; `custom:true`
  auto-adds a "Type your own answer" option. No permission prompt (it *is* the
  prompt).

#### `lsp` (behind experimental flag)
- **Input:** `operation`\* (one of 9 literals: `goToDefinition`,
  `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`,
  `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`,
  `outgoingCalls`), `filePath`\*, `line`\* (≥1), `character`\* (≥1), `query`
  (opt, for `workspaceSymbol`).
- **Output:** JSON of results or `"No results found for {op}"`. Converts
  1-based input to 0-based internally. Errors if no LSP server for the file
  type.

#### `plan_exit` (CLI + experimental flag)
- **Input:** none (empty object).
- **Output:** `"User approved switching to build agent..."`. Asks Yes/No via
  `question.ask`; "No" → `RejectedError`. `plan.ts` defines only the *exit*
  tool; `plan-enter.txt` exists but its tool is wired elsewhere.

### Web / skill

#### `webfetch`
- **Input:** `url`\* (string), `format` (`text`|`markdown`|`html`, default
  markdown), `timeout` (seconds, max 120).
- **Output:** content converted to the requested format (HTML→markdown via
  Turndown); images → `attachments`. `metadata: {}`.
- **Limits:** max **5 MB**; default timeout 30 s, max 120 s; URL must start
  `http://`|`https://`; one Cloudflare-challenge retry.

#### `websearch`
- **Input:** `query`\*, `numResults` (default 8), `livecrawl`
  (`fallback`|`preferred`), `type` (`auto`|`fast`|`deep`),
  `contextMaxCharacters`.
- **Output:** provider result text. `metadata: { provider }` (`exa` or
  `parallel`, chosen by env / flag / session-hash). 25 s timeout.
  `mcp-websearch.ts` is a helper (JSON-RPC transport), **not** a separate tool.

#### `skill`
- **Input:** `name`\* (must match a skill listed in the system prompt).
- **Output:** `<skill_content name=...>` with the SKILL.md body inlined, plus a
  `<skill_files>` list of up to **10** sibling files as references (not
  inlined). `metadata: { name, dir }`. Uses `always: [name]`.

### Internal

#### `invalid`
- **Input:** `tool`, `error`. **Output:** echoes the error. A sentinel
  substituted when the model emits an unmatchable tool call, so the
  conversation gets clean error prose instead of crashing. Always succeeds.

#### `external-directory.ts` (helper, **not** a tool)
- Exports `assertExternalDirectoryEffect` — the shared gate the file tools call
  before touching a path outside the project; prompts
  `external_directory` permission scoped to that dir's glob.

---

## 4. Patterns worth stealing

1. **Uniform result shape** `{ title, output, metadata, attachments? }` with a
   wrapper that handles decode-errors and truncation once, centrally.
2. **`edit` by exact-string replacement with a fallback matcher cascade** —
   far cheaper than rewriting whole files and robust to whitespace drift.
3. **`read` with line numbers** so edits and diagnostics can reference lines.
4. **Diagnostics folded into tool output** — the model sees compile/lint errors
   immediately after a write, in the same turn.
5. **Per-tool permission gating** with an "always allow" scope.
6. **`.txt` description separate from `.ts` logic** — easy to tune the
   model-facing prose without touching code; descriptions can be dynamic
   (shell, task).
7. **`invalid` sentinel** + typed `InvalidArgumentsError` — every bad call
   produces "rewrite your input" prose rather than a hard failure.
