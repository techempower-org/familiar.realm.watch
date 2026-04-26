import { test, expect, describe, beforeEach } from "bun:test";
import { handleGraph, _resetGraphCache, type GraphRouteDeps } from "../src/routes/graph.ts";
import type { PalaceClient } from "../src/palace-client.ts";
import type { PalaceGraph } from "../src/types.ts";

const SAMPLE_GRAPH: PalaceGraph = {
  wings: { realmwatch: 12, personal: 7 },
  rooms: [
    { wing: "realmwatch", rooms: { gatekeeper: 5, ubox0: 7 } },
    { wing: "personal", rooms: { hobbies: 4, work: 3 } },
  ],
  tunnels: [{ room: "tools", wings: ["realmwatch", "personal"] }],
  kg_entities: [
    { id: "ent_1", name: "JP", type: "person", properties: { primary: true } },
  ],
  kg_triples: [
    { subject: "ent_1", predicate: "owns", object: "ent_repo", confidence: 0.95 },
  ],
  kg_stats: { entities: 1, triples: 1 },
};

function mockPalace(opts: { graph?: PalaceGraph; throws?: Error; calls?: { n: number } } = {}): PalaceClient {
  return {
    getGraph: async () => {
      if (opts.calls) opts.calls.n++;
      if (opts.throws) throw opts.throws;
      return opts.graph ?? SAMPLE_GRAPH;
    },
  } as unknown as PalaceClient;
}

function req(): Request {
  return new Request("http://localhost/api/familiar/graph", { method: "GET" });
}

beforeEach(() => {
  _resetGraphCache();
});

describe("/api/familiar/graph", () => {
  test("returns palace graph JSON with x-graph-cache: miss on first call", async () => {
    const calls = { n: 0 };
    const palace = mockPalace({ calls });
    const res = await handleGraph(req(), { palace });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-graph-cache")).toBe("miss");
    const body = (await res.json()) as PalaceGraph;
    expect(body.wings.realmwatch).toBe(12);
    expect(body.kg_stats.entities).toBe(1);
    expect(calls.n).toBe(1);
  });

  test("cache hit on second call within TTL — does not re-query daemon", async () => {
    let now = 1_000_000;
    const calls = { n: 0 };
    const palace = mockPalace({ calls });
    const deps: GraphRouteDeps = { palace, cacheTtlMs: 30_000, now: () => now };

    await handleGraph(req(), deps);  // miss
    now += 10_000;                     // 10s later, well within 30s TTL
    const res2 = await handleGraph(req(), deps);

    expect(res2.headers.get("x-graph-cache")).toBe("hit");
    expect(res2.headers.get("x-graph-age-ms")).toBe("10000");
    expect(calls.n).toBe(1);  // only the first call hit the daemon
  });

  test("cache miss after TTL expires — re-queries daemon", async () => {
    let now = 1_000_000;
    const calls = { n: 0 };
    const palace = mockPalace({ calls });
    const deps: GraphRouteDeps = { palace, cacheTtlMs: 30_000, now: () => now };

    await handleGraph(req(), deps);
    now += 35_000;  // past TTL
    const res2 = await handleGraph(req(), deps);

    expect(res2.headers.get("x-graph-cache")).toBe("miss");
    expect(calls.n).toBe(2);
  });

  test("502 when palace-daemon is unreachable; does NOT poison cache", async () => {
    const palace = mockPalace({ throws: new Error("ECONNREFUSED") });
    const res = await handleGraph(req(), { palace });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ECONNREFUSED");

    // Subsequent successful call must NOT be a hit on a failed cache entry
    const palace2 = mockPalace();
    const res2 = await handleGraph(req(), { palace: palace2 });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-graph-cache")).toBe("miss");
  });

  test("default TTL is 300_000 ms (5 min) when not specified", async () => {
    let now = 1_000_000;
    const calls = { n: 0 };
    const palace = mockPalace({ calls });
    const deps: GraphRouteDeps = { palace, now: () => now };

    await handleGraph(req(), deps);
    now += 299_999;  // just under 5 min
    const res2 = await handleGraph(req(), deps);
    expect(res2.headers.get("x-graph-cache")).toBe("hit");
    expect(calls.n).toBe(1);

    now += 2;  // total elapsed = 300_001
    const res3 = await handleGraph(req(), deps);
    expect(res3.headers.get("x-graph-cache")).toBe("miss");
    expect(calls.n).toBe(2);
  });
});
