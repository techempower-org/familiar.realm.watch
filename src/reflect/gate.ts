/**
 * Quality gate for reflect candidates.
 *
 * Returns null if the candidate passes (proceed to dedup). Returns a
 * ReflectDecision with status "gated" if the candidate fails.
 *
 * Conservative: better to drop borderline content than to write
 * hallucinations to palace.
 */

import type { ReflectCandidate, ReflectDecision } from "./types.ts";

const REFUSAL_PATTERNS: RegExp[] = [
  /\bI\s+don'?t\s+(have|know)\b/i,
  /\bI\s+do\s+not\s+(have|know)\b/i,
  /\bI'?m\s+not\s+(sure|able|certain)\b/i,
  /\bI\s+am\s+not\s+(sure|able|certain)\b/i,
  /\bcan'?t\s+(find|locate|determine)\b/i,
  /\bcannot\s+(find|locate|determine)\b/i,
  /\bunable\s+to\b/i,
];

const LEADING_HEDGE_RE = /^\s*(?:maybe|perhaps|possibly|might|could\s+be)\b/i;

const MIN_LENGTH = 20;

export function gate(candidate: ReflectCandidate): ReflectDecision | null {
  const text = candidate.fact;
  const trimmed = text.trim();

  if (trimmed.length < MIN_LENGTH) {
    return { candidate, status: "gated", reason: "too_short" };
  }
  for (const p of REFUSAL_PATTERNS) {
    if (p.test(trimmed)) {
      return { candidate, status: "gated", reason: "refusal_pattern" };
    }
  }
  if (LEADING_HEDGE_RE.test(trimmed)) {
    return { candidate, status: "gated", reason: "leading_hedge" };
  }
  return null;
}
