export interface Config {
  port: number;
  host: string;
  ollamaChat: {
    url: string;
    model: string;
  };
  ollamaEmbed: {
    url: string;
    model: string;
  };
  /** Optional llama.cpp endpoint. When set, prepended to the inference router as primary. */
  llamaCpp: {
    url: string;        // empty string = disabled (falls through to ollamaChat)
    model: string;
  };
  palaceDaemon: {
    url: string;
    apiKey: string;
    searchTimeoutMs: number;
  };
  tokenBudget: {
    system: number;
    context: number;
    history: number;
    response: number;
  };
  retrievalLimit: number;
  sessionTtlMinutes: number;
  realmSigilRealm: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Search-result filter for Stop-hook checkpoint drawers.
 * memorypalace fork (270 ahead of upstream) introduced this — checkpoints
 * are 5-word session summaries that dominate vector similarity unless filtered.
 * Default for chat retrieval is "content"; "checkpoint" is for audit/recovery.
 */

export interface PalaceDrawer {
  id?: string;
  text: string;
  wing: string;
  room: string;
  source_file?: string;
  created_at?: string;
  similarity?: number;
  distance?: number;
  // memorypalace fork additions:
  topic?: string;
  matched_via?: "drawer" | "closet" | "sqlite_bm25_fallback" | string;
  cosine?: number;
  bm25?: number;
}

export interface PalaceSearchResult {
  query: string;
  total_before_filter?: number;
  available_in_scope?: number;
  warnings?: string[];
  results: PalaceDrawer[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  options?: Record<string, unknown>;
}

export interface OllamaChatChunk {
  model: string;
  created_at: string;
  message?: { role: string; content: string };
  done: boolean;
}

/**
 * Common interface satisfied by OllamaClient and LlamaCppClient. The
 * InferenceRouter wraps multiple providers behind this same shape so the
 * chat + eval routes don't care which backend served the response.
 *
 * `chatStream` yields OllamaChatChunk-shaped objects regardless of whether
 * the upstream protocol is Ollama NDJSON or OpenAI-compat SSE — the clients
 * normalize on emit.
 */
export interface InferenceChatProvider {
  /** Returns true if the provider responds to a basic probe within the timeout. */
  isHealthy(): Promise<boolean>;
  /** Stream a chat completion. Throws if the upstream is unreachable. */
  chatStream(opts: import("./ollama-client.ts").ChatStreamOpts): AsyncGenerator<OllamaChatChunk>;
}

export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  recentTurns: ChatMessage[];
  recentCitations: string[];
  /**
   * Normalized query hashes from recent turns, capped to ~10. Used by the
   * stuck detector to notice when the user asks similar questions in a row
   * and to nudge the assistant to suggest rephrasing or wing scope.
   */
  recentQueryHashes: string[];
}

// ------------------------------------------------------------
// SME (Structural Memory Evaluation) adapter contract.
// Source: ~/Projects/multipass-structural-memory-eval/docs/sme_spec_v8.md
// Familiar exposes POST /api/familiar/eval matching this shape so multipass
// can run Cat 1–8 offline scoring (and Cat 9 Handshake once it lands).
// ------------------------------------------------------------

export interface SmeQueryRequest {
  query: string;
  /** Override retrievalLimit. */
  limit?: number;
  /** Optional wing scope. */
  wing?: string;
  /** If true, skip inference, return a stub answer. context_string is still real. */
  mock?: boolean;
}

/**
 * Origin of a retrieved entity. Modeled on karta's Provenance enum
 * (~/Projects/karta — `crates/karta-core/src/note.rs`).
 *
 * v0.2 only emits `observed` (direct palace search hit). v0.3+ adds
 * `dream` (background reasoning surfaced this) and `synthesized`
 * (multi-hop traversal derived this) variants — adding the seam now
 * costs almost nothing and lets future features carry origin metadata
 * without consumer-side churn.
 */
export type Provenance =
  | { kind: "observed" }
  | {
      kind: "dream";
      dream_type: "contradiction" | "consolidation" | "deduction" | "induction" | "abduction" | "episode" | "cross_episode";
      source_ids: string[];
      confidence: number;
    }
  | { kind: "synthesized"; steps: string[] };

export interface SmeEntity {
  /** drawer_id */
  id: string;
  /** v0.2 only emits "drawer". v0.3+ may add "kg_entity". */
  type: "drawer";
  wing?: string;
  room?: string;
  topic?: string;
  /** First ~240 chars of drawer text — full body addressable via id. */
  content_snippet?: string;
  cosine?: number;
  bm25?: number;
  matched_via?: string;
  /** Defaults to `{ kind: "observed" }` when constructed from palace search. */
  provenance?: Provenance;
}

export interface SmeEdge {
  subject: string;
  predicate: string;
  object: string;
}

export interface SmeQueryResponse {
  /** What the LLM said (or a stub when mock=true). */
  answer: string;
  /** Verbatim system prompt that went to inference — multipass tiktoken-counts this. */
  context_string: string;
  retrieved_entities: SmeEntity[];
  /** Empty in v0.2; populated with KG triples in v0.3+. */
  retrieved_edges: SmeEdge[];
  /** Adapter-level error (palace failures surface in `warnings`, not here). */
  error: string | null;
  warnings: string[];
  available_in_scope?: number;
}

/**
 * Structural snapshot of the palace, returned by palace-daemon's `GET /graph`
 * (v1.6.0+). Wings + rooms + tunnels + KG entities + KG triples in one
 * parallel-gathered response. ~0.4s on a 151K-drawer palace versus ~30s+
 * for an equivalent serial MCP fan-out.
 *
 * Familiar exposes this verbatim via `GET /api/familiar/graph` with a 30s
 * cache so the PWA / mempalace-viz / multipass adapter can poll cheaply.
 */
export interface PalaceGraph {
  /** wing_name → drawer_count */
  wings: Record<string, number>;
  rooms: Array<{
    wing: string;
    rooms: Record<string, number>;
  }>;
  tunnels: Array<{
    room: string;
    wings: string[];
  }>;
  kg_entities: Array<{
    id: string;
    name: string;
    type: string;
    properties: Record<string, unknown>;
  }>;
  kg_triples: Array<{
    subject: string;
    predicate: string;
    object: string;
    valid_from?: string;
    valid_to?: string | null;
    confidence?: number;
    source_file?: string;
  }>;
  kg_stats: { entities: number; triples: number };
}

/**
 * Structured per-turn record of a chat interaction.
 *
 * Every chat turn produces this shape — the query, the drawers walked, the
 * verbatim prompt sent to inference, the answer, the citations cited.
 * Emitted as an SSE event when the chat request includes `?trace=1`,
 * always logged to the journal as a one-line summary.
 *
 * Trace is the substrate that connects familiar to its downstream consumers:
 *  - multipass Cat 9 HandshakeTrace (one level up — across many turns)
 *  - mempalace-viz (visualizes a trace as a graph walk)
 *  - hermes-agent fine-tune corpus (one trace = one training tuple)
 *  - debugging (full turn replay)
 */
export interface Trace {
  trace_id: string;
  session_id: string;
  ts: string;                       // ISO8601 timestamp
  query: string;                    // user message
  wing_scope: string | null;
  retrieved: SmeEntity[];           // drawers selected after rerank/budget
  context_string: string;           // verbatim system prompt sent to inference
  answer: string;                   // assistant response
  citations: string[];              // drawer_ids cited in answer ([drawer_xxx] pattern)
  warnings: string[];
  available_in_scope?: number;
  inference_endpoint?: string;      // which provider served this (post-Phase 2)
  duration_ms: number;
}
