import { test, expect, describe, mock } from "bun:test";
import { OllamaClient } from "../src/ollama-client.ts";

function ndjsonResponse(chunks: object[]): Response {
  const body = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("OllamaClient", () => {
  test("chatStream yields content chunks then done", async () => {
    const fetchMock = mock(async () => ndjsonResponse([
      { model: "m", created_at: "t", message: { role: "assistant", content: "Hel" }, done: false },
      { model: "m", created_at: "t", message: { role: "assistant", content: "lo" }, done: false },
      { model: "m", created_at: "t", done: true },
    ]));
    const client = new OllamaClient({ baseUrl: "http://ollama:11434", defaultModel: "m", fetch: fetchMock as unknown as typeof fetch });

    const out: string[] = [];
    let doneFlag = false;
    for await (const chunk of client.chatStream({ messages: [{ role: "user", content: "hi" }] })) {
      if (chunk.message?.content) out.push(chunk.message.content);
      if (chunk.done) doneFlag = true;
    }
    expect(out.join("")).toBe("Hello");
    expect(doneFlag).toBe(true);
  });

  test("chatStream uses provided model over default", async () => {
    let captured: object = {};
    const fetchMock = mock(async (_url: unknown, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return ndjsonResponse([{ model: "x", created_at: "t", done: true }]);
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

  test("embed returns vector", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 }));
    const client = new OllamaClient({ baseUrl: "http://o:11435", defaultModel: "nomic", fetch: fetchMock as unknown as typeof fetch });
    const v = await client.embed({ text: "hello" });
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  test("embed uses provided model", async () => {
    let body: object = {};
    const fetchMock = mock(async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    });
    const client = new OllamaClient({ baseUrl: "http://o:11435", defaultModel: "default", fetch: fetchMock as unknown as typeof fetch });
    await client.embed({ model: "custom", text: "x" });
    expect((body as { model: string }).model).toBe("custom");
  });
});
