#!/bin/bash
# Replace katana's direct plugin_mempalace_mempalace MCP with palace-daemon's
# bridge client pointing at localhost:8085. Backs up settings.json first.
set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
BACKUP="${SETTINGS}.bak-$(date +%Y%m%d-%H%M%S)"
BRIDGE_SRC="$HOME/Projects/palace-daemon/clients/mempalace-mcp.py"

[ -f "${SETTINGS}" ] || { echo "FAIL: ${SETTINGS} not found"; exit 1; }
[ -f "${BRIDGE_SRC}" ] || { echo "FAIL: bridge client not at ${BRIDGE_SRC} — run install-palace-daemon-katana.sh first"; exit 1; }

echo ">>> Backing up ${SETTINGS} → ${BACKUP}"
cp "${SETTINGS}" "${BACKUP}"

echo ">>> Fetching palace-daemon API key from vault..."
API_KEY="$(bw get password 'palace-daemon-v1')"
[ -n "${API_KEY}" ] || { echo "FAIL: palace-daemon-v1 not in vault"; exit 1; }

echo ">>> Writing new mempalace MCP config (bridge to localhost:8085)..."
jq --arg bridge "${BRIDGE_SRC}" --arg url "http://localhost:8085" --arg key "${API_KEY}" '
  .mcpServers.mempalace = {
    "command": "python3",
    "args": [$bridge],
    "env": {
      "PALACE_DAEMON_URL": $url,
      "PALACE_API_KEY": $key
    }
  }
' "${BACKUP}" > "${SETTINGS}.new"

jq '.plugins["mempalace@mempalace"] = false' "${SETTINGS}.new" > "${SETTINGS}.new2"
mv "${SETTINGS}.new2" "${SETTINGS}"
rm "${SETTINGS}.new"

echo ">>> Done. Restart Claude Code to pick up the new MCP config."
echo ">>> Backup: ${BACKUP}"
echo ">>> To revert: cp '${BACKUP}' '${SETTINGS}'"
