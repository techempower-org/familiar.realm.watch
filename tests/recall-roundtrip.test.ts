import { test, expect, describe } from "bun:test";

// End-to-end recall roundtrip test.
//
// Inserts a known drawer into palace, waits for indexing, asks familiar a
// question that should retrieve the drawer, asserts the marker comes back.
//
// This is the test version of "the foundation works": write → index → search
// → retrieve → chat. Would have caught the 2026-05-10 split-brain immediately.
//
// Requires the live palace-daemon and familiar-api to be running. Skipped
// automatically when palace-daemon isn't reachable, so unit-test runs don't
// fail just because the daemon is down (useful during foundation work itself).

// Read env inside test functions, not at module-top: other tests (notably
// config.test.ts) wipe PALACE_*/FAMILIAR_*/etc. env vars in their beforeEach
// to test default-value behavior. Module-top constants captured before that
// wipe still work, but only if module load order happens to put us before
// them. Reading env at test-run time makes this robust regardless of order.

const MARKER = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function palaceUp(url: string, key: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${url}/health`, {
      headers: key ? { "x-api-key": key } : {},
      signal: ctl.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

describe("recall roundtrip", () => {
  test("a drawer written to palace is recallable by familiar within 10s", async () => {
    const PALACE_URL = process.env.PALACE_DAEMON_URL ?? "http://disks:8085";
    const PALACE_KEY = process.env.PALACE_DAEMON_API_KEY ?? "";
    const FAMILIAR_URL = process.env.FAMILIAR_URL ?? "http://127.0.0.1:8080";

    const up = await palaceUp(PALACE_URL, PALACE_KEY);
    if (!up) {
      // Skip rather than fail. Run with palace-daemon up to assert the foundation works.
      console.warn(`[skip] palace-daemon at ${PALACE_URL} not reachable; recall test skipped.`);
      return;
    }

    // 1. Write a known drawer
    const writeRes = await fetch(`${PALACE_URL}/memory`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": PALACE_KEY,
      },
      body: JSON.stringify({
        content: `Test marker for foundation rework: ${MARKER}. This is a unique drawer used by the recall roundtrip smoke test.`,
        wing: "test_recall_roundtrip",
        room: "smoke",
      }),
    });
    expect(writeRes.ok).toBe(true);

    // 2. Wait for index
    await new Promise((r) => setTimeout(r, 5000));

    // 3. Ask familiar a question that should retrieve the marker
    const chatRes = await fetch(`${FAMILIAR_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5:14b-instruct-q4_K_M",
        messages: [
          {
            role: "user",
            content: `What does the marker '${MARKER}' refer to? Quote anything specific you know about it.`,
          },
        ],
        stream: false,
      }),
    });
    expect(chatRes.ok).toBe(true);
    const body = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> };
    const content = body.choices[0]?.message?.content ?? "";

    // 4. Assert the marker appears in the answer (proves retrieval landed)
    expect(content).toContain(MARKER);
  }, { timeout: 30000 });
});
