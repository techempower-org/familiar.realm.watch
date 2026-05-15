#!/usr/bin/env python3
"""run_paraphrase_probe.py — A/B HyDE measurement against /api/familiar/eval.

Per familiar#5. Sends each question in `paraphrase_questions.yaml` to
`/api/familiar/eval` twice — once with ``?hyde=false`` (force off), once
with ``?hyde=true`` (force on) — and compares retrieval quality.

Match logic (any-of):
  1. drawer_id appears in `retrieved_entities[*].id`
  2. any `expected_substrings` appears in any retrieved drawer's
     `content_snippet` (case-insensitive)

This dual matcher lets us probe drawers we know exist by ID *and*
content-themed questions where the specific drawer ID isn't pinned but
the topical content should still surface.

Usage::

    python tests/eval/run_paraphrase_probe.py \\
        --base-url http://localhost:8080 \\
        --questions tests/eval/paraphrase_questions.yaml \\
        --out tests/eval/probe-results.json

Output: stdout summary table + optional full JSON. The summary shows,
per shape:
  - recall@N for HyDE-off vs HyDE-on
  - Δ recall (HyDE − off)
  - mean latency delta (HyDE adds ~one model call per query)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path


def _load_questions(path: str) -> list[dict]:
    """Minimal YAML reader for our flat shape. Avoids PyYAML dependency.

    Format we accept:
        questions:
          - query: "..."
            expected_drawers:
              - drawer_id_a
              - drawer_id_b
            expected_substrings:   # optional
              - foo
              - bar
            shape: vocab_mismatch
            why: "..."

    All values are strings except expected_drawers / expected_substrings
    (which are list-of-strings) and `expected_drawers: []` (empty list).
    """
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    out: list[dict] = []
    cur: dict | None = None
    cur_list_key: str | None = None
    for raw in lines:
        # Strip comments.
        line = raw.split("#", 1)[0].rstrip() if not raw.strip().startswith("#") else ""
        if not line:
            continue
        if line == "questions:":
            continue
        if line.startswith("  - query:") or line.startswith("- query:"):
            if cur is not None:
                out.append(cur)
            cur = {"expected_drawers": [], "expected_substrings": []}
            cur_list_key = None
            val = line.split(":", 1)[1].strip().strip('"')
            cur["query"] = val
            continue
        if cur is None:
            continue
        stripped = line.strip()
        if stripped.startswith("expected_drawers:"):
            cur_list_key = "expected_drawers"
            rest = stripped.split(":", 1)[1].strip()
            if rest == "[]":
                cur["expected_drawers"] = []
                cur_list_key = None
            continue
        if stripped.startswith("expected_substrings:"):
            cur_list_key = "expected_substrings"
            continue
        if stripped.startswith("shape:"):
            cur["shape"] = stripped.split(":", 1)[1].strip().strip('"')
            cur_list_key = None
            continue
        if stripped.startswith("why:"):
            cur["why"] = stripped.split(":", 1)[1].strip().strip('"')
            cur_list_key = None
            continue
        if stripped.startswith("- ") and cur_list_key:
            item = stripped[2:].strip().strip('"')
            cur[cur_list_key].append(item)
            continue
    if cur is not None:
        out.append(cur)
    return out


def _eval_once(base_url: str, query: str, hyde: bool, timeout: float = 60.0) -> tuple[dict, float]:
    """POST query to /api/familiar/eval; return (response_dict, latency_seconds)."""
    url = f"{base_url}/api/familiar/eval?hyde={'true' if hyde else 'false'}"
    body = json.dumps({"query": query, "mock": True}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError) as e:
        data = {"_error": str(e), "retrieved_entities": []}
    latency = time.time() - t0
    return data, latency


def _matches(question: dict, retrieved: list[dict]) -> tuple[bool, str]:
    """Return (matched, reason). Tries drawer-id match first, then substring."""
    expected_ids = set(question.get("expected_drawers") or [])
    if expected_ids:
        retrieved_ids = {r.get("id", "") for r in retrieved}
        hit = expected_ids & retrieved_ids
        if hit:
            return True, f"drawer_id:{next(iter(hit))[:48]}"

    expected_subs = [s.lower() for s in question.get("expected_substrings") or []]
    if expected_subs:
        for r in retrieved:
            snippet = (r.get("content_snippet") or "").lower()
            for sub in expected_subs:
                if sub in snippet:
                    return True, f"substring:{sub}"
    return False, "no-match"


def _truncate_retrieved(retrieved: list[dict], top_n: int) -> list[dict]:
    return retrieved[:top_n] if top_n else retrieved


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:8080")
    parser.add_argument(
        "--questions",
        default=str(Path(__file__).resolve().parent / "paraphrase_questions.yaml"),
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=5,
        help="Recall cutoff. Defaults to 5 — matches multipass convention.",
    )
    parser.add_argument("--out", default="", help="Optional path for the full result JSON.")
    parser.add_argument(
        "--shapes",
        default="",
        help="Comma-separated subset of shapes to run (default: all).",
    )
    args = parser.parse_args(argv)

    questions = _load_questions(args.questions)
    if args.shapes:
        wanted = {s.strip() for s in args.shapes.split(",")}
        questions = [q for q in questions if q.get("shape") in wanted]
    print(f"Questions: {len(questions)} loaded from {args.questions}")
    print(f"Endpoint:  {args.base_url}/api/familiar/eval")
    print(f"Top-N for recall: {args.top_n}")
    print()

    rows = []
    for q in questions:
        no_hyde, lat_no = _eval_once(args.base_url, q["query"], hyde=False)
        yes_hyde, lat_yes = _eval_once(args.base_url, q["query"], hyde=True)

        retrieved_no = _truncate_retrieved(no_hyde.get("retrieved_entities") or [], args.top_n)
        retrieved_yes = _truncate_retrieved(yes_hyde.get("retrieved_entities") or [], args.top_n)

        ok_no, reason_no = _matches(q, retrieved_no)
        ok_yes, reason_yes = _matches(q, retrieved_yes)

        rows.append(
            {
                "query": q["query"],
                "shape": q.get("shape", "unknown"),
                "no_hyde": {"matched": ok_no, "reason": reason_no, "latency_s": round(lat_no, 3)},
                "yes_hyde": {"matched": ok_yes, "reason": reason_yes, "latency_s": round(lat_yes, 3)},
                "delta_state": (
                    "rescued" if (ok_yes and not ok_no)
                    else "regressed" if (ok_no and not ok_yes)
                    else "tied_hit" if (ok_yes and ok_no)
                    else "tied_miss"
                ),
            }
        )

    # ── Per-shape summary ────────────────────────────────────────────
    by_shape: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_shape[r["shape"]].append(r)

    print(f"{'shape':22s} {'n':>3s} {'noHyDE':>8s} {'HyDE':>8s} {'Δ':>6s} {'lat+':>7s}")
    print("-" * 60)
    totals = {"n": 0, "no_ok": 0, "yes_ok": 0, "lat_no_sum": 0.0, "lat_yes_sum": 0.0}
    for shape, group in sorted(by_shape.items()):
        n = len(group)
        no_ok = sum(1 for r in group if r["no_hyde"]["matched"])
        yes_ok = sum(1 for r in group if r["yes_hyde"]["matched"])
        lat_no = sum(r["no_hyde"]["latency_s"] for r in group) / n
        lat_yes = sum(r["yes_hyde"]["latency_s"] for r in group) / n
        print(
            f"{shape:22s} {n:3d} "
            f"{no_ok/n*100:7.1f}% "
            f"{yes_ok/n*100:7.1f}% "
            f"{(yes_ok-no_ok)/n*100:+5.1f}% "
            f"{(lat_yes-lat_no)*1000:+5.0f}ms"
        )
        totals["n"] += n
        totals["no_ok"] += no_ok
        totals["yes_ok"] += yes_ok
        totals["lat_no_sum"] += lat_no * n
        totals["lat_yes_sum"] += lat_yes * n
    print("-" * 60)
    n = totals["n"]
    if n:
        print(
            f"{'OVERALL':22s} {n:3d} "
            f"{totals['no_ok']/n*100:7.1f}% "
            f"{totals['yes_ok']/n*100:7.1f}% "
            f"{(totals['yes_ok']-totals['no_ok'])/n*100:+5.1f}% "
            f"{(totals['lat_yes_sum']-totals['lat_no_sum'])/n*1000:+5.0f}ms"
        )
    print()

    # ── Delta-state breakdown ──
    state_counts = defaultdict(int)
    for r in rows:
        state_counts[r["delta_state"]] += 1
    print("State transitions (HyDE off → on):")
    for state in ("rescued", "regressed", "tied_hit", "tied_miss"):
        print(f"  {state:10s} {state_counts[state]:3d}")

    if args.out:
        Path(args.out).write_text(
            json.dumps({"summary": dict(state_counts), "rows": rows}, indent=2),
            encoding="utf-8",
        )
        print(f"\nFull result JSON: {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
