import type { PalaceSearchResult } from "./types.ts";

export interface PalaceClientOptions {
  baseUrl: string;
  apiKey: string;
  searchTimeoutMs: number;
  fetch?: typeof fetch;
}

export interface SearchOpts {
  query: string;
  limit: number;
  wing?: string;
  room?: string;
  maxDistance?: number;
}

export interface WriteMemoryOpts {
  content: string;
  wing: string;
  room: string;
  metadata?: Record<string, unknown>;
}

export class PalaceClient {
  private baseUrl: string;
  private apiKey: string;
  private searchTimeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(opts: PalaceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.searchTimeoutMs = opts.searchTimeoutMs;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async search(opts: SearchOpts): Promise<PalaceSearchResult> {
    const params = new URLSearchParams({ q: opts.query, limit: String(opts.limit) });
    if (opts.wing) params.set("wing", opts.wing);
    if (opts.room) params.set("room", opts.room);
    if (opts.maxDistance !== undefined) params.set("max_distance", String(opts.maxDistance));
    const url = `${this.baseUrl}/search?${params.toString()}`;

    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error(`palace-daemon search: timeout after ${this.searchTimeoutMs}ms`));
      }, this.searchTimeoutMs);
    });
    try {
      const res = await Promise.race([
        this.fetchFn(url, { method: "GET", headers: this.headers(), signal: ctl.signal }),
        timeoutPromise,
      ]);
      if (!res.ok) throw new Error(`palace-daemon search: ${res.status} ${res.statusText}`);
      return (await res.json()) as PalaceSearchResult;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async writeMemory(opts: WriteMemoryOpts): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/memory`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`palace-daemon memory write: ${res.status} ${res.statusText}`);
  }

  async health(): Promise<{ status: string; [k: string]: unknown }> {
    const res = await this.fetchFn(`${this.baseUrl}/health`, { headers: this.headers() });
    if (!res.ok) throw new Error(`palace-daemon health: ${res.status}`);
    return (await res.json()) as { status: string };
  }
}
