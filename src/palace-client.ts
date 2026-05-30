import type { PalaceDrawer, PalaceGraph, PalaceSearchResult } from "./types.ts";

function normalizeResults(raw: PalaceSearchResult): PalaceSearchResult {
  return {
    ...raw,
    results: (raw.results ?? []).map((d: PalaceDrawer & { drawer_id?: string }) => ({
      ...d,
      id: d.drawer_id ?? d.id,
    })),
  };
}

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

export interface HybridSearchOpts {
  query: string;
  limit: number;
  wing?: string;
  room?: string;
  /** Attach per-source trace (matched_via counts) to the response. */
  includeTrace?: boolean;
  /**
   * HyDE (Hypothetical Document Embeddings) — if a generator is provided,
   * call it with the query, get a hypothetical answer, embed THAT instead
   * of (or in addition to) the literal query. Closes paraphrase vocabulary
   * gaps where the query and target drawer share zero literal vocabulary.
   * Best paired with a small fast model (gemma3:4b ~2s on 4GB VRAM).
   * When provided, returns the original query merged with the hypothesis
   * for the actual search; this consistently outperforms pure HyDE because
   * the original query still anchors entity-specific tokens.
   */
  hydeGenerate?: (query: string) => Promise<string>;
}

export interface AgeFusedSearchOpts {
  query: string;
  limit: number;
  wing?: string;
  room?: string;
  /** Attach per-source trace (matched_via counts) to the response. */
  includeTrace?: boolean;
  /**
   * How many AGE-graph-walk candidates to fold into the RRF fusion
   * (daemon default 50). Higher = more graph reach, slightly slower.
   */
  graphTopK?: number;
  /** RRF constant for the vector⊕graph fusion (daemon default 60). */
  fusionK?: number;
  /**
   * Override the daemon's rerank decision for this call. Leave undefined
   * to honor the daemon's env-configured default (ENABLE_RERANK).
   */
  rerank?: boolean;
  /**
   * HyDE generator — same contract as {@link HybridSearchOpts.hydeGenerate}.
   * Applied client-side as a query concat before the request, since
   * /search/age-fused has no server-side HyDE step.
   */
  hydeGenerate?: (query: string) => Promise<string>;
}

export interface WriteMemoryOpts {
  content: string;
  wing: string;
  room: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of a write-path call. palace-daemon (mempalace#86) returns
 * `warnings` + `errors` on /memory and /silent-save so callers can surface
 * non-fatal issues (e.g. HNSW lazy-index race detected, embedder
 * fallback used, queued-for-rebuild) without checking server logs.
 *
 * Forward-compatible: an older daemon that doesn't ship these fields
 * yields empty arrays via the `?? []` defaults at parse time.
 */
export interface WriteMemoryResult {
  /** Daemon-assigned drawer id; "" if the daemon didn't return one. */
  id: string;
  /** Non-fatal warnings emitted during the write. */
  warnings: string[];
  /** Non-fatal errors recorded but not raised (e.g. async pipeline failures). */
  errors: string[];
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
    // Strip trailing punctuation before embedding. nomic-embed-text v1.5
    // produces meaningfully different embeddings for "What is X" vs "What
    // is X?" — a single trailing "?" was observed dropping a known-good
    // hit from sim=0.562 (#1) out of top-5 entirely on the live palace.
    // Normalize at the client layer so every consumer benefits.
    const normalizedQ = opts.query.replace(/[?!.,;:]+\s*$/, "").trim();
    const params = new URLSearchParams({ q: normalizedQ, limit: String(opts.limit) });
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
      return normalizeResults((await res.json()) as PalaceSearchResult);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Apply the client-side HyDE concat. Generates a hypothetical answer
   * with a small LLM and concatenates it with the (punctuation-normalized)
   * query. The hypothesis bridges vocabulary gaps for paraphrase queries;
   * the original query keeps entity-specific tokens anchored. Failure is
   * non-fatal — on error/timeout the literal query stands.
   */
  private async applyHyde(query: string, hydeGenerate?: (q: string) => Promise<string>): Promise<string> {
    let effectiveQuery = query.replace(/[?!.,;:]+\s*$/, "").trim();
    if (hydeGenerate) {
      try {
        const hypothesis = await hydeGenerate(effectiveQuery);
        if (hypothesis && hypothesis.trim()) {
          effectiveQuery = `${effectiveQuery}\n\n${hypothesis.trim().slice(0, 500)}`;
        }
      } catch {
        // HyDE failure should not block search; original query stands.
      }
    }
    return effectiveQuery;
  }

  /**
   * POST a search body to one of the daemon's POST search endpoints,
   * bounded by `searchTimeoutMs` and aborted on timeout. `label` is used
   * only in error messages. Returns the normalized result set.
   */
  private async postSearch(path: string, label: string, body: Record<string, unknown>): Promise<PalaceSearchResult> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error(`palace-daemon ${label}: timeout after ${this.searchTimeoutMs}ms`));
      }, this.searchTimeoutMs);
    });
    try {
      const res = await Promise.race([
        this.fetchFn(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: ctl.signal,
        }),
        timeoutPromise,
      ]);
      if (!res.ok) throw new Error(`palace-daemon ${label}: ${res.status} ${res.statusText}`);
      return normalizeResults((await res.json()) as PalaceSearchResult);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Hybrid search: fuses vector + BM25 + graph retrieval in a single
   * ranked result set. Calls palace-daemon's /search/hybrid endpoint
   * which routes through mempalace's `candidate_strategy="hybrid"`
   * path.
   *
   * Use over `search()` when retrieval quality matters more than raw
   * latency — hybrid surfaces BM25-strong / graph-anchored drawers
   * that vector alone misses. Requires postgres backend (daemon
   * returns 503 on chroma; familiar should fall back to `search()`
   * in that case).
   */
  async searchHybrid(opts: HybridSearchOpts): Promise<PalaceSearchResult> {
    const effectiveQuery = await this.applyHyde(opts.query, opts.hydeGenerate);

    const body: Record<string, unknown> = {
      query: effectiveQuery,
      limit: opts.limit,
    };
    if (opts.wing) body.wing = opts.wing;
    if (opts.room) body.room = opts.room;
    if (opts.includeTrace) body.include_trace = true;

    return this.postSearch("/search/hybrid", "hybrid search", body);
  }

  /**
   * AGE-fused search: fuses vector retrieval with an Apache-AGE
   * knowledge-graph walk via reciprocal-rank fusion. Calls palace-daemon's
   * POST /search/age-fused (palace-daemon#25). This is the ONLY search
   * path that lets the populated KG (~1.9M triples on familiar) influence
   * what's retrieved — `/search` and `/search/hybrid` never walk AGE.
   *
   * Measured ~+8.3pp R@5 over vector-only on the candidate-strategy
   * ablation. Requires postgres + a populated AGE graph; an older daemon
   * (no endpoint) returns 404 and callers should fall back to `search()`.
   *
   * The response envelope is leaner than hybrid's — no top-level
   * `available_in_scope` / `warnings` — so those normalize to undefined/[]
   * downstream, which is benign for the grounding layer.
   */
  async searchAgeFused(opts: AgeFusedSearchOpts): Promise<PalaceSearchResult> {
    const effectiveQuery = await this.applyHyde(opts.query, opts.hydeGenerate);

    const body: Record<string, unknown> = {
      query: effectiveQuery,
      limit: opts.limit,
    };
    if (opts.wing) body.wing = opts.wing;
    if (opts.room) body.room = opts.room;
    if (opts.graphTopK !== undefined) body.graph_top_k = opts.graphTopK;
    if (opts.fusionK !== undefined) body.fusion_k = opts.fusionK;
    if (opts.includeTrace) body.include_trace = true;
    if (opts.rerank !== undefined) body.rerank = opts.rerank;

    return this.postSearch("/search/age-fused", "age-fused search", body);
  }

  /**
   * List drawers by metadata (wing/room) — no search query.
   * palace-daemon ≥1.7.x exposes this; older daemons return 404 and
   * callers should fall back to /search with post-filtering.
   *
   * Normalizes the daemon's `{drawers: [{drawer_id, content_preview, ...}]}`
   * shape to PalaceSearchResult so consumers can treat search and list
   * results uniformly.
   */
  async listDrawers(opts: { wing?: string; room?: string; limit?: number; offset?: number }): Promise<PalaceSearchResult> {
    const params = new URLSearchParams();
    if (opts.wing) params.set("wing", opts.wing);
    if (opts.room) params.set("room", opts.room);
    params.set("limit", String(opts.limit ?? 20));
    if (opts.offset) params.set("offset", String(opts.offset));
    const url = `${this.baseUrl}/list?${params.toString()}`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers() });
    if (!res.ok) throw new Error(`palace-daemon list: ${res.status} ${res.statusText}`);
    const raw = (await res.json()) as { drawers?: Array<{
      drawer_id?: string; id?: string; wing?: string; room?: string;
      content_preview?: string; text?: string; created_at?: string; topic?: string;
    }>; total?: number };
    const results: PalaceDrawer[] = (raw.drawers ?? []).map((d) => ({
      id: d.drawer_id ?? d.id,
      text: d.text ?? d.content_preview ?? "",
      wing: d.wing ?? "",
      room: d.room ?? "",
      created_at: d.created_at,
      topic: d.topic,
    }));
    return { query: "", results, total_before_filter: raw.total };
  }

  async deleteDrawer(drawerId: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/memory/${encodeURIComponent(drawerId)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`palace-daemon delete: ${res.status} ${res.statusText}`);
  }

  async updateDrawer(drawerId: string, patch: { content?: string; wing?: string; room?: string }): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/memory/${encodeURIComponent(drawerId)}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`palace-daemon update: ${res.status} ${res.statusText}`);
  }

  async writeMemory(opts: WriteMemoryOpts): Promise<WriteMemoryResult> {
    const res = await this.fetchFn(`${this.baseUrl}/memory`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`palace-daemon memory write: ${res.status} ${res.statusText}`);
    // Forward-compatible: pre-mempalace#86 daemons return {ok: true} or similar
    // without warnings/errors; default to empty arrays.
    const data = (await res.json().catch(() => ({}))) as Partial<WriteMemoryResult> & { drawer_id?: string };
    return {
      id: data.id ?? data.drawer_id ?? "",
      warnings: data.warnings ?? [],
      errors: data.errors ?? [],
    };
  }

  async health(): Promise<{ status: string; [k: string]: unknown }> {
    // Bound /health probe with the same 2s ceiling used elsewhere — when
    // the daemon is wedged (mid-rebuild, lock contention, etc.) /health can
    // hang indefinitely and we don't want familiar's /api/familiar/health
    // to hang with it.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.searchTimeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`palace-daemon health: ${res.status}`);
      return (await res.json()) as { status: string };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the palace structural snapshot. palace-daemon v1.6.0 added this as
   * a single-shot parallel-gather endpoint. Heavy by design — callers should
   * cache the result rather than poll directly. Familiar's /api/familiar/graph
   * route adds a 30s in-memory cache layer on top of this.
   */
  async getGraph(): Promise<PalaceGraph> {
    const res = await this.fetchFn(`${this.baseUrl}/graph`, { headers: this.headers() });
    if (!res.ok) throw new Error(`palace-daemon graph: ${res.status} ${res.statusText}`);
    return (await res.json()) as PalaceGraph;
  }

  /**
   * Stop-hook diary save. palace-daemon v1.5.0+ exposes /silent-save as the
   * single durable write path for session checkpoints. Queue-safe by design:
   * if a palace rebuild is in progress, the daemon writes to
   * `<palace_parent>/palace-daemon-pending.jsonl` and drains automatically
   * once the rebuild completes — no retry logic needed client-side.
   */
  async silentSave(params: SilentSaveParams): Promise<SilentSaveResult> {
    const res = await this.fetchFn(`${this.baseUrl}/silent-save`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`palace-daemon silent-save: ${res.status} ${res.statusText}`);
    // Forward-compatible: default warnings/errors to [] when daemon predates mempalace#86.
    const raw = (await res.json()) as Partial<SilentSaveResult>;
    return {
      count: raw.count ?? 0,
      themes: raw.themes ?? [],
      queued: raw.queued ?? false,
      entry_id: raw.entry_id,
      systemMessage: raw.systemMessage ?? "",
      warnings: raw.warnings ?? [],
      errors: raw.errors ?? [],
    };
  }
}

export interface SilentSaveParams {
  session_id: string;
  wing: string;
  entry: string;
  topic?: string;
  agent_name?: string;
  themes?: string[];
  message_count?: number;
}

export interface SilentSaveResult {
  count: number;
  themes: string[];
  queued: boolean;
  entry_id?: string;
  /** Daemon-formatted, glyphed string (✦ for memory ops). Render verbatim. */
  systemMessage: string;
  /**
   * Non-fatal warnings emitted during the save (mempalace#86). Empty on
   * older daemons that don't ship the field.
   */
  warnings: string[];
  /**
   * Non-fatal errors recorded but not raised (mempalace#86). Empty on
   * older daemons that don't ship the field.
   */
  errors: string[];
}
