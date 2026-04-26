/**
 * GET /api/familiar/graph
 *
 * Thin proxy over palace-daemon's `GET /graph` (v1.6.0+) with a 30-second
 * in-memory cache. The daemon endpoint is heavy enough on big palaces (~0.4s
 * on 151K drawers) that the PWA / mempalace-viz / multipass adapter benefit
 * from caching at the familiar layer rather than each client polling raw.
 *
 * Cache key is global (no per-user variance — the palace structural snapshot
 * is shared across all sessions). On error, we fail open rather than serving
 * stale data: 502 with the underlying error string.
 */

import type { PalaceClient } from "../palace-client.ts";
import type { PalaceGraph } from "../types.ts";

export interface GraphRouteDeps {
  palace: PalaceClient;
  /** Cache TTL in milliseconds. Defaults to 30_000 (30s). */
  cacheTtlMs?: number;
  /** For deterministic tests; defaults to Date.now(). */
  now?: () => number;
}

interface CacheEntry {
  ts: number;
  data: PalaceGraph;
}

let cache: CacheEntry | null = null;

/** Test-only: clear the cache between cases. */
export function _resetGraphCache(): void {
  cache = null;
}

export async function handleGraph(_req: Request, deps: GraphRouteDeps): Promise<Response> {
  const ttl = deps.cacheTtlMs ?? 30_000;
  const now = (deps.now ?? Date.now)();

  if (cache && now - cache.ts < ttl) {
    return new Response(JSON.stringify(cache.data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-graph-cache": "hit",
        "x-graph-age-ms": String(now - cache.ts),
      },
    });
  }

  try {
    const data = await deps.palace.getGraph();
    cache = { ts: now, data };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-graph-cache": "miss",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
