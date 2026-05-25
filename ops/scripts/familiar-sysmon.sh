#!/bin/bash
# Collect system metrics from familiar as JSON for wave-block custom mode.
# Usage: wave-block.py custom --title "FAMILIAR SYSMON" --cmd "bash ops/scripts/familiar-sysmon.sh" --interval 3
# The collector script is Syncthing'd to familiar via the repo.
ssh familiar "python3 /home/jp/Projects/familiar.realm.watch/ops/scripts/sysmon-collect.py"
