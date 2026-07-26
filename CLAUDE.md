# CLAUDE.md — familiar.realm.watch

Project-specific instructions for Claude Code working in this repo.

## What this is

Local-first AI companion. Reads mempalace before speaking, writes it after. See [docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md](docs/superpowers/specs/2026-04-23-familiar-realm-watch-design.md) for the full design.

**Palace storage model:** wing = project, room ∈ {architecture, decisions, problems, planning, sessions, references, discoveries}, drawer = entry. See [docs/superpowers/specs/2026-05-13-palace-room-taxonomy.md](docs/superpowers/specs/2026-05-13-palace-room-taxonomy.md). The `palace-taxonomy` skill carries the same content cross-project.

## Stack

- TypeScript + Bun (runtime + test runner + package manager)
- **Inference: [llama.cpp](https://github.com/ggml-org/llama.cpp)** (`llama-server`) on `familiar` — built locally with `-DCMAKE_CUDA_ARCHITECTURES=52;61` to support Pascal (P102, sm_61) and Maxwell (GTX 970, sm_52). Speaks OpenAI-compatible `/v1/*` API. `src/ollama-client.ts` is the (legacy-named) OpenAI-compat client. Stock Ollama prebuilts silently CPU-fallback on Pascal — don't reach for them. See `~/.claude/projects/-home-jp-Projects-familiar-realm-watch/memory/reference_pascal_inference_stack.md`.
- [palace-daemon](https://github.com/techempower-org/palace-daemon) (mempalace HTTP gateway) on `familiar` at `:8085` — postgres backend (pgvector + AGE) in Docker at `familiar:5433`, data on local SSD at `/var/lib/mempalace-db`
- [mempalace](https://github.com/techempower-org/mempalace) (techempower-org fork) pip-installed into palace-daemon's venv — adds postgres+pgvector+AGE backend, hybrid search, canonical room taxonomy
- familiar-api: production on `familiar` host (10.0.6.124); dev/test on `katana` (10.0.6.129)
- Caddy + Authelia edge on `ubox0` — public-facing `familiar.jphe.in` lands here
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

## Slot picker

Five inference workloads — **chat**, **embed**, **extract**, **hyde**, **reflect** — each get a pickable variant via `PATCH /api/familiar/admin/slots/:slot`. See [`docs/slot-picker.md`](docs/slot-picker.md) for the operator runbook.

- **Registry**: `/var/lib/familiar/registry.json` — ops-owned, enumerates available variants. Templated by `ops/systemd/registry.json.example`.
- **Live state**: `/var/lib/familiar/slots.json` — familiar-api-owned, atomic-write, mtime-cached at request time.
- **systemctl wrapper**: `/usr/local/sbin/familiar-slotctl` (sudoers-scoped to the `familiar` user; allow-list at `/var/lib/familiar/allowed-units.txt`).
- **Admin gating**: Caddy's `@admin` block forwards `/api/familiar/admin/*` through Authelia. The picker UI must be served from an authenticated session.
- **Master enable**: `FAMILIAR_SLOTS_ADMIN=true` in `/srv/familiar/.env` — defaults false so tests don't shell out to sudo.

v1 ships the admin endpoints + slot infra. Chat/embed/HyDE/reflect runtime still routes through the legacy `InferenceRouter` until Wave 2b swaps it.

## Qwen36-coder lane

familiar also runs **Qwen36-coder** (Qwen3.6-35B-A3B UD-Q3_K_XL, 16.8GB MoE, 131K context) on `familiar:8091` via `--jinja`. Used by `claude-local-qwen` on katana as the default Claude Code inference lane. Supports tool-calling and the HA pipeline (Home Assistant integration). See [docs/superpowers/specs/2026-07-25-ha-pipeline-integration.md](docs/superpowers/specs/2026-07-25-ha-pipeline-integration.md).

## Deploying

Scripts in `ops/scripts/`:
- `install-ollama-familiar.sh` — one-shot Ollama + systemd setup on familiar. **Legacy** — installs stock Ollama which CPU-fallbacks on Pascal. After 2026-05-15 the production setup uses llama.cpp built from source; the systemd unit names (`ollama-chat.service`, `ollama-embed.service`) are kept for compatibility but `ExecStart` is overridden to `/opt/llama.cpp/build/bin/llama-server`.
- `install-palace-daemon-katana.sh` — clone + install palace-daemon on katana
- `swap-katana-mcp.sh` — update katana's Claude Code MCP to bridge
- `deploy-familiar.sh` — rsync + systemctl restart (also installs slot picker scaffolding: slotctl + sudoers + variant units + seeds `/var/lib/familiar/`)

## Don't

- Don't use `tsc` to compile — Bun runs TS natively. Typecheck only via `bun run typecheck`.
- Don't reach into mempalace Python internals — only talk to palace-daemon HTTP surface.
- Don't mount the palace via NFS/Samba — data corruption guaranteed. Always HTTP via palace-daemon.
- Don't commit secrets. Vault is the source of truth.
- Don't use `exec`/`execSync` with a shell string — always spawn with argv arrays (`Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"] })`).
