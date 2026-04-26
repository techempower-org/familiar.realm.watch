/**
 * Multi-endpoint inference router with per-endpoint circuit breakers.
 *
 * Tries providers in priority order. On each call:
 *  - Skip providers whose circuit is open.
 *  - Run inside the breaker's run() — failures record, success closes.
 *  - On any provider failure, move to the next provider.
 *  - When all providers fail/are-open, throw.
 *
 * Implements `InferenceChatProvider` itself so it's recursive-friendly:
 * a router can wrap other routers (flat composition is the v0.2 default,
 * but the recursive path is the seam where rlm-style decomposition slots
 * in for v0.3+).
 *
 * Streaming is preserved end-to-end: we eagerly pull the FIRST chunk
 * inside breaker.run() so a failing provider records a breaker failure,
 * then yield the buffered first chunk + the rest of the stream outside
 * the breaker. This is the standard pattern for "fail-fast or commit"
 * stream routing.
 */

import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.ts";
import type { ChatStreamOpts } from "./ollama-client.ts";
import type { InferenceChatProvider, OllamaChatChunk } from "./types.ts";

const DEFAULT_BREAKER: CircuitBreakerOptions = {
  threshold: 3,
  windowMs: 30_000,
  openMs: 60_000,
};

export class InferenceRouter implements InferenceChatProvider {
  private readonly providers: InferenceChatProvider[];
  private readonly breakers: CircuitBreaker[];

  constructor(providers: InferenceChatProvider[], breakerOpts?: Partial<CircuitBreakerOptions>) {
    if (providers.length === 0) {
      throw new Error("InferenceRouter requires at least one provider");
    }
    this.providers = providers;
    const opts = { ...DEFAULT_BREAKER, ...breakerOpts };
    this.breakers = providers.map(() => new CircuitBreaker(opts));
  }

  /** Test-only: expose breakers by index to drive forced state in tests. */
  breakerFor(i: number): CircuitBreaker {
    return this.breakers[i];
  }

  async isHealthy(): Promise<boolean> {
    for (const p of this.providers) {
      if (await p.isHealthy()) return true;
    }
    return false;
  }

  async *chatStream(opts: ChatStreamOpts): AsyncGenerator<OllamaChatChunk> {
    const errors: string[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const breaker = this.breakers[i];
      if (breaker.state() === "open") {
        errors.push(`provider[${i}]: circuit open`);
        continue;
      }

      // Eagerly pull the first chunk inside breaker.run so failures record.
      // If first .next() resolves, the upstream is committed — we stream the rest.
      let firstChunk: OllamaChatChunk | undefined;
      let gen: AsyncGenerator<OllamaChatChunk> | undefined;
      try {
        await breaker.run(async () => {
          gen = this.providers[i].chatStream(opts);
          const first = await gen.next();
          if (!first.done) firstChunk = first.value;
        });
      } catch (err) {
        errors.push(`provider[${i}]: ${(err as Error).message}`);
        continue;
      }

      // Provider committed — yield buffered first chunk + remainder.
      if (firstChunk) yield firstChunk;
      if (gen) {
        for await (const chunk of gen) yield chunk;
      }
      return;
    }

    throw new Error(`all inference endpoints failed or circuit-broken: [${errors.join("; ")}]`);
  }
}
