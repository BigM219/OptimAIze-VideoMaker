// Runtime-editable model fallback config. Users can add models from multiple
// providers (OpenRouter, z.ai, or any OpenAI-compatible base URL) and set the
// priority order. Persisted to a JSON file next to .env so it survives restart;
// falls back to the OPENROUTER_MODEL env list on first run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A single model entry in the ordered fallback chain.
export interface ModelEntry {
  // The model id sent to the provider, e.g. "google/gemma-4-31b-it:free" or
  // "glm-4.6". For the built-in OpenRouter provider, this is the bare id; for
  // other providers it is whatever that provider expects.
  model: string;
  // Provider routing key: "openrouter" (default), "zai", or "custom".
  provider: string;
  // Only for provider === "custom": the OpenAI-compatible base URL + the env
  // var name holding the key (so keys never live in this JSON).
  baseUrl?: string;
  keyEnv?: string;
  // Whether this entry participates in the fallback chain.
  enabled: boolean;
}

function configPath(): string {
  // impl/ts/src/models-config.ts -> impl/ts/models.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "models.json");
}

function envPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", ".env");
}

// Parse the OPENROUTER_MODEL env list into entries (the bootstrap default).
function defaultEntries(): ModelEntry[] {
  let raw = process.env.OPENROUTER_MODEL ?? "";
  if (!raw) {
    try {
      const text = fs.readFileSync(envPath(), "utf-8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith("OPENROUTER_MODEL=")) {
          raw = t.slice("OPENROUTER_MODEL=".length).trim();
          break;
        }
      }
    } catch {
      /* no .env is fine */
    }
  }
  if (!raw) raw = "openrouter/owl-alpha";
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => entryFromToken(m));
}

// Turn a chain token like "zai:glm-5.1" into a structured entry.
export function entryFromToken(token: string): ModelEntry {
  if (token.startsWith("zai:")) {
    return { model: token.slice(4), provider: "zai", enabled: true };
  }
  return { model: token, provider: "openrouter", enabled: true };
}

// Turn an entry back into a chain token the LLM client understands.
export function tokenFromEntry(e: ModelEntry): string {
  if (e.provider === "zai") return `zai:${e.model}`;
  // Custom OpenAI-compatible host: encode keyEnv + baseUrl + model so the LLM
  // client can route there. Format must match the client's resolve() parser.
  if (e.provider === "custom") return `custom:${e.keyEnv ?? ""}|${e.baseUrl ?? ""}|${e.model}`;
  return e.model;
}

let cache: ModelEntry[] | null = null;

export function getModels(): ModelEntry[] {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as ModelEntry[];
    if (Array.isArray(data) && data.length > 0) {
      cache = data;
      return cache;
    }
  } catch {
    /* no config yet -> bootstrap from env */
  }
  cache = defaultEntries();
  return cache;
}

export function setModels(entries: ModelEntry[]): ModelEntry[] {
  cache = entries.filter((e) => e.model && e.model.trim());
  fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), "utf-8");
  return cache;
}

// The ordered list of enabled chain tokens, for the LLM client.
export function enabledChain(): string[] {
  return getModels()
    .filter((e) => e.enabled)
    .map(tokenFromEntry);
}
