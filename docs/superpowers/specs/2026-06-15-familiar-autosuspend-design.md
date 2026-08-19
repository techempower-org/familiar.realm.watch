# familiar autosuspend — design

**Date:** 2026-06-15
**Status:** approved (brainstorming) — pending implementation plan
**Repo:** techempower-org/familiar.realm.watch

## Problem

`familiar` (10.0.6.124, headless) is an always-on host that mostly sits idle. It draws full
power around the clock to serve three intermittent workloads. We want it to **suspend itself
(S3) when idle** and rely on the existing on-demand wake path, with a control that's trivial to
turn on and off.

Half the system already exists, inverted:

- **On-demand wake** is solved. The `mempalace` CLI has `auto_wake` (WOLs familiar and retries,
  ~20 s) and `ops/scripts/familiar-wake` sends a magic packet from katana. WOL works from **S3**
  (ACPI-armed) but not S5 (BIOS-gated, headless) — see
  `reference_familiar_wol_s3`.
- **Manual suspend** is solved: `ops/scripts/familiar-sleep` arms WOL then suspends over ssh.
- **Missing:** an idle detector that decides *when* to let it sleep.

This design adds that detector and a one-command on/off control.

## Goals / non-goals

**Goals**

- Suspend familiar to S3 after a configurable idle period (default **15 min**).
- Never suspend while a workload that can't tolerate it is active (companion, local-coder, CI).
- Never suspend a box it can't wake (WOL-armed safety gate — headless = unrecoverable otherwise).
- Make turning autosuspend on/off and holding it off trivial.
- Reuse signals that already exist on the host; touch as little as possible.

**Non-goals**

- Auto-**waking** for CI builds. Decision: **accept queuing** — builds that arrive while familiar
  sleeps wait in GitHub's queue until familiar is next awake (companion/coder use, a palace query
  that auto-wakes it, or a manual `familiar-wake`). No katana-side poller, no GitHub token, no
  pre-push hook.
- S4/hibernate or true ~0 W cold-off (blocked: zram-only swap, BIOS-gated S5 — see WOL reference).
- Durable WOL network-config fix (see "WOL persistence" — explicitly deferred, not a prerequisite).
- A web-dashboard toggle (clean future add-on via the slot-picker scoped-sudo pattern; not v1).

## Idle definition (the crux)

Each ~5-min tick the on-host checker classifies the host into one of three states:

| Class | Signals | Effect |
|---|---|---|
| **Hard-busy** | master disabled · companion active · coder active · CI build in flight · maintenance hold · active SSH (recently-typed TTY) | reset idle clock to *now*, do **not** suspend |
| **Soft-defer** | operator hold window · recent palace request | do **not** suspend this tick, but do **not** reset the clock |
| **Idle** | none of the above, and clock age ≥ threshold | arm WOL, then suspend (S3) |

Rationale for the split:

- **Companion / coder = hard-busy via liveness.** `familiar-api.service` and `qwen3-coder.service`
  are both **on-demand** (`disabled` at boot, started when wanted, stopped to free VRAM). So
  "running = wanted = don't suspend." There is no per-request idle surface for either today
  (familiar-api emits no `/metrics`; coder journal logging not relied on), and we deliberately
  accept that a *running-but-idle* companion/coder pins the box awake — **stop the service to let
  it sleep**, which is already the operator's habit for freeing GPU memory.
  - `qwen3-coder.service` (`:8091`, owns **both** P102s) `Conflicts=` the entire companion GPU stack
    (`llama-server-*-gpu1`, extractor, etc.). It is therefore **mutually exclusive** with the
    companion: during a local-Claude-Code session, `familiar-api` is necessarily *down*. Watching
    only the companion would be blind exactly when the coder is mid-inference — hence coder is its
    own first-class hard-block, not an afterthought.
- **CI = hard-busy via sentinel.** The candela/storyvox self-hosted runner
  (`actions.runner.techempower-org-candela.familiar.service`) invokes `/home/jp/ci-hooks/pause-ml.sh`
  on `JOB_STARTED` and `resume-ml.sh` on `JOB_COMPLETED`. `pause-ml.sh` creates
  `/home/jp/ci-hooks/.ml-paused-by-ci` (refcount-gated, flock-serialized) and `resume-ml.sh` removes
  it on the last completion. So "CI in flight" = `test -f .ml-paused-by-ci`, with **zero** changes
  to the CI system. `.ml-maintenance` (JP's manual "hold ML down" sentinel) is honored the same way.
- **Palace = soft grace** (your choice: not a hard block). Palace clients auto-wake, so palace
  traffic shouldn't pin the box long-term — but rapid query bursts shouldn't suspend *between*
  queries either. A recent palace request defers this tick without resetting the idle clock, so
  palace can extend the awake window up to `PALACE_GRACE_S` past the last query, then the box
  sleeps.
- **SSH = active-only guard.** You chose "ignore SSH"; the faithful reading is *ignore **idle** SSH*.
  An idle ssh session (high TTY idle time) never pins the box; a session you're **actively typing
  in** (TTY idle < `SSH_ACTIVE_GRACE_S`) is treated as hard-busy so the box isn't suspended out from
  under you. `familiar-autosuspend hold` is the explicit escape hatch for long non-typing work.

## Architecture

Everything lives **on familiar** except the operator CLI, which is **katana-side** (mirrors
`familiar-sleep`/`familiar-wake`). No katana daemon, no second host involved.

```
familiar (on-host)
  ┌─────────────────────────────────────────────────────────────┐
  │ familiar-autosuspend.timer  ── every 5 min ──▶                │
  │ familiar-autosuspend.service (oneshot, User=jp)               │
  │   └─ /usr/local/sbin/familiar-autosuspend-check.sh            │
  │        reads:  systemctl is-active {familiar-api,qwen3-coder} │
  │                test -f /home/jp/ci-hooks/.ml-{paused-by-ci,   │
  │                                              maintenance}     │
  │                journalctl -u palace-daemon (windowed)         │
  │                w -h -s            (active-SSH TTY idle)        │
  │                /var/lib/familiar-autosuspend/{enabled,        │
  │                                               hold-until}     │
  │                /run/familiar-autosuspend/last-busy   (clock)  │
  │        gate:   sudo -n ethtool enp5s0 | grep 'Wake-on: g'     │
  │                (re-arm if missing; ABORT if still unarmed)    │
  │        act:    sudo systemd-run --no-block systemctl suspend  │
  └─────────────────────────────────────────────────────────────┘
  /usr/lib/systemd/system-sleep/familiar-autosuspend-resume
       └─ on `post` (resume): rm -f /run/familiar-autosuspend/last-busy

katana (operator)
  ┌─────────────────────────────────────────────────────────────┐
  │ ops/scripts/familiar-autosuspend  (symlinked ~/.local/bin)   │
  │   on | off | status | hold [dur] | now   ── ssh familiar ──▶  │
  └─────────────────────────────────────────────────────────────┘
```

### Components

1. **`familiar-autosuspend-check.sh`** — on-host idle detector + suspend trigger. The only piece
   with decision logic. **Every input is env-overridable** (commands via PATH shims, paths and
   thresholds via env) so the decision is unit-testable without real systemd. Supports `--explain`
   (dry-run: print verdict + reason, never suspend).
2. **`familiar-autosuspend.service` / `.timer`** — oneshot + 5-min timer (watchdog convention).
3. **`familiar-autosuspend-resume`** — `system-sleep` hook; invalidates the idle clock on resume.
4. **`familiar-autosuspend`** — katana-side operator CLI (`on|off|status|hold|now`), ssh-driven.
5. **`install-familiar-autosuspend.sh`** — installer modeled on `install-familiar-watchdog.sh`.

### State

| Path | Substrate | Owner | Purpose | Lifecycle |
|---|---|---|---|---|
| `/var/lib/familiar-autosuspend/enabled` | persistent | jp:jp | master "armed" intent | created by `on`, removed by `off`; survives reboot (stays armed) |
| `/var/lib/familiar-autosuspend/hold-until` | persistent | jp:jp | epoch; defer suspend while `now < value` | written by `hold`; expires naturally; jp-writable over ssh without sudo |
| `/run/familiar-autosuspend/last-busy` | tmpfs | jp:jp | idle clock = epoch of last hard-busy tick | `RuntimeDirectory=` provisioned; cleared on reboot; invalidated on resume by the hook |

**Why the idle clock is in `/run`, not `/var/lib`:** tmpfs is wiped on **reboot** (so a fresh boot
starts with no clock → "just active" → no immediate suspend) but **survives S3** (RAM retained).
That survival is exactly why the resume hook is required (below). The persistent intent/hold files
live in `/var/lib` so they survive reboot and are writable by jp over ssh without sudo (matching the
`familiar-watchdog` `/var/lib/familiar-watchdog` precedent).

## The checker algorithm

```
# config (env-overridable; defaults shown)
IDLE_THRESHOLD_S=900      # 15 min
PALACE_GRACE_S=600        # 10 min soft grace after last palace request
SSH_ACTIVE_GRACE_S=600    # SSH TTY idle below this = "actively typing" = hard-busy
CI_HOOKS_DIR=/home/jp/ci-hooks
STATE_DIR=/var/lib/familiar-autosuspend
RUN_DIR=/run/familiar-autosuspend
IFACE=enp5s0
EXPLAIN=0                 # --explain sets this; never suspends

now            = epoch
last_busy_file = $RUN_DIR/last-busy

# ── master switch ───────────────────────────────────────────────
test -f $STATE_DIR/enabled            || verdict "disabled";  exit
# (timer being enabled is the primary switch; the sentinel is an
#  in-script kill switch so `off` is effective even mid-tick.)

# ── hold window (soft) ──────────────────────────────────────────
if [ -f $STATE_DIR/hold-until ] && now < $(cat hold-until):
    verdict "held until <ts>"; exit            # no suspend, no clock reset

# ── hard-busy signals → reset clock, stay awake ─────────────────
hard_busy = false; reason=""
systemctl is-active --quiet familiar-api.service      && hard_busy; reason="companion active"
systemctl is-active --quiet qwen3-coder.service       && hard_busy; reason="coder active"
test -f $CI_HOOKS_DIR/.ml-paused-by-ci                && hard_busy; reason="CI build in flight"
test -f $CI_HOOKS_DIR/.ml-maintenance                 && hard_busy; reason="ML maintenance hold"
ssh_min_idle_s < SSH_ACTIVE_GRACE_S                   && hard_busy; reason="active SSH (idle <Ns)"
if hard_busy:
    echo now > $last_busy_file                  # reset idle clock
    verdict "busy: $reason"; exit

# ── idle clock bootstrap ────────────────────────────────────────
if ! -f $last_busy_file:                         # missing = fresh (boot/resume)
    echo now > $last_busy_file
    verdict "fresh clock (no prior activity)"; exit
idle = now - $(cat $last_busy_file)

# ── palace soft grace ───────────────────────────────────────────
palace_age = seconds_since_last_palace_request()  # windowed journald, see below
if palace_age != STALE and palace_age < PALACE_GRACE_S:
    verdict "palace grace (last req ${palace_age}s ago)"; exit   # no clock reset

# ── min-uptime guard (defense; let the box settle) ──────────────
if uptime_s < IDLE_THRESHOLD_S:
    verdict "settling (uptime ${uptime_s}s)"; exit

# ── idle decision ───────────────────────────────────────────────
if idle < IDLE_THRESHOLD_S:
    verdict "idle ${idle}s / need ${IDLE_THRESHOLD_S}s"; exit

# ── WOL safety gate (must pass before ANY suspend) ──────────────
if ! sudo -n ethtool $IFACE | grep -q 'Wake-on: g':
    sudo ethtool -s $IFACE wol g                 # re-arm (familiar-sleep parity)
    if ! sudo -n ethtool $IFACE | grep -q 'Wake-on: g':
        verdict "REFUSE: WOL not armable — staying awake (unwakeable risk)"; exit

# ── suspend ─────────────────────────────────────────────────────
if EXPLAIN: verdict "WOULD SUSPEND (idle ${idle}s, WOL armed)"; exit
log "suspending: idle ${idle}s ≥ ${IDLE_THRESHOLD_S}s, WOL armed"
sudo systemd-run --no-block systemctl suspend     # detached, like familiar-sleep
```

### Sub-signals — exact commands (all verified live 2026-06-15)

- **companion / coder:** `systemctl is-active --quiet <unit>` (exit 0 = active). Deliberately
  returns non-zero for `failed`/`activating`/`inactive`, so familiar-api's known SIGKILL→`failed`
  stop outcome does **not** block suspend.
- **CI in flight:** `test -f /home/jp/ci-hooks/.ml-paused-by-ci` (created by `pause-ml.sh` first
  `JOB_STARTED`, removed by `resume-ml.sh` last `JOB_COMPLETED`; staleness bounded to ≤20 min by
  `ml-resume-guard.timer`, `MAX_PAUSE_S=1200`). Maintenance hold: `test -f .ml-maintenance`.
  *Decision:* honor the sentinel as-is (simplest-correct; fail-safe = stays awake). Optional future
  tightening: `&& pgrep -x Runner.Worker` to discount a stale-but-present sentinel. Not in v1.
- **palace recent:** windowed journald (jp is in `adm`, so no sudo; measured ~7 ms — not a full
  scan). Compute seconds since the last **non-health** request:
  ```
  win=$(( PALACE_GRACE_S + 90 ))    # window = grace + tick buffer
  last=$(journalctl -u palace-daemon.service --since "${win} sec ago" --no-pager -o short-unix \
           | grep -E 'INFO: .* - "(GET|POST|PUT|DELETE|PATCH) ' \
           | grep -v '"GET /health ' \
           | tail -1 | cut -d. -f1)
  # empty → STALE (no grace); else age = now - last
  ```
  The `grep -v '"GET /health '` is **mandatory**: it drops health self-probes so monitors don't
  self-grant grace forever. **The checker issues zero requests to `:8085`** (journald only) and does
  **not** curl the companion either (uses `is-active`), so there is no self-probe feedback loop on
  any journal it scans. *Dependency note (one comment in the script):* this signal relies on
  uvicorn's default access logging; if `palace-daemon.service` were ever started `--no-access-log`,
  the query reads STALE → fail-safe (box may sleep), never the reverse.
- **active SSH:** parse `w -h -s` (USER TTY FROM IDLE WHAT), take the **minimum** IDLE across sshd
  PTYs, normalize formats (`s`, `M:SS`, `H:MMm`, `Ndays`); unparseable → treat as active
  (conservative). Non-PTY `ssh host cmd` connections don't appear in `w`, so the checker's own
  invocations never self-register. `< SSH_ACTIVE_GRACE_S` → hard-busy.
- **WOL gate:** `sudo -n ethtool enp5s0 | grep -q 'Wake-on: g'` (verified live: `Wake-on: g`,
  `mem_sleep=[deep]`, ACPI `RLAN *enabled`). Re-arm with `ethtool -s enp5s0 wol g` if missing.

### Resume hook — why it exists

S3 is **not** a reboot: the kernel never restarts, RAM is retained, and `/run` tmpfs survives.
Therefore the idle clock **survives resume** — and if left alone it would read "idle ≥ 15 min" the
instant the box wakes, so the very next tick would re-suspend: a wake→sleep loop. The hook breaks
the loop by **invalidating the clock on every resume**, guaranteeing a full awake window after any
wake (manual, palace auto-wake, or operator):

```sh
#!/bin/sh
# /usr/lib/systemd/system-sleep/familiar-autosuspend-resume  (root:root 0755)
# systemd calls: <script> {pre|post} {suspend|hibernate|...}
[ "$1" = post ] && rm -f /run/familiar-autosuspend/last-busy 2>/dev/null
exit 0
```

(Deletion is ownership-agnostic — root unlinks the jp-owned file; next tick re-bootstraps it to
*now*. Equivalent alternative considered: `WantedBy=sleep.target` oneshot; the `system-sleep` script
is simpler and the dir already holds vendor hooks.)

## Operator CLI — "very easy on/off"

Katana-side script `ops/scripts/familiar-autosuspend`, symlinked into `~/.local/bin` (mirrors
`familiar-sleep`/`familiar-wake`). All actions drive familiar over `ssh` using jp's passwordless
sudo.

| Command | Action |
|---|---|
| `familiar-autosuspend on` | `ssh familiar` → `touch $STATE_DIR/enabled` + `sudo systemctl enable --now familiar-autosuspend.timer` |
| `familiar-autosuspend off` | `ssh familiar` → `sudo systemctl disable --now …timer` + `rm -f $STATE_DIR/enabled` (hard kill switch) |
| `familiar-autosuspend status` | `ssh familiar` → print enabled?(sentinel+timer), idle-for, last palace age, hold remaining, min SSH idle, **and the live verdict** via `familiar-autosuspend-check.sh --explain` |
| `familiar-autosuspend hold [DUR]` | `ssh familiar` → write `$STATE_DIR/hold-until = now + DUR` (default `30m`); stay awake for the window, then auto-re-arm |
| `familiar-autosuspend now` | immediate S3 suspend, **still** WOL-gated (re-arm if needed) — shares `familiar-sleep`'s arm-then-suspend path |

`off` is unconditional (no surprises). `hold` is the documented workflow for long interactive work
that won't register as TTY activity.

## Install & layout

Source lives under **`ops/familiar/`** (the established home for oneshot+timer trios —
`familiar-watchdog`, `familiar-disk-monitor`, `mempalace-backup`), **not** `ops/systemd/units/`
(reserved for slot-variant llama.cpp model servers, and iterated by `deploy-familiar.sh`'s
`for u in ops/systemd/units/*.service` loop — a timer-less oneshot dropped there would be
mis-installed).

| Artifact | Repo source | Installed to | Mode/owner |
|---|---|---|---|
| check script | `ops/familiar/familiar-autosuspend-check.sh` | `/usr/local/sbin/familiar-autosuspend-check.sh` | 0755 root:root |
| resume hook | `ops/familiar/familiar-autosuspend-resume` | `/usr/lib/systemd/system-sleep/familiar-autosuspend-resume` | 0755 root:root |
| service unit | `ops/familiar/familiar-autosuspend.service` | `/etc/systemd/system/` | 0644 |
| timer unit | `ops/familiar/familiar-autosuspend.timer` | `/etc/systemd/system/` | 0644 |
| installer | `ops/scripts/install-familiar-autosuspend.sh` | (run from katana) | — |
| operator CLI | `ops/scripts/familiar-autosuspend` | `~/.local/bin/familiar-autosuspend` (katana symlink) | 0755 |

Installer (modeled on `install-familiar-watchdog.sh`): scp → `/tmp` → `sudo install` to the
destinations above; `mkdir -p /var/lib/familiar-autosuspend` (`chown jp:jp`, `0755`);
`systemctl daemon-reload`. **Does not auto-enable** — it leaves autosuspend installed-but-off and
prints `run: familiar-autosuspend on`. (Deploy never surprise-suspends.) `deploy-familiar.sh` is
**not** modified; autosuspend ships via its own installer, matching the watchdog precedent.

### Unit files

```ini
# familiar-autosuspend.service
[Unit]
Description=familiar autosuspend — idle-detect + S3 suspend (companion/coder/CI aware)
Documentation=https://github.com/techempower-org/familiar.realm.watch/blob/main/docs/superpowers/specs/2026-06-15-familiar-autosuspend-design.md
After=network.target

[Service]
Type=oneshot
User=jp
Group=jp
RuntimeDirectory=familiar-autosuspend
RuntimeDirectoryPreserve=yes
ExecStart=/usr/local/sbin/familiar-autosuspend-check.sh
StandardOutput=journal
StandardError=journal
TimeoutStopSec=10
# no [Install] — the timer carries it
```

```ini
# familiar-autosuspend.timer
[Unit]
Description=Run familiar autosuspend idle-check every 5 min

[Timer]
OnBootSec=120
OnUnitActiveSec=5min
AccuracySec=1min
Persistent=true
Unit=familiar-autosuspend.service

[Install]
WantedBy=timers.target
```

`RuntimeDirectory=familiar-autosuspend` makes systemd create `/run/familiar-autosuspend` as `jp:jp`
on service start; `RuntimeDirectoryPreserve=yes` keeps it across the oneshot's exit (cleared only on
reboot). `OnBootSec=120` staggers after `familiar-watchdog@60s`/`disk-monitor@90s`.

## Identity & privilege

The checker runs as **`User=jp`** (watchdog precedent). jp has **passwordless sudo** on familiar
(verified), so the checker calls `sudo -n ethtool …` and `sudo systemd-run --no-block systemctl
suspend` with **no new sudoers entry**. The operator CLI likewise drives `ssh familiar sudo …` over
jp's existing grant — the same path `familiar-sleep` already uses. (The slot-picker's scoped
`familiar-slotctl` sudoers is for the unprivileged `familiar` service user and is **not** needed
here; it would only be required for a future web-UI toggle.)

## WOL persistence (FIXED 2026-06-15)

Live state is armed (`Wake-on: g`) and S3 sleep/wake has worked reliably all week — **because S3
retains RAM and leaves the NIC PME-armed, so the runtime setting survives every suspend/resume
cycle.** The NetworkManager→systemd-networkd migration had dropped the *durable* arming (no
`wakeonlan` in `/etc/netplan/01-enp5s0.yaml`, empty `/etc/systemd/network/`, r8169 drops WOL on
power-cycle), so the only gap was **across a reboot**.

**Fixed** by a boot-time oneshot, `ops/familiar/wol-arm-enp5s0.service` (installed to
`/etc/systemd/system/`, `enabled`), which re-runs the known-good `ethtool -s enp5s0 wol g` once the
NIC device appears at each boot (`Requires=`/`After=sys-subsystem-net-devices-enp5s0.device`). An
`ethtool` oneshot is chosen over netplan `wakeonlan:` or a networkd `.link WakeOnLan=magic` because
the r8169 is documented to drop WOL on power-cycle and reliably responds to this exact runtime
command; the unit is driver- and renderer-agnostic. Verified live by simulating the drop
(`ethtool -s enp5s0 wol d` → `Wake-on: d`) then running the unit (→ `Wake-on: g`), without a
disruptive reboot.

The autosuspend checker still re-arms WOL before each suspend as defense-in-depth (familiar-sleep
parity), so the suspend path is self-healing even if the boot unit were ever disabled. Network
config (netplan/networkd) is left untouched; backups at `/var/backups/familiar-net/`.

## Failure modes & edge cases

| Scenario | Behavior |
|---|---|
| Idle clock missing (boot / post-resume) | bootstrap to *now*, don't suspend (fresh window) |
| Resume from S3 | hook deletes clock → next tick bootstraps → full 15-min window |
| WOL not armable | **refuse to suspend**, log loudly (never strand a headless box) |
| `familiar-api` stuck `failed` (SIGKILL-on-stop quirk) | `is-active --quiet` is non-zero → does **not** block (correct) |
| Crashed CI runner leaves stale `.ml-paused-by-ci` | stays awake ≤20 min until `ml-resume-guard` clears it (fail-safe) |
| Operator actively typing in SSH | TTY idle < grace → hard-busy → not suspended |
| Operator long non-typing task | use `familiar-autosuspend hold 30m` |
| Master toggled `off` mid-tick | timer disabled (no future ticks) + `enabled` sentinel removed (in-tick kill) |
| palace started `--no-access-log` | grace query reads STALE → may sleep (fail-safe), never never-sleep |

## Testing

`familiar-autosuspend-check.sh --explain` is a pure, side-effect-free verdict printer. A Bun test
(`tests/autosuspend.test.ts`, shelling out per repo convention) drives it with:

- a fake-bin dir prepended to `PATH` shimming `systemctl`, `ethtool`, `journalctl`, `w`, `systemd-run`;
- env overrides: `FA_NOW`, `FA_STATE_DIR`, `FA_RUN_DIR`, `FA_CI_HOOKS_DIR`, `FA_IFACE`,
  `FA_IDLE_THRESHOLD_S`, `FA_PALACE_GRACE_S`, `FA_SSH_ACTIVE_GRACE_S`.

Matrix (assert verdict string **and** whether the `systemd-run`/suspend shim was invoked):

1. master disabled → no suspend
2. hold window active → no suspend
3. companion active → "busy: companion", clock reset, no suspend
4. coder active → "busy: coder", no suspend
5. `.ml-paused-by-ci` present → "busy: CI", no suspend
6. `.ml-maintenance` present → "busy: maintenance", no suspend
7. active SSH (TTY idle < grace) → "busy: active SSH", no suspend
8. fresh clock (missing file) → bootstrap, no suspend
9. recent palace request (< grace) → "palace grace", no suspend, clock unchanged
10. uptime < threshold → "settling", no suspend
11. idle < threshold → "idle Ns", no suspend
12. idle ≥ threshold, WOL unarmable → **refuse**, no suspend
13. idle ≥ threshold, WOL armed, `--explain` → "WOULD SUSPEND", shim **not** called
14. idle ≥ threshold, WOL armed, normal → suspend shim **called once**

## Build sequence (for the implementation plan)

1. `familiar-autosuspend-check.sh` with full env-overridability + `--explain` (TDD against the matrix).
2. `tests/autosuspend.test.ts` (fake-bin shims + env).
3. Resume hook + the two unit files.
4. Operator CLI `familiar-autosuspend` (on/off/status/hold/now).
5. `install-familiar-autosuspend.sh`.
6. Deploy to familiar, arm with `familiar-autosuspend on`, observe one real idle→suspend→wake cycle.

## Open follow-ups (out of scope, noted)

- ~~Durable WOL arming across reboot~~ — **done 2026-06-15** via `ops/familiar/wol-arm-enp5s0.service` (see "WOL persistence").
- familiar-api graceful-shutdown (SIGTERM→clean exit) so it doesn't land `failed` on stop — pre-existing.
- Deployed `familiar-api.service` omits `KillMode=mixed` present in the repo template — pre-existing drift.
- Optional CI sentinel tightening with `pgrep -x Runner.Worker`.
- Web-dashboard toggle via a scoped-sudo wrapper (slot-picker pattern).
