import { loadConfig } from "./config.ts";
import { SessionStore } from "./sessions.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { PalaceClient } from "./palace-client.ts";
import { OllamaClient } from "./ollama-client.ts";
import { LlamaCppClient } from "./llama-client.ts";
import { InferenceRouter } from "./inference-router.ts";
import type { InferenceChatProvider } from "./types.ts";
import { readSigil } from "./sigil.ts";
import { handleChat } from "./routes/chat.ts";
import { handleEmbeddings } from "./routes/embeddings.ts";
import { handleVersion, handleHealth } from "./routes/api.ts";
import { handleEval } from "./routes/eval.ts";
import { handleGraph } from "./routes/graph.ts";
import { handleReflect } from "./routes/reflect.ts";
import { handleMemories, handleMemoryDelete, handleMemoryPatch } from "./routes/memories.ts";
import { ReflectWriter } from "./reflect/writer.ts";

const REFLECT_WING = "reflect";
import { DiaryBuffer } from "./diary-buffer.ts";
import { mountFamiliarMcp } from "./mcp-server.ts";

const cfg = loadConfig();
const sigil = readSigil(cfg.realmSigilRealm);

const sessions = new SessionStore({ ttlMinutes: cfg.sessionTtlMinutes });
setInterval(() => sessions.purgeExpired(), 5 * 60 * 1000);

const palace = new PalaceClient({
  baseUrl: cfg.palaceDaemon.url,
  apiKey: cfg.palaceDaemon.apiKey,
  searchTimeoutMs: cfg.palaceDaemon.searchTimeoutMs,
});
const ollamaChat = new OllamaClient({ baseUrl: cfg.ollamaChat.url, defaultModel: cfg.ollamaChat.model });
const ollamaEmbed = new OllamaClient({ baseUrl: cfg.ollamaEmbed.url, defaultModel: cfg.ollamaEmbed.model });

// Build the inference router. Order matters — first healthy wins.
// llama.cpp on katana (Phase 1) goes first when LLAMA_CPP_URL is set;
// otherwise Ollama is the only provider.
const inferenceProviders: InferenceChatProvider[] = [];
if (cfg.llamaCpp.url) {
  inferenceProviders.push(new LlamaCppClient({ baseUrl: cfg.llamaCpp.url, model: cfg.llamaCpp.model }));
}
inferenceProviders.push(ollamaChat);
const inferenceRouter = new InferenceRouter(inferenceProviders);

// HyDE generator — module-scope so both /v1/chat/completions and
// /api/familiar/eval share the same wiring. Bridges paraphrase
// vocabulary gaps (closes the "user says X, drawer says Y" gap for
// tech identifiers). Cheap on gemma3:4b (~2s).
//
// `hydeGenerator` is always constructed so the eval route can opt-in
// per-request (via `?hyde=true|false`) for A/B benchmarks. `hyde` is
// the env-default the chat route and unannotated eval requests get.
const hydeGenerator = async (query: string) =>
  ollamaChat.generateShort(
    `Write a concise (~80 words) hypothetical answer to: ${query}\nDo not say "hypothetically" or hedge — write as if you know.`,
    { maxTokens: 150, timeoutMs: 4000 },
  );
const hyde = (Bun.env.PALACE_USE_HYDE ?? "").toLowerCase() === "true"
  ? hydeGenerator
  : undefined;

const mkBreaker = () => new CircuitBreaker({ threshold: 3, windowMs: 30_000, openMs: 60_000 });
const breakers = {
  palace: mkBreaker(),
  ollamaChat: mkBreaker(),
  ollamaEmbed: mkBreaker(),
};

// Diary buffer: every 10 turns, flush a checkpoint summary to palace /silent-save.
// The daemon-side queue handles palace rebuilds, so no client-side retry needed.
const diaryBuffer = new DiaryBuffer({
  flushSize: 10,
  flushFn: async (entries) => {
    const entry = entries.join("\n\n---\n\n");
    const result = await palace.silentSave({
      session_id: "familiar-api",
      wing: "familiar",
      entry,
      themes: ["session-checkpoint", "familiar-turn"],
      message_count: entries.length,
    });
    if (result.queued) {
      log("diary.queued", { count: result.count, reason: "palace under repair" });
    } else {
      log("diary.flushed", {
        count: result.count,
        entry_id: result.entry_id,
        warnings: result.warnings,
        errors: result.errors,
        msg: result.systemMessage,
      });
    }
  },
});

// Drain the buffer cleanly on graceful shutdown so no entries are lost.
process.on("SIGTERM", () => { diaryBuffer.flush().catch(() => { /* drain best-effort */ }); });
process.on("SIGINT", () => { diaryBuffer.flush().catch(() => { /* drain best-effort */ }); });

// ReflectWriter: post-turn write-back of synthesized facts to palace.
// v0.3 ships as operator-triggered (POST /api/familiar/reflect); v0.4
// will wire automatic per-session triggering via Stop hook.
const reflectWriter = new ReflectWriter({
  palace,
  inference: inferenceRouter,
  threshold: 0.85,
  maxFactsPerTurn: 5,
  wing: REFLECT_WING,
});

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

log("server.starting", { port: cfg.port, host: cfg.host, sigil });

// Mount MCP server (3 tools: familiar_recall, familiar_reflect, familiar_chat)
const mcp = await mountFamiliarMcp({ cfg, palace, inference: inferenceRouter });

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  // palace-daemon /graph can take 30-40s on 150K-drawer palaces (single-shot
  // structural snapshot). Default Bun idleTimeout=10 kills those mid-flight.
  // Streaming chat responses also need headroom for slow models.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const t0 = Date.now();
    try {
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return await handleChat(req, { cfg, palace, ollama: inferenceRouter, sessions, diaryBuffer, reflectWriter, hydeGenerate: hyde, breakers: { palace: breakers.palace, ollama: breakers.ollamaChat } });
      }
      if (url.pathname === "/v1/embeddings" && req.method === "POST") {
        return await handleEmbeddings(req, { cfg, ollamaEmbed, breaker: breakers.ollamaEmbed });
      }
      if (url.pathname === "/api/version" && req.method === "GET") {
        return await handleVersion(req, sigil);
      }
      if (url.pathname === "/api/familiar/health" && req.method === "GET") {
        return await handleHealth(req, {
          palace,
          ollamaChatUrl: cfg.ollamaChat.url,
          ollamaEmbedUrl: cfg.ollamaEmbed.url,
          breakers: { palace: breakers.palace, ollamaChat: breakers.ollamaChat, ollamaEmbed: breakers.ollamaEmbed },
          sigil,
        });
      }
      if (url.pathname === "/api/familiar/eval" && req.method === "POST") {
        return await handleEval(req, { cfg, palace, inference: inferenceRouter, hydeGenerate: hyde, hydeGenerator });
      }
      if (url.pathname === "/api/familiar/graph" && req.method === "GET") {
        return await handleGraph(req, { palace });
      }
      if (url.pathname === "/api/familiar/reflect" && req.method === "POST") {
        return await handleReflect(req, { writer: reflectWriter });
      }
      if (url.pathname === "/api/familiar/memories" && req.method === "GET") {
        return await handleMemories(req, { palace, reflectWing: REFLECT_WING });
      }
      // /api/familiar/memories/<drawer_id> — DELETE/PATCH a single drawer.
      const memoryMatch = url.pathname.match(/^\/api\/familiar\/memories\/(drawer_[a-z0-9_]+)$/);
      if (memoryMatch) {
        const drawerId = memoryMatch[1];
        if (req.method === "DELETE") {
          return await handleMemoryDelete(req, drawerId, { palace, reflectWing: REFLECT_WING });
        }
        if (req.method === "PATCH") {
          return await handleMemoryPatch(req, drawerId, { palace, reflectWing: REFLECT_WING });
        }
      }
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        return await mcp.handle(req);
      }

      if (req.method === "GET") {
        const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
        // Reject any path trying to escape web/ via ..
        if (pathname.includes("..")) return new Response("not found", { status: 404 });
        const file = Bun.file(`./web${pathname}`);
        if (await file.exists()) {
          const ct = contentTypeFor(pathname);
          const headers: Record<string, string> = { "content-type": ct };
          // sw.js MUST always revalidate against the server. Without this,
          // browsers cache it with the default HTTP heuristics (~24h) and
          // new SW deploys don't land for existing clients until the
          // cache stales. Once the browser re-fetches sw.js and sees a
          // new content, our `self.skipWaiting() + self.clients.claim()`
          // pattern takes over and the new shell goes live immediately.
          // See techempower-org/familiar.realm.watch#17.
          if (pathname === "/sw.js") {
            headers["cache-control"] = "no-cache, must-revalidate";
          }
          return new Response(file, { headers });
        }
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      log("request.error", { url: req.url, err: (err as Error).message });
      return new Response("internal error", { status: 500 });
    } finally {
      log("request.done", { method: req.method, path: url.pathname, latency_ms: Date.now() - t0 });
    }
  },
});

log("server.listening", { url: `http://${server.hostname}:${server.port}` });

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".webmanifest") || path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
