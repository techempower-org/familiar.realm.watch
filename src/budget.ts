import type { PalaceDrawer } from "./types.ts";

/**
 * Estimate tokens for a string. Heuristic: 1 token per 4 chars for English prose.
 * Swap for tiktoken in production if accuracy matters — Emmimal cites ~15% error.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface AllocateResult {
  kept: PalaceDrawer[];
  dropped: PalaceDrawer[];
  usedTokens: number;
}

/**
 * Slot allocator for palace context. Drops lowest-similarity drawers
 * when over budget, preserving input order for the kept set (so a prior
 * rerank order stays intact).
 */
export function allocateContext(drawers: PalaceDrawer[], budgetTokens: number): AllocateResult {
  const withTokens = drawers.map((d) => ({ drawer: d, tokens: estimateTokens(d.text) }));

  const working = [...withTokens];
  while (sumTokens(working) > budgetTokens && working.length > 0) {
    let lowestIdx = 0;
    for (let i = 1; i < working.length; i++) {
      const a = working[i].drawer.similarity ?? 0;
      const b = working[lowestIdx].drawer.similarity ?? 0;
      if (a < b) lowestIdx = i;
    }
    working.splice(lowestIdx, 1);
  }

  const keptSet = new Set(working.map((w) => w.drawer));
  const kept = drawers.filter((d) => keptSet.has(d));
  const dropped = drawers.filter((d) => !keptSet.has(d));
  return { kept, dropped, usedTokens: sumTokens(working) };
}

function sumTokens(xs: { tokens: number }[]): number {
  let sum = 0;
  for (const x of xs) sum += x.tokens;
  return sum;
}
