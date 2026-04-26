import { test, expect, describe } from "bun:test";
import { createFamiliarMcp } from "../src/mcp-server.ts";
import type { PalaceClient } from "../src/palace-client.ts";
import type { Config, InferenceChatProvider, OllamaChatChunk, PalaceDrawer } from "../src/types.ts";

const baseCfg: Config = {
  port: 0,
  host: "",
  ollamaChat: { url: "", model: "" },
  ollamaEmbed: { url: "", model: "" },
  llamaCpp: { url: "", model: "" },
  palaceDaemon: { url: "", apiKey: "", searchTimeoutMs: 1000 },
  tokenBudget: { system: 1500, context: 4000, history: 2000, response: 512 },
  retrievalLimit: 5,
  candidateLimit: 20,
  sessionTtlMinutes: 60,
  realmSigilRealm: "fantasy",
  logLevel: "warn",
};

function mockPalace(drawers: PalaceDrawer[]): PalaceClient {
  return {
    search: async () => ({
      query: "x",
      available_in_scope: drawers.length,
      warnings: [],
      results: drawers,
    }),
  } as unknown as PalaceClient;
}

function mockInference(answer: string): InferenceChatProvider {
  return {
    isHealthy: () => Promise.resolve(true),
    async *chatStream() {
      yield {
        model: "test",
        created_at: "",
        message: { role: "assistant", content: answer },
        done: false,
      } as OllamaChatChunk;
      yield { model: "test", created_at: "", done: true } as OllamaChatChunk;
    },
  };
}

/**
 * Pull the registered tool handler directly off the McpServer instance
 * via _registeredTools. The SDK doesn't expose a public test API; this
 * private path is stable for the SDK 1.29 shape (entry has `handler`).
 */
function getHandler(server: ReturnType<typeof createFamiliarMcp>, name: string): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: Record<string, unknown>, extra: object) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> | undefined;
  if (!tools) throw new Error("server._registeredTools not present — SDK shape changed?");
  const tool = tools[name];
  if (!tool) throw new Error(`tool not registered: ${name}. registered: ${Object.keys(tools).join(", ")}`);
  return (args) => tool.handler(args, {} as object);
}

describe("createFamiliarMcp", () => {
  test("registers the three documented tools", () => {
    const server = createFamiliarMcp({
      cfg: baseCfg,
      palace: mockPalace([]),
      inference: mockInference(""),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(Object.keys(tools).sort()).toEqual(["familiar_chat", "familiar_recall", "familiar_reflect"]);
  });

  describe("familiar_recall", () => {
    test("returns formatted drawers with [drawer_id] markers", async () => {
      const drawers: PalaceDrawer[] = [
        { id: "drawer_a", text: "User enjoys hiking.", wing: "personal", room: "hobbies", similarity: 0.85 },
        { id: "drawer_b", text: "JP works on familiar.realm.watch.", wing: "projects", room: "familiar", similarity: 0.78 },
      ];
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace: mockPalace(drawers),
        inference: mockInference(""),
      });
      const result = await getHandler(server, "familiar_recall")({ query: "what does JP do?" });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("[drawer_a]");
      expect(text).toContain("[drawer_b]");
      expect(text).toContain("personal/hobbies");
      expect(text).toContain("projects/familiar");
      expect(text).toContain("hiking");
    });

    test("returns 'No relevant memories' when palace returns empty", async () => {
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace: mockPalace([]),
        inference: mockInference(""),
      });
      const result = await getHandler(server, "familiar_recall")({ query: "obscure" });
      expect(result.content[0].text).toMatch(/no relevant memories/i);
    });

    test("filters null-text drawers (defensive)", async () => {
      const drawers: PalaceDrawer[] = [
        { id: "drawer_null", text: null as unknown as string, wing: "w", room: "r", similarity: 0.9 },
        { id: "drawer_real", text: "real content", wing: "w", room: "r", similarity: 0.8 },
      ];
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace: mockPalace(drawers),
        inference: mockInference(""),
      });
      const result = await getHandler(server, "familiar_recall")({ query: "test" });
      expect(result.content[0].text).toContain("[drawer_real]");
      expect(result.content[0].text).not.toContain("[drawer_null]");
    });

    test("returns isError on palace failure", async () => {
      const palace = { search: async () => { throw new Error("ECONNREFUSED"); } } as unknown as PalaceClient;
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace,
        inference: mockInference(""),
      });
      const result = await getHandler(server, "familiar_recall")({ query: "x" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/palace search failed.*ECONNREFUSED/i);
    });
  });

  describe("familiar_reflect", () => {
    test("returns the inference response", async () => {
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace: mockPalace([{ id: "d1", text: "context", wing: "w", room: "r", similarity: 0.8 }]),
        inference: mockInference("a thoughtful reflection"),
      });
      const result = await getHandler(server, "familiar_reflect")({ topic: "memory" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("a thoughtful reflection");
    });

    test("returns isError on inference failure", async () => {
      const failing: InferenceChatProvider = {
        isHealthy: () => Promise.resolve(true),
        async *chatStream() { throw new Error("inference down"); },
      };
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace: mockPalace([]),
        inference: failing,
      });
      const result = await getHandler(server, "familiar_reflect")({ topic: "x" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/reflection failed.*inference down/i);
    });
  });

  describe("familiar_chat", () => {
    test("returns the inference response", async () => {
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace: mockPalace([{ id: "d1", text: "context", wing: "w", room: "r", similarity: 0.8 }]),
        inference: mockInference("hello back"),
      });
      const result = await getHandler(server, "familiar_chat")({ message: "hello" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("hello back");
    });

    test("respects optional wing parameter (passed through to retrieval)", async () => {
      let observedWing: string | undefined;
      const palace = {
        search: async (opts: { wing?: string }) => {
          observedWing = opts.wing;
          return { query: "x", available_in_scope: 0, warnings: [], results: [] };
        },
      } as unknown as PalaceClient;
      const server = createFamiliarMcp({
        cfg: baseCfg,
        palace,
        inference: mockInference("ok"),
      });
      await getHandler(server, "familiar_chat")({ message: "hi", wing: "realmwatch" });
      expect(observedWing).toBe("realmwatch");
    });
  });
});
