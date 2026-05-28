import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickChatProvider } from "../src/routes/chat.ts";
import { SlotResolver } from "../src/slots/resolver.ts";
import type { ChatRouteDeps } from "../src/routes/chat.ts";
import type { Config, InferenceChatProvider, OllamaChatChunk } from "../src/types.ts";

let tmpRoot: string;

function makeCfg(): Config {
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
      adminEnabled: false,
    },
  };
}

const REGISTRY = {
  schema_version: 1,
  gpu_total_mb: { "0": 10240, "1": 10240 },
  variants: [
    { id: "chat-a", label: "A", model: "m-a", runtime: "llama-cpp", unit: "chat-a.service", url: "http://chat-a", gpu: 0, vram_mb: 4000, capabilities: ["chat"] },
    { id: "chat-b", label: "B", model: "m-b", runtime: "ollama", unit: "chat-b.service", url: "http://chat-b", gpu: 1, vram_mb: 4000, capabilities: ["chat"] },
  ],
};

const LEGACY_PROVIDER: InferenceChatProvider = {
  isHealthy: () => Promise.resolve(true),
  async *chatStream() {
    yield { model: "legacy", created_at: "", message: { role: "assistant", content: "legacy" }, done: false } as OllamaChatChunk;
    yield { model: "legacy", created_at: "", done: true } as OllamaChatChunk;
  },
};

function depsWith(resolver: SlotResolver | undefined): ChatRouteDeps {
  return {
    cfg: makeCfg(),
    palace: {} as ChatRouteDeps["palace"],
    ollama: LEGACY_PROVIDER,
    resolver,
    sessions: {} as ChatRouteDeps["sessions"],
    diaryBuffer: {} as ChatRouteDeps["diaryBuffer"],
    breakers: { palace: {} as ChatRouteDeps["breakers"]["palace"], ollama: {} as ChatRouteDeps["breakers"]["ollama"] },
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "familiar-chat-pick-"));
  await writeFile(join(tmpRoot, "registry.json"), JSON.stringify(REGISTRY));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("pickChatProvider (Wave 2b fallback contract)", () => {
  test("returns the legacy provider when no resolver is wired", async () => {
    const provider = await pickChatProvider(depsWith(undefined));
    expect(provider).toBe(LEGACY_PROVIDER);
  });

  test("returns the legacy provider when resolver yields no chat binding (cold start)", async () => {
    const resolver = new SlotResolver(makeCfg());
    const provider = await pickChatProvider(depsWith(resolver));
    expect(provider).toBe(LEGACY_PROVIDER);
  });

  test("returns the resolver's provider when the chat slot is bound", async () => {
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: {
          chat: { variant_id: "chat-b" },
          embed: { variant_id: null }, extract: { variant_id: null },
          hyde: { variant_id: null }, reflect: { variant_id: null },
        },
      }),
    );
    const resolver = new SlotResolver(makeCfg());
    const provider = await pickChatProvider(depsWith(resolver));
    expect(provider).not.toBe(LEGACY_PROVIDER);
    expect(typeof provider.isHealthy).toBe("function");
    expect(typeof provider.chatStream).toBe("function");
  });

  test("falls back to legacy when chat slot points at unknown variant", async () => {
    await writeFile(
      join(tmpRoot, "slots.json"),
      JSON.stringify({
        schema_version: 1, updated_at: "x",
        slots: {
          chat: { variant_id: "does-not-exist" },
          embed: { variant_id: null }, extract: { variant_id: null },
          hyde: { variant_id: null }, reflect: { variant_id: null },
        },
      }),
    );
    const resolver = new SlotResolver(makeCfg());
    const provider = await pickChatProvider(depsWith(resolver));
    expect(provider).toBe(LEGACY_PROVIDER);
  });
});
