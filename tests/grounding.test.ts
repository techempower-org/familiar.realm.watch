import { test, expect, describe } from "bun:test";
import { buildSystemPrompt, confidencePrefix, stuckDirective } from "../src/grounding.ts";
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

  test("appends confidence note when retrieval is weak", () => {
    const weakDrawers: PalaceDrawer[] = [{ text: "x", wing: "w", room: "r", similarity: 0.2 }];
    const prompt = buildSystemPrompt({ drawers: weakDrawers, warnings: [], availableInScope: 1, wingScope: null });
    expect(prompt).toMatch(/confidence note|weak/i);
  });

  test("omits confidence note when retrieval is strong", () => {
    const strongDrawers: PalaceDrawer[] = [
      { text: "x", wing: "w", room: "r", similarity: 0.85 },
      { text: "y", wing: "w", room: "r", similarity: 0.7 },
    ];
    const prompt = buildSystemPrompt({ drawers: strongDrawers, warnings: [], availableInScope: 2, wingScope: null });
    expect(prompt).not.toContain("Confidence note");
  });

  test("appends loop note when stuck=true", () => {
    const prompt = buildSystemPrompt({
      drawers: [{ text: "x", wing: "w", room: "r", similarity: 0.8 }],
      warnings: [], availableInScope: 1, wingScope: null, stuck: true,
    });
    expect(prompt).toMatch(/loop note|repeatedly/i);
  });

  test("omits loop note when stuck=false (default)", () => {
    const prompt = buildSystemPrompt({
      drawers: [{ text: "x", wing: "w", room: "r", similarity: 0.8 }],
      warnings: [], availableInScope: 1, wingScope: null,
    });
    expect(prompt).not.toContain("Loop note");
  });
});

describe("confidencePrefix", () => {
  test("empty when top similarity > 0.3", () => {
    const drawers: PalaceDrawer[] = [{ text: "x", wing: "w", room: "r", similarity: 0.5 }];
    expect(confidencePrefix(drawers)).toBe("");
  });

  test("empty when there are >= 2 drawers (even if weakly matched)", () => {
    const drawers: PalaceDrawer[] = [
      { text: "x", wing: "w", room: "r", similarity: 0.1 },
      { text: "y", wing: "w", room: "r", similarity: 0.1 },
    ];
    expect(confidencePrefix(drawers)).toBe("");
  });

  test("non-empty when top < 0.3 AND fewer than 2 drawers", () => {
    const drawers: PalaceDrawer[] = [{ text: "x", wing: "w", room: "r", similarity: 0.2 }];
    expect(confidencePrefix(drawers)).toContain("weak");
  });

  test("non-empty when no drawers at all", () => {
    expect(confidencePrefix([])).toContain("weak");
  });
});

describe("stuckDirective", () => {
  test("returns a non-empty system-prompt directive", () => {
    const out = stuckDirective();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/repeatedly|wing|rephras/i);
  });
});
