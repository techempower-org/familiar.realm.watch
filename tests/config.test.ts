import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.ts";

const ENV_PREFIXES = ["FAMILIAR_", "OLLAMA_", "PALACE_", "TOKEN_BUDGET_"];
const ENV_EXACT = ["RETRIEVAL_LIMIT", "SESSION_TTL_MINUTES", "REALM_SIGIL_REALM", "LOG_LEVEL"];

function shouldClear(key: string): boolean {
  return ENV_PREFIXES.some((p) => key.startsWith(p)) || ENV_EXACT.includes(key);
}

describe("loadConfig", () => {
  // Snapshot the original env so we can restore it after each test. Without
  // this, the env wipe leaks into other test files (notably recall-roundtrip
  // which reads PALACE_DAEMON_API_KEY at runtime) and causes spurious failures
  // when bun's test runner reuses the process across files.
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = {};
    for (const key of Object.keys(process.env)) {
      if (shouldClear(key)) {
        snapshot[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
    snapshot = {};
  });

  test("returns defaults when env is empty", () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.ollamaChat.url).toBe("http://127.0.0.1:11434");
    expect(cfg.ollamaChat.model).toBe("qwen2.5:3b-instruct-q4_K_M");
    expect(cfg.ollamaEmbed.url).toBe("http://127.0.0.1:11435");
    expect(cfg.ollamaEmbed.model).toBe("nomic-embed-text:v1.5");
    expect(cfg.palaceDaemon.url).toBe("http://katana:8085");
    expect(cfg.palaceDaemon.searchTimeoutMs).toBe(2000);
    expect(cfg.tokenBudget.system).toBe(1500);
    expect(cfg.tokenBudget.context).toBe(4000);
    expect(cfg.tokenBudget.history).toBe(2000);
    expect(cfg.tokenBudget.response).toBe(512);
    expect(cfg.retrievalLimit).toBe(5);
    expect(cfg.sessionTtlMinutes).toBe(60);
    expect(cfg.realmSigilRealm).toBe("fantasy");
    expect(cfg.logLevel).toBe("info");
  });

  test("overrides from env vars", () => {
    process.env.FAMILIAR_PORT = "9090";
    process.env.OLLAMA_CHAT_URL = "http://familiar:11434";
    process.env.PALACE_DAEMON_URL = "http://katana:8085";
    process.env.PALACE_DAEMON_API_KEY = "secret123";
    process.env.TOKEN_BUDGET_CONTEXT = "8000";
    const cfg = loadConfig();
    expect(cfg.port).toBe(9090);
    expect(cfg.ollamaChat.url).toBe("http://familiar:11434");
    expect(cfg.palaceDaemon.apiKey).toBe("secret123");
    expect(cfg.tokenBudget.context).toBe(8000);
  });

  test("rejects invalid numeric env vars", () => {
    process.env.FAMILIAR_PORT = "not-a-number";
    expect(() => loadConfig()).toThrow(/FAMILIAR_PORT/);
  });
});
