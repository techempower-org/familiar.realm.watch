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


def _normalize_signal(matched_via: str | None) -> str:
    """Bucket the daemon's matched_via string into vector / bm25 / graph / other.

    palace-daemon emits a few different tokens depending on which retriever
    surfaced the drawer — e.g. ``drawer`` and ``closet`` are dense-vector
    matches, ``sqlite_bm25_fallback`` and anything containing ``bm25`` are
    lexical, and ``graph`` / ``age`` are graph-anchored. We collapse them
    so the per-signal summary is stable across daemon versions.
    """
    if not matched_via:
        return "unknown"
    s = matched_via.lower()
    if "bm25" in s or "lexical" in s:
        return "bm25"
    if "graph" in s or "age" in s or "kg" in s:
        return "graph"
    if "vector" in s or "dense" in s or "hnsw" in s or "drawer" in s or "closet" in s:
        return "vector"
    return s  # preserve raw token so we don't silently lose a new signal


def _matches(
    question: dict, retrieved: list[dict]
) -> tuple[bool, str, str | None, str | None, int]:
    """Return (matched, reason, matched_via_raw, matched_via_bucket, rank).

    Tries drawer-id match first, then substring. When a hit is found, also
    surfaces the ``matched_via`` field from the retrieved entity so callers
    can attribute the hit to vector / bm25 / graph retrieval. ``rank`` is
    1-indexed (first match wins) and 0 on miss — feeds MRR computation
    where reciprocal rank is 1/rank, 0 if no hit.
    """
    expected_ids = set(question.get("expected_drawers") or [])
    if expected_ids:
        for idx, r in enumerate(retrieved):
            rid = r.get("id", "")
            if rid in expected_ids:
                mv = r.get("matched_via")
                return True, f"drawer_id:{rid[:48]}", mv, _normalize_signal(mv), idx + 1

    expected_subs = [s.lower() for s in question.get("expected_substrings") or []]
    if expected_subs:
        for idx, r in enumerate(retrieved):
            snippet = (r.get("content_snippet") or "").lower()
            for sub in expected_subs:
                if sub in snippet:
                    mv = r.get("matched_via")
                    return True, f"substring:{sub}", mv, _normalize_signal(mv), idx + 1
    return False, "no-match", None, None, 0


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

        ok_no, reason_no, mv_raw_no, mv_bucket_no, rank_no = _matches(q, retrieved_no)
        ok_yes, reason_yes, mv_raw_yes, mv_bucket_yes, rank_yes = _matches(q, retrieved_yes)

        rows.append(
            {
                "query": q["query"],
                "shape": q.get("shape", "unknown"),
                "no_hyde": {
                    "matched": ok_no,
                    "reason": reason_no,
                    "latency_s": round(lat_no, 3),
                    "matched_via": mv_raw_no,
                    "signal": mv_bucket_no,
                    "rank": rank_no,
                    "timings": no_hyde.get("timings") or {},
                },
                "yes_hyde": {
                    "matched": ok_yes,
                    "reason": reason_yes,
                    "latency_s": round(lat_yes, 3),
                    "matched_via": mv_raw_yes,
                    "signal": mv_bucket_yes,
                    "rank": rank_yes,
                    "timings": yes_hyde.get("timings") or {},
                },
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

    def _mrr(group: list[dict], arm: str) -> float:
        """Mean reciprocal rank. RR = 1/rank for hits, 0 for misses."""
        if not group:
            return 0.0
        return sum((1.0 / r[arm]["rank"]) if r[arm]["rank"] else 0.0 for r in group) / len(group)

    print(
        f"{'shape':22s} {'n':>3s} {'noHyDE':>8s} {'HyDE':>8s} {'Δ':>6s} "
        f"{'MRR_no':>7s} {'MRR_yes':>8s} {'lat+':>7s}"
    )
    print("-" * 78)
    totals = {
        "n": 0, "no_ok": 0, "yes_ok": 0,
        "lat_no_sum": 0.0, "lat_yes_sum": 0.0,
        "rr_no_sum": 0.0, "rr_yes_sum": 0.0,
    }
    for shape, group in sorted(by_shape.items()):
        n = len(group)
        no_ok = sum(1 for r in group if r["no_hyde"]["matched"])
        yes_ok = sum(1 for r in group if r["yes_hyde"]["matched"])
        lat_no = sum(r["no_hyde"]["latency_s"] for r in group) / n
        lat_yes = sum(r["yes_hyde"]["latency_s"] for r in group) / n
        mrr_no = _mrr(group, "no_hyde")
        mrr_yes = _mrr(group, "yes_hyde")
        print(
            f"{shape:22s} {n:3d} "
            f"{no_ok/n*100:7.1f}% "
            f"{yes_ok/n*100:7.1f}% "
            f"{(yes_ok-no_ok)/n*100:+5.1f}% "
            f"{mrr_no:7.3f} "
            f"{mrr_yes:8.3f} "
            f"{(lat_yes-lat_no)*1000:+5.0f}ms"
        )
        totals["n"] += n
        totals["no_ok"] += no_ok
        totals["yes_ok"] += yes_ok
        totals["lat_no_sum"] += lat_no * n
        totals["lat_yes_sum"] += lat_yes * n
        totals["rr_no_sum"] += mrr_no * n
        totals["rr_yes_sum"] += mrr_yes * n
    print("-" * 78)
    n = totals["n"]
    if n:
        print(
            f"{'OVERALL':22s} {n:3d} "
            f"{totals['no_ok']/n*100:7.1f}% "
            f"{totals['yes_ok']/n*100:7.1f}% "
            f"{(totals['yes_ok']-totals['no_ok'])/n*100:+5.1f}% "
            f"{totals['rr_no_sum']/n:7.3f} "
            f"{totals['rr_yes_sum']/n:8.3f} "
            f"{(totals['lat_yes_sum']-totals['lat_no_sum'])/n*1000:+5.0f}ms"
        )
    print()

    # ── Per-signal recall breakdown ─────────────────────────────────
    # Which retriever (vector / bm25 / graph) surfaced each hit? Reported
    # per shape and overall, for both HyDE arms. Misses contribute to the
    # `none` column so the rows sum to n.
    signal_buckets = ("vector", "bm25", "graph", "unknown", "none")

    def _bucket(rows_subset: list[dict], arm: str) -> dict[str, int]:
        counts: dict[str, int] = {b: 0 for b in signal_buckets}
        for r in rows_subset:
            if not r[arm]["matched"]:
                counts["none"] += 1
                continue
            sig = r[arm]["signal"] or "unknown"
            counts[sig] = counts.get(sig, 0) + 1
        return counts

    print()
    print("Per-signal recall (which retriever surfaced each hit):")
    header = f"{'shape':22s} {'arm':>4s} " + " ".join(f"{b:>7s}" for b in signal_buckets)
    print(header)
    print("-" * len(header))
    per_signal_summary: dict[str, dict] = {}
    for shape, group in sorted(by_shape.items()):
        for arm, label in (("no_hyde", "off"), ("yes_hyde", "on")):
            counts = _bucket(group, arm)
            per_signal_summary.setdefault(shape, {})[arm] = counts
            cells = " ".join(f"{counts[b]:7d}" for b in signal_buckets)
            print(f"{shape:22s} {label:>4s} {cells}")
    print("-" * len(header))
    overall_signal: dict[str, dict[str, int]] = {}
    for arm, label in (("no_hyde", "off"), ("yes_hyde", "on")):
        counts = _bucket(rows, arm)
        overall_signal[arm] = counts
        cells = " ".join(f"{counts[b]:7d}" for b in signal_buckets)
        print(f"{'OVERALL':22s} {label:>4s} {cells}")
    print()

    # ── Delta-state breakdown ──
    state_counts = defaultdict(int)
    for r in rows:
        state_counts[r["delta_state"]] += 1
    print("State transitions (HyDE off → on):")
    for state in ("rescued", "regressed", "tied_hit", "tied_miss"):
        print(f"  {state:10s} {state_counts[state]:3d}")

    # ── MRR summary block for JSON output ─────────────────────────────
    # Per-shape and overall MRR mirroring the printed table — consumers
    # plotting trends over time read this rather than re-parsing the rows.
    mrr_by_shape: dict[str, dict[str, float]] = {}
    for shape, group in by_shape.items():
        mrr_by_shape[shape] = {
            "no_hyde": round(_mrr(group, "no_hyde"), 4),
            "yes_hyde": round(_mrr(group, "yes_hyde"), 4),
            "n": len(group),
        }
    mrr_overall = {
        "no_hyde": round(totals["rr_no_sum"] / n, 4) if n else 0.0,
        "yes_hyde": round(totals["rr_yes_sum"] / n, 4) if n else 0.0,
        "n": n,
    }

    if args.out:
        Path(args.out).write_text(
            json.dumps(
                {
                    "summary": dict(state_counts),
                    "signal_summary": {
                        "overall": overall_signal,
                        "by_shape": per_signal_summary,
                    },
                    "mrr": {
                        "overall": mrr_overall,
                        "by_shape": mrr_by_shape,
                    },
                    "rows": rows,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\nFull result JSON: {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
