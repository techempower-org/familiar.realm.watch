# Palace Room Taxonomy — Project-Topic-Drawer model

**Status:** approved design, deferred implementation
**Owner:** JP
**Implements-into:** the pgvector migration of the palace substrate (no chromadb-side rework — see HANDOFF 2026-05-11)
**Supersedes:** ad-hoc wing/room naming as of 2026-05-13 (71 wings, 73 rooms, mixed `wing_X` / `X` / agent-name conventions; live `/stats` snapshot shows three flavors of `familiar.realm.watch` alone: `familiar`, `wing_familiar-realm-watch`, `wing_familiar_realm_watch`)

---

## 1. Why

As of 2026-05-13 the palace holds ~183k drawers across 71 wings and 73 rooms. The naming is inconsistent: some wings use `wing_` prefixes, some don't; rooms are sometimes verbs ("debugging"), sometimes nouns ("architecture"), sometimes agent names ("claude_code"). New writes invent new rooms instead of reusing existing ones. The closet (mempalace's auto-built index of `topic|entities|→drawer_ids` pointers) compensates for free-form tagging, but the wing/room layer underneath has drifted into entropy.

The miner can't fix this — it indexes whatever you give it. The fix is upstream of the miner: a rigid taxonomy at write time.

## 2. The model: Project-Topic-Drawer

```
palace
└── wing  (= project, one per fork or active codebase)
    └── room  (= canonical topic, from a fixed list of 7)
        └── drawer  (= mempalace entry, UUID-addressed)
              └── (closets are auto-built on top of drawers by `mempalace mine`)
```

Three address levels at write-time. Closets are not addressable — they're a derived view.

## 3. Wings

**Wing slug = lower snake_case project name.**

Examples:
- `familiar_realm_watch`
- `mempalace`
- `palace_daemon`
- `realm_sigil`
- `claude_code_switcher`

Rules:
- One wing per repo/project. If a project lives across multiple repos (e.g. a frontend and backend), still one wing per repo unless they share a roadmap.
- No `wing_` prefix. The directory level *is* the wing.
- No agent-name wings (`claude_code`, `aider`, `codex`) — agent identity is metadata on the drawer, not a wing.
- Personal/non-code wings allowed: `homelab`, `infrastructure`, `personal`. Use sparingly.

## 4. Rooms — the canonical seven

| Room | Holds | Distinguishing question |
|---|---|---|
| **architecture** | how things are built, design choices, structural decisions | "How is the system shaped?" |
| **decisions** | explicit choices with rationale, atemporal | "Why did we pick X over Y?" |
| **problems** | bugs, incidents, debugging trails | "What broke and how was it fixed?" |
| **planning** | roadmaps, plans, what comes next | "What are we going to do?" |
| **sessions** | chronological journal entries, session logs | "What did we do on date X?" |
| **references** | pointers to external systems, runbooks, dashboards, docs | "Where do I look this up?" |
| **discoveries** | durable lessons not tied to a single incident | "What truth did we learn?" |

**The rooms are closed-set.** When tempted to add a new room, ask: *is this really a new kind of memory or just a new topic?* Topics go into the closet via tags. Rooms stay rigid.

### 4.1 Disambiguation guide

The two confusable pairs:

**problems vs. discoveries**
- A `problems` drawer is incident-shaped: "X broke at time T, here's the trail." Has a victim and a fix.
- A `discoveries` drawer is lesson-shaped: "X behaves in a non-obvious way Y." Atemporal, usable as a heuristic on the next project.
- *Example:* "chromadb dimensionality=None recovery on 2026-05-11" → `problems`. "chromadb silently degrades when hnswlib import fails" → `discoveries`.

**architecture vs. decisions**
- `architecture` describes *what is* — the current shape.
- `decisions` describes *what was chosen* — with alternatives considered and rationale.
- *Example:* "familiar streams SSE via Bun.serve TransformStream" → `architecture`. "Bun chosen over Node — native TS, no build step, faster spawn" → `decisions`.

**planning vs. sessions**
- `planning` is forward-looking, an artifact (a plan doc, a todo list).
- `sessions` is backward-looking, a journal entry from a specific day.
- *Example:* "Foundation rework plan, 6 phases" → `planning`. "2026-05-11 cascade resolution" → `sessions`.

## 5. Drawers

- Drawer id = mempalace-assigned UUID. Don't touch.
- Drawer body = freeform markdown.
- Drawer metadata: `wing`, `room`, `topic` (free-form tag), `agent` (the LLM or human that wrote it), `entities` (mentioned proper nouns), `timestamp`.

## 6. Closets — out of scope at write-time

Closets are mempalace's index layer: `topic | entities | → drawer_ids`. They are built by `mempalace mine` from drawer content. You never:
- Address a closet directly when writing.
- Decide which closet a drawer goes into.
- Create or rename a closet.

The closet layer is the *retrieval* surface. The taxonomy in this doc is the *write* surface. They meet through the miner.

## 7. Migration plan

**Phase 0 — today.** This spec exists. No code changes. Existing 183k drawers stay in their current (messy) wings and rooms. New writes continue under chromadb.

**Phase 1 — pgvector substrate swap** (deferred until post-cascade quiet, see HANDOFF 2026-05-11). When migrating off chromadb:
- Postgres schema embodies this taxonomy at the table level:
  - `wings (id, slug, name, created_at)`
  - `rooms (id, wing_id, slug ∈ {architecture, decisions, problems, planning, sessions, references, discoveries})`
  - `drawers (id, room_id, body, topic, agent, entities[], embedding vector(384), created_at)`
  - `closets` — materialized view or AGE graph projection over `drawers` grouped by topic.
- Migration script reads existing chromadb drawers, maps each to a `(wing, room)` pair using a heuristic table (room mapping from current chaotic rooms → canonical seven), writes to Postgres.
- Heuristic mapping table built before migration runs — sampled from current data.

**Phase 2 — write-side enforcement.** palace-daemon's `/diary/write` endpoint validates `room ∈ canonical_seven` and rejects free-form room names with a 400 + suggestion of the closest match.

**Phase 3 — backfill cleanup.** Optional. Re-tag existing low-quality wing/room assignments after the miner has had a few weeks of pgvector data to compare against.

## 8. Open questions (resolve before Phase 1)

- Does the room list need an 8th slot for **conversations** (raw chat transcripts as distinct from edited `sessions`)? Current lean: no, transcripts are storage-tier, not knowledge-tier.
- How do we handle drawers that legitimately straddle two rooms (a debugging session that produced a discovery)? Current lean: write two drawers, link via topic tag.
- Wing granularity for monorepos (e.g., `realm.watch` covers `status.realm.watch`, `os.realm.watch`, etc.) — one wing or many? Current lean: many, one per subdomain.

## 9. What this is not

- Not a replacement for closets — closets remain the retrieval index.
- Not a folder structure on disk — it's a logical taxonomy enforced at the daemon's write API.
- Not retroactive — existing drawers don't get renamed unless Phase 3 runs.
- Not a database schema — Phase 1 turns it into one, but this doc is the model, not the DDL.
