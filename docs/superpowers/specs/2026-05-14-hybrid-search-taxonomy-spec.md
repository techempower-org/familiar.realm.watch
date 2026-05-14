# Hybrid Search + Unified Write Path + Configurable Taxonomy

**Status:** approved 2026-05-14 — actively implementing
**Owner:** JP / Claude (Opus 4.7)
**Supersedes:** [2026-05-13-palace-room-taxonomy.md](2026-05-13-palace-room-taxonomy.md) (room taxonomy spec, now folded into Phase 1 of this doc)
**Implementation plan:** [2026-05-14-hybrid-search-and-taxonomy.md](../plans/2026-05-14-hybrid-search-and-taxonomy.md)

---

## 1. Goal

Three things in one initiative because they share a substrate (`mempalace_drawers` in postgres) and overlap in implementation:

1. **Taxonomy reform** — replace the current 39-wing × 73-room entropy with a *configurable* canonical model: wing = project (path-derived), room ∈ a small editable set (default 7).
2. **Unified write path** — collapse the two parallel write surfaces (`mempalace_diary_write` from hook + `mempalace mine` from CLI) into one. Hook becomes trigger-only.
3. **Hybrid search** — fuse vector + BM25 + graph retrieval into a single ranked result set. Default mode for familiar grounding.

---

## 2. Upstream landscape (audited 2026-05-14)

The plan must coordinate with these existing PRs and merged work, not duplicate or conflict.

### Already merged (in our fork via cherry-pick or upstream sync)

- **#1306** `feat(searcher): candidate_strategy="union"` — BM25+vector hybrid via sqlite FTS5. **Architectural template** we follow. Pattern: `_CANDIDATE_MERGERS` registry; `_apply_candidate_strategy()` dispatches mergers that union BM25 hits into vector candidate pool before the hybrid reranker.
- **#1474** `perf(convo_miner): bulk pre-fetch` — our own PR, merged 2026-05-13.
- **#1415, #1412, #1305, #1310, #1377, #1322** — hook robustness, repair, chromadb fixes — all in our fork.

### Open upstream PRs we either monitor, comment on, or supersede

| PR | Title | Relationship |
|---|---|---|
| **#1306** companions | #1480 (wider over-fetch), #1481 ("contains" strategy) | Extensions of the union pattern. Match shape when we add `"hybrid"` strategy. |
| **#1433** | refactor(searcher): decompose search_memories | Cleans the surface we extend. Watch for merge; rebase on top. |
| **#1053** | hooks auto-mine in convos mode + stable wing | **Our Phase 1D supersedes this.** Comment on #1053 with our refactor approach. |
| **#1424** | fix(hooks): hyphenated wing extraction | **Already covered by our Phase 1A wing-slug normalize.** Comment that our approach is more general. |
| **#1366** | server-level wing access control | Compatible with our schema. May port later. |
| **#490** | canonical wing/hall taxonomy | **Explicit divergence.** Upstream's `wing_*`/`hall_*` is a content-topic taxonomy (wing_user, hall_facts, ...). Ours is `wing=project, room=topic`. Document the difference; don't try to merge. |

### What we deliberately do NOT do upstream first

Per [[fork-first-patches]] memory: fix in our fork now, deal with conflict at merge time. We post operator/diagnosis comments upstream where useful, but don't gate work on review cycles. This applies especially to the unified-write-path refactor, which is unlikely to merge upstream as-is (their model still assumes diary_write + mine as separate paths).

---

## 3. Architecture

### 3.1 Data model

```
mempalace_drawers
├── id              text PK         drawer_<wing>_<room>_<sha256[:24]>  (miner-controlled)
├── wing            text NOT NULL   slug-normalized project name (see §3.2)
├── room            text NOT NULL   FK → mempalace_canonical_rooms.name (§3.3)
├── document        text NOT NULL   summarized OR raw, per write mode
├── embedding       vector(384)     all-MiniLM-L6-v2 ONNX
├── doc_tsv         tsvector        GENERATED ALWAYS AS to_tsvector('english', document) STORED
├── metadata        jsonb           {source_file, chunk_index, agent, added_at, ...}
└── (indexes)       mempalace_drawers_pkey         on id
                    mempalace_drawers_vec_idx      HNSW (embedding vector_cosine_ops)
                    mempalace_drawers_doc_tsv_idx  GIN (doc_tsv)
                    mempalace_drawers_metadata_gin GIN (metadata)
                    mempalace_drawers_wing_idx     btree (wing)
                    mempalace_drawers_room_idx     btree (room)

mempalace_canonical_rooms
├── name            text PK         canonical room slug
├── description     text            human-readable
└── added_at        timestamptz     audit trail
```

### 3.2 Wing slug normalization (canonical form)

A single function used by every writer:

```python
def normalize_wing_slug(s: str) -> str:
    """Single source of truth for wing slugs. Idempotent."""
    if not s:
        return "unknown"
    s = s.lower()
    if s.startswith("wing_"):
        s = s[5:]
    s = re.sub(r"[^a-z0-9_]", "_", s)
    return s or "unknown"
```

Wing derivation strategies (in priority order, all converge through `normalize_wing_slug`):
1. Explicit `--wing` flag
2. `mempalace.yaml` in project directory
3. **Claude Code transcript path** (encoded form): take the path *after* `~/.claude/projects/` and strip leading `-`, replace `-` with `/`, take the final basename. Example: `~/.claude/projects/-home-jp-Projects-customer-portal/abc.jsonl` → `customer-portal` → normalize → `customer_portal`. (Supersedes #1424's last-token fix.)
4. cwd basename → normalize
5. fallback: `"unknown"`

### 3.3 Canonical rooms (configurable)

**Default seed set (the spec's 7):**

| Name | Purpose |
|---|---|
| `architecture` | designs, structures, schemas, interfaces, module boundaries |
| `decisions` | choices, trade-offs, resolved alternatives |
| `problems` | bugs, failures, debugging artifacts, error logs |
| `planning` | plans, roadmaps, scopes, todos |
| `sessions` | conversation checkpoints, diary entries, transcript captures |
| `references` | code, docs, configs, registries (reference material, not learning) |
| `discoveries` | findings, learnings, insights — also the default for unclassified content |

**Configurability:** Stored as a postgres table (`mempalace_canonical_rooms`); CLI editable.

```sql
CREATE TABLE mempalace_canonical_rooms (
  name        text PRIMARY KEY,
  description text,
  added_at    timestamptz DEFAULT now()
);

ALTER TABLE mempalace_drawers
  ADD CONSTRAINT mempalace_drawers_room_fk
  FOREIGN KEY (room) REFERENCES mempalace_canonical_rooms(name)
  ON UPDATE CASCADE;
```

`ON UPDATE CASCADE` means renaming a room in the lookup auto-renames in every drawer. Deleting a room with drawers in it raises (must move drawers first).

### 3.4 Configuration surface

`~/.mempalace/config.yaml` — extends mempalace's existing config dir:

```yaml
# Canonical rooms — defaults come from the DB; this section can override
# the keyword-routing rules used by detect_convo_room.
room_rules:
  problems:    [bug, broken, fail, crash, stuck, debug, error, fix, recovery, workaround]
  planning:    [plan, roadmap, todo, sprint, backlog, scope, milestone, spec]
  architecture:[architecture, design, pattern, structure, schema, interface, layer]
  decisions:   [decided, chose, picked, switched, migrated, trade-off, alternative]
  sessions:    [session, conversation, chat, diary, checkpoint, convo]
  references:  [code, doc, link, url, registry, config, setup, api, infrastructure]
  discoveries: [discovered, found, learned, insight, finding, note]

# Wing slug normalization rules (defaults are baked into normalize_wing_slug;
# this lets per-installation overrides happen without code changes)
wing_rules:
  strip_prefixes: [wing_, project_]
  replace_chars:  ["-": "_", ".": "_"]
  fallback:       unknown

# Write-path behavior
write:
  verbatim:           false              # if true, neither hook nor miner LLM-summarizes
  default_room:       discoveries        # fallback when content classifier returns no signal
  session_summary:    true               # whether --mode session produces summary or raw concat
```

`mempalace config show` prints the merged config (DB defaults + YAML overrides). CLI subcommands `mempalace rooms list/add/rename/remove` edit the DB lookup.

### 3.5 Write path (unified, post Phase 1D refactor)

```
                ┌──────────────────────────────────┐
   Stop/PreCompact event ──▶│   hook.py — trigger only   │
                            │   1. compute cadence         │
                            │   2. pick mode               │
                            │   3. POST daemon /mine        │
                            └────────────────────────────┘
                                          │
                                          ▼
   `mempalace mine` ──────▶ ┌────────────────────────────┐
   (CLI / daemon /mine)     │   miner — sole writer       │
                            │   ────────────────────────  │
                            │   1. resolve wing slug      │
                            │      (single normalize fn)  │
                            │   2. read content           │
                            │   3. chunk OR summarize     │
                            │      per --mode             │
                            │   4. detect_convo_room      │
                            │      from rules → canonical│
                            │   5. dedup by content hash  │
                            │   6. drawer_<wing>_<room>_..│
                            │   7. upsert via backend     │
                            └────────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────┐
                            │  PostgresBackend.upsert     │
                            │  ✓ FK to canonical_rooms     │
                            │  ✓ generated doc_tsv         │
                            │  ✓ HNSW + GIN auto-update    │
                            └────────────────────────────┘
```

**Miner modes (write path knobs):**

| Mode | Output shape | Use case |
|---|---|---|
| `convos` | N drawers per file, chunked at exchange boundary | Transcript ingestion (current + hook trigger) |
| `projects` | N drawers per file, sliding-window chunked | General-purpose file ingestion |
| `session` (NEW) | 1 summary drawer per session/file | Hook checkpoint writes (replaces `diary_write`) |
| `general` | LLM-extracted memory_type drawers | Existing freeform extraction |

**Hook simplification:**

```python
# hook.py (post-refactor) — trigger-only
def hook_stop(data, harness):
    if not _should_checkpoint(data):
        return
    wing = _wing_from_event(data)
    mine_dir = data.get("transcript_path", "").rsplit("/", 1)[0]
    # No more mempalace_diary_write call.
    _post_mine(daemon_url, mine_dir, mode="session", wing=wing)
```

`mempalace_diary_write` becomes a legacy shim that calls `mempalace mine --mode session --file <X>` internally, for back-compat with anything (or anyone) still calling it directly.

### 3.6 Hybrid search

Three retrieval modes, fused via the upstream-style **candidate union strategy** (matches #1306's pattern):

```python
_CANDIDATE_MERGERS = {
    "vector":  None,                                # default no-op
    "union":   _merge_bm25_union_candidates,        # existing chroma path
    "hybrid":  _merge_hybrid_candidates,            # NEW: vector + BM25 + graph
}
```

The new `_merge_hybrid_candidates` does:
1. Pull `n_results * 3` BM25 candidates via postgres tsvector (parallel to vector, not after)
2. Pull graph-expanded drawers via two channels (weighted in rerank):
   - **Vector-seeded**: take vector top-5; AGE query for entities → 1-hop expansion → drawer IDs
   - **Query NER**: regex for capitalized/known-entity tokens; AGE match → 1-hop expansion
3. Union all three sources, dedupe by `(source_file, chunk_index)` (matching #1306's logic)
4. Score in `_hybrid_rank`: vector distance contributes when present, BM25 score always, graph-presence is a small boost (`+0.05` to rrf-like normalized score)

**Why union-then-rerank instead of pure RRF:** matches upstream #1306's architecture so future merges are less painful. The reranker already exists; we feed it a wider candidate pool. Pure RRF would require new combinator code that doesn't exist upstream.

### 3.7 Daemon endpoints

```
GET   /health                            existing
POST  /memory                            existing — gains wing-slug normalize + room validation
POST  /mine                              existing — gains mode= forwarded
POST  /search             {query, wing, room, limit}                  vector only (compat)
POST  /search/keyword     {query, wing, room, limit}                  NEW — postgres BM25
POST  /search/hybrid      {query, wing, room, limit, modes, trace}    NEW — union strategy via mcp
POST  /cypher             existing — graph queries
POST  /embed              existing — raw embed
```

`/search/hybrid` routes through `mempalace_search_drawers` MCP tool with `candidate_strategy="hybrid"`.

### 3.8 Familiar integration

`palace-client.ts` gains:
```typescript
async searchHybrid(query: string, opts?: {wing?: string; room?: string; limit?: number; trace?: boolean})
```

Defaults:
- `wing` = current project (inferred from cwd at server startup)
- `room` = unset (search across all rooms)
- `limit` = 10
- mode set to `"hybrid"`

`grounding.ts` switches default retrieval from `search()` (vector) to `searchHybrid()`. Behind `PALACE_SEARCH_MODE` env (`vector` | `hybrid`, default `hybrid`).

---

## 4. Phased implementation

### Phase 1 — Taxonomy reform (status: in progress)

| Sub-phase | Status | Notes |
|---|---|---|
| 1A — Wing slug normalize | ✅ Done 2026-05-14 | 33,633 rows updated, 46→39 wings |
| 1B — Wing-from-room reassignment | ✅ Done 2026-05-14 | 34,316 rows moved, 78 distinct wings (some legitimately new from the reassignment) |
| 1C — Room canonicalization (rules + LLM) | 🔄 In progress | Stage 1 rules script ready; Stage 2 LLM judges the remaining ~30 distinct rooms |
| 1D — Unified write path + FK constraint | ⏳ Pending | See §3.5 + §3.3 |

### Phase 2 — BM25 surface

| Step | Output |
|---|---|
| 2.1 | `ALTER TABLE mempalace_drawers ADD COLUMN doc_tsv tsvector GENERATED ALWAYS AS to_tsvector('english', document) STORED;` |
| 2.2 | `CREATE INDEX CONCURRENTLY mempalace_drawers_doc_tsv_idx ON mempalace_drawers USING gin (doc_tsv);` |
| 2.3 | New helper `_bm25_only_via_postgres(query, palace_dsn, wing, room, n_results)` in mempalace/searcher.py — mirror of `_bm25_only_via_sqlite` |
| 2.4 | Backend-aware dispatch in `_merge_bm25_union_candidates`: if collection's backend is postgres, call `_bm25_only_via_postgres`; else `_bm25_only_via_sqlite` |
| 2.5 | Daemon `/search/keyword` endpoint |

### Phase 3 — Graph integration

| Step | Output |
|---|---|
| 3.1 | Helper `_graph_expand_from_entities(entities, n_results, wing)` issuing AGE Cypher: `MATCH (e:Entity {name: $name})-[r:RELATION]-(o) RETURN r.source` |
| 3.2 | Vector-seeded path: after vector candidates, extract entities mentioned in top-K drawers, expand 1-hop, add to pool |
| 3.3 | NER path: simple regex (capitalized multi-words + known entity list from catalog) on query → AGE lookup → 1-hop |
| 3.4 | Both feed into `_merge_hybrid_candidates` with `distance=None` and a `_graph_source` metadata marker for trace |

### Phase 4 — Hybrid endpoint

| Step | Output |
|---|---|
| 4.1 | `_merge_hybrid_candidates` registered in `_CANDIDATE_MERGERS` as `"hybrid"` |
| 4.2 | `_hybrid_rank` extension: respect `_graph_source` for small score boost (+0.05) |
| 4.3 | MCP tool `mempalace_search_drawers` accepts `candidate_strategy="hybrid"` |
| 4.4 | Daemon `/search/hybrid` endpoint with optional `include_trace=true` |
| 4.5 | Familiar `palace-client.searchHybrid` |

### Phase 5 — Familiar wiring

| Step | Output |
|---|---|
| 5.1 | `palace-client.ts` adds `searchHybrid` |
| 5.2 | `grounding.ts` defaults to hybrid (via env-gated `PALACE_SEARCH_MODE`) |
| 5.3 | `routes/eval.ts` adds A/B vector-vs-hybrid recall comparison |
| 5.4 | Recall-roundtrip test extends to verify hybrid surfaces a marker drawer that vector alone might miss |

---

## 5. Decisions locked in

| Decision | Choice | Rationale |
|---|---|---|
| Primary address | wing=project, room=topic | Spec-of-record; auto-population deterministic from cwd. JP confirmed 2026-05-14. |
| Fusion strategy | Candidate union + rerank (matching #1306) | Upstream-compatible; future merges less painful. |
| Backfill strategy | Rules + local LLM for unmapped | qwen2.5:14b judgment for the ~30 ambiguous rooms. |
| Graph integration | Both vector-seeded + NER, weighted | NER catches entity-anchored queries vector misses. |
| Room config | DB lookup table + YAML override for rules | DB is canonical (FK enforced); YAML for per-installation routing rules. |
| Config path | `~/.mempalace/config.yaml` | Extends existing mempalace config dir. |
| Hook/miner | Single write path (Option C) | Hook = trigger; miner = sole writer. JP confirmed 2026-05-14. |
| Upstream coordination | Fork-first, conflict at merge | Per [[fork-first-patches]]. |

---

## 6. Open questions deferred to implementation

- **`technical` room split**: 168k drawers. Per-wing+content-shingle clustering before LLM judgment to keep cost bounded.
- **BM25 query parser**: `websearch_to_tsquery` vs `plainto_tsquery`. websearch is more flexible (phrase support); plainto is safer. Start with websearch; fall back to plainto if user-input crashes.
- **Graph fan-out cap**: a single entity can have hundreds of `RELATION` edges. Cap per-entity 1-hop expansion at 10 drawers to keep latency bounded.
- **Auto-scope override heuristic**: when does familiar's LLM widen scope from current-project to all-wings? Defer to Phase 5 measurements; start with explicit-only override via prompt cue.

---

## 7. Success criteria

1. **Post-Phase-1**: zero non-canonical rooms in `mempalace_drawers`; FK valid; both hook and miner emit only canonical rooms for 24h with no rejected writes in hook.log.
2. **Post-Phase-2**: `/search/keyword` returns sensible results for queries vector misses (file paths, exact error strings, commit hashes). Local probe queries pass: "pgvector advisory lock", "mempalace_drawers_vec_idx", "78ms".
3. **Post-Phase-3**: graph contributes drawers neither vector nor BM25 surfaced, verified via `include_trace=true` on probe queries about specific entities ("palace-daemon", "skuznetsov").
4. **Post-Phase-4**: `/search/hybrid` macro recall demonstrably better than `/search` alone on a probe set including narrative + exact-match + entity-anchored queries.
5. **Post-Phase-5**: `/api/familiar/health` reports hybrid p99 < 200ms; recall-roundtrip still passes; eval route shows hybrid surfaces drawers vector alone missed.

---

## 8. Cross-references

- Spec predecessor: [2026-05-13-palace-room-taxonomy.md](2026-05-13-palace-room-taxonomy.md)
- Implementation plan: [2026-05-14-hybrid-search-and-taxonomy.md](../plans/2026-05-14-hybrid-search-and-taxonomy.md)
- pgvector lazy-index race: `techempower-org/mempalace#73`
- Operator comment on PostgresBackend: `MemPalace/mempalace#665`
- Upstream architectural template: `MemPalace/mempalace#1306` (merged)
- Upstream divergence point: `MemPalace/mempalace#490` (open, different model)
- Upstream we supersede: `MemPalace/mempalace#1053`, `#1424`
