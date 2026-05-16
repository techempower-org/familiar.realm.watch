import type { PalaceClient } from "./palace-client.ts";
import type { CircuitBreaker } from "./circuit-breaker.ts";
import type { SigilInfo } from "./sigil.ts";
import type { InferenceChatProvider } from "./types.ts";
import type { OllamaClient } from "./ollama-client.ts";
import { voice } from "./lang/familiar-voice.ts";

export interface HealthDeps {
  palace: PalaceClient;
  ollamaChatUrl: string;
  ollamaEmbedUrl: string;
  /** Configured chat model name (defaults from cfg.ollamaChat.model). Used
   * by the functional chat probe to verify the model actually serves,
   * not just that /v1/models is reachable. */
  chatModel?: string;
  /** Configured embed model name. Same purpose for the embed probe. */
  embedModel?: string;
  /** Inference router or any InferenceChatProvider. When provided, /api/
   * familiar/health does a functional chat completion probe — sends a
   * tiny ping and asserts the response is non-empty AND not the
   * chatFalters fallback string. This is the lever that would have
   * caught the 2026-05-16 env-mismatch incident (OLLAMA_CHAT_MODEL=
   * gemma3:4b but only phi-4 loaded; /v1/models returned 200 ok, chat
   * returned the "voice falters" fallback). Without this dep, only the
   * /v1/models dial-tone check runs. */
  inference?: InferenceChatProvider;
  /** Embed client. When provided, the embed probe makes a real
   * embedding call and asserts a non-empty vector. */
  ollamaEmbed?: OllamaClient;
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
  /**
   * For ollama_chat only (#186):
   *   "ok"          — functional chat completion returned a non-fallback token
   *   "fallback"    — inference returned the chatFalters string (model loaded
   *                    upstream returns 200 on /v1/models but isn't actually
   *                    serving the configured model name — 2026-05-16 incident)
   *   "probe_error" — chat probe failed entirely (timeout, network)
   */
  chat_quality?: "ok" | "fallback" | "probe_error";
  chat_warning?: string;
  chat_latency_ms?: number;
  /**
   * For ollama_embed only (#186): "ok" if a real embedding call returned a
   * non-empty vector. Catches the embed-equivalent of the chat fallback bug.
   */
  embed_quality?: "ok" | "probe_error";
  embed_warning?: string;
  embed_latency_ms?: number;
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

/**
 * Functional chat-completion probe (#186, production-readiness).
 *
 * Sends a 1-token completion through the actual inference router and
 * asserts the response is non-empty AND not the chatFalters fallback
 * string. This catches the failure mode that bit 2026-05-16:
 * /v1/models returned 200 ok (so the dial-tone probe was happy), but
 * the configured chat model wasn't loaded so every chat request hit
 * the fallback. /api/familiar/health reported "ok" while users saw
 * "My voice falters" for hours.
 *
 * Bounded latency (timeoutMs default 4s) so the health endpoint stays
 * fast enough for status-page polling. Returns `chat_quality:
 * "ok" | "fallback" | "probe_error"` so consumers can see the
 * actionable detail without parsing free-form strings.
 */
async function probeChatCompletion(
  inference: InferenceChatProvider,
  model: string,
  // 10s default — phi-4 14B on P102 routinely takes 1-3s for first-token
  // even on a tiny prompt. The original 4s ceiling tripped under steady-
  // state load (2026-05-16 watchdog deploy showed every probe hitting
  // 4001ms ceiling); 10s keeps the probe useful as a regression detector
  // while accommodating the cold/loaded model latency profile.
  timeoutMs = 10000,
): Promise<{
  chat_quality: "ok" | "fallback" | "probe_error";
  chat_warning?: string;
  chat_latency_ms?: number;
}> {
  const start = Date.now();
  // Race the actual stream pull against a timeout. ChatStreamOpts does
  // not (yet) carry an AbortSignal, so a deadline race is the safest
  // bound-the-latency tool we have without widening the provider
  // contract for one consumer.
  const run = (async () => {
    let accumulated = "";
    for await (const chunk of inference.chatStream({
      model,
      messages: [{ role: "user", content: "ping" }],
      // num_predict caps the visible response tokens on llama-server
      // and stock Ollama alike; small enough to keep the probe cheap
      // even if a thinking model wants to chain-of-thought.
      options: { num_predict: 4 },
    })) {
      const delta = chunk.message?.content ?? "";
      if (delta) accumulated += delta;
      if (accumulated.length >= 4) break;
    }
    return accumulated;
  })();
  let accumulated: string;
  try {
    accumulated = await Promise.race([
      run,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  } catch (err) {
    return {
      chat_quality: "probe_error",
      chat_warning: `chat probe failed: ${(err as Error).message}`,
      chat_latency_ms: Date.now() - start,
    };
  }
  const latency_ms = Date.now() - start;
  const text = accumulated.trim();
  if (!text) {
    return {
      chat_quality: "probe_error",
      chat_warning: "no tokens returned (model may not be loaded)",
      chat_latency_ms: latency_ms,
    };
  }
  // The chatFalters string in voice.ts — if we get it back, the
  // inference router exhausted all providers and the chat route
  // returned the themed fallback. That's exactly what happened
  // 2026-05-16 with OLLAMA_CHAT_MODEL=gemma3:4b not loaded.
  if (voice.chatFalters && text.includes(voice.chatFalters.slice(0, 20))) {
    return {
      chat_quality: "fallback",
      chat_warning: "inference returned the chatFalters fallback string — model not actually serving",
      chat_latency_ms: latency_ms,
    };
  }
  return { chat_quality: "ok", chat_latency_ms: latency_ms };
}

/**
 * Functional embed probe — asks for an embedding of a single character
 * and asserts a non-empty vector. Catches the embed-equivalent of the
 * chat-fallback bug: /v1/models 200 but the configured embed model
 * isn't actually serving.
 */
async function probeEmbedCompletion(
  embedClient: OllamaClient,
  model: string,
  timeoutMs = 4000,
): Promise<{
  embed_quality: "ok" | "probe_error";
  embed_warning?: string;
  embed_latency_ms?: number;
}> {
  const start = Date.now();
  try {
    const vec = await Promise.race([
      embedClient.embed({ model, text: "x" }),
      new Promise<number[]>((_, reject) =>
        setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const latency_ms = Date.now() - start;
    if (!Array.isArray(vec) || vec.length === 0) {
      return {
        embed_quality: "probe_error",
        embed_warning: "embed returned non-array or empty vector",
        embed_latency_ms: latency_ms,
      };
    }
    return { embed_quality: "ok", embed_latency_ms: latency_ms };
  } catch (err) {
    return {
      embed_quality: "probe_error",
      embed_warning: `embed probe failed: ${(err as Error).message}`,
      embed_latency_ms: Date.now() - start,
    };
  }
}

export async function getHealth(deps: HealthDeps): Promise<HealthReport> {
  const fetchFn = deps.fetch ?? fetch;
  // Probe set. Two new functional probes (chat + embed completion) run
  // *in addition to* the /v1/models dial-tone — the dial-tone catches
  // "service unreachable", the functional probes catch "service reachable
  // but configured model not serving". Both run in parallel to keep p99
  // latency under the timeout cap.
  const chatFunctional = deps.inference && deps.chatModel
    ? probeChatCompletion(deps.inference, deps.chatModel)
    : Promise.resolve({ chat_quality: undefined as undefined } as never);
  const embedFunctional = deps.ollamaEmbed && deps.embedModel
    ? probeEmbedCompletion(deps.ollamaEmbed, deps.embedModel)
    : Promise.resolve({ embed_quality: undefined as undefined } as never);

  const [palace, chat, embed, recall, chatFn, embedFn] = await Promise.all([
    probe(() => deps.palace.health().then(() => {})),
    probe(async () => {
      // /v1/models is the OpenAI-compat lingua franca that both stock
      // Ollama (compat shim) and llama-server speak. /api/tags used to
      // be hardcoded here but only Ollama-native serves it — llama-server
      // returns 404 which made the health route report "degraded" even
      // when the embed service was fine. Match the client-side isHealthy()
      // change in src/ollama-client.ts.
      const r = await fetchFn(`${deps.ollamaChatUrl}/v1/models`);
      if (!r.ok) throw new Error(`${r.status}`);
    }),
    probe(async () => {
      const r = await fetchFn(`${deps.ollamaEmbedUrl}/v1/models`);
      if (!r.ok) throw new Error(`${r.status}`);
    }),
    probePalaceRecall(deps.palace),
    chatFunctional,
    embedFunctional,
  ]);

  // Merge functional chat probe into the ollama_chat dep. Both fallback
  // and probe_error flip top-level status to "degraded" so status.realm.
  // watch + the existing 503-on-degraded logic raise the alarm.
  if (chatFn && (chatFn as { chat_quality?: string }).chat_quality) {
    const cf = chatFn as { chat_quality: "ok" | "fallback" | "probe_error"; chat_warning?: string; chat_latency_ms?: number };
    chat.chat_quality = cf.chat_quality;
    if (cf.chat_warning) chat.chat_warning = cf.chat_warning;
    if (cf.chat_latency_ms !== undefined) chat.chat_latency_ms = cf.chat_latency_ms;
    if (chat.status === "ok" && cf.chat_quality !== "ok") {
      chat.status = "degraded";
      chat.error = cf.chat_quality === "fallback"
        ? `chat returned chatFalters fallback — model not serving: ${cf.chat_warning}`
        : `chat probe failed: ${cf.chat_warning}`;
    }
  }

  // Same shape for embed.
  if (embedFn && (embedFn as { embed_quality?: string }).embed_quality) {
    const ef = embedFn as { embed_quality: "ok" | "probe_error"; embed_warning?: string; embed_latency_ms?: number };
    embed.embed_quality = ef.embed_quality;
    if (ef.embed_warning) embed.embed_warning = ef.embed_warning;
    if (ef.embed_latency_ms !== undefined) embed.embed_latency_ms = ef.embed_latency_ms;
    if (embed.status === "ok" && ef.embed_quality !== "ok") {
      embed.status = "degraded";
      embed.error = `embed probe failed: ${ef.embed_warning}`;
    }
  }

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
