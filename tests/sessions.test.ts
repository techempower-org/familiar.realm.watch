import { test, expect, describe } from "bun:test";
import { SessionStore } from "../src/sessions.ts";

describe("SessionStore", () => {
  test("creates a session and returns it by id", () => {
    const store = new SessionStore({ ttlMinutes: 60 });
    const session = store.create();
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = store.get(session.id);
    expect(fetched).toEqual(session);
  });

  test("updates lastSeenAt when getting a session", () => {
    let now = 1000;
    const store = new SessionStore({ ttlMinutes: 60, now: () => now });
    const s = store.create();
    expect(s.lastSeenAt).toBe(1000);
    now = 2000;
    const fetched = store.get(s.id);
    expect(fetched!.lastSeenAt).toBe(2000);
  });

  test("expires a session after ttl", () => {
    let now = 1000;
    const store = new SessionStore({ ttlMinutes: 1, now: () => now });
    const s = store.create();
    expect(store.get(s.id)).toBeDefined();
    now += 61 * 1000; // 61 seconds later (past 1-minute TTL)
    expect(store.get(s.id)).toBeUndefined();
  });

  test("appendTurn pushes a message to recentTurns", () => {
    const store = new SessionStore({ ttlMinutes: 60 });
    const s = store.create();
    store.appendTurn(s.id, { role: "user", content: "hello" });
    store.appendTurn(s.id, { role: "assistant", content: "hi" });
    const fetched = store.get(s.id)!;
    expect(fetched.recentTurns).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("appendTurn on unknown session is a no-op", () => {
    const store = new SessionStore({ ttlMinutes: 60 });
    expect(() => store.appendTurn("nonexistent", { role: "user", content: "x" })).not.toThrow();
  });

  test("markCitations adds drawer ids to recentCitations without duplicates", () => {
    const store = new SessionStore({ ttlMinutes: 60 });
    const s = store.create();
    store.markCitations(s.id, ["drawer_a", "drawer_b"]);
    store.markCitations(s.id, ["drawer_b", "drawer_c"]);
    const fetched = store.get(s.id)!;
    expect(fetched.recentCitations.sort()).toEqual(["drawer_a", "drawer_b", "drawer_c"]);
  });

  test("purgeExpired removes expired sessions", () => {
    let now = 1000;
    const store = new SessionStore({ ttlMinutes: 1, now: () => now });
    const s1 = store.create();
    now += 30 * 1000;
    const s2 = store.create();
    now += 31 * 1000; // s1 expired, s2 still alive
    store.purgeExpired();
    expect(store.get(s1.id)).toBeUndefined();
    expect(store.get(s2.id)).toBeDefined();
  });
});
