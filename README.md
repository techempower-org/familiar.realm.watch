# familiar.realm.watch

Local-first AI companion — reads [mempalace](https://github.com/techempower-org/mempalace) before speaking, writes it after. Part of the [realm.watch](https://realm.watch) ecosystem.

## Stack

- **familiar-api** — TypeScript + [Bun](https://bun.sh) HTTP + MCP server
- **familiar-web** — Static PWA served from the same Bun process
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** (`llama-server`) — Local LLM inference (chat + embed + extract + HyDE + reflect) on GPU via OpenAI-compatible `/v1/*` API. Built locally from source on familiar with `-DCMAKE_CUDA_ARCHITECTURES=52;61` to support Pascal SASS. Stock Ollama doesn't ship Pascal SASS in its prebuilt binaries and silently CPU-fallbacks — we migrated off it on 2026-05-15.
- **[palace-daemon](https://github.com/techempower-org/palace-daemon)** — mempalace coordination gateway (our fork — adds hook detach, postgres backend gates, `/cypher` + `/embed`, `/search/keyword` + `/search/hybrid`, `/backfill-age`)
- **[mempalace](https://github.com/techempower-org/mempalace)** — mempalace fork, pip-installed into palace-daemon (adds postgres + pgvector + Apache AGE backend, hybrid search, canonical room taxonomy, KG writethrough)
- **Caddy + Authelia** — TLS termination + Authelia forward-auth on ubox0. Tailnet-only; not public-facing. See [ubox0/docs/three-horizon-dns.md](https://github.com/jphein/ubox0/blob/main/docs/three-horizon-dns.md) for the split-horizon DNS setup.

## Hosts

- `katana` (10.0.6.129) — workstation; dev/test target for familiar-api
- `familiar` (10.0.6.124) — production. Runs `familiar-api` (Bun/TS), `palace-daemon` (postgres gateway), `mempalace-db` (Docker, postgres + pgvector + AGE, 375K+ drawers, 1.7M KG triples), plus the llama-server inference variants. Two **P102-100** GPUs (10 GB each).
- `ubox0` (10.0.6.11) — tailnet-side TLS edge + dnsmasq for the `*.jphe.in` zone

## Quickstart (dev)

```bash
bun install
cp .env.example .env  # edit as needed
bun run dev
```

## Layout

- `src/` — familiar-api TypeScript modules
- `tests/` — Bun tests (`bun test`)
- `tests/eval/` — Python eval harnesses (`paraphrase_questions.yaml` + `run_paraphrase_probe.py` for HyDE A/B; see [CHANGELOG](CHANGELOG.md) "2026-05-15")
- `web/` — PWA assets (served by Bun at `/`)
- `ops/` — systemd units, Caddy snippets, install/deploy scripts
- `docs/superpowers/` — spec + implementation plans

## Dashboard

The web UI at `https://familiar.jphe.in/` is a **Wave Terminal-style block dashboard** — every UI element is a movable, resizable block with its own settings drawer.

- **Chat block** — conversation UI with streaming responses, palace grounding, reflection
- **Palace block** — browse drawers + wings + rooms
- **Slot picker block** — change which model serves each of the five inference slots (chat / embed / extract / HyDE / reflect) without touching systemd by hand. See [docs/slot-picker.md](docs/slot-picker.md).
- **Stat widgets** — GPU / CPU / memory / disk / network bars fed by `/api/familiar/stats`. See [docs/stat-widgets.md](docs/stat-widgets.md).
- **Add-block picker, layout presets, reset, settings drawers** — see [docs/dashboard.md](docs/dashboard.md).

Layout persists per browser via `localStorage`. Mobile collapses to a single column. Theme variables in `web/style.css` enforce a parchment+sigil-gold aesthetic that responds to `prefers-color-scheme`.

## Inference slots

Familiar runs five distinct inference workloads, each independently switchable:

| Slot | Workload | Default backend | Variant types |
|---|---|---|---|
| `chat` | `/v1/chat/completions` | llama-server or Ollama | qwen 7B/14B/coder, gemma 4B, phi-4 |
| `embed` | `/v1/embeddings` | Ollama (nomic-embed-text v1.5) | ollama-only today |
| `extract` | KG triple worker (`mempalace.kg_triple_worker`) | llama-server phi-4-mini | dedicated GPU pin |
| `hyde` | Pre-search hypothetical-doc generator | shares chat | designed for a tiny model |
| `reflect` | Post-turn fact extraction | shares chat | designed for structured output |

Pick a variant per slot from the dashboard's slot-picker block, or via the admin endpoint:

```
PATCH /api/familiar/admin/slots/:slot   { "variant_id": "chat-gemma3-4b-gpu1" }
```

The slot resolver mtime-caches `/var/lib/familiar/slots.json` and re-reads on change, so PATCH takes effect on the very next chat/embed request. Authelia-gated.

## Retrieval modes

- **Hybrid (default)** — `PALACE_SEARCH_MODE=hybrid` (the default). Daemon-side `candidate_strategy="hybrid"` fuses vector ∪ BM25 ∪ AGE graph-expanded candidates and hybrid-reranks. AGE knowledge graph populated via inline writethrough (`MEMPALACE_KG_WRITETHROUGH=1`) + one-shot backfill for existing drawers. Falls back to vector-only on daemon 503/404.
- **Temporal query expansion** — `src/memory-protocol.ts` detects date-relative words ("yesterday", "last week", "N days ago") and appends resolved ISO dates, helping BM25 match against drawer timestamps.
- **HyDE** — plumbed end-to-end (`/v1/chat/completions` and `/api/familiar/eval`) but **gated off in production**. Enable per-process via `PALACE_USE_HYDE=true` or per-request via `/api/familiar/eval?hyde=true`. Diagnosis: HyDE is structurally weak for institutional-memory corpora — [#6](https://github.com/techempower-org/familiar.realm.watch/issues/6) has the full investigation.

## Production ops

- **familiar-watchdog** — on-host `/health` probe + restart-counter alert + ntfy paging on WARN events. Systemd timer on `familiar`.
- **Functional health probes** — `/health` sends real chat + embed requests (not just model-list pings).
- **Pre-deploy parse check** — `ops/scripts/` catches JS syntax errors before rsync.

## Inference variants

Beyond the five builtin slots, familiar also runs **Qwen36-coder** (Qwen3.6-35B-A3B UD-Q3_K_XL, 16.8GB MoE) as the default lane for Claude Code on katana. Enabled via `claude-local-qwen` launcher, routed through `http://familiar:8091`. See [HA pipeline integration spec](docs/superpowers/specs/2026-07-25-ha-pipeline-integration.md) for the full architecture.

## Docs

- [Design spec](docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md)
- [Hybrid search + taxonomy spec](docs/superpowers/specs/2026-05-14-hybrid-search-taxonomy-spec.md)
- [Foundation rework spec](docs/superpowers/specs/2026-05-10-foundation-rework-design.md)
- [v0.1 implementation plan](docs/superpowers/plans/2026-04-23-familiar-v0.1.md)
- [Hybrid search + taxonomy plan](docs/superpowers/plans/2026-05-14-hybrid-search-and-taxonomy.md)
- [HA pipeline integration](docs/superpowers/specs/2026-07-25-ha-pipeline-integration.md) — Claude Code → Qwen36-coder → Home Assistant

## License

MIT
