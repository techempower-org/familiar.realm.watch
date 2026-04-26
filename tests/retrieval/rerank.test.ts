import { test, expect, describe } from "bun:test";
import { domainRerank } from "../../src/retrieval/rerank.ts";
import type { PalaceDrawer } from "../../src/types.ts";

function drawer(
  partial: Partial<PalaceDrawer> & Pick<PalaceDrawer, "wing">,
): PalaceDrawer {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    text: partial.text ?? "x",
    wing: partial.wing,
    room: partial.room ?? "r",
    similarity: partial.similarity,
    distance: partial.distance,
    created_at: partial.created_at,
    topic: partial.topic,
    cosine: partial.cosine,
    bm25: partial.bm25,
    matched_via: partial.matched_via,
  };
}

describe("domainRerank", () => {
  test("wing match boosts score above non-match at equal base similarity", () => {
    const result = domainRerank(
      [drawer({ wing: "other", similarity: 0.6 }), drawer({ wing: "realmwatch", similarity: 0.6 })],
      "realmwatch",
    );
    expect(result[0].wing).toBe("realmwatch");
    expect(result[0].similarity!).toBeGreaterThan(result[1].similarity!);
  });

  test("with no wing scope, all drawers get neutral tag weight (similarity-ordered)", () => {
    const result = domainRerank(
      [drawer({ wing: "a", similarity: 0.4 }), drawer({ wing: "b", similarity: 0.9 })],
      null,
    );
    expect(result[0].wing).toBe("b");
    expect(result[1].wing).toBe("a");
  });

  test("recent drawer (within 48h) gets recency bonus", () => {
    const NOW = 1714000000000; // fixed epoch
    const recent = drawer({ wing: "x", similarity: 0.5, created_at: new Date(NOW - 6 * 3600 * 1000).toISOString() });
    const stale = drawer({ wing: "x", similarity: 0.5, created_at: new Date(NOW - 30 * 86400 * 1000).toISOString() });
    const [first, second] = domainRerank([stale, recent], null, { now: NOW });
    expect(first.created_at).toBe(recent.created_at);
    expect(first.similarity!).toBeGreaterThan(second.similarity!);
  });

  test("missing created_at applies no recency bonus, doesn't crash", () => {
    const result = domainRerank(
      [drawer({ wing: "x", similarity: 0.7 })],
      null,
    );
    expect(result[0].similarity).toBeCloseTo(0.7 * 0.68 + 1.0 * 0.32, 3);
  });

  test("falls back from similarity → distance → 0 for base score", () => {
    const NOW = 1714000000000;
    // distance=0.2 maps to baseScore=0.8
    const onlyDistance = drawer({ wing: "x", distance: 0.2 });
    // similarity wins when both present
    const both = drawer({ wing: "x", similarity: 0.4, distance: 0.9 });
    // neither => baseScore=0
    const neither = drawer({ wing: "x" });
    const result = domainRerank([neither, both, onlyDistance], null, { now: NOW });
    expect(result[0]).toBe(result[0]); // sanity
    // Order: onlyDistance (0.8 base) > both (0.4 base) > neither (0 base)
    expect(result[0].distance).toBe(0.2);
    expect(result[1].similarity).not.toBeUndefined();
    expect(result[2].similarity).toBeCloseTo(0.32, 3); // 0 * 0.68 + 1 * 0.32
  });

  test("preserves all PalaceDrawer fields (topic, matched_via, cosine, bm25, id, room)", () => {
    const input: PalaceDrawer = {
      id: "drawer_abc",
      text: "x",
      wing: "personal",
      room: "hobbies",
      similarity: 0.7,
      cosine: 0.81,
      bm25: 0.42,
      topic: "general",
      matched_via: "drawer",
      created_at: undefined,
    };
    const [out] = domainRerank([input], null);
    expect(out.id).toBe("drawer_abc");
    expect(out.text).toBe("x");
    expect(out.wing).toBe("personal");
    expect(out.room).toBe("hobbies");
    expect(out.cosine).toBe(0.81);   // raw scores preserved
    expect(out.bm25).toBe(0.42);
    expect(out.topic).toBe("general");
    expect(out.matched_via).toBe("drawer");
  });

  test("returns a new array — does not mutate input", () => {
    const input = [drawer({ wing: "a", similarity: 0.5 })];
    const original = input[0].similarity;
    const out = domainRerank(input, null);
    expect(input[0].similarity).toBe(original);  // unchanged
    expect(out[0]).not.toBe(input[0]);            // new object
  });

  test("empty input returns empty", () => {
    expect(domainRerank([], null)).toEqual([]);
  });

  test("computes exact final score per spec formula (wing match)", () => {
    const NOW = 1714000000000;
    // wing match, no recency: base * 0.68 + 1.4 * 0.32
    const out = domainRerank(
      [drawer({ wing: "p", similarity: 0.5 })],
      "p",
      { now: NOW },
    );
    expect(out[0].similarity).toBeCloseTo(0.5 * 0.68 + 1.4 * 0.32, 4); // 0.34 + 0.448 = 0.788
  });

  test("computes exact final score with recency bonus", () => {
    const NOW = 1714000000000;
    const recentISO = new Date(NOW - 12 * 3600 * 1000).toISOString();
    const out = domainRerank(
      [drawer({ wing: "p", similarity: 0.5, created_at: recentISO })],
      "p",
      { now: NOW },
    );
    expect(out[0].similarity).toBeCloseTo(0.5 * 0.68 + 1.4 * 0.32 + 0.1, 4); // 0.888
  });
});

describe("baseScore — bm25 awareness", () => {
  // Helper builds a drawer with explicit cosine + bm25 (no similarity) so the
  // test isolates the new blend behavior. id is set so tests can identify
  // which drawer won by content (rerank returns new objects via spread).
  const cb = (id: string, cosine: number | undefined, bm25: number | undefined, similarity?: number): PalaceDrawer => ({
    id,
    text: "doc", wing: "projects", room: "test",
    ...(cosine !== undefined && { cosine }),
    ...(bm25 !== undefined && { bm25 }),
    ...(similarity !== undefined && { similarity }),
  });

  const NOW = Date.parse("2026-04-26T12:00:00Z");

  test("blends cosine and bm25 when both present (0.6/0.4 default)", () => {
    // q08-shape: keyword-strong, vector-weak drawer must outrank a vector-only winner.
    const a = cb("a", 0.4, 0.9);   // base = 0.4*0.6 + 0.9*0.4 = 0.60
    const b = cb("b", 0.5, 0.1);   // base = 0.5*0.6 + 0.1*0.4 = 0.34
    const out = domainRerank([a, b], null, { now: NOW });
    expect(out[0].id).toBe("a");
    expect(out[1].id).toBe("b");
  });

  test("falls back to similarity when cosine and bm25 absent (back-compat)", () => {
    const a = cb("a", undefined, undefined, 0.7);
    const b = cb("b", undefined, undefined, 0.3);
    const out = domainRerank([a, b], null, { now: NOW });
    expect(out[0].id).toBe("a");
  });

  test("uses cosine alone when bm25 absent but cosine present", () => {
    const a = cb("a", 0.7, undefined);
    const b = cb("b", 0.3, undefined);
    const out = domainRerank([a, b], null, { now: NOW });
    expect(out[0].id).toBe("a");
  });

  test("treats bm25 as 0 when only bm25 missing on one drawer", () => {
    const a = cb("a", 0.4, undefined);  // base = 0.4 * 0.6 = 0.24
    const b = cb("b", 0.4, 0.5);        // base = 0.4*0.6 + 0.5*0.4 = 0.44
    const out = domainRerank([a, b], null, { now: NOW });
    expect(out[0].id).toBe("b");
  });
});
