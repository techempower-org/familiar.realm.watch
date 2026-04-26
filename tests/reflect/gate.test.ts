import { test, expect, describe } from "bun:test";
import { gate } from "../../src/reflect/gate.ts";
import type { ReflectCandidate } from "../../src/reflect/types.ts";

const cand = (fact: string): ReflectCandidate => ({ fact, source_span: [0, fact.length] });

describe("gate", () => {
  test("passes a substantive factual claim", () => {
    expect(gate(cand("The palace-daemon kind=content filter excludes Stop-hook autosave checkpoints from search results."))).toBeNull();
  });

  test("blocks 'I don't have' refusals", () => {
    const d = gate(cand("I don't have that information in the palace."));
    expect(d?.status).toBe("gated");
    expect(d?.reason).toBe("refusal_pattern");
  });

  test("blocks 'I'm not sure' hedges", () => {
    const d = gate(cand("I'm not sure exactly when this was added."));
    expect(d?.status).toBe("gated");
    expect(d?.reason).toBe("refusal_pattern");
  });

  test("blocks 'unable to' refusals", () => {
    const d = gate(cand("Unable to determine the exact version."));
    expect(d?.status).toBe("gated");
    expect(d?.reason).toBe("refusal_pattern");
  });

  test("blocks leading hedges", () => {
    const d = gate(cand("Maybe palace-daemon supports that feature."));
    expect(d?.status).toBe("gated");
    expect(d?.reason).toBe("leading_hedge");
  });

  test("does not block internal hedge words", () => {
    expect(gate(cand("The kind=content filter is the default; maybe most operators don't override it."))).toBeNull();
  });

  test("blocks too-short candidates (< 20 chars)", () => {
    const d = gate(cand("Yes."));
    expect(d?.status).toBe("gated");
    expect(d?.reason).toBe("too_short");
  });

  test("blocks empty candidates", () => {
    const d = gate(cand("   "));
    expect(d?.status).toBe("gated");
    expect(d?.reason).toBe("too_short");
  });
});
