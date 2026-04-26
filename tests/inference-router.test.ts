import { test, expect, describe } from "bun:test";
import { InferenceRouter } from "../src/inference-router.ts";
import type { InferenceChatProvider, OllamaChatChunk } from "../src/types.ts";

function makeProvider(opts: {
  healthy?: boolean;
  response?: string;
  failOnFirstChunk?: boolean;
}): InferenceChatProvider & { calls: number } {
  const provider = {
    calls: 0,
    isHealthy: () => Promise.resolve(opts.healthy ?? true),
    async *chatStream() {
      provider.calls++;
      if (opts.failOnFirstChunk) throw new Error("provider down");
      const text = opts.response ?? "default";
      yield {
        model: "test",
        created_at: "",
        message: { role: "assistant", content: text },
        done: false,
      } as OllamaChatChunk;
      yield { model: "test", created_at: "", done: true } as OllamaChatChunk;
    },
  };
  return provider;
}

async function collect(gen: AsyncGenerator<OllamaChatChunk>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of gen) {
    if (c.message?.content) out.push(c.message.content);
  }
  return out;
}

describe("InferenceRouter", () => {
  test("uses first provider when it succeeds — fallback never called", async () => {
    const primary = makeProvider({ response: "from primary" });
    const fallback = makeProvider({ response: "from fallback" });
    const router = new InferenceRouter([primary, fallback]);

    const out = await collect(router.chatStream({ messages: [{ role: "user", content: "hi" }] }));
    expect(out).toEqual(["from primary"]);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  test("falls back to next provider when first throws on first chunk", async () => {
    const primary = makeProvider({ failOnFirstChunk: true });
    const fallback = makeProvider({ response: "from fallback" });
    const router = new InferenceRouter([primary, fallback]);

    const out = await collect(router.chatStream({ messages: [{ role: "user", content: "hi" }] }));
    expect(out).toEqual(["from fallback"]);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  test("throws when ALL providers fail; error message includes per-provider details", async () => {
    const a = makeProvider({ failOnFirstChunk: true });
    const b = makeProvider({ failOnFirstChunk: true });
    const router = new InferenceRouter([a, b]);
    const gen = router.chatStream({ messages: [{ role: "user", content: "hi" }] });
    await expect(gen.next()).rejects.toThrow(/all inference endpoints/i);
  });

  test("skips providers whose circuit is open", async () => {
    const primary = makeProvider({ response: "primary" });
    const fallback = makeProvider({ response: "fallback" });
    const router = new InferenceRouter([primary, fallback], {
      threshold: 1,
      windowMs: 30_000,
      openMs: 60_000,
    });

    // Force the primary breaker open with one recorded failure
    try {
      await router.breakerFor(0).run(async () => { throw new Error("boom"); });
    } catch { /* expected */ }
    expect(router.breakerFor(0).state()).toBe("open");

    const out = await collect(router.chatStream({ messages: [{ role: "user", content: "hi" }] }));
    expect(out).toEqual(["fallback"]);
    expect(primary.calls).toBe(0); // skipped due to open circuit
    expect(fallback.calls).toBe(1);
  });

  test("isHealthy returns true if any provider is healthy", async () => {
    const a = makeProvider({ healthy: false });
    const b = makeProvider({ healthy: true });
    const router = new InferenceRouter([a, b]);
    expect(await router.isHealthy()).toBe(true);
  });

  test("isHealthy returns false when all providers are down", async () => {
    const a = makeProvider({ healthy: false });
    const b = makeProvider({ healthy: false });
    const router = new InferenceRouter([a, b]);
    expect(await router.isHealthy()).toBe(false);
  });

  test("constructor throws when no providers given", () => {
    expect(() => new InferenceRouter([])).toThrow(/at least one provider/i);
  });

  test("router itself satisfies InferenceChatProvider — recursive composition", async () => {
    const inner = new InferenceRouter([makeProvider({ response: "inner" })]);
    const outer = new InferenceRouter([inner]);
    const out = await collect(outer.chatStream({ messages: [{ role: "user", content: "hi" }] }));
    expect(out).toEqual(["inner"]);
  });
});
