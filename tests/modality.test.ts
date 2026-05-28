import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectQueryIntent, modalityWeight, intensify, getModalityIntensity } from "../src/retrieval/modality.ts";
import type { PalaceDrawer } from "../src/types.ts";

function drawer(
  partial: Partial<PalaceDrawer> & Pick<PalaceDrawer, "room">,
): PalaceDrawer {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    text: partial.text ?? "x",
    wing: partial.wing ?? "w",
    room: partial.room,
    similarity: partial.similarity,
    distance: partial.distance,
    created_at: partial.created_at,
    topic: partial.topic,
    cosine: partial.cosine,
    bm25: partial.bm25,
    matched_via: partial.matched_via,
  };
}

describe("detectQueryIntent", () => {
  test("classifies detail queries (what/which/exact/version/port/path/file/config/error/log)", () => {
    expect(detectQueryIntent("what port is llama-server on")).toBe("detail");
    expect(detectQueryIntent("which file holds the config")).toBe("detail");
    expect(detectQueryIntent("exact version of phi-4")).toBe("detail");
    expect(detectQueryIntent("show me the error log")).toBe("detail");
    expect(detectQueryIntent("where is the path to the model")).toBe("detail");
  });

  test("classifies synthesis queries (how/why/overview/explain/describe/architecture)", () => {
    expect(detectQueryIntent("how does retrieval work")).toBe("synthesis");
    expect(detectQueryIntent("why did we pick postgres")).toBe("synthesis");
    expect(detectQueryIntent("explain the design")).toBe("synthesis");
    expect(detectQueryIntent("describe the architecture")).toBe("synthesis");
    expect(detectQueryIntent("overview of the stack")).toBe("synthesis");
    expect(detectQueryIntent("compare hybrid to vector")).toBe("synthesis");
  });

  test("classifies as general when both detail and synthesis signals match", () => {
    // "what" (detail) + "how" (synthesis)
    expect(detectQueryIntent("what is the path and how is it used")).toBe("general");
    // "which" + "why"
    expect(detectQueryIntent("which file and why was it chosen")).toBe("general");
  });

  test("classifies as general when neither pattern matches", () => {
    expect(detectQueryIntent("tell me about cats")).toBe("general");
    expect(detectQueryIntent("hello there")).toBe("general");
    expect(detectQueryIntent("")).toBe("general");
  });

  test("matching is case-insensitive", () => {
    expect(detectQueryIntent("WHAT IS THE PORT")).toBe("detail");
    expect(detectQueryIntent("How Does This Work")).toBe("synthesis");
  });
});

describe("modalityWeight", () => {
  beforeEach(() => {
    delete (Bun.env as Record<string, string | undefined>).PALACE_MODALITY_WEIGHT;
  });
  afterEach(() => {
    delete (Bun.env as Record<string, string | undefined>).PALACE_MODALITY_WEIGHT;
  });

  test("applies correct multiplier for references × detail (1.0)", () => {
    const out = modalityWeight([drawer({ room: "references", similarity: 0.5 })], "detail");
    expect(out[0].similarity).toBeCloseTo(0.5, 6);
  });

  test("applies correct multiplier for references × synthesis (0.85)", () => {
    const out = modalityWeight([drawer({ room: "references", similarity: 0.5 })], "synthesis");
    expect(out[0].similarity).toBeCloseTo(0.5 * 0.85, 6);
  });

  test("applies correct multiplier for architecture × detail (0.85)", () => {
    const out = modalityWeight([drawer({ room: "architecture", similarity: 0.5 })], "detail");
    expect(out[0].similarity).toBeCloseTo(0.5 * 0.85, 6);
  });

  test("applies correct multiplier for architecture × synthesis (1.15)", () => {
    const out = modalityWeight([drawer({ room: "architecture", similarity: 0.5 })], "synthesis");
    expect(out[0].similarity).toBeCloseTo(0.5 * 1.15, 6);
  });

  test("applies correct multiplier for decisions × synthesis (1.1)", () => {
    const out = modalityWeight([drawer({ room: "decisions", similarity: 0.4 })], "synthesis");
    expect(out[0].similarity).toBeCloseTo(0.4 * 1.1, 6);
  });

  test("applies correct multiplier for diary × general (0.9)", () => {
    const out = modalityWeight([drawer({ room: "diary", similarity: 0.5 })], "general");
    expect(out[0].similarity).toBeCloseTo(0.5 * 0.9, 6);
  });

  test("full room×intent matrix matches the spec", () => {
    const matrix: Record<string, Record<string, number>> = {
      references:   { detail: 1.0,  synthesis: 0.85, general: 1.0 },
      problems:     { detail: 1.0,  synthesis: 0.9,  general: 1.0 },
      sessions:     { detail: 1.0,  synthesis: 0.95, general: 1.0 },
      architecture: { detail: 0.85, synthesis: 1.15, general: 1.0 },
      decisions:    { detail: 0.9,  synthesis: 1.1,  general: 1.0 },
      planning:     { detail: 0.85, synthesis: 1.1,  general: 1.0 },
      discoveries:  { detail: 0.95, synthesis: 1.1,  general: 1.0 },
      diary:        { detail: 0.8,  synthesis: 0.9,  general: 0.9 },
    };
    for (const room of Object.keys(matrix)) {
      for (const intent of ["detail", "synthesis", "general"]) {
        const [out] = modalityWeight([drawer({ room, similarity: 1.0 })], intent);
        expect(out.similarity).toBeCloseTo(matrix[room][intent], 6);
      }
    }
  });

  test("results are re-sorted by adjusted similarity", () => {
    // architecture (1.15× on synthesis) starts behind references (0.85×) but should overtake
    const arch = drawer({ id: "arch", room: "architecture", similarity: 0.6 });
    const refs = drawer({ id: "refs", room: "references", similarity: 0.65 });
    const out = modalityWeight([refs, arch], "synthesis");
    // arch: 0.6 * 1.15 = 0.69; refs: 0.65 * 0.85 = 0.5525
    expect(out[0].id).toBe("arch");
    expect(out[1].id).toBe("refs");
  });

  test("unknown room gets 1.0× (no crash)", () => {
    const out = modalityWeight([drawer({ room: "weirdroom", similarity: 0.7 })], "detail");
    expect(out[0].similarity).toBeCloseTo(0.7, 6);
  });

  test("missing similarity treated as 0", () => {
    const out = modalityWeight([drawer({ room: "architecture" })], "synthesis");
    expect(out[0].similarity).toBe(0);
  });

  test("unknown intent string falls back to general", () => {
    const out = modalityWeight([drawer({ room: "architecture", similarity: 0.5 })], "weird-intent");
    expect(out[0].similarity).toBeCloseTo(0.5, 6); // architecture × general = 1.0
  });

  test("PALACE_MODALITY_WEIGHT=off returns results unchanged", () => {
    Bun.env.PALACE_MODALITY_WEIGHT = "off";
    const input = [drawer({ room: "architecture", similarity: 0.6 }), drawer({ room: "references", similarity: 0.65 })];
    const out = modalityWeight(input, "synthesis");
    expect(out).toBe(input); // identity — unchanged
  });

  test("PALACE_MODALITY_WEIGHT=false returns results unchanged", () => {
    Bun.env.PALACE_MODALITY_WEIGHT = "false";
    const input = [drawer({ room: "architecture", similarity: 0.6 })];
    const out = modalityWeight(input, "synthesis");
    expect(out).toBe(input);
  });

  test("PALACE_MODALITY_WEIGHT=0 returns results unchanged", () => {
    Bun.env.PALACE_MODALITY_WEIGHT = "0";
    const input = [drawer({ room: "architecture", similarity: 0.6 })];
    const out = modalityWeight(input, "synthesis");
    expect(out).toBe(input);
  });

  test("PALACE_MODALITY_WEIGHT=on applies weighting normally", () => {
    Bun.env.PALACE_MODALITY_WEIGHT = "on";
    const out = modalityWeight([drawer({ room: "architecture", similarity: 0.5 })], "synthesis");
    expect(out[0].similarity).toBeCloseTo(0.5 * 1.15, 6);
  });

  test("empty input returns empty", () => {
    expect(modalityWeight([], "detail")).toEqual([]);
  });

  test("preserves all PalaceDrawer fields", () => {
    const input: PalaceDrawer = {
      id: "drawer_abc",
      text: "hello",
      wing: "personal",
      room: "decisions",
      similarity: 0.5,
      cosine: 0.6,
      bm25: 0.4,
      topic: "general",
      matched_via: "drawer",
      created_at: "2026-05-20T00:00:00Z",
    };
    const [out] = modalityWeight([input], "synthesis");
    expect(out.id).toBe("drawer_abc");
    expect(out.text).toBe("hello");
    expect(out.wing).toBe("personal");
    expect(out.room).toBe("decisions");
    expect(out.cosine).toBe(0.6);
    expect(out.bm25).toBe(0.4);
    expect(out.topic).toBe("general");
    expect(out.matched_via).toBe("drawer");
    expect(out.created_at).toBe("2026-05-20T00:00:00Z");
    expect(out.similarity).toBeCloseTo(0.5 * 1.1, 6);
  });
});

describe("intensify (#72 widening multiplier)", () => {
  test("intensity 1.0 returns factor unchanged", () => {
    expect(intensify(0.85, 1.0)).toBeCloseTo(0.85, 6);
    expect(intensify(1.15, 1.0)).toBeCloseTo(1.15, 6);
    expect(intensify(1.0, 1.0)).toBe(1.0);
  });

  test("intensity 2.0 doubles the distance from neutral", () => {
    expect(intensify(0.85, 2.0)).toBeCloseTo(0.7, 6);   // 1 - 2*(1-0.85)
    expect(intensify(1.15, 2.0)).toBeCloseTo(1.3, 6);   // 1 + 2*(1.15-1)
    expect(intensify(1.0, 2.0)).toBe(1.0);              // neutral stays neutral
  });

  test("intensity 0.0 collapses every factor to 1.0 (ablation arm)", () => {
    expect(intensify(0.5, 0.0)).toBe(1.0);
    expect(intensify(1.5, 0.0)).toBe(1.0);
    expect(intensify(0.85, 0.0)).toBe(1.0);
  });

  test("intensity 2.5 (Aurora rec) widens 0.85→0.625 and 1.15→1.375", () => {
    expect(intensify(0.85, 2.5)).toBeCloseTo(0.625, 6);
    expect(intensify(1.15, 2.5)).toBeCloseTo(1.375, 6);
  });
});

describe("getModalityIntensity (#72 env parsing)", () => {
  const ORIG = Bun.env.PALACE_MODALITY_INTENSITY;
  afterEach(() => {
    if (ORIG === undefined) delete Bun.env.PALACE_MODALITY_INTENSITY;
    else Bun.env.PALACE_MODALITY_INTENSITY = ORIG;
  });

  test("defaults to 1.0 when env unset", () => {
    delete Bun.env.PALACE_MODALITY_INTENSITY;
    expect(getModalityIntensity()).toBe(1.0);
  });

  test("parses a numeric env value", () => {
    Bun.env.PALACE_MODALITY_INTENSITY = "2.5";
    expect(getModalityIntensity()).toBe(2.5);
  });

  test("falls back to 1.0 on negative or NaN input", () => {
    Bun.env.PALACE_MODALITY_INTENSITY = "-1";
    expect(getModalityIntensity()).toBe(1.0);
    Bun.env.PALACE_MODALITY_INTENSITY = "garbage";
    expect(getModalityIntensity()).toBe(1.0);
  });

  test("intensity flows through to modalityWeight (widened factors observable)", () => {
    Bun.env.PALACE_MODALITY_INTENSITY = "2.5";
    const out = modalityWeight(
      [drawer({ id: "a", room: "architecture", similarity: 1.0 }),
       drawer({ id: "b", room: "references",   similarity: 1.0 })],
      "synthesis",
    );
    // architecture×synthesis = 1.15 → intensified at 2.5 = 1.375
    // references×synthesis   = 0.85 → intensified at 2.5 = 0.625
    const a = out.find((d) => d.id === "a")!;
    const b = out.find((d) => d.id === "b")!;
    expect(a.similarity).toBeCloseTo(1.375, 6);
    expect(b.similarity).toBeCloseTo(0.625, 6);
    expect(out[0].id).toBe("a");   // architecture sorts above references for synthesis
    expect(out[1].id).toBe("b");
  });
});
