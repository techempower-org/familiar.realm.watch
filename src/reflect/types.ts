/**
 * Reflect — write-side completion of the chat loop.
 *
 * When the assistant says something the palace doesn't know, reflect
 * extracts that fact, dedupes against existing drawers, and writes
 * it back. Off the chat hot path; failures degrade silently.
 *
 * See docs/superpowers/specs/2026-04-26-familiar-v0.3-design.md.
 */

/** A fact pulled from an assistant turn, candidate for palace writeback. */
export interface ReflectCandidate {
  /** The factual claim, as a self-contained sentence. */
  fact: string;
  /** [start, end] char offsets into the source assistant text. */
  source_span: [number, number];
}

/** Per-candidate decision: written, gated, or already-known. */
export interface ReflectDecision {
  candidate: ReflectCandidate;
  status: "written" | "gated" | "duplicate";
  /** Why gated/dedupe'd; empty when written. */
  reason?: string;
  /** When status === "written", the new drawer's id (if daemon returned one). */
  drawer_id?: string;
  /** When status === "duplicate", the existing drawer's id. */
  existing_drawer_id?: string;
}
