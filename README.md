# familiar.realm.watch

Local-first AI companion — reads [mempalace](https://github.com/techempower-org/mempalace) before speaking, writes it after. Part of the [realm.watch](https://realm.watch) ecosystem.

## Stack

- **familiar-api** — TypeScript + [Bun](https://bun.sh) HTTP + MCP server
- **familiar-web** — Static PWA served from the same Bun process
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** (`llama-server`) — Local LLM inference (chat + embed) on GPU via OpenAI-compatible `/v1/*` API. Built locally from source on familiar with `-DCMAKE_CUDA_ARCHITECTURES=52;61` to support Pascal (P102) + Maxwell (GTX 970). Stock Ollama doesn't ship Pascal SASS in its prebuilt binaries and silently CPU-fallbacks — we migrated off it on 2026-05-15.
- **[palace-daemon](https://github.com/techempower-org/palace-daemon)** — mempalace coordination gateway (our fork — adds hook detach, postgres backend gates, `/cypher` + `/embed`, `/search/keyword` + `/search/hybrid`)
- **[mempalace](https://github.com/techempower-org/mempalace)** — mempalace fork, pip-installed into palace-daemon (adds postgres + pgvector + Apache AGE backend, hybrid search, canonical room taxonomy)
- **Caddy + Authelia** — reverse proxy + auth on ubox0

## Hosts

- `katana` (10.0.6.129) — workstation; dev/test target for familiar-api
- `familiar` (10.0.6.124) — production inference server (llama-server + familiar-api). Two GPUs: P102-100 (10 GB, runs the chat model on `:11434`) + GTX 970 (4 GB, runs the embed model on `:11435`). Public-facing `familiar.jphe.in` lands here.
- `disks` (10.0.6.120) — palace-daemon + Postgres (pgvector + AGE) + palace data home (`/mnt/raid/projects/mempalace-data/palace`)

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

- **Hybrid (default)** — `PALACE_SEARCH_MODE=hybrid` (the default). Daemon-side `candidate_strategy="hybrid"` fuses vector ∪ BM25 ∪ AGE graph-expanded candidates and hybrid-reranks. Falls back to vector-only on daemon 503/404.
- **HyDE** — plumbed end-to-end (`/v1/chat/completions` and `/api/familiar/eval`) but **gated off in production**. Enable per-process via `PALACE_USE_HYDE=true` or per-request via `/api/familiar/eval?hyde=true`. Current measurement: 0 rescues on the 15-probe paraphrase set against katana + qwen2.5:14b — diagnosis tracked at [#6](https://github.com/techempower-org/familiar.realm.watch/issues/6).

## Docs

- [Design spec](docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md)
- [v0.1 implementation plan](docs/superpowers/plans/2026-04-23-familiar-v0.1.md)

## License

MIT
