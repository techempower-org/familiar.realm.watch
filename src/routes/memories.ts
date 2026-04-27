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

export async function handleMemoryDelete(req: Request, drawerId: string, deps: MemoriesRouteDeps): Promise<Response> {
  if (!drawerId || !drawerId.startsWith("drawer_")) {
    return new Response(JSON.stringify({ error: "drawer_id required (drawer_*)" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  try {
    await deps.palace.deleteDrawer(drawerId);
    return new Response(JSON.stringify({ deleted: drawerId }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}

export async function handleMemoryPatch(req: Request, drawerId: string, deps: MemoriesRouteDeps): Promise<Response> {
  if (!drawerId || !drawerId.startsWith("drawer_")) {
    return new Response(JSON.stringify({ error: "drawer_id required (drawer_*)" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  let body: { content?: unknown; wing?: unknown; room?: unknown };
  try {
    body = (await req.json()) as { content?: unknown; wing?: unknown; room?: unknown };
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  const patch: { content?: string; wing?: string; room?: string } = {};
  if (typeof body.content === "string") patch.content = body.content;
  if (typeof body.wing === "string") patch.wing = body.wing;
  if (typeof body.room === "string") patch.room = body.room;
  if (Object.keys(patch).length === 0) {
    return new Response(JSON.stringify({ error: "at least one of content/wing/room required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  try {
    await deps.palace.updateDrawer(drawerId, patch);
    return new Response(JSON.stringify({ updated: drawerId, fields: Object.keys(patch) }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}

export async function handleMemories(req: Request, deps: MemoriesRouteDeps): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));

  try {
    // palace-daemon ≥1.7 exposes /list — query-free metadata listing
    // by wing/room. That's the right path for browsing reflect-wing
    // drawers (the /search wing filter is honored only on vector
    // matches; with no embeddable content it falls back to BM25 and
    // ignores the filter).
    const result = await deps.palace.listDrawers({
      wing: deps.reflectWing,
      room: sessionId ?? undefined,
      limit,
    });
    const list = (result.results ?? []).slice();
    // Sort by created_at descending (most recent first).
    list.sort((a, b) => {
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      return bt - at;
    });
    const drawers = list.map((d) => ({
      id: d.id,
      text: d.text,
      room: d.room,
      wing: d.wing,
      created_at: d.created_at,
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
