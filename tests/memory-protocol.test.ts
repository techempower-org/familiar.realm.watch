import { test, expect, describe } from "bun:test";
import { retrieveAndGround } from "../src/memory-protocol.ts";
import type { PalaceSearchResult } from "../src/types.ts";

function fakePalace(result: PalaceSearchResult) {
  return {
    search: async () => result,
    // Phase 5: retrieveAndGround defaults to hybrid; the fake returns the
    // same result so tests don't have to assert on which channel ran.
    searchHybrid: async () => result,
    writeMemory: async () => {},
    health: async () => ({ status: "ok" }),
  };
}

describe("retrieveAndGround", () => {
  test("returns system prompt with retrieved drawers", async () => {
    const palace = fakePalace({
      query: "gatekeeper",
      total_before_filter: 3,
      available_in_scope: 5000,
      warnings: [],
      results: [
        { id: "d1", text: "gatekeeper runs OpenWrt 25.12.2", wing: "realmwatch", room: "technical", similarity: 0.9, matched_via: "drawer" },
      ],
    });

    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "what's on gatekeeper?",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: [],
    });

    expect(result.systemPrompt).toContain("gatekeeper runs OpenWrt 25.12.2");
    expect(result.systemPrompt).toContain("available_in_scope: 5,000");
    expect(result.drawerIds).toEqual(["d1"]);
  });

  test("filters out recently cited drawers", async () => {
    const palace = fakePalace({
      query: "x", available_in_scope: 1000, warnings: [],
      results: [
        { id: "d1", text: "content 1", wing: "w", room: "r", similarity: 0.9, matched_via: "drawer" },
        { id: "d2", text: "content 2", wing: "w", room: "r", similarity: 0.85, matched_via: "drawer" },
      ],
    });
    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "x",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: ["d1"], // d1 already cited this session
    });
    expect(result.drawerIds).toEqual(["d2"]);
  });

  test("returns empty drawers when palace times out", async () => {
    const palace = {
      search: async () => { throw new Error("aborted"); },
      searchHybrid: async () => { throw new Error("aborted"); },
      writeMemory: async () => {},
      health: async () => ({ status: "ok" }),
    };
    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "x",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: [],
    });
    expect(result.drawerIds).toEqual([]);
    expect(result.systemPrompt).toContain("no palace context retrieved");
    expect(result.warnings).toContain("palace_unreachable");
  });

  test("applies token budget to drop lowest-similarity drawers", async () => {
    const big = "a".repeat(4000); // ~1000 tokens
    const palace = fakePalace({
      query: "x", available_in_scope: 100, warnings: [],
      results: [
        { id: "d1", text: big, wing: "w", room: "r", similarity: 0.5, matched_via: "drawer" },
        { id: "d2", text: big, wing: "w", room: "r", similarity: 0.9, matched_via: "drawer" },
        { id: "d3", text: big, wing: "w", room: "r", similarity: 0.7, matched_via: "drawer" },
      ],
    });
    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "x",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 2100, // fits ~2 big drawers
      recentCitations: [],
    });
    expect(result.drawerIds.length).toBe(2);
    expect(result.drawerIds).toContain("d2"); // highest similarity always kept
  });
});
