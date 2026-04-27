/**
 * ReflectWriter — orchestrates extraction → gate → dedup → palace write.
 *
 * Off the chat hot path. Failures are decisions, not exceptions: a
 * write failure marks the candidate "gated" with reason "write_failed"
 * so the journal can see it without affecting the user's chat UX.
 */

import type { ReflectDecision, ReflectTiming } from "./types.ts";
import type { InferenceChatProvider } from "../types.ts";
import type { PalaceClient } from "../palace-client.ts";
import { extractCandidates } from "./extractor.ts";
import { gate } from "./gate.ts";
import { dedupCheck } from "./dedup.ts";

export interface ReflectReviewResult {
  decisions: ReflectDecision[];
  timing: ReflectTiming;
}

export interface ReflectWriterDeps {
  palace: PalaceClient;
  inference: InferenceChatProvider;
  /** Cosine threshold above which a candidate is considered duplicate. */
  threshold: number;
  /** Cap on candidates considered per call. */
  maxFactsPerTurn: number;
  /** Wing to write reflect-derived drawers into. */
  wing: string;
}

export interface ReflectReviewOpts {
  sessionId: string;
  assistantTurn: string;
  /** Reserved: optional next-turn user reaction. v0.4 will use this as a quality signal. */
  userReaction?: string;
}

export class ReflectWriter {
  constructor(private readonly deps: ReflectWriterDeps) {}

  /**
   * Backwards-compat shape: callers that ignore timing get just the
   * decisions array. New callers can use review() which returns both.
   */
  async review(opts: ReflectReviewOpts): Promise<ReflectDecision[]> {
    const result = await this.reviewWithTiming(opts);
    return result.decisions;
  }

  async reviewWithTiming(opts: ReflectReviewOpts): Promise<ReflectReviewResult> {
    const t0 = Date.now();
    const tExtractStart = Date.now();
    const candidates = await extractCandidates(opts.assistantTurn, {
      inference: this.deps.inference,
      maxFacts: this.deps.maxFactsPerTurn,
    });
    const extractMs = Date.now() - tExtractStart;

    let gateMs = 0, dedupMs = 0, writeMs = 0;
    const decisions: ReflectDecision[] = [];
    for (const c of candidates) {
      const ts = new Date().toISOString();
      const tGate = Date.now();
      const gated = gate(c);
      gateMs += Date.now() - tGate;
      if (gated) {
        decisions.push({ ...gated, ts, session_id: opts.sessionId });
        continue;
      }
      const tDedup = Date.now();
      const dup = await dedupCheck(c, { palace: this.deps.palace, threshold: this.deps.threshold });
      dedupMs += Date.now() - tDedup;
      if (!dup.novel) {
        decisions.push({
          candidate: c,
          status: "duplicate",
          existing_drawer_id: dup.existing_drawer_id,
          reason: `similar_to_${dup.existing_drawer_id}`,
          ts,
          session_id: opts.sessionId,
        });
        continue;
      }
      const tWrite = Date.now();
      try {
        await this.deps.palace.writeMemory({
          content: c.fact,
          wing: this.deps.wing,
          room: opts.sessionId,
        });
        decisions.push({ candidate: c, status: "written", ts, session_id: opts.sessionId });
      } catch {
        decisions.push({ candidate: c, status: "gated", reason: "write_failed", ts, session_id: opts.sessionId });
      }
      writeMs += Date.now() - tWrite;
    }
    const totalMs = Date.now() - t0;
    return {
      decisions,
      timing: { extract_ms: extractMs, gate_ms: gateMs, dedup_ms: dedupMs, write_ms: writeMs, total_ms: totalMs },
    };
  }
}
