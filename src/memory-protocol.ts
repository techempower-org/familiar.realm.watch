import type { PalaceClient } from "./palace-client.ts";
import type { PalaceDrawer, PalaceSearchKind, SmeEntity } from "./types.ts";
import { buildSystemPrompt } from "./grounding.ts";
import { allocateContext } from "./budget.ts";
import { domainRerank } from "./retrieval/rerank.ts";

export interface RetrieveAndGroundOpts {
  palace: PalaceClient;
  userMessage: string;
  wingScope: string | null;
  retrievalLimit: number;
  contextBudgetTokens: number;
  recentCitations: string[];
  /** Defaults to "content" inside palace-client; pass "checkpoint" for audit/recovery flows. */
  kind?: PalaceSearchKind;
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
  };
}

export async function retrieveAndGround(opts: RetrieveAndGroundOpts): Promise<RetrieveAndGroundResult> {
  const warnings: string[] = [];
  let drawers: PalaceDrawer[] = [];
  let availableInScope: number | undefined;
  let palaceWarnings: string[] = [];

  try {
    const search = await opts.palace.search({
      query: opts.userMessage.slice(0, 250),
      limit: opts.retrievalLimit,
      wing: opts.wingScope ?? undefined,
      kind: opts.kind,  // undefined → palace-client defaults to "content"
    });
    drawers = search.results ?? [];
    availableInScope = search.available_in_scope;
    palaceWarnings = search.warnings ?? [];
  } catch (err) {
    warnings.push("palace_unreachable");
  }

  // Dedup against recentCitations (don't re-inject last turn's drawers)
  if (opts.recentCitations.length > 0) {
    drawers = drawers.filter((d) => !d.id || !opts.recentCitations.includes(d.id));
  }

  // Emmimal component 2 — domain-weighted rerank.
  // Adjusts similarity using wing-match + recency; raw cosine/bm25 preserved.
  drawers = domainRerank(drawers, opts.wingScope);

  // Apply token budget
  const alloc = allocateContext(drawers, opts.contextBudgetTokens);
  if (alloc.dropped.length > 0) {
    warnings.push(`budget_dropped_${alloc.dropped.length}`);
  }

  const systemPrompt = buildSystemPrompt({
    drawers: alloc.kept,
    warnings: palaceWarnings,
    availableInScope: availableInScope ?? 0,
    wingScope: opts.wingScope,
  });

  const drawerIds = alloc.kept.map((d) => d.id).filter((id): id is string => Boolean(id));
  const entities = alloc.kept.map(drawerToEntity);
  return { systemPrompt, drawerIds, entities, availableInScope, warnings };
}
