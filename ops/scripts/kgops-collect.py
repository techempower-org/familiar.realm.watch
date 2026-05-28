#!/usr/bin/env python3
"""Collect KG-extract queue stats + sysmon metrics as JSON for wave-block.

Designed to run on familiar via SSH (familiar-kgops.sh). Emits everything
sysmon-collect.py emits (RAM, swap, disk, temps, GPUs, pg conns) plus
KG-extract queue counters and per-worker activity flags.

Output schema (consumed by kg-extract-poll.py):
  kg_completed       - completed extraction rows
  kg_incomplete      - pending extraction rows
  kg_errors          - rows with error NOT NULL
  kg_total_triples   - SUM(triples_extracted)
  kg_rate_per_min    - rows completed in the last 60 seconds
  worker_<N>         - "active" or "inactive" per mempalace-kg-extract@N.service

No external deps - stdlib only.

NOTE 2026-05-27: original file was deleted accidentally during a refactor.
This is a reconstruction from the interface contract in kg-extract-poll.py
plus the sysmon-collect.py pattern. Verify the queue table name and rate
window match production schema before relying on this.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _run(cmd: list[str], timeout: int = 10) -> str:
    """Run a subprocess and return stdout.

    Failures (non-zero exit, timeout, OSError, etc.) emit a stderr
    diagnostic line instead of silently swallowing the error. The
    previous behavior — bare ``except Exception: return ""`` — let
    `kgops-collect` quietly produce all-zeros output when a SQL
    column went missing (#48), which downstream defaulted to "no
    work pending" and triggered false-alarm investigations.
    """
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"[kgops-collect] _run timeout after {timeout}s: {cmd[:3]}...",
              file=sys.stderr)
        return ""
    except (FileNotFoundError, OSError) as e:
        print(f"[kgops-collect] _run exec failed: {e}: {cmd[:3]}...",
              file=sys.stderr)
        return ""
    if r.returncode != 0:
        stderr_snippet = (r.stderr or "").strip()[:300]
        print(
            f"[kgops-collect] _run rc={r.returncode}: {cmd[:3]}... "
            f"stderr: {stderr_snippet}",
            file=sys.stderr,
        )
        return ""
    return r.stdout.strip()


def _psql(query: str) -> str:
    return _run([
        "docker", "exec", "mempalace-db",
        "psql", "-U", "palace", "-d", "mempalace_2026_05_13",
        "-t", "-A", "-c", query,
    ])


def collect_sysmon() -> dict:
    """Run the sysmon-collect.py sibling and inherit its full JSON."""
    out = _run(["python3", os.path.join(HERE, "sysmon-collect.py")])
    if not out:
        return {}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {}


def collect_kg_extract() -> dict:
    """KG-extract queue counters from the mempalace database.

    #48 — dropped the ``total_triples`` row from the UNION ALL. The
    queue table has no ``triples_extracted`` column (verified live
    2026-05-28); the row caused the whole query to error and the
    enclosing _run/_psql to silently return "", which dropped ALL
    kg_* metrics. Downstream defaulted each missing key to 0,
    masking the failure for months.

    If a true triple-count metric is wanted later, query AGE directly:

        SELECT count(*) FROM cypher('mempalace_kg',
            $$ MATCH ()-[r:RELATION]->() RETURN count(r) $$
        ) AS (n agtype);

    That's an order of magnitude slower but is the actual source of
    truth (the extractor doesn't persist a per-queue-item count today).
    """
    m: dict = {}
    rows = _psql(
        "SELECT 'completed', count(*) FROM mempalace_kg_extraction_queue WHERE completed_at IS NOT NULL "
        "UNION ALL "
        "SELECT 'incomplete', count(*) FROM mempalace_kg_extraction_queue WHERE completed_at IS NULL "
        "UNION ALL "
        "SELECT 'errors', count(*) FROM mempalace_kg_extraction_queue WHERE error IS NOT NULL "
        "UNION ALL "
        "SELECT 'rate_per_min', count(*) FROM mempalace_kg_extraction_queue "
        "WHERE completed_at > now() - interval '1 minute';"
    )
    for line in rows.splitlines():
        if "|" not in line:
            continue
        k, v = line.split("|", 1)
        k = k.strip()
        v = v.strip()
        if not v.lstrip("-").isdigit():
            continue
        n = int(v)
        if k == "completed":
            m["kg_completed"] = n
        elif k == "incomplete":
            m["kg_incomplete"] = n
        elif k == "errors":
            m["kg_errors"] = n
        elif k == "rate_per_min":
            m["kg_rate_per_min"] = float(n)
    return m


def collect_workers() -> dict:
    """Active/inactive flag per mempalace-kg-extract@N.service worker unit."""
    out = _run([
        "systemctl", "list-units", "--type=service", "--all",
        "--no-legend", "--plain", "mempalace-kg-extract@*",
    ])
    m: dict = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        unit = parts[0]
        active_state = parts[2]
        match = re.match(r"mempalace-kg-extract@(\w+)\.service", unit)
        if not match:
            continue
        worker_id = match.group(1)
        m[f"worker_{worker_id}"] = "active" if active_state == "active" else "inactive"
    return m


def main() -> int:
    out: dict = {}
    out.update(collect_sysmon())
    out.update(collect_kg_extract())
    out.update(collect_workers())
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
