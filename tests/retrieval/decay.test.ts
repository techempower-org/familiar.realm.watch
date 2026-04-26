import { test, expect, describe } from "bun:test";
import { temporalDecay } from "../../src/retrieval/decay.ts";
import type { PalaceDrawer } from "../../src/types.ts";

const NOW = 1714000000000;

function drawerAge(similarity: number, ageDays: number, id = ""): PalaceDrawer {
  return {
    id,
    text: "x",
    wing: "w",
    room: "r",
    similarity,
    created_at: new Date(NOW - ageDays * 86400 * 1000).toISOString(),
  };
}

describe("temporalDecay", () => {
  test("score unchanged for age=0 (just-created drawer)", () => {
    const [out] = temporalDecay([drawerAge(0.8, 0)], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.8, 3);
  });

  test("score halves at half-life", () => {
    const [out] = temporalDecay([drawerAge(1.0, 30)], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.5, 3);
  });

  test("score quarters at 2x half-life", () => {
    const [out] = temporalDecay([drawerAge(1.0, 60)], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.25, 3);
  });

  test("missing created_at keeps base score unchanged", () => {
    const d: PalaceDrawer = { text: "x", wing: "w", room: "r", similarity: 0.7 };
    const [out] = temporalDecay([d], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.7, 3);
  });

  test("malformed timestamp keeps base score, doesn't crash", () => {
    const d: PalaceDrawer = { text: "x", wing: "w", room: "r", similarity: 0.6, created_at: "not-a-date" };
    const [out] = temporalDecay([d], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.6, 3);
  });

  test("future-dated drawer doesn't penalize (ageDays < 0)", () => {
    const future: PalaceDrawer = {
      text: "x", wing: "w", room: "r", similarity: 0.5,
      created_at: new Date(NOW + 86400 * 1000).toISOString(),
    };
    const [out] = temporalDecay([future], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.5, 3);
  });

  test("falls back to inverted distance when similarity missing", () => {
    const d: PalaceDrawer = { text: "x", wing: "w", room: "r", distance: 0.4 };
    // baseScore = distance value (the function uses .similarity ?? .distance ?? 0)
    // age=0 => no decay => score = 0.4
    const [out] = temporalDecay([d], { halfLifeDays: 30, now: NOW });
    expect(out.similarity).toBeCloseTo(0.4, 3);
  });

  test("preserves all PalaceDrawer fields via spread", () => {
    const input: PalaceDrawer = {
      id: "drawer_x", text: "y", wing: "w", room: "r",
      similarity: 1.0, cosine: 0.9, bm25: 0.5, topic: "t", matched_via: "drawer",
      created_at: new Date(NOW).toISOString(),
    };
    const [out] = temporalDecay([input], { halfLifeDays: 30, now: NOW });
    expect(out.id).toBe("drawer_x");
    expect(out.cosine).toBe(0.9);
    expect(out.bm25).toBe(0.5);
    expect(out.topic).toBe("t");
    expect(out.matched_via).toBe("drawer");
  });

  test("returns new array, doesn't mutate input", () => {
    const input = [drawerAge(0.5, 60)];
    const original = input[0].similarity;
    const out = temporalDecay(input, { halfLifeDays: 30, now: NOW });
    expect(input[0].similarity).toBe(original);
    expect(out[0]).not.toBe(input[0]);
  });

  test("empty input returns empty", () => {
    expect(temporalDecay([], { halfLifeDays: 30 })).toEqual([]);
  });
});
