import { test, expect, describe } from "bun:test";
import { extractCandidates } from "../../src/reflect/extractor.ts";
import type { InferenceChatProvider, OllamaChatChunk } from "../../src/types.ts";

// Minimal InferenceChatProvider stub: yields a single chunk with given content.
function stubInference(jsonResponse: string): InferenceChatProvider {
  return {
    isHealthy: async () => true,
    chatStream: async function* (): AsyncGenerator<OllamaChatChunk> {
      yield {
        model: "stub",
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: jsonResponse },
        done: true,
      };
    },
  };
}

describe("extractCandidates", () => {
  test("parses a clean JSON array of facts", async () => {
    const inference = stubInference(JSON.stringify([
      { fact: "palace-daemon kind=content excludes Stop-hook checkpoints", source_span: [0, 50] },
      { fact: "DiaryBuffer flushes every 10 turns", source_span: [80, 120] },
    ]));
    const out = await extractCandidates("some assistant turn text", { inference, maxFacts: 5 });
    expect(out).toHaveLength(2);
    expect(out[0].fact).toContain("kind=content");
  });

  test("returns empty array when LLM returns invalid JSON", async () => {
    const inference = stubInference("not json at all");
    const out = await extractCandidates("turn", { inference, maxFacts: 5 });
    expect(out).toEqual([]);
  });

  test("returns empty array when LLM returns non-array JSON", async () => {
    const inference = stubInference(JSON.stringify({ not: "an array" }));
    const out = await extractCandidates("turn", { inference, maxFacts: 5 });
    expect(out).toEqual([]);
  });

  test("filters out malformed array entries (missing fact field)", async () => {
    const inference = stubInference(JSON.stringify([
      { fact: "valid claim", source_span: [0, 10] },
      { not_a_fact: "garbage" },
      { fact: "another valid claim", source_span: [20, 40] },
    ]));
    const out = await extractCandidates("turn", { inference, maxFacts: 5 });
    expect(out).toHaveLength(2);
    expect(out[0].fact).toBe("valid claim");
    expect(out[1].fact).toBe("another valid claim");
  });

  test("respects maxFacts limit (slices to maxFacts)", async () => {
    const inference = stubInference(JSON.stringify([
      { fact: "a", source_span: [0, 1] },
      { fact: "b", source_span: [1, 2] },
      { fact: "c", source_span: [2, 3] },
      { fact: "d", source_span: [3, 4] },
    ]));
    const out = await extractCandidates("turn", { inference, maxFacts: 2 });
    expect(out).toHaveLength(2);
  });

  test("strips ```json fences from LLM output", async () => {
    const inference = stubInference("```json\n" + JSON.stringify([{ fact: "fenced", source_span: [0, 6] }]) + "\n```");
    const out = await extractCandidates("turn", { inference, maxFacts: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].fact).toBe("fenced");
  });

  test("accepts bare-string array (small-model fallback)", async () => {
    const inference = stubInference(JSON.stringify([
      "rlm is a recursive language model paradigm",
      "DiaryBuffer flushes every 10 turns",
    ]));
    const out = await extractCandidates("turn", { inference, maxFacts: 5 });
    expect(out).toHaveLength(2);
    expect(out[0].fact).toBe("rlm is a recursive language model paradigm");
  });
});
