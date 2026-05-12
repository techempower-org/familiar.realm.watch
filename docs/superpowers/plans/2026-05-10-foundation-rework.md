# Foundation Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the palace split-brain (Stop-hook writes landing in katana's local palace while familiar-api reads from disks's palace) and migrate palace-daemon + familiar-api to system systemd units for reliability.

**Architecture:** Three layered changes. Layer 1 makes palace-daemon a system service on disks (foundation for testing the rest). Layer 2 replaces the mempalace-CLI subprocess hook with palace-daemon's HTTP-based hook.py and migrates katana's orphaned local palace data into disks's palace. Layer 3 removes the now-dead `kind` parameter, adds an end-to-end recall smoke test, mirrors the system-unit pattern to familiar-api, and reworks `deploy-familiar.sh` to be host-agnostic.

**Tech Stack:** Bun + TypeScript (familiar-api), Python stdlib (palace-daemon's hook.py), systemd units, mempalace CLI, palace-daemon HTTP API (FastAPI).

---

## Status snapshot — 2026-05-11 (now fully ticked, post-completion)

**Verified-done** (evidence in commits + on disks):

- **Step 0** — all four open questions resolved; findings in
  `~/.claude/projects/-home-jp-Projects-familiar-realm-watch/scratch/foundation-rework.notes.md`.
- **Layer 1** — palace-daemon runs as system unit on disks
  (`/etc/systemd/system/palace-daemon.service`, enabled, `User=jp`,
  port 8085 listening). User unit disabled. Verified live.
- **Layer 2A + 2B** — Stop hook on katana routes through
  palace-daemon HTTP (`~/.mempalace/hook_settings.json` →
  `http://disks:8085`). Katana's local palace
  (`~/Projects/mempalace-data/palace/chroma.sqlite3`) hasn't been
  written since 2026-05-06, confirming the swap. Re-mine fallback
  used because mempalace CLI lacks `import`.
- **Layer 3** — `kind` parameter removed (familiar.realm.watch
  commit `9797f08`); recall roundtrip smoke test landed (`ce0d7b9`);
  `deploy-familiar.sh` made host-agnostic + ollama/familiar-api
  units aligned (`d5d7bc4`); changelog populated (`137136a`).

**Discovered + fixed 2026-05-11 (post-rework operational debugging):**

- **palace-daemon hook auth bug** — hook.py never sent `X-API-Key`,
  so every save from katana 401'd while logging "daemon
  unreachable". Fixed in jphein/palace-daemon `1a843ca`.
- **mempalace mine N+1 query perf bug** — mine_convos used per-file
  `file_already_mined()` instead of the existing bulk helper;
  2000-file sweep took >1h. Fixed in jphein/mempalace `248854a` via
  new `prefetch_mined_set()` helper. Live timing: 225s bulk scan
  instead of ~70min sequential. (Side finding: only 818 of 173,357
  drawers carry `normalize_version >= 2`, so the gate marks 99.5% of
  the palace as needing re-mine — a separate dataset-level concern.)

**Open + filed as issues:**

- jphein/palace-daemon#6 — regression tests for hook.py auth/error
  classification
- jphein/palace-daemon#7 — audit other request paths for swallowed
  HTTPError → "unreachable" pattern
- jphein/palace-daemon#8 — SIGTERM/SIGINT handler for clean
  ChromaDB shutdown (root cause of the HNSW partial-flush loop —
  see "loose ends" below)
- jphein/mempalace#50 — original integrity-gate filing; commented
  with self-correction (integrity gate is fine; bug is upstream)
- jphein/mempalace#51 — `mempalace mine` CPU runaway investigation
  (perf fix above mitigates but doesn't fully resolve)
- jphein/mempalace#52 — lower `hnsw:sync_threshold` to shrink
  partial-flush corruption window

**In-flight (not yet verified)** as of 16:42 PDT:

- `/repair?mode=rebuild` against disks palace, kicked off 16:39:09.
  Rebuilds HNSW for the 173,357-drawer `mempalace_drawers`
  collection from sqlite. Defensive sqlite snapshot taken pre-rebuild
  (`/mnt/raid/projects/mempalace-data/chroma-pre-rebuild-20260511-164041.sqlite3`,
  3.0GB, 173,360 rows verified). Hook saves queue during rebuild,
  drain on completion.

**Originally-flagged loose ends — now resolved:**

- ✅ The actual durability fix — palace-daemon#8 shipped (`e714c76`,
  clean shutdown), #10 shipped (`255cace`, hnswlib import guard),
  and #11 (`938dd2f`) hardened the recursive-loop fix into the
  systemd unit. mempalace#52 closed as won't-do (sync_threshold=50000
  is intentional bloat guard).
- ✅ Post-rebuild verification — the chromadb index metadata file
  was created (1.8 MB), `data_level0.bin` is 43 MB, `link_lists.bin`
  is 218 KB (non-zero). Survives daemon restart. Hook saves succeed
  end-to-end (`Silent save OK at exchange 226` at 18:06:15).
- ✅ Plan checkboxes — now ticked. The work is genuinely done across
  all four layers + the bonus debugging that uncovered the deeper
  causes of today's outage.

**Correction to a Step 0 finding (added 2026-05-11):**

- Step 0.4 declared `PALACE_DAEMON_PATH_MAP` "dead config" on
  2026-05-10. That aged out: PR `70cbf3f` in palace-daemon
  ("feat(/mine): translate client-side paths via
  PALACE_DAEMON_PATH_MAP") landed afterward and made the env var
  load-bearing for `/mine` path translation with a full test suite
  in `tests/test_path_translation.py`. The original scratch note in
  `~/.claude/projects/-home-jp-Projects-familiar-realm-watch/scratch/`
  has been updated with the correction. **Keep the env var.**

---

## Step 0 — Open question resolution (read-only)

Before any deploys, verify the four unknowns flagged in the spec. Each is a quick read of an existing file or `--help` invocation.

### Task 0.1: Verify mempalace CLI export/import surface

**Files:**
- Read: command-line tools only, no file modifications

- [x] **Step 1: Check mempalace CLI surface**

Run on katana:
```bash
~/Projects/memorypalace/venv/bin/python -m mempalace --help 2>&1 | head -40
~/Projects/memorypalace/venv/bin/python -m mempalace export --help 2>&1 | head -20
~/Projects/memorypalace/venv/bin/python -m mempalace import --help 2>&1 | head -20
```

Expected: One of:
- `export` and `import` are real subcommands → **Migration path 1 (preferred) is available**
- Neither exists → **Migration path 3 (re-mine) is the fallback**

- [x] **Step 2: Record decision in journal**

Write the result to a scratch note so Layer 2B can branch on it:
```bash
mkdir -p /home/jp/.claude/projects/-home-jp-Projects-familiar-realm-watch/scratch/
echo "mempalace export/import exists: YES|NO" >> /home/jp/.claude/projects/-home-jp-Projects-familiar-realm-watch/scratch/foundation-rework.notes.md
```

No commit — this is investigation only.

### Task 0.2: Verify `kind` parameter status in palace-daemon

**Files:**
- Read: `/home/jp/Projects/palace-daemon/` (look at /search route)

- [x] **Step 1: Find the /search route handler**

Run:
```bash
grep -rn 'def search\|@.*search\|"/search"\|kind' /home/jp/Projects/palace-daemon/*.py 2>/dev/null | head -20
```

Expected: locate the FastAPI route handler for GET /search (likely in `main.py` or `routes/search.py`).

- [x] **Step 2: Inspect how `kind` is handled**

Open the file from Step 1 and check whether `kind` is:
- Read from the request and used for filtering → still active
- Read but ignored → dead but accepted (safe to remove from client)
- Not read at all → dead and rejected (must remove from client; might be causing 4xx)

Record the finding in the scratch journal.

No commit.

### Task 0.3: Read hook.py to understand the cadence trigger

**Files:**
- Read: `/home/jp/Projects/palace-daemon/clients/hook.py`

- [x] **Step 1: Find the "every N exchanges" logic**

Run:
```bash
grep -nE 'exchange|messages|interval|threshold|force_min' /home/jp/Projects/palace-daemon/clients/hook.py | head -20
```

Expected: locate the counter or threshold logic.

- [x] **Step 2: Determine threshold source**

Read the relevant section. Determine whether the threshold (e.g., 15) is:
- Hardcoded
- Read from `~/.mempalace/hook_settings.json` (key name to use)
- Read from `~/.mempalace/hook_state/`

Record the finding. If hardcoded and JP wants 15 specifically: that's an additional patch in Layer 2A.

No commit.

### Task 0.4: Decide PALACE_DAEMON_PATH_MAP fate

**Files:**
- Read: `/home/jp/.config/palace-daemon/env` on disks

- [x] **Step 1: Inspect current env**

Run on katana (sshing into disks):
```bash
ssh disks 'cat /home/jp/.config/palace-daemon/env'
```

The env currently includes:
```
PALACE_DAEMON_PATH_MAP=/home/jp/.claude/=/mnt/raid/claude-config/,/home/jp/Projects/=/mnt/raid/projects/
```

This translated katana paths to disks paths back when palace-daemon read katana's transcripts via NFS. NFS is now disabled.

- [x] **Step 2: Decide**

Two outcomes:
- **Keep**: if Layer 2B uses Migration path 3 (re-mine), the path map is still needed to translate katana paths in transcripts. Keep as is.
- **Retire**: if Migration path 1 (export/import) is used, the path map is no longer load-bearing. Mark for removal in Layer 1 (when rewriting the unit/env).

Record the decision.

No commit.

---

## Layer 1 — palace-daemon as system service (on disks)

### Task 1.1: Backup current palace-daemon configuration

**Files:**
- Read: `~/.config/systemd/user/palace-daemon.service` on disks
- Read: `~/.config/palace-daemon/env` on disks
- Backup target: `/tmp/palace-daemon-bak-YYYYMMDD/` on disks

- [x] **Step 1: Create backup directory and copy current files**

Run on katana:
```bash
ssh disks 'BAK=/tmp/palace-daemon-bak-$(date +%Y%m%d-%H%M%S); mkdir -p $BAK && cp ~/.config/systemd/user/palace-daemon.service $BAK/ && cp ~/.config/palace-daemon/env $BAK/ && ls -la $BAK && echo "BACKUP_DIR=$BAK"'
```

Expected: prints the backup dir name and confirms both files copied. Save the BACKUP_DIR value in the scratch notes for rollback if needed.

No commit (host-side state, not in the repo).

### Task 1.2: Take a palace data backup via /backup endpoint

**Files:**
- Output: `/mnt/storage/backups/palace/palace-pre-foundation-rework-YYYYMMDD.tar.zst` on disks (or wherever palace-daemon's /backup writes)

- [x] **Step 1: Trigger /backup**

Run on katana:
```bash
curl -s --max-time 60 -X POST http://disks:8085/backup \
  -H "x-api-key: $(grep PALACE_DAEMON_API_KEY ~/Projects/familiar.realm.watch/.env | cut -d= -f2)" \
  -H "Content-Type: application/json" -d '{}' | jq .
```

Expected: JSON response with the backup path and file size. If endpoint returns 404 or 405, palace-daemon doesn't support /backup at runtime — fall back to a manual rsync of `/mnt/raid/projects/mempalace-data/palace/` to a sibling directory.

- [x] **Step 2: Verify backup file exists**

```bash
ssh disks 'ls -la $(jq -r .backup_path /tmp/last-backup-resp.json 2>/dev/null) 2>/dev/null || find /mnt/storage/backups /mnt/raid/projects/mempalace-data -name "*pre-foundation*" -mmin -5 2>/dev/null'
```

Expected: file exists, >100 MB (palace data is non-trivial).

No commit.

### Task 1.3: Stop and disable the user systemd unit

**Files:**
- Modify on disks: enabled state of `~/.config/systemd/user/palace-daemon.service`

- [x] **Step 1: Stop and disable**

Run on katana:
```bash
ssh disks 'systemctl --user disable --now palace-daemon.service 2>&1; systemctl --user is-active palace-daemon.service'
```

Expected: output ends with `inactive`.

- [x] **Step 2: Verify port 8085 is free**

```bash
ssh disks 'ss -tlnp 2>/dev/null | grep 8085 || echo "(port 8085 free)"'
```

Expected: `(port 8085 free)`.

No commit.

### Task 1.4: Write the new system unit

**Files:**
- Create on disks: `/etc/systemd/system/palace-daemon.service`

- [x] **Step 1: Write the new unit via sudo tee**

Run on katana:
```bash
ssh disks 'sudo tee /etc/systemd/system/palace-daemon.service >/dev/null <<EOF
[Unit]
Description=palace-daemon — mempalace HTTP/MCP gateway (system unit)
Documentation=https://github.com/jphein/palace-daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jp
Group=jp
WorkingDirectory=/mnt/raid/projects/palace-daemon
ExecStartPre=-/usr/bin/fuser -k 8085/tcp
ExecStartPre=-/bin/rm -f /home/jp/.cache/palace-daemon/daemon-8085.lock
ExecStart=/home/jp/.local/share/palace-daemon/venv/bin/python main.py --palace /mnt/raid/projects/mempalace-data/palace
Environment=PALACE_PORT=8085
Environment=PALACE_MAX_CONCURRENCY=4
EnvironmentFile=/home/jp/.config/palace-daemon/env
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF'
```

Note: `WantedBy=multi-user.target` (not `default.target`) — that's the system equivalent.

- [x] **Step 2: Verify the file was written**

```bash
ssh disks 'sudo cat /etc/systemd/system/palace-daemon.service | head -10'
```

Expected: shows the `[Unit]` block. File is owned root:root.

No commit (system-level file).

### Task 1.5: Reload systemd and start the new unit

**Files:**
- None to modify

- [x] **Step 1: daemon-reload and enable + start**

Run on katana:
```bash
ssh disks 'sudo systemctl daemon-reload && sudo systemctl enable --now palace-daemon.service'
```

Expected: prints `Created symlink ...palace-daemon.service` and no error.

- [x] **Step 2: Wait a moment, then check status**

```bash
ssh disks 'sleep 3 && systemctl is-active palace-daemon && systemctl status palace-daemon --no-pager | head -10'
```

Expected: `active (running)`, no error states.

- [x] **Step 3: Verify port 8085 listening**

```bash
ssh disks 'ss -tlnp 2>/dev/null | grep 8085'
```

Expected: a LISTEN row for `*:8085` owned by `python main.py`.

No commit.

### Task 1.6: End-to-end health check from katana

**Files:**
- None to modify

- [x] **Step 1: Health check from outside disks**

Run on katana:
```bash
KEY=$(grep PALACE_DAEMON_API_KEY ~/Projects/familiar.realm.watch/.env | cut -d= -f2)
curl -s --max-time 10 -w "\nHTTP %{http_code}\n" "http://disks:8085/health" -H "x-api-key: $KEY"
```

Expected: HTTP 200 with palace-daemon health JSON.

- [x] **Step 2: Re-verify familiar-api sees palace healthy**

```bash
curl -s --max-time 10 http://127.0.0.1:8080/api/familiar/health | jq '.dependencies.palace_daemon'
```

Expected: `"status": "ok"`.

No commit.

### Task 1.7: Reboot test (optional but smart)

**Files:**
- None to modify

- [x] **Step 1: Reboot disks**

This restarts the whole machine; only do it during low-impact time.

```bash
ssh disks 'sudo systemctl reboot'
```

The SSH connection drops immediately.

- [x] **Step 2: Wait for disks to come back**

Wait 60 seconds, then:
```bash
until ping -c 1 -W 2 disks >/dev/null 2>&1; do sleep 2; done
echo "ping ok"
sleep 5
ssh disks 'systemctl is-active palace-daemon'
```

Expected: `active`. palace-daemon should be up *before* any user session.

- [x] **Step 3: Confirm port from outside**

```bash
curl -s --max-time 10 "http://disks:8085/health" -H "x-api-key: $KEY" | jq .status
```

Expected: `"ok"`.

No commit. (Optional task — can skip if not ready to reboot.)

### Task 1.8: Commit a record of Layer 1 completion

**Files:**
- Create: `docs/superpowers/plans/2026-05-10-foundation-rework.md` (this file gets checkbox updates)

- [x] **Step 1: Update this plan's checkboxes**

Mark Tasks 1.1–1.7 complete in the plan. Commit:

```bash
cd ~/Projects/familiar.realm.watch
git add docs/superpowers/plans/2026-05-10-foundation-rework.md
git commit -m "$(cat <<'EOF'
chore: mark Layer 1 of foundation rework complete

palace-daemon now runs as a system systemd unit on disks with
User=jp, Restart=always, explicit paths. Reboot test confirmed
the daemon comes up before any user session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Layer 2A — Hook routing fix

### Task 2A.1: Pause the existing Stop hook temporarily

**Files:**
- Modify on katana: `/home/jp/Projects/memorypalace/.claude-plugin/hooks/hooks.json`

- [x] **Step 1: Inspect the file to find the Stop hook block**

```bash
cat /home/jp/Projects/memorypalace/.claude-plugin/hooks/hooks.json
```

Note the structure. Find the `Stop` array.

- [x] **Step 2: Comment out the Stop hook command**

JSON doesn't support comments. To pause, replace the command body with a no-op that emits a marker:

Edit `/home/jp/Projects/memorypalace/.claude-plugin/hooks/hooks.json`. In the `Stop` hook entry, change the `command` value from:

```
bash "${CLAUDE_PLUGIN_ROOT}/hooks/mempal-stop-hook.sh"
```

to:

```
echo "Stop hook paused for foundation rework — see foundation-rework spec"
```

(Same for PreCompact and SessionStart if they exist in the file.)

- [x] **Step 3: Verify paused by triggering a small exchange and checking palace state**

In a separate Claude Code session: ask one short question, close.

Then on katana:
```bash
ls -la ~/.mempalace/hook_state/ | head -5
```

Expected: no new files modified in the last minute (hook didn't run mempalace logic).

No commit yet — this is mid-migration state.

### Task 2A.2: Pre-write the new hook_settings.json

**Files:**
- Create on katana: `~/.mempalace/hook_settings.json`

- [x] **Step 1: Write the settings file**

```bash
mkdir -p ~/.mempalace
cat > ~/.mempalace/hook_settings.json <<'EOF'
{
  "daemon_url": "http://disks:8085",
  "silent_save": true,
  "force_on_stop": true,
  "force_min_interval": 60
}
EOF
cat ~/.mempalace/hook_settings.json
```

Expected: prints the JSON back.

- [x] **Step 2: Verify API key is available to hook.py**

hook.py reads `PALACE_API_KEY` from env (set in `~/.claude/settings.json`'s env block — verify):

```bash
grep PALACE_API_KEY ~/.claude/settings.json
```

Expected: matches the key in `~/Projects/familiar.realm.watch/.env`.

No commit yet.

### Task 2A.3: Backup disks palace one more time (pre-migration insurance)

**Files:**
- Output: a fresh backup file with a clear timestamp

- [x] **Step 1: Trigger /backup**

```bash
KEY=$(grep PALACE_DAEMON_API_KEY ~/Projects/familiar.realm.watch/.env | cut -d= -f2)
curl -s --max-time 60 -X POST http://disks:8085/backup \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"label":"pre-layer2-data-migration"}' | jq .
```

Expected: path to a `.tar.zst` file on disks. Record the path in the scratch journal. If /backup doesn't exist, fall back to:

```bash
ssh disks 'sudo cp -r /mnt/raid/projects/mempalace-data/palace /mnt/raid/projects/mempalace-data/palace.pre-layer2-$(date +%Y%m%d-%H%M%S) && du -sh /mnt/raid/projects/mempalace-data/palace*'
```

No commit.

---

## Layer 2B — Data migration

Branch on the Task 0.1 finding.

### Task 2B.1a: Migrate via mempalace CLI (preferred path, if export exists)

**Files:**
- Output (intermediate): `/tmp/katana-palace-export-YYYYMMDD.tar.zst` on katana
- Output (intermediate): same file copied to disks

Only execute if Task 0.1 confirmed `mempalace export` and `mempalace import` exist.

- [x] **Step 1: Export katana's local palace**

```bash
~/Projects/memorypalace/venv/bin/python -m mempalace export \
  --palace /home/jp/Projects/mempalace-data/palace \
  --output /tmp/katana-palace-export-$(date +%Y%m%d-%H%M%S).tar.zst
```

Expected: writes a tar.zst file; prints summary (drawer count, size).

- [x] **Step 2: Transfer to disks**

```bash
FILE=$(ls -1t /tmp/katana-palace-export-*.tar.zst | head -1)
scp "$FILE" disks:/tmp/
```

Expected: file uploads cleanly.

- [x] **Step 3: Import into disks palace**

```bash
ssh disks "~/Projects/memorypalace/venv/bin/python -m mempalace import \
  --palace /mnt/raid/projects/mempalace-data/palace \
  --input /tmp/$(basename $FILE) \
  --on-conflict skip"
```

`--on-conflict skip` (or whatever flag is correct per `mempalace import --help`) preserves existing drawers, only adds new ones. Adjust based on the actual CLI surface.

Expected: prints import summary (new drawers added, conflicts skipped).

- [x] **Step 4: Verify by searching for a known katana-only topic**

```bash
KEY=$(grep PALACE_DAEMON_API_KEY ~/Projects/familiar.realm.watch/.env | cut -d= -f2)
curl -s "http://disks:8085/search?q=qwen2.5%3A14b&limit=3" \
  -H "x-api-key: $KEY" | jq '.results | length'
```

Expected: `>= 1` if today's session was mined to katana local.

No commit.

### Task 2B.1b: Migrate via re-mine (fallback path)

Only execute if Task 0.1 found no export/import commands.

**Files:**
- Sync source: `~/.claude/projects/-home-jp-*/` on katana
- Sync target: `/mnt/raid/claude-config/projects/` on disks (per existing PALACE_DAEMON_PATH_MAP)

- [x] **Step 1: Rsync transcripts from katana to disks**

```bash
rsync -av --delete \
  ~/.claude/projects/-home-jp-Projects-familiar-realm-watch/ \
  disks:/mnt/raid/claude-config/projects/-home-jp-Projects-familiar-realm-watch/
```

Repeat for each `-home-jp-*` project directory you want mined. The path map (`/home/jp/.claude/=/mnt/raid/claude-config/`) will let palace-daemon resolve them.

- [x] **Step 2: Trigger /mine on disks for each synced directory**

```bash
KEY=$(grep PALACE_DAEMON_API_KEY ~/Projects/familiar.realm.watch/.env | cut -d= -f2)
curl -s -X POST "http://disks:8085/mine" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"path":"/mnt/raid/claude-config/projects/-home-jp-Projects-familiar-realm-watch"}' | jq .
```

Expected: mine job started/completed with drawer count.

- [x] **Step 3: Verify**

Same as 2B.1a Step 4.

No commit.

### Task 2B.2: Switch the Stop hook to call hook.py

**Files:**
- Modify on katana: `/home/jp/Projects/memorypalace/.claude-plugin/hooks/hooks.json`

- [x] **Step 1: Edit the Stop hook command**

Edit `/home/jp/Projects/memorypalace/.claude-plugin/hooks/hooks.json`. Change the Stop hook's `command` (currently the paused echo from Task 2A.1) to:

```
python3 /home/jp/Projects/palace-daemon/clients/hook.py --hook stop --harness claude-code
```

Bump the `timeout` field to `30000` (30 sec) since the hook now does network I/O to disks.

- [x] **Step 2: Same for PreCompact (if defined)**

If hooks.json has a `PreCompact` block, change its command to:
```
python3 /home/jp/Projects/palace-daemon/clients/hook.py --hook precompact --harness claude-code
```

- [x] **Step 3: Same for SessionStart (if defined)**

If hooks.json has a `SessionStart` block, change its command to:
```
python3 /home/jp/Projects/palace-daemon/clients/hook.py --hook session-start --harness claude-code
```

- [x] **Step 4: Commit the plugin change**

```bash
cd ~/Projects/memorypalace
git add .claude-plugin/hooks/hooks.json
git commit -m "$(cat <<'EOF'
fix(hooks): route Stop/PreCompact/SessionStart through palace-daemon

Replaces mempal-stop-hook.sh subprocess approach with direct
invocation of palace-daemon/clients/hook.py. The new hook routes
mine operations through palace-daemon's POST /mine (single source
of truth), eliminating the split-brain where katana's local palace
was receiving writes that disks-served palace never saw.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(The mempalace plugin is JP's fork; safe to commit there.)

### Task 2B.3: Test the new hook fires correctly

**Files:**
- None to modify

- [x] **Step 1: Open a fresh Claude Code session in a different terminal**

Run a short interaction: ask one question, get one response, close.

- [x] **Step 2: Check katana's hook_state**

```bash
ls -lat ~/.mempalace/hook_state/ | head -5
```

Expected: most recent file mtime is from within the last minute (or matches when hook fired).

- [x] **Step 3: Check disks palace for new drawers**

```bash
KEY=$(grep PALACE_DAEMON_API_KEY ~/Projects/familiar.realm.watch/.env | cut -d= -f2)
curl -s "http://disks:8085/list?limit=5" -H "x-api-key: $KEY" | \
  jq '.drawers | map({created_at, wing, room})[0:5]'
```

Expected: at least one drawer with `created_at` from the last few minutes (post-hook-deployment).

No commit.

### Task 2B.4: Freeze the old katana local palace

**Files:**
- Rename on katana: `~/Projects/mempalace-data/palace` → `~/Projects/mempalace-data/palace.frozen-YYYYMMDD`

- [x] **Step 1: Rename**

```bash
mv ~/Projects/mempalace-data/palace ~/Projects/mempalace-data/palace.frozen-$(date +%Y%m%d)
ls ~/Projects/mempalace-data/
```

Expected: only the `palace.frozen-...` directory exists (no plain `palace`).

- [x] **Step 2: Update the symlink in ~/.mempalace/ to point at disks**

The `~/.mempalace/palace` symlink originally pointed at the local palace. With the daemon-routed approach, the symlink isn't strictly needed (hook.py talks HTTP), but leaving a dangling symlink is messy. Replace with a marker:

```bash
rm ~/.mempalace/palace
echo "# This palace is now served by palace-daemon on disks:8085" > ~/.mempalace/palace.RETIRED
ls -la ~/.mempalace/palace*
```

- [x] **Step 3: Verify nothing depends on the dangling symlink**

```bash
grep -r "~/.mempalace/palace" ~/Projects/memorypalace ~/Projects/palace-daemon ~/Projects/familiar.realm.watch 2>/dev/null | grep -v node_modules | head
```

Expected: any remaining references are doc/comment, not load-bearing code.

No commit (host-side state).

---

## Layer 3 — Recall verification + cleanup

### Task 3.1: Remove the `kind` parameter from palace-client.ts

**Files:**
- Modify: `src/palace-client.ts`

- [x] **Step 1: Find current kind usage**

Run:
```bash
grep -n 'kind' /home/jp/Projects/familiar.realm.watch/src/palace-client.ts
```

You'll find: the `kind?: PalaceSearchKind` field in `SearchOpts`, and the `params.set("kind", ...)` line.

- [x] **Step 2: Edit palace-client.ts**

Remove the `kind?: PalaceSearchKind` line from `SearchOpts` and the `params.set("kind", ...)` line. Remove the import of `PalaceSearchKind` if no other references remain.

The diff should remove ~6 lines (interface field + comment + params.set line).

- [x] **Step 3: Run typecheck**

```bash
cd /home/jp/Projects/familiar.realm.watch
~/.bun/bin/bun run typecheck 2>&1 | tail
```

Expected: no type errors.

- [x] **Step 4: Run existing tests**

```bash
~/.bun/bin/bun test 2>&1 | tail -10
```

Expected: all tests pass.

### Task 3.2: Remove PalaceSearchKind type from types.ts

**Files:**
- Modify: `src/types.ts`

- [x] **Step 1: Verify no other consumers**

```bash
grep -rn 'PalaceSearchKind' /home/jp/Projects/familiar.realm.watch/src/ /home/jp/Projects/familiar.realm.watch/tests/ 2>/dev/null
```

Expected: only the type definition in `types.ts` (no other consumers after Task 3.1).

- [x] **Step 2: Delete the type**

Find the line `export type PalaceSearchKind = "content" | "checkpoint" | "all";` in `src/types.ts` and remove it.

- [x] **Step 3: Typecheck + tests**

```bash
~/.bun/bin/bun run typecheck 2>&1 | tail
~/.bun/bin/bun test 2>&1 | tail -5
```

Expected: pass.

### Task 3.3: Commit the kind cleanup

**Files:**
- Modified: `src/palace-client.ts`, `src/types.ts`

- [x] **Step 1: Commit**

```bash
cd /home/jp/Projects/familiar.realm.watch
git add src/palace-client.ts src/types.ts
git commit -m "$(cat <<'EOF'
refactor(palace-client): remove dead `kind` parameter

palace-daemon's /search no longer filters by kind (verified in
Step 0 of the foundation rework). Removing the unused parameter
from palace-client.ts and the PalaceSearchKind type from types.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.4: Write the end-to-end recall smoke test

**Files:**
- Create: `tests/recall-roundtrip.test.ts`

- [x] **Step 1: Write the test**

Create `tests/recall-roundtrip.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";

const PALACE_URL = process.env.PALACE_DAEMON_URL ?? "http://disks:8085";
const PALACE_KEY = process.env.PALACE_DAEMON_API_KEY ?? "";
const FAMILIAR_URL = process.env.FAMILIAR_URL ?? "http://127.0.0.1:8080";

const MARKER = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("recall roundtrip", () => {
  test("a drawer written to palace is recallable by familiar within 10s", async () => {
    // 1. Write a known drawer
    const writeRes = await fetch(`${PALACE_URL}/memory`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": PALACE_KEY,
      },
      body: JSON.stringify({
        content: `Test marker for foundation rework: ${MARKER}. This is a unique drawer used by the recall roundtrip smoke test.`,
        wing: "test_recall_roundtrip",
        room: "smoke",
      }),
    });
    expect(writeRes.ok).toBe(true);

    // 2. Wait for index
    await new Promise((r) => setTimeout(r, 5000));

    // 3. Ask familiar a question that should retrieve the marker
    const chatRes = await fetch(`${FAMILIAR_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5:14b-instruct-q4_K_M",
        messages: [
          { role: "user", content: `What does the marker '${MARKER}' refer to? Quote anything specific you know about it.` },
        ],
        stream: false,
      }),
    });
    expect(chatRes.ok).toBe(true);
    const body = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> };
    const content = body.choices[0]?.message?.content ?? "";

    // 4. Assert the marker appears in the answer (proves retrieval landed)
    expect(content).toContain(MARKER);
  }, { timeout: 30000 });
});
```

- [x] **Step 2: Run the test**

```bash
cd /home/jp/Projects/familiar.realm.watch
PALACE_DAEMON_URL=http://disks:8085 \
  PALACE_DAEMON_API_KEY=$(grep PALACE_DAEMON_API_KEY .env | cut -d= -f2) \
  FAMILIAR_URL=http://127.0.0.1:8080 \
  ~/.bun/bin/bun test tests/recall-roundtrip.test.ts
```

Expected: 1 passed. If it fails, the foundation isn't actually working — debug before declaring complete.

- [x] **Step 3: Commit the test**

```bash
git add tests/recall-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
test: add recall roundtrip smoke test

Inserts a unique-marker drawer into palace, waits for indexing,
then asks familiar a question that should retrieve the marker.
Verifies the foundation works end-to-end: hook isn't needed for
this path, but write→index→search→retrieve→chat is the same
shape the daily flow uses.

This test would have caught today's split-brain immediately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.5: Migrate familiar-api to system systemd unit

**Files:**
- Disable on current host: `~/.config/systemd/user/familiar-api.service`
- Create: `/etc/systemd/system/familiar-api.service`

- [x] **Step 1: Stop and disable the user unit**

```bash
systemctl --user disable --now familiar-api.service
systemctl --user is-active familiar-api.service
```

Expected: `inactive`.

- [x] **Step 2: Write the system unit**

```bash
sudo tee /etc/systemd/system/familiar-api.service >/dev/null <<'EOF'
[Unit]
Description=familiar-api — local-first AI companion (system unit)
Documentation=https://github.com/jphein/familiar.realm.watch
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=jp
Group=jp
WorkingDirectory=/home/jp/Projects/familiar.realm.watch
Environment=PATH=/home/jp/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/jp/.bun/bin/bun src/familiar.ts
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF
```

- [x] **Step 3: daemon-reload, enable, start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now familiar-api.service
sleep 3
systemctl is-active familiar-api && systemctl status familiar-api --no-pager | head -10
```

Expected: `active`.

- [x] **Step 4: Smoke test it from outside**

```bash
curl -s --max-time 10 http://127.0.0.1:8080/api/familiar/health | jq '.dependencies'
```

Expected: all three dependencies `"status": "ok"`.

No commit (host-side state).

### Task 3.6: Rework deploy-familiar.sh for host-agnostic deploys

**Files:**
- Modify: `ops/scripts/deploy-familiar.sh`

- [x] **Step 1: Read the current deploy script**

```bash
cat /home/jp/Projects/familiar.realm.watch/ops/scripts/deploy-familiar.sh
```

Note the current behavior — what it assumes about target host, paths, sudo, etc.

- [x] **Step 2: Rewrite the script**

Replace contents with a host-agnostic version:

```bash
#!/usr/bin/env bash
# deploy-familiar.sh — host-agnostic deploy for familiar-api
#
# Usage:
#   ./deploy-familiar.sh                       # deploy to current host
#   ./deploy-familiar.sh --host familiar       # deploy to remote
#   ./deploy-familiar.sh --host katana --dry-run

set -euo pipefail

HOST=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "DRY-RUN: $*"
  elif [[ -n "$HOST" ]]; then
    ssh "$HOST" "$@"
  else
    eval "$@"
  fi
}

echo "==> Deploying familiar-api to ${HOST:-$(hostname)}"

# 1. Ensure bun is installed
run 'which ~/.bun/bin/bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash)'

# 2. Sync source (if remote)
if [[ -n "$HOST" && "$DRY_RUN" == false ]]; then
  rsync -av --delete --exclude node_modules --exclude .env \
    "$SRC_DIR/" "$HOST:/home/jp/Projects/familiar.realm.watch/"
fi

# 3. Install deps
run 'cd /home/jp/Projects/familiar.realm.watch && ~/.bun/bin/bun install'

# 4. Ensure .env exists (don't overwrite)
run 'test -f /home/jp/Projects/familiar.realm.watch/.env || cp /home/jp/Projects/familiar.realm.watch/.env.example /home/jp/Projects/familiar.realm.watch/.env'

# 5. Install systemd unit
run "sudo tee /etc/systemd/system/familiar-api.service >/dev/null <<'UNIT_EOF'
[Unit]
Description=familiar-api — local-first AI companion (system unit)
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=jp
Group=jp
WorkingDirectory=/home/jp/Projects/familiar.realm.watch
Environment=PATH=/home/jp/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/jp/.bun/bin/bun src/familiar.ts
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
KillMode=mixed

[Install]
WantedBy=multi-user.target
UNIT_EOF"

# 6. Reload + enable + (re)start
run 'sudo systemctl daemon-reload && sudo systemctl enable --now familiar-api'

# 7. Health check
run 'sleep 3 && curl -s --max-time 10 http://127.0.0.1:8080/api/familiar/health | jq -r .dependencies | head'

echo "==> Done."
```

- [x] **Step 3: chmod and quick local dry-run**

```bash
chmod +x /home/jp/Projects/familiar.realm.watch/ops/scripts/deploy-familiar.sh
/home/jp/Projects/familiar.realm.watch/ops/scripts/deploy-familiar.sh --dry-run | head -20
```

Expected: prints DRY-RUN lines for each step without executing.

- [x] **Step 4: Commit**

```bash
git add ops/scripts/deploy-familiar.sh
git commit -m "$(cat <<'EOF'
feat(ops): host-agnostic deploy-familiar.sh

Accepts --host and --dry-run flags. Same script deploys to katana
now and will deploy to familiar after the P102 GPUs are installed.
Writes a system systemd unit (User=jp) matching the palace-daemon
pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.7: Final end-to-end verification

**Files:**
- None to modify

- [x] **Step 1: Full test suite passes**

```bash
cd /home/jp/Projects/familiar.realm.watch
PALACE_DAEMON_URL=http://disks:8085 \
  PALACE_DAEMON_API_KEY=$(grep PALACE_DAEMON_API_KEY .env | cut -d= -f2) \
  FAMILIAR_URL=http://127.0.0.1:8080 \
  ~/.bun/bin/bun test
```

Expected: all green, including `recall-roundtrip.test.ts`.

- [x] **Step 2: Trigger a new Claude session and chat about a recent topic**

In a separate terminal: open Claude Code, ask "what have I worked on this past hour?" or similar topical question.

Expected: response cites drawers written during this foundation rework session (the proof the hook is writing to disks AND familiar can recall them).

- [x] **Step 3: Update the plan checkboxes and commit**

```bash
cd /home/jp/Projects/familiar.realm.watch
git add docs/superpowers/plans/2026-05-10-foundation-rework.md
git commit -m "$(cat <<'EOF'
chore: mark foundation rework complete (all three layers)

palace-daemon stable as system unit on disks; mempalace plugin
hook routes through palace-daemon (split-brain eliminated);
recall roundtrip smoke test passes; familiar-api migrated to
system unit; deploy-familiar.sh is host-agnostic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Rollback paths (for reference)

If any layer fails after deploy:

**Layer 1 (palace-daemon system unit):**
- `sudo systemctl disable --now palace-daemon` (system)
- `systemctl --user enable --now palace-daemon` (back to user)
- Same daemon binary, same data — purely a lifecycle revert

**Layer 2A (hook routing):**
- Revert `/home/jp/Projects/memorypalace/.claude-plugin/hooks/hooks.json` to call `mempal-stop-hook.sh`
- `git checkout HEAD~1 .claude-plugin/hooks/hooks.json` in `~/Projects/memorypalace`
- Writes resume to katana local (which may be frozen; unfreeze if needed by renaming the directory back)

**Layer 2B (data migration):**
- Restore disks's pre-migration backup
- `POST /restore` if palace-daemon supports it, otherwise rsync from the snapshot

**Layer 3 (kind cleanup, smoke test, deploy script):**
- `git revert` the relevant commits — all code-level changes

---

## Notes

- Pre-migration backups: at least one before Layer 1, one before Layer 2B. Keep for at least 7 days before pruning.
- After all three layers land, the borg backup (running on disks) will pick up disks's palace in its nightly run, so the merged palace data automatically gets included in long-term backup.
- The dual Ollama setup on familiar (ollama-chat + ollama-embed on different GPUs) is unaffected by this plan. The P102-day migration of familiar-api off katana is a separate work item, but the `deploy-familiar.sh --host familiar` from Task 3.6 should handle it cleanly.
