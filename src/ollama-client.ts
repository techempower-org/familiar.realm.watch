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
    const body = {
      model: opts.model ?? this.defaultModel,
      messages: opts.messages,
      stream: true,
      options: opts.options,
    };
    const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ollama chat: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error("ollama chat: no response body");

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
        if (!line) continue;
        try {
          yield JSON.parse(line) as OllamaChatChunk;
        } catch {
          // skip malformed lines; Ollama sometimes chunks mid-utf8
        }
      }
    }
    if (buffer.trim()) {
      try { yield JSON.parse(buffer.trim()) as OllamaChatChunk; } catch { /* ignore tail */ }
    }
  }

  async embed(opts: EmbedOpts): Promise<number[]> {
    const body = { model: opts.model ?? this.defaultModel, prompt: opts.text };
    const res = await this.fetchFn(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ollama embed: ${res.status}`);
    const data = (await res.json()) as { embedding: number[] };
    return data.embedding;
  }

  /** GET /api/tags is the cheapest non-mutating Ollama endpoint. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Non-streaming /api/generate — used for HyDE pre-search query
   * expansion. Short prompt, short response, no streaming overhead.
   * Returns "" on any failure so callers can use it as a non-fatal
   * pre-step. Timeout is hard-capped at 5s to keep retrieval p99
   * under control.
   */
  async generateShort(prompt: string, opts?: { model?: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const body = {
      model: opts?.model ?? this.defaultModel,
      prompt,
      stream: false,
      options: { num_predict: opts?.maxTokens ?? 200 },
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) return "";
      const data = (await res.json()) as { response?: string };
      return (data.response ?? "").trim();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}
