/**
 * POST /api/familiar/reflect
 *
 * Operator-triggered (v0.3) reflect entry point. Body:
 *   { session_id: string, assistant_turn: string }
 *
 * Returns:
 *   { decisions: ReflectDecision[], summary: { written, gated, duplicate } }
 *
 * v0.4 will wire automatic per-session triggering via Stop-hook.
 */

import type { ReflectWriter } from "../reflect/writer.ts";
import type { ReflectDecision } from "../reflect/types.ts";

export interface ReflectRouteDeps {
  writer: ReflectWriter;
}

export async function handleReflect(req: Request, deps: ReflectRouteDeps): Promise<Response> {
  let body: { session_id?: unknown; assistant_turn?: unknown };
  try {
    body = (await req.json()) as { session_id?: unknown; assistant_turn?: unknown };
  } catch {
    return jsonErr("invalid JSON body", 400);
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return jsonErr("session_id required", 400);
  }
  if (typeof body.assistant_turn !== "string" || !body.assistant_turn) {
    return jsonErr("assistant_turn required", 400);
  }

  const decisions: ReflectDecision[] = await deps.writer.review({
    sessionId: body.session_id,
    assistantTurn: body.assistant_turn,
  });

  const summary = {
    written: decisions.filter((d) => d.status === "written").length,
    gated: decisions.filter((d) => d.status === "gated").length,
    duplicate: decisions.filter((d) => d.status === "duplicate").length,
  };
  return new Response(JSON.stringify({ decisions, summary }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonErr(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
