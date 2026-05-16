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

  test("includes all drawers with metadata tags (YAML-style header)", () => {
    // 2026-05-16: switched source-header rendering from [bracketed tags]
    // to plain colon-separated YAML-style lines because every model we
    // tested was copying the bracketed shape into citations. Tests now
    // check for the new `key: value` form. Plus a synthetic `cite-as:`
    // line that gives the model a verbatim bracketed drawer-id to copy.
    const drawers = [mkDrawer({ id: "a" }), mkDrawer({ id: "b", wing: "homelab", room: "openwrt" })];
    const prompt = buildSystemPrompt({ drawers, warnings: [], availableInScope: 1000, wingScope: null });
    expect(prompt).toContain("drawer_id: a");
    expect(prompt).toContain("drawer_id: b");
    expect(prompt).toContain("wing: realmwatch");
    expect(prompt).toContain("wing: homelab");
    expect(prompt).toContain("cite-as: [a]");
    expect(prompt).toContain("cite-as: [b]");
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

  test("includes grounding directives (faithfulness/citation/persona-meta/ambiguity)", () => {
    const prompt = buildSystemPrompt({ drawers: [], warnings: [], availableInScope: 0, wingScope: null });
    expect(prompt).toMatch(/prefer the palace context/i);
    // Directive teaches citations via a [drawer_xxx_yyy_zzz]-shaped example
    // (the literal id pattern). Previously used [drawer_id] which the
    // model interpreted as a literal label, then [drawer_xxx] which phi-4
    // copied as a header — see the regex fix in src/trace.ts. Accept any
    // historical bracketed-drawer form.
    // The placeholder format has evolved over the day:
    //   v1: [drawer_id]                         — model read as literal label
    //   v2: [drawer_xxx]                        — model copied verbatim
    //   v3: [drawer_xxx_yyy_zzz]                — same drift, model copied
    //   v4 (current): [drawer_<wing>_<room>_<hash>]  — angle-bracket placeholders
    //       paired with an explicit "do NOT invent IDs" line so the model
    //       must extract from the actual context block, not the directive.
    expect(prompt).toMatch(/\[drawer_(?:id|xxx|xxx_yyy_zzz|<wing>_<room>_<hash>)\]/);
    expect(prompt).toMatch(/answer from your persona/i);
    expect(prompt).toMatch(/name the ambiguity/i);
    expect(prompt).toMatch(/don't force-cite/i);
  });

  test("source-header lines are not in bracketed shape (model couldn't be talked out of copying them)", () => {
    // 2026-05-16: previous attempts (PR #19, #24, #27) added stronger
    // and stronger language to the directive telling the model not to
    // copy `[wing=... · room=... · date=...]` style headers as
    // citations. phi-4 14B kept doing it anyway across 3 rounds. The
    // structural fix is to not show that shape in the input at all —
    // headers are rendered as plain `wing: foo` YAML-style lines now,
    // and the only bracketed thing the model sees is the explicit
    // `cite-as: [drawer_xxx]` line ready to copy verbatim.
    const drawers = [mkDrawer({ id: "abc" })];
    const prompt = buildSystemPrompt({ drawers, warnings: [], availableInScope: 1, wingScope: null });
    // Bracketed source-header shape MUST NOT appear in the rendered
    // context (the precondition the model copies from).
    expect(prompt).not.toMatch(/\[wing=/);
    expect(prompt).not.toMatch(/\[drawer=/);
    // The cite-as line is the only bracketed thing the model sees
    // in the context block.
    expect(prompt).toContain("cite-as: [abc]");
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

  test("includes a Now anchor with weekday + date + time (clock pattern)", () => {
    // Mid-day on a known date so toLocaleDateString returns deterministic weekday.
    const fixedNow = new Date("2026-04-26T15:30:00");
    const prompt = buildSystemPrompt({
      drawers: [], warnings: [], availableInScope: 0, wingScope: null,
      now: fixedNow,
    });
    expect(prompt).toContain("── Now ──");
    expect(prompt).toContain("Sunday");
    expect(prompt).toContain("2026-04-26");
    expect(prompt).toMatch(/15:30/);
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
