# Slot Picker — Operator Runbook

The slot picker lets familiar-api swap which inference model serves each of
five **slots** — `chat`, `embed`, `extract`, `hyde`, `reflect` — by starting
and stopping pre-defined systemd unit variants. This document covers the
operator surface: what the files mean, how to add a variant, what fails
and why.

## Architecture in one paragraph

A static **`/var/lib/familiar/registry.json`** (ops-owned) enumerates every
variant: model, runtime, systemd unit name, URL, GPU pin, VRAM cost, which
slots it can serve. A live **`/var/lib/familiar/slots.json`** (familiar-api-
owned, atomic-write) maps each slot to a variant id or `null` (disabled).
familiar-api reads both files at request time (mtime-cached) and routes
chat/embed/HyDE/reflect/extract through the resolved provider. The admin
endpoint `PATCH /api/familiar/admin/slots/:slot` validates the change, runs
a VRAM preflight, calls the sudoers-scoped wrapper `familiar-slotctl` to
stop outgoing units and start incoming ones, polls `/health` on the new
endpoint, and only then atomic-writes `slots.json`. On any failure it
reverts systemd state and leaves `slots.json` unchanged.

## File layout

| Path | Owner | Edited by | Survives deploy? |
|---|---|---|---|
| `/var/lib/familiar/registry.json` | `familiar:familiar` 0644 | Ops (hand) | Yes (deploy never overwrites) |
| `/var/lib/familiar/slots.json` | `familiar:familiar` 0644 | familiar-api (PATCH) | Yes |
| `/var/lib/familiar/allowed-units.txt` | `familiar:familiar` 0644 | Ops (hand, in lockstep with registry) | Yes |
| `/usr/local/sbin/familiar-slotctl` | `root:root` 0755 | Deploy script (overwrite each run) | Refreshed every deploy |
| `/etc/sudoers.d/familiar-slotctl` | `root:root` 0440 | Deploy script | Refreshed every deploy |
| `/etc/systemd/system/llama-server-*.service` | `root:root` 0644 | Deploy script (from `ops/systemd/units/`) | Refreshed every deploy |

The `.example` templates ship in the repo at `ops/systemd/registry.json.example`
and `ops/systemd/allowed-units.txt.example`. The deploy script copies them
into `/var/lib/familiar/` on first install and leaves the live versions
alone thereafter — so operator edits survive.

## Enabling admin

Admin PATCH is gated behind `FAMILIAR_SLOTS_ADMIN=true` in `/srv/familiar/.env`.
Default is `false` so test environments and a fresh deploy don't accidentally
shell out to sudo. Flip to `true` and restart `familiar-api.service` once the
registry is reviewed and the units are loaded.

Caddy's `@admin` block forwards `/api/familiar/admin/*` through Authelia at
`10.0.6.134:9091`, so admin writes require a logged-in session. The read-only
`/api/familiar/slots` endpoint is open (same trust level as `/api/familiar/health`).

## Adding a new variant

Three coordinated edits, then a restart:

1. **Write the systemd unit file.** Drop into `ops/systemd/units/llama-server-<name>.service` in the repo. Template:

    ```ini
    [Unit]
    Description=llama.cpp <slot> — <model> on <GPU>
    After=network.target

    [Service]
    Type=simple
    User=jp
    Environment=CUDA_VISIBLE_DEVICES=<N>
    ExecStart=/opt/llama.cpp/build/bin/llama-server \
      --model /var/cache/llama/models/<file>.gguf \
      --port <port> --host 0.0.0.0 \
      --n-gpu-layers 999 --ctx-size <ctx> --parallel <p> --threads <t> \
      --cont-batching --alias <alias>
    Restart=on-failure
    RestartSec=5
    MemoryMax=<NG>

    [Install]
    WantedBy=multi-user.target
    ```

2. **Register the variant.** Add an object to `registry.json`'s `variants[]`. Required fields: `id`, `label`, `model`, `runtime`, `unit`, `url`, `gpu`, `vram_mb`, `capabilities`. Optional: `context`. The `id` is what `slots.json` references; `unit` must match the filename you just dropped; `url` must match the `--port` in ExecStart.

3. **Allow-list the unit.** Append the unit filename (no path) to `allowed-units.txt`. The slotctl wrapper rejects any unit not on this list.

4. **Reload systemd + apply.** On the familiar host:
    ```bash
    sudo systemctl daemon-reload
    # Optional: pre-start to validate the unit + warm the model cache.
    sudo systemctl start llama-server-<name>.service
    sudo systemctl status llama-server-<name>.service
    sudo systemctl stop llama-server-<name>.service
    # Then PATCH the slot via the UI or curl.
    ```

The deploy script handles steps 1 + 4 (dropping unit files + daemon-reload).
Steps 2 + 3 are intentionally manual — they're the source of truth for what
the picker can do, and we don't want a deploy to silently expand the
allow-list.

## VRAM math

The preflight rejects a PATCH if any GPU's sum of `vram_mb` across bound
variants would exceed `0.92 × gpu_total_mb`. The 0.92 leaves headroom for
KV cache growth + llama-server's prompt cache + driver overhead. If the
published `vram_mb` is wrong (e.g., your variant loads heavier than the
registry claims under load), edit the number — the registry is the source
of truth for the calc.

`gpu_total_mb` is also a registry field — set per-GPU. Use what `nvidia-smi`
reports as total memory.

## Troubleshooting

### `PATCH ... 403 slots admin disabled`

`FAMILIAR_SLOTS_ADMIN` is `false` in the .env. Set to `true`, restart
familiar-api.

### `PATCH ... 503 health check timed out for variant "..."`

The unit started but its `/health` (or `/v1/models`) didn't return 200
within 30 seconds. Likely causes:
- Model file missing or unreadable (check `journalctl -u <unit>` for llama-server's error)
- VRAM OOM after the model loaded (nvidia-smi between PATCH attempts)
- Port collision with another unit (check the `url` in the registry vs
  `--port` in ExecStart match, and no other process is bound there)

The route auto-reverts: the unit you just started is stopped, the previous
binding is restarted. `slots.json` is unchanged. You can investigate at
your leisure.

### `PATCH ... 409 VRAM budget exceeded`

Your proposed change pushes a GPU past the 0.92 budget. Either pick a
smaller variant, free another slot first (PATCH something on that GPU to
`null` or a CPU variant), or — if the math is wrong — edit `registry.json`
to reflect the actual VRAM cost.

### `slotctl: unit not on allow-list: <unit>`

You added a variant to `registry.json` but forgot to add it to
`allowed-units.txt`. Add the line and retry — no service restart needed
(the wrapper re-reads the file every call).

### `slotctl: admin disabled (FAMILIAR_SLOTS_ADMIN != true)`

Same as the 403, but from the wrapper's perspective. The route checks
this first; if you see it here, your .env env var changed but
familiar-api wasn't restarted.

### `bw get password palace-daemon-v1` failed during deploy

Unrelated to the slot picker — that's the palace daemon API key. The slot
picker has no Vault dependencies; check the runbook for palace-daemon
specifically.

### chat returns "My voice falters — the resonance is unsettled"

The themed inference-failure fallback (`voice.chatFalters`). The chat
route catches *any* error in the inference call and emits this, so it
covers several distinct causes. As of the 2026-05-29 incident, the
fallback is no longer silent — **`journalctl -u familiar-api | grep
chat.falters`** logs the cause (model, breaker state, error message),
and `LlamaCppClient` includes the upstream error body. Start there, then
walk this chain (top = most common):

1. **Chat models unloaded to save RAM?** Routine. `systemctl is-active
   llama-server-chat-gemma3-4b-gpu1` (or whichever variant chat is bound
   to). If inactive, that's "resting" — the web UI shows a calm resting
   state, not an error. `systemctl start` it; the 60s health poll clears
   resting on its own. Confirm: `nvidia-smi` shows the model's VRAM back.

2. **palace-daemon down?** Grounding runs before the chat model; if
   palace is unreachable the turn still proceeds *ungrounded* (breaker
   open path) — but if palace went down hard it can cascade. Check
   `curl -s localhost:8085/health`. If down: `systemctl start
   palace-daemon` (it has `Restart=always` + `RestartSec=10`; a clean
   `stop` stays stopped, a crash self-heals).

3. **`slots.json` missing or chat unbound?** `cat /var/lib/familiar/slots.json`
   — `slots.chat.variant_id` must name a chat-capable variant. If the
   file is absent, the resolver returns null and chat falls through to
   the legacy `OLLAMA_CHAT_URL` (`:11434`), which is **dead** (Ollama was
   replaced by llama.cpp). Bind it: write `slots.json` with chat → a
   variant whose `capabilities` include `"chat"`, or PATCH via the admin
   endpoint. (Deploy does not seed `slots.json` — see familiar #86.)

4. **Per-slot context too small for the grounded prompt?** ⚠️ The subtle
   one — this was the 2026-05-29 root cause. `grep chat.falters` shows a
   400; the llama-cpp error body says `exceed_context_size_error`,
   `n_prompt_tokens` vs `n_ctx`. The familiar's grounded prompt is
   **~3000 tokens** (persona + up to ~9 palace drawers + the turn).
   llama-server splits `--ctx-size` across `--parallel` slots, so the
   *per-slot* window is `ctx-size / parallel`. The extractor (`4096 / 4 =
   1024`) and a naive chat unit (`8192 / 4 = 2048`) both 400 on a real
   grounded turn while a tiny "pong" test passes. Fix: give the chat unit
   `--parallel 1` (full window per slot) or raise `--ctx-size`. The
   single-user familiar doesn't need concurrent chat slots.

5. **Not an IPv6 / `localhost` problem.** A red herring from the incident:
   the variant URLs were switched `localhost`→`127.0.0.1` on a hunch, but
   the 400s proved the connection worked (Bun resolves `localhost` fine
   here). Don't chase DNS — if you got an HTTP status back, the transport
   is fine; read the error body.

## File interaction diagram

```
            ┌──────────────────┐
            │   /var/lib/      │
            │   familiar/      │
            │  registry.json   │ ← ops-edited
            └────────┬─────────┘
                     │
                     │ read (mtime-cached 30s)
                     ▼
                ┌─────────────┐         ┌─────────────────┐
                │  Registry   │         │     PATCH       │
                │    .ts      │ ◄──────►│ admin-slots.ts  │
                └─────────────┘         └────────┬────────┘
                     ▲                           │ start/stop
                     │                           ▼
            ┌────────┴─────────┐          ┌─────────────┐
            │  SlotResolver    │          │  Slotctl    │ — sudo + wrapper
            └────────┬─────────┘          └──────┬──────┘
                     │                           │
                     │ read+atomic-write         │
                     ▼                           ▼
            ┌──────────────────┐         ┌──────────────────┐
            │  /var/lib/       │         │  systemctl       │
            │  familiar/       │         │  start/stop      │
            │  slots.json      │         │  llama-server-*  │
            └──────────────────┘         └──────────────────┘
```

## Migration from v0.x

Pre-Wave 1, familiar-api routed everything through a static
`InferenceRouter` constructed from env vars `OLLAMA_CHAT_URL`,
`OLLAMA_CHAT_MODEL`, `LLAMA_CPP_URL`, etc. Those env vars are still read
(see `src/config.ts`) and the router is still constructed — now as the
fail-open fallback for `slot_resolver.chat()` / `.embedClient()`.

## Runtime routing — what's live

| Slot | Resolver wired? | Falls back to | Notes |
|---|---|---|---|
| `chat` | ✅ Wave 2b (`dc97bc0`) | `inferenceRouter` (legacy) | `pickChatProvider` in `src/routes/chat.ts` consults resolver per request |
| `embed` | ✅ Wave 2c (`01d9684`) | `ollamaEmbed` (legacy) | `resolver.embedClient()` — ollama runtime only |
| `extract` | n/a (worker is separate process) | n/a | extract slot picks which `llama-server-extractor*.service` is up; kg-extract worker connects to whichever URL is in slots.json |
| `hyde` | ✅ Wave 2d.1 (`e8d86c4`) | `ollamaChat` (legacy closure) | hydeGenerator now consults `resolver.hydeClient()` per call |
| `reflect` | ✅ Wave 2d.2 (`71e2485`) | `inferenceRouter` (legacy) | ReflectWriter `getInference` callback consults `resolver.reflect()` per extraction |

**The 5-slot loop is closed.** PATCHing any slot takes effect on the
**very next** request — the resolver mtime-checks `slots.json` (1s
cache window) so disk edits propagate without restart. Each slot has
a backward-compatible fallback to its legacy provider, so a cold-start
deploy (no `slots.json`) behaves exactly as before the slot picker
landed.
