# familiar.realm.watch

Local-first AI companion — reads [mempalace](https://github.com/techempower-org/mempalace) before speaking, writes it after. Part of the [realm.watch](https://realm.watch) ecosystem.

## Stack

- **familiar-api** — TypeScript + [Bun](https://bun.sh) HTTP + MCP server
- **familiar-web** — Static PWA served from the same Bun process
- **Ollama** — Local LLM inference (chat + embed) on GPU
- **[palace-daemon](https://github.com/techempower-org/palace-daemon)** — mempalace coordination gateway (our fork — adds hook detach, postgres backend gates, `/cypher` + `/embed`, `/search/keyword` + `/search/hybrid`)
- **[mempalace](https://github.com/techempower-org/mempalace)** — mempalace fork, pip-installed into palace-daemon (adds postgres + pgvector + Apache AGE backend, hybrid search, canonical room taxonomy)
- **Caddy + Authelia** — reverse proxy + auth on ubox0

## Hosts

- `katana` (10.0.6.129) — workstation; dev/test target for familiar-api
- `familiar` (10.0.6.124) — production inference server (Ollama + familiar-api). Public-facing `familiar.jphe.in` lands here.
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
- `web/` — PWA assets (served by Bun at `/`)
- `ops/` — systemd units, Caddy snippets, install/deploy scripts
- `docs/superpowers/` — spec + implementation plans

## Docs

- [Design spec](docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md)
- [v0.1 implementation plan](docs/superpowers/plans/2026-04-23-familiar-v0.1.md)

## License

MIT
