// runAgent — the agentic tool loop. See docs/harness-design.md §9.
// The LLM only returns text, so each turn we: send the conversation, parse a
// ```tool_calls``` block (protocol.ts), execute the calls through the registry,
// append incremental diagnostics, and feed a ```tool_results``` block back as
// the next user message — repeating until the model signals done, stalls, or we
// hit the turn ceiling. This replaces the "rewrite the whole file every turn"
// shape of the old chatEdit/repair loops.

import type { OpenRouterClient } from "../agent/llm-client.js";
import type { ProjectStore, ProjectStep } from "../projects.js";
import type { ProcessBackend } from "../sandbox/process-backend.js";
import { ToolRegistry } from "./registry.js";
import { parseToolCalls, renderToolResults } from "./protocol.js";
import type { ToolContext } from "./types.js";

export const MAX_TOOL_TURNS = 12;
const MAX_IDLE = 2; // consecutive turns with no tool calls before we stop

interface Message {
  role: string;
  content: string;
}

export interface RunAgentResult {
  summary: string;
  turns: number;
  // Why the loop ended: the model said done, it stalled, or it ran out of turns.
  stop: "done" | "idle" | "max_turns";
  // Every file the loop mutated (write/edit/update_storyboard), de-duplicated.
  edited: string[];
}

export interface RunAgentOptions {
  store: ProjectStore;
  projectId: string;
  backend: ProcessBackend;
  sandboxId: string;
  client: OpenRouterClient;
  systemPrompt: string; // task framing; tool docs + protocol are appended here
  userGoal: string;
  registry?: ToolRegistry;
  signal?: AbortSignal;
  maxTurns?: number;
  // Append a transcript step (defaults to a no-op for headless callers).
  log?: (phase: string, detail: string, extra?: Partial<ProjectStep>) => void;
  // Keep the conversation bounded: system + the last N exchanges. Each
  // tool_results message already carries fresh state, so old turns are stale.
  historyWindow?: number;
}

// The protocol contract appended to every system prompt so the model knows how
// to emit tool calls and when to stop.
function protocolDoc(registry: ToolRegistry): string {
  return [
    "You work by calling tools. Each turn, reply with EXACTLY ONE fenced code block tagged tool_calls whose body is a JSON object.",
    "",
    "To act, list one or more calls (they run in parallel):",
    '```tool_calls',
    '{ "calls": [ { "tool": "read", "args": { "filePath": "src/Root.tsx" } } ] }',
    "```",
    "",
    "When the goal is fully done, finish with:",
    '```tool_calls',
    '{ "done": true, "summary": "what you accomplished" }',
    "```",
    "",
    "Rules: emit only the tool_calls block (a short reasoning line before it is fine). " +
      "Read a file before editing it. Prefer `edit` over `write` for small changes. " +
      "After editing a scene, use `render_scene` to verify it renders. " +
      "Results come back in a tool_results block; read them before the next step.",
    "",
    "Available tools:",
    registry.renderDocs(),
  ].join("\n");
}

function trimHistory(messages: Message[], window: number): Message[] {
  // Always keep the system message (index 0) + the last `window` messages.
  if (messages.length <= window + 1) return messages;
  return [messages[0], ...messages.slice(messages.length - window)];
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const {
    store,
    projectId,
    backend,
    sandboxId,
    client,
    systemPrompt,
    userGoal,
    signal,
  } = opts;
  const registry = opts.registry ?? new ToolRegistry();
  const maxTurns = opts.maxTurns ?? MAX_TOOL_TURNS;
  const historyWindow = opts.historyWindow ?? 8;
  const log = opts.log ?? (() => {});

  const ctx: ToolContext = { projectId, store, backend, sandboxId, signal, log };

  let messages: Message[] = [
    { role: "system", content: `${systemPrompt}\n\n${protocolDoc(registry)}` },
    { role: "user", content: userGoal },
  ];

  const editedAll = new Set<string>();
  let idleStreak = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { summary: "(aborted)", turns: turn - 1, stop: "idle", edited: [...editedAll] };

    const resp = await client.chat(messages, { maxTokens: 4000, temperature: 0.3 });
    messages.push({ role: "assistant", content: resp });

    const parsed = parseToolCalls(resp);

    if (parsed.done) {
      log("done", parsed.summary || "Agent finished.", { kind: "info" });
      return { summary: parsed.summary ?? "", turns: turn, stop: "done", edited: [...editedAll] };
    }

    // No usable tool block: either a parse error (feed it back) or genuine idle.
    if (parsed.calls.length === 0) {
      idleStreak += 1;
      if (idleStreak >= MAX_IDLE) {
        return { summary: "(stopped: no progress)", turns: turn, stop: "idle", edited: [...editedAll] };
      }
      const nudge =
        parsed.parseError ??
        'No tool_calls block found. Emit one ```tool_calls``` block with {"calls":[...]} or {"done":true,"summary":"..."}.';
      messages.push({ role: "user", content: nudge });
      continue;
    }
    idleStreak = 0;

    // Execute all calls this turn (parallel — none depend on each other within a
    // turn; the model sequences dependent steps across turns).
    const results = await Promise.all(parsed.calls.map((c) => registry.execute(c, ctx)));

    // One diagnostics pass for the turn, spliced into the mutating results.
    await registry.appendDiagnostics(results, ctx);

    for (const r of results) {
      const fp = r.metadata?.filePath;
      if (r.ok && registry.isMutating(r.tool) && typeof fp === "string") editedAll.add(fp);
    }

    messages.push({ role: "user", content: renderToolResults(results) });
    messages = trimHistory(messages, historyWindow);
  }

  return { summary: "(stopped: max turns)", turns: maxTurns, stop: "max_turns", edited: [...editedAll] };
}
