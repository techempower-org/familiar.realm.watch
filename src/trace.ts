/**
 * Trace helpers — assemble per-turn structured records.
 *
 * Trace is the per-turn ledger that downstream consumers (eval, viz, fine-tune
 * corpus, debugging) all read from. See `Trace` in types.ts for the full shape.
 */

import type { SmeEntity, Trace } from "./types.ts";

// Matches:
//   [drawer_xxxxx]              — canonical
//   [drawer_id: drawer_xxxxx]   — label-prefixed (some models add the
//                                 label despite the system prompt)
//   [drawer_id=drawer_xxxxx]    — equals variant
//   [id: drawer_xxxxx]          — shortened label
//
// The captured group is always the bare drawer id. Optional whitespace
// around the label separator handles minor format drift.
const CITATION_PATTERN = /\[(?:(?:drawer_id|id)\s*[:=]\s*)?(drawer_[a-z0-9_]+)\]/g;

/**
 * Extract unique drawer_id citations referenced in an assistant response.
 * Canonical pattern is `[drawer_xxxxxx]`; we also accept a few common
 * model-creative variants like `[drawer_id: drawer_xxx]` (see issue: real
 * familiar response shipped with that bracketed-label form and rendered
 * as plain text because the matcher was too strict).
 */
export function extractCitations(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    ids.add(match[1]);
  }
  return [...ids];
}

export interface BuildTraceArgs {
  sessionId: string;
  query: string;
  wingScope: string | null;
  entities: SmeEntity[];
  contextString: string;
  answer: string;
  warnings: string[];
  availableInScope?: number;
  inferenceEndpoint?: string;
  startedAt: number;  // Date.now() at turn start
}

export function buildTrace(args: BuildTraceArgs): Trace {
  return {
    trace_id: crypto.randomUUID(),
    session_id: args.sessionId,
    ts: new Date().toISOString(),
    query: args.query,
    wing_scope: args.wingScope,
    retrieved: args.entities,
    context_string: args.contextString,
    answer: args.answer,
    citations: extractCitations(args.answer),
    warnings: args.warnings,
    available_in_scope: args.availableInScope,
    inference_endpoint: args.inferenceEndpoint,
    duration_ms: Date.now() - args.startedAt,
  };
}

/**
 * One-line summary suitable for journalctl. Uses ✦ glyph (memory ops) to
 * align with palace-daemon's themed logging.
 */
export function traceSummary(t: Trace): string {
  return `✦ trace ${t.trace_id.slice(0, 8)} ${t.duration_ms}ms ${t.retrieved.length}d ${t.citations.length}cit ${t.warnings.length ? `[${t.warnings.join(",")}]` : ""}`.trim();
}
