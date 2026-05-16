/**
 * Emmimal component 2 — domain-weighted rerank.
 *
 * After palace-daemon returns the top-N by vector similarity, we adjust the
 * score with metadata-aware signals: wing match (drawer wing matches the
 * active scope), and recency (last 48h). No ML model — pure client-side math.
 *
 * Formula (from the v0.1 design spec):
 *
 *   final = base_score × 0.68
 *         + tag_importance × 0.32
 *         + recency_bonus
 *
 *   tag_importance = 1.4 if drawer.wing === wingScope, else 1.0
 *   recency_bonus  = 0.3 if drawer is < 48h old, else 0
 *
 * Recency was 0.1 originally; bumped to 0.3 after issue #26 — palace-wide
 * retrieval without a wing scope was ranking generic stale drawers (BM25-rich
 * general/sessions wings) above freshly-written wing-authoritative ones.
 * 0.3 is large enough to dominate the BM25 lead on stale generic drawers
 * while still letting older drawers compete on raw similarity. Live test:
 * the "what model is running" query that previously surfaced 0 of the top-10
 * from familiar_realm_watch now returns the relevant decision drawer first.
 *
 * The function preserves all PalaceDrawer fields (topic, matched_via, cosine,
 * bm25 etc.) via spread; only `similarity` is replaced with the final score.
 * The raw `cosine` and `bm25` fields stay intact for /api/familiar/eval and
 * downstream telemetry.
 *
 * Note on graph-flavored futures: when palace-daemon goes Postgres, this is
 * the seed schema for stigmergic edge weights — the per-drawer adjustment
 * lifts to per-edge weight on traversed paths.
 */

import type { PalaceDrawer } from "../types.ts";

const WING_WEIGHT = 0.68;
const TAG_WEIGHT = 0.32;
const WING_BOOST = 1.4;
const NEUTRAL_WEIGHT = 1.0;
const RECENCY_BONUS = 0.3;
const RECENCY_WINDOW_MS = 48 * 3600 * 1000;

function tagImportance(drawer: PalaceDrawer, wingScope: string | null): number {
  if (wingScope && drawer.wing === wingScope) return WING_BOOST;
  return NEUTRAL_WEIGHT;
}

function recencyBonus(drawer: PalaceDrawer, now: number): number {
  if (!drawer.created_at) return 0;
  const ts = Date.parse(drawer.created_at);
  if (Number.isNaN(ts)) return 0;
  const age = now - ts;
  return age >= 0 && age <= RECENCY_WINDOW_MS ? RECENCY_BONUS : 0;
}

function baseScore(drawer: PalaceDrawer): number {
  // Prefer similarity (already in [0,1]); fall back to inverted distance, then 0.
  if (typeof drawer.similarity === "number") return drawer.similarity;
  if (typeof drawer.distance === "number") return Math.max(0, 1 - drawer.distance);
  return 0;
}

function finalScore(drawer: PalaceDrawer, wingScope: string | null, now: number): number {
  return baseScore(drawer) * WING_WEIGHT
    + tagImportance(drawer, wingScope) * TAG_WEIGHT
    + recencyBonus(drawer, now);
}

export interface DomainRerankOptions {
  /** For deterministic tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Reorder drawers by domain-weighted score, descending.
 * Returns a new array; does not mutate the input. Preserves all fields
 * (topic, matched_via, cosine, bm25, …) via spread; only `similarity` is
 * overwritten with the final score.
 */
export function domainRerank(
  drawers: PalaceDrawer[],
  wingScope: string | null,
  opts: DomainRerankOptions = {},
): PalaceDrawer[] {
  const now = opts.now ?? Date.now();
  return drawers
    .map((d) => ({ ...d, similarity: finalScore(d, wingScope, now) }))
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}
