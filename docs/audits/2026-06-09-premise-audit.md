# familiar.realm.watch — Premise Audit (2026-06-09)

**Method:** dream-team workflow — 7 parallel readers (design, backend, frontend, ops, memory-loop, tests, trajectory) → 4 adversarial critics (security, hardware-viability, premise-coherence, sustainability) → adversarial verification pass that tried to *refute* every high/critical finding → completeness-gap critic. 24 agents, ~2.7M tokens. Findings below are **only those that survived refutation** (11 of 12 high/critical confirmed; 1 refuted, noted). Read-only audit against HEAD + the uncommitted working tree (search-mode widget, AGE-fused retrieval), treated as current state.

## Bottom line (premise verdict)

The **read half is real, disciplined engineering** — the retrieve→ground→cite pipeline exists, is incident-tested, degrades gracefully, and the project honestly recorded its own negative results (HyDE rescued 0/12 misses). But what runs in production is *"a well-instrumented single-turn RAG chat over the palace, available when the GPUs aren't doing something else"* — and the four headline promises (always-available, private, durable memory, Sonnet-rivaling quality) are each contradicted by the repo's own code, config, or measurements. The newest committed work (`qwen3-coder.service`) structurally displaces the companion from its own hardware. **No document acknowledges the gap** between the premise sold and the artifact shipped. That doc/reality gap — not any single bug — is the headline.

## Critic verdicts

- **Security (lucid):** "Literally zero in-app authentication — `src/familiar.ts` dispatches every route without checking a credential. The single boundary is Caddy forward_auth, and the repo's Caddyfile leaves the memory-*reading* surface (`/v1/*`, `/eval`, `/graph`, `/mcp`) and slot-mutation on an unauthenticated catch-all. The privacy model is inverted relative to the project's reason to exist."
- **Hardware (haze):** "The premise does not fit the hardware, and the live host proves it. The slot subsystem's safety math models a fictional machine: the 5-slot topology has never fit, prod has only ever bound 1 of 5, and the flagship chat unit understates its VRAM 4×. The most probable failure (a GPU wedge on this XID-79/one-fan/81°C box) becomes an infinite SSE hang because no timeout exists on the chat stream path. The code guards the wrong failure modes — errors are themed and bounded while hangs, heat, phantom VRAM, and two-tenant contention are unmodeled."
- **Coherence (vesper):** "Genuinely differentiated; the read half is real. But it's a single-turn, sometimes-on, single-host artifact whose headline promises are each contradicted by its own repo, and no document acknowledges the gap."
- **Sustainability (drift):** "The maintenance surface is far larger than the codebase: two hard forks (mempalace +619, palace-daemon +256 commits, never remergeable), a from-source llama.cpp frozen on an arch CUDA is sunsetting, and a production deploy that is a live Syncthing mirror of uncommitted working trees. After 6 months of neglect it wouldn't crash loudly — it would keep superficially working while accumulating unrestorable backups and an un-upgradable stack, and the single user would lose the thing the premise protects: his memories."

## Confirmed findings (survived adversarial verification)

| # | Severity | Finding | Filed |
|---|----------|---------|-------|
| 1 | critical | Personal palace readable **and writable** via unauthenticated `/v1/*`, `/mcp` (`familiar_recall`), `/eval` (verbatim context dump), `/graph` (KG triples); repo Caddyfile has no `@admin` block despite docs/code claiming one | #95 |
| 2 | high | Stream emits **two `done` chunks per turn** → reflect runs twice → duplicate palace writes + 2× GPU extraction (reproduced empirically) | #96 |
| 3 | high→med | `recentCitations` grows unbounded → session-lifetime drawer exclusion (latent amnesia). Verification found the deeper bug: **server-side session continuity is broken** (no client registers minted session IDs), which also disables turn-history + stuck detection | #97 |
| 4 | high | Reflect writes `room = session UUID`, violating the closed-set 7-room taxonomy; Phase-2 daemon enforcement would silently 400 every reflect write | #98 |
| 5 | high | Every citation **"view in palace →" link 404s** — `GET /api/familiar/memory/:id` was planned, linked-to, never implemented | #99 |
| 6 | high | Companion's most common real state (off, on-demand) has **no designed UX and no wake path** from the PWA; "resting" state only renders when the API is *up* | #100 |
| 7 | high | **24/7-companion invariant is structurally dead**: `qwen3-coder.service` `Conflicts=` the whole companion stack with no doc acknowledgment; slot-picker VRAM math is blind to the ~19 GB coder tenant; a dashboard slot PATCH can silently kill a live local-CC session | #101 |
| — | high | **`:8080` port collision** (qwen3-coder vs familiar-api; raw unauth llama-server on the public domain when companion is off) | **FIXED in-session** → moved to `:8091` (folded into #101) |
| — | high | Slot-picker allow-list "self-DoS" via qwen3-coder entry | **REFUTED** — HTTP surface validates against the registry; `Conflicts=` symmetry is the *intended* VRAM arbiter; allow-list entry needed for read-only probes. (Verifier did surface a stronger latent issue: the deployed allow-list is `familiar:familiar 0644` in a familiar-owned dir, so a compromised `familiar` user can rewrite it — see #106.) |

## Gaps the audit itself almost missed (completeness critic) — filed where concrete

- **KG write-back was never implemented** (#102). Premise promises each turn writes "diary/drawers/**KG updates**"; `palace-client.ts` exposes only `/memory` + `/silent-save`. Every triple reference in `src/` is read-side. Conversations never enrich the graph that grounds future conversations.
- **No isolated palace** (#103). `bun test` writes marker drawers into **production**; eval baselines decay with the living corpus; the recall-roundtrip premise guard can't run offline. A docker-compose pgvector+AGE seeded with a frozen 1–5K-drawer fixture fixes all of these at once.
- **No redaction / no forget path** (#104). Zero scrub logic in `src/`; a secret pasted in chat flows verbatim into diary, reflect, localStorage, and traces, then back into future prompts. No session purge.
- **Embedding-model identity has no owner** (#105). The 375K vectors were embedded by nomic-embed v1.5; the embed slot is PATCHable and only checks `capabilities.includes('embed')`. A swap silently splits the vector space — HTTP 200, wrong results, invisible.
- **Prompt injection via retrieved drawers + LAN trust boundary** (#106). `grounding.ts` injects verbatim drawer text as system prompt; drawers come from miners/web/reflect/possibly-unauth writers. Separately, palace-daemon at `:8085` reportedly accepted a write with an **empty `x-api-key`** — every LAN host bypasses the edge the critics studied.

### Lower-priority gaps (in the report, not filed — promote as needed)

- **localStorage custody**: full conversation history (incl. quoted palace content) sits unencrypted on every device that opened the PWA; no expiry/wipe.
- **No data lifecycle**: palace grew 151K→375K in ~6 weeks, unbounded; `familiar-watchdog` probes HTTP only — disk-full on `/var/lib/mempalace-db` is exactly the silent-write-failure class the project keeps rediscovering.
- **Observability leak**: `chat.ts` logs a trace summary every turn; does drawer/user content land in journald (a second, unaudited memory store)?
- **Non-PWA consumers never exercised**: the voice loop (speech-to-cli) that "companion" most implies was never run end-to-end against familiar.
- **bun runtime unpinned**: deploy rsyncs source and runs whatever bun exists on the host; no `.bun-version`/`--frozen-lockfile` — the exact "works on katana, falters on familiar" drift class.
- **Adoption unmeasured**: nobody quantified conversations/day by the single user — if near-zero, it re-orders every other priority. The data is queryable today (diary drawer counts, session store, Caddy logs).

## Highest-leverage suggestions (synthesized)

1. **Reconcile the exposure model in writing, then gate memory *reads*** — README (tailnet-only) vs design/CLAUDE.md (public) contradict; align the Caddyfile, add the rate-limiting the design already promises. Reads are the sensitive op and are the least protected. *(medium)*
2. **One-line fixes with outsized impact:** `break` after the first done-chunk (#2); window `recentCitations` to N=10 FIFO (#3); implement `GET /api/familiar/memory/:id` (#5). *(small each)*
3. **A `docs/current-state.md` + "Superseded by X" banners** on the four partially-overlapping specs — removes the largest class of doc-rot findings for ~1 hour. *(small)*
4. **A fixture palace** (docker-compose, frozen corpus) — unblocks offline tests, stable eval baselines, and reproducible A/B for the #88 AGE work. *(medium)*
5. **Decide the GPU arbitration model explicitly** — either register qwen3-coder as a registry variant (so the picker's VRAM math + dashboard see it) or document modal operation and surface it in the UI so a slot PATCH warns before killing a live session. *(medium)*

### Filed from the suggestions tier (2026-06-09)

- **#107** — off-host backup leg + verified restore + failure alerting (drift's "highest value-per-hour fix"; nightly pg_dump reportedly a 20-byte artifact).
- **#108** — no timeout anywhere on the chat stream path → a GPU wedge becomes an infinite SSE hang.
- **#109** — versioned deploy + one-command rollback; record what production actually runs.
- **#110** — teach the watchdog the on-demand era (tenant-aware, backup/unit-failure alerting, thermal/XID/VRAM telemetry).

## Fixed during the audit session (2026-06-09)

- **`:8080` public-exposure / port collision** → qwen3-coder moved to LAN-only `:8091`; familiar.jphe.in no longer proxies to a raw coder.
- **Tool-call grammar leak** (`<function=>` as text) → root-caused to a 3,264-rule GBNF (from the full MCP surface) that *fails to parse* → unconstrained output; fixed client-side via `--strict-mcp-config` in `~/.local/bin/claude-local-qwen`. (Operator-tooling fix, not a repo change.)

_Full raw findings + verifier notes: `scratch/audit-2026-06-09/extract.json`._
