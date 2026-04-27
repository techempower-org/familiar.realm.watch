/**
 * GET /api/familiar/memories?session_id=&limit=
 *
 * Returns reflect-written drawers from the configured reflect wing.
 * Supports optional session_id filter (matches palace-side `room`)
 * and a limit cap. Read-only — no write paths.
 *
 * Response shape:
 *   { wing: "reflect", count, drawers: [{id, text, room, created_at, ...}] }
 *
 * Note on filtering: palace-daemon `/search` supports `wing` + `room`
 * but requires a query string. We use a wildcard-ish probe ("*") and
 * rely on the wing/room filter to constrain results — same pattern
 * the daemon's listing tools use.
 */

import type { PalaceClient } from "../palace-client.ts";

export interface MemoriesRouteDeps {
  palace: PalaceClient;
  /** Wing where reflect writes drawers — must match ReflectWriterDeps.wing. */
  reflectWing: string;
}

export async function handleMemories(req: Request, deps: MemoriesRouteDeps): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));

  try {
    const search = await deps.palace.search({
      // Empty/wildcard query: the daemon returns rows that match the wing filter
      // ranked by recency when the query has no informational content.
      query: "*",
      wing: deps.reflectWing,
      room: sessionId ?? undefined,
      limit,
      kind: "content",
    });
    const drawers = (search.results ?? []).map((d) => ({
      id: d.id,
      text: d.text,
      room: d.room,
      wing: d.wing,
      created_at: d.created_at,
      similarity: d.similarity,
    }));
    return new Response(
      JSON.stringify({ wing: deps.reflectWing, count: drawers.length, drawers }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message, drawers: [] }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
