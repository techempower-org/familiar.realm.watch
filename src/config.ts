import type { Config } from "./types.ts";

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return n;
}

function readStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function readLogLevel(name: string, fallback: Config["logLevel"]): Config["logLevel"] {
  const v = readStr(name, fallback);
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  throw new Error(`${name} must be debug|info|warn|error, got: ${v}`);
}

export function loadConfig(): Config {
  return {
    port: readInt("FAMILIAR_PORT", 8080),
    host: readStr("FAMILIAR_HOST", "0.0.0.0"),
    ollamaChat: {
      url: readStr("OLLAMA_CHAT_URL", "http://127.0.0.1:11434"),
      model: readStr("OLLAMA_CHAT_MODEL", "qwen2.5:3b-instruct-q4_K_M"),
    },
    ollamaEmbed: {
      url: readStr("OLLAMA_EMBED_URL", "http://127.0.0.1:11435"),
      model: readStr("OLLAMA_EMBED_MODEL", "nomic-embed-text:v1.5"),
    },
    llamaCpp: {
      // Empty default → router skips this provider (Phase 1 sets it to katana:11436)
      url: readStr("LLAMA_CPP_URL", ""),
      model: readStr("LLAMA_CPP_MODEL", "qwen2.5-7b"),
    },
    palaceDaemon: {
      url: readStr("PALACE_DAEMON_URL", "http://katana:8085"),
      apiKey: readStr("PALACE_DAEMON_API_KEY", ""),
      searchTimeoutMs: readInt("PALACE_SEARCH_TIMEOUT_MS", 2000),
    },
    tokenBudget: {
      system: readInt("TOKEN_BUDGET_SYSTEM", 1500),
      context: readInt("TOKEN_BUDGET_CONTEXT", 4000),
      history: readInt("TOKEN_BUDGET_HISTORY", 2000),
      response: readInt("TOKEN_BUDGET_RESPONSE", 512),
    },
    retrievalLimit: readInt("RETRIEVAL_LIMIT", 5),
    sessionTtlMinutes: readInt("SESSION_TTL_MINUTES", 60),
    realmSigilRealm: readStr("REALM_SIGIL_REALM", "fantasy"),
    logLevel: readLogLevel("LOG_LEVEL", "info"),
  };
}
