import { test, expect, describe } from "bun:test";
import { extractiveCompress } from "../../src/retrieval/compress.ts";
import type { PalaceDrawer } from "../../src/types.ts";

function d(text: string): PalaceDrawer {
  return { id: "x", text, wing: "w", room: "r", similarity: 0.8 };
}

describe("extractiveCompress", () => {
  test("short drawer (<= longThreshold chars) passes through unchanged", () => {
    const drawer = d("This is a short text under the threshold.");
    const [out] = extractiveCompress([drawer], "anything");
    expect(out.text).toBe(drawer.text);
  });

  test("drawer with few sentences passes through (<= keepSentences)", () => {
    const long = "A".repeat(600);
    const drawer = d(long); // single 'sentence' (no .!?)
    const [out] = extractiveCompress([drawer], "query");
    expect(out.text).toBe(drawer.text);
  });

  test("long drawer keeps top-K query-overlap sentences in original order", () => {
    const text = [
      "Sentence A discusses something unrelated to anything.",
      "Sentence B talks about hiking and mountains specifically.",
      "Sentence C also mentions hiking trails in detail.",
      "Sentence D is about cooking dinner.",
      "Sentence E covers rare birds in winter.",
    ].join(" ");
    // total ~250 chars; inflate to exceed default 500-char threshold
    const padded = text + " " + "x ".repeat(200);
    const [out] = extractiveCompress([d(padded)], "hiking trails");

    expect(out.text.length).toBeLessThan(padded.length);
    expect(out.text).toContain("hiking");
    // B and C should both be in (highest overlap), and B comes before C in the original
    const bIdx = out.text.indexOf("Sentence B");
    const cIdx = out.text.indexOf("Sentence C");
    if (bIdx !== -1 && cIdx !== -1) {
      expect(bIdx).toBeLessThan(cIdx);
    }
  });

  test("no query overlap → keeps any K sentences (still trims long drawers)", () => {
    const sents = Array.from({ length: 20 }, (_, i) => `Sentence ${i} talks about totally unrelated topics.`).join(" ");
    const [out] = extractiveCompress([d(sents)], "completely orthogonal vocabulary");
    expect(out.text.length).toBeLessThan(sents.length);
    // Default keepSentences=3 → output has 3 sentences worth of content
    const sentenceCount = out.text.split(/[.!?]/).filter((s) => s.trim().length > 0).length;
    expect(sentenceCount).toBe(3);
  });

  test("keepSentences option overrides default", () => {
    // Each sentence ~80 chars × 10 = 800 chars — exceeds default 500 threshold.
    const sents = Array.from(
      { length: 10 },
      (_, i) => `Sentence number ${i} contains keyword target word with extra padding here.`,
    ).join(" ");
    const [out] = extractiveCompress([d(sents)], "keyword", { keepSentences: 5 });
    const sentenceCount = out.text.split(/[.!?]/).filter((s) => s.trim().length > 0).length;
    expect(sentenceCount).toBe(5);
  });

  test("longThreshold option allows shorter drawers to be compressed", () => {
    const sents = "Sentence A. Sentence B about target. Sentence C. Sentence D about target. Sentence E.";
    const [out] = extractiveCompress(
      [d(sents)],
      "target",
      { longThreshold: 30, keepSentences: 2 },
    );
    expect(out.text.length).toBeLessThan(sents.length);
    expect(out.text).toContain("target");
  });

  test("preserves all PalaceDrawer fields", () => {
    const sents = Array.from({ length: 10 }, (_, i) => `Sentence ${i} something.`).join(" ");
    const input: PalaceDrawer = {
      id: "drawer_xyz", text: sents, wing: "personal", room: "hobbies",
      similarity: 0.9, cosine: 0.8, bm25: 0.4, topic: "t", matched_via: "drawer",
    };
    const [out] = extractiveCompress([input], "something");
    expect(out.id).toBe("drawer_xyz");
    expect(out.wing).toBe("personal");
    expect(out.cosine).toBe(0.8);
    expect(out.bm25).toBe(0.4);
    expect(out.similarity).toBe(0.9); // compress doesn't touch similarity
  });

  test("empty input returns empty", () => {
    expect(extractiveCompress([], "q")).toEqual([]);
  });

  test("doesn't mutate input drawer", () => {
    const sents = Array.from({ length: 10 }, (_, i) => `Sentence ${i} stuff.`).join(" ");
    const input = [d(sents)];
    const original = input[0].text;
    extractiveCompress(input, "q");
    expect(input[0].text).toBe(original);
  });
});
