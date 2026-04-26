import type { PalaceClient } from "./palace-client.ts";
import type { PalaceDrawer, PalaceSearchKind } from "./types.ts";
import { buildSystemPrompt } from "./grounding.ts";
import { allocateContext } from "./budget.ts";

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
  warnings: string[];
}

export async function retrieveAndGround(opts: RetrieveAndGroundOpts): Promise<RetrieveAndGroundResult> {
  const warnings: string[] = [];
  let drawers: PalaceDrawer[] = [];
  let availableInScope = 0;
  let palaceWarnings: string[] = [];

  try {
    const search = await opts.palace.search({
      query: opts.userMessage.slice(0, 250),
      limit: opts.retrievalLimit,
      wing: opts.wingScope ?? undefined,
      kind: opts.kind,  // undefined → palace-client defaults to "content"
    });
    drawers = search.results ?? [];
    availableInScope = search.available_in_scope ?? 0;
    palaceWarnings = search.warnings ?? [];
  } catch (err) {
    warnings.push("palace_unreachable");
  }

  // Dedup against recentCitations (don't re-inject last turn's drawers)
  if (opts.recentCitations.length > 0) {
    drawers = drawers.filter((d) => !d.id || !opts.recentCitations.includes(d.id));
  }

  // Apply token budget
  const alloc = allocateContext(drawers, opts.contextBudgetTokens);
  if (alloc.dropped.length > 0) {
    warnings.push(`budget_dropped_${alloc.dropped.length}`);
  }

  const systemPrompt = buildSystemPrompt({
    drawers: alloc.kept,
    warnings: palaceWarnings,
    availableInScope,
    wingScope: opts.wingScope,
  });

  const drawerIds = alloc.kept.map((d) => d.id).filter((id): id is string => Boolean(id));
  return { systemPrompt, drawerIds, warnings };
}
