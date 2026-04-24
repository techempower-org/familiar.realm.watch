export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  threshold: number;
  windowMs: number;
  openMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private opts: CircuitBreakerOptions;
  private now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  state(): CircuitState {
    if (this.openedAt === null) return "closed";
    if (this.now() - this.openedAt >= this.opts.openMs) return "half-open";
    return "open";
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.state();
    if (s === "open") throw new Error("circuit open");
    try {
      const result = await fn();
      if (s === "half-open") {
        this.openedAt = null;
        this.failures = [];
      }
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordFailure(): void {
    const now = this.now();
    this.failures.push(now);
    // drop failures outside the window
    this.failures = this.failures.filter((t) => now - t <= this.opts.windowMs);
    if (this.state() === "half-open") {
      this.openedAt = now;
      return;
    }
    if (this.failures.length >= this.opts.threshold) {
      this.openedAt = now;
    }
  }
}
