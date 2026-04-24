import { test, expect, describe } from "bun:test";
import { estimateTokens, allocateContext } from "../src/budget.ts";
import type { PalaceDrawer } from "../src/types.ts";

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("approximates 1 token per 4 chars", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("rounds up partial tokens", () => {
    expect(estimateTokens("ab")).toBe(1); // 2/4 → 0.5 → 1
    expect(estimateTokens("abcde")).toBe(2); // 5/4 → 1.25 → 2
  });
});

describe("allocateContext", () => {
  function mkDrawer(text: string, similarity: number): PalaceDrawer {
    return { text, wing: "w", room: "r", similarity };
  }

  test("returns all drawers when under budget", () => {
    const drawers = [mkDrawer("short", 0.9), mkDrawer("also short", 0.8)];
    const result = allocateContext(drawers, 1000);
    expect(result.kept.length).toBe(2);
    expect(result.dropped.length).toBe(0);
    expect(result.usedTokens).toBeLessThan(1000);
  });

  test("drops lowest-similarity drawers until fit", () => {
    const big = "a".repeat(4000); // ~1000 tokens each
    const drawers = [
      mkDrawer(big, 0.5),
      mkDrawer(big, 0.9),
      mkDrawer(big, 0.7),
    ];
    const result = allocateContext(drawers, 2100); // fits 2 big drawers
    expect(result.kept.length).toBe(2);
    expect(result.kept[0].similarity).toBe(0.9);
    expect(result.kept[1].similarity).toBe(0.7);
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0].similarity).toBe(0.5);
  });

  test("preserves relative order of kept drawers as provided", () => {
    // input order simulates post-rerank order; we keep rerank order intact
    const drawers = [mkDrawer("first", 0.9), mkDrawer("second", 0.8), mkDrawer("third", 0.7)];
    const result = allocateContext(drawers, 1000);
    expect(result.kept.map((d) => d.text)).toEqual(["first", "second", "third"]);
  });

  test("returns empty when no drawers fit", () => {
    const big = "a".repeat(10000);
    const drawers = [mkDrawer(big, 0.9)];
    const result = allocateContext(drawers, 100);
    expect(result.kept.length).toBe(0);
    expect(result.dropped.length).toBe(1);
  });
});
