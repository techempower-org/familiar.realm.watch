import type { PalaceClient } from "./palace-client.ts";
import type { PalaceDrawer, SmeEntity } from "./types.ts";
import { buildSystemPrompt } from "./grounding.ts";
import { allocateContext } from "./budget.ts";
import { domainRerank } from "./retrieval/rerank.ts";
import { temporalDecay } from "./retrieval/decay.ts";
import { extractiveCompress } from "./retrieval/compress.ts";

const DEFAULT_HALF_LIFE_DAYS = 30;

export interface RetrieveAndGroundOpts {
  palace: PalaceClient;
  userMessage: string;
  wingScope: string | null;
  retrievalLimit: number;
  contextBudgetTokens: number;
  recentCitations: string[];
  /** When true, append a stuck-loop directive to the system prompt. Set by the chat route from session telemetry. */
  stuck?: boolean;
}

export interface RetrieveAndGroundResult {
  systemPrompt: string;
  drawerIds: string[];
  /** SME-shaped entities for /api/familiar/eval and Trace consumers. */
  entities: SmeEntity[];
  /** Daemon-reported total drawers in the search scope (pre-limit), useful for confidence gating. */
  availableInScope?: number;
  warnings: string[];
}

function drawerToEntity(d: PalaceDrawer): SmeEntity {
  return {
    id: d.id ?? "",
    type: "drawer",
    wing: d.wing,
    room: d.room,
    topic: d.topic,
    content_snippet: d.text.slice(0, 240),
    cosine: d.cosine,
    bm25: d.bm25,
    matched_via: d.matched_via,
    provenance: { kind: "observed" },  // v0.2: every retrieved drawer is direct-observed
  };
}

export async function retrieveAndGround(opts: RetrieveAndGroundOpts): Promise<RetrieveAndGroundResult> {
  const warnings: string[] = [];
  let drawers: PalaceDrawer[] = [];
  let availableInScope: number | undefined;
  let palaceWarnings: string[] = [];

  // Phase 5 of the hybrid-search-taxonomy initiative (familiar.realm.watch
  // spec §3.8): default retrieval to hybrid when available. Hybrid fuses
  // vector + BM25 + graph candidates server-side, addressing the
  // vector-only failure modes (rare tokens, file paths, exact strings).
  // PALACE_SEARCH_MODE=vector forces the legacy path; "hybrid" (default)
  // tries hybrid first and falls back to vector on 503 (chroma backends).
  const mode = (Bun.env.PALACE_SEARCH_MODE ?? "hybrid").toLowerCase();
  try {
    if (mode === "hybrid") {
      try {
        const search = await opts.palace.searchHybrid({
          query: opts.userMessage.slice(0, 250),
          limit: opts.retrievalLimit,
          wing: opts.wingScope ?? undefined,
        });
        drawers = search.results ?? [];
        availableInScope = search.available_in_scope;
        palaceWarnings = search.warnings ?? [];
      } catch (hybridErr) {
        // Hybrid endpoint not available (older daemon or chroma backend).
        // Fall back to vector path silently — the user gets results, just
        // without the BM25/graph boost.
        const msg = hybridErr instanceof Error ? hybridErr.message : String(hybridErr);
        if (msg.includes("503") || msg.includes("404")) {
          warnings.push("hybrid_fallback_vector");
        } else {
          throw hybridErr;
        }
      }
    }
    if (drawers.length === 0 && availableInScope === undefined) {
      // Either mode=vector, or hybrid was unavailable. Use legacy /search.
      const search = await opts.palace.search({
        query: opts.userMessage.slice(0, 250),
        limit: opts.retrievalLimit,
        wing: opts.wingScope ?? undefined,
      });
      drawers = search.results ?? [];
      availableInScope = search.available_in_scope;
      palaceWarnings = search.warnings ?? [];
    }
  } catch (err) {
    warnings.push("palace_unreachable");
  }

  // Defensive: palace-daemon occasionally returns drawers with `text: null`
  // (legacy / corrupt entries). Downstream code (compress, snippet) assumes
  // string. Filter them out and surface the count as a warning so eval +
  // Trace can see the data-quality signal.
  const droppedNullCount = drawers.length;
  drawers = drawers.filter((d) => typeof d.text === "string");
  if (drawers.length < droppedNullCount) {
    warnings.push(`filtered_null_text_${droppedNullCount - drawers.length}`);
  }

  // Dedup against recentCitations (don't re-inject last turn's drawers)
  if (opts.recentCitations.length > 0) {
    drawers = drawers.filter((d) => !d.id || !opts.recentCitations.includes(d.id));
  }

  // Emmimal component 2 — domain-weighted rerank.
  // Adjusts similarity using wing-match + recency; raw cosine/bm25 preserved.
  drawers = domainRerank(drawers, opts.wingScope);

  // Emmimal component 3 — exponential temporal decay.
  // Multiplies similarity by exp(-λ * age_days) where λ = ln(2) / half_life.
  drawers = temporalDecay(drawers, { halfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  // Re-sort: decay can change the order significantly when older drawers
  // had high rerank scores.
  drawers.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  // Emmimal component 4 — extractive compression.
  // Long drawers (>500 chars) get trimmed to top-3 query-relevant sentences.
  // Full drawer body remains addressable by drawer.id via citations.
  drawers = extractiveCompress(drawers, opts.userMessage);

  // Apply token budget
  const alloc = allocateContext(drawers, opts.contextBudgetTokens);
  if (alloc.dropped.length > 0) {
    warnings.push(`budget_dropped_${alloc.dropped.length}`);
  }

  // Confidence gate signal: surface as a warning when retrieval is weak so
  // /api/familiar/eval and Trace consumers can see it in their telemetry.
  // The grounding layer separately emits a system-prompt directive.
  const topSimilarity = alloc.kept[0]?.similarity ?? 0;
  if (topSimilarity < 0.3 && alloc.kept.length < 2) {
    warnings.push("low_confidence");
  }

  const systemPrompt = buildSystemPrompt({
    drawers: alloc.kept,
    warnings: palaceWarnings,
    availableInScope: availableInScope ?? 0,
    wingScope: opts.wingScope,
    stuck: opts.stuck ?? false,
  });

  const drawerIds = alloc.kept.map((d) => d.id).filter((id): id is string => Boolean(id));
  const entities = alloc.kept.map(drawerToEntity);
  return { systemPrompt, drawerIds, entities, availableInScope, warnings };
}
