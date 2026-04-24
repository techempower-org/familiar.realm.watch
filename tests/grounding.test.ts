import { test, expect, describe } from "bun:test";
import { buildSystemPrompt } from "../src/grounding.ts";
import type { PalaceDrawer } from "../src/types.ts";

describe("buildSystemPrompt", () => {
  function mkDrawer(overrides: Partial<PalaceDrawer> = {}): PalaceDrawer {
    return {
      id: "drawer_123",
      text: "The gatekeeper firewall runs OpenWrt 25.12.2.",
      wing: "realmwatch",
      room: "technical",
      source_file: "gatekeeper.md",
      created_at: "2026-04-22T10:00:00Z",
      similarity: 0.88,
      matched_via: "drawer",
      ...overrides,
    };
  }

  test("includes persona preamble", () => {
    const prompt = buildSystemPrompt({
      drawers: [],
      warnings: [],
      availableInScope: 0,
      wingScope: null,
    });
    expect(prompt).toContain("familiar");
    expect(prompt).toContain("palace");
  });

  test("includes all drawers with metadata tags", () => {
    const drawers = [mkDrawer({ id: "a" }), mkDrawer({ id: "b", wing: "homelab", room: "openwrt" })];
    const prompt = buildSystemPrompt({ drawers, warnings: [], availableInScope: 1000, wingScope: null });
    expect(prompt).toContain("drawer_id=a");
    expect(prompt).toContain("drawer_id=b");
    expect(prompt).toContain("wing=realmwatch");
    expect(prompt).toContain("wing=homelab");
    expect(prompt).toContain("The gatekeeper firewall runs OpenWrt 25.12.2");
  });

  test("surfaces warnings and available_in_scope", () => {
    const prompt = buildSystemPrompt({
      drawers: [],
      warnings: ["vector search returned 0 of 5; filled via BM25 fallback"],
      availableInScope: 12202,
      wingScope: "realmwatch",
    });
    expect(prompt).toContain("available_in_scope: 12,202");
    expect(prompt).toContain("vector search returned 0 of 5");
    expect(prompt).toContain("wing_scope: realmwatch");
  });

  test("includes grounding directives (faithfulness/citation/refusal)", () => {
    const prompt = buildSystemPrompt({ drawers: [], warnings: [], availableInScope: 0, wingScope: null });
    expect(prompt).toMatch(/only from the palace context/i);
    expect(prompt).toMatch(/cite drawer ids/i);
    expect(prompt).toMatch(/do not refuse/i);
    expect(prompt).toMatch(/name the ambiguity/i);
  });

  test("labels empty palace clearly", () => {
    const prompt = buildSystemPrompt({ drawers: [], warnings: [], availableInScope: 0, wingScope: null });
    expect(prompt).toContain("no palace context retrieved");
  });
});
