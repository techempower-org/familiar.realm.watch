#!/usr/bin/env python3
"""Poll AGE backfill progress from checkpoint table + real log.

Computes rate from checkpoint count deltas between polls. Reads
entity/error counts from the live backfill log on familiar.

Outputs JSON matching palace-daemon's /backfill-age/status shape so
wave-block.py backfill --cmd can render the full progress bar dashboard.
"""
import json, re, subprocess, sys, time
import psycopg2

DSN = "postgresql://palace:REDACTED-DSN-PASSWORD@familiar:5433/mempalace_2026_05_13"
STATE_FILE = "/tmp/backfill-poll-state.json"
BACKFILL_HOST = "familiar"
BACKFILL_LOG = "/tmp/backfill-age.log"
WORKER_LOG_PATTERN = "/tmp/backfill-worker-*.log"

conn = psycopg2.connect(DSN)
cur = conn.cursor()

cur.execute("SELECT COUNT(*) FROM mempalace_drawers")
total = cur.fetchone()[0]

cur.execute("SELECT COUNT(*) FROM mempalace_kg_backfill_state WHERE phase = 'drawer'")
done = cur.fetchone()[0]

conn.close()

now = time.time()
rate = 0.0
started_at = now

# Load previous poll state to compute delta rate.
try:
    with open(STATE_FILE) as f:
        prev = json.load(f)
    dt = now - prev["ts"]
    dd = done - prev["done"]
    if dt > 0 and dd > 0:
        rate = dd / dt
    started_at = prev.get("started_at", now)
except (FileNotFoundError, KeyError, json.JSONDecodeError):
    started_at = now

# Save current state for next poll.
with open(STATE_FILE, "w") as f:
    json.dump({"ts": now, "done": done, "started_at": started_at}, f)

elapsed = int(now - started_at)

# Read entity/error counts from worker logs (parallel) or single log (legacy).
# Sum across all workers to get the aggregate.
entities = 0
errors = 0
workers = 0
try:
    result = subprocess.run(
        ["ssh", BACKFILL_HOST,
         f"for f in {WORKER_LOG_PATTERN} {BACKFILL_LOG}; do "
         f"[ -f \"$f\" ] && grep 'entities_added=' \"$f\" | tail -1; done"],
        capture_output=True, text=True, timeout=5,
    )
    for line in result.stdout.strip().splitlines():
        m = re.search(r'entities_added=(\d+)', line)
        if m:
            entities += int(m.group(1))
            workers += 1
        m = re.search(r'errors=(\d+)', line)
        if m:
            errors += int(m.group(1))
except Exception:
    pass

worker_tag = f" workers={workers}" if workers > 1 else ""
log_line = (
    f"{time.strftime('%Y-%m-%d %H:%M:%S')} mempalace.backfill_age INFO "
    f"backfill: drawers_seen={done} entities_added={entities} "
    f"skipped=0 errors={errors} rate={rate:.1f}/s{worker_tag}"
)

json.dump({
    "in_progress": done < total,
    "elapsed_seconds": elapsed,
    "total_drawers": total,
    "recent_output": [log_line],
}, sys.stdout)
