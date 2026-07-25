import { test, expect, describe } from "bun:test";
import { retrieveAndGround, expandTemporalQuery } from "../src/memory-protocol.ts";
import type { PalaceSearchResult } from "../src/types.ts";

function fakePalace(result: PalaceSearchResult) {
  return {
    search: async () => result,
    searchHybrid: async () => result,
    // retrieveAndGround defaults to age-fused (#88); fake returns the same
    // result across all three methods so tests don't assert on which channel ran.
    searchAgeFused: async () => result,
    writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
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
      searchAgeFused: async () => { throw new Error("aborted"); },
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
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

  test("excludes session-diary drawers from grounding (issue #25)", async () => {
    // Stop-hook diary entries (room=diary) are the agent's own log of past
    // turns. Including them in palace context creates a feedback loop —
    // a hallucinated answer becomes "palace truth" for the next turn.
    // retrieveAndGround should filter them out and warn so eval/trace can
    // see the data-quality signal.
    const palace = fakePalace({
      query: "what model is running?",
      available_in_scope: 100,
      warnings: [],
      results: [
        { id: "diary_familiar_001", text: "[2026-05-16] user: ... assistant: 7B model on RTX 2080 Ti", wing: "familiar", room: "diary", similarity: 0.9, matched_via: "drawer" },
        { id: "drawer_decisions_001", text: "chat model = phi-4 14B on P102", wing: "familiar_realm_watch", room: "decisions", similarity: 0.7, matched_via: "drawer" },
      ],
    });
    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "what model is running?",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: [],
    });
    expect(result.drawerIds).not.toContain("diary_familiar_001");
    expect(result.drawerIds).toContain("drawer_decisions_001");
    expect(result.warnings.some((w) => w.startsWith("filtered_diary_"))).toBe(true);
  });
});

describe("hybrid → vector fallback", () => {
  const baseOpts = (palace: unknown) => ({
    palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
    userMessage: "test query",
    wingScope: null,
    retrievalLimit: 5,
    contextBudgetTokens: 4000,
    recentCitations: [] as string[],
  });

  test("hybrid 503 falls back to vector search with warning", async () => {
    const palace = {
      searchAgeFused: async () => { throw new Error("503 Service Unavailable"); },
      searchHybrid: async () => { throw new Error("503 Service Unavailable"); },
      search: async () => ({
        query: "test query",
        available_in_scope: 100,
        warnings: [],
        results: [
          { id: "v1", text: "vector result", wing: "w", room: "r", similarity: 0.8, matched_via: "drawer" },
        ],
      }),
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };

    const result = await retrieveAndGround(baseOpts(palace));
    expect(result.warnings).toContain("hybrid_fallback_vector");
    expect(result.drawerIds.length).toBeGreaterThan(0);
    expect(result.drawerIds).toContain("v1");
  });

  test("hybrid non-503 error surfaces as palace_unreachable", async () => {
    const palace = {
      searchAgeFused: async () => { throw new Error("ECONNREFUSED"); },
      searchHybrid: async () => { throw new Error("ECONNREFUSED"); },
      search: async () => ({
        query: "test query",
        available_in_scope: 100,
        warnings: [],
        results: [
          { id: "v1", text: "should not appear", wing: "w", room: "r", similarity: 0.8, matched_via: "drawer" },
        ],
      }),
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };

    const result = await retrieveAndGround(baseOpts(palace));
    expect(result.warnings).toContain("palace_unreachable");
    expect(result.drawerIds).toEqual([]);
  });
});

describe("search_mode (age-fused) routing + fallback chain", () => {
  const baseOpts = (palace: unknown, searchMode?: import("../src/types.ts").SearchMode) => ({
    palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
    userMessage: "pgvector advisory lock race",
    wingScope: null,
    retrievalLimit: 5,
    contextBudgetTokens: 4000,
    recentCitations: [] as string[],
    searchMode,
  });

  const ageFusedResult = {
    query: "pgvector advisory lock race",
    available_in_scope: 200,
    warnings: [],
    results: [{ id: "ag1", text: "graph-connected memory", wing: "memorypalace", room: "problems", similarity: 0.7, matched_via: "both" }],
    trace: { n_vector: 18, n_graph: 6, n_after_fusion: 8 },
  };

  test("searchMode=age-fused calls searchAgeFused and threads trace into result.retrieval", async () => {
    let calledAgeFused = false;
    const palace = {
      searchAgeFused: async () => { calledAgeFused = true; return ageFusedResult; },
      searchHybrid: async () => { throw new Error("hybrid should not be called"); },
      search: async () => { throw new Error("vector should not be called"); },
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };
    const result = await retrieveAndGround(baseOpts(palace, "age-fused"));
    expect(calledAgeFused).toBe(true);
    expect(result.drawerIds).toContain("ag1");
    expect(result.retrieval).toBeDefined();
    expect(result.retrieval!.mode).toBe("age-fused");
    expect(result.retrieval!.n_graph).toBe(6);
    expect(result.retrieval!.n_vector).toBe(18);
    expect(result.retrieval!.fell_back_to).toBeUndefined();
  });

  test("age-fused 503 falls back to hybrid with age_fused_fallback_hybrid warning", async () => {
    const palace = {
      searchAgeFused: async () => { throw new Error("503 Service Unavailable"); },
      searchHybrid: async () => ({
        query: "x", available_in_scope: 50, warnings: [],
        results: [{ id: "h1", text: "hybrid hit", wing: "w", room: "r", similarity: 0.8, matched_via: "drawer" }],
      }),
      search: async () => { throw new Error("vector should not be called"); },
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };
    const result = await retrieveAndGround(baseOpts(palace, "age-fused"));
    expect(result.warnings).toContain("age_fused_fallback_hybrid");
    expect(result.drawerIds).toContain("h1");
    expect(result.retrieval!.mode).toBe("hybrid");
    expect(result.retrieval!.fell_back_to).toBe("hybrid");
  });

  test("age-fused 503 then hybrid 404 falls all the way back to vector", async () => {
    const palace = {
      searchAgeFused: async () => { throw new Error("503 Service Unavailable"); },
      searchHybrid: async () => { throw new Error("404 Not Found"); },
      search: async () => ({
        query: "x", available_in_scope: 50, warnings: [],
        results: [{ id: "v1", text: "vector hit", wing: "w", room: "r", similarity: 0.6, matched_via: "drawer" }],
      }),
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };
    const result = await retrieveAndGround(baseOpts(palace, "age-fused"));
    expect(result.warnings).toContain("age_fused_fallback_hybrid");
    expect(result.warnings).toContain("hybrid_fallback_vector");
    expect(result.drawerIds).toContain("v1");
    expect(result.retrieval!.mode).toBe("vector");
  });

  test("age-fused non-503 error surfaces palace_unreachable without falling back", async () => {
    let hybridCalled = false;
    const palace = {
      searchAgeFused: async () => { throw new Error("ECONNREFUSED"); },
      searchHybrid: async () => { hybridCalled = true; return { query: "x", results: [] }; },
      search: async () => ({ query: "x", results: [] }),
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };
    const result = await retrieveAndGround(baseOpts(palace, "age-fused"));
    expect(hybridCalled).toBe(false);
    expect(result.warnings).toContain("palace_unreachable");
    expect(result.drawerIds).toEqual([]);
  });

  test("explicit searchMode=vector skips hybrid + age-fused entirely", async () => {
    let vectorCalled = false;
    const palace = {
      searchAgeFused: async () => { throw new Error("age-fused should not be called"); },
      searchHybrid: async () => { throw new Error("hybrid should not be called"); },
      search: async () => { vectorCalled = true; return {
        query: "x", available_in_scope: 10, warnings: [],
        results: [{ id: "v1", text: "vector only", wing: "w", room: "r", similarity: 0.9, matched_via: "drawer" }],
      }; },
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };
    const result = await retrieveAndGround(baseOpts(palace, "vector"));
    expect(vectorCalled).toBe(true);
    expect(result.retrieval!.mode).toBe("vector");
    expect(result.retrieval!.fell_back_to).toBeUndefined();
  });
});

describe("HyDE integration", () => {
  test("hydeGenerate is forwarded to searchHybrid", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const hydeGenerate = async (q: string) => "hypothesis for " + q;

    const palace = {
      searchHybrid: async (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return {
          query: "test query",
          available_in_scope: 10,
          warnings: [],
          results: [
            { id: "h1", text: "hyde result", wing: "w", room: "r", similarity: 0.9, matched_via: "drawer" },
          ],
        };
      },
      search: async () => ({ query: "", available_in_scope: 0, warnings: [], results: [] }),
      writeMemory: async () => ({ id: "", warnings: [], errors: [] }),
      health: async () => ({ status: "ok" }),
    };

    await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "test query",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: [],
      searchMode: "hybrid",
      hydeGenerate,
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.hydeGenerate).toBe(hydeGenerate);
  });
});

describe("filtering: null-text, diary, citations", () => {
  test("filters drawers with null text and emits warning", async () => {
    const palace = fakePalace({
      query: "test",
      available_in_scope: 100,
      warnings: [],
      results: [
        { id: "good1", text: "valid content", wing: "w", room: "r", similarity: 0.9, matched_via: "drawer" },
        { id: "bad1", text: null as unknown as string, wing: "w", room: "r", similarity: 0.8, matched_via: "drawer" },
      ],
    });

    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "test query",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: [],
    });

    expect(result.drawerIds).toContain("good1");
    expect(result.drawerIds).not.toContain("bad1");
    expect(result.warnings.some((w) => /filtered_null_text/.test(w))).toBe(true);
  });

  test("filters diary-room drawers and emits warning", async () => {
    const palace = fakePalace({
      query: "test",
      available_in_scope: 100,
      warnings: [],
      results: [
        { id: "normal1", text: "factual content", wing: "w", room: "decisions", similarity: 0.9, matched_via: "drawer" },
        { id: "diary1", text: "session log entry", wing: "familiar", room: "diary", similarity: 0.95, matched_via: "drawer" },
        { id: "diary2", text: "another session log", wing: "familiar", room: "diary", similarity: 0.85, matched_via: "drawer" },
      ],
    });

    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "test query",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: [],
    });

    expect(result.drawerIds).toContain("normal1");
    expect(result.drawerIds).not.toContain("diary1");
    expect(result.drawerIds).not.toContain("diary2");
    expect(result.warnings.some((w) => /filtered_diary/.test(w))).toBe(true);
  });

  test("deduplicates against recentCitations", async () => {
    const palace = fakePalace({
      query: "test",
      available_in_scope: 100,
      warnings: [],
      results: [
        { id: "d1", text: "content one", wing: "w", room: "r", similarity: 0.9, matched_via: "drawer" },
        { id: "d2", text: "content two", wing: "w", room: "r", similarity: 0.85, matched_via: "drawer" },
        { id: "d3", text: "content three", wing: "w", room: "r", similarity: 0.8, matched_via: "drawer" },
      ],
    });

    const result = await retrieveAndGround({
      palace: palace as unknown as import("../src/palace-client.ts").PalaceClient,
      userMessage: "test query",
      wingScope: null,
      retrievalLimit: 5,
      contextBudgetTokens: 4000,
      recentCitations: ["d1", "d3"],
    });

    expect(result.drawerIds).toEqual(["d2"]);
  });
});

describe("expandTemporalQuery", () => {
  const fixed = new Date("2026-05-24T14:30:00-07:00");

  test("appends ISO date for 'yesterday'", () => {
    const result = expandTemporalQuery("what did we do yesterday", fixed);
    expect(result).toBe("what did we do yesterday 2026-05-23");
  });

  test("appends ISO date for 'today'", () => {
    const result = expandTemporalQuery("what happened today", fixed);
    expect(result).toBe("what happened today 2026-05-24");
  });

  test("expands 'last week' to 7 date strings", () => {
    const result = expandTemporalQuery("what did we work on last week", fixed);
    expect(result).toContain("2026-05-17");
    expect(result).toContain("2026-05-24");
  });

  test("expands 'N days ago'", () => {
    const result = expandTemporalQuery("what happened 3 days ago", fixed);
    expect(result).toBe("what happened 3 days ago 2026-05-21");
  });

  test("passes through non-temporal queries unchanged", () => {
    const result = expandTemporalQuery("what model runs on familiar", fixed);
    expect(result).toBe("what model runs on familiar");
  });

  test("case insensitive", () => {
    const result = expandTemporalQuery("YESTERDAY we fixed a bug", fixed);
    expect(result).toContain("2026-05-23");
  });

  test("expands 'recently' to 3-day window", () => {
    const result = expandTemporalQuery("what did we do recently", fixed);
    expect(result).toContain("2026-05-21");
    expect(result).toContain("2026-05-24");
  });
});
