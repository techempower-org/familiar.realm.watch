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

export interface PalaceDrawer {
  id?: string;
  text: string;
  wing: string;
  room: string;
  source_file?: string;
  created_at?: string;
  similarity?: number;
  distance?: number;
  matched_via?: "drawer" | "sqlite_bm25_fallback" | string;
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
