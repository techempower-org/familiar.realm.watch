#!/usr/bin/env python3
"""Poll AGE backfill progress from checkpoint table.

Outputs JSON matching palace-daemon's /backfill-age/status shape so
wave-block.py backfill --cmd can render the full progress bar dashboard.
"""
import json, sys, time
import psycopg2

DSN = "postgresql://palace:REDACTED-DSN-PASSWORD@familiar:5433/mempalace_2026_05_13"

conn = psycopg2.connect(DSN)
cur = conn.cursor()

cur.execute("SELECT COUNT(*) FROM mempalace_drawers")
total = cur.fetchone()[0]

cur.execute("SELECT COUNT(*) FROM mempalace_kg_backfill_state WHERE phase = 'drawer'")
done = cur.fetchone()[0]

conn.close()

log_line = (
    f"{time.strftime('%Y-%m-%d %H:%M:%S')} mempalace.backfill_age INFO "
    f"backfill: drawers_seen={done} entities_added=0 "
    f"skipped=0 errors=0 rate=0.0/s"
)

json.dump({
    "in_progress": done < total,
    "elapsed_seconds": 0,
    "total_drawers": total,
    "recent_output": [log_line],
}, sys.stdout)
