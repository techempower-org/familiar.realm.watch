import { test, expect, describe } from "bun:test";
import type { RegistryConfig, SlotsConfig } from "../src/types.ts";
import {
  VRAM_BUDGET_FRACTION,
  applyChange,
  computeUsage,
  validateChange,
} from "../src/slots/vram.ts";

function reg(): RegistryConfig {
  return {
    schema_version: 1,
    gpu_total_mb: { "0": 10240, "1": 10240 },
    variants: [
      { id: "chat-7b-gpu0", label: "Chat 7B GPU0", model: "m", runtime: "llama-cpp", unit: "u-a.service", url: "http://localhost:1", gpu: 0, vram_mb: 4400, capabilities: ["chat"] },
      { id: "chat-7b-gpu1", label: "Chat 7B GPU1", model: "m", runtime: "llama-cpp", unit: "u-b.service", url: "http://localhost:2", gpu: 1, vram_mb: 4400, capabilities: ["chat"] },
      { id: "chat-big-gpu0", label: "Big GPU0", model: "m", runtime: "llama-cpp", unit: "u-c.service", url: "http://localhost:3", gpu: 0, vram_mb: 9000, capabilities: ["chat"] },
      { id: "chat-cpu", label: "Chat CPU", model: "m", runtime: "llama-cpp", unit: "u-d.service", url: "http://localhost:4", gpu: null, vram_mb: 0, capabilities: ["chat"] },
      { id: "embed-gpu1", label: "Embed GPU1", model: "m", runtime: "ollama", unit: "u-e.service", url: "http://localhost:5", gpu: 1, vram_mb: 350, capabilities: ["embed"] },
      { id: "extract-gpu0", label: "Extract GPU0", model: "m", runtime: "llama-cpp", unit: "u-f.service", url: "http://localhost:6", gpu: 0, vram_mb: 5500, capabilities: ["extract"] },
    ],
  };
}

function slots(overrides: Partial<SlotsConfig["slots"]> = {}): SlotsConfig {
  return {
    schema_version: 1,
    updated_at: "1970-01-01T00:00:00Z",
    slots: {
      chat: { variant_id: null },
      embed: { variant_id: null },
      extract: { variant_id: null },
      hyde: { variant_id: null },
      reflect: { variant_id: null },
      ...overrides,
    },
  };
}

describe("computeUsage", () => {
  test("all slots disabled returns zero usage on every known GPU", () => {
    const u = computeUsage(slots(), reg());
    const byGpu = Object.fromEntries(u.map((g) => [g.gpu, g.used_mb]));
    expect(byGpu["0"]).toBe(0);
    expect(byGpu["1"]).toBe(0);
  });

  test("sums VRAM per GPU across slots", () => {
    const u = computeUsage(
      slots({ chat: { variant_id: "chat-7b-gpu0" }, extract: { variant_id: "extract-gpu0" } }),
      reg(),
    );
    const byGpu = Object.fromEntries(u.map((g) => [g.gpu, g.used_mb]));
    expect(byGpu["0"]).toBe(4400 + 5500);
    expect(byGpu["1"]).toBe(0);
  });

  test("CPU variants tally under 'cpu' bucket, not a GPU", () => {
    const u = computeUsage(slots({ chat: { variant_id: "chat-cpu" } }), reg());
    const cpu = u.find((g) => g.gpu === "cpu");
    expect(cpu?.used_mb).toBe(0); // CPU variant is 0 vram_mb
  });

  test("computes budget_mb as floor(total × 0.92)", () => {
    const u = computeUsage(slots(), reg());
    const g0 = u.find((g) => g.gpu === "0");
    expect(g0?.budget_mb).toBe(Math.floor(10240 * VRAM_BUDGET_FRACTION));
  });

  test("unknown variant_id contributes zero (registry corruption tolerated)", () => {
    const u = computeUsage(
      slots({ chat: { variant_id: "does-not-exist" } }),
      reg(),
    );
    const byGpu = Object.fromEntries(u.map((g) => [g.gpu, g.used_mb]));
    expect(byGpu["0"]).toBe(0);
    expect(byGpu["1"]).toBe(0);
  });
});

describe("validateChange", () => {
  test("returns null when every GPU is under budget", () => {
    expect(
      validateChange(
        slots({
          chat: { variant_id: "chat-7b-gpu1" },
          embed: { variant_id: "embed-gpu1" },
        }),
        reg(),
      ),
    ).toBeNull();
  });

  test("returns overflow detail when a GPU exceeds budget", () => {
    const result = validateChange(
      slots({
        chat: { variant_id: "chat-big-gpu0" },
        extract: { variant_id: "extract-gpu0" },
      }),
      reg(),
    );
    expect(result).not.toBeNull();
    expect(result!.gpu).toBe("0");
    expect(result!.would_use_mb).toBe(9000 + 5500);
    expect(result!.total_mb).toBe(10240);
    expect(result!.budget_mb).toBe(Math.floor(10240 * VRAM_BUDGET_FRACTION));
  });

  test("CPU-only configurations are never rejected by budget rule", () => {
    expect(
      validateChange(slots({ chat: { variant_id: "chat-cpu" } }), reg()),
    ).toBeNull();
  });

  test("budget is independent per GPU — one tight GPU does not affect the other", () => {
    const result = validateChange(
      slots({
        chat: { variant_id: "chat-big-gpu0" },
        embed: { variant_id: "embed-gpu1" },
      }),
      reg(),
    );
    // GPU0 has 9000 (under 9420 budget), GPU1 has 350 — both fit
    expect(result).toBeNull();
  });
});

describe("applyChange", () => {
  test("does not mutate the input", () => {
    const original = slots({ chat: { variant_id: "chat-7b-gpu0" } });
    const snapshot = JSON.stringify(original);
    applyChange(original, "chat", "chat-7b-gpu1");
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("returns new config with the slot updated", () => {
    const next = applyChange(slots(), "chat", "chat-7b-gpu1");
    expect(next.slots.chat.variant_id).toBe("chat-7b-gpu1");
    expect(next.slots.embed.variant_id).toBeNull();
  });

  test("null clears a slot", () => {
    const next = applyChange(
      slots({ hyde: { variant_id: "chat-7b-gpu1" } }),
      "hyde",
      null,
    );
    expect(next.slots.hyde.variant_id).toBeNull();
  });
});
