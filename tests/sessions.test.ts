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

  test("create() initializes recentQueryHashes as empty array", () => {
    const store = new SessionStore({ ttlMinutes: 60 });
    const s = store.create();
    expect(s.recentQueryHashes).toEqual([]);
  });

  describe("stuck detection", () => {
    test("isStuck returns false on a fresh session", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      const s = store.create();
      expect(store.isStuck(s.id, "what are my projects?")).toBe(false);
    });

    test("isStuck returns true after near-identical queries repeat", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      const s = store.create();
      // Realistic "user asks the same thing" — only the trailing modifier varies.
      store.markQuery(s.id, "tell me about my recent hiking adventures");
      store.markQuery(s.id, "tell me about my recent hiking adventures please");
      expect(store.isStuck(s.id, "tell me about my recent hiking adventures again")).toBe(true);
    });

    test("isStuck returns false when queries are different topics", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      const s = store.create();
      store.markQuery(s.id, "what are my hobbies");
      store.markQuery(s.id, "where did I work last summer");
      expect(store.isStuck(s.id, "tell me about my friends")).toBe(false);
    });

    test("markQuery caps history at 10 entries", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      const s = store.create();
      for (let i = 0; i < 15; i++) {
        store.markQuery(s.id, `query number ${i}`);
      }
      const fetched = store.get(s.id)!;
      expect(fetched.recentQueryHashes.length).toBe(10);
      // Oldest should be query number 5 (0-4 dropped)
      expect(fetched.recentQueryHashes[0]).toContain("5");
    });

    test("markQuery on unknown session is a no-op", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      expect(() => store.markQuery("nonexistent", "x")).not.toThrow();
    });

    test("isStuck on unknown session returns false", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      expect(store.isStuck("nonexistent", "anything")).toBe(false);
    });

    test("isStuck ignores trivial short words", () => {
      const store = new SessionStore({ ttlMinutes: 60 });
      const s = store.create();
      // These all have only short connector words in common
      store.markQuery(s.id, "is the sky blue");
      store.markQuery(s.id, "is the sea wet");
      expect(store.isStuck(s.id, "is the cat asleep")).toBe(false);
    });
  });
});
