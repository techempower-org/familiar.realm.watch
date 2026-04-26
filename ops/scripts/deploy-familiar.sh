#!/bin/bash
# Deploy familiar-api from katana → familiar. Run LOCALLY on katana.
# Assumes: install-ollama-familiar.sh has been run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST_HOST="familiar"
DEST_ROOT="/srv/familiar"
DEST_USER="familiar"

echo ">>> Ensuring service user exists on ${DEST_HOST}..."
ssh "${DEST_HOST}" "id ${DEST_USER} >/dev/null 2>&1 || sudo useradd -r -m -s /bin/bash ${DEST_USER}"

echo ">>> Ensuring Bun is installed for ${DEST_USER}..."
ssh "${DEST_HOST}" "sudo -u ${DEST_USER} bash -c 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash'"

echo ">>> rsync source to ${DEST_HOST}:${DEST_ROOT}/..."
ssh "${DEST_HOST}" "sudo mkdir -p ${DEST_ROOT} && sudo chown ${DEST_USER}:${DEST_USER} ${DEST_ROOT}"
rsync -avP --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude '*.log' \
  -e "ssh" \
  "${REPO_ROOT}/" \
  "${DEST_HOST}:/tmp/familiar-src/"
ssh "${DEST_HOST}" "sudo rsync -a --delete --chown ${DEST_USER}:${DEST_USER} /tmp/familiar-src/ ${DEST_ROOT}/"

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
PALACE_SEARCH_TIMEOUT_MS=2000
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
curl -s --max-time 5 http://familiar:8080/api/familiar/health | head -c 500 || { echo "FAIL: /api/familiar/health"; exit 1; }
echo ""
echo ">>> Deploy done."
