/**
 * ReflectWriter — orchestrates extraction → gate → dedup → palace write.
 *
 * Off the chat hot path. Failures are decisions, not exceptions: a
 * write failure marks the candidate "gated" with reason "write_failed"
 * so the journal can see it without affecting the user's chat UX.
 */

import type { ReflectDecision } from "./types.ts";
import type { InferenceChatProvider } from "../types.ts";
import type { PalaceClient } from "../palace-client.ts";
import { extractCandidates } from "./extractor.ts";
import { gate } from "./gate.ts";
import { dedupCheck } from "./dedup.ts";

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

  async review(opts: ReflectReviewOpts): Promise<ReflectDecision[]> {
    const candidates = await extractCandidates(opts.assistantTurn, {
      inference: this.deps.inference,
      maxFacts: this.deps.maxFactsPerTurn,
    });

    const decisions: ReflectDecision[] = [];
    for (const c of candidates) {
      const gated = gate(c);
      if (gated) {
        decisions.push(gated);
        continue;
      }
      const dup = await dedupCheck(c, { palace: this.deps.palace, threshold: this.deps.threshold });
      if (!dup.novel) {
        decisions.push({
          candidate: c,
          status: "duplicate",
          existing_drawer_id: dup.existing_drawer_id,
          reason: `similar_to_${dup.existing_drawer_id}`,
        });
        continue;
      }
      try {
        await this.deps.palace.writeMemory({
          content: c.fact,
          wing: this.deps.wing,
          room: opts.sessionId,
        });
        decisions.push({ candidate: c, status: "written" });
      } catch {
        decisions.push({
          candidate: c,
          status: "gated",
          reason: "write_failed",
        });
      }
    }
    return decisions;
  }
}
