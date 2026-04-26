/**
 * HTTP client for llama.cpp's OpenAI-compatible server (`llama-server`).
 *
 * Emits OllamaChatChunk-shaped objects so it's a drop-in alternative to
 * OllamaClient inside InferenceRouter — the chat route doesn't need to
 * know which protocol delivered the bytes.
 *
 * Upstream protocol: SSE chunks of the form
 *   data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   ...
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
 *   data: [DONE]
 *
 * We translate to OllamaChatChunk on the fly: `delta.content` becomes
 * `message.content`, `finish_reason==="stop"` becomes `done: true`.
 */

import type { ChatStreamOpts } from "./ollama-client.ts";
import type { InferenceChatProvider, OllamaChatChunk } from "./types.ts";

export interface LlamaCppClientOptions {
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}

export class LlamaCppClient implements InferenceChatProvider {
  private baseUrl: string;
  private model: string;
  private fetchFn: typeof fetch;

  constructor(opts: LlamaCppClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async *chatStream(opts: ChatStreamOpts): AsyncGenerator<OllamaChatChunk> {
    const body = {
      model: opts.model ?? this.model,
      messages: opts.messages,
      stream: true,
      ...(opts.options ?? {}),
    };
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`llama-cpp chat: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error("llama-cpp chat: no response body");

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
          yield { model: this.model, created_at: new Date().toISOString(), done: true };
          return;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          const isDone = parsed.choices?.[0]?.finish_reason === "stop";
          yield {
            model: this.model,
            created_at: new Date().toISOString(),
            message: delta ? { role: "assistant", content: delta } : undefined,
            done: isDone,
          };
        } catch {
          // skip malformed SSE lines
        }
      }
    }
    yield { model: this.model, created_at: new Date().toISOString(), done: true };
  }
}
