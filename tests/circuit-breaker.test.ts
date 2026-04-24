import { test, expect, describe } from "bun:test";
import { CircuitBreaker } from "../src/circuit-breaker.ts";

describe("CircuitBreaker", () => {
  test("starts closed and allows calls", async () => {
    const cb = new CircuitBreaker({ threshold: 3, windowMs: 30_000, openMs: 60_000 });
    expect(cb.state()).toBe("closed");
    const out = await cb.run(async () => "ok");
    expect(out).toBe("ok");
  });

  test("opens after threshold failures within window", async () => {
    let now = 1000;
    const cb = new CircuitBreaker({ threshold: 3, windowMs: 30_000, openMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) {
      try {
        await cb.run(async () => { throw new Error("boom"); });
      } catch { /* expected */ }
      now += 100;
    }
    expect(cb.state()).toBe("open");
  });

  test("rejects calls while open", async () => {
    let now = 1000;
    const cb = new CircuitBreaker({ threshold: 1, windowMs: 30_000, openMs: 60_000, now: () => now });
    try { await cb.run(async () => { throw new Error("boom"); }); } catch {}
    expect(cb.state()).toBe("open");
    await expect(cb.run(async () => "ok")).rejects.toThrow(/circuit open/i);
  });

  test("transitions to half-open after openMs and recovers on success", async () => {
    let now = 1000;
    const cb = new CircuitBreaker({ threshold: 1, windowMs: 30_000, openMs: 500, now: () => now });
    try { await cb.run(async () => { throw new Error("boom"); }); } catch {}
    expect(cb.state()).toBe("open");

    now += 600; // past openMs
    const out = await cb.run(async () => "ok");
    expect(out).toBe("ok");
    expect(cb.state()).toBe("closed");
  });

  test("half-open probe failure re-opens", async () => {
    let now = 1000;
    const cb = new CircuitBreaker({ threshold: 1, windowMs: 30_000, openMs: 500, now: () => now });
    try { await cb.run(async () => { throw new Error("boom"); }); } catch {}
    now += 600;
    try { await cb.run(async () => { throw new Error("still boom"); }); } catch {}
    expect(cb.state()).toBe("open");
  });

  test("old failures outside window don't count toward threshold", async () => {
    let now = 1000;
    const cb = new CircuitBreaker({ threshold: 3, windowMs: 1_000, openMs: 60_000, now: () => now });
    try { await cb.run(async () => { throw new Error("1"); }); } catch {}
    now += 2_000; // past window
    try { await cb.run(async () => { throw new Error("2"); }); } catch {}
    try { await cb.run(async () => { throw new Error("3"); }); } catch {}
    expect(cb.state()).toBe("closed"); // only 2 failures within 1s window
  });
});
