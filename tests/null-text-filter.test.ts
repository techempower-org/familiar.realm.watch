import { test, expect } from "bun:test";
import { retrieveAndGround } from "../src/memory-protocol.ts";
import type { PalaceClient } from "../src/palace-client.ts";

test("retrieveAndGround filters drawers with null text + tags warning", async () => {
  const palace = {
    search: async () => ({
      query: "x",
      available_in_scope: 100,
      warnings: [],
      results: [
        // null text — must be filtered out, not throw
        { id: "drawer_bad", text: null as unknown as string, wing: "w", room: "r", similarity: 0.9 },
        { id: "drawer_good", text: "real content", wing: "w", room: "r", similarity: 0.8 },
      ],
    }),
  } as unknown as PalaceClient;
  const out = await retrieveAndGround({
    palace,
    userMessage: "test query",
    wingScope: null,
    retrievalLimit: 5,
    contextBudgetTokens: 4000,
    recentCitations: [],
  });
  expect(out.drawerIds).toEqual(["drawer_good"]);
  expect(out.warnings.some((w) => w.startsWith("filtered_null_text_"))).toBe(true);
});
