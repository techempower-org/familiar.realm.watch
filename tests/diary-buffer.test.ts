import { test, expect, describe } from "bun:test";
import { DiaryBuffer } from "../src/diary-buffer.ts";

describe("DiaryBuffer", () => {
  test("accumulates entries below flush threshold without flushing", async () => {
    const flushed: string[][] = [];
    const buf = new DiaryBuffer({
      flushSize: 10,
      flushFn: async (e) => { flushed.push(e); },
    });
    await buf.add("first");
    await buf.add("second");
    expect(buf.size()).toBe(2);
    expect(flushed.length).toBe(0);
  });

  test("auto-flushes when size threshold is reached", async () => {
    const flushed: string[][] = [];
    const buf = new DiaryBuffer({
      flushSize: 3,
      flushFn: async (e) => { flushed.push(e); },
    });
    await buf.add("a");
    await buf.add("b");
    await buf.add("c"); // triggers flush
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toEqual(["a", "b", "c"]);
    expect(buf.size()).toBe(0);
  });

  test("manual flush() empties the buffer", async () => {
    const flushed: string[][] = [];
    const buf = new DiaryBuffer({
      flushSize: 100,
      flushFn: async (e) => { flushed.push(e); },
    });
    await buf.add("only entry");
    await buf.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toEqual(["only entry"]);
    expect(buf.size()).toBe(0);
  });

  test("flushing an empty buffer is a no-op", async () => {
    let calls = 0;
    const buf = new DiaryBuffer({
      flushSize: 10,
      flushFn: async () => { calls++; },
    });
    await buf.flush();
    expect(calls).toBe(0);
  });

  test("entries restored to head if flushFn throws — next flush retries", async () => {
    let attempts = 0;
    const flushed: string[][] = [];
    const buf = new DiaryBuffer({
      flushSize: 100,
      flushFn: async (e) => {
        attempts++;
        if (attempts === 1) throw new Error("palace-daemon down");
        flushed.push(e);
      },
    });
    await buf.add("first");
    await buf.add("second");
    await expect(buf.flush()).rejects.toThrow(/palace-daemon down/);
    expect(buf.size()).toBe(2); // entries put back

    // Add a third, then retry flush — should send all three in order
    await buf.add("third");
    await buf.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toEqual(["first", "second", "third"]);
    expect(buf.size()).toBe(0);
  });

  test("concurrent flush calls coalesce — second is no-op while first runs", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const flushed: string[][] = [];
    const buf = new DiaryBuffer({
      flushSize: 100,
      flushFn: async (e) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        flushed.push(e);
        inFlight--;
      },
    });
    await buf.add("a");
    await buf.add("b");
    await Promise.all([buf.flush(), buf.flush(), buf.flush()]);
    expect(maxInFlight).toBe(1); // only one flushFn call ran at a time
    expect(flushed.length).toBe(1); // only the first flush actually fired
    expect(buf.size()).toBe(0);
  });

  test("flushSize=1 flushes immediately on every add", async () => {
    const flushed: string[][] = [];
    const buf = new DiaryBuffer({
      flushSize: 1,
      flushFn: async (e) => { flushed.push(e); },
    });
    await buf.add("a");
    await buf.add("b");
    expect(flushed.length).toBe(2);
    expect(flushed[0]).toEqual(["a"]);
    expect(flushed[1]).toEqual(["b"]);
  });
});
