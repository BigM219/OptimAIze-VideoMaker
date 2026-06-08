// OpenRouter chat-completions client (built-in fetch) with an ordered model
// fallback list. Mirrors the Go impl: OPENROUTER_MODEL may be a comma-separated
// list; the client tries each model in turn until one returns a usable
// completion, skipping 429s and empty bodies. env/.env config, 429/5xx backoff.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enabledChain } from "../models-config.js";

const RETRY_CODES = new Set([429, 500, 502, 503, 529]);

// Session circuit breaker with a TIME-BASED cooldown. A model that fails
// MAX_MODEL_FAILURES times is "tripped" and skipped — but only for COOLDOWN_MS,
// after which it is given another chance. This avoids the trap where a brief
// all-provider hiccup permanently disables every model for the rest of the
// session (which left the later repair phase with nothing to call). A success
// clears the counter. State is module-level because each request constructs a
// fresh OpenRouterClient.
const MAX_MODEL_FAILURES = 2;
const COOLDOWN_MS = 60_000;
const modelFailures = new Map<string, number>();
const trippedUntil = new Map<string, number>();

function isTripped(model: string): boolean {
  const until = trippedUntil.get(model);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    // Cooldown elapsed: give the model another chance.
    trippedUntil.delete(model);
    modelFailures.delete(model);
    return false;
  }
  return true;
}
function recordFailure(model: string): void {
  const n = (modelFailures.get(model) ?? 0) + 1;
  modelFailures.set(model, n);
  if (n >= MAX_MODEL_FAILURES) trippedUntil.set(model, Date.now() + COOLDOWN_MS);
}
function recordSuccess(model: string): void {
  modelFailures.delete(model);
  trippedUntil.delete(model);
}

export function llmBreakerState(): Record<string, number> {
  return Object.fromEntries(modelFailures);
}

export class LLMConfigError extends Error {}
export class LLMUnavailable extends Error {}

function loadDotenv(): Record<string, string> {
  // impl/ts/src/agent/llm-client.ts -> impl/ts/.env
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
  return out;
}

interface ChatMessage {
  role: string;
  content: string;
}

export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  // z.ai is a separate OpenAI-compatible provider; a model entry prefixed
  // "zai:" routes there (own base URL + key) instead of OpenRouter.
  private zaiKey: string;
  private zaiBaseUrl: string;
  // Ordered fallback list; the first is the primary model.
  readonly models: string[];

  private dotenv: Record<string, string>;

  constructor(opts: { models?: string[] } = {}) {
    const dotenv = loadDotenv();
    this.dotenv = dotenv;
    const pick = (name: string, fallback = ""): string =>
      process.env[name] ?? dotenv[name] ?? fallback;
    this.apiKey = pick("OPENROUTER_API_KEY");
    this.baseUrl = pick("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.zaiKey = pick("ZAI_API_KEY");
    this.zaiBaseUrl = pick("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4").replace(/\/+$/, "");
    // Models come from the runtime-editable config (enabledChain), which falls
    // back to the OPENROUTER_MODEL env list on first run.
    this.models = opts.models ?? enabledChain();
    if (this.models.length === 0) this.models = ["openrouter/owl-alpha"];
  }

  // Resolve which provider a model entry targets. "zai:..." -> z.ai;
  // "custom:<keyEnv>|<baseUrl>|<model>" -> an arbitrary OpenAI-compatible host.
  private resolve(model: string): { url: string; key: string; model: string; openrouter: boolean } {
    if (model.startsWith("zai:")) {
      return { url: this.zaiBaseUrl, key: this.zaiKey, model: model.slice(4), openrouter: false };
    }
    if (model.startsWith("custom:")) {
      // Format: custom:<KEY_ENV>|<BASE_URL>|<MODEL_ID>
      const [keyEnv, baseUrl, ...rest] = model.slice(7).split("|");
      const key = process.env[keyEnv] ?? this.dotenv[keyEnv] ?? "";
      return { url: (baseUrl ?? "").replace(/\/+$/, ""), key, model: rest.join("|"), openrouter: false };
    }
    return { url: this.baseUrl, key: this.apiKey, model, openrouter: true };
  }

  get model(): string {
    return this.models[0] ?? "";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey) && this.apiKey !== "REPLACE_WITH_YOUR_OPENROUTER_KEY";
  }

  async chat(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number; timeoutS?: number } = {},
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new LLMConfigError("No OPENROUTER_API_KEY configured (set it in impl/ts/.env).");
    }
    if (this.models.length === 0) throw new LLMConfigError("No OPENROUTER_MODEL configured.");
    let lastErr = "";
    let triedAny = false;
    for (const model of this.models) {
      if (isTripped(model)) {
        console.warn(`LLM model ${model} skipped (tripped after ${MAX_MODEL_FAILURES} failures this session).`);
        continue;
      }
      triedAny = true;
      try {
        const out = await this.chatModel(model, messages, opts);
        recordSuccess(model);
        return out;
      } catch (e) {
        recordFailure(model);
        lastErr = `[${model}] ${String((e as Error).message ?? e)}`;
        console.warn(`LLM model ${model} failed, falling back: ${lastErr}`);
      }
    }
    if (!triedAny) {
      // Every model is tripped; clear the breaker and try the primary once more
      // so a transient outage doesn't permanently disable the session.
      modelFailures.clear();
      throw new LLMUnavailable(`all models are tripped this session; breaker reset. last: ${lastErr || "n/a"}`);
    }
    throw new LLMUnavailable(`all ${this.models.length} models failed; last: ${lastErr}`);
  }

  // Retry loop for a single model.
  private async chatModel(
    model: string,
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number; timeoutS?: number },
  ): Promise<string> {
    const timeoutS = opts.timeoutS ?? 60;
    // One attempt per model: the fallback list itself is the redundancy, so we
    // never burn time re-hitting a model that just failed. The session breaker
    // then skips it entirely after MAX_MODEL_FAILURES.
    const maxRetries = 1;
    const target = this.resolve(model);
    const body = JSON.stringify({
      model: target.model,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
    });
    if (!target.key) throw new Error(`no API key configured for ${target.openrouter ? "OpenRouter" : "z.ai"}`);
    let lastErr = "";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${target.key}`,
          "Content-Type": "application/json",
        };
        if (target.openrouter) {
          headers["HTTP-Referer"] = "https://optimaize.local/videomaker";
          headers["X-Title"] = "OptimAIze-VideoMaker";
        }
        const resp = await fetch(`${target.url}/chat/completions`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          const detail = (await resp.text()).slice(0, 200);
          lastErr = `HTTP ${resp.status}: ${detail}`;
          if (RETRY_CODES.has(resp.status)) {
            await sleep(Math.min(2 ** attempt * 2, 20));
            continue;
          }
          throw new Error(lastErr);
        }
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw new Error(`invalid/empty response body: ${JSON.stringify(data).slice(0, 300)}`);
        }
        return content;
      } catch (e) {
        clearTimeout(timer);
        lastErr = String((e as Error).message ?? e);
        await sleep(Math.min(2 ** attempt * 2, 20));
      }
    }
    throw new Error(`unreachable after ${maxRetries} attempts: ${lastErr}`);
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}
