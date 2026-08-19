#!/usr/bin/env bash
# Install familiar's idle-autosuspend (check script, resume hook, units) on the
# familiar host. Leaves the timer DISABLED — arm with `familiar-autosuspend on`.
# Spec: docs/superpowers/specs/2026-06-15-familiar-autosuspend-design.md
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
