import { test, expect, describe, mock } from "bun:test";
import { PalaceClient } from "../src/palace-client.ts";

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  });
}

describe("PalaceClient", () => {
  test("search passes query + limit + wing as query params and api key header", async () => {
    let captured: { url: string; headers: Headers } | null = null;
    const fetchMock = mockFetch((req) => {
      captured = { url: req.url, headers: req.headers };
      return new Response(JSON.stringify({
        query: "hello",
        total_before_filter: 12,
        available_in_scope: 1000,
        warnings: [],
        results: [{ text: "drawer content", wing: "realmwatch", room: "general", similarity: 0.85, distance: 0.15, matched_via: "drawer" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new PalaceClient({
      baseUrl: "http://katana:8085",
      apiKey: "test-key",
      searchTimeoutMs: 2000,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.search({ query: "hello", limit: 5, wing: "realmwatch" });

    expect(result.results.length).toBe(1);
    expect(result.available_in_scope).toBe(1000);
    expect(captured!.url).toContain("/search");
    expect(captured!.url).toContain("q=hello");
    expect(captured!.url).toContain("limit=5");
    expect(captured!.url).toContain("wing=realmwatch");
    expect(captured!.headers.get("x-api-key")).toBe("test-key");
  });

  test("search strips trailing punctuation from q (embedding-stability fix)", async () => {
    let captured = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "What is GraphPalace?", limit: 5 });
    // Trailing "?" stripped — observed dropping known-good hits out of top-K
    // due to nomic-embed-text v1.5 punctuation sensitivity.
    expect(captured).toContain("q=What+is+GraphPalace&");
    expect(captured).not.toContain("%3F");
  });

  test("search preserves internal punctuation (only trailing is stripped)", async () => {
    let captured = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "What's the difference, exactly?", limit: 5 });
    // Apostrophes and inner commas preserved — they carry semantic meaning
    expect(captured).toContain("What%27s+the+difference%2C+exactly");
    // But the trailing "?" still stripped
    expect(captured).not.toMatch(/exactly%3F/);
  });

  test("search without wing omits wing param", async () => {
    let captured: string = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "x", limit: 3 });
    expect(captured).not.toContain("wing=");
  });

  test("search does not pass a kind parameter (palace-daemon ignores it)", async () => {
    let captured: string = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "x", limit: 3 });
    expect(captured).not.toContain("kind=");
  });

  test("search throws on non-2xx response", async () => {
    const fetchMock = mockFetch(() => new Response("error", { status: 500 }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.search({ query: "x", limit: 5 })).rejects.toThrow(/500/);
  });

  test("search respects timeout", async () => {
    const fetchMock = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response("{}", { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 50, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.search({ query: "x", limit: 5 })).rejects.toThrow(/abort|timeout/i);
  });

  test("writeMemory posts drawer to /memory with api key", async () => {
    let captured: { body: string; headers: Headers } | null = null;
    const fetchMock = mockFetch(async (req) => {
      captured = { body: await req.text(), headers: req.headers };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "key", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.writeMemory({ content: "hello world", wing: "diary", room: "familiar" });
    expect(JSON.parse(captured!.body)).toEqual({ content: "hello world", wing: "diary", room: "familiar" });
    expect(captured!.headers.get("x-api-key")).toBe("key");
    // Forward-compat: pre-mempalace#86 daemons return shapes without warnings/errors;
    // the client defaults them to empty arrays.
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.id).toBe("");
  });

  test("writeMemory propagates warnings + errors + id from daemon (mempalace#86)", async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      id: "drawer_abc123",
      warnings: ["hnsw_index_pending"],
      errors: [],
    }), { status: 200 }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "key", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.writeMemory({ content: "x", wing: "w", room: "r" });
    expect(result.id).toBe("drawer_abc123");
    expect(result.warnings).toEqual(["hnsw_index_pending"]);
    expect(result.errors).toEqual([]);
  });

  test("silentSave defaults warnings + errors to [] on pre-mempalace#86 daemon", async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      count: 3,
      themes: ["session-checkpoint"],
      queued: false,
      entry_id: "drawer_xyz",
      systemMessage: "✦ flushed 3 entries",
    }), { status: 200 }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "key", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.silentSave({ session_id: "s1", wing: "familiar", entry: "x" });
    expect(result.count).toBe(3);
    expect(result.entry_id).toBe("drawer_xyz");
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("silentSave propagates warnings + errors when daemon ships them (mempalace#86)", async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({
      count: 5,
      themes: ["a"],
      queued: false,
      entry_id: "drawer_q",
      systemMessage: "✦ saved",
      warnings: ["embedder_fallback_used"],
      errors: ["graph_link_failed"],
    }), { status: 200 }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "key", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.silentSave({ session_id: "s1", wing: "familiar", entry: "x" });
    expect(result.warnings).toEqual(["embedder_fallback_used"]);
    expect(result.errors).toEqual(["graph_link_failed"]);
  });

  test("searchAgeFused posts to /search/age-fused with camel→snake body mapping", async () => {
    let captured: { url: string; body: string; method: string; headers: Headers } | null = null;
    const fetchMock = mockFetch(async (req) => {
      captured = { url: req.url, body: await req.text(), method: req.method, headers: req.headers };
      return new Response(JSON.stringify({
        query: "pgvector lock",
        available_in_scope: 200,
        warnings: [],
        results: [{ drawer_id: "ag1", text: "graph hit", wing: "memorypalace", room: "problems", similarity: 0.7, matched_via: "both" }],
        trace: { n_vector: 18, n_graph: 6, n_after_fusion: 8 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new PalaceClient({ baseUrl: "http://familiar:8085", apiKey: "k", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });

    const result = await client.searchAgeFused({
      query: "pgvector lock", limit: 8, wing: "memorypalace", room: "problems",
      graphTopK: 50, fusionK: 60, includeTrace: true,
    });

    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("/search/age-fused");
    expect(captured!.headers.get("x-api-key")).toBe("k");
    const sent = JSON.parse(captured!.body);
    expect(sent).toEqual({
      query: "pgvector lock", limit: 8, wing: "memorypalace", room: "problems",
      graph_top_k: 50, fusion_k: 60, include_trace: true,
    });
    // Daemon trace passes through; drawer_id normalized to id; matched_via preserved.
    expect(result.trace).toEqual({ n_vector: 18, n_graph: 6, n_after_fusion: 8 });
    expect(result.results[0].id).toBe("ag1");
    expect(result.results[0].matched_via).toBe("both");
  });

  test("searchAgeFused omits optional graph_top_k/fusion_k/include_trace when unset", async () => {
    let body = "";
    const fetchMock = mockFetch(async (req) => {
      body = await req.text();
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.searchAgeFused({ query: "x", limit: 5 });
    const sent = JSON.parse(body);
    expect(sent).toEqual({ query: "x", limit: 5 });
  });

  test("searchAgeFused strips trailing punctuation from query (embedding stability)", async () => {
    let body = "";
    const fetchMock = mockFetch(async (req) => {
      body = await req.text();
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.searchAgeFused({ query: "What is GraphPalace?", limit: 5 });
    expect(JSON.parse(body).query).toBe("What is GraphPalace");
  });

  test("searchAgeFused throws on non-2xx (so retrieveAndGround can fall back on 503)", async () => {
    const fetchMock = mockFetch(() => new Response("backend is chroma", { status: 503, statusText: "Service Unavailable" }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.searchAgeFused({ query: "x", limit: 5 })).rejects.toThrow(/503/);
  });

  test("searchAgeFused respects timeout", async () => {
    const fetchMock = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response("{}", { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 50, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.searchAgeFused({ query: "x", limit: 5 })).rejects.toThrow(/abort|timeout/i);
  });

  test("health returns parsed JSON", async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({ status: "ok", drawers: 165915 }), { status: 200 }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    const h = await client.health();
    expect(h.status).toBe("ok");
    expect(h.drawers).toBe(165915);
  });
});
