/**
 * Emmimal component 4 — extractive sentence compression.
 *
 * For drawers longer than a soft threshold (default 500 chars), select the
 * top-K sentences with highest word-overlap against the user query, then
 * restore those sentences in their original order. Drawers shorter than the
 * threshold pass through untouched.
 *
 * The compressed text replaces `drawer.text` for the prompt-composition step.
 * The full drawer body remains addressable by `drawer.id` — citations link
 * back to the verbatim original via the PWA citation popover or palace-daemon
 * `/memory/<id>`.
 *
 * No ML model — Jaccard-style word-overlap is enough at this scale and keeps
 * the path local + deterministic. When palace-daemon ships server-side
 * compression (upstream candidate), this module retires.
 */

import type { PalaceDrawer } from "../types.ts";

const DEFAULT_LONG_THRESHOLD = 500;
const DEFAULT_KEEP_SENTENCES = 3;

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\b\w+\b/g) ?? []));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / (a.size + b.size - hits);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

export interface CompressOptions {
  /** Drawers shorter than this pass through unchanged. */
  longThreshold?: number;
  /** Number of sentences to keep per long drawer. */
  keepSentences?: number;
}

function compressOne(
  drawer: PalaceDrawer,
  queryTokens: Set<string>,
  longThreshold: number,
  keepSentences: number,
): PalaceDrawer {
  if (drawer.text.length <= longThreshold) return drawer;
  const sentences = splitSentences(drawer.text);
  if (sentences.length <= keepSentences) return drawer;

  const scored = sentences.map((s, idx) => ({
    s,
    idx,
    score: jaccard(tokenize(s), queryTokens),
  }));

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, keepSentences)
    .sort((a, b) => a.idx - b.idx) // restore original sentence order
    .map((x) => x.s);

  return { ...drawer, text: top.join(" ") };
}

export function extractiveCompress(
  drawers: PalaceDrawer[],
  query: string,
  opts: CompressOptions = {},
): PalaceDrawer[] {
  const longThreshold = opts.longThreshold ?? DEFAULT_LONG_THRESHOLD;
  const keepSentences = opts.keepSentences ?? DEFAULT_KEEP_SENTENCES;
  const queryTokens = tokenize(query);
  return drawers.map((d) => compressOne(d, queryTokens, longThreshold, keepSentences));
}
