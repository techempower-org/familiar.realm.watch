import { test, expect, describe } from "bun:test";
import { handleEval, type EvalRouteDeps } from "../src/routes/eval.ts";
import type { PalaceClient } from "../src/palace-client.ts";
import type { Config, OllamaChatChunk, PalaceDrawer } from "../src/types.ts";

function mockPalace(drawers: PalaceDrawer[], availableInScope = drawers.length): PalaceClient {
  const result = {
    query: "",
    available_in_scope: availableInScope,
    results: drawers,
    warnings: [],
  };
  return {
    search: async () => result,
    searchHybrid: async () => result,
  } as unknown as PalaceClient;
}

function mockInference(answer: string): EvalRouteDeps["inference"] {
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

const baseCfg: Config = {
  port: 0,
  host: "",
  ollamaChat: { url: "", model: "" },
  ollamaEmbed: { url: "", model: "" },
  llamaCpp: { url: "", model: "" },
  palaceDaemon: { url: "", apiKey: "", searchTimeoutMs: 1000 },
  tokenBudget: { system: 1500, context: 4000, history: 2000, response: 512 },
  retrievalLimit: 5,
  sessionTtlMinutes: 60,
  realmSigilRealm: "fantasy",
  logLevel: "warn",
  slots: {
    registryPath: "/tmp/familiar-test-registry.json",
    configPath: "/tmp/familiar-test-slots.json",
    slotctlPath: "/tmp/familiar-test-slotctl",
    adminEnabled: false,
  },
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

describe("/api/familiar/eval — search_mode override (#88)", () => {
  test("?search_mode=age-fused routes through searchAgeFused and surfaces retrieval.n_graph", async () => {
    let ageFusedCalled = false;
    const palace = {
      search: async () => { throw new Error("vector should not be called"); },
      searchHybrid: async () => { throw new Error("hybrid should not be called"); },
      searchAgeFused: async () => {
        ageFusedCalled = true;
        return {
          query: "x", available_in_scope: 100, warnings: [],
          results: [{ id: "ag1", text: "graph hit", wing: "memorypalace", room: "problems", similarity: 0.7, matched_via: "both" }],
          trace: { n_vector: 18, n_graph: 6, n_after_fusion: 8 },
        };
      },
    } as unknown as PalaceClient;

    const req = new Request("http://localhost/api/familiar/eval?search_mode=age-fused", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "pgvector lock race", mock: true }),
    });
    const res = await handleEval(req, deps(palace, "stub"));
    const json = (await res.json()) as { retrieval?: { mode: string; n_graph: number } };

    expect(ageFusedCalled).toBe(true);
    expect(json.retrieval).toBeDefined();
    expect(json.retrieval!.mode).toBe("age-fused");
    expect(json.retrieval!.n_graph).toBe(6);
  });

  test("unknown ?search_mode= is ignored → default (hybrid) path runs", async () => {
    const palace = mockPalace([
      { id: "h1", text: "hybrid hit", wing: "w", room: "r", similarity: 0.8, matched_via: "drawer" },
    ]);
    const req = new Request("http://localhost/api/familiar/eval?search_mode=bogus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", mock: true }),
    });
    const res = await handleEval(req, deps(palace, "stub"));
    const json = (await res.json()) as { retrieved_entities: { id: string }[]; retrieval?: { mode: string } };
    expect(json.retrieved_entities.some((e) => e.id === "h1")).toBe(true);
    expect(json.retrieval!.mode).toBe("hybrid");
  });
});

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
      searchHybrid: async () => {
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

  // Issue #45 — wing-scope: when the request includes `wing`, the eval
  // route must thread it through `retrieveAndGround` to the palace search
  // call so the daemon scopes the query to that single wing.
  test("wing in request body is forwarded to palace.searchHybrid", async () => {
    let captured: { wing?: string; query?: string } | null = null;
    const palace = {
      search: async (opts: { wing?: string; query?: string }) => {
        captured = { wing: opts.wing, query: opts.query };
        return { query: "", results: [], warnings: [], available_in_scope: 0 };
      },
      searchHybrid: async (opts: { wing?: string; query?: string }) => {
        captured = { wing: opts.wing, query: opts.query };
        return { query: "", results: [], warnings: [], available_in_scope: 0 };
      },
    } as unknown as PalaceClient;
    const res = await handleEval(
      makeRequest({ query: "what is the design", wing: "familiar_realm_watch", mock: true }),
      deps(palace, "")
    );
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.wing).toBe("familiar_realm_watch");
  });

  test("omitted wing leaves palace search wing undefined (palace-wide query)", async () => {
    let captured: { wing?: string } | null = null;
    const palace = {
      search: async (opts: { wing?: string }) => {
        captured = { wing: opts.wing };
        return { query: "", results: [], warnings: [], available_in_scope: 0 };
      },
      searchHybrid: async (opts: { wing?: string }) => {
        captured = { wing: opts.wing };
        return { query: "", results: [], warnings: [], available_in_scope: 0 };
      },
    } as unknown as PalaceClient;
    const res = await handleEval(
      makeRequest({ query: "anything", mock: true }),
      deps(palace, "")
    );
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.wing).toBeUndefined();
  });

  test("wing scope is independent of vector vs hybrid fallback (vector path also gets it)", async () => {
    // Force the vector path by having hybrid 503 → silent fallback to /search.
    let hybridCaptured: { wing?: string } | null = null;
    let vectorCaptured: { wing?: string } | null = null;
    const palace = {
      search: async (opts: { wing?: string }) => {
        vectorCaptured = { wing: opts.wing };
        return { query: "", results: [], warnings: [], available_in_scope: 0 };
      },
      searchHybrid: async (opts: { wing?: string }) => {
        hybridCaptured = { wing: opts.wing };
        throw new Error("503 Service Unavailable");
      },
    } as unknown as PalaceClient;
    const res = await handleEval(
      makeRequest({ query: "test", wing: "realmwatch", mock: true }),
      deps(palace, "")
    );
    expect(res.status).toBe(200);
    expect(hybridCaptured!.wing).toBe("realmwatch");
    expect(vectorCaptured!.wing).toBe("realmwatch");
  });
});
