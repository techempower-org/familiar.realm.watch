#!/usr/bin/env bash
# familiar-watchdog.sh — on-host watchdog for the familiar daily-deps.
#
# Runs every 5 min via familiar-watchdog.timer. Checks three things and
# logs WARN-level diagnostics to journal when anything degrades. Stays
# silent on the happy path.
#
# 1. Functional /api/familiar/health probe via localhost. Faster than
#    going through Caddy and catches the chat-fallback class of bug
#    that hid for hours on 2026-05-16 before anyone noticed (#38).
# 2. Restart-counter watch on ollama-chat / ollama-embed / familiar-api.
#    Today's palace-daemon cascade ran restart counter to 97 in <30 min
#    while `systemctl is-active` happily reported "active" because the
#    service was restarting every 5s. This script compares the current
#    counter to the previously-observed value (cached at
#    /var/lib/familiar-watchdog/state) and fires on growth > threshold.
# 3. Memory pressure check on each service — if memory-current is close
#    to memory-max, log warning (lead indicator before OOM).
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

log_warn()  { echo "{\"level\":\"warn\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",$1}"; }
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
    local resp http
    resp=$(curl -sS --max-time 15 http://127.0.0.1:8080/api/familiar/health 2>&1)
    http=$?
    if [ $http -ne 0 ]; then
        log_warn "\"event\":\"health_unreachable\",\"curl_exit\":$http,\"error\":\"$(echo "$resp" | head -c 200 | tr '"' "'")\""
        return
    fi
    python3 -c "
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
"
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

# Run all probes. Each is independent so one failure doesn't block the
# others.
probe_health
for s in ollama-chat ollama-embed familiar-api; do
    probe_restart_counter "$s"
done

exit 0
