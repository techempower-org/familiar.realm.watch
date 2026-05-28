import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SlotResolver, SlotsLoadError } from "../src/slots/resolver.ts";
import { RegistryLoadError } from "../src/slots/registry.ts";
import type { Config } from "../src/types.ts";

let tmpRoot: string;

function makeCfg(): Config {
  return {
    port: 0, host: "",
    ollamaChat: { url: "", model: "" },
    ollamaEmbed: { url: "", model: "" },
    llamaCpp: { url: "", model: "" },
    palaceDaemon: { url: "", apiKey: "", searchTimeoutMs: 1000 },
    tokenBudget: { system: 1, context: 1, history: 1, response: 1 },
    retrievalLimit: 5, sessionTtlMinutes: 60, realmSigilRealm: "test", logLevel: "warn",
    slots: {
      registryPath: join(tmpRoot, "registry.json"),
      configPath: join(tmpRoot, "slots.json"),
      slotctlPath: "/no/such/path",
      adminEnabled: false,
    },
  };
}

const REGISTRY_CONTENT = {
  schema_version: 1,
  gpu_total_mb: { "0": 10240, "1": 10240 },
  variants: [
    { id: "chat-a", label: "A", model: "m-a", runtime: "llama-cpp", unit: "chat-a.service", url: "http://a", gpu: 0, vram_mb: 4000, capabilities: ["chat", "hyde", "reflect"] },
    { id: "chat-b", label: "B", model: "m-b", runtime: "ollama", unit: "chat-b.service", url: "http://b", gpu: 1, vram_mb: 4000, capabilities: ["chat"] },
    { id: "embed-x", label: "Embed", model: "m-e", runtime: "ollama", unit: "embed.service", url: "http://e", gpu: 1, vram_mb: 350, capabilities: ["embed"] },
    { id: "extract-x", label: "Extract", model: "m-x", runtime: "llama-cpp", unit: "extract.service", url: "http://x", gpu: 0, vram_mb: 5000, capabilities: ["extract"] },
  ],
};

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "familiar-slots-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("SlotResolver.readSlots", () => {
  test("returns empty defaults when slots.json doesn't exist", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    const s = await r.readSlots();
    for (const slot of ["chat", "embed", "extract", "hyde", "reflect"] as const) {
      expect(s.slots[slot].variant_id).toBeNull();
    }
  });

  test("reads valid slots.json and parses it", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1,
        updated_at: "2026-05-28T00:00:00Z",
        slots: {
          chat: { variant_id: "chat-a" },
          embed: { variant_id: "embed-x" },
          extract: { variant_id: null },
          hyde: { variant_id: null },
          reflect: { variant_id: null },
        },
      }),
    );
    const r = new SlotResolver(makeCfg());
    const s = await r.readSlots();
    expect(s.slots.chat.variant_id).toBe("chat-a");
    expect(s.slots.embed.variant_id).toBe("embed-x");
  });

  test("throws SlotsLoadError on malformed slots.json", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(join(tmpRoot, "slots.json"), "not json at all");
    const r = new SlotResolver(makeCfg());
    let caught: unknown = null;
    try { await r.readSlots(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SlotsLoadError);
  });

  test("mtime cache returns same object on rapid re-reads", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "2026-05-28T00:00:00Z",
        slots: { chat: { variant_id: "chat-a" }, embed: { variant_id: null }, extract: { variant_id: null }, hyde: { variant_id: null }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    const a = await r.readSlots();
    const b = await r.readSlots();
    expect(a).toBe(b); // same reference inside the cache window
  });
});

describe("SlotResolver.writeSlots (atomic)", () => {
  test("persists to disk and leaves no .tmp files behind", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    const next = {
      schema_version: 1 as const,
      updated_at: "2026-05-28T00:00:00Z",
      slots: {
        chat: { variant_id: "chat-a" },
        embed: { variant_id: null },
        extract: { variant_id: null },
        hyde: { variant_id: null },
        reflect: { variant_id: null },
      },
    };
    await r.writeSlots(next);
    const text = await readFile(join(tmpRoot, "slots.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.slots.chat.variant_id).toBe("chat-a");
    // Atomic rename — no .tmp files survive.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmpRoot);
    expect(entries.filter((f) => f.startsWith("slots.json.tmp"))).toEqual([]);
  });

  test("invalidates the mtime cache", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    const before = await r.readSlots();
    expect(before.slots.chat.variant_id).toBeNull();
    await r.writeSlots({
      schema_version: 1, updated_at: "x",
      slots: {
        chat: { variant_id: "chat-a" },
        embed: { variant_id: null }, extract: { variant_id: null }, hyde: { variant_id: null }, reflect: { variant_id: null },
      },
    });
    const after = await r.readSlots();
    expect(after.slots.chat.variant_id).toBe("chat-a");
  });
});

describe("SlotResolver.resolve / convenience accessors", () => {
  test("returns null provider when slot is disabled", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    const out = await r.resolve("hyde");
    expect(out.variant).toBeNull();
    expect(out.provider).toBeNull();
  });

  test("returns provider when slot bound to a valid variant", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: { chat: { variant_id: "chat-a" }, embed: { variant_id: null }, extract: { variant_id: null }, hyde: { variant_id: null }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    const out = await r.chat();
    expect(out.variant?.id).toBe("chat-a");
    expect(out.provider).not.toBeNull();
    expect(out.from_override).toBe(false);
  });

  test("session override takes precedence over system default", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: { chat: { variant_id: "chat-a" }, embed: { variant_id: null }, extract: { variant_id: null }, hyde: { variant_id: null }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    const out = await r.chat("chat-b");
    expect(out.variant?.id).toBe("chat-b");
    expect(out.from_override).toBe(true);
  });

  test("rejects override that lacks the slot capability", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    // chat-b only has 'chat', not 'embed'
    const out = await r.embed("chat-b");
    expect(out.variant).toBeNull();
    expect(out.provider).toBeNull();
  });
});

describe("SlotResolver.validateAssignment", () => {
  test("required slot cannot be set to null", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.validateAssignment("chat", null)).toMatch(/cannot be disabled/);
    expect(await r.validateAssignment("embed", null)).toMatch(/cannot be disabled/);
    expect(await r.validateAssignment("extract", null)).toMatch(/cannot be disabled/);
  });

  test("optional slots may be null (hyde + reflect)", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.validateAssignment("hyde", null)).toBeNull();
    expect(await r.validateAssignment("reflect", null)).toBeNull();
  });

  test("unknown variant id is rejected", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.validateAssignment("chat", "nope")).toMatch(/not in the registry/);
  });

  test("capability mismatch is rejected", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.validateAssignment("embed", "chat-a")).toMatch(/does not advertise capability/);
  });
});

describe("SlotResolver.hydeClient (Wave 2d)", () => {
  test("returns null when hyde slot is disabled (legitimate — HyDE is optional)", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.hydeClient()).toBeNull();
  });

  test("returns OllamaClient when hyde slot bound to ollama variant", async () => {
    const reg = {
      ...REGISTRY_CONTENT,
      variants: [
        ...REGISTRY_CONTENT.variants,
        { id: "hyde-tiny", label: "HyDE tiny", model: "qwen2.5:0.5b", runtime: "ollama", unit: "hyde-tiny.service", url: "http://hyde", gpu: 1, vram_mb: 600, capabilities: ["hyde"] },
      ],
    };
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(reg));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: { chat: { variant_id: null }, embed: { variant_id: null }, extract: { variant_id: null }, hyde: { variant_id: "hyde-tiny" }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    const client = await r.hydeClient();
    expect(client).not.toBeNull();
    expect(typeof (client as { generateShort: unknown }).generateShort).toBe("function");
  });

  test("returns null when variant.runtime is llama-cpp (no generateShort today)", async () => {
    // chat-a has runtime=llama-cpp AND capabilities includes "hyde" in REGISTRY_CONTENT.
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: { chat: { variant_id: null }, embed: { variant_id: null }, extract: { variant_id: null }, hyde: { variant_id: "chat-a" }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    expect(await r.hydeClient()).toBeNull();
  });

  test("returns null when override variant_id is unknown to registry", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.hydeClient("nope")).toBeNull();
  });
});

describe("SlotResolver.embedClient (Wave 2c)", () => {
  test("returns null when embed slot is disabled", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.embedClient()).toBeNull();
  });

  test("returns OllamaClient when embed slot bound to ollama variant", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: { chat: { variant_id: null }, embed: { variant_id: "embed-x" }, extract: { variant_id: null }, hyde: { variant_id: null }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    const client = await r.embedClient();
    expect(client).not.toBeNull();
    expect(typeof (client as { embed: unknown }).embed).toBe("function");
  });

  test("returns null when variant lacks embed capability", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: { chat: { variant_id: null }, embed: { variant_id: "chat-a" }, extract: { variant_id: null }, hyde: { variant_id: null }, reflect: { variant_id: null } },
      }),
    );
    const r = new SlotResolver(makeCfg());
    expect(await r.embedClient()).toBeNull();
  });

  test("returns null when override variant_id is unknown to registry", async () => {
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY_CONTENT));
    const r = new SlotResolver(makeCfg());
    expect(await r.embedClient("nope")).toBeNull();
  });
});

describe("Registry validation", () => {
  test("rejects schema_version != 1", async () => {
    await writeFile(
      join(tmpRoot, "registry.json"),
      JSON.stringify({ ...REGISTRY_CONTENT, schema_version: 2 }),
    );
    const r = new SlotResolver(makeCfg());
    let caught: unknown = null;
    try { await r.getRegistry().read(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RegistryLoadError);
  });

  test("rejects duplicate variant ids", async () => {
    const bad = { ...REGISTRY_CONTENT, variants: [REGISTRY_CONTENT.variants[0], REGISTRY_CONTENT.variants[0]] };
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(bad));
    const r = new SlotResolver(makeCfg());
    let caught: unknown = null;
    try { await r.getRegistry().read(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RegistryLoadError);
    expect((caught as Error).message).toMatch(/duplicated/);
  });

  test("rejects unit name not matching regex", async () => {
    const bad = {
      ...REGISTRY_CONTENT,
      variants: [{ ...REGISTRY_CONTENT.variants[0], unit: "Bad Unit Name.service" }],
    };
    await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(bad));
    const r = new SlotResolver(makeCfg());
    let caught: unknown = null;
    try { await r.getRegistry().read(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RegistryLoadError);
  });
});
