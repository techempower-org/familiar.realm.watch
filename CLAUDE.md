# CLAUDE.md — familiar.realm.watch

Project-specific instructions for Claude Code working in this repo.

## What this is

Local-first AI companion. Reads mempalace before speaking, writes it after. See [docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md](docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md) for the full design.

## Stack

- TypeScript + Bun (runtime + test runner + package manager)
- Ollama (chat + embeddings over HTTP)
- palace-daemon (mempalace HTTP gateway) on katana for v0.1
- PWA served by Bun from `web/`

## Key conventions

- **Bun, not Node.** `bun run`, `bun test`, `bun install`. Native TS.
- **No build step.** Bun executes TS directly. `bun --hot` for dev.
- **Test framework: Bun's built-in.** `import { test, expect, describe } from "bun:test"`.
- **Imports: ESM with `.ts` extensions allowed** (`allowImportingTsExtensions` on).
- **Streaming: SSE via `ReadableStream` or `TransformStream`.** No Express, no Fastify — Bun.serve is the server.
- **MCP SDK: `@modelcontextprotocol/sdk`** (v1.29+).
- **Spawning subprocesses: use `Bun.spawnSync({ cmd: [...] })` with argv array.** Never use shell strings or `child_process.exec()`/`execSync` — they enable shell injection.
- **Commits: selective staging** (`git add <files>`, not `-A`). Conventional commit messages.
- **Secrets via Vaultwarden.** `bw get password <item>`. Never hardcode.

## Running locally

```bash
bun install
cp .env.example .env       # edit OLLAMA_CHAT_URL, PALACE_DAEMON_URL, etc.
bun run dev                # familiar-api at http://localhost:8080
bun test                   # all tests
bun test tests/grounding.test.ts  # one file
```

## Deploying

Scripts in `ops/scripts/`:
- `install-ollama-familiar.sh` — one-shot Ollama + systemd setup on familiar
- `install-palace-daemon-katana.sh` — clone + install palace-daemon on katana
- `swap-katana-mcp.sh` — update katana's Claude Code MCP to bridge
- `deploy-familiar.sh` — rsync + systemctl restart

## Don't

- Don't use `tsc` to compile — Bun runs TS natively. Typecheck only via `bun run typecheck`.
- Don't reach into mempalace Python internals — only talk to palace-daemon HTTP surface.
- Don't mount the palace via NFS/Samba — data corruption guaranteed. Always HTTP via palace-daemon.
- Don't commit secrets. Vault is the source of truth.
- Don't use `exec`/`execSync` with a shell string — always spawn with argv arrays (`Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"] })`).
