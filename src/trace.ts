/**
 * Trace helpers — assemble per-turn structured records.
 *
 * Trace is the per-turn ledger that downstream consumers (eval, viz, fine-tune
 * corpus, debugging) all read from. See `Trace` in types.ts for the full shape.
 */

import type { SmeEntity, Trace } from "./types.ts";

// Matches drawer-id citations only. The captured group is always the
// bare drawer id.
//
// Variants accepted:
//   [drawer_xxxxx]                — canonical
//   [drawer_id: drawer_xxxxx]     — label-prefixed
//   [drawer_id=drawer_xxxxx]      — equals form
//   [id: drawer_xxxxx]            — shortened label
//   [id=drawer_xxxxx]             — shortened equals
//   [drawer=drawer_xxxxx]         — drawer= form (phi-4 emits this)
//
// Explicitly NOT matched here: source-header forms like
// `[wing=... · room=...]` or `[drawer=general · room=...]`. Those are
// echoed-back system-prompt headers, not citations — the UI renders
// them as source chips (see web/app.js CITATION_PATTERN variant B) and
// they must NOT contribute to trace.citations.
const CITATION_PATTERN = /\[(?:(?:drawer_id|id|drawer)\s*[:=]\s*)?(drawer_[a-z0-9_]+)\]/g;

/**
 * Extract unique drawer_id citations referenced in an assistant response.
 * Canonical pattern is `[drawer_xxxxxx]`; we also accept a few common
 * model-creative variants like `[drawer_id: drawer_xxx]` and
 * `[drawer=drawer_xxx]` (observed live on phi-4-Q4_K_M, 2026-05-15).
 *
 * Source-header forms (`[wing=... · room=...]`, `[drawer=general · room=...]`)
 * are NOT extracted as citations — those are echoes of the palace-context
 * block, rendered by the UI as source chips.
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
