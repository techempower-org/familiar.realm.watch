# Changelog

All notable changes to familiar.realm.watch.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html) and the
[realm-sigil](https://github.com/jphein/realm-sigil) convention used across
the realm.watch ecosystem.

## [0.3.1] — 2026-04-26 — *the familiar's window*

PWA polish patch: surfaces what reflect just remembered, distinguishes
palace states, makes citations discoverable, preserves multi-session
state in localStorage, adds proper iOS PWA install metadata, and
leans the visual identity further toward fantasy without adding deps.

### Added — chat surface

- **Reflect SSE event** (`src/routes/chat.ts`). After the assistant turn
  streams, the chat route runs `ReflectWriter.review(...)` synchronously
  and emits `event: reflect\ndata: {summary, decisions}` before `[DONE]`.
  Length-gated: assistant turns shorter than 80 chars skip extraction
  (avoids spending an LLM call on greetings). Wired via the optional
  `reflectWriter` dep on `ChatRouteDeps`.
- **Reflect pill in PWA** (`web/app.js`, `web/style.css`). Renders
  below each assistant message: `✦ N remembered · M already known`.
  Click expands a detail panel listing each fact + status. Hidden
  when reflect ran but found nothing.
- **Multi-session sidebar** (`web/app.js`, `web/index.html`,
  `web/style.css`). Click the rotating sigil to open a session list.
  Each session has a label (auto from first user turn, renameable),
  relative timestamp, and delete affordance. Sessions persist in
  `localStorage` under `familiar_sessions`; legacy single-id form
  migrates on first load.
- **Per-session transcript persistence**. Reload preserves the active
  session's history. Switching sessions replays the transcript.

### Changed — chat surface

- **Status pill — finer-grained palace state**. Now reads
  `dependencies.palace_daemon.recall_quality` from `/api/familiar/health`:
  `connected` (green/accent), `palace slow` / `palace rebuilding`
  (warn yellow), `palace busy` / `offline` (red).
- **Citation discoverability**. `[d8a3ce]` markers now have a leading
  `✦`, soft-fade-in animation when first rendered, hover lift, and
  open-state highlight. Removes the "looks like a build artifact"
  problem.
- **Sigil → button**. The header sigil is now an interactive control
  (opens sessions panel) with slow continuous rotation (60s/turn,
  respects `prefers-reduced-motion`). New nested-circles layout adds
  visual weight without new files.
- **Sigil-word in header**. The build's realm-sigil word (e.g.,
  `wildwood`) now renders as a small caps line under the title,
  fed from `/api/familiar/health` version block.
- **Glyph flourish on assistant turns**. Subtle `✦` in the top-left
  margin of each assistant message; serif body lifts to 1.02rem with
  1.55 line-height.
- **Parchment grain**. Fixed-position radial accent gradients on
  `body` (no images, GPU-cheap).
- **Send button**. Plain `→` replaced with a clean SVG arrow that
  nudges right on hover.

### Changed — PWA basics

- **iOS install metadata** (`web/index.html`):
  `apple-mobile-web-app-capable`, `apple-touch-icon`, `mask-icon`,
  `viewport-fit=cover`, safe-area-inset padding. Standalone-mode
  install on iOS now picks up the right title and status-bar style.
- **Manifest extended** (`web/manifest.webmanifest`): explicit
  `lang`, `dir`, `scope`, `orientation`, `categories`, and split
  `purpose` icons (`any` + `maskable` separate entries — Chrome's
  preferred shape).
- **Service worker cache version**: `familiar-shell-v1` →
  `familiar-shell-v2` so installed clients pick up the new shell.

### Test suite

- 183 tests, ~397 expect() calls, 0 failures, typecheck clean.
- No new server-side tests; all changes are CSS/HTML/client-JS plus
  a chat-route addition that preserves existing behavior when
  `reflectWriter` is undefined (back-compat shape).

## [0.3.0] — 2026-04-26 — *the familiar writes back*

### Added — reflect loop (Subsystem A)

- **`POST /api/familiar/reflect`** (`src/routes/reflect.ts`). Operator-
  triggered endpoint. Body: `{session_id, assistant_turn}`. Runs the
  candidate-extraction → gate → dedup → palace.writeMemory pipeline
  and returns a `{decisions[], summary}` JSON. Off the chat hot path;
  errors degrade silently. v0.4 will add automatic per-session
  triggering via Stop hook. Gated by Authelia `@write` matcher in
  ubox0's Caddyfile.
- **`ReflectWriter`** (`src/reflect/writer.ts`). Orchestrator that
  stitches the four reflect modules. Wing-scoped writes (default:
  `wing="reflect"`, `room=<session_id>`) so reflect-written drawers
  are attributable and bulk-removable.
- **`extractCandidates`** (`src/reflect/extractor.ts`). LLM-based
  fact extraction via the existing `InferenceRouter`. JSON-array
  protocol with a one-shot example in the prompt; permissive parser
  accepts both `{fact, source_span}` objects and bare-string array
  entries (small models like Qwen 2.5 3B sometimes emit the latter).
  Robust to malformed output (returns `[]` rather than throwing).
- **`gate`** (`src/reflect/gate.ts`). Pure-logic filter: drops
  refusal patterns, leading hedges, and stubs (<20 chars).
- **`dedupCheck`** (`src/reflect/dedup.ts`). `palace.search` top-1
  with strict-greater-than threshold (default 0.85). Defensive on
  missing `drawer_id`.
- **Types** (`src/reflect/types.ts`): `ReflectCandidate`, `ReflectDecision`.

### Investigated and reverted (Subsystem C)

Two read-side rerank attempts measured against jp-realm-v0.1 and
reverted because the data didn't justify shipping them:

- **bm25 blend in `domainRerank.baseScore`** (`eb0b640`, reverted by
  `d2bf8a0`). Mempalace fork's `_hybrid_rank` already does an
  identical 0.6/0.4 blend internally. Net effect: zero.
- **`CANDIDATE_LIMIT=20` window expansion** (`55d8889`, reverted by
  `f4f2cce`). Wing-match boost (×1.4) elevated same-wing-irrelevant
  drawers above correct answers when the candidate pool widened.
  Net regression (76.67% → 71.67%). 4 questions regressed, 3 improved.

Both kept in commit history for the lesson; baseline JSONs in
`multipass-structural-memory-eval/baselines/jp_realm_v0_1_familiar_v0.3_*.json`.

### Changed

- `PalaceDrawer.matched_via` type widened to include
  `"sqlite_bm25_fallback"` (memorypalace fork #1005's value).

### Test suite

- 183 tests, ~397 expect() calls, 0 failures, typecheck clean.
- New test files: `tests/reflect/{gate,dedup,extractor,writer,route}.test.ts`.

### Documentation

- v0.3 spec: `docs/superpowers/specs/2026-04-26-familiar-v0.3-design.md`
- v0.3 plan: `docs/superpowers/plans/2026-04-26-familiar-v0.3.md`

### Eval baseline (jp-realm-v0.1)

- v0.2.1 entering v0.3: 76.67% recall, 17 full hits, 29/30 hit-rate
- v0.3.0 after smoke:   78.33% recall, 18 full hits, 29/30 hit-rate

q14_hermes_agent flipped 0.5 → 1.0 because the reflect smoke turn
wrote a drawer about hermes-agent that now surfaces `agent` in
retrieval. v0.4's automatic per-session reflect should compound this
across many turns.

## [0.2.1] — 2026-04-26 — *eval-driven hardening*

Patch release: reliability + retrieval fixes surfaced by the first
multipass-structural-memory-eval baseline run against the live palace.
30-question jp-realm-v0.1 corpus; recall 73.33% → 76.67%, hit-rate
90.00% → 96.67% across the v0.2.0→v0.2.1 cut.

### Fixed

- **Trailing-punctuation embedding distortion** (`src/palace-client.ts`).
  A single trailing `?` was observed dropping a known-good drawer from
  sim=0.562 (#1) to outside top-5 entirely on the live 151K-drawer palace.
  nomic-embed-text v1.5 produces meaningfully different embeddings for
  "What is X" vs "What is X?". Strip trailing sentence terminators
  (`?!.,;:`) at the client layer so chat, eval, and MCP all benefit.
  Internal punctuation (apostrophes, commas) preserved.
- **`PALACE_SEARCH_TIMEOUT_MS` 2000ms → 5000ms** (deploy default +
  production env). Real-world p99 search latency on a 151K palace
  legitimately touches 1.9-2.0s; the prior boundary caused ~10% of
  baseline runs to error with `palace_unreachable`. 5s gives ~2.5×
  headroom on observed tail latency.

### Diagnostic baseline

- 154 tests pass, typecheck clean.
- Eval baselines committed in
  `multipass-structural-memory-eval/baselines/jp_realm_v0_1_*.json`
  alongside the corpus YAML at `sme/corpora/jp_realm_v0_1/questions.yaml`.

## [0.2.0] — 2026-04-26 — *the familiar remembers better*

### Added — retrieval pipeline (Emmimal components 2-4)

- **Domain-weighted reranker** (`src/retrieval/rerank.ts`). Adjusts palace
  search similarity using wing-match × 1.4 boost and 48h recency bonus.
  Pure metadata math, no ML model — preserves raw `cosine`/`bm25` for
  telemetry.
- **Exponential temporal decay** (`src/retrieval/decay.ts`). Multiplies
  similarity by `exp(-λ × age_days)` with default 30-day half-life.
- **Extractive sentence compression** (`src/retrieval/compress.ts`). Trims
  drawers >500 chars to top-3 sentences by Jaccard token overlap with the
  query, in original order. Full body remains addressable by drawer ID.
- **Confidence gate + stuck-loop detector** (`src/grounding.ts`,
  `src/sessions.ts`). System-prompt directives that trigger `voice.weakContext`
  when retrieval is weak (top similarity < 0.3 AND fewer than 2 results)
  or `voice.stuckSearching` when 2+ recent queries Jaccard-overlap > 0.7.

### Added — multi-endpoint inference

- **`LlamaCppClient`** (`src/llama-client.ts`). HTTP client for llama.cpp's
  OpenAI-compatible `/v1/chat/completions`, translating SSE chunks into
  OllamaChatChunk shape so it's a drop-in alternative to OllamaClient.
- **`InferenceRouter`** (`src/inference-router.ts`). Tries providers in
  priority order with per-endpoint circuit breakers. Recursively
  satisfies its own `InferenceChatProvider` interface (composable today,
  rlm-ready for v0.3).
- **llama.cpp on katana** (`ops/katana/install-llama.sh` +
  `ops/katana/llama-server.service`). Build script, systemd-user unit,
  Qwen2.5-7B Q5_K_M loaded on RTX 2080 Ti GPU0 (~5.9GB VRAM). Primary
  inference route when `LLAMA_CPP_URL` is set; falls back to Ollama
  on familiar.

### Added — observability + measurement

- **`POST /api/familiar/eval`** (SME adapter contract). Implements
  multipass-structural-memory-eval's required shape: returns `answer`,
  verbatim `context_string` (tiktoken-counted by multipass), SME-shaped
  `retrieved_entities`, `retrieved_edges` (empty in v0.2; KG triples in
  v0.3+), and `error`. `mock=true` skips inference for retrieval-only
  testing.
- **`Trace` per-turn record** (`src/trace.ts`). Structured per-turn ledger:
  `trace_id`, `query`, `wing_scope`, `retrieved`, `context_string`,
  `answer`, `citations`, `warnings`, `duration_ms`. Emitted as a final
  SSE event when chat is requested with `?trace=1`; always logged as
  one-liner to journal.
- **`GET /api/familiar/graph`** proxy. Caches palace-daemon's `/graph`
  (5-minute TTL — the underlying call takes ~30s on a 151k-drawer palace).
- **`palace_daemon.recall_quality`** field on `/api/familiar/health`.
  Distinguishes `ok` / `empty_hnsw` (rebuild needed) / `probe_error`
  (daemon busy) — surfaces HNSW degradations to status.realm.watch's
  60s poll instead of hiding them in chat-trace warnings.

### Added — durable writes

- **`DiaryBuffer`** (`src/diary-buffer.ts`). In-memory accumulator of
  per-turn entries, flushes every 10 turns or on graceful shutdown
  (SIGTERM/SIGINT). Failed flushes restore entries to the head of the
  queue. Wired through palace-daemon's `/silent-save` endpoint, which
  itself queues to `palace-daemon-pending.jsonl` during palace rebuilds
  — no client-side retry needed.

### Added — agent surface

- **MCP server** (`src/mcp-server.ts`) at `/mcp` exposing three tools:
  `familiar_recall`, `familiar_reflect`, `familiar_chat`. Uses
  `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`
  for native fit with Bun.serve. Any MCP client (Claude Code, Cursor,
  custom agents) can now call into the familiar.

### Added — PWA

- **Citation popovers** (`web/app.js` + `web/style.css`). Replaces
  `[drawer_xxx]` markers in assistant responses with click-to-open
  popover buttons. DOM-only (no `innerHTML`); `?trace=1` SSE events
  feed entity metadata into popovers (wing/room/snippet). Link target
  uses `<body data-viz-base-url=...>` for one-config swap to
  mempalace-viz when deployed.

### Added — type seam

- **`Provenance` enum** (`src/types.ts`). Every `SmeEntity` carries
  `{ kind: "observed" }` in v0.2; v0.3+ adds `dream` (background reasoning)
  and `synthesized` (multi-hop traversal) variants. Adopted from karta's
  pattern; no consumer code changes when v0.3 lifts more provenance kinds.

### Changed

- **`kind=content` filter** is now passed on every palace search
  (`src/palace-client.ts`). Excludes Stop-hook checkpoint drawers which
  otherwise dominate vector similarity on heavily-autobiographical
  palaces. Validated on a 151K-drawer palace.
- `PalaceDrawer` type carries `topic`, `matched_via`, `cosine`, `bm25`
  (surfaced by the memorypalace fork). Rerank/decay preserve via spread;
  raw scores stay intact for eval telemetry.
- Bun.serve `idleTimeout`: default 10s → 60s. Palace-daemon's `/graph`
  takes 30-40s on big palaces; the default would kill the connection.
- `palace.health()` is now bounded by `searchTimeoutMs` (was unbounded —
  could hang familiar's `/api/familiar/health` indefinitely when the
  daemon was wedged).

### Fixed

- `extractiveCompress` null-text safety + `filtered_null_text_N`
  warning. Live palace returns some legacy drawers with `text: null`;
  the pipeline used to crash and get mislabeled `palace_unreachable`.
- `deploy-familiar.sh`: idempotent `.env` write (preserves operator
  overrides), `--exclude .env` on host-side rsync (was being deleted
  by `--delete`), `systemctl restart` instead of `enable --now` (the
  latter no-ops when the unit is already running).
- `sigil.ts` reads version from `package.json` at module load instead
  of a hardcoded literal.

### Test suite

- 152 tests, 332 expect() calls, 0 failures, typecheck clean.
- New test files: `tests/llama-client.test.ts`, `tests/inference-router.test.ts`,
  `tests/eval.test.ts`, `tests/trace.test.ts`, `tests/graph.test.ts`,
  `tests/diary-buffer.test.ts`, `tests/mcp-server.test.ts`,
  `tests/health.test.ts`, plus `tests/retrieval/{rerank,decay,compress}.test.ts`.

### Documentation

- v0.2 plan: `docs/superpowers/plans/2026-04-24-familiar-v0.2.md`
- katana ops: `ops/katana/install-llama.sh`, `ops/katana/llama-server.service`

## [0.1.0] — 2026-04-23 — *the familiar speaks*

End-to-end stack live:

- Ollama chat (Qwen 2.5 3B Q4, GPU0) + embed (nomic-v1.5, GPU1) on familiar
- palace-daemon (jphein fork mempalace) on katana → later moved to disks
- familiar-api (Bun + TS) at familiar:8080 with retrieve+ground+budget
  pipeline, SSE streaming chat, OpenAI-compat surface
- PWA shell + service worker
- Caddy route on ubox0 with Authelia gating
- realm-sigil version endpoint, status.realm.watch registration

Tag: [v0.1.0](https://github.com/jphein/familiar.realm.watch/releases/tag/v0.1.0)
