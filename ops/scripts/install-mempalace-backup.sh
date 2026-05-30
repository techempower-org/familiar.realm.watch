#!/usr/bin/env bash
# install-mempalace-backup.sh — install the nightly mempalace pg_dump (#87).
#
# Run from the local repo root. Copies the dump script + service + timer to the
# familiar host and arms the nightly timer. Mirrors install-familiar-watchdog.sh.
#
# Idempotent — safe to re-run after script/unit edits to refresh the install.
#
# The dump runs as root (the unit has no User=) because it needs to stop/start
# llama-server-extractor.service and exec into the mempalace-db container.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${FAMILIAR_HOST:-familiar}"

echo ">>> Installing mempalace-backup on ${HOST}..."

# Backup script lives at /usr/local/bin (the unit's ExecStart path).
scp "${REPO_ROOT}/ops/familiar/mempalace-backup.sh" "${HOST}:/tmp/mempalace-backup.sh"
ssh "${HOST}" "sudo install -o root -g root -m 0755 /tmp/mempalace-backup.sh /usr/local/bin/mempalace-backup.sh && rm /tmp/mempalace-backup.sh"

# Service + timer units.
scp "${REPO_ROOT}/ops/familiar/mempalace-backup.service" "${HOST}:/tmp/mempalace-backup.service"
scp "${REPO_ROOT}/ops/familiar/mempalace-backup.timer" "${HOST}:/tmp/mempalace-backup.timer"
ssh "${HOST}" "
    sudo install -o root -g root -m 0644 /tmp/mempalace-backup.service /etc/systemd/system/mempalace-backup.service
    sudo install -o root -g root -m 0644 /tmp/mempalace-backup.timer /etc/systemd/system/mempalace-backup.timer
    rm /tmp/mempalace-backup.service /tmp/mempalace-backup.timer
    sudo mkdir -p /srv/backups/databases
    sudo systemctl daemon-reload
    sudo systemctl enable --now mempalace-backup.timer
"

echo ">>> Verifying timer is armed..."
ssh "${HOST}" "systemctl status mempalace-backup.timer --no-pager | head -8"
ssh "${HOST}" "systemctl list-timers mempalace-backup.timer --no-pager"

echo "✓ mempalace-backup installed."
echo "  Run now:    sudo systemctl start mempalace-backup.service"
echo "  Tail logs:  journalctl -u mempalace-backup -f"
echo "  Backups in: /srv/backups/databases/"
echo "  Disable:    sudo systemctl disable --now mempalace-backup.timer"
