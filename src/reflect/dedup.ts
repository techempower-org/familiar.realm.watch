/**
 * Dedup check — skip writing facts palace already knows.
 *
 * Calls palace.search with the fact text as the query; if the top
 * result's similarity strictly exceeds the threshold AND has an id,
 * we consider the fact already-known.
 */

import type { ReflectCandidate } from "./types.ts";
import type { PalaceClient } from "../palace-client.ts";

export interface DedupOptions {
  palace: PalaceClient;
  /** Cosine threshold the top result must strictly exceed for "duplicate". */
  threshold: number;
}

export type DedupResult =
  | { novel: true }
  | { novel: false; existing_drawer_id: string; similarity: number };

export async function dedupCheck(
  candidate: ReflectCandidate,
  opts: DedupOptions,
): Promise<DedupResult> {
  const result = await opts.palace.search({
    query: candidate.fact,
    limit: 1,
  });
  const top = result.results?.[0];
  if (!top) return { novel: true };
  const sim = typeof top.similarity === "number" ? top.similarity : 0;
  if (sim <= opts.threshold) return { novel: true };
  if (!top.id) return { novel: true }; // defensive: no id to reference
  return { novel: false, existing_drawer_id: top.id, similarity: sim };
}
