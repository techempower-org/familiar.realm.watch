#!/usr/bin/env bash
# install-familiar-watchdog.sh — install the on-host watchdog (#38).
#
# Run from local repo root. Copies the script + service + timer to the
# familiar host and enables the timer.
#
# Idempotent — safe to re-run after script edits to refresh the install.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${FAMILIAR_HOST:-familiar}"

echo ">>> Installing familiar-watchdog on ${HOST}..."

# Copy the watchdog script to /usr/local/sbin (writable only by root,
# executable by anyone — matches the service's User=jp).
scp "${REPO_ROOT}/ops/familiar/familiar-watchdog.sh" "${HOST}:/tmp/familiar-watchdog.sh"
ssh "${HOST}" "sudo install -o root -g root -m 0755 /tmp/familiar-watchdog.sh /usr/local/sbin/familiar-watchdog.sh && rm /tmp/familiar-watchdog.sh"

# Copy the service + timer units.
scp "${REPO_ROOT}/ops/familiar/familiar-watchdog.service" "${HOST}:/tmp/familiar-watchdog.service"
scp "${REPO_ROOT}/ops/familiar/familiar-watchdog.timer" "${HOST}:/tmp/familiar-watchdog.timer"
ssh "${HOST}" "
    sudo install -o root -g root -m 0644 /tmp/familiar-watchdog.service /etc/systemd/system/familiar-watchdog.service
    sudo install -o root -g root -m 0644 /tmp/familiar-watchdog.timer /etc/systemd/system/familiar-watchdog.timer
    rm /tmp/familiar-watchdog.service /tmp/familiar-watchdog.timer
    sudo mkdir -p /var/lib/familiar-watchdog
    sudo chown jp:jp /var/lib/familiar-watchdog
    sudo systemctl daemon-reload
    sudo systemctl enable --now familiar-watchdog.timer
"

echo ">>> Verifying timer is armed..."
ssh "${HOST}" "sudo systemctl status familiar-watchdog.timer --no-pager | head -8"

echo ">>> Running watchdog once to verify baseline + log shape..."
ssh "${HOST}" "sudo systemctl start familiar-watchdog.service"
sleep 2
ssh "${HOST}" "sudo journalctl -u familiar-watchdog -n 20 --no-pager"

echo "✓ familiar-watchdog installed."
echo "  Tail logs:   journalctl -u familiar-watchdog -f"
echo "  Warn only:   journalctl -u familiar-watchdog -p warning -f"
echo "  Disable:     sudo systemctl disable --now familiar-watchdog.timer"
