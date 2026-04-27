# Changelog

All notable changes to familiar.realm.watch.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html) and the
[realm-sigil](https://github.com/jphein/realm-sigil) convention used across
the realm.watch ecosystem.

## [0.3.11] — 2026-04-26 — *streamed markdown*

### Changed — chat surface

- **Markdown renders during stream, not just at `[DONE]`**
  (`web/app.js`, `web/style.css`). Previously chunks updated
  `textContent` and the parser ran once at the end, causing a
  visible "snap" as headings, bullets, and code blocks resolved
  all at once. Now `streamingMarkdownRender` finds the last
  paragraph boundary outside any open code fence, parses
  everything before it as markdown DOM, and appends the trailing
  in-flight text as a `stream-tail` span with `pre-wrap`. Every
  paragraph crystallizes into proper markdown the moment its
  closing `\n\n` arrives.
- **rAF coalescing** — many SSE chunks per frame collapse to one
  parse via `requestAnimationFrame`. Markdown parse is sub-ms on
  typical assistant turns; this keeps the UI smooth without
  re-parsing per token.
- **Citations + source chips + syntax highlighting + copy buttons
  still apply once at stream end.** They depend on the final text
  being stable and aren't worth flickering during stream.

## [0.3.10] — 2026-04-26 — *the familiar shows the palace*

### Added — palace tab

- **chat / palace tabs in the header** (`web/index.html`,
  `web/style.css`). Toggle between the chat transcript and a
  palace-structure view. Active tab gold-highlighted; matches
  realm-sigil's accent color.
- **Palace treemap** (`web/app.js`). Wings as cards sorted by
  drawer count, each card shows: wing name, drawer count, a
  proportional gold progress bar, and the top 6 rooms with
  per-room counts. Auto-fills the screen on a 240px grid.
- **Tunnels list.** `palace_graph.tunnels` (rooms that span
  multiple wings, like `technical` appearing in 17 wings) renders
  beneath the treemap as a one-line-per-room view with wing chips.
- **Stats line** at the top of the tab: total drawers, wing count,
  tunnel count, kg triple count. On JP's 151K-drawer palace it
  reads `150,891 drawers · 36 wings · 9 tunnels · 3 kg triples`.
- **`/api/familiar/graph` is already cached server-side** (5min TTL
  via `handleGraph`). The PWA caches in-memory per session;
  manual `↻` button forces a refetch.

### Why now

Reflect made write-side visible (v0.3.6/0.3.7), edit/delete made
it curatable (v0.3.9), but operator awareness of the *whole* palace
was still text-only via `/api/familiar/health`. The palace tab
gives you a structural map you can scan at a glance — see where
the volume actually is, which rooms thread across wings, which
wings are growing.

## [0.3.9] — 2026-04-26 — *the familiar lets you curate*

### Added — memory editing

- **`DELETE /api/familiar/memories/{drawer_id}`** removes a drawer
  from palace via the new daemon endpoint.
- **`PATCH /api/familiar/memories/{drawer_id}`** updates content
  (and optionally wing/room) on an existing drawer.
- **Sidebar memory items get ✎/✕ buttons on hover.** Click ✎ to edit
  inline (the fact becomes a `contenteditable` field with cursor
  positioned at the end); click ✓ to save (persists via PATCH) or
  click ✕ to delete (confirms first, then removes via DELETE).
- **`palace-client.deleteDrawer()` + `updateDrawer()`** as typed
  client methods backed by daemon's new endpoints.

### Cross-repo

- `palace-daemon@0d216a2` exposes DELETE /memory/{id} and PATCH
  /memory/{id} (wraps `mempalace_delete_drawer` and
  `mempalace_update_drawer` which already existed in mempalace).

### Why this matters

v0.3.6/0.3.7 made reflect *visible*; this release closes the trust
loop — when the 7B extractor produces noisy facts, you can now drop
them. Without delete/edit, palace fills up with whatever extraction
happened to land. With it, reflect is a curated write surface.

## [0.3.8] — 2026-04-26 — *the familiar speaks aloud*

### Added — voice (Web Speech API)

- **Voice section in sidebar** with auto-speak toggle + system-voice
  picker. Both persist in `localStorage` under `familiar_voice_state`.
  Picker prefers en-* voices first, sorted by name. Falls back gracefully
  on browsers without Web Speech API (toggle disabled, picker shows
  "speech not supported").
- **Per-message ♪ speak button** on every assistant turn (visible on
  hover, always shown on touch). Click once to speak; click while
  speaking to stop. Reloaded session transcripts get speak buttons too.
- **Auto-speak when toggle is on** — every newly streamed assistant
  turn is read aloud as soon as the stream completes.
- **Stop on submit** — sending a new message cancels in-flight speech
  so the familiar doesn't talk over the next exchange.
- **Markdown stripped before TTS** — code blocks dropped (read as
  "code block omitted"), inline code unwrapped, asterisk emphasis
  removed, citation chips and `[wing=…]` source headers excluded,
  headings flattened. No more "drawer underscore xyz" mid-sentence.

### Why browser-native and not speech-to-cli?

Web Speech API is built in, works offline, requires zero server
plumbing, and ships with quality voices on every modern OS. The
v0.1 design spec earmarks "new voice in speech-to-cli roster for
the familiar" as a v1.0 polish item — that's where the custom-voice
work goes. For v0.3 the right move is to surface the capability
now with what every browser already has.

## [0.3.7] — 2026-04-26 — *the memories list works*

### Fixed

- **Memories panel returned wing=projects drawers** instead of
  wing=reflect. palace-daemon's `/search` route silently dropped
  the `wing` query param (route signature only accepted q/limit/kind),
  so the filter never reached mempalace's searcher. Even if it had,
  the filter is honored only on vector matches and falls back to
  BM25-across-everything when the query has no embeddable content.

  Fix has two parts:
  - palace-daemon got a new `GET /list?wing=&room=&limit=&offset=`
    route that wraps `mempalace_list_drawers` (already existed in
    mempalace; the daemon just hadn't exposed it). Query-free,
    metadata-only browse. Verified via verify-routes.sh.
  - familiar's `palace-client.ts` gained `listDrawers()` which
    normalizes the daemon's `{drawers: [{drawer_id, content_preview}]}`
    shape to PalaceSearchResult so call sites stay uniform.
  - `/api/familiar/memories` now uses the list path. The reflect
    panel renders actual reflect drawers sorted by recency.

### Cross-repo

- `palace-daemon@1.7.x` ([ec0eb82](https://github.com/jphein/palace-daemon/commit/ec0eb82))

## [0.3.6] — 2026-04-26 — *the familiar shows its work*

### Added — reflect observability

- **`GET /api/familiar/memories`** (`src/routes/memories.ts`).
  Returns reflect-written drawers from `wing="reflect"` ranked by
  recency. Optional `session_id` (filters by `room`) and `limit`
  (default 50, max 100) query params. Read-only.
- **Memories panel in the sidebar** (`web/index.html`,
  `web/style.css`, `web/app.js`). Shows the most recent reflect
  drawers under the sessions list with their text, room, and
  relative date. Refreshes after each chat turn that wrote
  drawers, on visibility-change, and on manual `↻` click.
- **Per-stage timing** (`src/reflect/types.ts`,
  `src/reflect/writer.ts`, `src/routes/chat.ts`,
  `web/app.js`). Reflect now reports `{extract_ms, gate_ms,
  dedup_ms, write_ms, total_ms}` per turn. SSE event includes
  it; the reflect pill renders a small mono line beneath the
  summary like `extract 1240ms · dedup 380ms · write 90ms · total 1710ms`
  so the operator can see where the budget goes.
- **Decision metadata** (`src/reflect/types.ts`). Each
  `ReflectDecision` now carries `ts` and `session_id` so a future
  audit log can render across-session views without correlating
  by drawer body.

### Test suite

- 184 tests, ~402 expect() calls, 0 failures, typecheck clean.

## [0.3.5] — 2026-04-26 — *named in full*

### Fixed

- **Sigil sidebar showed only the noun** ("EMBER", "KEYSTONE") instead
  of the full two-word realm-sigil name ("NOBLE EMBER", "GILDED
  KEYSTONE"). `extractWord` was carried over from the v0.2 single-word
  fallback ("wildwood") and never updated to match the canonical
  realm-sigil contract. Now extracts everything before " · hash"
  (the magical name half), so the PWA matches `/api/version`'s
  `version` field.

## [0.3.4] — 2026-04-26 — *the familiar knows the hour*

Two integrations landed: realm-sigil canonical contract (replaces the
hand-rolled `src/sigil.ts`) and clock.realm.watch (both visual + the
time-anchor pattern that grounds the model in the current moment).

### Added — clock integration

- **"── Now ──" anchor in the system prompt** (`src/grounding.ts`).
  Same pattern clock.realm.watch's `time-anchor.sh` SessionStart hook
  uses for Claude Code: a single `Sunday 2026-04-26 18:13 PDT` line
  prepended to every grounding prompt. The 7B model now answers
  "what day is it?" with the actual current date instead of guessing
  from training-data heuristics. Recomputed per turn (cheap), so a
  session crossing midnight reflects the new date by the next message.
- **Sidebar clock panel** (`web/index.html`, `web/style.css`,
  `web/app.js`). Adapted from clock.realm.watch (stellar realm),
  recolored to familiar's fantasy palette, scaled down to fit under
  the sigil. Shows `HH:MM` + seconds + weekday-date + `TZ · zone`.
  Same format the server-side anchor uses, so the sidebar mirrors
  what the model sees.

### Changed — realm-sigil integration (full canonical adoption)

- `src/sigil.ts` rewritten to import from `realm-sigil` package
  (vendored at `vendor/realm-sigil/` so the `file:` dep resolves on
  the deployed host). Schema follows the canonical contract:
  `version` is the magical name (`Noble Ember · 3495895`),
  `pkg_version` is the semver, `commit_url` is populated. PWA's
  `d.version.word` still works because we extract it from the noun
  half of the magical name as a top-level convenience field.
- `realm-sigil` itself bumped 1.0.0 → 1.1.0 with a new `bunHandler`,
  `.git_info` reader in `gitInfo()`, runtime detection, and TS types.
  See realm-sigil CHANGELOG for details.
- `ops/scripts/deploy-familiar.sh` now sources the canonical
  `~/Projects/realm-sigil/deploy-banner.sh` and uses
  `realm_sigil_pre` (top of script — banner is the first line of
  output) plus `realm_sigil_post` (after smoke test, fetches
  `/api/version`). Removed bespoke bash word-table duplication.
- `.git_info` baked at deploy time (instead of `sigil.json`); the
  realm-sigil `gitInfo()` reads it on production.

### Test suite

- 184 tests, ~402 expect() calls, 0 failures, typecheck clean.

### Cross-repo work this release

- `realm-sigil@1.1.0` ([3dd90a0](https://github.com/jphein/realm-sigil/commit/3dd90a0))
- `bestiary` now serves `/api/version` via the same `bunHandler`
  ([2c2ad01](https://github.com/jphein/bestiary/commit/2c2ad01) — local commit)
- Audit run across portfolio, oracle, realm-portal, status.realm.watch,
  realmwatch, clock.realm.watch — all already canonically integrated.
  `os.realm.watch` remains the one realm.watch project with no
  realm-sigil integration.

## [0.3.3] — 2026-04-26 — *the familiar's seams hold*

### Fixed

- **Sigil word stuck at `wildwood` across all releases** (`src/sigil.ts`,
  `ops/scripts/deploy-familiar.sh`, `.gitignore`). The deploy excludes
  `.git` from rsync, so `git rev-parse HEAD` returned empty in
  production and the word fell back to a hardcoded literal. Now the
  deploy script bakes a `sigil.json` with `{hash, branch, dirty}`
  before rsync; sigil.ts reads it first, falls back to live git for
  dev. Word now rotates with each commit. v0.3.2 retroactively reads
  as `quillhearth`.
- **Code fences directly below headings rendered as raw text**
  (`web/app.js`). When the model emitted `#### app/__init__.py\n\`\`\`python\n…`
  with no blank line between, `splitBlocks` glued heading + fence into
  one block, neither parser branch matched, and the paragraph fallback
  dumped the literal backticks + code body as text. `splitBlocks` now
  force-flushes at fence openers, heading lines, and horizontal-rule
  lines (matches CommonMark on these boundaries).

### Changed

- Service worker cache `v7 → v8`.

## [0.3.2] — 2026-04-26 — *the familiar speaks plainly*

PWA polish + grounding voice fix. Same evening as v0.3.1; the sigil
word changes with the version so this is the visible cue that the
PWA shell has materially improved since you opened it last.

### Added — chat surface

- **Always-visible turn footer** (`web/app.js`, `web/style.css`).
  Below every assistant message: `✦ N drawers grounded this turn`
  (expandable to source list with snippet + similarity) and a reflect
  pill that surfaces the actual pipeline state (`✦ N remembered` /
  `no new memories` / `reflect skipped (turn brief)` /
  `reflect still working…`). Replaces the previous "hidden when empty"
  UI which made the pipeline invisible.
- **Markdown rendering** (`web/app.js`). Inline parser, no deps,
  ~250 lines. Handles paragraphs, **bold**, *italic*, `code`, fenced
  code blocks, # headings, - / 1. lists, [text](url) links, bare URLs,
  ~~strikethrough~~, `> blockquotes`, `---` horizontal rules, GFM
  tables with `:---` alignment. Hard line break via trailing 2+ spaces.
  Output is DOM nodes built via `textContent` and `appendChild` only —
  no `innerHTML`, so model output can't smuggle HTML.
- **Syntax highlighting** (`web/highlight.min.js`, themes). highlight.js
  124KB bundled (not CDN) so the PWA still works offline. atom-one-dark
  / atom-one-light themes via `prefers-color-scheme`. Service worker
  pre-caches on install — no flash-of-unstyled-code.
- **Copy button on code blocks** (`web/app.js`, `web/style.css`).
  `navigator.clipboard.writeText`, vanilla. Fades in on hover (always
  visible on touch). Flashes `copied` → `copy` on success.
- **Sessions sidebar** (`web/index.html`, `web/style.css`,
  `web/app.js`). Permanent 260px left sidebar on desktop with the
  sigil + sigil-word + sessions list + new-session button. Mobile
  (≤720px) collapses to a slide-out drawer behind a scrim, triggered
  by a hamburger in the chat header.
- **Source chips** for verbatim `[wing=X · room=Y · ...]` markers
  the model echoes from the system prompt: render as a `❖ projects ·
  technical` pill with full metadata in the title attribute.
- **Themed scrollbars** — gold-tinted thin scrollbars (Firefox
  `scrollbar-color/width` + WebKit `::-webkit-scrollbar*`).

### Changed — chat surface

- **Reflect race against a 4s budget.** `runReflect` returns a
  `ReflectOutcome` with a `skipped` reason (`no_writer | too_short |
  timeout | error | null`); the chat stream emits `event: reflect`
  with the outcome before `[DONE]` regardless. Whatever's slower (the
  extractor LLM call, per-fact dedup, palace writes) continues in the
  background past the budget — drawers still get written, the stream
  just doesn't block. Fixes the "submit button stuck after first
  message" bug observed in v0.3.1.
- **Status pill — finer-grained palace state.** Reads
  `dependencies.palace_daemon.recall_quality` from
  `/api/familiar/health`. States: `connected` (accent),
  `palace slow` / `palace rebuilding` (warn yellow),
  `palace busy` / `offline` (red).
- **Citation discoverability.** `[d8a3ce]` markers now have a leading
  `✦`, soft-fade-in animation, hover lift, open-state highlight.
- **Grounding prompt rewritten** (`src/grounding.ts`). Old DIRECTIVES
  said "answer ONLY from palace context, must use it for factual
  claims" — so asking "what is your strength?" returned the literal
  "strength level is set to 0.65" from a config drawer. New prompt:
  - prefers palace for facts about JP/realm/projects/events
  - answers from PERSONA on meta-questions about the familiar itself
  - explicitly forbids literalizing technical config values as
    personality traits
  - allows honest "thin context" answers instead of forced citations
    of system/infra drawers
- **Drop `_italic_` and `__bold__` from markdown parser.** Underscores
  are load-bearing in identifiers (snake_case Python,
  `mempalace_search`, `url_for`); the parser was eating them in
  prose. Asterisk forms only.

### Changed — PWA basics

- iOS install metadata: `apple-mobile-web-app-capable`,
  `apple-touch-icon`, `mask-icon`, `viewport-fit=cover`,
  safe-area-inset padding.
- Manifest extended: `lang`, `dir`, `scope`, `orientation`,
  `categories`, split `purpose` icons (`any` + `maskable`).
- Service worker cache `familiar-shell-v1` → `v7` over the v0.3.2
  release; SHELL list extended to include hjs assets.

### Test suite

- 183 tests, ~398 expect() calls, 0 failures, typecheck clean.

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
