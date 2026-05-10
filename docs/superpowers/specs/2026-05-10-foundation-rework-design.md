# Foundation Rework — familiar + mempalace + palace-daemon

**Status:** Design, not yet implemented
**Date:** 2026-05-10
**Author:** JP + Claude session
**Supersedes (in part):** `2026-04-23-familiar-realm-watch-design.md` host assignments

## Context

A diagnostic session uncovered a **split-brain in the palace data layer**:

- `~/Projects/memorypalace/.claude-plugin/hooks/hooks.json` on katana wires the Stop hook to `mempal-stop-hook.sh`, which calls `mempalace hook run --hook stop` (subprocess approach).
- The `mempalace` CLI reads `~/.mempalace/config.json`, which still points at `~/.mempalace/palace`, a symlink to `/home/jp/Projects/mempalace-data/palace` — a **local palace database on katana**.
- Today's Stop hook writes have been landing in that local katana palace.
- familiar-api on katana connects to **palace-daemon on disks** (`disks:8085`), which serves `/mnt/raid/projects/mempalace-data/palace` — **a different palace database on a different host**.
- familiar-api can't recall any of today's session writes because the writes never reached the palace it reads from.

The artifact `~/.mempalace/config.json.pre-daemon-migration` is the smoking gun: JP did migrate the mempalace config to use the daemon at some point, but the Stop hook never caught up. `palace-daemon/clients/hook.py` (written 2026-05-06) is the prepared replacement that routes through the daemon's HTTP API instead of subprocess-spawning mempalace.

Separately, palace-daemon runs as a *user* systemd unit on disks. Even with linger enabled, that's one more dependency layer than a network-facing daemon should have.

## Goals

**Foundation goal (per brainstorming Q1):** Trust. The system should boringly work — palace stays up, hooks fire reliably, mined data shows up in familiar within seconds of writing.

**Scope (per Q2 + Q3):** Full rework — palace-daemon, hook routing, familiar-api lifecycle, dead-code cleanup, plus a one-time data migration of katana's local palace into disks's palace. Host-agnostic deploy so the same workflow handles katana now and familiar after the P102s arrive.

## Non-goals

- Building a new palace tool. mempalace and palace-daemon are the substrate; this is wiring/lifecycle work.
- Rewriting the design spec from 2026-04-23. That document describes the v0.1 plan (palace on katana → migrate to familiar in v0.3). Reality drifted (palace landed on disks instead). The April spec stays as historical context; the host-of-record fixes already landed in `CLAUDE.md` and `README.md` earlier today.
- Encrypting the borg repo or other off-topic security work flagged in the same session.

## Architecture — three layers

```
Layer 1 — palace-daemon stability (disks)
   user systemd unit → system systemd unit, User=jp
   Restart=always, explicit paths

Layer 2 — Kill split-brain
   2A. Hook routing: mempalace plugin's hooks.json → calls hook.py directly
       (replaces mempal-stop-hook.sh + mempalace CLI subprocess)
   2B. Data migration: katana's ~/Projects/mempalace-data/palace
       → /mnt/raid/projects/mempalace-data/palace (on disks)
   2C. Settings: ~/.mempalace/hook_settings.json points at disks:8085

Layer 3 — Recall verification + cleanup
   3A. Remove `kind` parameter from palace-client.ts (palace-daemon ignores it)
   3B. End-to-end recall smoke test (insert drawer → query familiar → assert)
   3C. familiar-api: user systemd → system systemd unit (match palace-daemon)
   3D. Host-agnostic ops/scripts/deploy-familiar.sh
```

Each layer leaves the system functional. If a later layer hits a snag, earlier layers still provide standalone value.

---

## Layer 1 — palace-daemon as system service

### What changes

| | Current (user unit) | Target (system unit) |
|---|---|---|
| Path | `/home/jp/.config/systemd/user/palace-daemon.service` | `/etc/systemd/system/palace-daemon.service` |
| Manager | `user@1000.service` (requires linger or active session) | systemd PID 1 |
| Identity | Implicit jp (user manager) | Explicit `User=jp Group=jp` |
| Restart | `Restart=on-failure RestartSec=5` | **`Restart=always RestartSec=5`** |
| `%h` expansion | Valid only in user units | Replaced with explicit `/home/jp/...` paths |
| EnvironmentFile | `%h/.config/palace-daemon/env` | `/home/jp/.config/palace-daemon/env` (User=jp can still read) |
| StopTimeout | unset (default 90s) | `TimeoutStopSec=30` |

### Data flow

Unchanged. palace-daemon listens on `:8085`, reads `/mnt/raid/projects/mempalace-data/palace`, serves `/search /list /mine /memory /backup`. Lifecycle is the only thing changing.

### Migration steps (on disks)

1. Read current user unit + env file
2. Compose new system unit (above changes applied)
3. Backup old user unit: `cp ~/.config/systemd/user/palace-daemon.service ~/.config/systemd/user/palace-daemon.service.bak.YYYYMMDD`
4. Stop + disable user unit: `systemctl --user disable --now palace-daemon`
5. Write new unit to `/etc/systemd/system/palace-daemon.service`
6. `sudo systemctl daemon-reload && sudo systemctl enable --now palace-daemon`
7. Verify: `systemctl status palace-daemon`, port 8085 responds locally and from katana

### Error handling additions

- `Restart=always` (catches any exit, not just failures)
- `TimeoutStopSec=30` (graceful shutdown bounded)
- Existing `StandardOutput=journal` retained

### Test plan

1. `systemctl is-active palace-daemon` → active
2. `curl localhost:8085/health` from disks → 200
3. `curl http://disks:8085/health` from katana → 200 with API key
4. `sudo reboot` on disks → after reboot, palace-daemon up before any user session

### Risk

Low. System units don't inherit user environment, but `EnvironmentFile=` and explicit `Environment=` directives cover everything needed. All env (PALACE_API_KEY, PALACE_PORT, PALACE_MAX_CONCURRENCY, PALACE_DAEMON_PATH_MAP) stays in the existing env file.

---

## Layer 2 — Kill split-brain

### 2A. Hook routing change

**Edit** `~/Projects/memorypalace/.claude-plugin/hooks/hooks.json` on katana:

- Stop hook command changes from `bash "${CLAUDE_PLUGIN_ROOT}/hooks/mempal-stop-hook.sh"` to `python3 /home/jp/Projects/palace-daemon/clients/hook.py --hook stop --harness claude-code`
- Same pattern for PreCompact and SessionStart hooks if present
- Bypass the `.sh` wrapper entirely — its mempalace-CLI fallback strategy isn't needed; hook.py is single-Python, stdlib-only.

Old `mempal-stop-hook.sh` stays on disk but no longer invoked. Once Layer 2 is stable for a while, retire it.

### 2B. Data migration

**The problem:** katana's `~/Projects/mempalace-data/palace/` has session drawers that didn't make it to disks's palace. Once Stop hook flips to hook.py, future writes go to disks but past katana writes stay orphaned.

**Preferred mechanism: mempalace CLI export/import** (Option 1). Fallback if unavailable: re-mine source transcripts (Option 3). Option 2 is documented for completeness but not the first pick.

| Option | How | When to use |
|---|---|---|
| **1. mempalace CLI export/import (preferred)** | `mempalace export --palace <src> -o X.tar.zst` + `mempalace import --palace <dst> -i X.tar.zst` | First choice — verify these commands exist; if so, use them |
| 2. palace-daemon /backup + restore | Requires a temp palace-daemon on katana pointing at local palace, then transfer + import into disks | Skip — more moving parts than Option 1 with no real benefit |
| **3. Re-mine source transcripts (fallback)** | Rsync `~/.claude/projects/-home-jp-*/` jsonl files from katana to a path readable by palace-daemon on disks, then `POST /mine` on each | Use if Option 1 turns out not to exist in the CLI surface |

Implementation step zero: `mempalace --help` and `mempalace export --help` to confirm. Whichever path: take a `POST /backup` snapshot of disks's palace before any import.

### 2C. Hook settings

Write/update `~/.mempalace/hook_settings.json` on katana:

```json
{
  "daemon_url": "http://disks:8085",
  "silent_save": true,
  "force_on_stop": true,
  "force_min_interval": 60
}
```

API key comes from env (`PALACE_API_KEY` already set in `~/.claude/settings.json`'s env block).

### "Every 15 messages" cadence

Per the `feedback_stop_hook_mcp_calls.md` memory file, this was the intended cadence. hook.py's docstring mentions counting human exchanges in transcript (`Count human exchanges in transcript (same logic as hooks_cli.py)`). Verify the exact threshold in implementation; if not configurable, may need to either accept hook.py's default or add a config field.

### Rollout sequence (safe order)

1. Pause Stop hook (comment out in `hooks.json`, or set silent_save block so no writes occur)
2. Backup disks's palace (`POST /backup` on palace-daemon, or rsync the palace dir to a side path)
3. Run data migration (mechanism chosen above)
4. Verify: disks's palace contains expected katana-side drawers (search for a known-katana-only topic)
5. Update `hooks.json` to call `hook.py`
6. Write `~/.mempalace/hook_settings.json`
7. Test: fire a manual Stop event via short Claude session, watch disks's palace grow, watch katana's local palace stay frozen
8. Rename katana's local palace to `palace.frozen-2026-05-10/` so it's clearly out of service

### Test plan

After Layer 2:
1. Fresh Claude Code session, 3 exchanges, close
2. Within ~30 seconds, query disks's palace for a topic from the session
3. Drawer should appear with `created_at` within last minute and wing matching the session
4. katana's `palace.frozen-` dir mtime should not advance after the migration timestamp

### Risk

Medium. Rollback paths:
- If migration corrupts disks's palace: restore from pre-migration backup
- If hook.py misbehaves: revert `hooks.json` to `mempal-stop-hook.sh` (writes resume to katana local, recording continues even if unsynced)
- If hook_settings.json is malformed: hook.py uses defaults, writes go nowhere useful, no data loss

---

## Layer 3 — Recall verification + cleanup

### 3A. Remove `kind` parameter

In `src/palace-client.ts`:
- Remove `params.set("kind", opts.kind ?? "all")` and the `kind` field from `SearchOpts`
- Verify palace-daemon's `/search` route either ignores `kind` or doesn't expose it — by reading `palace-daemon`'s router code. (JP's "we don't really use kind anymore" suggests this is safe.)

In `src/types.ts`:
- If `PalaceSearchKind` has no other consumers (grep confirms), delete the type

`bun run typecheck` to catch breakage.

### 3B. End-to-end recall smoke test

A new test in `tests/recall-roundtrip.test.ts`:
1. Insert a known drawer into disks's palace via `POST /memory` with a content string containing a unique marker (e.g., a UUID)
2. Wait N seconds for embed + index
3. Call familiar-api's chat endpoint with a question that should retrieve the marker
4. Assert the marker appears in the response (or in trace metadata)

This is the *test* version of "the foundation works." Run as part of `bun test`.

### 3C. familiar-api: user → system unit (match palace-daemon)

Same pattern as Layer 1, just for familiar-api on the host where it runs (katana now, familiar later):

- `/etc/systemd/system/familiar-api.service` with `User=jp Group=jp`
- `Restart=always RestartSec=5`
- `WorkingDirectory=/home/jp/Projects/familiar.realm.watch`
- `ExecStart=/home/jp/.bun/bin/bun src/familiar.ts`
- Replace existing user unit at `~/.config/systemd/user/familiar-api.service`

Optional but recommended for consistency.

### 3D. Host-agnostic deploy script

`ops/scripts/deploy-familiar.sh` reworked:

- Accepts `--host <hostname>` flag (defaults to current host; sshs if remote)
- Idempotent: ensures bun installed, source synced, `.env` written from template, systemd unit installed, service enabled + started, health-checked
- Same script works for katana now and familiar after P102s arrive — flip the `--host` flag
- For `.env`, prompts for any unset keys (or accepts them via flags); never commits the resulting `.env`

### Test plan

After Layer 3:
1. `bun test` passes (including new recall roundtrip)
2. `deploy-familiar.sh` is re-runnable without breaking state
3. Chat with familiar about a topic from earlier today — should surface relevant drawers from disks's palace, no "I don't have palace context" caveat (unless topic genuinely isn't there)

### Risk

Low. Code changes are removals + additions. Behavior change is small (kind removal — palace-daemon should already be ignoring it).

---

## Open questions to resolve during implementation

1. **mempalace CLI surface for export/import** — does `mempalace export` / `mempalace import` exist? Determines which migration mechanism (Option 1 vs 2 vs 3) to pick.
2. **`kind` status in palace-daemon's `/search`** — confirm it's ignored vs filtered. Quick read of palace-daemon router code.
3. **"every 15 messages" threshold in hook.py** — is it configurable via `hook_settings.json`, hardcoded, or read from a different config?
4. **PALACE_DAEMON_PATH_MAP fate** — currently maps `/home/jp/Projects/` → `/mnt/raid/projects/`, but that was for the older NFS-backed setup. With NFS off and mempalace plugin staying on katana, does this mapping still serve a purpose? Confirm before Layer 1 deploy.

These don't block the design — they get resolved by reading 2–3 files during the implementation plan.

## Rollback strategy (overall)

Each layer is independently revertible:

- **Layer 1**: stop new system unit, re-enable user unit. Same daemon binary, same data — purely a lifecycle revert.
- **Layer 2A** (hook routing): revert `hooks.json` to call `.sh` wrapper. Writes resume to katana local palace (which we may have frozen — restore from backup or unfreeze).
- **Layer 2B** (data migration): if migration corrupted disks's palace, restore from pre-migration backup taken in step 2.
- **Layer 3**: code changes are removals; restore from git. systemd unit migration revertible same way as Layer 1.

Each rollback puts the system back in the *previous* state (one layer back), not all the way to today's broken state. This is the value of the layered approach.

## Success criteria

After all three layers complete:

1. palace-daemon survives a reboot of disks and is up before any user logs in.
2. A Stop event in a Claude Code session results in a drawer in disks's palace within ~10 seconds.
3. familiar-api recalls topics from drawers written less than 1 minute ago.
4. Re-running `deploy-familiar.sh --host <X>` is idempotent.
5. The `kind` parameter is gone from `palace-client.ts`. The end-to-end recall test passes.
6. No "I don't have palace context" caveat from familiar for topics actually mined this session.
