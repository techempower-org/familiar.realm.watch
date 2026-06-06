#!/bin/bash
# Deploy familiar-api to a target host. Run LOCALLY on the build host
# (typically katana). Assumes: ollama is set up on the target.
#
# Usage:
#   deploy-familiar.sh                       # deploys to default host (familiar)
#   deploy-familiar.sh --host katana         # deploys to katana
#   deploy-familiar.sh --host <h> --user <u> --root <path>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST_HOST="familiar"
DEST_ROOT="/srv/familiar"
DEST_USER="familiar"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) DEST_HOST="$2"; shift 2 ;;
    --root) DEST_ROOT="$2"; shift 2 ;;
    --user) DEST_USER="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--host HOSTNAME] [--root PATH] [--user USER]"
      echo "Defaults: --host familiar --root /srv/familiar --user familiar"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo ">>> Target: ${DEST_USER}@${DEST_HOST}:${DEST_ROOT}"

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
  # Line 1 — sigil (magical name + hash); the realm word changes per commit.
  realm_sigil_pre "fantasy" "${REPO_ROOT}/.git_info"
  # Line 2 — semver from package.json. Two parallel cadences: sigil rotates
  # per commit, semver rotates per release. Both fit one row of scrollback.
  PKG_VERSION=$(grep -oP '"version":\s*"\K[^"]+' "${REPO_ROOT}/package.json" 2>/dev/null || echo "?")
  printf '  \033[2mv%s · %s\033[0m\n\n' "${PKG_VERSION}" "${REPO_ROOT##*/}"
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

# Pre-deploy gate: parse + duplicate-declaration check on web/ assets.
# Today's regression (2026-05-16) was a duplicate `function clearChildren`
# at module scope in app.js — typecheck didn't catch it, only the browser
# did. check-web.sh runs node --check on each web/*.js file (catches the
# specific SyntaxError that took out the PWA) AND scans for duplicate
# top-level declarations as a regex tripwire for the same class. Fast
# enough to run on every deploy.
echo ">>> Pre-deploy web/ parse check..."
if ! "${REPO_ROOT}/ops/scripts/check-web.sh"; then
    echo "✗ web/ assets failed parse check — aborting deploy"
    exit 1
fi

# Closes #63 — auto-bump SW cache name to the current git hash so we
# never ship a stale shell to existing browser clients. Until this
# landed, every shell-file edit needed a manual `CACHE = "...v$N+1"`
# bump in web/sw.js, and missing one (or batch-merging multiple PRs
# without re-bumping) left clients serving the cached old HTML/CSS.
#
# The bake is repo-local: we sed web/sw.js in the WORKING TREE before
# rsync. The git-tracked sw.js keeps its `familiar-shell-vNN` literal
# (so dev `bun run dev` still works); only the deployed copy is
# stamped with the per-deploy hash.
SW_CACHE_NAME="familiar-shell-${HASH:0:12}"
echo ">>> Stamping SW cache name → ${SW_CACHE_NAME}..."
sed -i.deploybak "s/^const CACHE = \"familiar-shell-[^\"]*\";/const CACHE = \"${SW_CACHE_NAME}\";/" "${REPO_ROOT}/web/sw.js"
# Will restore after rsync so the working tree returns to its baseline
# vNN literal (keeps git status clean after deploys).
trap 'mv -f "${REPO_ROOT}/web/sw.js.deploybak" "${REPO_ROOT}/web/sw.js" 2>/dev/null || true' EXIT
echo ">>> SW shell list integrity check..."
# Verify every <link rel=stylesheet> + <script src=> URL in index.html
# appears in sw.js's SHELL array. Catches the "added a new web/widgets/*
# but forgot to extend SHELL" class of bug at deploy time. Tolerant of
# /v1/* + /api/* URLs (intentionally network-only).
node "${REPO_ROOT}/ops/scripts/check-sw-shell.js" \
    "${REPO_ROOT}/web/index.html" "${REPO_ROOT}/web/sw.js" || {
    echo "✗ SW shell drift detected — aborting deploy"
    exit 1
}

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
  "${DEST_HOST}:/var/tmp/familiar-src/"
ssh "${DEST_HOST}" "sudo rsync -a --delete --exclude .env --chown ${DEST_USER}:${DEST_USER} /var/tmp/familiar-src/ ${DEST_ROOT}/"

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
# Slot picker — leave admin off until the picker UI is wired end-to-end.
# Flip to true once registry.json + allowed-units.txt are reviewed.
FAMILIAR_SLOTS_REGISTRY=/var/lib/familiar/registry.json
FAMILIAR_SLOTS_CONFIG=/var/lib/familiar/slots.json
FAMILIAR_SLOTCTL_PATH=/usr/local/sbin/familiar-slotctl
FAMILIAR_SLOTS_ADMIN=false
EOF"
  ssh "${DEST_HOST}" "sudo chmod 600 ${DEST_ROOT}/.env && sudo chown ${DEST_USER}:${DEST_USER} ${DEST_ROOT}/.env"
fi

echo ">>> Installing/refreshing systemd unit..."
ssh "${DEST_HOST}" "sudo cp ${DEST_ROOT}/ops/systemd/familiar-api.service /etc/systemd/system/ && sudo systemctl daemon-reload"

# Slot picker scaffolding — install on every deploy, but never overwrite
# the live /var/lib/familiar/registry.json or slots.json once they exist
# (those are operator-edited and must survive deploys).
echo ">>> Installing slot picker scaffolding..."
ssh "${DEST_HOST}" "
  set -e
  # Wrapper + sudoers — always refresh from source of truth.
  sudo install -m 0755 -o root -g root ${DEST_ROOT}/ops/systemd/familiar-slotctl.sh /usr/local/sbin/familiar-slotctl
  sudo install -m 0440 -o root -g root ${DEST_ROOT}/ops/systemd/familiar-slotctl.sudoers /etc/sudoers.d/familiar-slotctl
  sudo visudo -cf /etc/sudoers.d/familiar-slotctl >/dev/null

  # /var/lib/familiar must exist, owned by the service user, before
  # familiar-api boots — the resolver writes slots.json there.
  sudo mkdir -p /var/lib/familiar
  sudo chown ${DEST_USER}:${DEST_USER} /var/lib/familiar
  sudo chmod 0755 /var/lib/familiar

  # Seed registry.json + allowed-units.txt on FIRST deploy only.
  # Subsequent deploys leave the operator-edited files alone.
  for f in registry.json allowed-units.txt; do
    if ! sudo test -s /var/lib/familiar/\$f; then
      sudo install -m 0644 -o ${DEST_USER} -g ${DEST_USER} \\
        ${DEST_ROOT}/ops/systemd/\${f}.example /var/lib/familiar/\$f
      echo \"    seeded /var/lib/familiar/\$f from example\"
    else
      echo \"    /var/lib/familiar/\$f exists — leaving in place\"
    fi
  done

  # Install slot-variant unit files. These are inactive by default; the
  # admin PATCH endpoint enables/starts them on demand. We refresh on
  # every deploy because the unit definitions are part of the source of
  # truth in ops/systemd/units/.
  for u in ${DEST_ROOT}/ops/systemd/units/*.service; do
    [ -e \"\$u\" ] || continue
    sudo cp \"\$u\" /etc/systemd/system/
  done
  sudo systemctl daemon-reload
"

echo ">>> (Re)starting familiar-api..."
# familiar-api is intentionally NOT boot-enabled (2026-06-05): the companion is
# started on demand, and the slot-variant model units are gated to its lifecycle
# (PartOf= + WantedBy=familiar-api.service), so nothing model-related auto-starts
# at boot. `disable` here keeps that property from being silently re-armed on
# every deploy. We still `restart` so the deploy can smoke-test the running API;
# the restart pulls up the slot models enabled into familiar-api.wants.
ssh "${DEST_HOST}" "sudo systemctl disable familiar-api.service && sudo systemctl restart familiar-api.service"
sleep 3

echo ">>> Smoke test..."
# Poll /api/version rather than a single shot — Bun's boot + module load
# can run past the post-restart sleep, and a slow boot shouldn't false-fail
# an otherwise-good deploy. ~15s budget, then give up.
version_ok=""
for i in $(seq 1 15); do
  if curl -s --max-time 3 http://${DEST_HOST}:8080/api/version | head -c 500; then version_ok=1; break; fi
  sleep 1
done
[ -n "$version_ok" ] || { echo "FAIL: /api/version (service did not come up)"; ssh "${DEST_HOST}" "sudo journalctl -u familiar-api -n 40"; exit 1; }
echo ""
# Health does FUNCTIONAL probes now (#86): a real chat completion through
# the resolver-bound backend + a real embed call, in addition to the palace
# probes. On the P102s a grounded chat completion alone runs ~6s, so the
# whole endpoint can take 8-12s. 25s leaves headroom while still failing
# fast on a true hang. (A timeout here is NOT fatal — the service is already
# up per the version poll; health latency under load shouldn't fail a deploy.)
curl -s --max-time 25 http://${DEST_HOST}:8080/api/familiar/health | head -c 500 \
  || echo "WARN: /api/familiar/health slow/unreachable (service is up; check manually)"
echo ""
# Post-deploy banner from the canonical helper — fetches /api/version
# and renders the live realm-sigil so the operator sees the running
# sigil at the bottom of scrollback, matching what status.realm.watch
# would see on its next poll.
if declare -F realm_sigil_post >/dev/null 2>&1; then
  realm_sigil_post "http://${DEST_HOST}:8080/api/version"
fi
echo ""
echo ">>> Deploy done."
