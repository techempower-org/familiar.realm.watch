#!/usr/bin/env python3
"""Poll AGE backfill progress from checkpoint table.

Computes rate from checkpoint count deltas between polls (stored in a
temp file). No dependency on the backfill log — works even when the
log is sparse or the process is restarted.

Outputs JSON matching palace-daemon's /backfill-age/status shape so
wave-block.py backfill --cmd can render the full progress bar dashboard.
"""
import json, os, sys, time
import psycopg2

DSN = "postgresql://palace:REDACTED-DSN-PASSWORD@familiar:5433/mempalace_2026_05_13"
STATE_FILE = "/tmp/backfill-poll-state.json"

conn = psycopg2.connect(DSN)
cur = conn.cursor()

cur.execute("SELECT COUNT(*) FROM mempalace_drawers")
total = cur.fetchone()[0]

cur.execute("SELECT COUNT(*) FROM mempalace_kg_backfill_state WHERE phase = 'drawer'")
done = cur.fetchone()[0]

conn.close()

now = time.time()
rate = 0.0

# Load previous poll state to compute delta rate.
try:
    with open(STATE_FILE) as f:
        prev = json.load(f)
    dt = now - prev["ts"]
    dd = done - prev["done"]
    if dt > 0 and dd > 0:
        rate = dd / dt
except (FileNotFoundError, KeyError, json.JSONDecodeError):
    pass

# Save current state for next poll.
with open(STATE_FILE, "w") as f:
    json.dump({"ts": now, "done": done}, f)

log_line = (
    f"{time.strftime('%Y-%m-%d %H:%M:%S')} mempalace.backfill_age INFO "
    f"backfill: drawers_seen={done} entities_added=0 "
    f"skipped=0 errors=0 rate={rate:.1f}/s"
)

json.dump({
    "in_progress": done < total,
    "elapsed_seconds": 0,
    "total_drawers": total,
    "recent_output": [log_line],
}, sys.stdout)
