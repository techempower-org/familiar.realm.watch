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

  test("search defaults kind=content (filters Stop-hook checkpoint noise)", async () => {
    let captured: string = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "x", limit: 3 });
    expect(captured).toContain("kind=content");
  });

  test("search passes explicit kind=checkpoint when requested", async () => {
    let captured: string = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "x", limit: 3, kind: "checkpoint" });
    expect(captured).toContain("kind=checkpoint");
    expect(captured).not.toContain("kind=content");
  });

  test("search passes explicit kind=all when requested", async () => {
    let captured: string = "";
    const fetchMock = mockFetch((req) => {
      captured = req.url;
      return new Response(JSON.stringify({ query: "x", results: [] }), { status: 200 });
    });
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    await client.search({ query: "x", limit: 3, kind: "all" });
    expect(captured).toContain("kind=all");
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
    await client.writeMemory({ content: "hello world", wing: "diary", room: "familiar" });
    expect(JSON.parse(captured!.body)).toEqual({ content: "hello world", wing: "diary", room: "familiar" });
    expect(captured!.headers.get("x-api-key")).toBe("key");
  });

  test("health returns parsed JSON", async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({ status: "ok", drawers: 165915 }), { status: 200 }));
    const client = new PalaceClient({ baseUrl: "http://k:8085", apiKey: "", searchTimeoutMs: 2000, fetch: fetchMock as unknown as typeof fetch });
    const h = await client.health();
    expect(h.status).toBe("ok");
    expect(h.drawers).toBe(165915);
  });
});
