#!/bin/bash
#
# familiar-slotctl — sudoers-scoped systemctl wrapper for the slot picker.
#
# Installed at /usr/local/sbin/familiar-slotctl, mode 0755, root-owned.
# Granted to the `familiar` user via a single sudoers line:
#
#   familiar ALL=(root) NOPASSWD: /usr/local/sbin/familiar-slotctl
#
# This wrapper is the ONLY path by which the unprivileged familiar-api
# process can affect systemd state. The privilege grant is narrowed to
# this wrapper alone, and the wrapper itself narrows further:
#
#   1. Only five operations: start, stop, restart, is-active, status.
#   2. Unit name must match ^[a-z0-9-]+\.service$ (no path traversal).
#   3. Unit name must appear in /var/lib/familiar/allowed-units.txt
#      (one line per unit, # comments allowed). This file is ops-owned
#      and regenerated alongside /var/lib/familiar/registry.json.
#
# Auditable: every invocation lands in journalctl -u sudo automatically.

set -euo pipefail

ALLOWED_UNITS_FILE="${FAMILIAR_ALLOWED_UNITS:-/var/lib/familiar/allowed-units.txt}"
UNIT_REGEX='^[a-z0-9-]+\.service$'

err() {
    echo "familiar-slotctl: $*" >&2
    exit 2
}

# Args: <action> <unit-name>
if [[ $# -ne 2 ]]; then
    err "usage: $0 <start|stop|restart|is-active|status> <unit.service>"
fi

action="$1"
unit="$2"

case "$action" in
    start|stop|restart|is-active|status) : ;;
    *) err "invalid action: $action (allowed: start, stop, restart, is-active, status)" ;;
esac

if ! [[ "$unit" =~ $UNIT_REGEX ]]; then
    err "invalid unit name: $unit (must match $UNIT_REGEX)"
fi

if [[ ! -r "$ALLOWED_UNITS_FILE" ]]; then
    err "allow-list not readable: $ALLOWED_UNITS_FILE"
fi

# Match the unit against the allow-list, stripping comments + whitespace.
if ! grep -E '^[a-z0-9-]+\.service$' "$ALLOWED_UNITS_FILE" \
        | grep -Fxq "$unit"; then
    err "unit not on allow-list: $unit (see $ALLOWED_UNITS_FILE)"
fi

# Hand off to systemctl. is-active / status are read-only and shouldn't
# error out the wrapper just because the unit is inactive — that's a
# meaningful answer the caller wants. start/stop/restart propagate
# systemctl's exit code so the caller can detect failures.
case "$action" in
    is-active|status)
        # systemctl is-active returns non-zero when unit is inactive;
        # that's a real signal, not an error. Print and pass through.
        exec systemctl "$action" "$unit" || true
        ;;
    *)
        exec systemctl "$action" "$unit"
        ;;
esac
