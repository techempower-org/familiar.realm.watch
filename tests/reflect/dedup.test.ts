import { test, expect, describe } from "bun:test";
import { dedupCheck } from "../../src/reflect/dedup.ts";
import type { ReflectCandidate } from "../../src/reflect/types.ts";
import type { PalaceClient } from "../../src/palace-client.ts";
import type { PalaceSearchResult, PalaceDrawer } from "../../src/types.ts";

// Minimal PalaceClient stub: only `search` is needed.
const stubPalace = (top?: PalaceDrawer): PalaceClient => ({
  search: async (): Promise<PalaceSearchResult> => ({
    query: "?",
    results: top ? [top] : [],
  }),
} as unknown as PalaceClient);

const cand = (fact: string): ReflectCandidate => ({ fact, source_span: [0, fact.length] });

describe("dedupCheck", () => {
  test("returns novel=true when palace returns no results", async () => {
    const out = await dedupCheck(cand("rlm is a recursive LM paradigm"), { palace: stubPalace(), threshold: 0.85 });
    expect(out.novel).toBe(true);
  });

  test("returns novel=true when top result similarity is below threshold", async () => {
    const top: PalaceDrawer = { id: "drawer_x", text: "loosely related", wing: "w", room: "r", similarity: 0.4 };
    const out = await dedupCheck(cand("rlm is a recursive LM paradigm"), { palace: stubPalace(top), threshold: 0.85 });
    expect(out.novel).toBe(true);
  });

  test("returns novel=false when top result meets threshold", async () => {
    const top: PalaceDrawer = { id: "drawer_y", text: "rlm is a recursive language model paradigm", wing: "w", room: "r", similarity: 0.92 };
    const out = await dedupCheck(cand("rlm is a recursive LM paradigm"), { palace: stubPalace(top), threshold: 0.85 });
    expect(out.novel).toBe(false);
    if (!out.novel) {
      expect(out.existing_drawer_id).toBe("drawer_y");
      expect(out.similarity).toBe(0.92);
    }
  });

  test("returns novel=true when top result is exactly at threshold (strict greater-than)", async () => {
    const top: PalaceDrawer = { id: "drawer_z", text: "boundary case", wing: "w", room: "r", similarity: 0.85 };
    const out = await dedupCheck(cand("a substantively unique claim about reflect"), { palace: stubPalace(top), threshold: 0.85 });
    expect(out.novel).toBe(true);
  });

  test("returns novel=true if top result has no id (defensive)", async () => {
    const top: PalaceDrawer = { text: "ghost drawer", wing: "w", room: "r", similarity: 0.99 };
    const out = await dedupCheck(cand("a candidate"), { palace: stubPalace(top), threshold: 0.85 });
    expect(out.novel).toBe(true);
  });
});
