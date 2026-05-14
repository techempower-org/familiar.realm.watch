# Hybrid Search + Room Taxonomy Implementation Plan

> **Status:** approved 2026-05-14 — implementation in progress
> **Owner:** JP / Claude (Opus 4.7)
> **Spec:** [`2026-05-13-palace-room-taxonomy.md`](../specs/2026-05-13-palace-room-taxonomy.md)
> **Substrate:** `mempalace_2026_05_13` on disks (273,205 drawers as of audit 2026-05-14)

## Goal

Combine three retrieval modes that already (or almost) exist in the substrate:

```
Hybrid search
├── Vector (pgvector HNSW, cosine)         ✓ in place (mempalace_drawers_vec_idx)
├── BM25  (Postgres tsvector + GIN)        ✗ to add
└── Graph (Apache AGE, mempalace_kg)        ✓ in place, unused by familiar
```

Fuse them with **Reciprocal Rank Fusion (RRF, k=60)**, exposed as a daemon
`/search/hybrid` endpoint. Scope is filterable by wing and room — which
requires the room taxonomy to land first, since today's labels are too
noisy to use as filters.

## Phase 1 — Taxonomy reform

### Audit findings (2026-05-14)

- 46 wings: top 3 (`projects` 39%, `storyvox` 32%, `general` 11%) cover 82%
- `projects` is a catch-all bucket where path inference stopped at `~/Projects/*`
- 73 rooms: `technical` alone has 168k drawers (62%); 4 canonical rooms already exist (`architecture`, `planning`, `problems`, `decisions`) holding 18%
- Many rooms are project names misused as rooms (`bestiary`, `dreamspace`, `oracle`, ...). These need wing/room swap.

### Phase 1A — Wing slug normalization (mechanical, risk-free)

Pure-rule transform on `wing`:

```python
def normalize_wing_slug(s: str) -> str:
    s = s.lower()
    if s.startswith("wing_"):
        s = s[5:]
    return re.sub(r"[^a-z0-9_]", "_", s)
```

Effect on top wings:
- `wing_realmwatch` (12k) + `realmwatch` → merge to `realmwatch`
- `wing_familiar-realm-watch` (10) + `familiar_realm_watch` (112) → `familiar_realm_watch`
- `kiyo-xhci-fix` (5009) + `kiyo_xhci_fix` (731) → `kiyo_xhci_fix`

Expected after: ~30 wings down from 46. Pure UPDATE, no row count change, no semantic loss.

### Phase 1B — Wing-from-room reassignment (data quality reform)

For drawers where `wing ∈ {'projects', 'general', ''}` and `room` matches a known project name in `~/Projects/`, move room→wing and set room to a placeholder that Phase 1C will then canonicalize.

The "known project name" set comes from `~/Projects/` directory listing + the canonical entries in `~/Projects/lexicon.realm.watch/catalog/projects.yaml`. This is rule-driven, no LLM needed at this step.

Expected: ~80k drawers move from `wing=projects/general/''` into proper project wings.

### Phase 1C — Room canonicalization (rules + LLM)

Two-stage mapping of room names to the canonical 7:

**Stage 1 — Rule-based pass** (substring match, fast, deterministic):

| Pattern in room name | → Canonical |
|---|---|
| `*debug*`, `*bug*`, `*issue*`, `*problem*`, `*usb*`, `*fix*`, `*recovery*`, `*error*` | `problems` |
| `*plan*`, `*todo*`, `*roadmap*` | `planning` |
| `*architecture*`, `*design*`, `*structure*` | `architecture` |
| `*decision*`, `*choice*` | `decisions` |
| `*session*`, `*chat*`, `*diary*`, `*checkpoint*` | `sessions` |
| `*ref*`, `*doc*`, `*link*`, `*url*`, `*registry*` | `references` |
| `*discover*`, `*found*`, `*learn*`, `*finding*` | `discoveries` |

**Stage 2 — LLM fallback for unmapped rooms.** Remaining distinct room names (probably ~40 after Stage 1) get judged by `qwen2.5:14b` on familiar via `/v1/chat/completions`. Prompt: room name + 5 random sample drawer contents + canonical set + "pick one or 'discoveries' if unclear." Cache decisions in JSON.

**Stage 3 — Default to `discoveries`** for truly ambiguous cases (per spec's catch-all).

The huge `technical` room (168k drawers) gets stage-2'd with much more careful prompt — likely splits across multiple canonical rooms by sampling per-wing/per-content.

### Architectural pivot (2026-05-14): single write path

Decided after the room taxonomy direction question (JP: "I want hooks
and mine to do the same things, in every way").

Today there are two parallel write paths into the palace:
1. Hook calls `mempalace_diary_write` (writes one summary drawer per
   session checkpoint with AAAK-compressed content).
2. Miner (`mempalace mine`) walks files and writes N chunk drawers
   per file using `detect_convo_room()` keyword-scoring.

These differ in wing derivation, room derivation, drawer ID format,
output shape, content shaping, dedup mechanism, and metadata fields.
The "same in every way" goal requires collapsing them to one write
path.

**Architecture: hook = trigger; miner = sole writer.**

- Hook.py drops the `mempalace_diary_write` call entirely. Its only
  job is "decide when to capture and POST `/mine` with the right mode."
- Miner gains `--mode session` that produces ONE summary drawer per
  session (replacing diary_write semantics), with AAAK content
  compression moved from diary_write into the miner.
- All wing/room/ID/dedup/validation logic lives in miner. Hook trusts
  the miner.
- `mempalace_diary_write` becomes a deprecated legacy shim calling
  miner internally (back-compat for non-hook callers).

Phase 1D below expands to cover this refactor in addition to the
CHECK constraint work.

### Phase 1D — Unified write path + CHECK constraint + enforcement

```sql
-- Add as NOT VALID first (instant, no lock contention)
ALTER TABLE mempalace_drawers ADD CONSTRAINT mempalace_drawers_room_canonical
  CHECK (room IN ('architecture','decisions','problems','planning',
                  'sessions','references','discoveries')) NOT VALID;

-- Then VALIDATE after all backfill complete (uses SHARE UPDATE EXCLUSIVE,
-- writes can continue)
ALTER TABLE mempalace_drawers VALIDATE CONSTRAINT mempalace_drawers_room_canonical;
```

**Daemon enforcement** (`palace-daemon` `main.py`):
- New helper `normalize_taxonomy(wing, room) -> (wing, room)` applied in `/memory` POST before forwarding to mempalace
- Reject 400 with `{valid_rooms: [...]}` payload if room is non-canonical and can't be auto-mapped
- Auto-map common aliases at the boundary (e.g., received `technical` → reject with hint)

**Hook update** (`palace-daemon` `clients/hook.py`):
- `_drawer_label`'s output mapped through a canonical-room resolver
- Default room for stop-hook saves: `sessions` (they are session checkpoints)
- Default room for precompact saves: also `sessions`

## Phase 2 — BM25 surface

### Schema

```sql
ALTER TABLE mempalace_drawers
  ADD COLUMN doc_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(document, ''))) STORED;

CREATE INDEX CONCURRENTLY mempalace_drawers_doc_tsv_idx
  ON mempalace_drawers USING gin (doc_tsv);
```

`GENERATED STORED` keeps the tsvector in sync automatically (no trigger needed). `CONCURRENTLY` avoids ACCESS EXCLUSIVE during index build. Storage cost: ~500MB extra.

### Daemon endpoint

`POST /keyword-search`:
```json
{
  "query": "chromadb segfault",
  "wing": null,            // optional, exact-match filter
  "room": null,            // optional, must be canonical if set
  "limit": 20
}
```

Query SQL:
```sql
SELECT id, document, wing, room, metadata,
       ts_rank_cd(doc_tsv, q) AS rank
FROM mempalace_drawers, websearch_to_tsquery('english', $1) q
WHERE doc_tsv @@ q
  AND ($2::text IS NULL OR wing = $2)
  AND ($3::text IS NULL OR room = $3)
ORDER BY rank DESC LIMIT $4;
```

`websearch_to_tsquery` is the right parser — supports user-friendly phrase syntax (`"exact phrase"`, `-exclude`, `or`).

### MCP tool

Add `mempalace_keyword_search_drawers` in `mempalace/mcp_server.py` mirroring the existing `mempalace_search_drawers` shape.

## Phase 3 — Graph integration

Per design decision 2026-05-14: **Both, weighted.**

### Vector-seeded expansion (primary)

After vector search returns top-K hits, look up their entity associations in AGE:

```cypher
MATCH (e:Entity)-[r:RELATION {source: $drawer_id}]-(other:Entity)
RETURN DISTINCT other.name AS entity
```

For each surfaced entity, find adjacent drawers:

```cypher
MATCH (a:Entity {name: $entity_name})-[r:RELATION]-(b:Entity)
RETURN DISTINCT r.source AS drawer_id LIMIT 50
```

These graph-expanded drawer IDs go into the RRF fusion alongside vector and BM25 results.

### NER + entity lookup (secondary, lower weight)

For queries with obvious entity mentions (capitalized words, known project names from `~/Projects/`), run a direct entity lookup:

```cypher
MATCH (e:Entity) WHERE e.name ILIKE $pattern OR e.name = $name
RETURN e.name
LIMIT 5
```

Then expand each matched entity 1-hop the same way. Adds independent signal for queries vector misses entirely.

For v1, "NER" is just a regex for capitalized multi-word phrases + the static list of project names from the catalog. A real NER model can come later.

### Weighting in RRF

Each source contributes `1 / (k_source + rank)`:
- Vector: `k = 60`
- BM25: `k = 60`
- Graph (vector-seeded): `k = 45` — slight boost; the drawer matched both semantic + structural
- Graph (NER): `k = 60`

Tunable. Start with these.

## Phase 4 — Hybrid endpoint

`POST /search/hybrid`:

```json
{
  "query": "how did we fix the pgvector lazy index race",
  "wing": "memorypalace",
  "room": null,
  "limit": 10,
  "modes": ["vector", "keyword", "graph"],  // optional, defaults to all 3
  "include_trace": false
}
```

Returns:
```json
{
  "results": [
    {"id": "drawer_xxx", "document": "...", "wing": "...", "room": "...",
     "rrf_score": 0.0521, "sources": ["vector", "graph"], "rank_in_source": {"vector": 1, "graph": 3}}
  ],
  "trace": {  // only if include_trace=true
    "vector": {"count": 20, "took_ms": 18},
    "keyword": {"count": 14, "took_ms": 22},
    "graph": {"count": 8, "took_ms": 11, "entities_seed": ["pgvector", "HNSW", ...]}
  }
}
```

Implementation: run vector + keyword in parallel (`asyncio.gather`); graph runs after vector (it needs vector seeds). Total budget: ~50ms p50, ~150ms p99.

## Phase 5 — Familiar wiring

`src/palace-client.ts`:
- Add `searchHybrid(query, opts)` method calling `/search/hybrid`
- Default opts: pass current project as `wing` filter (auto-scope from cwd/transcript)
- Add config flag `PALACE_SEARCH_MODE` ∈ `{"vector", "hybrid"}`; default `hybrid`

`src/grounding.ts`:
- Switch from `palaceClient.search` to `palaceClient.searchHybrid`
- Surface `sources` info in `/api/familiar/health` for debugging

`src/routes/eval.ts`:
- Add hybrid-vs-vector recall comparison on test queries (which queries does hybrid surface that vector misses?)

## Phase order + commit map

| Phase | Repo | Effort | Risk |
|---|---|---|---|
| 1A wing slug normalize | one-shot SQL on disks | small | low |
| 1B wing-from-room | one-shot SQL on disks | medium | medium |
| 1C room canonical (rules+LLM) | one-shot script on katana | medium | medium |
| 1D CHECK + daemon enforce | palace-daemon, fork mempalace | small | low |
| 2 BM25 schema + endpoint | mempalace fork, palace-daemon | medium | low |
| 3 graph integration | palace-daemon | medium | medium |
| 4 hybrid endpoint | palace-daemon | medium | low |
| 5 familiar wiring | familiar.realm.watch | medium | low |

## Open questions deferred to implementation

- **Backfill batching**: do we update 273k rows in one transaction (10-30s, blocks writes) or batches of 10k (slower but interleaves with concurrent writes)? Probably batches.
- **`technical` room (168k) splitting**: stage-2 LLM call needs ~10k LLM judgments at worst. Cheap enough on familiar (qwen2.5:14b), but maybe sample-cluster: group `technical` drawers by (wing, content shingle) and judge per-cluster.
- **Graph expansion fan-out**: a single entity can have hundreds of `RELATION` edges. Cap fan-out per entity to ~10 to keep latency bounded.
- **Auto-scope override**: when does the LLM widen scope from current-project to all-wings? Probably a heuristic on user query ("everything", "all projects", "across", "global"). Stage 5 detail.

## Success criteria

1. After Phase 1: zero non-canonical rooms in `mempalace_drawers`; CHECK constraint VALID; writes from current hooks succeed (no 400s in hook.log for 24h).
2. After Phase 2: BM25 search returns sensible results on file paths, error strings, commit hashes (specific test queries that vector misses).
3. After Phase 4: hybrid `include_trace=true` shows each of 3 sources contributing distinct drawers on a varied query set.
4. After Phase 5: `/api/familiar/health` reports hybrid-mode latency p99 < 200ms; recall-roundtrip test still passes; an A/B query comparison demonstrates hybrid finds drawers vector alone missed.
