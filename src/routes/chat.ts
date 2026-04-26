import type { OllamaClient } from "../ollama-client.ts";
import type { PalaceClient } from "../palace-client.ts";
import type { CircuitBreaker } from "../circuit-breaker.ts";
import type { SessionStore } from "../sessions.ts";
import type { Config } from "../types.ts";
import type { DiaryBuffer } from "../diary-buffer.ts";
import { retrieveAndGround, type RetrieveAndGroundResult } from "../memory-protocol.ts";
import { voice } from "../lang/familiar-voice.ts";
import { buildTrace, traceSummary } from "../trace.ts";

export interface ChatRouteDeps {
  cfg: Config;
  palace: PalaceClient;
  ollama: OllamaClient;
  sessions: SessionStore;
  diaryBuffer: DiaryBuffer;
  breakers: {
    palace: CircuitBreaker;
    ollama: CircuitBreaker;
  };
}

interface OpenAIChatRequest {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream?: boolean;
  user?: string;
  wing?: string;
}

/**
 * POST /v1/chat/completions. OpenAI-compatible request/response.
 * If stream=true (default), returns Server-Sent Events ("data: {...}\n\n").
 * If stream=false, buffers the full response and returns a single JSON body.
 */
export async function handleChat(req: Request, deps: ChatRouteDeps): Promise<Response> {
  let body: OpenAIChatRequest;
  try {
    body = (await req.json()) as OpenAIChatRequest;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  if (!body.messages || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages required" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return new Response(JSON.stringify({ error: "at least one user message required" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  let session = body.user ? deps.sessions.get(body.user) : undefined;
  if (!session) session = deps.sessions.create();
  const sessionId = session.id;

  const wingHint = body.wing ?? req.headers.get("x-familiar-context") ?? null;

  // Track this query for stuck-loop detection; check before retrieval so the
  // current query is INCLUDED in the recent-history window for future turns
  // but does NOT match itself for the current turn's stuck check.
  const stuck = deps.sessions.isStuck(sessionId, lastUser.content);
  deps.sessions.markQuery(sessionId, lastUser.content);

  let grounded: Awaited<ReturnType<typeof retrieveAndGround>>;
  try {
    grounded = await deps.breakers.palace.run(() => retrieveAndGround({
      palace: deps.palace,
      userMessage: lastUser.content,
      wingScope: wingHint,
      retrievalLimit: deps.cfg.retrievalLimit,
      contextBudgetTokens: deps.cfg.tokenBudget.context,
      recentCitations: session.recentCitations,
      stuck,
    }));
  } catch {
    // breaker open — still respond, just without palace context
    grounded = {
      systemPrompt: `You are the familiar. ${voice.palaceQuiet}`,
      drawerIds: [],
      entities: [],
      warnings: ["palace_unreachable"],
    };
  }
  if (stuck) grounded.warnings.push("stuck_loop");

  const model = body.model ?? deps.cfg.ollamaChat.model;
  const messagesForOllama = [
    { role: "system" as const, content: grounded.systemPrompt },
    ...body.messages,
  ];

  const stream = body.stream !== false;
  const traceEnabled = new URL(req.url).searchParams.get("trace") === "1";
  const turnStartedAt = Date.now();
  const sharedOpts: GenOpts = {
    deps,
    model,
    messagesForOllama,
    sessionId,
    grounded,
    wingScope: wingHint,
    userContent: lastUser.content,
    turnStartedAt,
    traceEnabled,
  };
  return stream ? streamResponse(sharedOpts) : bufferResponse(sharedOpts);
}

interface GenOpts {
  deps: ChatRouteDeps;
  model: string;
  messagesForOllama: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  sessionId: string;
  grounded: RetrieveAndGroundResult;
  wingScope: string | null;
  userContent: string;
  turnStartedAt: number;
  traceEnabled: boolean;
}

function streamResponse(opts: GenOpts): Response {
  const { deps, model, messagesForOllama, sessionId, grounded, wingScope, userContent, turnStartedAt, traceEnabled } = opts;
  const enc = new TextEncoder();
  let accumulated = "";
  const created = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${crypto.randomUUID()}`;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await deps.breakers.ollama.run(async () => {
          for await (const chunk of deps.ollama.chatStream({ model, messages: messagesForOllama })) {
            const delta = chunk.message?.content ?? "";
            if (delta) accumulated += delta;
            const openAIChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: delta ? { role: "assistant", content: delta } : {}, finish_reason: chunk.done ? "stop" : null }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            if (chunk.done) {
              if (traceEnabled) emitTraceEvent(controller, enc, opts, accumulated);
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
            }
          }
        });
      } catch (err) {
        const errChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: `\n\n${voice.chatFalters}` }, finish_reason: "stop" }],
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
        if (traceEnabled) emitTraceEvent(controller, enc, opts, accumulated);
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
        logTrace(opts, accumulated);
        postStreamWrite({ deps, sessionId, userContent, assistantContent: accumulated, drawerIds: grounded.drawerIds });
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-session-id": sessionId,
    },
  });
}

async function bufferResponse(opts: GenOpts): Promise<Response> {
  const { deps, model, messagesForOllama, sessionId, grounded, userContent } = opts;
  let accumulated = "";
  try {
    await deps.breakers.ollama.run(async () => {
      for await (const chunk of deps.ollama.chatStream({ model, messages: messagesForOllama })) {
        const delta = chunk.message?.content ?? "";
        if (delta) accumulated += delta;
      }
    });
  } catch {
    accumulated = voice.chatFalters;
  }
  logTrace(opts, accumulated);
  postStreamWrite({ deps, sessionId, userContent, assistantContent: accumulated, drawerIds: grounded.drawerIds });
  const resp: Record<string, unknown> = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: accumulated }, finish_reason: "stop" }],
  };
  if (opts.traceEnabled) {
    resp.trace = buildTraceFromOpts(opts, accumulated);
  }
  return new Response(JSON.stringify(resp), {
    status: 200,
    headers: { "content-type": "application/json", "x-session-id": sessionId },
  });
}

function buildTraceFromOpts(opts: GenOpts, answer: string) {
  const { sessionId, grounded, wingScope, userContent, turnStartedAt } = opts;
  return buildTrace({
    sessionId,
    query: userContent,
    wingScope,
    entities: grounded.entities,
    contextString: grounded.systemPrompt,
    answer,
    warnings: grounded.warnings,
    availableInScope: grounded.availableInScope,
    startedAt: turnStartedAt,
  });
}

function emitTraceEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  enc: TextEncoder,
  opts: GenOpts,
  answer: string,
): void {
  const trace = buildTraceFromOpts(opts, answer);
  controller.enqueue(enc.encode(`event: trace\ndata: ${JSON.stringify(trace)}\n\n`));
}

function logTrace(opts: GenOpts, answer: string): void {
  const trace = buildTraceFromOpts(opts, answer);
  console.log(traceSummary(trace));
}

function postStreamWrite(args: {
  deps: ChatRouteDeps;
  sessionId: string;
  userContent: string;
  assistantContent: string;
  drawerIds: string[];
}): void {
  // Fire-and-forget: never await, never propagate errors to the user
  const { deps, sessionId, userContent, assistantContent, drawerIds } = args;
  queueMicrotask(() => {
    deps.sessions.appendTurn(sessionId, { role: "user", content: userContent });
    deps.sessions.appendTurn(sessionId, { role: "assistant", content: assistantContent });
    deps.sessions.markCitations(sessionId, drawerIds);
    // Feed the diary buffer — flushes every 10 turns to palace /silent-save.
    const entry = `[${new Date().toISOString()}] user: ${userContent.slice(0, 200)} | assistant: ${assistantContent.slice(0, 200)}`;
    deps.diaryBuffer.add(entry).catch(() => { /* daemon-side queue handles failures */ });
  });
}
