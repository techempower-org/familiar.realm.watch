# familiar.realm.watch

Local-first AI companion — reads [mempalace](https://github.com/techempower-org/mempalace) before speaking, writes it after. Part of the [realm.watch](https://realm.watch) ecosystem.

## Stack

- **familiar-api** — TypeScript + [Bun](https://bun.sh) HTTP + MCP server
- **familiar-web** — Static PWA served from the same Bun process
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** (`llama-server`) — Local LLM inference (chat + embed) on GPU via OpenAI-compatible `/v1/*` API. Built locally from source on familiar with `-DCMAKE_CUDA_ARCHITECTURES=52;61` to support Pascal (P102) + Maxwell (GTX 970). Stock Ollama doesn't ship Pascal SASS in its prebuilt binaries and silently CPU-fallbacks — we migrated off it on 2026-05-15.
- **[palace-daemon](https://github.com/techempower-org/palace-daemon)** — mempalace coordination gateway (our fork — adds hook detach, postgres backend gates, `/cypher` + `/embed`, `/search/keyword` + `/search/hybrid`, `/backfill-age`)
- **[mempalace](https://github.com/techempower-org/mempalace)** — mempalace fork, pip-installed into palace-daemon (adds postgres + pgvector + Apache AGE backend, hybrid search, canonical room taxonomy, KG writethrough)
- **Caddy + Authelia** — reverse proxy + auth on ubox0

## Hosts

- `katana` (10.0.6.129) — workstation; dev/test target for familiar-api
- `familiar` (10.0.6.124) — production inference server (llama-server + familiar-api). Two GPUs: P102-100 (10 GB, runs the chat model on `:11434`) + GTX 970 (4 GB, runs the embed model on `:11435`). Public-facing `familiar.jphe.in` lands here.
- `disks` (10.0.6.120) — palace-daemon + Postgres (pgvector + AGE, 335K+ drawers) + palace data home (`/mnt/raid/projects/mempalace-data/palace`)

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

## Retrieval modes

- **Hybrid (default)** — `PALACE_SEARCH_MODE=hybrid` (the default). Daemon-side `candidate_strategy="hybrid"` fuses vector ∪ BM25 ∪ AGE graph-expanded candidates and hybrid-reranks. AGE knowledge graph populated via inline writethrough (`MEMPALACE_KG_WRITETHROUGH=1`) + one-shot backfill for existing drawers. Falls back to vector-only on daemon 503/404.
- **Temporal query expansion** — `src/memory-protocol.ts` detects date-relative words ("yesterday", "last week", "N days ago") and appends resolved ISO dates, helping BM25 match against drawer timestamps.
- **HyDE** — plumbed end-to-end (`/v1/chat/completions` and `/api/familiar/eval`) but **gated off in production**. Enable per-process via `PALACE_USE_HYDE=true` or per-request via `/api/familiar/eval?hyde=true`. Diagnosis: HyDE is structurally weak for institutional-memory corpora — [#6](https://github.com/techempower-org/familiar.realm.watch/issues/6) has the full investigation.

## Production ops

- **familiar-watchdog** — on-host `/health` probe + restart-counter alert + ntfy paging on WARN events. Systemd timer on `familiar`.
- **Functional health probes** — `/health` sends real chat + embed requests (not just model-list pings).
- **Pre-deploy parse check** — `ops/scripts/` catches JS syntax errors before rsync.

## Docs

- [Design spec](docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md)
- [Hybrid search + taxonomy spec](docs/superpowers/specs/2026-05-14-hybrid-search-taxonomy-spec.md)
- [Foundation rework spec](docs/superpowers/specs/2026-05-10-foundation-rework-design.md)
- [v0.1 implementation plan](docs/superpowers/plans/2026-04-23-familiar-v0.1.md)
- [Hybrid search + taxonomy plan](docs/superpowers/plans/2026-05-14-hybrid-search-and-taxonomy.md)

## License

MIT
