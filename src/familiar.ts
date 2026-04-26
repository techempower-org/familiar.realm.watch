import { loadConfig } from "./config.ts";
import { SessionStore } from "./sessions.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { PalaceClient } from "./palace-client.ts";
import { OllamaClient } from "./ollama-client.ts";
import { readSigil } from "./sigil.ts";
import { handleChat } from "./routes/chat.ts";
import { handleEmbeddings } from "./routes/embeddings.ts";
import { handleVersion, handleHealth } from "./routes/api.ts";
import { handleEval } from "./routes/eval.ts";
import { handleGraph } from "./routes/graph.ts";

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

const mkBreaker = () => new CircuitBreaker({ threshold: 3, windowMs: 30_000, openMs: 60_000 });
const breakers = {
  palace: mkBreaker(),
  ollamaChat: mkBreaker(),
  ollamaEmbed: mkBreaker(),
};

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

log("server.starting", { port: cfg.port, host: cfg.host, sigil });

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  async fetch(req) {
    const url = new URL(req.url);
    const t0 = Date.now();
    try {
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return await handleChat(req, { cfg, palace, ollama: ollamaChat, sessions, breakers: { palace: breakers.palace, ollama: breakers.ollamaChat } });
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
        return await handleEval(req, { cfg, palace, inference: ollamaChat });
      }
      if (url.pathname === "/api/familiar/graph" && req.method === "GET") {
        return await handleGraph(req, { palace });
      }

      if (req.method === "GET") {
        const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
        // Reject any path trying to escape web/ via ..
        if (pathname.includes("..")) return new Response("not found", { status: 404 });
        const file = Bun.file(`./web${pathname}`);
        if (await file.exists()) {
          const ct = contentTypeFor(pathname);
          return new Response(file, { headers: { "content-type": ct } });
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
