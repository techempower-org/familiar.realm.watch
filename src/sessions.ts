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
