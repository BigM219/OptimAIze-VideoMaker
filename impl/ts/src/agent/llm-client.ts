// OpenRouter chat-completions client (built-in fetch) with an ordered model
// fallback list. Mirrors the Go impl: OPENROUTER_MODEL may be a comma-separated
// list; the client tries each model in turn until one returns a usable
// completion, skipping 429s and empty bodies. env/.env config, 429/5xx backoff.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RETRY_CODES = new Set([429, 500, 502, 503, 529]);

// Session circuit breaker: a model that fails MAX_MODEL_FAILURES times in this
// process is "tripped" and skipped for the rest of the session, so we never burn
// time retrying a model that is reliably down/rate-limited (e.g. a :free model
// that always 429s). A success resets its counter. State is module-level because
// each request constructs a fresh OpenRouterClient.
const MAX_MODEL_FAILURES = 2;
const modelFailures = new Map<string, number>();

function isTripped(model: string): boolean {
  return (modelFailures.get(model) ?? 0) >= MAX_MODEL_FAILURES;
}
function recordFailure(model: string): void {
  modelFailures.set(model, (modelFailures.get(model) ?? 0) + 1);
}
function recordSuccess(model: string): void {
  modelFailures.delete(model);
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
  // Ordered fallback list; the first is the primary model.
  readonly models: string[];

  constructor(opts: { models?: string[] } = {}) {
    const dotenv = loadDotenv();
    const pick = (name: string, fallback = ""): string =>
      process.env[name] ?? dotenv[name] ?? fallback;
    this.apiKey = pick("OPENROUTER_API_KEY");
    this.baseUrl = pick("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    const raw = pick("OPENROUTER_MODEL", "openai/gpt-4o-mini");
    this.models = opts.models ?? raw.split(",").map((m) => m.trim()).filter(Boolean);
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
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
    });
    let lastErr = "";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
      try {
        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://optimaize.local/videomaker",
            "X-Title": "OptimAIze-VideoMaker",
          },
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
