#!/bin/bash
# Unlock Vaultwarden via a Ghostty window, capture the BW_SESSION key.
#
# Ghostty window runs `bw unlock --raw`, writes the session key to a
# file, then touches a done-marker. Controller polls for the marker.
#
# Usage:
#   eval "$(./ops/scripts/unlock-vault.sh)"
#   bw get password 'some-item'
#
# Or just run it and source the output manually:
#   ./ops/scripts/unlock-vault.sh
set -euo pipefail

SESSION_FILE="${BW_SESSION_FILE:-/tmp/bw-session}"
DONE_FILE="${SESSION_FILE}.done"
BW="${BW_BIN:-/home/jp/.npm-global/bin/bw}"
TIMEOUT_SECS="${UNLOCK_TIMEOUT:-120}"

# If vault is already unlocked in this shell, short-circuit
if [ -n "${BW_SESSION:-}" ] && $BW status 2>/dev/null | grep -q '"status":"unlocked"'; then
    echo "export BW_SESSION=\"${BW_SESSION}\""
    exit 0
fi

rm -f "$SESSION_FILE" "$DONE_FILE"

# Launch Ghostty; master password prompt is written to /dev/tty regardless
# of the --raw stdout redirect, so the user sees it.
ghostty -e bash -c "
    echo '=== Vault unlock ==='
    echo 'Enter your master password below.'
    echo
    if $BW unlock --raw > '$SESSION_FILE' 2>/dev/null; then
        touch '$DONE_FILE'
        echo
        echo 'Unlocked. Closing in 2s.'
    else
        echo 'FAIL' > '$DONE_FILE'
        echo
        echo 'Unlock failed. Closing in 5s.'
        sleep 3
    fi
    sleep 2
" >/dev/null 2>&1 &
disown

# Poll for done-marker
for _ in $(seq 1 "$TIMEOUT_SECS"); do
    if [ -f "$DONE_FILE" ]; then
        if grep -qx FAIL "$DONE_FILE" 2>/dev/null; then
            echo "unlock failed" >&2
            exit 1
        fi
        if [ -s "$SESSION_FILE" ]; then
            key="$(cat "$SESSION_FILE")"
            echo "export BW_SESSION=\"$key\""
            exit 0
        fi
        echo "unlock marker present but session file empty" >&2
        exit 1
    fi
    sleep 1
done

echo "timeout after ${TIMEOUT_SECS}s waiting for unlock" >&2
exit 1
