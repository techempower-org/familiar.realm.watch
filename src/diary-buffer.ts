/**
 * In-memory accumulator for per-turn diary entries.
 *
 * Familiar's chat route fires `diaryBuffer.add(entry)` after every turn
 * (fire-and-forget); the buffer accumulates and flushes either when it
 * fills (default 10 entries) or when the operator manually calls flush()
 * — for example during graceful shutdown or end-of-session.
 *
 * Flush is delegated via `flushFn`, which familiar wires to
 * `palace.silentSave({...})`. The daemon's `/silent-save` endpoint is itself
 * queue-safe (writes to pending.jsonl during palace rebuilds), so DiaryBuffer
 * doesn't need its own retry loop — if flushFn throws, we put the entries
 * back at the head of the queue and let the next flush try again.
 */

type FlushFn = (entries: string[]) => Promise<void>;

export interface DiaryBufferOptions {
  flushSize: number;
  flushFn: FlushFn;
}

export class DiaryBuffer {
  private entries: string[] = [];
  private readonly flushFn: FlushFn;
  private readonly flushSize: number;
  private flushing = false;

  constructor(opts: DiaryBufferOptions) {
    this.flushSize = opts.flushSize;
    this.flushFn = opts.flushFn;
  }

  size(): number {
    return this.entries.length;
  }

  /** Add an entry. Auto-flushes when size threshold is reached. */
  async add(entry: string): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length >= this.flushSize) {
      await this.flush();
    }
  }

  /**
   * Flush all buffered entries via flushFn. No-op if empty or already
   * flushing (concurrent calls are coalesced). On flushFn error, entries
   * are restored to the head of the queue for the next attempt.
   */
  async flush(): Promise<void> {
    if (this.entries.length === 0 || this.flushing) return;
    this.flushing = true;
    const batch = this.entries.splice(0);
    try {
      await this.flushFn(batch);
    } catch (err) {
      // Restore entries at the head so the next flush attempt re-tries them.
      this.entries.unshift(...batch);
      throw err;
    } finally {
      this.flushing = false;
    }
  }
}
