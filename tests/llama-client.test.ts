import { test, expect, describe } from "bun:test";
import { LlamaCppClient } from "../src/llama-client.ts";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResp(lines: string[]): Response {
  return new Response(lines.join("\n\n") + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("LlamaCppClient", () => {
  test("isHealthy returns true on /health 200", async () => {
    const client = new LlamaCppClient({
      baseUrl: "http://katana:11436",
      model: "qwen",
      fetch: (() => Promise.resolve(jsonResp({ status: "ok" }))) as unknown as typeof fetch,
    });
    expect(await client.isHealthy()).toBe(true);
  });

  test("isHealthy returns false on network error", async () => {
    const client = new LlamaCppClient({
      baseUrl: "http://katana:11436",
      model: "qwen",
      fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    expect(await client.isHealthy()).toBe(false);
  });

  test("chatStream translates OpenAI-compat SSE to OllamaChatChunk shape", async () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ];
    const client = new LlamaCppClient({
      baseUrl: "http://katana:11436",
      model: "qwen",
      fetch: (() => Promise.resolve(sseResp(lines))) as unknown as typeof fetch,
    });

    const contents: string[] = [];
    let saw_done = false;
    for await (const chunk of client.chatStream({ messages: [{ role: "user", content: "hi" }] })) {
      if (chunk.message?.content) contents.push(chunk.message.content);
      if (chunk.done) saw_done = true;
    }
    expect(contents).toEqual(["Hi", " world"]);
    expect(saw_done).toBe(true);
  });

  test("chatStream throws on non-2xx upstream response", async () => {
    const client = new LlamaCppClient({
      baseUrl: "http://katana:11436",
      model: "qwen",
      fetch: (() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch,
    });
    const gen = client.chatStream({ messages: [{ role: "user", content: "hi" }] });
    await expect(gen.next()).rejects.toThrow(/500/);
  });

  test("chatStream skips malformed SSE lines without crashing", async () => {
    const lines = [
      "data: not-json-at-all",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}`,
      "data: [DONE]",
    ];
    const client = new LlamaCppClient({
      baseUrl: "http://katana:11436",
      model: "qwen",
      fetch: (() => Promise.resolve(sseResp(lines))) as unknown as typeof fetch,
    });

    const contents: string[] = [];
    for await (const chunk of client.chatStream({ messages: [] })) {
      if (chunk.message?.content) contents.push(chunk.message.content);
    }
    expect(contents).toEqual(["ok"]);
  });
});
