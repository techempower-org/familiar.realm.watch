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

  test("searchAgeFused POSTs to /search/age-fused with body + api key, normalizes drawer_id", async () => {
    let captured: { url: string; method: string; body: string; headers: Headers } | null = null;
    const fetchMock = mockFetch(async (req) => {
      captured = { url: req.url, method: req.method, body: await req.text(), headers: req.headers };
      // age-fused envelope: results use drawer_id, no top-level available_in_scope/warnings.
      return new Response(JSON.stringify({
        results: [{ drawer_id: "drawer_abc", text: "kg-enriched result", wing: "familiar", room: "discoveries", similarity: 0.61, matched_via: "vector", rrf_score: 0.0166 }],
        rerank: { enabled: true, model: "ms-marco-TinyBERT-L-2-v2" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new PalaceClient({
      baseUrl: "http://katana:8085",
      apiKey: "test-key",
      searchTimeoutMs: 2000,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.searchAgeFused({ query: "what does JP work on", limit: 5, wing: "familiar" });

    expect(captured!.url).toContain("/search/age-fused");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers.get("x-api-key")).toBe("test-key");
    const body = JSON.parse(captured!.body);
    expect(body.query).toBe("what does JP work on");
    expect(body.limit).toBe(5);
    expect(body.wing).toBe("familiar");
    // normalizeResults maps the daemon's drawer_id onto the canonical id field.
    expect(result.results[0].id).toBe("drawer_abc");
    // Lean envelope: no available_in_scope/warnings → undefined / [] downstream.
    expect(result.available_in_scope).toBeUndefined();
  });

  test("searchAgeFused strips trailing punctuation and forwards optional knobs", async () => {
    let body: Record<string, unknown> = {};
    const fetchMock = mockFetch(async (req) => {
      body = JSON.parse(await req.text());
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.searchAgeFused({ query: "what is GraphPalace?", limit: 3, room: "decisions", graphTopK: 80, fusionK: 40, includeTrace: true, rerank: false });
    // Trailing "?" stripped (nomic-embed-text v1.5 punctuation sensitivity).
    expect(body.query).toBe("what is GraphPalace");
    expect(body.room).toBe("decisions");
    expect(body.graph_top_k).toBe(80);
    expect(body.fusion_k).toBe(40);
    expect(body.include_trace).toBe(true);
    expect(body.rerank).toBe(false);
  });

  test("searchAgeFused applies HyDE concat when a generator is provided", async () => {
    let body: Record<string, unknown> = {};
    const fetchMock = mockFetch(async (req) => {
      body = JSON.parse(await req.text());
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.searchAgeFused({ query: "razer kiyo firmware", limit: 3, hydeGenerate: async (q) => `hypothetical doc about ${q}` });
    expect(body.query as string).toContain("razer kiyo firmware");
    expect(body.query as string).toContain("hypothetical doc about razer kiyo firmware");
  });

  test("searchAgeFused HyDE failure is non-fatal — literal query stands", async () => {
    let body: Record<string, unknown> = {};
    const fetchMock = mockFetch(async (req) => {
      body = JSON.parse(await req.text());
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.searchAgeFused({ query: "kiyo flash", limit: 3, hydeGenerate: async () => { throw new Error("hyde model down"); } });
    expect(body.query).toBe("kiyo flash");
  });

  test("searchAgeFused throws on non-2xx (caller falls back to vector)", async () => {
    const fetchMock = mockFetch(() => new Response("nope", { status: 404, statusText: "Not Found" }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.searchAgeFused({ query: "x", limit: 5 })).rejects.toThrow(/404/);
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
