// Shared helpers for tool arg validation and output shaping.
// validate() functions throw ToolValidationError with a model-facing message.

import { ToolValidationError } from "./types.js";

export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") {
    throw new ToolValidationError(`"${key}" is required and must be a non-empty string.`);
  }
  return v;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolValidationError(`"${key}" must be a string.`);
  return v;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Be tolerant: models often send numbers as strings inside JSON.
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new ToolValidationError(`"${key}" must be a number.`);
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ToolValidationError(`"${key}" must be a boolean.`);
}

// Writes are restricted to the project's writable subtrees, so the model can't
// clobber config/lockfiles. The jail enforces this too, but checking here gives
// the model a clear message instead of an opaque jail rejection.
const WRITABLE_PREFIXES = ["src/", "public/", "out/"];

// Normalize a relative path and reject escapes (absolute or "..") shared by both
// the read and write checks.
function normalizeRel(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.startsWith("/") || norm.includes("..")) {
    throw new ToolValidationError(`Path "${p}" must be relative to the project root with no "..".`);
  }
  return norm;
}

// For write/edit: must land in a writable subtree.
export function assertProjectPath(p: string): string {
  const norm = normalizeRel(p);
  if (!WRITABLE_PREFIXES.some((pre) => norm.startsWith(pre))) {
    throw new ToolValidationError(
      `Path "${p}" must be under one of: ${WRITABLE_PREFIXES.join(", ")}.`,
    );
  }
  return norm;
}

// For read/list: any path inside the project is fair game (package.json,
// tsconfig.json, etc.) so the agent can understand the project — it just can't
// escape the root. The jail still bounds it to the sandbox workdir.
export function assertReadablePath(p: string): string {
  return normalizeRel(p);
}
