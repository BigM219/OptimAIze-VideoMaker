// Tiny .env reader shared by the network tools (webfetch/websearch), mirroring
// the loader in agent/llm-client.ts so provider keys are picked up the same way:
// process.env first, then impl/ts/.env. No dependency on dotenv.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cache: Record<string, string> | null = null;

function loadDotenv(): Record<string, string> {
  if (cache) return cache;
  // impl/ts/src/tool/env.ts -> impl/ts/.env
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, "..", "..", ".env");
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(envPath, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* no .env is fine */
  }
  cache = out;
  return out;
}

// Read a config value: process.env wins, then .env, then fallback.
export function readEnv(name: string, fallback = ""): string {
  const fromProc = process.env[name];
  if (fromProc !== undefined && fromProc !== "") return fromProc;
  const dot = loadDotenv()[name];
  return dot !== undefined && dot !== "" ? dot : fallback;
}
