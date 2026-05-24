/**
 * Phase 0 — modality-aware retrieval weighting.
 *
 * Different rooms serve different query intents. Detail queries ("what port",
 * "which file", "exact version") want references / problems / sessions —
 * fact-shaped drawers. Synthesis queries ("how does X relate to Y", "why did
 * we choose", "describe the architecture") want architecture / decisions /
 * planning / discoveries — narrative-shaped drawers.
 *
 * Intent is classified by regex over the query; an explicit "general" bucket
 * covers the ambiguous case (both signals or neither). The weight table is
 * applied as a multiplier to the already-reranked similarity score, then
 * results are re-sorted. Unknown rooms (anything outside the canonical
 * taxonomy) get 1.0×.
 *
 * Toggle: PALACE_MODALITY_WEIGHT=off|false|0 disables and returns input
 * unchanged for the ablation arm of the eval probe.
 */

import type { PalaceDrawer } from "../types.ts";

export type QueryIntent = "detail" | "synthesis" | "general";

const DETAIL_SIGNALS = /\b(what|which|when|where|specific|exact|version|port|path|file|config|error|log)\b/i;
const SYNTHESIS_SIGNALS = /\b(how|why|overview|summarize|explain|describe|compare|relate|design|architecture)\b/i;

export function detectQueryIntent(query: string): QueryIntent {
  const detail = DETAIL_SIGNALS.test(query);
  const synthesis = SYNTHESIS_SIGNALS.test(query);
  if (detail && !synthesis) return "detail";
  if (synthesis && !detail) return "synthesis";
  return "general";
}

const ROOM_MODALITY: Record<string, Record<QueryIntent, number>> = {
  references:   { detail: 1.0,  synthesis: 0.85, general: 1.0 },
  problems:     { detail: 1.0,  synthesis: 0.9,  general: 1.0 },
  sessions:     { detail: 1.0,  synthesis: 0.95, general: 1.0 },
  architecture: { detail: 0.85, synthesis: 1.15, general: 1.0 },
  decisions:    { detail: 0.9,  synthesis: 1.1,  general: 1.0 },
  planning:     { detail: 0.85, synthesis: 1.1,  general: 1.0 },
  discoveries:  { detail: 0.95, synthesis: 1.1,  general: 1.0 },
  diary:        { detail: 0.8,  synthesis: 0.9,  general: 0.9 },
};

function isDisabled(): boolean {
  const v = (Bun.env.PALACE_MODALITY_WEIGHT ?? "").toLowerCase();
  return v === "off" || v === "false" || v === "0";
}

export function modalityWeight(results: PalaceDrawer[], queryIntent: string): PalaceDrawer[] {
  if (isDisabled()) return results;
  const intent: QueryIntent =
    queryIntent === "detail" || queryIntent === "synthesis" || queryIntent === "general"
      ? queryIntent
      : "general";
  return results
    .map((d) => {
      const base = d.similarity ?? 0;
      const factors = ROOM_MODALITY[d.room];
      const factor = factors ? factors[intent] : 1.0;
      return { ...d, similarity: base * factor };
    })
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}
