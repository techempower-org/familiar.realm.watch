/**
 * Emmimal component 3 — exponential temporal decay.
 *
 * After domain rerank, multiply each drawer's score by an age-based decay
 * factor so older drawers fade unless they have a strong reason to surface.
 *
 *   decayed = score × exp(−λ × age_days)
 *   λ       = ln(2) / half_life_days
 *
 * At age = half_life_days, score halves. Default half-life is 30 days
 * (matches the v0.1 design spec).
 *
 * Drawers with no `created_at` keep their score unchanged — we don't have
 * the age signal to apply decay. Drawers with malformed timestamps likewise
 * pass through; we never crash on bad metadata.
 *
 * Applied client-side because palace-daemon doesn't yet ship Weibull-flavored
 * decay (upstream PR #1032). When it lands, this module becomes a no-op or
 * gets removed.
 */

import type { PalaceDrawer } from "../types.ts";

export interface DecayOptions {
  halfLifeDays: number;
  /** For deterministic tests; defaults to Date.now(). */
  now?: number;
}

const MS_PER_DAY = 86_400_000;

export function temporalDecay(drawers: PalaceDrawer[], opts: DecayOptions): PalaceDrawer[] {
  const lambda = Math.log(2) / opts.halfLifeDays;
  const now = opts.now ?? Date.now();

  return drawers.map((d) => {
    const base = d.similarity ?? d.distance ?? 0;
    if (!d.created_at) return { ...d, similarity: base };
    const ts = Date.parse(d.created_at);
    if (Number.isNaN(ts)) return { ...d, similarity: base };
    const ageDays = (now - ts) / MS_PER_DAY;
    if (ageDays < 0) return { ...d, similarity: base };  // future-dated; don't penalize
    const decayed = base * Math.exp(-lambda * ageDays);
    return { ...d, similarity: decayed };
  });
}
