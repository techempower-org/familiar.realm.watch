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
  /**
   * For palace_daemon only:
   *   "ok"          — /search returned cleanly with no recall warning
   *   "empty_hnsw"  — /search returned with "vector ranked 0/1 — keyword
   *                    fallback only" warning (rebuild needed)
   *   "probe_error" — /search itself failed/timed out (daemon may be
   *                    locked by an ongoing rebuild — distinct from
   *                    index-empty so operators don't conflate them)
   *
   * Surfaced loudly so status.realm.watch + manual eyeballing both flag
   * the issue immediately, instead of it hiding inside chat-turn warnings.
   */
  recall_quality?: "ok" | "empty_hnsw" | "probe_error";
  recall_warning?: string;
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

const HNSW_EMPTY_PATTERN = /vector ranked [01]\b/i;

/**
 * Probe palace recall health by issuing a tiny /search and inspecting the
 * warnings field. The jphein-fork's BM25-fallback path emits a specific
 * warning when the HNSW index is empty/quarantined; surfacing it at the
 * /api/familiar/health level means status.realm.watch sees the regression
 * immediately on its 60s poll, rather than learning about it from chat
 * trace warnings buried in journal logs.
 */
async function probePalaceRecall(palace: PalaceClient): Promise<{
  recall_quality: "ok" | "empty_hnsw" | "probe_error";
  recall_warning?: string;
}> {
  try {
    const r = await palace.search({ query: "_health_probe", limit: 1 });
    const warnings = r.warnings ?? [];
    const empty = warnings.find((w) => HNSW_EMPTY_PATTERN.test(w));
    if (empty) {
      return { recall_quality: "empty_hnsw", recall_warning: empty };
    }
    return { recall_quality: "ok" };
  } catch (err) {
    // Distinct from "ok" and "empty_hnsw" — the daemon's /health passed but
    // /search itself failed/timed out, which most often means the daemon is
    // locked by an ongoing rebuild. Operators see this as actionable
    // ambiguity ("we don't know if recall works") rather than misleading "ok".
    return {
      recall_quality: "probe_error",
      recall_warning: `search probe failed: ${(err as Error).message}`,
    };
  }
}

export async function getHealth(deps: HealthDeps): Promise<HealthReport> {
  const fetchFn = deps.fetch ?? fetch;
  const [palace, chat, embed, recall] = await Promise.all([
    probe(() => deps.palace.health().then(() => {})),
    probe(async () => {
      const r = await fetchFn(`${deps.ollamaChatUrl}/api/tags`);
      if (!r.ok) throw new Error(`${r.status}`);
    }),
    probe(async () => {
      const r = await fetchFn(`${deps.ollamaEmbedUrl}/api/tags`);
      if (!r.ok) throw new Error(`${r.status}`);
    }),
    probePalaceRecall(deps.palace),
  ]);

  // Merge recall info into the palace_daemon report. Both empty_hnsw and
  // probe_error flip top-level status to "degraded" so status.realm.watch
  // (and the existing 503-on-degraded logic in routes/api.ts) raise the
  // alarm. The recall_warning preserves the actionable detail.
  if (palace.status === "ok" && recall.recall_quality !== "ok") {
    palace.status = "degraded";
    palace.error = recall.recall_quality === "empty_hnsw"
      ? `HNSW index empty: ${recall.recall_warning}`
      : `recall probe failed (daemon may be busy): ${recall.recall_warning}`;
  }
  palace.recall_quality = recall.recall_quality;
  if (recall.recall_warning) palace.recall_warning = recall.recall_warning;

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
