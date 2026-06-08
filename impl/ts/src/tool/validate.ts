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

// Every file path a tool touches must stay under src/ (or another writable
// project dir). The jail enforces this too, but checking here gives the model a
// clear message instead of an opaque jail rejection.
const WRITABLE_PREFIXES = ["src/", "public/", "out/"];

export function assertProjectPath(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.startsWith("/") || norm.includes("..")) {
    throw new ToolValidationError(`Path "${p}" must be relative to the project root with no "..".`);
  }
  if (!WRITABLE_PREFIXES.some((pre) => norm.startsWith(pre))) {
    throw new ToolValidationError(
      `Path "${p}" must be under one of: ${WRITABLE_PREFIXES.join(", ")}.`,
    );
  }
  return norm;
}
