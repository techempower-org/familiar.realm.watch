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
