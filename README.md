# familiar.realm.watch

Local-first AI companion — reads [mempalace](https://github.com/jphein/mempalace) before speaking, writes it after. Part of the [realm.watch](https://realm.watch) ecosystem.

## Stack

- **familiar-api** — TypeScript + [Bun](https://bun.sh) HTTP + MCP server
- **familiar-web** — Static PWA served from the same Bun process
- **Ollama** — Local LLM inference (chat + embed) on GPU
- **[palace-daemon](https://github.com/rboarescu/palace-daemon)** — mempalace coordination gateway
- **[jphein/mempalace](https://github.com/jphein/mempalace)** — mempalace fork, pip-installed into palace-daemon
- **Caddy + Authelia** — reverse proxy + auth on ubox0

## Hosts

- `familiar` (10.0.6.115) — 24/7 inference server (Ollama + familiar-api + web)
- `katana` (10.0.6.129) — workstation + palace data home (palace-daemon for v0.1)

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
