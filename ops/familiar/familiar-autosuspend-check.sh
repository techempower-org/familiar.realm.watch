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
