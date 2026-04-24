import type { PalaceClient } from "./palace-client.ts";
import type { CircuitBreaker } from "./circuit-breaker.ts";
import type { SigilInfo } from "./sigil.ts";

export interface HealthDeps {
  palace: PalaceClient;
  ollamaChatUrl: string;
  ollamaEmbedUrl: string;
  breakers: {
    palace: CircuitBreaker;
    ollamaChat: CircuitBreaker;
    ollamaEmbed: CircuitBreaker;
  };
  sigil: SigilInfo;
  fetch?: typeof fetch;
}

export interface HealthReport {
  service: "familiar-api";
  version: SigilInfo;
  dependencies: {
    palace_daemon: DepReport;
    ollama_chat: DepReport;
    ollama_embed: DepReport;
  };
  circuit_breakers: {
    palace_daemon: string;
    ollama_chat: string;
    ollama_embed: string;
  };
}

interface DepReport {
  status: "ok" | "degraded";
  latency_ms?: number;
  error?: string;
}

async function probe(fn: () => Promise<void>): Promise<DepReport> {
  const start = Date.now();
  try {
    await fn();
    return { status: "ok", latency_ms: Date.now() - start };
  } catch (err) {
    return { status: "degraded", error: (err as Error).message };
  }
}

export async function getHealth(deps: HealthDeps): Promise<HealthReport> {
  const fetchFn = deps.fetch ?? fetch;
  const [palace, chat, embed] = await Promise.all([
    probe(() => deps.palace.health().then(() => {})),
    probe(async () => {
      const r = await fetchFn(`${deps.ollamaChatUrl}/api/tags`);
      if (!r.ok) throw new Error(`${r.status}`);
    }),
    probe(async () => {
      const r = await fetchFn(`${deps.ollamaEmbedUrl}/api/tags`);
      if (!r.ok) throw new Error(`${r.status}`);
    }),
  ]);
  return {
    service: "familiar-api",
    version: deps.sigil,
    dependencies: {
      palace_daemon: palace,
      ollama_chat: chat,
      ollama_embed: embed,
    },
    circuit_breakers: {
      palace_daemon: deps.breakers.palace.state(),
      ollama_chat: deps.breakers.ollamaChat.state(),
      ollama_embed: deps.breakers.ollamaEmbed.state(),
    },
  };
}
