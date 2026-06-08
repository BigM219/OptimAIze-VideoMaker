// Harness tool contract — see docs/harness-design.md §4.
// The LLM client only returns text (no native function-calling), so tools are
// invoked via a JSON-block protocol (protocol.ts) and dispatched through a
// lightweight registry (registry.ts). Each tool is a plain object — no Effect,
// unlike opencode — that wraps the already-jailed `store` file ops and the
// already-caged `backend.exec`.

import type { ProjectStore, ProjectStep } from "../projects.js";
import type { ProcessBackend } from "../sandbox/process-backend.js";

// What every tool's execute() receives. Mirrors opencode's Tool.Context but
// carries our concrete store/backend instead of an Effect service graph.
export interface ToolContext {
  projectId: string;
  store: ProjectStore;
  backend: ProcessBackend;
  sandboxId: string;
  signal?: AbortSignal;
  // Append a step to the project transcript (same shape the director uses).
  log: (phase: string, detail: string, extra?: Partial<ProjectStep>) => void;
}

// What every tool's execute() returns. `output` is the text fed back to the
// LLM; the wrapper truncates it and fills truncated/outputPath.
export interface ToolResult {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  outputPath?: string;
}

// A minimal JSON-schema-ish descriptor used both to validate args and to render
// the tool docs injected into the system prompt. Kept deliberately small.
export interface ToolParamSpec {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required?: boolean;
  // For array params: a hint about element shape (rendered in docs only).
  items?: string;
}

export interface ToolDef<A = Record<string, unknown>> {
  id: string;
  description: string;
  parameters: Record<string, ToolParamSpec>;
  // Throw a ToolValidationError (message shown to the model) on bad args.
  validate(args: Record<string, unknown>): A;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

// Thrown by validate() when args don't satisfy the schema. The registry turns
// this into an ok:false result with a model-facing "rewrite the input" message
// rather than crashing the loop (see opencode InvalidArgumentsError).
export class ToolValidationError extends Error {}

// One parsed tool invocation from a ```tool_calls``` block.
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

// Result of executing one ToolCall, ready to render back to the model.
export interface ToolCallResult {
  tool: string;
  ok: boolean;
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  outputPath?: string;
}
