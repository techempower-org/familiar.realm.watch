import { test, expect, describe } from "bun:test";
import { buildTrace, extractCitations, traceSummary } from "../src/trace.ts";
import type { SmeEntity } from "../src/types.ts";

describe("extractCitations", () => {
  test("extracts unique drawer_ids from text", () => {
    const text = "Per [drawer_abc123] you enjoy hiking, also see [drawer_xyz] and [drawer_abc123].";
    expect(extractCitations(text).sort()).toEqual(["drawer_abc123", "drawer_xyz"]);
  });

  test("returns empty array when no citations present", () => {
    expect(extractCitations("nothing cited here")).toEqual([]);
  });

  test("ignores malformed citations", () => {
    expect(extractCitations("[drawer] [drawer_] [DRAWER_abc] text")).toEqual([]);
  });

  test("handles a single citation", () => {
    expect(extractCitations("see [drawer_xyz] for context")).toEqual(["drawer_xyz"]);
  });

  test("extracts drawer ids containing underscores (real-world ids)", () => {
    // Real drawer ids look like drawer_storyvox_architecture_bae0315aac3371d96e5d11d4
    // The old regex `drawer_[a-z0-9]+` would truncate after the first underscore.
    const text = "see [drawer_familiar_realm_watch_sessions_abc123]";
    expect(extractCitations(text)).toEqual(["drawer_familiar_realm_watch_sessions_abc123"]);
  });

  test("tolerates label-prefixed variants the model emits", () => {
    // Observed live on familiar.jphe.in: model wrote `[drawer_id: drawer_xxx]`
    // because the system prompt's "[drawer_id]" was interpreted as a literal
    // label. New regex accepts both bare and labeled forms.
    expect(extractCitations("see [drawer_id: drawer_abc] and [id=drawer_xyz]").sort())
      .toEqual(["drawer_abc", "drawer_xyz"]);
  });

  test("tolerates [drawer=drawer_xxx] form (phi-4-Q4_K_M, 2026-05-15)", () => {
    // Observed live: phi-4 drifts toward `[drawer=drawer_xxx]`, mixing the
    // source-header `drawer=...` key into a real citation. Accept it.
    expect(extractCitations("see [drawer=drawer_abc] and [drawer:drawer_xyz]").sort())
      .toEqual(["drawer_abc", "drawer_xyz"]);
  });

  test("does NOT extract source-header [wing=... · room=...] as a citation", () => {
    // Observed live on phi-4-Q4_K_M (2026-05-15): model copies the
    // palace-context source headers verbatim. These render as source chips
    // in the UI but must NOT be treated as drawer citations — they have no
    // drawer_id to look up.
    const text = "per [wing=familiar_realm_watch · room=references · date=2026-05-15 · similarity=0.803] you use bun";
    expect(extractCitations(text)).toEqual([]);
  });

  test("does NOT extract [drawer=general · room=...] source-header variant", () => {
    // Observed live: phi-4 sometimes emits the source-header form with
    // `drawer=` instead of `wing=`. Still a header, still not a citation.
    const text = "see [drawer=general · room=discoveries · date=2026-05-11] for context";
    expect(extractCitations(text)).toEqual([]);
  });

  test("dedups across mixed bare and labeled forms", () => {
    const text = "first [drawer_abc] then [drawer_id: drawer_abc] then [id:drawer_abc] then [drawer=drawer_abc]";
    expect(extractCitations(text)).toEqual(["drawer_abc"]);
  });
});

describe("buildTrace", () => {
  const entity: SmeEntity = {
    id: "drawer_abc",
    type: "drawer",
    wing: "personal",
    room: "hobbies",
    content_snippet: "User enjoys hiking",
  };

  test("populates all required fields", () => {
    const t = buildTrace({
      sessionId: "session-1",
      query: "What are my hobbies?",
      wingScope: "personal",
      entities: [entity],
      contextString: "system prompt",
      answer: "You enjoy hiking [drawer_abc].",
      warnings: [],
      availableInScope: 42,
      startedAt: Date.now() - 100,
    });

    expect(t.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.session_id).toBe("session-1");
    expect(t.query).toBe("What are my hobbies?");
    expect(t.wing_scope).toBe("personal");
    expect(t.retrieved).toEqual([entity]);
    expect(t.context_string).toBe("system prompt");
    expect(t.answer).toBe("You enjoy hiking [drawer_abc].");
    expect(t.citations).toEqual(["drawer_abc"]);
    expect(t.available_in_scope).toBe(42);
    expect(t.duration_ms).toBeGreaterThanOrEqual(100);
    expect(t.duration_ms).toBeLessThan(2000);
    expect(t.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("citations field auto-derives from answer", () => {
    const t = buildTrace({
      sessionId: "s",
      query: "q",
      wingScope: null,
      entities: [],
      contextString: "",
      answer: "Two refs: [drawer_one] and [drawer_two]",
      warnings: [],
      startedAt: Date.now(),
    });
    expect(t.citations.sort()).toEqual(["drawer_one", "drawer_two"]);
  });

  test("each call gets a unique trace_id", () => {
    const a = buildTrace({ sessionId: "s", query: "q", wingScope: null, entities: [], contextString: "", answer: "", warnings: [], startedAt: Date.now() });
    const b = buildTrace({ sessionId: "s", query: "q", wingScope: null, entities: [], contextString: "", answer: "", warnings: [], startedAt: Date.now() });
    expect(a.trace_id).not.toBe(b.trace_id);
  });
});

describe("traceSummary", () => {
  test("includes glyph, id prefix, duration, drawer count, citation count", () => {
    const t = buildTrace({
      sessionId: "s",
      query: "q",
      wingScope: null,
      entities: [{ id: "d1", type: "drawer" }, { id: "d2", type: "drawer" }],
      contextString: "",
      answer: "[drawer_a]",
      warnings: [],
      startedAt: Date.now() - 50,
    });
    const summary = traceSummary(t);
    expect(summary).toContain("✦ trace");
    expect(summary).toContain("2d");
    expect(summary).toContain("1cit");
    expect(summary).toMatch(/\d+ms/);
  });

  test("includes warnings when present", () => {
    const t = buildTrace({
      sessionId: "s",
      query: "q",
      wingScope: null,
      entities: [],
      contextString: "",
      answer: "",
      warnings: ["palace_unreachable", "budget_dropped_2"],
      startedAt: Date.now(),
    });
    const summary = traceSummary(t);
    expect(summary).toContain("palace_unreachable");
    expect(summary).toContain("budget_dropped_2");
  });

  test("omits warnings bracket when empty", () => {
    const t = buildTrace({ sessionId: "s", query: "q", wingScope: null, entities: [], contextString: "", answer: "", warnings: [], startedAt: Date.now() });
    expect(traceSummary(t)).not.toContain("[");
  });
});
