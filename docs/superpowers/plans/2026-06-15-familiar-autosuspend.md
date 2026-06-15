# familiar autosuspend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the headless `familiar` host suspend itself to S3 after 15 min idle — aware of the on-demand companion, the local-coder, and CI builds — with a trivial on/off control.

**Architecture:** A 5-min systemd timer (`User=jp`) runs `familiar-autosuspend-check.sh`, which evaluates 6 hard-blocks (master-switch, companion, coder, CI sentinel, maintenance sentinel, active-SSH) and 2 soft-defers (operator hold, recent palace request); when idle past threshold it arms WOL and suspends. A `system-sleep` resume hook invalidates the `/run` idle clock so the box doesn't re-suspend in a loop after waking. A katana-side CLI (`familiar-autosuspend on|off|status|hold|now`) drives it over ssh, mirroring `familiar-sleep`/`familiar-wake`.

**Tech Stack:** Bash (host scripts + systemd units), Bun test (decision-logic tests via env injection), systemd timer/oneshot/`system-sleep`.

**Spec:** `docs/superpowers/specs/2026-06-15-familiar-autosuspend-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `ops/familiar/familiar-autosuspend-check.sh` | The only decision logic. Env-overridable inputs; `--explain` (dry-run) and `--parse-idle` (debug). Installed → `/usr/local/sbin/`. |
| `ops/familiar/familiar-autosuspend-resume` | `system-sleep` hook; deletes the `/run` idle clock on resume. Installed → `/usr/lib/systemd/system-sleep/`. |
| `ops/familiar/familiar-autosuspend.service` | Oneshot, `User=jp`, `RuntimeDirectory=familiar-autosuspend`. Installed → `/etc/systemd/system/`. |
| `ops/familiar/familiar-autosuspend.timer` | 5-min timer. Installed → `/etc/systemd/system/`. |
| `ops/scripts/familiar-autosuspend` | Katana-side operator CLI; ssh-driven. Symlinked → `~/.local/bin/`. |
| `ops/scripts/install-familiar-autosuspend.sh` | Installer (scp → sudo install → daemon-reload; does NOT auto-enable). |
| `tests/autosuspend.test.ts` | Bun test driving the check script across the 14-case matrix via env injection. |

Test seam: the check script reads `FA_FORCE_COMPANION_ACTIVE`, `FA_FORCE_CODER_ACTIVE`, `FA_FORCE_SSH_MIN_IDLE_S`, `FA_FORCE_PALACE_AGE_S`, `FA_FORCE_WOL`, `FA_NOW`, `FA_UPTIME_S`, `FA_SUSPEND_CMD`, `FA_REARM_CMD`, and path/threshold overrides — so tests need no real systemd, ethtool, journald, or `w`.

---

## Task 1: The idle-detector check script (TDD)

**Files:**
- Create: `ops/familiar/familiar-autosuspend-check.sh`
- Test: `tests/autosuspend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/autosuspend.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = new URL("../ops/familiar/familiar-autosuspend-check.sh", import.meta.url).pathname;
const NOW = 1_000_000_000;

let dirs: { state: string; run: string; ci: string };

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "fa-"));
  dirs = { state: join(base, "state"), run: join(base, "run"), ci: join(base, "ci") };
  for (const d of Object.values(dirs)) require("node:fs").mkdirSync(d, { recursive: true });
});
afterEach(() => {
  // temp dirs live under os.tmpdir(); leave to OS cleanup if rm fails
  try { rmSync(dirs.state.replace(/\/state$/, ""), { recursive: true, force: true }); } catch {}
});

function base(): Record<string, string> {
  return {
    FA_STATE_DIR: dirs.state, FA_RUN_DIR: dirs.run, FA_CI_HOOKS_DIR: dirs.ci,
    FA_NOW: String(NOW), FA_UPTIME_S: "100000",
    FA_IDLE_THRESHOLD_S: "900", FA_PALACE_GRACE_S: "600", FA_SSH_ACTIVE_GRACE_S: "600",
    FA_FORCE_COMPANION_ACTIVE: "0", FA_FORCE_CODER_ACTIVE: "0",
    FA_FORCE_SSH_MIN_IDLE_S: "999999", FA_FORCE_PALACE_AGE_S: "STALE",
    FA_FORCE_WOL: "g",
    FA_SUSPEND_CMD: `touch ${join(dirs.run, "SUSPENDED")}`,
    FA_REARM_CMD: "true",
  };
}
function run(env: Record<string, string>, args: string[] = []) {
  const p = Bun.spawnSync({ cmd: ["bash", CHECK, ...args], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
}
const enable = () => writeFileSync(join(dirs.state, "enabled"), "");
const setClock = (epoch: number) => writeFileSync(join(dirs.run, "last-busy"), String(epoch));
const suspended = () => existsSync(join(dirs.run, "SUSPENDED"));

describe("familiar-autosuspend-check", () => {
  test("disabled when no master sentinel", () => {
    const r = run(base());
    expect(r.out).toContain("disabled");
    expect(suspended()).toBe(false);
  });

  test("hold window defers", () => {
    enable(); setClock(NOW - 5000);
    writeFileSync(join(dirs.state, "hold-until"), String(NOW + 300));
    const r = run(base());
    expect(r.out).toContain("held");
    expect(suspended()).toBe(false);
  });

  test("companion active blocks + resets clock", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_COMPANION_ACTIVE: "1" });
    expect(r.out).toContain("busy — companion");
    expect(suspended()).toBe(false);
    expect(require("node:fs").readFileSync(join(dirs.run, "last-busy"), "utf8").trim()).toBe(String(NOW));
  });

  test("coder active blocks", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_CODER_ACTIVE: "1" });
    expect(r.out).toContain("busy — coder");
    expect(suspended()).toBe(false);
  });

  test("CI sentinel blocks", () => {
    enable(); setClock(NOW - 5000);
    writeFileSync(join(dirs.ci, ".ml-paused-by-ci"), String(NOW));
    const r = run(base());
    expect(r.out).toContain("busy — CI build");
    expect(suspended()).toBe(false);
  });

  test("maintenance sentinel blocks", () => {
    enable(); setClock(NOW - 5000);
    writeFileSync(join(dirs.ci, ".ml-maintenance"), "");
    const r = run(base());
    expect(r.out).toContain("busy — ML maintenance");
    expect(suspended()).toBe(false);
  });

  test("active SSH blocks", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_SSH_MIN_IDLE_S: "120" });
    expect(r.out).toContain("active SSH");
    expect(suspended()).toBe(false);
  });

  test("missing clock bootstraps to fresh", () => {
    enable(); // no setClock
    const r = run(base());
    expect(r.out).toContain("fresh");
    expect(suspended()).toBe(false);
    expect(existsSync(join(dirs.run, "last-busy"))).toBe(true);
  });

  test("recent palace request defers (soft grace, no clock reset)", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_PALACE_AGE_S: "120" });
    expect(r.out).toContain("palace grace");
    expect(suspended()).toBe(false);
    expect(require("node:fs").readFileSync(join(dirs.run, "last-busy"), "utf8").trim()).toBe(String(NOW - 5000));
  });

  test("settling guard when uptime below threshold", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_UPTIME_S: "100" });
    expect(r.out).toContain("settling");
    expect(suspended()).toBe(false);
  });

  test("idle below threshold waits", () => {
    enable(); setClock(NOW - 100);
    const r = run(base());
    expect(r.out).toContain("idle 100s / need 900s");
    expect(suspended()).toBe(false);
  });

  test("idle past threshold but WOL unarmable refuses", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_WOL: "d", FA_REARM_CMD: "true" });
    expect(r.out).toContain("REFUSE");
    expect(suspended()).toBe(false);
  });

  test("--explain never suspends even when it would", () => {
    enable(); setClock(NOW - 5000);
    const r = run(base(), ["--explain"]);
    expect(r.out).toContain("WOULD SUSPEND");
    expect(suspended()).toBe(false);
  });

  test("idle past threshold with WOL armed suspends once", () => {
    enable(); setClock(NOW - 5000);
    const r = run(base());
    expect(r.out).toContain("suspending");
    expect(suspended()).toBe(true);
  });

  describe("parse-idle (w IDLE column → seconds)", () => {
    const cases: [string, string][] = [
      ["3:21", "201"], ["08:09", "489"], ["45.00s", "45"], ["0.00s", "0"],
      ["1:30m", "5400"], ["2days", "172800"],
    ];
    for (const [inp, exp] of cases) {
      test(`${inp} → ${exp}`, () => {
        const r = run(base(), ["--parse-idle", inp]);
        expect(r.out).toBe(exp);
      });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/autosuspend.test.ts`
Expected: FAIL — the script doesn't exist yet (`bash: .../familiar-autosuspend-check.sh: No such file or directory`), all assertions fail.

- [ ] **Step 3: Write the check script**

Create `ops/familiar/familiar-autosuspend-check.sh` (exact content):

```bash
#!/usr/bin/env bash
# familiar-autosuspend-check — idle detector + S3 suspend trigger for the familiar host.
# Runs every ~5 min from familiar-autosuspend.timer (User=jp). Spec:
#   docs/superpowers/specs/2026-06-15-familiar-autosuspend-design.md
#
# All inputs are env-overridable so the decision logic is unit-testable without
# real systemd/ethtool/journald/w (see tests/autosuspend.test.ts).
#   --explain      print the verdict and never suspend
#   --parse-idle V print the `w` IDLE value V converted to seconds (debug)
#
# NOTE: palace-recent relies on uvicorn's default access logging in palace-daemon's
# journal; if that unit ever runs --no-access-log the signal reads STALE
# (fail-safe: may sleep), never the reverse.
set -uo pipefail

STATE_DIR="${FA_STATE_DIR:-/var/lib/familiar-autosuspend}"
RUN_DIR="${FA_RUN_DIR:-/run/familiar-autosuspend}"
CI_HOOKS_DIR="${FA_CI_HOOKS_DIR:-/home/jp/ci-hooks}"
IFACE="${FA_IFACE:-enp5s0}"
IDLE_THRESHOLD_S="${FA_IDLE_THRESHOLD_S:-900}"
PALACE_GRACE_S="${FA_PALACE_GRACE_S:-600}"
SSH_ACTIVE_GRACE_S="${FA_SSH_ACTIVE_GRACE_S:-600}"
COMPANION_UNIT="${FA_COMPANION_UNIT:-familiar-api.service}"
CODER_UNIT="${FA_CODER_UNIT:-qwen3-coder.service}"
PALACE_UNIT="${FA_PALACE_UNIT:-palace-daemon.service}"
REARM_CMD="${FA_REARM_CMD:-sudo ethtool -s ${IFACE} wol g}"
SUSPEND_CMD="${FA_SUSPEND_CMD:-sudo systemd-run --no-block systemctl suspend}"

now="${FA_NOW:-$(date +%s)}"
last_busy_file="${RUN_DIR}/last-busy"
enabled_file="${STATE_DIR}/enabled"
hold_file="${STATE_DIR}/hold-until"

say() { echo "autosuspend: $1"; }

parse_idle() {
  # procps `w` IDLE column → integer seconds. Echo seconds or return 1.
  local v="$1"
  case "$v" in
    *days) echo $(( ${v%days} * 86400 )) ;;
    *day)  echo 86400 ;;
    *m)    v="${v%m}"; echo $(( 10#${v%:*} * 3600 + 10#${v#*:} * 60 )) ;;   # H:MMm
    *s)    v="${v%s}"; echo "${v%.*}" ;;                                    # SS.sss s
    *:*)   echo $(( 10#${v%:*} * 60 + 10#${v#*:} )) ;;                      # MM:SS
    *[0-9]) echo "$v" ;;
    *) return 1 ;;
  esac
}

ssh_min_idle_s() {
  [ -n "${FA_FORCE_SSH_MIN_IDLE_S:-}" ] && { echo "$FA_FORCE_SSH_MIN_IDLE_S"; return; }
  local min="" idle secs user tty from what
  while read -r user tty from idle what; do
    case "$tty" in tty*|pts/*) ;; *) continue ;; esac
    secs="$(parse_idle "$idle")" || continue
    if [ -z "$min" ] || [ "$secs" -lt "$min" ]; then min="$secs"; fi
  done < <(w -h -s 2>/dev/null)
  echo "${min:-999999}"
}

palace_age_s() {
  [ -n "${FA_FORCE_PALACE_AGE_S:-}" ] && { echo "$FA_FORCE_PALACE_AGE_S"; return; }
  local win last
  win=$(( PALACE_GRACE_S + 90 ))
  last="$(journalctl -u "$PALACE_UNIT" --since "${win} sec ago" --no-pager -o short-unix 2>/dev/null \
            | grep -E 'INFO: .* - "(GET|POST|PUT|DELETE|PATCH) ' \
            | grep -v '"GET /health ' \
            | tail -1 | cut -d. -f1)"
  if [ -z "$last" ]; then echo "STALE"; else echo $(( now - last )); fi
}

companion_active() {
  [ -n "${FA_FORCE_COMPANION_ACTIVE:-}" ] && { [ "$FA_FORCE_COMPANION_ACTIVE" = 1 ]; return; }
  systemctl is-active --quiet "$COMPANION_UNIT"
}
coder_active() {
  [ -n "${FA_FORCE_CODER_ACTIVE:-}" ] && { [ "$FA_FORCE_CODER_ACTIVE" = 1 ]; return; }
  systemctl is-active --quiet "$CODER_UNIT"
}
wol_armed() {
  [ -n "${FA_FORCE_WOL:-}" ] && { [ "$FA_FORCE_WOL" = g ]; return; }
  sudo -n ethtool "$IFACE" 2>/dev/null | grep -q 'Wake-on: g'
}
uptime_s() {
  [ -n "${FA_UPTIME_S:-}" ] && { echo "$FA_UPTIME_S"; return; }
  cut -d. -f1 /proc/uptime
}

# ---- debug subcommand ----
if [ "${1:-}" = "--parse-idle" ]; then parse_idle "${2:-}"; exit $?; fi
EXPLAIN=0
[ "${1:-}" = "--explain" ] && EXPLAIN=1

mkdir -p "$RUN_DIR" 2>/dev/null || true
mkdir -p "$STATE_DIR" 2>/dev/null || true

# ---- master switch ----
if [ ! -f "$enabled_file" ]; then say "disabled (master switch off)"; exit 0; fi

# ---- hold window (soft) ----
if [ -f "$hold_file" ]; then
  hold_until="$(cat "$hold_file" 2>/dev/null || echo 0)"
  if [ "$now" -lt "$hold_until" ]; then rem=$(( hold_until - now )); say "held (${rem}s remaining)"; exit 0; fi
fi

# ---- hard-busy → reset clock, stay awake ----
busy_reason=""
if companion_active; then busy_reason="companion active"
elif coder_active; then busy_reason="coder active"
elif [ -f "$CI_HOOKS_DIR/.ml-paused-by-ci" ]; then busy_reason="CI build in flight"
elif [ -f "$CI_HOOKS_DIR/.ml-maintenance" ]; then busy_reason="ML maintenance hold"
else
  ssh_idle="$(ssh_min_idle_s)"
  if [ "$ssh_idle" -lt "$SSH_ACTIVE_GRACE_S" ]; then busy_reason="active SSH (idle ${ssh_idle}s)"; fi
fi
if [ -n "$busy_reason" ]; then
  echo "$now" > "$last_busy_file" 2>/dev/null || true
  say "busy — $busy_reason"; exit 0
fi

# ---- idle clock bootstrap ----
if [ ! -f "$last_busy_file" ]; then
  echo "$now" > "$last_busy_file" 2>/dev/null || true
  say "fresh clock — idle baseline set"; exit 0
fi
last_busy="$(cat "$last_busy_file" 2>/dev/null || echo "$now")"
idle=$(( now - last_busy ))

# ---- palace soft grace ----
page="$(palace_age_s)"
if [ "$page" != "STALE" ] && [ "$page" -lt "$PALACE_GRACE_S" ]; then
  say "palace grace (last request ${page}s ago)"; exit 0
fi

# ---- min-uptime guard ----
up="$(uptime_s)"
if [ "$up" -lt "$IDLE_THRESHOLD_S" ]; then say "settling (uptime ${up}s < ${IDLE_THRESHOLD_S}s)"; exit 0; fi

# ---- idle decision ----
if [ "$idle" -lt "$IDLE_THRESHOLD_S" ]; then say "idle ${idle}s / need ${IDLE_THRESHOLD_S}s"; exit 0; fi

# ---- WOL safety gate (never suspend a box we can't wake) ----
if ! wol_armed; then
  eval "$REARM_CMD" >/dev/null 2>&1 || true
  if ! wol_armed; then say "REFUSE — WOL not armable, staying awake"; exit 0; fi
fi

# ---- suspend ----
if [ "$EXPLAIN" = 1 ]; then say "WOULD SUSPEND (idle ${idle}s, WOL armed)"; exit 0; fi
say "suspending — idle ${idle}s, WOL armed"
eval "$SUSPEND_CMD"
exit 0
```

- [ ] **Step 4: Make it executable and run the tests**

Run: `chmod +x ops/familiar/familiar-autosuspend-check.sh && bun test tests/autosuspend.test.ts`
Expected: PASS — all 20 assertions (14 decision cases + 6 parse-idle cases) green.

- [ ] **Step 5: Commit**

```bash
git add ops/familiar/familiar-autosuspend-check.sh tests/autosuspend.test.ts
git commit -m "feat(autosuspend): idle-detector check script + tests"
```

---

## Task 2: Resume hook + systemd units

**Files:**
- Create: `ops/familiar/familiar-autosuspend-resume`
- Create: `ops/familiar/familiar-autosuspend.service`
- Create: `ops/familiar/familiar-autosuspend.timer`

- [ ] **Step 1: Write the resume hook**

Create `ops/familiar/familiar-autosuspend-resume`:

```sh
#!/bin/sh
# system-sleep hook: invalidate the autosuspend idle clock on resume so a stale
# clock (which survives S3 — RAM is retained) doesn't trigger an immediate
# re-suspend loop. systemd calls: <script> {pre|post} {suspend|hibernate|...}
[ "$1" = post ] && rm -f /run/familiar-autosuspend/last-busy 2>/dev/null
exit 0
```

- [ ] **Step 2: Write the service unit**

Create `ops/familiar/familiar-autosuspend.service`:

```ini
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
```

- [ ] **Step 3: Write the timer unit**

Create `ops/familiar/familiar-autosuspend.timer`:

```ini
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

- [ ] **Step 4: Make the hook executable and commit**

```bash
chmod +x ops/familiar/familiar-autosuspend-resume
git add ops/familiar/familiar-autosuspend-resume ops/familiar/familiar-autosuspend.service ops/familiar/familiar-autosuspend.timer
git commit -m "feat(autosuspend): resume hook + oneshot/timer units"
```

---

## Task 3: Operator CLI (katana-side)

**Files:**
- Create: `ops/scripts/familiar-autosuspend`

- [ ] **Step 1: Write the CLI**

Create `ops/scripts/familiar-autosuspend`:

```bash
#!/usr/bin/env bash
# familiar-autosuspend — operator control for familiar's idle-autosuspend.
# Runs from katana; drives familiar over ssh (jp has passwordless sudo there).
# Pairs with familiar-sleep / familiar-wake. Spec:
#   docs/superpowers/specs/2026-06-15-familiar-autosuspend-design.md
set -euo pipefail

HOST=familiar
STATE_DIR=/var/lib/familiar-autosuspend
TIMER=familiar-autosuspend.timer
CHECK=/usr/local/sbin/familiar-autosuspend-check.sh

to_secs() { # "30m" "2h" "45" "45s" "1d" -> seconds
  local v="$1"
  case "$v" in
    *d) echo $(( ${v%d} * 86400 )) ;;
    *h) echo $(( ${v%h} * 3600 )) ;;
    *m) echo $(( ${v%m} * 60 )) ;;
    *s) echo "${v%s}" ;;
    *)  echo "$v" ;;
  esac
}

cmd="${1:-status}"
case "$cmd" in
  on)
    ssh "$HOST" "touch $STATE_DIR/enabled && sudo systemctl enable --now $TIMER"
    echo "autosuspend ARMED (15-min idle → S3). Disable with: familiar-autosuspend off"
    ;;
  off)
    ssh "$HOST" "sudo systemctl disable --now $TIMER; rm -f $STATE_DIR/enabled"
    echo "autosuspend DISABLED — familiar will stay up."
    ;;
  hold)
    secs="$(to_secs "${2:-30m}")"
    ssh "$HOST" "echo \$(( \$(date +%s) + $secs )) > $STATE_DIR/hold-until"
    echo "holding familiar awake for ${2:-30m}."
    ;;
  now)
    exec familiar-sleep
    ;;
  status)
    ssh "$HOST" "
      en=no; [ -f $STATE_DIR/enabled ] && en=yes
      echo \"armed:   \$en (sentinel) / timer \$(systemctl is-enabled $TIMER 2>/dev/null),\$(systemctl is-active $TIMER 2>/dev/null)\"
      if [ -f $STATE_DIR/hold-until ]; then rem=\$(( \$(cat $STATE_DIR/hold-until) - \$(date +%s) )); if [ \$rem -gt 0 ]; then echo \"hold:    \${rem}s remaining\"; else echo \"hold:    none\"; fi; else echo \"hold:    none\"; fi
      echo \"verdict: \$($CHECK --explain 2>/dev/null || echo '(check unavailable)')\"
    "
    ;;
  *)
    echo "usage: familiar-autosuspend {on|off|status|hold [DUR]|now}" >&2
    exit 2
    ;;
esac
```

- [ ] **Step 2: Make executable, smoke-test usage, commit**

Run: `chmod +x ops/scripts/familiar-autosuspend && ops/scripts/familiar-autosuspend bogus; echo "exit=$?"`
Expected: prints the `usage:` line to stderr and `exit=2`.

```bash
git add ops/scripts/familiar-autosuspend
git commit -m "feat(autosuspend): katana-side operator CLI (on/off/status/hold/now)"
```

---

## Task 4: Installer

**Files:**
- Create: `ops/scripts/install-familiar-autosuspend.sh`

- [ ] **Step 1: Write the installer**

Create `ops/scripts/install-familiar-autosuspend.sh` (modeled on `install-familiar-watchdog.sh`):

```bash
#!/usr/bin/env bash
# Install familiar's idle-autosuspend (check script, resume hook, units) on the
# familiar host. Leaves the timer DISABLED — arm with `familiar-autosuspend on`.
set -euo pipefail

HOST=familiar
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../familiar"

scp "$SRC/familiar-autosuspend-check.sh" \
    "$SRC/familiar-autosuspend-resume" \
    "$SRC/familiar-autosuspend.service" \
    "$SRC/familiar-autosuspend.timer" \
    "$HOST:/tmp/"

ssh "$HOST" '
set -e
sudo install -m 0755 -o root -g root /tmp/familiar-autosuspend-check.sh /usr/local/sbin/familiar-autosuspend-check.sh
sudo install -m 0755 -o root -g root /tmp/familiar-autosuspend-resume    /usr/lib/systemd/system-sleep/familiar-autosuspend-resume
sudo install -m 0644 -o root -g root /tmp/familiar-autosuspend.service    /etc/systemd/system/familiar-autosuspend.service
sudo install -m 0644 -o root -g root /tmp/familiar-autosuspend.timer      /etc/systemd/system/familiar-autosuspend.timer
rm -f /tmp/familiar-autosuspend-*
sudo mkdir -p /var/lib/familiar-autosuspend
sudo chown jp:jp /var/lib/familiar-autosuspend
sudo chmod 0755 /var/lib/familiar-autosuspend
sudo systemctl daemon-reload
echo "installed (timer NOT enabled). arm with: familiar-autosuspend on"
'
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x ops/scripts/install-familiar-autosuspend.sh
git add ops/scripts/install-familiar-autosuspend.sh
git commit -m "feat(autosuspend): installer for familiar host"
```

---

## Task 5: Deploy + live verify (does NOT let it suspend mid-session)

**Files:** none (operational)

- [ ] **Step 1: Install on familiar**

Run: `ops/scripts/install-familiar-autosuspend.sh`
Expected: ends with `installed (timer NOT enabled). arm with: familiar-autosuspend on`.

- [ ] **Step 2: Run the checker once by hand and read the verdict**

Run: `ssh familiar 'FA_FORCE_WOL=g /usr/local/sbin/familiar-autosuspend-check.sh --explain'`
Expected: a `autosuspend: disabled (master switch off)` line (not yet armed). Confirms the script runs on-host with no error.

- [ ] **Step 3: Arm, then immediately hold to protect the active session**

Run:
```bash
ops/scripts/familiar-autosuspend on
ops/scripts/familiar-autosuspend hold 2h
ops/scripts/familiar-autosuspend status
```
Expected: `armed: yes ... timer enabled,active`; `hold: ~7200s remaining`; `verdict: autosuspend: held (...s remaining)`. The hold guarantees no real suspend while you/this session are working.

- [ ] **Step 4: Confirm the timer is scheduled**

Run: `ssh familiar 'systemctl list-timers familiar-autosuspend.timer --no-pager'`
Expected: one row showing the next fire within ~5 min.

- [ ] **Step 5: Verify resume-hook + units are installed**

Run: `ssh familiar 'ls -l /usr/lib/systemd/system-sleep/familiar-autosuspend-resume /usr/local/sbin/familiar-autosuspend-check.sh; systemctl is-enabled familiar-autosuspend.timer'`
Expected: both files present (0755), timer `enabled`.

---

## Task 6: Finish the branch

- [ ] **Step 1: Full test run**

Run: `bun test tests/autosuspend.test.ts`
Expected: all green.

- [ ] **Step 2: Use superpowers:finishing-a-development-branch** to choose merge/PR and return to `main`.

---

## Self-Review

**Spec coverage:**
- Idle model (6 hard-blocks / 2 soft-defers) → Task 1 script + tests. ✓
- `/run` idle clock + `RuntimeDirectory` → Task 2 service unit. ✓
- Resume-hook loop-breaker → Task 2 hook + Task 1 fresh-clock test. ✓
- WOL-armed safety gate + re-arm → Task 1 (`wol_armed`/`REARM_CMD`) + REFUSE test. ✓
- `User=jp`, no sudoers → Task 2 unit (`User=jp`), CLI uses jp ssh + passwordless sudo. ✓
- Operator CLI on/off/status/hold/now → Task 3. ✓
- Install under `ops/familiar/`, not `ops/systemd/units/` → Task 4. ✓
- 14-case test matrix + parse-idle → Task 1. ✓
- Deploy without surprise-suspend → Task 5 (install leaves disabled; arm+hold). ✓

**Placeholder scan:** none — all scripts/units are complete literal content; all commands have expected output.

**Type/name consistency:** verdict substrings asserted in tests (`disabled`, `held`, `busy — companion`, `busy — coder`, `busy — CI build`, `busy — ML maintenance`, `active SSH`, `fresh`, `palace grace`, `settling`, `idle 100s / need 900s`, `REFUSE`, `WOULD SUSPEND`, `suspending`) match the `say "..."` strings in the script exactly. Env var names (`FA_*`) match between the test harness and the script. Paths (`/var/lib/familiar-autosuspend`, `/run/familiar-autosuspend/last-busy`, `/usr/local/sbin/familiar-autosuspend-check.sh`) are consistent across script, units, CLI, and installer.
