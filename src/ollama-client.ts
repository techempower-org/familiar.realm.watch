/**
 * HTTP client for OpenAI-compatible inference servers.
 *
 * Despite the legacy name, this client speaks the OpenAI `/v1/*` API surface
 * — chat completions, embeddings, model listing. That works against both
 * stock Ollama (which mounts the OpenAI shim on the same port as its
 * native `/api/*`) AND llama.cpp's `llama-server`. The latter is the
 * production backend after the Pascal-SASS regression in stock Ollama
 * binaries on 2026-05-15; the OpenAI surface is the lingua franca that
 * lets both backends slot in without router-side branching.
 *
 * The class name is preserved for callsite stability; the class is
 * functionally equivalent to LlamaCppClient now and the two could be
 * consolidated in a follow-up.
 *
 * Stream translation: chat responses arrive as Server-Sent Events of
 *   data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   ...
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
 *   data: [DONE]
 * and we emit OllamaChatChunk-shaped objects so the existing chat route
 * and InferenceRouter don't need to change.
 */

import type { ChatMessage, OllamaChatChunk } from "./types.ts";

export interface OllamaClientOptions {
  baseUrl: string;
  defaultModel: string;
  fetch?: typeof fetch;
}

export interface ChatStreamOpts {
  model?: string;
  messages: ChatMessage[];
  options?: Record<string, unknown>;
}

export interface EmbedOpts {
  model?: string;
  text: string;
}

export class OllamaClient {
  private baseUrl: string;
  private defaultModel: string;
  private fetchFn: typeof fetch;

  constructor(opts: OllamaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.defaultModel = opts.defaultModel;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async *chatStream(opts: ChatStreamOpts): AsyncGenerator<OllamaChatChunk> {
    const model = opts.model ?? this.defaultModel;
    // OpenAI body shape — `options` (Ollama-native sampling overrides) is
    // spread at the top level so callers can still pass `temperature`,
    // `top_p`, `top_k`, etc. via the same key.
    const body = {
      model,
      messages: opts.messages,
      stream: true,
      ...(opts.options ?? {}),
    };
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chat: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error("chat: no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield { model, created_at: new Date().toISOString(), done: true };
          return;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          const isDone = parsed.choices?.[0]?.finish_reason === "stop";
          yield {
            model,
            created_at: new Date().toISOString(),
            message: delta ? { role: "assistant", content: delta } : undefined,
            done: isDone,
          };
        } catch {
          // skip malformed SSE lines; some servers occasionally emit
          // partial chunks straddling buffer boundaries that re-form on
          // the next read.
        }
      }
    }
    // Some servers omit the explicit "data: [DONE]" terminator; emit a
    // synthetic done chunk so consumers see a clean stream end.
    yield { model, created_at: new Date().toISOString(), done: true };
  }

  async embed(opts: EmbedOpts): Promise<number[]> {
    const body = {
      model: opts.model ?? this.defaultModel,
      input: opts.text,
    };
    const res = await this.fetchFn(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`embed: ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const vec = data.data?.[0]?.embedding;
    if (!vec) throw new Error("embed: no embedding in response");
    return vec;
  }

  /**
   * Probe the backend with `GET /v1/models`. Lightweight, present on
   * both Ollama (OpenAI shim) and llama-server. Falls back to false
   * on any transport error.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/models`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Non-streaming completion used for HyDE pre-search query expansion
   * (the "write a hypothetical answer to bridge query/drawer vocabulary"
   * trick). Short prompt, short response. Returns "" on any failure
   * so callers can use it as a non-fatal pre-step. Timeout is hard-
   * capped at 5s by default to keep retrieval p99 under control.
   */
  async generateShort(prompt: string, opts?: { model?: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const body = {
      model: opts?.model ?? this.defaultModel,
      // Single-turn shape so the OpenAI server treats it as a one-shot
      // completion rather than expecting message history.
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: opts?.maxTokens ?? 200,
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) return "";
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return (data.choices?.[0]?.message?.content ?? "").trim();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}
