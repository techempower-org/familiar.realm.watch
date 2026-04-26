import { test, expect, describe } from "bun:test";
import { getHealth, type HealthDeps } from "../src/health.ts";
import type { PalaceClient } from "../src/palace-client.ts";
import type { CircuitBreaker } from "../src/circuit-breaker.ts";
import type { SigilInfo } from "../src/sigil.ts";

const SIGIL: SigilInfo = {
  name: "familiar-realm-watch",
  description: "test",
  version: "0.2.0",
  realm: "fantasy",
  word: "test",
  hash: "",
  branch: "",
  dirty: false,
  built: "2026-04-26T00:00:00Z",
  repo: null,
};

const okBreaker = (): CircuitBreaker => ({
  state: () => "closed",
} as unknown as CircuitBreaker);

const okFetch: typeof fetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as never;

function mockPalace(opts: { searchWarnings?: string[]; healthThrows?: boolean; searchThrows?: boolean }): PalaceClient {
  return {
    health: async () => {
      if (opts.healthThrows) throw new Error("ECONNREFUSED");
      return { status: "ok" };
    },
    search: async () => {
      if (opts.searchThrows) throw new Error("search failed");
      return {
        query: "_health_probe",
        available_in_scope: 100,
        warnings: opts.searchWarnings ?? [],
        results: [],
      };
    },
  } as unknown as PalaceClient;
}

function deps(palace: PalaceClient): HealthDeps {
  return {
    palace,
    ollamaChatUrl: "http://chat",
    ollamaEmbedUrl: "http://embed",
    breakers: { palace: okBreaker(), ollamaChat: okBreaker(), ollamaEmbed: okBreaker() },
    sigil: SIGIL,
    fetch: okFetch,
  };
}

describe("getHealth", () => {
  test("all-ok report when palace + recall + ollamas are healthy", async () => {
    const r = await getHealth(deps(mockPalace({ searchWarnings: [] })));
    expect(r.dependencies.palace_daemon.status).toBe("ok");
    expect(r.dependencies.palace_daemon.recall_quality).toBe("ok");
    expect(r.dependencies.palace_daemon.recall_warning).toBeUndefined();
    expect(r.dependencies.ollama_chat.status).toBe("ok");
    expect(r.dependencies.ollama_embed.status).toBe("ok");
  });

  test("flags HNSW empty when /search returns 'vector ranked 0' warning", async () => {
    const warning = "151478 drawers match this scope in sqlite; vector ranked 0 — the rest are only reachable by keyword match. Run `mempalace repair` to rebuild the HNSW index for full semantic recall.";
    const r = await getHealth(deps(mockPalace({ searchWarnings: [warning] })));
    expect(r.dependencies.palace_daemon.status).toBe("degraded");
    expect(r.dependencies.palace_daemon.recall_quality).toBe("empty_hnsw");
    expect(r.dependencies.palace_daemon.recall_warning).toContain("vector ranked 0");
    expect(r.dependencies.palace_daemon.error).toContain("HNSW index empty");
  });

  test("flags HNSW empty when warning says 'vector ranked 1' (still effectively broken)", async () => {
    const warning = "151478 drawers; vector ranked 1 — keyword fallback only.";
    const r = await getHealth(deps(mockPalace({ searchWarnings: [warning] })));
    expect(r.dependencies.palace_daemon.recall_quality).toBe("empty_hnsw");
    expect(r.dependencies.palace_daemon.status).toBe("degraded");
  });

  test("does NOT flag empty_hnsw on unrelated warnings (e.g. 'vector ranked 100')", async () => {
    const warning = "vector ranked 100 results returned; legacy distance metric in use";
    const r = await getHealth(deps(mockPalace({ searchWarnings: [warning] })));
    expect(r.dependencies.palace_daemon.recall_quality).toBe("ok");
    expect(r.dependencies.palace_daemon.status).toBe("ok");
  });

  test("daemon-unreachable still reports degraded; recall left as ok (probe falls through)", async () => {
    const r = await getHealth(deps(mockPalace({ healthThrows: true })));
    expect(r.dependencies.palace_daemon.status).toBe("degraded");
    expect(r.dependencies.palace_daemon.error).toContain("ECONNREFUSED");
    // Search probe also throws, but recall_quality defaults to "ok" rather
    // than confusing two different failure modes.
    expect(r.dependencies.palace_daemon.recall_quality).toBe("ok");
  });

  test("search probe failure doesn't break overall health", async () => {
    const r = await getHealth(deps(mockPalace({ searchThrows: true })));
    // Daemon /health succeeded, /search failed — overall stays ok-but-recall-unknown.
    expect(r.dependencies.palace_daemon.status).toBe("ok");
    expect(r.dependencies.palace_daemon.recall_quality).toBe("ok");
  });

  test("includes circuit breaker states", async () => {
    const r = await getHealth(deps(mockPalace({})));
    expect(r.circuit_breakers.palace_daemon).toBe("closed");
    expect(r.circuit_breakers.ollama_chat).toBe("closed");
    expect(r.circuit_breakers.ollama_embed).toBe("closed");
  });

  test("ollama chat unreachable surfaces as degraded", async () => {
    const failChat: typeof fetch = ((url: string) =>
      url.includes("chat")
        ? Promise.resolve(new Response("", { status: 500 }))
        : Promise.resolve(new Response("{}", { status: 200 }))) as never;
    const d = { ...deps(mockPalace({})), fetch: failChat };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_chat.status).toBe("degraded");
    expect(r.dependencies.ollama_embed.status).toBe("ok");
  });
});
