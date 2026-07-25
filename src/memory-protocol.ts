import type { PalaceClient } from "./palace-client.ts";
import type { PalaceDrawer, PalaceSearchResult, RetrievalInfo, RetrievalTimings, SearchMode, SmeEntity } from "./types.ts";
import { SEARCH_MODES } from "./types.ts";
import { buildSystemPrompt } from "./grounding.ts";
import { allocateContext } from "./budget.ts";
import { domainRerank } from "./retrieval/rerank.ts";
import { temporalDecay } from "./retrieval/decay.ts";
import { extractiveCompress } from "./retrieval/compress.ts";
import { detectQueryIntent, modalityWeight } from "./retrieval/modality.ts";

const DEFAULT_HALF_LIFE_DAYS = 30;

const TEMPORAL_PATTERNS: Array<{ re: RegExp; resolve: (now: Date, match?: RegExpMatchArray) => [Date, Date] }> = [
  { re: /\byesterday\b/i, resolve: (now) => {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return [startOfDay(d), endOfDay(d)];
  }},
  { re: /\btoday\b/i, resolve: (now) => [startOfDay(now), endOfDay(now)] },
  { re: /\bthis morning\b/i, resolve: (now) => [startOfDay(now), endOfDay(now)] },
  { re: /\blast night\b/i, resolve: (now) => {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return [startOfDay(d), endOfDay(now)];
  }},
  { re: /\blast week\b/i, resolve: (now) => {
    const end = new Date(now);
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return [startOfDay(start), endOfDay(end)];
  }},
  { re: /\bthis week\b/i, resolve: (now) => {
    const dayOfWeek = now.getDay();
    const start = new Date(now); start.setDate(start.getDate() - dayOfWeek);
    return [startOfDay(start), endOfDay(now)];
  }},
  { re: /\b(\d+)\s+days?\s+ago\b/i, resolve: (now, match) => {
    const n = parseInt(match![1], 10);
    const d = new Date(now); d.setDate(d.getDate() - n);
    return [startOfDay(d), endOfDay(d)];
  }},
  { re: /\blast month\b/i, resolve: (now) => {
    const start = new Date(now); start.setMonth(start.getMonth() - 1, 1);
    const end = new Date(now); end.setDate(0);
    return [startOfDay(start), endOfDay(end)];
  }},
  { re: /\brecently\b/i, resolve: (now) => {
    const start = new Date(now); start.setDate(start.getDate() - 3);
    return [startOfDay(start), endOfDay(now)];
  }},
];

function startOfDay(d: Date): Date {
  const r = new Date(d); r.setHours(0, 0, 0, 0); return r;
}
function endOfDay(d: Date): Date {
  const r = new Date(d); r.setHours(23, 59, 59, 999); return r;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Detects temporal references ("yesterday", "last week", "3 days ago")
 * and appends the resolved ISO date(s) so BM25 can match on filed_at
 * timestamps in session manifest drawers.
 */
export function expandTemporalQuery(query: string, now = new Date()): string {
  for (const pat of TEMPORAL_PATTERNS) {
    const match = query.match(pat.re);
    if (match) {
      const [start, end] = pat.resolve(now, match);
      const startStr = isoDate(start);
      const endStr = isoDate(end);
      if (startStr === endStr) {
        return `${query} ${startStr}`;
      }
      const dates: string[] = [];
      const cursor = new Date(start);
      while (cursor <= end && dates.length < 14) {
        dates.push(isoDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return `${query} ${dates.join(" ")}`;
    }
  }
  return query;
}

export interface RetrieveAndGroundOpts {
  palace: PalaceClient;
  userMessage: string;
  wingScope: string | null;
  retrievalLimit: number;
  contextBudgetTokens: number;
  recentCitations: string[];
  /** When true, append a stuck-loop directive to the system prompt. Set by the chat route from session telemetry. */
  stuck?: boolean;
  /**
   * Optional HyDE generator: given the user's query, produce a
   * hypothetical answer to bridge query-document vocabulary gaps
   * before retrieval. When provided, the hypothetical text is
   * concatenated with the original query for the actual search.
   * Best paired with a small fast model (gemma3:4b ~2s). Setting
   * `PALACE_USE_HYDE=true` env var enables it from familiar.ts; off
   * by default while we measure paraphrase quality improvement.
   */
  hydeGenerate?: (query: string) => Promise<string>;
  /**
   * Per-request retrieval strategy override. When omitted, falls back to the
   * PALACE_SEARCH_MODE env var (default "hybrid"). "age-fused" routes through
   * the daemon's AGE knowledge-graph walk (familiar.realm.watch#88), degrading
   * to hybrid then vector if the daemon can't serve it (503/404).
   */
  searchMode?: SearchMode;
}

export interface RetrieveAndGroundResult {
  systemPrompt: string;
  drawerIds: string[];
  /** SME-shaped entities for /api/familiar/eval and Trace consumers. */
  entities: SmeEntity[];
  /** Daemon-reported total drawers in the search scope (pre-limit), useful for confidence gating. */
  availableInScope?: number;
  /** Which retrieval strategy ran + its per-source counts (#88). Undefined if palace was unreachable. */
  retrieval?: RetrievalInfo;
  warnings: string[];
  /** Per-stage latencies in milliseconds. Zero-overhead instrumentation via performance.now(). */
  timings: RetrievalTimings;
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
  const tTotal = performance.now();
  const timings: RetrievalTimings = {
    temporal_expand_ms: 0,
    palace_search_ms: 0,
    filter_ms: 0,
    rerank_ms: 0,
    modality_ms: 0,
    decay_ms: 0,
    compress_ms: 0,
    budget_ms: 0,
    prompt_ms: 0,
    total_ms: 0,
  };
  const warnings: string[] = [];
  let drawers: PalaceDrawer[] = [];
  let availableInScope: number | undefined;
  let palaceWarnings: string[] = [];

  const tTemporal = performance.now();
  const query = expandTemporalQuery(opts.userMessage.slice(0, 250));
  timings.temporal_expand_ms = Math.round(performance.now() - tTemporal);

  // Retrieval strategy (familiar.realm.watch#88). Per-request `searchMode`
  // wins; otherwise PALACE_SEARCH_MODE env (default "hybrid").
  //   vector    → GET /search             (embedding similarity only)
  //   hybrid    → POST /search/hybrid      (vector + BM25 + graph rerank)
  //   age-fused → POST /search/age-fused   (vector + AGE knowledge-graph walk)
  //
  // Each mode degrades through lower tiers when the daemon can't serve it —
  // a 503 (wrong backend, e.g. chroma) or 404 (older daemon) skips that tier
  // with a `<from>_fallback_<to>` warning. Any OTHER error (ECONNREFUSED,
  // timeout) means the daemon is down: we do NOT silently substitute a
  // weaker result, we surface `palace_unreachable`.
  const requested = (opts.searchMode ?? Bun.env.PALACE_SEARCH_MODE ?? "hybrid").toLowerCase();
  // Unknown values (typo'd env, stale client) degrade to the safe default
  // rather than silently collapsing to vector-only — see contract #88.
  const mode: SearchMode = (SEARCH_MODES as readonly string[]).includes(requested)
    ? (requested as SearchMode)
    : "hybrid";
  let retrieval: RetrievalInfo | undefined;

  type Tier = { mode: SearchMode; run: () => Promise<PalaceSearchResult> };
  const tiers: Tier[] = [];
  if (mode === "age-fused") {
    tiers.push({ mode: "age-fused", run: () => opts.palace.searchAgeFused({
      query, limit: opts.retrievalLimit, wing: opts.wingScope ?? undefined, includeTrace: true,
    }) });
  }
  if (mode === "age-fused" || mode === "hybrid") {
    tiers.push({ mode: "hybrid", run: () => opts.palace.searchHybrid({
      query, limit: opts.retrievalLimit, wing: opts.wingScope ?? undefined, hydeGenerate: opts.hydeGenerate,
    }) });
  }
  tiers.push({ mode: "vector", run: () => opts.palace.search({
    query, limit: opts.retrievalLimit, wing: opts.wingScope ?? undefined,
  }) });

  const tSearch = performance.now();
  try {
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      try {
        const search = await tier.run();
        drawers = search.results ?? [];
        availableInScope = search.available_in_scope;
        palaceWarnings = search.warnings ?? [];
        retrieval = {
          mode: tier.mode,
          n_vector: search.trace?.n_vector,
          n_graph: search.trace?.n_graph,
          n_after_fusion: search.trace?.n_after_fusion,
          ...(tier.mode !== mode ? { fell_back_to: tier.mode } : {}),
        };
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const fallbackable = msg.includes("503") || msg.includes("404");
        const next = tiers[i + 1];
        if (fallbackable && next) {
          warnings.push(`${tier.mode.replace(/-/g, "_")}_fallback_${next.mode.replace(/-/g, "_")}`);
          continue;
        }
        throw err; // daemon down, or last tier failed → palace_unreachable
      }
    }
  } catch {
    warnings.push("palace_unreachable");
  }
  timings.palace_search_ms = Math.round(performance.now() - tSearch);

  const tFilter = performance.now();
  // Defensive: palace-daemon occasionally returns drawers with `text: null`
  // (legacy / corrupt entries). Downstream code (compress, snippet) assumes
  // string. Filter them out and surface the count as a warning so eval +
  // Trace can see the data-quality signal.
  const droppedNullCount = drawers.length;
  drawers = drawers.filter((d) => typeof d.text === "string");
  if (drawers.length < droppedNullCount) {
    warnings.push(`filtered_null_text_${droppedNullCount - drawers.length}`);
  }

  // Exclude session-diary drawers from chat grounding (issue #25).
  // Stop-hook conversation diaries (room=diary, typically wing=familiar)
  // are the agent's log of past turns — including them creates a feedback
  // loop where a hallucinated answer becomes "palace truth" for the next
  // turn. Diary stays useful for session-recap views; just not as factual
  // grounding for new questions.
  const beforeDiaryFilter = drawers.length;
  drawers = drawers.filter((d) => d.room !== "diary");
  if (drawers.length < beforeDiaryFilter) {
    warnings.push(`filtered_diary_${beforeDiaryFilter - drawers.length}`);
  }

  // Dedup against recentCitations (don't re-inject last turn's drawers)
  if (opts.recentCitations.length > 0) {
    drawers = drawers.filter((d) => !d.id || !opts.recentCitations.includes(d.id));
  }
  timings.filter_ms = Math.round(performance.now() - tFilter);

  // Pipeline order is env-controlled (#71, closes Aurora #94 finding 1).
  //
  // Default ("rerank-modality-decay") is the legacy order. Aurora's
  // multipass#94 showed that with this order, temporal-decay's final
  // re-sort can override the gains from rerank/modality on age-diverse
  // corpora — toggling rerank-on/off returned bit-identical retrieval.
  //
  // Alternative ("decay-rerank-modality") applies decay first as a
  // baseline score multiplier, then rerank + modality compose ON TOP
  // of the decayed score — preserving their relative ordering effects.
  //
  // Multiplications are associative for the final score, so this is
  // equivalent in pure math terms — what changes is what each stage
  // SEES when it applies its formula. domainRerank uses similarity in
  // a weighted sum (not multiply), so it's non-commutative; applying
  // decay first means rerank's wing-match bonus gets added to a
  // decayed base rather than a raw one, which shifts top-N membership
  // on the narrow-age corpus (#73).
  const pipelineOrder = (Bun.env.PALACE_PIPELINE_ORDER ?? "rerank-modality-decay").toLowerCase();
  const intent = detectQueryIntent(opts.userMessage);

  if (pipelineOrder === "decay-rerank-modality") {
    // Aurora-recommended order — decay first.
    const tDecay = performance.now();
    drawers = temporalDecay(drawers, { halfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    timings.decay_ms = Math.round(performance.now() - tDecay);

    const tRerank = performance.now();
    drawers = domainRerank(drawers, opts.wingScope);
    timings.rerank_ms = Math.round(performance.now() - tRerank);

    const tModality = performance.now();
    drawers = modalityWeight(drawers, intent);
    timings.modality_ms = Math.round(performance.now() - tModality);
  } else {
    // Default / legacy — rerank first, decay last.
    const tRerank = performance.now();
    drawers = domainRerank(drawers, opts.wingScope);
    timings.rerank_ms = Math.round(performance.now() - tRerank);

    const tModality = performance.now();
    drawers = modalityWeight(drawers, intent);
    timings.modality_ms = Math.round(performance.now() - tModality);

    const tDecay = performance.now();
    drawers = temporalDecay(drawers, { halfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    drawers.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    timings.decay_ms = Math.round(performance.now() - tDecay);
  }

  // Emmimal component 4 — extractive compression.
  // Long drawers (>500 chars) get trimmed to top-3 query-relevant sentences.
  // Full drawer body remains addressable by drawer.id via citations.
  const tCompress = performance.now();
  drawers = extractiveCompress(drawers, opts.userMessage);
  timings.compress_ms = Math.round(performance.now() - tCompress);

  // Apply token budget
  const tBudget = performance.now();
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
  timings.budget_ms = Math.round(performance.now() - tBudget);

  const tPrompt = performance.now();
  const systemPrompt = buildSystemPrompt({
    drawers: alloc.kept,
    warnings: palaceWarnings,
    availableInScope: availableInScope ?? 0,
    wingScope: opts.wingScope,
    stuck: opts.stuck ?? false,
  });
  timings.prompt_ms = Math.round(performance.now() - tPrompt);

  const drawerIds = alloc.kept.map((d) => d.id).filter((id): id is string => Boolean(id));
  const entities = alloc.kept.map(drawerToEntity);
  timings.total_ms = Math.round(performance.now() - tTotal);
  return { systemPrompt, drawerIds, entities, availableInScope, retrieval, warnings, timings };
}
