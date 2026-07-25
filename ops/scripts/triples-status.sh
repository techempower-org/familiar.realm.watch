#!/bin/bash
# Emits mempalace-kg-extract --status JSON enriched with progress bar + ETA
# for the wave-block custom dashboard.
#
# Usage: triples-status.sh {familiar|katana}
#
# Syncthing propagates this to familiar; both hosts run their local kg-extract
# venv. familiar mode ssh's there; katana mode runs locally.
set -euo pipefail

# Allow host via $1 (canonical) or inferred from $0 basename (e.g. when called
# as triples-familiar.sh / triples-katana.sh symlinks from a polling tool).
HOST="${1:-}"
if [ -z "$HOST" ]; then
  case "$(basename "$0")" in
    *familiar*) HOST=familiar ;;
    *katana*)   HOST=katana   ;;
  esac
fi

emit_status() {
  case "$HOST" in
    familiar)
      ssh familiar 'set -a; . ~/.mempalace/dsn.env; set +a; cd ~/kg-extract-deploy && .venv/bin/mempalace-kg-extract --status'
      ;;
    katana)
      cd ~/Projects/kg-extract-katana
      set -a
      . ~/.mempalace/dsn.env 2>/dev/null || . ~/.config/mempalace/kg-queue-dsn 2>/dev/null
      set +a
      .venv/bin/mempalace-kg-extract --status
      ;;
    *)
      echo "usage: $0 {familiar|katana}" >&2
      exit 2
      ;;
  esac
}

emit_status | python3 -c '
import json, sys
d = json.load(sys.stdin)
queue = d["queue_depth"]
done = d["completed_today"]
total = queue + done
pct = (done / total * 100) if total else 0.0
rate = d["drawers_per_min_5m"]
eta_min = queue / rate if rate else float("inf")
eta_h = eta_min / 60
W = 28
filled = int(W * pct / 100)
bar = "█" * filled + "░" * (W - filled)
d["progress"] = f"{bar} {pct:.1f}%"
d["eta_hours"] = f"{eta_h:.1f}h"
print(json.dumps(d, indent=2))
'
