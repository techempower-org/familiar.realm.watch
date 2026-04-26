import type { Session, ChatMessage } from "./types.ts";

export interface SessionStoreOptions {
  ttlMinutes: number;
  now?: () => number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: SessionStoreOptions) {
    this.ttlMs = opts.ttlMinutes * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  create(): Session {
    const id = crypto.randomUUID();
    const ts = this.now();
    const session: Session = {
      id,
      createdAt: ts,
      lastSeenAt: ts,
      recentTurns: [],
      recentCitations: [],
      recentQueryHashes: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const now = this.now();
    if (now - s.lastSeenAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeenAt = now;
    return s;
  }

  appendTurn(id: string, message: ChatMessage): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.recentTurns.push(message);
    s.lastSeenAt = this.now();
  }

  markCitations(id: string, drawerIds: string[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const did of drawerIds) {
      if (!s.recentCitations.includes(did)) s.recentCitations.push(did);
    }
    s.lastSeenAt = this.now();
  }

  /** Normalize a query for hash comparison: lowercase, collapse whitespace, drop short words. */
  private static normalizeQuery(query: string): string {
    return query
      .slice(0, 200)
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Record a user query for stuck-loop detection. Caps history at 10 entries per session. */
  markQuery(id: string, query: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (!s.recentQueryHashes) s.recentQueryHashes = [];
    s.recentQueryHashes.push(SessionStore.normalizeQuery(query));
    if (s.recentQueryHashes.length > 10) s.recentQueryHashes.shift();
    s.lastSeenAt = this.now();
  }

  /**
   * True when the current query has high word-overlap with at least N recent
   * queries from this session. Default N=2, threshold=0.7 Jaccard.
   */
  isStuck(id: string, query: string, threshold = 2, jaccardCutoff = 0.7): boolean {
    const s = this.sessions.get(id);
    if (!s?.recentQueryHashes?.length) return false;
    const current = SessionStore.normalizeQuery(query);
    const currentSet = new Set(current.split(" ").filter((w) => w.length > 2));
    if (currentSet.size === 0) return false;

    let similar = 0;
    for (const past of s.recentQueryHashes) {
      const pastSet = new Set(past.split(" ").filter((w) => w.length > 2));
      if (pastSet.size === 0) continue;
      let hits = 0;
      for (const w of currentSet) if (pastSet.has(w)) hits++;
      const union = currentSet.size + pastSet.size - hits;
      const j = union === 0 ? 0 : hits / union;
      if (j >= jaccardCutoff) similar++;
    }
    return similar >= threshold;
  }

  purgeExpired(): number {
    const now = this.now();
    let purged = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > this.ttlMs) {
        this.sessions.delete(id);
        purged++;
      }
    }
    return purged;
  }

  size(): number {
    return this.sessions.size;
  }
}
