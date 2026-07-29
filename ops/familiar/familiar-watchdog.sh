#!/usr/bin/env bash
# familiar-watchdog.sh — on-host watchdog for the familiar daily-deps.
#
# Runs every 5 min via familiar-watchdog.timer. Checks four things and
# logs WARN-level diagnostics to journal when anything degrades. Stays
# silent on the happy path.
#
# 1. Functional /api/familiar/health probe via localhost. Faster than
#    going through Caddy and catches the chat-fallback class of bug
#    that hid for hours on 2026-05-16 before anyone noticed (#38).
#    Gated on familiar-api's unit state since 2026-07-29 — an on-demand
#    service that is deliberately inactive must not page. `failed` still
#    pages. See probe_health for why this is a triage, not a mute.
# 2. Restart-counter watch on ollama-chat / ollama-embed / familiar-api.
#    Today's palace-daemon cascade ran restart counter to 97 in <30 min
#    while `systemctl is-active` happily reported "active" because the
#    service was restarting every 5s. This script compares the current
#    counter to the previously-observed value (cached at
#    /var/lib/familiar-watchdog/state) and fires on growth > threshold.
# 3. Memory pressure check on each service — if memory-current is close
#    to memory-max, log warning (lead indicator before OOM).
#    NOTE: documented since the original commit but NOT yet implemented.
# 4. NVIDIA driver-stack coherence (added 2026-07-29). Catches the
#    userspace-upgraded-under-a-running-kernel-module failure that cost
#    15.8 hours of dead CUDA on 2026-07-29 with zero visible symptom.
#    See probe_driver_mismatch for the full post-mortem.
#
# Log format: JSON-per-line so `journalctl -u familiar-watchdog -p warning`
# is parseable. Each WARN line has `event=` + `service=` + `metric=` so
# alerts can be grepped without parsing prose.
#
# Exits 0 always (timer wants service-level "active") — degradation is
# signalled via WARN log entries, not exit code.

set -u

STATE_DIR="/var/lib/familiar-watchdog"
STATE_FILE="$STATE_DIR/state"
mkdir -p "$STATE_DIR"
[ -e "$STATE_FILE" ] || touch "$STATE_FILE"

# Optional ntfy paging — loads NTFY_TOPIC if /etc/familiar-watchdog/ntfy.env
# exists. Missing file is fine; notify_ntfy is then a no-op.
NTFY_TOPIC=""
[ -r /etc/familiar-watchdog/ntfy.env ] && . /etc/familiar-watchdog/ntfy.env

# notify_ntfy — POST a single WARN line to ntfy.sh. Backgrounded so a slow
# ntfy.sh doesn't delay the watchdog. Topic name acts as auth (length
# tuned at install time). Silently no-ops if topic is unset.
notify_ntfy() {
    local msg="$1"
    [ -z "${NTFY_TOPIC:-}" ] && return
    local event
    event=$(echo "$msg" | grep -oE '"event":"[^"]*"' | head -1 | cut -d'"' -f4)
    local title="familiar-watchdog: ${event:-warn}"
    curl -sS --max-time 5 \
        -H "Title: ${title}" \
        -H "Priority: high" \
        -H "Tags: shield,warning" \
        -d "${msg}" \
        "https://ntfy.sh/${NTFY_TOPIC}" >/dev/null 2>&1 &
}

log_warn()  {
    local msg="{\"level\":\"warn\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",$1}"
    echo "$msg"
    notify_ntfy "$msg"
}
log_info()  { echo "{\"level\":\"info\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",$1}"; }

# Read a key=value from state. Empty if missing.
state_get() { grep "^$1=" "$STATE_FILE" 2>/dev/null | cut -d= -f2- | tail -1; }
state_set() {
    local key="$1"; local val="$2"
    grep -v "^$key=" "$STATE_FILE" 2>/dev/null > "$STATE_FILE.new" || true
    echo "$key=$val" >> "$STATE_FILE.new"
    mv "$STATE_FILE.new" "$STATE_FILE"
}

# ── 1. Functional /health probe ───────────────────────────────────────
probe_health() {
    # ── Gate: don't page for a service that is off ON PURPOSE ──────────
    #
    # 2026-07-29: this probe fired 117 high-priority ntfy pages in 24h — one
    # every ~12 min — every single one a `curl (7) … port 8080` because
    # familiar-api is an on-demand companion that is deliberately down most of
    # the time. That volume is not an alarm, it is a habit: it trained the
    # channel to be ignored, and it would have buried the nvidia_driver_mismatch
    # page that probe_driver_mismatch now emits (see #4 below). An off-by-design
    # service is not a degradation.
    #
    # Deliberately NOT a blanket `is-active || return` — that would create a
    # blind spot of exactly the kind this watchdog exists to catch. The states
    # are triaged instead:
    #   active                  -> probe it (a live API that won't answer is a
    #                              real failure and must still page)
    #   failed                  -> PAGE. The unit tried and died; that is never
    #                              intentional, and staying silent here would be
    #                              worse than the storm we're fixing.
    #   inactive                -> silent. JP's on-demand default.
    #   activating/deactivating -> silent. Transient; don't page mid-boot or
    #                              mid-deploy (the timer fires OnBootSec=60).
    #
    # State transitions are recorded with log_info, which does NOT call
    # notify_ntfy — so the journal keeps full forensics on when the companion
    # came up or went down, at zero paging cost.
    local api_state prev_state
    api_state=$(systemctl is-active familiar-api.service 2>/dev/null || true)
    [ -z "$api_state" ] && api_state="unknown"
    prev_state=$(state_get familiar_api_state)
    [ "$api_state" != "$prev_state" ] && \
        log_info "\"event\":\"api_state_change\",\"service\":\"familiar-api\",\"from\":\"${prev_state:-none}\",\"to\":\"$api_state\""
    state_set familiar_api_state "$api_state"

    case "$api_state" in
        active) ;;   # fall through to the real probe
        failed)
            log_warn "\"event\":\"api_failed\",\"service\":\"familiar-api\",\"metric\":\"unit_state\",\"error\":\"unit is in failed state — health probe skipped; check journalctl -u familiar-api\""
            return ;;
        *)
            # inactive / activating / deactivating / reloading / unknown.
            return ;;
    esac

    local resp http
    resp=$(curl -sS --max-time 15 http://127.0.0.1:8080/api/familiar/health 2>&1)
    http=$?
    if [ $http -ne 0 ]; then
        log_warn "\"event\":\"health_unreachable\",\"curl_exit\":$http,\"error\":\"$(echo "$resp" | head -c 200 | tr '"' "'")\""
        return
    fi
    # Capture python output so WARN lines can also notify_ntfy. Without
    # the capture, the python heredoc prints directly to stdout/journal
    # but bypasses the bash-side ntfy hook.
    local py_output
    py_output=$(python3 -c "
import json, sys
try:
    d = json.loads('''$resp''')
except Exception as e:
    print(f'{{\"level\":\"warn\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"health_parse_fail\",\"error\":\"{e}\"}}')
    sys.exit(0)
import datetime
ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
deps = d.get('dependencies', {})
breakers = d.get('circuit_breakers', {})
for k, v in deps.items():
    status = v.get('status')
    if status != 'ok':
        print(f'{{\"level\":\"warn\",\"ts\":\"{ts}\",\"event\":\"dep_degraded\",\"service\":\"{k}\",\"status\":\"{status}\",\"error\":\"{v.get(\"error\",\"\")[:200]}\"}}')
    cq = v.get('chat_quality')
    if cq and cq != 'ok':
        print(f'{{\"level\":\"warn\",\"ts\":\"{ts}\",\"event\":\"chat_probe_fail\",\"service\":\"{k}\",\"quality\":\"{cq}\",\"warning\":\"{v.get(\"chat_warning\",\"\")[:200]}\"}}')
    eq = v.get('embed_quality')
    if eq and eq != 'ok':
        print(f'{{\"level\":\"warn\",\"ts\":\"{ts}\",\"event\":\"embed_probe_fail\",\"service\":\"{k}\",\"quality\":\"{eq}\",\"warning\":\"{v.get(\"embed_warning\",\"\")[:200]}\"}}')
    rq = v.get('recall_quality')
    if rq and rq != 'ok':
        print(f'{{\"level\":\"warn\",\"ts\":\"{ts}\",\"event\":\"recall_probe_fail\",\"service\":\"{k}\",\"quality\":\"{rq}\",\"warning\":\"{v.get(\"recall_warning\",\"\")[:200]}\"}}')
for k, s in breakers.items():
    if s != 'closed':
        print(f'{{\"level\":\"warn\",\"ts\":\"{ts}\",\"event\":\"breaker_open\",\"service\":\"{k}\",\"state\":\"{s}\"}}')
")
    [ -z "$py_output" ] && return
    echo "$py_output"
    # Echo each WARN line into notify_ntfy. The python heredoc only emits
    # JSON-per-line, so a plain grep on level=warn picks up all real alerts.
    echo "$py_output" | while IFS= read -r line; do
        case "$line" in
            *'"level":"warn"'*) notify_ntfy "$line" ;;
        esac
    done
}

# ── 2. Restart-counter watch ──────────────────────────────────────────
#
# Today's palace-daemon kill cascade: 97 restarts in ~30 min, but
# `systemctl is-active` said "active" the whole time because the
# service restarted within 5s of each kill. The lead indicator is
# the n-times-restarted-since-boot counter, accessible via
# `systemctl show -p NRestarts`. Compare to last-observed value; warn
# on growth past threshold.
probe_restart_counter() {
    local service="$1"
    local now
    now=$(systemctl show -p NRestarts "$service" --value 2>/dev/null)
    if ! [[ "$now" =~ ^[0-9]+$ ]]; then
        # Service doesn't exist or systemctl unhappy — log info, don't warn
        # (no point flooding the journal when a service is simply absent).
        return
    fi
    local prev
    prev=$(state_get "nrestarts_${service//[^a-zA-Z0-9]/_}")
    if [ -z "$prev" ]; then
        # First run after install — establish baseline silently.
        state_set "nrestarts_${service//[^a-zA-Z0-9]/_}" "$now"
        return
    fi
    local delta=$((now - prev))
    # Threshold: > 3 restarts within a single 5-min window is unusual
    # for a steady-state service. Today's cascade would have tripped this
    # on the first sample.
    if [ "$delta" -gt 3 ]; then
        log_warn "\"event\":\"restart_cascade\",\"service\":\"$service\",\"restarts_since_last_check\":$delta,\"total_restarts\":$now"
    fi
    state_set "nrestarts_${service//[^a-zA-Z0-9]/_}" "$now"
}

# ── 4. NVIDIA driver-stack coherence ─────────────────────────────────
#
# POST-MORTEM 2026-07-29: familiar served for 15.8 hours with a dead CUDA
# stack and nothing noticed. unattended-upgrades installed nvidia
# 580.173.02 at 07:03 while the loaded kernel module stayed on
# 580.159.03. `nvidia-smi` failed outright and `llama-server
# --list-devices` returned an empty list, so nothing new could be loaded
# onto a GPU — but ollama-embed had started *before* the upgrade and kept
# serving happily off the deleted-but-still-open .so inodes. Every
# is-active check stayed green, /health stayed green, and the only real
# fix was a reboot. Nothing in this watchdog looked at the GPU stack.
#
# Three independent signals, cheapest first. They are deliberately
# separate events so a page tells you which stage broke:
#   a) driver_mismatch — loaded kernel module version vs the userspace
#      libnvidia-ml the dynamic loader would actually resolve. This is
#      the root cause and is detectable within 5 min of the upgrade
#      landing, long before anyone notices a symptom.
#   b) smi_fail / gpu_count_low — the direct symptom: can we still talk
#      to the cards at all, and are both P102s present.
#   c) libs_deleted — inference servers still mapping unlinked nvidia
#      .so files. These keep working but CANNOT restart cleanly; this is
#      the "running on borrowed time" signal that made (a) invisible.
#
# Cadence note: (a) and (b) re-fire every run while broken, matching the
# existing dep_degraded convention — a dead GPU stack deserves to keep
# paging. (c) is damped to fire only when the stale-pid set *changes*,
# because it stays true until the services are restarted and would
# otherwise nag every 5 min about a known-and-accepted state.
probe_driver_mismatch() {
    # ── (a) kernel module vs userspace library ──
    if [ ! -r /proc/driver/nvidia/version ]; then
        log_warn "\"event\":\"nvidia_module_absent\",\"metric\":\"driver_version\",\"error\":\"/proc/driver/nvidia/version unreadable — kernel module not loaded\""
        return
    fi
    local proc_ver user_ver lib_path
    proc_ver=$(sed -nE 's/.*Kernel Module +([0-9][0-9.]*).*/\1/p' /proc/driver/nvidia/version | head -1)

    # Resolve what the loader would actually pick for libnvidia-ml.so.1.
    # ldconfig is authoritative (honours any custom search path); fall back
    # to the multiarch dir if the cache is stale or ldconfig is absent.
    lib_path=$(ldconfig -p 2>/dev/null | awk '/libnvidia-ml\.so\.1 /{print $NF; exit}')
    [ -n "${lib_path:-}" ] && [ -e "$lib_path" ] || lib_path=/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1
    user_ver=""
    [ -e "$lib_path" ] && user_ver=$(basename "$(readlink -f "$lib_path")" \
        | sed -nE 's/^libnvidia-ml\.so\.([0-9][0-9.]*)$/\1/p')

    if [ -z "$proc_ver" ] || [ -z "$user_ver" ]; then
        log_warn "\"event\":\"nvidia_version_unreadable\",\"metric\":\"driver_version\",\"kernel_module\":\"${proc_ver:-unknown}\",\"userspace_lib\":\"${user_ver:-unknown}\",\"lib_path\":\"${lib_path:-none}\""
    elif [ "$proc_ver" != "$user_ver" ]; then
        log_warn "\"event\":\"nvidia_driver_mismatch\",\"metric\":\"driver_version\",\"kernel_module\":\"$proc_ver\",\"userspace_lib\":\"$user_ver\",\"error\":\"nvidia userspace was upgraded under the running kernel module — CUDA cannot initialise until this host reboots\""
    fi

    # ── (b) can we actually reach the GPUs? ──
    local smi_out smi_rc gpus
    smi_out=$(nvidia-smi --query-gpu=index,driver_version --format=csv,noheader 2>&1)
    smi_rc=$?
    if [ "$smi_rc" -ne 0 ]; then
        log_warn "\"event\":\"nvidia_smi_fail\",\"metric\":\"gpu_reachable\",\"exit\":$smi_rc,\"error\":\"$(echo "$smi_out" | head -c 200 | tr '"' "'" | tr '\n' ' ')\""
    else
        gpus=$(echo "$smi_out" | grep -c .)
        # familiar is a 2×P102 box (GTX 970 pulled 2026-06-09). Fewer visible
        # cards than expected means one fell off the bus or CUDA init is
        # half-broken. Override via FA_EXPECTED_GPUS if the hardware changes.
        if [ "$gpus" -lt "${FA_EXPECTED_GPUS:-2}" ]; then
            log_warn "\"event\":\"nvidia_gpu_count_low\",\"metric\":\"gpu_count\",\"found\":$gpus,\"expected\":${FA_EXPECTED_GPUS:-2}"
        fi
    fi

    # ── (c) inference servers mapping deleted nvidia libs ──
    # Watchdog runs as User=jp and llama-server runs as jp, so /proc/<pid>/maps
    # is readable for exactly the set we care about. Other users' pids fail
    # the read and are skipped silently.
    local stale_pids="" p prev_stale
    for p in $(pgrep -u "$(id -u)" -f 'llama-server|ollama' 2>/dev/null); do
        if grep -aE 'libnvidia|libcuda' "/proc/$p/maps" 2>/dev/null | grep -q '(deleted)'; then
            stale_pids="${stale_pids:+$stale_pids,}$p"
        fi
    done
    prev_stale=$(state_get nvidia_stale_pids)
    if [ -n "$stale_pids" ] && [ "$stale_pids" != "$prev_stale" ]; then
        log_warn "\"event\":\"nvidia_libs_deleted\",\"metric\":\"stale_maps\",\"pids\":\"$stale_pids\",\"error\":\"nvidia userspace changed on disk since these started — they still work but will FAIL to restart; restart them during the next maintenance window\""
    fi
    state_set nvidia_stale_pids "$stale_pids"
}

# --test fires a synthetic WARN through the notify path and exits.
# Used to verify ntfy wiring end-to-end without faking a real failure.
if [ "${1:-}" = "--test" ]; then
    log_warn "\"event\":\"test_alert\",\"message\":\"Manual --test invocation. If your phone got this, ntfy is wired up.\""
    # Give backgrounded notify_ntfy curl time to complete before exit.
    wait
    exit 0
fi

# Run all probes. Each is independent so one failure doesn't block the
# others.
probe_health
for s in ollama-chat ollama-embed familiar-api qwen3-coder; do
    probe_restart_counter "$s"
done
probe_driver_mismatch

# Wait for any backgrounded notify_ntfy curls to finish so systemd's
# Type=oneshot doesn't kill them mid-flight.
wait

exit 0
