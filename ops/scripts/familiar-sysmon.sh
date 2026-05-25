#!/bin/bash
# Collect system metrics from familiar as JSON for wave-block custom mode.
# Usage: wave-block.py custom --title "FAMILIAR SYSMON" --cmd "bash ops/scripts/familiar-sysmon.sh" --interval 3
ssh familiar "python3 /tmp/sysmon-collect.py"
