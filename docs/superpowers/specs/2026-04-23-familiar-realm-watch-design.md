# familiar.realm.watch — Design

- **Project:** `familiar.realm.watch`
- **Date:** 2026-04-23
- **Status:** Draft — pending final author review
- **Primary host:** `familiar` (10.0.6.115, currently `jp-Latitude-7390`, to be renamed)
- **Adjacent host:** `katana` (10.0.6.129, workstation — palace data home until v0.3)

---

## One-line summary

A local-first, mempalace-native AI companion ("the familiar") running on a dedicated LAN inference box — orchestrates a small LLM + @rboarescu's palace-daemon + JP's jphein-fork of mempalace into a chat surface that reads the palace before it speaks and writes the palace after, serving voice, web, MCP, and OpenAI-compatible consumers across the realm.

## Goals

1. **Be the voice of mempalace.** Every chat turn executes the MemPalace Memory Protocol: retrieve palace context → ground the response → write diary/drawers/KG updates.
2. **Provide a stable LLM surface** consumable by the entire realm.watch ecosystem: speech-to-cli for voice, map_server/realm-portal for realm services, Claude Code as a `cc`-provider local fallback, open MCP clients, web chat UI.
3. **Solve the "auto-surfacing context" open problem** named in jphein/mempalace's README by binding retrieval-then-generate into every conversation turn rather than hoping the model remembers to search.
4. **Close as much of the engram-2 17% E2E gap as small local models allow**, primarily through a grounded answer layer (faithfulness + citations + refusal mitigation) rather than chasing R@5 benchmarks.
5. **Compose prior art, don't rebuild it.** Use palace-daemon for multi-client coordination, jphein-fork for per-process reliability, Ollama/llama.cpp for inference, Emmimal's context-layer framework for retrieval shaping. Write only the glue.
6. **Match the realm architecture.** Versioned with realm-sigil, registered in status.realm.watch, served via Caddy on ubox0, themed dark/light, integrates with Authelia for write auth.

## Non-goals

- **Not building a new mempalace.** We consume it through stable surfaces (palace-daemon HTTP + MCP) and will not reach into Python internals — Ben's upstream TS rewrite will reshape those.
- **Not replacing cloud models.** Local familiar targets the ~70% of daily queries that are memory-anchored and latency-sensitive. Hard reasoning + long documents still defer to cloud Sonnet via `cc teams` fallback. The spec is explicit about the quality envelope.
- **Not solving multi-client concurrency ourselves.** palace-daemon owns that axis.
- **Not building a new MCP client for Claude Code.** palace-daemon ships `mempalace-mcp.py`; we use it.
- **Not a multi-tenant product.** Single-user (JP), LAN-scoped, Authelia-gated for public exposure.

## Context — what exists, what changes

| Thing | State | Changes |
|---|---|---|
| **mempalace (jphein fork)** | Production on katana, 165,915 drawers, 28 wings, 68 rooms, tracks upstream/develop | No internal changes — we consume it through palace-daemon |
| **palace data** | `/home/jp/Projects/mempalace-data/palace/` on katana | Stays there through v0.2; migrates to familiar in v0.3 |
| **palace-daemon (@rboarescu)** | Active upstream, v-recent, FastAPI gateway with read/write/mine semaphores, pins correctness at mempalace ≥3.3.2 | **New install on katana (v0.1) → migrates to familiar (v0.3)** |
| **katana Claude Code MCP** | Uses `plugin_mempalace_mempalace` directly | Swaps to `mempalace-mcp.py` bridge pointing at palace-daemon |
| **10.0.6.115 box** | Stale hostname `jp-Latitude-7390`, idle, Ryzen 9 3900X + 2x4GB GTX + 15GB RAM | Renamed to `familiar`, becomes inference server, P40 upgrade in v0.3 |
| **speech-to-cli, map_server, etc.** | Use cloud APIs today for their AI needs | Redirect OpenAI-compat calls to familiar (drop-in replacement) |
| **cc provider switcher** | Teams/direct/bedrock/vertex/foundry | Add `familiar` as a local tier |

## Architecture

### Host layout

| Host | Role | Services |
|---|---|---|
| **familiar** (10.0.6.115) | 24/7 LAN inference server | Ollama(s), familiar-api, familiar-web (Bun-served), (v0.3+) palace-daemon |
| **katana** (10.0.6.129) | Workstation, palace data home until v0.3, llama.cpp dev playground (v0.2+) | palace-daemon (systemd-user), (v0.2+) llama.cpp server |
| **ubox0** | Existing Caddy reverse proxy | Adds `familiar.jphe.in` route with Authelia gating |

### v0.1 data flow

```
  Clients                                               familiar host
  ─────────                                             ──────────────
  ┌─────────────────┐                           ┌────────────────────────┐
  │ Claude Code     │──────── HTTP/SSE ────────▶│ familiar-api (Bun+TS)  │
  │ (cc provider)   │                           │                        │
  ├─────────────────┤                           │ /v1/chat/completions   │
  │ speech-to-cli   │──── OpenAI-compat ───────▶│ /v1/embeddings         │
  ├─────────────────┤                           │ /api/familiar/*        │
  │ realm services  │──────── REST ────────────▶│ /api/version           │
  ├─────────────────┤                           │ /mcp  (MCP HTTP)       │
  │ MCP clients     │──── MCP-over-HTTP ───────▶│ / (PWA chat UI)        │
  ├─────────────────┤                           └─┬──────────────────────┘
  │ PWA chat UI     │──────── HTTP ────────────▶│ │
  │ familiar.jphe.in│                           │ │
  └─────────────────┘                           │ │
                                                │ ▼
                                                │ Ollama :11434,:11435
                                                │   GPU0: chat model
                                                │   GPU1: embed model
                                                │
  katana host                                   │
  ────────────                                  │
  ┌─────────────────────────────┐               │
  │ palace-daemon :8085         │◀──────────────┘  (HTTP + MCP-over-HTTP)
  │   FastAPI gateway           │
  │   read/write/mine semas     │
  │   └─ mempalace (jphein fork)│
  │       └─ /home/jp/Projects/ │
  │          mempalace-data/    │
  │          palace/            │
  └─────────────────────────────┘
         ▲
         │ mempalace-mcp.py bridge (localhost)
  ┌──────┴──────────────────────┐
  │ katana Claude Code MCP      │
  └─────────────────────────────┘
```

### v0.3 data flow (post P40 migration)

- palace-daemon moves from katana → familiar
- palace data rsync'd over, katana palace dir preserved for 2 weeks
- katana Claude Code's mempalace-mcp.py bridge now points at `familiar:8085`
- familiar's Ollama runs Qwen 14B + BGE-M3 + BGE-reranker on the P40
- katana's llama.cpp stays as dev/experimentation endpoint
- familiar-api's primary Ollama URL updated

## Components

Two services we build, three we install + configure.

### Build: `familiar-api` (TypeScript + Bun)

- Entry: `src/familiar.ts` — Bun HTTP server with routes + MCP endpoint
- Modules:
  - `src/palace-client.ts` — palace-daemon HTTP wrapper (`/search`, `/memory`, `/mcp` proxy)
  - `src/ollama-client.ts` — Ollama HTTP wrapper with circuit breaker
  - `src/memory-protocol.ts` — orchestrates a chat turn (retrieve → compress → generate → write)
  - `src/mcp-server.ts` — exposes `familiar_chat`, `familiar_recall`, `familiar_reflect`
  - `src/grounding.ts` — faithfulness / citation / refusal prompt composition
  - `src/retrieval/` — 5-component pipeline (hybrid α-blend, rerank, decay, extractive compress, budget allocator)
  - `src/sessions.ts` — in-memory session store (60-min TTL)
  - `src/lang/familiar-voice.ts` — themed user-facing error strings
  - `src/sigil.ts` — realm-sigil integration (`/api/version`)
  - `src/health.ts` — `/api/familiar/health`
- Config: env vars + `config.toml`; secrets via vault
- Deployed: `/srv/familiar/` on familiar host, systemd unit, port 8080

### Build: `familiar-web` (static PWA)

- Served by the same Bun process from `web/` directory
- Dark/light via `prefers-color-scheme` + CSS variables, realm aesthetic
- PWA manifest + service worker for installable + offline shell
- Streams `/v1/chat/completions` (SSE) for token-by-token display
- Citation rendering: `[drawer_id]` markers become hover popovers with wing/room/date + "view in palace"
- No framework for v0.1 — hand-rolled HTML/CSS/JS; evaluate Solid.js or Svelte in v1.0 if complexity warrants

### Install: Ollama (on familiar)

- Package: `ollama` via official install script (CUDA 12.x compatible)
- Two systemd units for explicit GPU pinning (v0.1):
  - `ollama-chat.service` — `CUDA_VISIBLE_DEVICES=0`, `:11434`, model stays loaded
  - `ollama-embed.service` — `CUDA_VISIBLE_DEVICES=1`, `:11435`, model stays loaded
- In v0.3 (P40): collapses to one unit, one GPU, 3-4 models loaded
- Model cache: `/var/cache/ollama`

### Install: palace-daemon (on katana v0.1, on familiar v0.3)

- Clone `@rboarescu/palace-daemon`
- Edit `requirements.txt` to install mempalace from `~/Projects/memorypalace` (jphein fork, editable) — critical: we want fork reliability, not vanilla upstream
- Config via env: `PALACE_API_KEY` from vault, `--palace /home/jp/Projects/mempalace-data/palace` (v0.1) or `/var/lib/palace-daemon/palace` (v0.3)
- Deploy as `systemctl --user enable --now palace-daemon`
- Port 8085, LAN-only, never public

### Install/configure: Caddy route (on ubox0)

- `familiar.jphe.in` → `http://familiar:8080`
- Authelia forward-auth on `/api/familiar/memory/*`, `/api/familiar/reflect`, `/mcp`
- Public read on `/v1/*` so OpenAI-compatible tools work without Authelia config
- TLS via existing Let's Encrypt wildcard

## The MemPalace Memory Protocol — what happens on every chat turn

This is the product. Everything else is plumbing to make this work well.

### Protocol summary (from palace's `mempalace_status`)

> 1. ON WAKE-UP: Call `mempalace_status` to load palace overview + AAAK spec.
> 2. BEFORE RESPONDING about any person, project, or past event: call `mempalace_kg_query` or `mempalace_search` FIRST. Never guess — verify.
> 3. IF UNSURE about a fact: say "let me check" and query the palace. Wrong is worse than slow.
> 4. AFTER EACH SESSION: call `mempalace_diary_write` to record what happened, what you learned, what matters.
> 5. WHEN FACTS CHANGE: call `mempalace_kg_invalidate` on the old fact, `mempalace_kg_add` for the new one.

familiar-api enforces this protocol as a deterministic turn-pipeline rather than relying on the chat model to remember.

### Per-turn pipeline (v0.2 target — full Emmimal 5-component)

```
1. PARSE request (user message, session, wing scope hint)

2. RETRIEVE in parallel (2s timeout, circuit-breaker-wrapped):
   ├─ palace-daemon /search  (vector + BM25 fallback, honors wing scope)
   ├─ palace-daemon /mcp → mempalace_kg_query  (only if named entity detected)
   └─ session.recentCitations  (dedup; don't re-inject last turn's context)

3. HYBRID RETRIEVAL α-BLEND (Emmimal component 1)
     hybrid_score = α · embedding_score + (1−α) · bm25_score   (α default 0.65)

4. RERANK with domain weighting (Emmimal component 2; v0.2+ uses
   BGE-reranker cross-encoder on top-50 → top-5 when available)
     final_score = base_score × 0.68 + tag_importance × 0.32
     tag_importance = 1.4 if drawer wing matches request wing, else 1.0
     bonus also for: recent writes (last 48h), user-flagged importance

5. EXPONENTIAL DECAY (Emmimal component 3; client-side until upstream #1032)
     recency = e^(−decay_rate × age_seconds)
     effective = importance × recency × freshness + relevance_boost

6. EXTRACTIVE COMPRESSION (Emmimal component 4)
   For each selected drawer >500 chars, pick 2-3 sentences with
   highest token overlap with user turn, preserving original order.
   Full drawer text remains addressable by drawer_id citation.

7. TOKEN-BUDGET SLOT ALLOCATOR (Emmimal component 5)
   total 8k budget:
     system prompt .......... 1500 tokens  (persona + AAAK + grounding)
     palace context ......... 4000 tokens  (retrieved + compressed drawers)
     conversation history ... 2000 tokens  (last N turns from session)
     response reserve ....... 512 tokens
   Hard-drop lowest-scored drawers until fit; never silently truncate mid-drawer.

8. COMPOSE SYSTEM PROMPT (grounding layer):
   ── Familiar persona ──
   [themed persona + AAAK preamble]

   ── Palace context (5 drawers) ──
   [drawer_abc123 · wing=realmwatch · room=technical · 2026-04-12 · similarity=0.82 · matched_via=drawer]
   <verbatim content, possibly extractive-compressed>

   ── Palace search quality ──
   available_in_scope: 12,202 drawers searched
   warnings: ["vector search returned 3 of 5; filled 2 via sqlite+BM25 fallback"]
   matched_via: [drawer, drawer, drawer, sqlite_bm25_fallback, sqlite_bm25_fallback]

   ── Grounding directives ──
   - Answer only from the palace context above. If the answer is
     not present, say "I don't have that in the palace."
   - Cite drawer IDs for every factual claim: [drawer_abc123].
   - If the palace contains multiple values for the same thing,
     list them and name the ambiguity — do not pick one.
   - If palace context contains the answer, you MUST use it — do
     not refuse with "I don't know" when the retrieval clearly has
     the information. Only refuse when truly empty or contradictory.

   ── Conversation history ──
   [last N turns]

9. GENERATE via Ollama (or llama.cpp on katana's 2080 Ti in v0.2+)
   - stream tokens to client
   - track citations referenced; dedup into session.recentCitations

10. POST-STREAM writes (fire-and-forget, 2s budget, never blocks user):
    ├─ If turn contains durable content: palace-daemon POST /memory
    ├─ If user stated/changed a typed fact: palace-daemon /mcp → mempalace_kg_add
    │   (and mempalace_kg_invalidate on conflicting predecessor)
    └─ Buffered diary writer: accumulate AAAK summary; flush every 10 turns
       or at session end via /mcp → mempalace_diary_write
```

### v0.1 simplification

v0.1 ships a *subset* of the pipeline:
- Step 2-3: palace-daemon /search (hybrid + BM25 fallback is free via jphein fork's #1005)
- Step 7: token budget allocator (essential)
- Step 8: grounding layer (faithfulness/citation/refusal directives)
- Step 9-10: generate + async writes

**Deferred to v0.2:** Steps 4 (rerank with cross-encoder), 5 (explicit decay), 6 (extractive compression).

This ships something honest and usable in a week without deferring indefinitely.

### Metacognition / abstention (grounding layer)

- **Confidence gate:** if top palace result distance > 0.7 (weak retrieval) AND no KG hit, prefix response with *"I don't have strong palace context for this — best guess follows."*
- **Stuck detection:** if the model asks familiar-api to re-query palace 3+ times within a session with similar queries, surface a user-facing hint: *"I'm searching the palace repeatedly — you may need to rephrase or point me at a wing."* (pattern from harreh3iesh/engram's PreToolUse hook)
- **Eval hook:** `/api/familiar/eval` accepts `(question, expected)` and runs the full protocol, returning faithfulness (cited from context?), relevance, refusal-rate, and retrieval telemetry. Aligns with multipass-structural-memory-eval's Category 9 Handshake.

## Model choices — per milestone

| Milestone | Chat | Embed (familiar's own) | Rerank | Hardware |
|---|---|---|---|---|
| **v0.1** | `qwen2.5:3b-instruct-q4_K_M` (~2.1GB) | `nomic-embed-text:v1.5` (~300MB) | — | 2× GTX 4GB on familiar |
| **v0.2** | v0.1 + katana's `llama-server -m Qwen2.5-7B-Instruct-Q5_K_M.gguf --flash-attn` (~5GB) | same as v0.1 | optional: BGE-reranker-v2-m3 if faithfulness metrics show gap | 2× GTX on familiar + 2080 Ti on katana |
| **v0.3** | `qwen2.5:14b-instruct-q4_K_M` (~9GB) | `bge-m3` (~2.3GB, 8k ctx, 1024-dim, multilingual) | `bge-reranker-v2-m3` (~560MB cross-encoder) | P40 24GB on familiar |

### Why Qwen 2.5

- Strong instruction compliance for "only answer from context" — critical for the grounding layer
- 32k context at 14B, plenty for extractive-compressed palace injections
- Ollama-supported, GGUF community-supported for llama.cpp
- Active model family (Qwen 3 will land, drop-in upgrade path)

### Why BGE-M3 (v0.3)

- 8k context allows chunking drawers without MiniLM's 256-token cap (addresses jphein fork's #1024 chunk-size issue)
- Multilingual — aligns with mempalace v4 roadmap (#488/#442)
- 1024-dim, strong retrieval on technical text per MTEB leaderboard
- 2.3GB fits comfortably alongside Qwen 14B on P40

### Palace-daemon's internal embedder (unchanged)

palace-daemon (via jphein fork) continues using its default ONNX all-MiniLM-L6-v2 on CPU. All 165,915 existing drawers stay indexed without migration. Familiar's own nomic-embed / BGE-M3 is for *its own* retrieval paths (web UI document upload, user-supplied RAG corpora) — separate vector space, separate job.

### Honest capability envelope

- **v0.1** (3B model): shipping-grade for stack validation, weak on faithfulness. Expect ~30-40% E2E QA on hard memory questions, high refusal rate, occasional citation errors. **Cloud fallback via `cc teams` is a first-class feature, not an afterthought.**
- **v0.2** (7B model via katana): meaningful bump — faithfulness and citation compliance noticeably improve. Expect ~50-60% E2E QA on memory-anchored queries.
- **v0.3** (14B model on P40): rivals cloud Sonnet on memory-anchored queries (est. 70-80% E2E QA). Cloud fallback reserved for long-document reasoning and novel problem solving.
- None of this is the 98.4% retrieval number. Per engram-2, retrieval recall ≠ answer quality; we optimize for E2E.

## Hardware inventory

| Host | CPU | RAM | GPU (v0.1) | GPU (v0.3) | Disk |
|---|---|---|---|---|---|
| **familiar** (10.0.6.115) | Ryzen 9 3900X 12C/24T | 15GB | GTX 1050 Ti 4GB + GTX 970 4GB | **Tesla P40 24GB** | 234GB NVMe, 188GB free |
| **katana** (10.0.6.129) | i7-9700K 8C/8T | 32GB | RTX 2080 Ti 11GB (Turing 7.5) | unchanged | 938GB NVMe, 439GB free |

### P40 upgrade notes (v0.3 prerequisites)

- [ ] Confirm PSU wattage and available connectors (EPS 8-pin for P40 — usually shipped with adapter)
- [ ] Cooling: 3D-printed shroud + 40mm/60mm PWM fan (passive card, mandatory)
- [ ] BIOS: enable "Above 4G Decoding" on the ASUS TUF B450M-PLUS
- [ ] Physical length: ~10.5" full-length dual-slot — verify case clearance
- [ ] Pull GTX 1050 Ti + GTX 970, install P40 in PCIEX16_1 (full x16 lanes)
- [ ] Driver 570.x already supports Pascal P40; no kernel or CUDA reinstall needed

## Error handling & graceful degradation

### Principle

Two voices in the system: **engineer-facing** (HTTP status, structured JSON logs, `/health`) and **user-facing** (themed, in-character, degraded-but-graceful). Never conflate them.

### Failure matrix

| Failure | Engineer-facing | User-facing | Degrade to |
|---|---|---|---|
| palace-daemon unreachable | WARN + health flip | *"The palace is quiet this turn — I speak from base knowledge alone."* | Chat continues without context; queue pending diary writes |
| palace-daemon slow (>2s) | INFO latency metric | silent | Skip context injection; continue generation |
| palace-daemon write failure | WARN + retry once + drop | silent | Log to `/srv/familiar/pending-writes.jsonl` for manual replay |
| Ollama chat down | ERROR + breaker trips | *"My voice falters — the resonance is unsettled."* | 503 to client; cc-fallback re-routes to cloud |
| Ollama embed down | WARN | silent | palace-daemon's internal ONNX search still works |
| GPU OOM | ERROR | *"This thought is too large — let me try something smaller."* | If a smaller model is loaded, auto-retry with it at half context; otherwise drop context injection and retry (in v0.1 only the one 3B model exists; in v0.3 the chain is 14B → 7B → 3B); if still fails, 503 |
| Context budget overrun | DEBUG | silent | Drop lowest-scored drawers until fit; surface dropped count in `/debug` |
| Palace corruption | CRITICAL + `notify-send` + raise quest in os.realm.watch | *"The palace is being mended — I speak without memory until it is whole again."* | Full chat fallback with no palace; admin acknowledgment required |
| Concurrency exhaustion | INFO queued-ms | up to 500ms: silent; after: *"The palace is busy — a moment."* | Exponential backoff max 3s; then skip context |
| Bun process crash | systemd restart | stream breaks; PWA reconnects invisibly | `Restart=on-failure`, 5s backoff |
| Rate-limit abuse | WARN + 429 | *"The familiar is catching her breath."* | Per-IP token bucket; Authelia already gates writes |

### Circuit breakers

Per-downstream (palace-daemon, Ollama chat, Ollama embed, katana llama.cpp): close/open/half-open. 3 failures in 30s → open for 60s → half-open probe. Prevents one bad minute from soaking request slots.

### Themed voice

All user-facing degradation strings live in `src/lang/familiar-voice.ts`. One file, one place to retheme or translate the entire personality. Enables future per-user persona variants (warm / stoic / laconic / verbose).

### Health endpoint

`GET /api/familiar/health` → JSON with: service info, realm-sigil version, dependency health (palace-daemon, Ollama chat, Ollama embed, optional llama.cpp on katana), circuit breaker states, last diary write timestamp. Polled by status.realm.watch every 60s.

## Deployment

### v0.1 deployment order

1. **Rename 10.0.6.115 → familiar**
   - `sudo hostnamectl set-hostname familiar`
   - Update `/etc/hosts`, OpenWrt internal DNS
   - Reboot to verify

2. **Install Ollama on familiar**
   - Official install script
   - Create two systemd units pinning GPUs 0 and 1
   - `ollama pull qwen2.5:3b-instruct-q4_K_M` + `ollama pull nomic-embed-text:v1.5`

3. **Install palace-daemon on katana (systemd-user)**
   - Clone `@rboarescu/palace-daemon`
   - Pip-install jphein-fork in editable mode as its mempalace dep
   - `PALACE_API_KEY` from `bw get password "palace-daemon-v1"`
   - `systemctl --user enable --now palace-daemon`
   - Verify `curl localhost:8085/health`

4. **Swap katana's mempalace MCP**
   - Backup: `cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%s)`
   - Replace `plugin_mempalace_mempalace` entry with palace-daemon bridge config
   - Restart Claude Code session, verify tools still work

5. **Build & deploy familiar-api**
   - Repo at `~/Projects/familiar.realm.watch`
   - `bun install`, TS compiled in-place (Bun native TS)
   - rsync to `familiar:/srv/familiar/`
   - systemd unit, starts on boot
   - Bun serves PWA at `/` and API at `/v1/*`, `/api/*`, `/mcp`

6. **Configure Caddy on ubox0**
   - Add `familiar.jphe.in` route
   - Authelia forward-auth on write endpoints
   - TLS via existing wildcard

7. **Register with status.realm.watch**
   - Add `https://familiar.jphe.in/api/version` to checks.json version array

### Rollback paths (v0.1)

| If | Rollback |
|---|---|
| palace-daemon misbehaves | Revert `~/.claude/settings.json` from backup → direct plugin, zero data loss |
| familiar-api crashes loop | systemd retries; if chronic, stop unit, PWA shows downtime banner |
| Caddy route breaks | Remove route from ubox0 Caddyfile; familiar still reachable at `http://familiar:8080` over LAN |

### v0.3 palace migration

1. **Preparation**
   - Confirm palace-daemon backup endpoint works on katana
   - Run `POST /backup` on katana palace-daemon, verify `.tar.zst` on disk
   - Full `rsync -avP katana:/home/jp/Projects/mempalace-data/palace/ familiar:/var/lib/palace-daemon/palace/`

2. **Switchover**
   - Stop palace-daemon on katana
   - Start palace-daemon on familiar with new path
   - Smoke-test: `curl familiar:8085/health`, `curl familiar:8085/stats`
   - Update katana's mempalace-mcp.py bridge URL from `localhost:8085` → `familiar:8085`
   - Update familiar-api config: `PALACE_DAEMON_URL=http://localhost:8085`

3. **Preservation (two weeks)**
   - Leave katana's palace dir untouched for 14 days
   - If anything breaks: stop familiar's palace-daemon, repoint katana bridge to `localhost`, restart katana's daemon
   - After 14 days with no issues: archive + delete katana palace dir

### Operations

- **Logs:** systemd journal per host; JSON-structured lines; `journalctl -u familiar-api -o cat | jq` for post-hoc
- **Backups:** palace-daemon `/backup` endpoint on nightly cron, 7-day retention, rsync to katana for offsite-ish safety
- **Monitoring:** status.realm.watch health poll every 60s; Prometheus exporter optional v1.0
- **Deploys:** realm-sigil version + `/ship` skill convention
- **Secrets:** vault (Vaultwarden) — `palace-daemon-v1`, `familiar-api-cookie-secret`, `familiar-api-admin-token`

## Milestones

### v0.1 — "The familiar speaks" (1 week)

Scope: validate the stack end-to-end with minimal retrieval sophistication.

- [ ] Rename 10.0.6.115 → familiar
- [ ] Install Ollama on familiar (2 systemd units, GPU pinning)
- [ ] Pull Qwen 2.5 3B + nomic-embed
- [ ] Install palace-daemon on katana (systemd-user, jphein-fork as mempalace dep)
- [ ] Swap katana Claude Code MCP to bridge
- [ ] Build familiar-api v0.1: chat proxy + palace search + grounding prompt + token budget + stream
- [ ] Build familiar-web v0.1: minimal themed PWA
- [ ] Caddy route + Authelia + status.realm.watch registration
- [ ] realm-sigil version endpoint
- [ ] Vault entries for secrets
- [ ] Smoke-test integration: cc provider, speech-to-cli, one realm service

Exit criteria: speak-and-remember loop works end-to-end. Voice works. Web PWA works. cc-fallback works. Palace writes land. System is ugly-but-functional.

### v0.2 — "The familiar remembers better" (1 week)

Scope: quality + katana llama.cpp integration.

- [ ] Install llama.cpp on katana (build from source with CUDA + flash-attn)
- [ ] Pull Qwen 2.5 7B GGUF, serve via llama-server on katana:11434
- [ ] familiar-api: multi-endpoint failover with circuit breakers (primary katana, fallback familiar, cloud fallback via cc)
- [ ] Add Emmimal components 4 (rerank) + 5 (decay) + 6 (extractive compression)
- [ ] Optional: BGE-reranker-v2-m3 if faithfulness metrics indicate need
- [ ] Citations rendered in PWA (hover popovers)
- [ ] Confidence gate + stuck detection
- [ ] Add `/api/familiar/eval` for multipass Category 9-style E2E eval
- [ ] Add MCP server (`familiar_chat`, `familiar_recall`, `familiar_reflect`)
- [ ] Diary buffering + flush every 10 turns + on session end

Exit criteria: measurably better faithfulness + citation rate on `/api/familiar/eval`; llama.cpp quality is A/B-testable vs Ollama 3B vs cloud.

### v0.3 — "The familiar comes home" (1 week)

Scope: P40 hardware + palace migration.

- [ ] P40 physical install (cooling, EPS adapter, BIOS toggle)
- [ ] Pull GTX 1050 Ti + GTX 970
- [ ] Reconfigure Ollama: single instance, one GPU
- [ ] Pull Qwen 14B + BGE-M3 + BGE-reranker
- [ ] Palace migration katana → familiar (rsync, cut over, preserve old)
- [ ] palace-daemon runs on familiar (systemd-system this time)
- [ ] Update katana's bridge to remote URL
- [ ] Update familiar-api primary endpoint
- [ ] katana's llama.cpp stays as dev endpoint
- [ ] Post-migration smoke tests
- [ ] Retire deployment of GTX cards

Exit criteria: P40 serving production; 14B model is default; palace on familiar; katana palace dir untouched for 14-day observation window.

### v1.0 — polish (ongoing, no deadline)

- Flutter desktop + mobile app (decision point: only if PWA gap is felt)
- Per-user sessions (multi-tenant when we want family-grade sharing)
- Multi-palace routing (addresses @kostadis's curated-vs-auto-mined concern in upstream #1018)
- New voice in speech-to-cli roster for the familiar
- Prometheus exporter + Grafana dashboard
- Re-evaluate fork directly integrating with Ben's upstream TS mempalace when it ships

## Testing approach

- **v0.1:** manual smoke tests + one integration test per consumer (cc, speech-to-cli, realm-service)
- **v0.2:** `/api/familiar/eval` with a curated 50-question set drawn from palace-anchored queries JP has actually asked; report: faithfulness rate, citation rate, refusal rate, retrieval recall, E2E QA
- **v0.3:** same eval suite across v0.1/v0.2/v0.3 model tiers for publishable A/B
- **Unit tests** (Bun's built-in test runner): retrieval pipeline components, grounding prompt composition, token budget allocator, circuit breaker state machine, session TTL
- **Integration tests:** stand up palace-daemon + Ollama in Docker Compose for CI; run canonical chat flow; verify faithfulness markers present

## Open questions (for v1.0 consideration)

1. **Does the familiar need a proper name?** "Familiar" is a role; a name like Sparrow, Nyx, Vale, Aria is identity. Affects voice/persona cohesion in speech-to-cli. Not blocking.
2. **Flutter v2 necessity?** If the PWA covers Android install + Web Push + WebAuthn biometric + offline service worker, Flutter may never be needed. Revisit at v1.0.
3. **Should familiar access other realm services' data** (realmwatch telemetry, os.realm.watch quests) as structured context, not just mempalace? Potential v0.3+ feature, shapes the wing-scoping logic.
4. **cc-provider integration shape** — does familiar surface as its own tier in `cc` (`cc familiar`) or is it wired into `cc direct` as a local-first URL? Depends on how cc resolves endpoints today.
5. **Multi-client rate-limit strategy** — token bucket per IP is v0.1; if voice + web + realm-services all hammer simultaneously, may need priority lanes (interactive > bg voice > bulk) at v0.2+.
6. **Does palace-daemon need per-request auth** beyond shared API key, given Authelia already gates the public surface? Probably not, but worth noting.

## Sources & prior art

### Directly used

- **[palace-daemon (@rboarescu)](https://github.com/rboarescu/palace-daemon)** — the coordination gateway we depend on; imposes the daemon-only access model
- **[jphein/mempalace](https://github.com/jphein/mempalace)** — JP's production fork with silent-save determinism, HNSW quarantine, search warnings + `available_in_scope` + BM25 fallback
- **[milla-jovovich/mempalace](https://github.com/milla-jovovich/mempalace)** — upstream; consumed through palace-daemon's stable surface, not directly
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** — MCP TS SDK for familiar's MCP server
- **[Ollama](https://ollama.com)** — inference on familiar
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** — inference on katana (v0.2+)
- **[realm-sigil](https://github.com/jphein/realm-sigil)** — versioning per project convention

### Shaped the design

- **jphein fork README's three architectural principles** — verbatim-first, hierarchy-as-optional-scope, retrieval-is-the-investment. Honored throughout.
- **codingwithcody "MemPalace: digital castles on sand"** ([post](https://codingwithcody.com/2026/04/13/mempalace-digital-castles-on-sand/)) — critique that produced fork principles 1-2
- **Emmimal P Alexander — "RAG isn't enough, I built the missing context layer"** ([post](https://towardsdatascience.com/rag-isnt-enough-i-built-the-missing-context-layer-that-makes-llm-systems-work/), [repo](https://github.com/Emmimal/context-engine)) — 5-component framework is the spine of the memory protocol
- **lhl/agentic-memory [ANALYSIS-mempalace.md](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-mempalace.md)** — seeded jphein fork's roadmap; informs the "headline R@5 isn't the same as palace quality" framing
- **[engram-2 (199-biotechnologies)](https://github.com/199-biotechnologies/engram-2)** — the 17% E2E QA critique is the single most important finding; motivates the grounding layer (faithfulness + citations + refusal mitigation)
- **[multipass-structural-memory-eval (M0nkeyFl0wer)](https://github.com/M0nkeyFl0wer/multipass-structural-memory-eval)** — Category 9 "Handshake" is our intended eval target in v0.2+
- **[harreh3iesh/engram](https://github.com/harreh3iesh/engram)** — stuck detector pattern adopted for familiar's metacognition
- **upstream mempalace #1032 (@zackchiutw) rerank + Weibull decay pipeline** — until it ships, familiar does client-side decay in v0.2
- **upstream mempalace #1024 chunk-size config** — motivates the BGE-M3 upgrade in v0.3 (larger chunks need longer-context embedder)

### For future reference

- **[Karta (@rohithzr)](https://github.com/rohithzr/karta)** — contradiction detection, dream-engine feedback. Deprioritized upstream but the contradiction-detection idea maps onto familiar's KG write path
- **[Celiums](https://celiums.ai/)** — PAD emotional vectors + circadian + importance scoring on write; potential v1.0+ enrichment layer
- **[Gigabrain](https://github.com/legendaryvibecoder/gigabrain)** — 30+ junk-filter patterns on write; adopt for diary write quality
- **[cdd-mempalace (@fuzzymoomoo)](https://github.com/fuzzymoomoo/cdd-mempalace)** — Context-Driven Development overlay onto mempalace; not integrated but useful reference for structured wing taxonomies

---

*End of design. Next step: spec self-review, user review, then writing-plans.*
