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
export type PalaceSearchKind = "content" | "checkpoint" | "all";

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

export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  recentTurns: ChatMessage[];
  recentCitations: string[];
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
  /** Forwarded to palace-client; defaults to "content" there. */
  kind?: PalaceSearchKind;
  /** Optional wing scope. */
  wing?: string;
  /** If true, skip inference, return a stub answer. context_string is still real. */
  mock?: boolean;
}

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
