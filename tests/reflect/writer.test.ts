import { test, expect, describe } from "bun:test";
import { ReflectWriter } from "../../src/reflect/writer.ts";
import type { InferenceChatProvider, OllamaChatChunk, PalaceSearchResult, PalaceDrawer } from "../../src/types.ts";
import type { PalaceClient, WriteMemoryOpts } from "../../src/palace-client.ts";

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

function stubPalace(
  searchResult: PalaceDrawer | undefined,
  writeSpy?: (opts: WriteMemoryOpts) => Promise<void>,
): PalaceClient {
  return {
    search: async (): Promise<PalaceSearchResult> => ({
      query: "?",
      results: searchResult ? [searchResult] : [],
    }),
    writeMemory: writeSpy ?? (async () => {}),
  } as unknown as PalaceClient;
}

const FIVE_GOOD_FACTS = JSON.stringify([
  { fact: "rlm is a recursive language model paradigm", source_span: [0, 40] },
  { fact: "DiaryBuffer flushes every 10 turns or on session end", source_span: [50, 100] },
]);

describe("ReflectWriter.review", () => {
  test("writes facts that pass gate and are novel", async () => {
    const writes: WriteMemoryOpts[] = [];
    const palace = stubPalace(undefined, async (opts) => { writes.push(opts); });
    const writer = new ReflectWriter({
      palace,
      inference: stubInference(FIVE_GOOD_FACTS),
      threshold: 0.85,
      maxFactsPerTurn: 5,
      wing: "reflect",
    });
    const decisions = await writer.review({ sessionId: "s1", assistantTurn: "irrelevant" });
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.status === "written")).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0].wing).toBe("reflect");
    expect(writes[0].room).toBe("s1");
  });

  test("gates short or refusal-shaped facts", async () => {
    const json = JSON.stringify([
      { fact: "I don't have that information.", source_span: [0, 30] },
      { fact: "x", source_span: [0, 1] },
      { fact: "rlm is a recursive language model paradigm", source_span: [40, 80] },
    ]);
    const writes: WriteMemoryOpts[] = [];
    const palace = stubPalace(undefined, async (opts) => { writes.push(opts); });
    const writer = new ReflectWriter({
      palace,
      inference: stubInference(json),
      threshold: 0.85,
      maxFactsPerTurn: 5,
      wing: "reflect",
    });
    const decisions = await writer.review({ sessionId: "s2", assistantTurn: "x" });
    expect(decisions).toHaveLength(3);
    expect(decisions[0].status).toBe("gated");
    expect(decisions[1].status).toBe("gated");
    expect(decisions[2].status).toBe("written");
    expect(writes).toHaveLength(1);
  });

  test("dedupes against existing palace content", async () => {
    const top: PalaceDrawer = { id: "drawer_existing", text: "near-match", wing: "w", room: "r", similarity: 0.92 };
    const writes: WriteMemoryOpts[] = [];
    const palace = stubPalace(top, async (opts) => { writes.push(opts); });
    const writer = new ReflectWriter({
      palace,
      inference: stubInference(JSON.stringify([{ fact: "rlm is a recursive language model paradigm", source_span: [0, 40] }])),
      threshold: 0.85,
      maxFactsPerTurn: 5,
      wing: "reflect",
    });
    const decisions = await writer.review({ sessionId: "s3", assistantTurn: "x" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("duplicate");
    expect(decisions[0].existing_drawer_id).toBe("drawer_existing");
    expect(writes).toHaveLength(0);
  });

  test("returns empty when extractor yields no candidates", async () => {
    const writer = new ReflectWriter({
      palace: stubPalace(undefined),
      inference: stubInference("[]"),
      threshold: 0.85,
      maxFactsPerTurn: 5,
      wing: "reflect",
    });
    const decisions = await writer.review({ sessionId: "s4", assistantTurn: "x" });
    expect(decisions).toEqual([]);
  });

  test("survives palace.writeMemory throwing — marks decision as gated with reason", async () => {
    const palace = stubPalace(undefined, async () => { throw new Error("daemon down"); });
    const writer = new ReflectWriter({
      palace,
      inference: stubInference(JSON.stringify([{ fact: "a substantively long candidate fact", source_span: [0, 30] }])),
      threshold: 0.85,
      maxFactsPerTurn: 5,
      wing: "reflect",
    });
    const decisions = await writer.review({ sessionId: "s5", assistantTurn: "x" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("gated");
    expect(decisions[0].reason).toBe("write_failed");
  });
});
