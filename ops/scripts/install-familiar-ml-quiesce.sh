#!/usr/bin/env bash
# install-familiar-ml-quiesce.sh — install the pre-sleep quiesce hook on familiar.
#
# Run from the local repo root. Installs the systemd-sleep hook that makes S3
# actually hold on this host (see ops/familiar/familiar-ml-quiesce for the two
# root causes and their measurements), plus the credentials it needs to tell
# Home Assistant to stand down while the host is asleep.
#
# Idempotent — safe to re-run after script edits to refresh the install.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${FAMILIAR_HOST:-familiar}"
HA_URL="${HA_URL:-https://ha.jphe.in:8123}"
HA_VAULT_ITEM="${HA_VAULT_ITEM:-ha-llat}"

echo ">>> Installing familiar-ml-quiesce on ${HOST}..."

# The hook lives in /usr/lib/systemd/system-sleep/ to sit alongside the existing
# familiar-autosuspend-resume hook. systemd runs every executable in there for
# both `pre` and `post`; ordering is by filename, which puts us ahead of the
# `nvidia` hook — deliberate, so the CUDA lane is already stopped before it runs.
scp "${REPO_ROOT}/ops/familiar/familiar-ml-quiesce" "${HOST}:/tmp/familiar-ml-quiesce"
ssh "${HOST}" "sudo install -o root -g root -m 0755 /tmp/familiar-ml-quiesce \
    /usr/lib/systemd/system-sleep/familiar-ml-quiesce && rm /tmp/familiar-ml-quiesce"

# The quiesce wrapper + the HA hold switch. These live in /usr/local/sbin (not
# in the sleep-hook dir) precisely because they must run OUTSIDE the sleep
# transaction — see the header of familiar-sleep-now for the measurements.
for s in familiar-ha-hold familiar-sleep-now; do
    scp "${REPO_ROOT}/ops/familiar/${s}" "${HOST}:/tmp/${s}"
    ssh "${HOST}" "sudo install -o root -g root -m 0755 /tmp/${s} /usr/local/sbin/${s} && rm /tmp/${s}"
done

# Credentials for the HA sleep hold. Never echoed, never committed — piped from
# Vaultwarden straight into a root-only file, per CLAUDE.md.
echo ">>> Installing HA credentials (from vault item '${HA_VAULT_ITEM}')..."
if ! bw get password "${HA_VAULT_ITEM}" >/dev/null 2>&1; then
    echo "!!! Could not read '${HA_VAULT_ITEM}' from Vaultwarden (locked?)." >&2
    echo "!!! The hook still installs and still fixes the OOM half; it will log" >&2
    echo "!!! 'no /etc/familiar/ha-token — skipping HA hold' until this is set." >&2
else
    ssh "${HOST}" "sudo mkdir -p /etc/familiar"
    bw get password "${HA_VAULT_ITEM}" \
        | ssh "${HOST}" "sudo tee /etc/familiar/ha-token >/dev/null \
            && sudo chown root:root /etc/familiar/ha-token \
            && sudo chmod 0600 /etc/familiar/ha-token"
    echo "${HA_URL}" \
        | ssh "${HOST}" "sudo tee /etc/familiar/ha-url >/dev/null \
            && sudo chmod 0644 /etc/familiar/ha-url"
    echo ">>> Token installed (mode 0600, root-only)."
fi

echo ">>> Verifying install..."
ssh "${HOST}" "ls -l /usr/lib/systemd/system-sleep/familiar-ml-quiesce; \
    sudo ls -l /etc/familiar/ 2>/dev/null || echo '(no /etc/familiar — HA hold disabled)'"

echo ">>> Checking the hook can reach Home Assistant..."
ssh "${HOST}" "sudo bash -c '
    [ -r /etc/familiar/ha-token ] || { echo \"skip: no token\"; exit 0; }
    code=\$(curl -s -o /dev/null -w \"%{http_code}\" -m 8 \
        -H \"Authorization: Bearer \$(cat /etc/familiar/ha-token)\" \
        \"\$(cat /etc/familiar/ha-url)/api/\")
    echo \"HA API: HTTP \$code (200 = token good, 401 = token rejected)\"
'"

# --------------------------------------------------------------------------
# katana side — teach mempalace's auto_wake to respect the same hold.
#
# HA is not the only thing that wakes familiar. mempalace auto_wake fires
# `realm wol wake familiar` whenever a palace query finds the daemon down, and
# on 2026-08-15 that single packet ended a deliberate sleep 245 ms later. The
# wrapper checks the same HA boolean before waking.
# --------------------------------------------------------------------------
echo ">>> Wiring the katana-side wake guard..."
install -D -m 0755 "${REPO_ROOT}/ops/scripts/familiar-wake-unless-held" \
    "${HOME}/.local/bin/familiar-wake-unless-held"

if bw get password "${HA_VAULT_ITEM}" >/dev/null 2>&1; then
    install -d -m 0700 "${HOME}/.config/familiar"
    bw get password "${HA_VAULT_ITEM}" > "${HOME}/.config/familiar/ha-token"
    chmod 0600 "${HOME}/.config/familiar/ha-token"
    echo ">>> katana token installed (mode 0600)."
else
    echo "!!! No vault access — the wrapper will fail OPEN (wake anyway) and say so." >&2
fi

MEMPALACE_CFG="${HOME}/.mempalace/config.json"
if [ -f "${MEMPALACE_CFG}" ] && command -v jq >/dev/null 2>&1; then
    current=$(jq -r '.auto_wake.command // ""' "${MEMPALACE_CFG}")
    if [ "${current}" = "realm wol wake familiar" ]; then
        cp "${MEMPALACE_CFG}" "${MEMPALACE_CFG}.bak-$(date +%Y%m%d-%H%M%S)"
        jq --arg cmd "${HOME}/.local/bin/familiar-wake-unless-held" \
            '.auto_wake.command = $cmd' "${MEMPALACE_CFG}" > "${MEMPALACE_CFG}.tmp"
        mv "${MEMPALACE_CFG}.tmp" "${MEMPALACE_CFG}"
        echo ">>> mempalace auto_wake rewired (backup alongside the config)."
    else
        echo ">>> mempalace auto_wake already customised ('${current}') — left alone."
    fi
else
    echo ">>> No mempalace config (or no jq) — skipped auto_wake rewiring."
fi

echo
echo ">>> Done. The hook runs on every suspend/resume."
echo ">>> Watch it work:  ssh ${HOST} 'journalctl -t familiar-ml-quiesce -n 20'"
echo ">>> or:             ssh ${HOST} 'journalctl -u systemd-suspend -n 40'"
