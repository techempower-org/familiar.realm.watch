import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { handleSlotsGet, handleSlotPatch } from "../src/routes/admin-slots.ts";
import { SlotResolver } from "../src/slots/resolver.ts";
import { FakeSlotctl } from "../src/slots/slotctl.ts";
import type { Config } from "../src/types.ts";

let tmpRoot: string;

function makeCfg(adminEnabled = true): Config {
  return {
    port: 0, host: "",
    ollamaChat: { url: "", model: "" }, ollamaEmbed: { url: "", model: "" },
    llamaCpp: { url: "", model: "" },
    palaceDaemon: { url: "", apiKey: "", searchTimeoutMs: 1000 },
    tokenBudget: { system: 1, context: 1, history: 1, response: 1 },
    retrievalLimit: 5, sessionTtlMinutes: 60, realmSigilRealm: "test", logLevel: "warn",
    slots: {
      registryPath: join(tmpRoot, "registry.json"),
      configPath: join(tmpRoot, "slots.json"),
      slotctlPath: "/no/such/path",
      adminEnabled,
    },
  };
}

const REGISTRY = {
  schema_version: 1,
  gpu_total_mb: { "0": 10240, "1": 10240 },
  variants: [
    { id: "chat-a", label: "A", model: "m-a", runtime: "llama-cpp", unit: "chat-a.service", url: "http://localhost:1", gpu: 0, vram_mb: 4000, capabilities: ["chat"] },
    { id: "chat-b", label: "B", model: "m-b", runtime: "ollama", unit: "chat-b.service", url: "http://localhost:2", gpu: 1, vram_mb: 4000, capabilities: ["chat"] },
    { id: "chat-huge", label: "Huge", model: "m-h", runtime: "llama-cpp", unit: "chat-huge.service", url: "http://localhost:9", gpu: 0, vram_mb: 9900, capabilities: ["chat"] },
    { id: "embed-x", label: "Embed", model: "m-e", runtime: "ollama", unit: "embed-x.service", url: "http://localhost:3", gpu: 1, vram_mb: 350, capabilities: ["embed"] },
  ],
};

const INITIAL_SLOTS = {
  schema_version: 1, updated_at: "2026-05-28T00:00:00Z",
  slots: {
    chat: { variant_id: "chat-a" },
    embed: { variant_id: "embed-x" },
    extract: { variant_id: null },
    hyde: { variant_id: null },
    reflect: { variant_id: null },
  },
};

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "familiar-admin-slots-test-"));
  await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY));
  await writeFile(join(tmpRoot, "slots.json"), JSON.stringify(INITIAL_SLOTS));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeFetch(behavior: "healthy" | "down" = "healthy"): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (behavior === "healthy") {
      return new Response("ok", { status: 200 });
    }
    return new Response("nope", { status: 502 });
  }) as typeof fetch;
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/familiar/admin/slots/chat", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/familiar/slots", () => {
  test("returns snapshot with registry + slots + gpu_usage", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const res = await handleSlotsGet(
      new Request("http://x/api/familiar/slots"),
      { cfg, resolver, slotctl: new FakeSlotctl() },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.registry).toBeDefined();
    expect(body.slots).toBeDefined();
    expect(body.gpu_usage).toBeDefined();
    expect(Array.isArray(body.gpu_usage)).toBe(true);
  });
});

describe("PATCH validation", () => {
  test("403 when admin disabled", async () => {
    const cfg = makeCfg(false);
    const resolver = new SlotResolver(cfg);
    const res = await handleSlotPatch(
      makeRequest({ variant_id: "chat-b" }),
      "chat",
      { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() },
    );
    expect(res.status).toBe(403);
  });

  test("400 on invalid slot name", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const res = await handleSlotPatch(
      makeRequest({ variant_id: "chat-b" }),
      "notaslot",
      { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() },
    );
    expect(res.status).toBe(400);
  });

  test("400 on non-JSON body", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const req = new Request("http://x/api/familiar/admin/slots/chat", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: "not json",
    });
    const res = await handleSlotPatch(req, "chat", { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() });
    expect(res.status).toBe(400);
  });

  test("400 on variant_id missing or wrong type", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const res = await handleSlotPatch(
      makeRequest({ variant_id: 42 }),
      "chat",
      { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() },
    );
    expect(res.status).toBe(400);
  });

  test("400 when required slot set to null", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const res = await handleSlotPatch(
      makeRequest({ variant_id: null }),
      "chat",
      { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() },
    );
    expect(res.status).toBe(400);
  });

  test("400 on unknown variant_id", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const res = await handleSlotPatch(
      makeRequest({ variant_id: "does-not-exist" }),
      "chat",
      { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() },
    );
    expect(res.status).toBe(400);
  });

  test("400 on capability mismatch", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    // chat-a does NOT have 'embed' capability
    const req = new Request("http://x/api/familiar/admin/slots/embed", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ variant_id: "chat-a" }),
    });
    const res = await handleSlotPatch(req, "embed", { cfg, resolver, slotctl: new FakeSlotctl(), fetchFn: makeFetch() });
    expect(res.status).toBe(400);
  });

  test("409 on VRAM overflow", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    // chat-huge (9900) + existing chat-a on GPU0 would be the swap — we
    // PATCH chat to chat-huge which alone is 9900 MB, > 0.92×10240 = 9420.
    const res = await handleSlotPatch(
      makeRequest({ variant_id: "chat-huge" }),
      "chat",
      { cfg, resolver, slotctl: new FakeSlotctl(["chat-a.service", "embed-x.service"]), fetchFn: makeFetch() },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.gpu).toBe("0");
  });
});

describe("PATCH happy path", () => {
  test("stops the outgoing unit, starts the incoming, writes slots.json, returns 200", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const slotctl = new FakeSlotctl(["chat-a.service", "embed-x.service"]);
    const res = await handleSlotPatch(
      makeRequest({ variant_id: "chat-b" }),
      "chat",
      { cfg, resolver, slotctl, fetchFn: makeFetch("healthy") },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.stopped_units).toContain("chat-a.service");
    expect(body.started_units).toContain("chat-b.service");
    // slotctl was called in the right sequence.
    const actions = slotctl.calls.map((c) => `${c.action}:${c.unit}`);
    expect(actions).toContain("stop:chat-a.service");
    expect(actions).toContain("start:chat-b.service");
    // slots.json got written with the new binding.
    const fresh = new SlotResolver(makeCfg());
    const after = await fresh.readSlots();
    expect(after.slots.chat.variant_id).toBe("chat-b");
  });
});

describe("PATCH rollback on health-check failure", () => {
  test("stops the just-started unit, restarts the previous, leaves slots.json unchanged, returns 503", async () => {
    const cfg = makeCfg();
    const resolver = new SlotResolver(cfg);
    const slotctl = new FakeSlotctl(["chat-a.service", "embed-x.service"]);

    // Mock fetch to never return healthy — health-check loop will time out.
    // To avoid waiting 30s in test, override HEALTH_POLL_TIMEOUT_MS? Easier:
    // mock fetch to throw immediately, the poll loop just retries until deadline.
    // Actually for the test we need a faster path — let's mock fetch to return
    // 502 every call. The poll will exit when it hits its deadline.
    // We accept ~30s test duration for this OR truncate by making the resolver
    // not poll. The cleanest fix: PATCH's waitHealthy is bounded by Date.now() —
    // we'd need a clock injection. For now, mark this test as slower-but-correct:
    // the timeout in the route is 30s. Bun's default test timeout is 5s.
    // → Bump this test's timeout. The behavior under test is the revert flow,
    // not the speed of the timeout.
    const res = await handleSlotPatch(
      makeRequest({ variant_id: "chat-b" }),
      "chat",
      { cfg, resolver, slotctl, fetchFn: makeFetch("down") },
    );
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.reverted).toBe(true);
    expect(body.variant_id).toBe("chat-b");
    // slots.json was NOT updated.
    const fresh = new SlotResolver(makeCfg());
    const after = await fresh.readSlots();
    expect(after.slots.chat.variant_id).toBe("chat-a"); // unchanged
    // Revert sequence: started chat-b, then on failure stopped it + restarted chat-a.
    const actions = slotctl.calls.map((c) => `${c.action}:${c.unit}`);
    expect(actions).toContain("start:chat-b.service");
    expect(actions).toContain("stop:chat-b.service");
    expect(actions).toContain("start:chat-a.service");
  }, 60_000);
});
