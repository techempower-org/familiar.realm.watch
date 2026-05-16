import { test, expect, describe } from "bun:test";
import { getHealth, type HealthDeps } from "../src/health.ts";
import type { PalaceClient } from "../src/palace-client.ts";
import type { CircuitBreaker } from "../src/circuit-breaker.ts";
import type { SigilInfo } from "../src/sigil.ts";

const SIGIL: SigilInfo = {
  name: "familiar-realm-watch",
  description: "test",
  version: "Test Sigil · deadbeef",
  pkg_version: "0.2.0",
  realm: "fantasy",
  word: "sigil",
  hash: "deadbeef",
  branch: "main",
  dirty: false,
  built: "2026-04-26T00:00:00Z",
  repo: null,
  commit_url: "https://github.com/techempower-org/familiar.realm.watch/commit/deadbeef",
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

  test("daemon-unreachable reports degraded with the daemon's own error", async () => {
    // Both /health and /search throw. The daemon-down error wins as the
    // top-level error since it's the more fundamental failure.
    const r = await getHealth(deps(mockPalace({ healthThrows: true, searchThrows: true })));
    expect(r.dependencies.palace_daemon.status).toBe("degraded");
    expect(r.dependencies.palace_daemon.error).toContain("ECONNREFUSED");
    expect(r.dependencies.palace_daemon.recall_quality).toBe("probe_error");
  });

  test("daemon /health ok but /search times out → recall: probe_error (likely rebuild in progress)", async () => {
    // This is the operationally important case — daemon is up, but a heavy
    // rebuild is holding the read semaphore so /search hangs. The report
    // says degraded with a specific 'recall probe failed' message, distinct
    // from 'HNSW empty' which would indicate a different (rebuild-needed) state.
    const r = await getHealth(deps(mockPalace({ searchThrows: true })));
    expect(r.dependencies.palace_daemon.status).toBe("degraded");
    expect(r.dependencies.palace_daemon.recall_quality).toBe("probe_error");
    expect(r.dependencies.palace_daemon.error).toMatch(/recall probe failed/i);
    expect(r.dependencies.palace_daemon.recall_warning).toContain("search probe failed");
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

  test("probes /v1/models, not Ollama-native /api/tags", async () => {
    // Regression: pre-2026-05-15 this hardcoded /api/tags, which 404s on
    // llama-server. Stuck the health route at "degraded" even when both
    // backends were fine.
    const probed: string[] = [];
    const trackingFetch: typeof fetch = ((url: string) => {
      probed.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as never;
    const d = { ...deps(mockPalace({})), fetch: trackingFetch };
    await getHealth(d);
    expect(probed).toContain("http://chat/v1/models");
    expect(probed).toContain("http://embed/v1/models");
    expect(probed.some(u => u.includes("/api/tags"))).toBe(false);
  });
});

// ── Functional probes (#186) ──────────────────────────────────────────

import { voice } from "../src/lang/familiar-voice.ts";
import type { InferenceChatProvider, OllamaChatChunk } from "../src/types.ts";

function makeInference(tokens: string[]): InferenceChatProvider {
  return {
    isHealthy: async () => true,
    chatStream: async function* (): AsyncGenerator<OllamaChatChunk> {
      for (const t of tokens) {
        yield {
          message: { role: "assistant", content: t },
          done: false,
        } as OllamaChatChunk;
      }
      yield {
        message: { role: "assistant", content: "" },
        done: true,
      } as OllamaChatChunk;
    },
  };
}

function makeEmbed(vec: number[]) {
  return { embed: async () => vec };
}

describe("getHealth — functional probes (#186)", () => {
  test("chat probe ok when inference returns non-fallback tokens", async () => {
    const d: HealthDeps = {
      ...deps(mockPalace({})),
      chatModel: "phi-4",
      embedModel: "nomic-embed",
      inference: makeInference(["Hello", "!"]),
      ollamaEmbed: makeEmbed([0.1, 0.2, 0.3]) as never,
    };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_chat.chat_quality).toBe("ok");
    expect(r.dependencies.ollama_chat.status).toBe("ok");
    expect(r.dependencies.ollama_embed.embed_quality).toBe("ok");
  });

  test("chat probe fallback when inference returns the chatFalters string", async () => {
    // Simulates 2026-05-16: env says gemma3:4b but only phi-4 loaded.
    // InferenceRouter exhausted all providers; chat route returned
    // voice.chatFalters. The probe must detect this and mark the dep
    // degraded so status.realm.watch + 503-on-degraded fire.
    const d: HealthDeps = {
      ...deps(mockPalace({})),
      chatModel: "phi-4",
      inference: makeInference([voice.chatFalters]),
    };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_chat.chat_quality).toBe("fallback");
    expect(r.dependencies.ollama_chat.status).toBe("degraded");
    expect(r.dependencies.ollama_chat.error).toMatch(/chatFalters fallback/i);
  });

  test("chat probe probe_error when inference throws", async () => {
    const failingInference: InferenceChatProvider = {
      isHealthy: async () => false,
      chatStream: async function* () {
        throw new Error("all inference endpoints failed");
        yield {} as never;
      },
    };
    const d: HealthDeps = {
      ...deps(mockPalace({})),
      chatModel: "phi-4",
      inference: failingInference,
    };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_chat.chat_quality).toBe("probe_error");
    expect(r.dependencies.ollama_chat.status).toBe("degraded");
    expect(r.dependencies.ollama_chat.error).toMatch(/chat probe failed/i);
  });

  test("chat probe probe_error when inference returns nothing", async () => {
    const d: HealthDeps = {
      ...deps(mockPalace({})),
      chatModel: "phi-4",
      inference: makeInference([""]),
    };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_chat.chat_quality).toBe("probe_error");
    expect(r.dependencies.ollama_chat.chat_warning).toMatch(/no tokens/i);
  });

  test("embed probe ok when embed returns a non-empty vector", async () => {
    const d: HealthDeps = {
      ...deps(mockPalace({})),
      embedModel: "nomic-embed",
      ollamaEmbed: makeEmbed([0.5, 0.6, 0.7, 0.8]) as never,
    };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_embed.embed_quality).toBe("ok");
    expect(r.dependencies.ollama_embed.status).toBe("ok");
  });

  test("embed probe probe_error when embed returns empty vector", async () => {
    const d: HealthDeps = {
      ...deps(mockPalace({})),
      embedModel: "nomic-embed",
      ollamaEmbed: makeEmbed([]) as never,
    };
    const r = await getHealth(d);
    expect(r.dependencies.ollama_embed.embed_quality).toBe("probe_error");
    expect(r.dependencies.ollama_embed.status).toBe("degraded");
  });

  test("probes skip when deps are absent — legacy /v1/models only", async () => {
    // Backward compat: when chatModel/inference/embedModel/ollamaEmbed
    // are omitted, only the dial-tone /v1/models check runs (as before).
    const r = await getHealth(deps(mockPalace({})));
    expect(r.dependencies.ollama_chat.chat_quality).toBeUndefined();
    expect(r.dependencies.ollama_embed.embed_quality).toBeUndefined();
    expect(r.dependencies.ollama_chat.status).toBe("ok");
  });
});
