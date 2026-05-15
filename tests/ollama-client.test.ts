import { test, expect, describe, mock } from "bun:test";
import { OllamaClient } from "../src/ollama-client.ts";

/**
 * SSE response factory mirroring llama-server's `/v1/chat/completions`
 * stream — each chunk is `data: {...}\n` ending with `data: [DONE]\n`.
 * We intentionally don't add `\n\n` separators (some servers do, some
 * don't); the client parses line-by-line and skips non-`data:` lines.
 */
function sseResponse(chunks: object[], terminator: "done" | "none" = "done"): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}`);
  if (terminator === "done") lines.push("data: [DONE]");
  const body = lines.join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OllamaClient (OpenAI-compat)", () => {
  test("chatStream translates OpenAI SSE deltas to OllamaChatChunks", async () => {
    const fetchMock = mock(async () => sseResponse([
      { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]));
    const client = new OllamaClient({ baseUrl: "http://server:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });

    const out: string[] = [];
    let doneFlag = false;
    for await (const chunk of client.chatStream({ messages: [{ role: "user", content: "hi" }] })) {
      if (chunk.message?.content) out.push(chunk.message.content);
      if (chunk.done) doneFlag = true;
    }
    expect(out.join("")).toBe("Hello");
    expect(doneFlag).toBe(true);
  });

  test("chatStream hits /v1/chat/completions (not /api/chat)", async () => {
    let capturedUrl = "";
    const fetchMock = mock(async (url: string | URL) => {
      capturedUrl = url.toString();
      return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    for await (const _ of client.chatStream({ messages: [{ role: "user", content: "x" }] })) { /* drain */ }
    expect(capturedUrl).toBe("http://o:11434/v1/chat/completions");
  });

  test("chatStream uses provided model over default", async () => {
    let captured: object = {};
    const fetchMock = mock(async (_url: unknown, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "default-m", fetch: fetchMock as unknown as typeof fetch });
    const it = client.chatStream({ model: "override-m", messages: [{ role: "user", content: "x" }] });
    for await (const _ of it) { /* drain */ }
    expect((captured as { model: string }).model).toBe("override-m");
  });

  test("chatStream surfaces non-2xx as thrown error", async () => {
    const fetchMock = mock(async () => new Response("boom", { status: 500 }));
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    const it = client.chatStream({ messages: [{ role: "user", content: "x" }] });
    await expect((async () => { for await (const _ of it) {} })()).rejects.toThrow(/500/);
  });

  test("chatStream still yields done when server omits [DONE] terminator", async () => {
    // llama-server is consistent about emitting [DONE]; some Ollama versions
    // and proxies don't. The client should emit a synthetic done on stream
    // close so consumers see a clean end either way.
    const fetchMock = mock(async () => sseResponse([
      { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
    ], "none"));
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    let doneFlag = false;
    for await (const chunk of client.chatStream({ messages: [{ role: "user", content: "x" }] })) {
      if (chunk.done) doneFlag = true;
    }
    expect(doneFlag).toBe(true);
  });

  test("embed unpacks OpenAI data[0].embedding shape", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
    }), { status: 200 }));
    const client = new OllamaClient({ baseUrl: "http://o:11435", defaultModel: "nomic", fetch: fetchMock as unknown as typeof fetch });
    const v = await client.embed({ text: "hello" });
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  test("embed sends `input` (OpenAI) not `prompt` (Ollama-native)", async () => {
    let body: object = {};
    const fetchMock = mock(async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    });
    const client = new OllamaClient({ baseUrl: "http://o:11435", defaultModel: "nomic", fetch: fetchMock as unknown as typeof fetch });
    await client.embed({ text: "hello world" });
    expect((body as { input: string }).input).toBe("hello world");
    expect((body as Record<string, unknown>).prompt).toBeUndefined();
  });

  test("embed uses provided model", async () => {
    let body: object = {};
    const fetchMock = mock(async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    });
    const client = new OllamaClient({ baseUrl: "http://o:11435", defaultModel: "default", fetch: fetchMock as unknown as typeof fetch });
    await client.embed({ model: "custom", text: "x" });
    expect((body as { model: string }).model).toBe("custom");
  });

  test("embed throws when response is missing data array", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new OllamaClient({ baseUrl: "http://o:11435", defaultModel: "nomic", fetch: fetchMock as unknown as typeof fetch });
    await expect(client.embed({ text: "x" })).rejects.toThrow(/no embedding/);
  });

  test("isHealthy probes /v1/models", async () => {
    let capturedUrl = "";
    const fetchMock = mock(async (url: string | URL) => {
      capturedUrl = url.toString();
      return new Response("{}", { status: 200 });
    });
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    expect(await client.isHealthy()).toBe(true);
    expect(capturedUrl).toBe("http://o:11434/v1/models");
  });

  test("isHealthy returns false on transport error", async () => {
    const fetchMock = mock(async () => { throw new Error("ECONNREFUSED"); });
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    expect(await client.isHealthy()).toBe(false);
  });

  test("generateShort uses /v1/chat/completions single-turn with stream=false", async () => {
    let url = "";
    let body: object = {};
    const fetchMock = mock(async (u: string | URL, init: RequestInit) => {
      url = u.toString();
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "hypothetical answer" } }],
      }), { status: 200 });
    });
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    const out = await client.generateShort("what is X?");
    expect(out).toBe("hypothetical answer");
    expect(url).toBe("http://o:11434/v1/chat/completions");
    const b = body as { stream: boolean; messages: Array<{ role: string; content: string }> };
    expect(b.stream).toBe(false);
    expect(b.messages).toEqual([{ role: "user", content: "what is X?" }]);
  });

  test("generateShort returns empty string on non-2xx (non-fatal HyDE)", async () => {
    const fetchMock = mock(async () => new Response("err", { status: 503 }));
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    expect(await client.generateShort("x")).toBe("");
  });

  test("generateShort returns empty string on timeout abort", async () => {
    const fetchMock = mock(async (_url: unknown, init: RequestInit) => {
      // Resolve after the abort signal fires
      await new Promise((res, rej) => {
        (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")));
      });
      return new Response("never", { status: 200 });
    });
    const client = new OllamaClient({ baseUrl: "http://o:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });
    expect(await client.generateShort("x", { timeoutMs: 5 })).toBe("");
  });
});
