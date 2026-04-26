import { test, expect, describe } from "bun:test";
import { handleEval, type EvalRouteDeps } from "../src/routes/eval.ts";
import type { PalaceClient } from "../src/palace-client.ts";
import type { Config, OllamaChatChunk, PalaceDrawer } from "../src/types.ts";

function mockPalace(drawers: PalaceDrawer[], availableInScope = drawers.length): PalaceClient {
  return {
    search: async () => ({
      query: "",
      available_in_scope: availableInScope,
      results: drawers,
      warnings: [],
    }),
  } as unknown as PalaceClient;
}

function mockInference(answer: string): { chatStream: EvalRouteDeps["inference"]["chatStream"] } {
  return {
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

const baseCfg: Config = {
  port: 0,
  host: "",
  ollamaChat: { url: "", model: "" },
  ollamaEmbed: { url: "", model: "" },
  palaceDaemon: { url: "", apiKey: "", searchTimeoutMs: 1000 },
  tokenBudget: { system: 1500, context: 4000, history: 2000, response: 512 },
  retrievalLimit: 5,
  sessionTtlMinutes: 60,
  realmSigilRealm: "fantasy",
  logLevel: "warn",
};

const deps = (palace: PalaceClient, answer: string): EvalRouteDeps => ({
  cfg: baseCfg,
  palace,
  inference: mockInference(answer),
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/familiar/eval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/familiar/eval — SME adapter contract", () => {
  test("returns SME-shape response with context_string, entities, and answer", async () => {
    const palace = mockPalace([
      { id: "drawer_abc", text: "User enjoys hiking on weekends.", wing: "personal", room: "hobbies", similarity: 0.85 },
    ]);
    const res = await handleEval(
      makeRequest({ query: "What are my hobbies?" }),
      deps(palace, "Based on the palace, you enjoy hiking. [drawer_abc]")
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.answer).toContain("hiking");
    expect(body.context_string).toContain("User enjoys hiking");
    expect(body.retrieved_entities).toBeArray();
    expect((body.retrieved_entities as unknown[]).length).toBe(1);
    const entity = (body.retrieved_entities as Record<string, unknown>[])[0];
    expect(entity.id).toBe("drawer_abc");
    expect(entity.type).toBe("drawer");
    expect(entity.wing).toBe("personal");
    expect(entity.content_snippet).toContain("hiking");
    expect(body.retrieved_edges).toEqual([]);
    expect(body.error).toBeNull();
  });

  test("mock=true skips inference, returns stub answer with real context_string", async () => {
    const palace = mockPalace([
      { id: "drawer_x", text: "Some palace memory.", wing: "w", room: "r", similarity: 0.7 },
    ]);
    const res = await handleEval(
      makeRequest({ query: "test", mock: true }),
      deps(palace, "this should NOT be called when mock=true")
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.context_string).toContain("Some palace memory");
    expect(body.answer).toMatch(/mock|stub|skipped/i);
    expect(body.answer).not.toContain("should NOT be called");
    expect((body.retrieved_entities as unknown[]).length).toBe(1);
  });

  test("palace failure surfaces in warnings, error stays null", async () => {
    const palace = {
      search: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as PalaceClient;
    const res = await handleEval(
      makeRequest({ query: "test" }),
      deps(palace, "answer without context")
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.warnings).toContain("palace_unreachable");
    expect(body.retrieved_entities).toEqual([]);
    expect(body.error).toBeNull();
  });

  test("rejects missing query with 400", async () => {
    const palace = mockPalace([]);
    const res = await handleEval(makeRequest({}), deps(palace, ""));
    expect(res.status).toBe(400);
  });

  test("rejects non-JSON body with 400", async () => {
    const palace = mockPalace([]);
    const req = new Request("http://localhost/api/familiar/eval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    const res = await handleEval(req, deps(palace, ""));
    expect(res.status).toBe(400);
  });

  test("includes available_in_scope when palace returns it", async () => {
    const palace = mockPalace(
      [{ id: "d1", text: "x", wing: "w", room: "r", similarity: 0.5 }],
      4242
    );
    const res = await handleEval(
      makeRequest({ query: "test", mock: true }),
      deps(palace, "")
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.available_in_scope).toBe(4242);
  });

  test("retrieved entities carry provenance: { kind: 'observed' } in v0.2", async () => {
    const palace = mockPalace([
      { id: "drawer_a", text: "fact", wing: "w", room: "r", similarity: 0.7 },
    ]);
    const res = await handleEval(
      makeRequest({ query: "test", mock: true }),
      deps(palace, "")
    );
    const body = (await res.json()) as { retrieved_entities: Array<{ provenance?: { kind: string } }> };
    expect(body.retrieved_entities[0].provenance?.kind).toBe("observed");
  });
});
