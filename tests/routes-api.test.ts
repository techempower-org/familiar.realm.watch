import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { handleModels } from "../src/routes/api.ts";

// Capture + control global fetch — handleModels calls fetch() against the
// configured upstream. We don't want to actually reach out to a real
// llama-server in unit tests.
let realFetch: typeof fetch;
function withFetch(fn: typeof fetch) {
  globalThis.fetch = fn;
}

describe("handleModels", () => {
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("returns prettified labels for llama-server /v1/models payload", async () => {
    // Shape captured from a real llama-server response — Phi-4 14B Q4_K_M.
    withFetch((async () => new Response(JSON.stringify({
      object: "list",
      data: [{
        id: "phi-4-Q4_K_M.gguf",
        object: "model",
        created: 1778928227,
        owned_by: "llamacpp",
        meta: {
          n_ctx: 4096,
          n_ctx_train: 16384,
          n_params: 14659507200,
          size: 8886743040,
        },
      }],
    }), { status: 200 })) as unknown as typeof fetch);

    const res = await handleModels(new Request("http://localhost/api/familiar/models"), {
      chatUpstreamUrl: "http://familiar:11434",
      defaultModel: "phi-4-Q4_K_M.gguf",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { default: string; models: Array<{ id: string; label: string; params_b: number; context: number; size_mb: number }> };
    expect(body.default).toBe("phi-4-Q4_K_M.gguf");
    expect(body.models).toHaveLength(1);
    const m = body.models[0];
    expect(m.id).toBe("phi-4-Q4_K_M.gguf");
    // Stem un-dashed, params + ctx surfaced. Exact format isn't load-bearing,
    // but we assert the three components are present so a regression that
    // drops one (e.g. ctx) gets caught.
    // un-dash but preserve quant underscores (Q4_K_M reads cleaner intact).
    expect(m.label).toContain("phi 4 Q4_K_M");
    expect(m.label).toContain("14.7B");
    expect(m.label).toContain("4k ctx");
    expect(m.params_b).toBeCloseTo(14.7, 1);
    expect(m.context).toBe(4096);
    expect(m.size_mb).toBeGreaterThan(8000);
  });

  test("falls back to default model on upstream error", async () => {
    withFetch((async () => new Response("upstream down", { status: 502 })) as unknown as typeof fetch);
    const res = await handleModels(new Request("http://localhost/api/familiar/models"), {
      chatUpstreamUrl: "http://familiar:11434",
      defaultModel: "some-default",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { default: string; models: unknown[]; error?: string };
    expect(body.default).toBe("some-default");
    expect(body.models).toEqual([]);
    expect(body.error).toMatch(/upstream 502/);
  });

  test("survives transport error (timeout / connection refused)", async () => {
    withFetch((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    const res = await handleModels(new Request("http://localhost/api/familiar/models"), {
      chatUpstreamUrl: "http://familiar:11434",
      defaultModel: "fallback",
    });
    // Note: we deliberately return 200 with empty models + error string. The
    // picker treats this as "(unavailable)" — better UX than a 5xx that the
    // user can't act on. Upstream health is visible in /api/familiar/health.
    expect(res.status).toBe(200);
    const body = await res.json() as { default: string; models: unknown[]; error?: string };
    expect(body.default).toBe("fallback");
    expect(body.error).toMatch(/ECONNREFUSED/);
  });
});
