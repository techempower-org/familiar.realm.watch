import { test, expect, describe, beforeEach } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  beforeEach(() => {
    // Clear any stray env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("FAMILIAR_") || key.startsWith("OLLAMA_") || key.startsWith("PALACE_") || key.startsWith("TOKEN_BUDGET_") || key === "RETRIEVAL_LIMIT" || key === "SESSION_TTL_MINUTES" || key === "REALM_SIGIL_REALM" || key === "LOG_LEVEL") {
        delete process.env[key];
      }
    }
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
