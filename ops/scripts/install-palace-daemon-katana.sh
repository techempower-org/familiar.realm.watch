#!/bin/bash
# Install palace-daemon on katana with our jphein fork as the mempalace library.
# Run LOCALLY on katana.
#
# palace-daemon clone source defaults to our fork (techempower-org) — we
# carry fork-only fixes that haven't reached upstream rboarescu yet
# (hook detach, postgres backend gates, /cypher + /embed endpoints,
# /search/keyword + /search/hybrid). Override PALACE_DAEMON_REMOTE if you
# want to test against upstream.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$HOME/Projects/palace-daemon"
FORK_PATH="$HOME/Projects/memorypalace"
PALACE_PATH="$HOME/Projects/mempalace-data/palace"
PALACE_DAEMON_REMOTE="${PALACE_DAEMON_REMOTE:-https://github.com/techempower-org/palace-daemon.git}"

echo ">>> Sanity checks..."
[ -d "${FORK_PATH}" ] || { echo "FAIL: jphein fork not at ${FORK_PATH}"; exit 1; }
[ -d "${PALACE_PATH}" ] || { echo "FAIL: palace data not at ${PALACE_PATH}"; exit 1; }

echo ">>> Cloning palace-daemon to ${DEST} (from ${PALACE_DAEMON_REMOTE})..."
if [ -d "${DEST}" ]; then
    echo "    already exists — pulling latest"
    cd "${DEST}" && git pull --rebase
else
    git clone "${PALACE_DAEMON_REMOTE}" "${DEST}"
fi

cd "${DEST}"

echo ">>> Creating venv..."
python3 -m venv venv
source venv/bin/activate

echo ">>> Installing palace-daemon deps..."
pip install --upgrade pip
pip install "fastapi>=0.136.0" "uvicorn[standard]>=0.44.0"
pip install -e "${FORK_PATH}"

echo ">>> Verifying mempalace install points at the fork..."
python -c "import mempalace; import pathlib; p = pathlib.Path(mempalace.__file__).parent; print(p); assert 'memorypalace' in str(p), 'mempalace not from fork'"

echo ">>> Generating API key and writing env file..."
mkdir -p "$HOME/.config/palace-daemon"
if ! bw status 2>/dev/null | grep -q unlocked; then
    echo "!!! Vault is locked. Unlock with: bw unlock"
    exit 1
fi
API_KEY="$(bw get password 'palace-daemon-v1' 2>/dev/null || true)"
if [ -z "${API_KEY}" ]; then
    API_KEY="$(openssl rand -hex 32)"
    echo "    generated new API key; storing in vault as 'palace-daemon-v1'"
    echo "{\"type\":1,\"name\":\"palace-daemon-v1\",\"login\":{\"password\":\"${API_KEY}\"}}" | bw encode | bw create item
fi
echo "PALACE_API_KEY=${API_KEY}" > "$HOME/.config/palace-daemon/env"
chmod 600 "$HOME/.config/palace-daemon/env"

echo ">>> Installing systemd-user unit..."
mkdir -p "$HOME/.config/systemd/user"
install -m 644 "${REPO_ROOT}/ops/palace-daemon/palace-daemon.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now palace-daemon.service

sleep 3

echo ">>> Verifying palace-daemon is live..."
curl -s http://localhost:8085/health -H "X-Api-Key: ${API_KEY}" | head -c 500
echo ""
echo ">>> Stats:"
curl -s http://localhost:8085/stats -H "X-Api-Key: ${API_KEY}" | head -c 500
echo ""
echo ">>> palace-daemon is up. API key is in vault as 'palace-daemon-v1'."
