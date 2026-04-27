#!/bin/bash
# Deploy familiar-api from katana → familiar. Run LOCALLY on katana.
# Assumes: install-ollama-familiar.sh has been run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST_HOST="familiar"
DEST_ROOT="/srv/familiar"
DEST_USER="familiar"

# ---- realm-sigil banner up front so the realm name is visible without
# scrolling. Sources the canonical helper from ~/Projects/realm-sigil/.
# realm_sigil_pre prints the bold "✦ Realm Name · hash" banner using the
# same deterministic hash → name mapping the runtime /api/version uses.
# realm_sigil_git_info bakes .git_info (sigil.json equivalent) so the
# in-process readSigil() inside familiar can recover hash/branch/dirty
# after the .git-excluded rsync.
SIGIL_HELPER="${HOME}/Projects/realm-sigil/deploy-banner.sh"
if [ -r "${SIGIL_HELPER}" ]; then
  # shellcheck source=/dev/null
  . "${SIGIL_HELPER}"
  realm_sigil_git_info "${REPO_ROOT}/.git_info"
  realm_sigil_pre "fantasy" "${REPO_ROOT}/.git_info"
  echo ""
else
  echo "WARN: realm-sigil helper not found at ${SIGIL_HELPER}; banner skipped."
fi

# Compute HASH/BRANCH/DIRTY for the bake-into-sigil.json step below. Read
# them out of .git_info if the helper just made it; otherwise fall back to
# direct git so the bake step still works.
if [ -r "${REPO_ROOT}/.git_info" ]; then
  HASH=$(python3 -c "import json; print(json.load(open('${REPO_ROOT}/.git_info'))['hash'])")
  BRANCH=$(python3 -c "import json; print(json.load(open('${REPO_ROOT}/.git_info'))['branch'])")
  DIRTY=$(python3 -c "import json; print('true' if json.load(open('${REPO_ROOT}/.git_info'))['dirty'] else 'false')")
else
  HASH=$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null | cut -c1-12 || echo "")
  BRANCH=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  DIRTY=$([ -z "$(git -C "${REPO_ROOT}" status --porcelain 2>/dev/null)" ] && echo "false" || echo "true")
fi

echo ">>> Ensuring service user exists on ${DEST_HOST}..."
ssh "${DEST_HOST}" "id ${DEST_USER} >/dev/null 2>&1 || sudo useradd -r -m -s /bin/bash ${DEST_USER}"

echo ">>> Ensuring Bun is installed for ${DEST_USER}..."
ssh "${DEST_HOST}" "sudo -u ${DEST_USER} bash -c 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash'"

# .git_info was already baked by `realm_sigil_git_info` at the top of this
# script. realm-sigil's gitInfo() reads it on the deployed host so
# /api/version reports the correct hash/branch/dirty even though .git is
# excluded from rsync.

# Vendor realm-sigil into the deploy tree so the file: dep resolves on
# the deployed host (which has no ~/Projects/realm-sigil). package.json
# points at vendor/realm-sigil; we sync from JP's working clone here.
echo ">>> Vendoring realm-sigil into ${REPO_ROOT}/vendor/realm-sigil..."
mkdir -p "${REPO_ROOT}/vendor/realm-sigil"
rsync -a --delete \
  --exclude __tests__ --exclude '*.test.js' --exclude node_modules \
  "${HOME}/Projects/realm-sigil/js/" \
  "${REPO_ROOT}/vendor/realm-sigil/"

echo ">>> rsync source to ${DEST_HOST}:${DEST_ROOT}/..."
ssh "${DEST_HOST}" "sudo mkdir -p ${DEST_ROOT} && sudo chown ${DEST_USER}:${DEST_USER} ${DEST_ROOT}"
rsync -avP --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude '*.log' \
  -e "ssh" \
  "${REPO_ROOT}/" \
  "${DEST_HOST}:/tmp/familiar-src/"
ssh "${DEST_HOST}" "sudo rsync -a --delete --exclude .env --chown ${DEST_USER}:${DEST_USER} /tmp/familiar-src/ ${DEST_ROOT}/"

echo ">>> Installing dependencies..."
ssh "${DEST_HOST}" "sudo -u ${DEST_USER} bash -c 'cd ${DEST_ROOT} && ~/.bun/bin/bun install --production'"

echo ">>> Populating .env (only if missing — preserves operator overrides)..."
if ssh "${DEST_HOST}" "sudo test -s ${DEST_ROOT}/.env"; then
  echo "    .env already exists; leaving in place. Edit on host to change config."
else
  API_KEY="$(bw get password 'palace-daemon-v1' 2>/dev/null || true)"
  [ -n "${API_KEY}" ] || { echo "WARN: palace-daemon-v1 not in vault — .env will have empty key"; }
  ssh "${DEST_HOST}" "sudo tee ${DEST_ROOT}/.env > /dev/null <<EOF
FAMILIAR_PORT=8080
FAMILIAR_HOST=0.0.0.0
OLLAMA_CHAT_URL=http://127.0.0.1:11434
OLLAMA_EMBED_URL=http://127.0.0.1:11435
OLLAMA_CHAT_MODEL=qwen2.5:3b-instruct-q4_K_M
OLLAMA_EMBED_MODEL=nomic-embed-text:v1.5
PALACE_DAEMON_URL=http://disks:8085
PALACE_DAEMON_API_KEY=${API_KEY}
PALACE_SEARCH_TIMEOUT_MS=5000
TOKEN_BUDGET_SYSTEM=1500
TOKEN_BUDGET_CONTEXT=4000
TOKEN_BUDGET_HISTORY=2000
TOKEN_BUDGET_RESPONSE=512
RETRIEVAL_LIMIT=5
SESSION_TTL_MINUTES=60
REALM_SIGIL_REALM=fantasy
LOG_LEVEL=info
EOF"
  ssh "${DEST_HOST}" "sudo chmod 600 ${DEST_ROOT}/.env && sudo chown ${DEST_USER}:${DEST_USER} ${DEST_ROOT}/.env"
fi

echo ">>> Installing/refreshing systemd unit..."
ssh "${DEST_HOST}" "sudo cp ${DEST_ROOT}/ops/systemd/familiar-api.service /etc/systemd/system/ && sudo systemctl daemon-reload"

echo ">>> (Re)starting familiar-api..."
ssh "${DEST_HOST}" "sudo systemctl enable familiar-api.service && sudo systemctl restart familiar-api.service"
sleep 3

echo ">>> Smoke test..."
curl -s --max-time 5 http://familiar:8080/api/version | head -c 500 || { echo "FAIL: /api/version"; ssh "${DEST_HOST}" "sudo journalctl -u familiar-api -n 40"; exit 1; }
echo ""
# Health endpoint can take up to ~4s under degraded conditions (2s palace
# health probe + 2s search recall probe, both bounded by searchTimeoutMs).
# 10s leaves headroom while still failing fast on real hangs.
curl -s --max-time 10 http://familiar:8080/api/familiar/health | head -c 500 || { echo "FAIL: /api/familiar/health"; exit 1; }
echo ""
# Post-deploy banner from the canonical helper — fetches /api/version
# and renders the live realm-sigil so the operator sees the running
# sigil at the bottom of scrollback, matching what status.realm.watch
# would see on its next poll.
if declare -F realm_sigil_post >/dev/null 2>&1; then
  realm_sigil_post "http://familiar:8080/api/version"
fi
echo ""
echo ">>> Deploy done."
