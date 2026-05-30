#!/bin/bash
# mempalace-backup.sh — nightly pg_dump of the mempalace postgres DB (#87).
#
# Deployed to /usr/local/bin/mempalace-backup.sh by
# ops/scripts/install-mempalace-backup.sh and driven by mempalace-backup.timer.
set -euo pipefail
BACKUP_DIR="/srv/backups/databases"
DATE=$(date +%Y%m%d)
KEEP_DAYS=7
LLAMA_SVC="llama-server-extractor.service"

# Free host RAM during the dump. familiar (15.5G) is RAM-oversubscribed; with
# llama-server (~3.1G) running, a pg_dump COPY of the embedding-laden drawers
# table tips the host below earlyoom's ~10%-free threshold and the dump's
# postgres backend gets SIGTERM'd mid-COPY (familiar.realm.watch#87). Stop
# llama for the dump window, restore its PRIOR state afterward (so we never
# resurrect a deliberately-stopped llama, e.g. during a benchmark). kg-extract
# retries against the dead endpoint (mempalace#307), so no triples are lost.
llama_was_active="$(systemctl is-active "$LLAMA_SVC" 2>/dev/null || true)"
restore_llama() {
    if [ "$llama_was_active" = "active" ]; then
        systemctl start "$LLAMA_SVC" || true
    fi
}
trap restore_llama EXIT

if [ "$llama_was_active" = "active" ]; then
    systemctl stop "$LLAMA_SVC"
fi

docker exec mempalace-db pg_dump -U palace -d mempalace_2026_05_13 \
    --clean --if-exists \
    | gzip > "$BACKUP_DIR/mempalace-$DATE.sql.gz"

find "$BACKUP_DIR" -name 'mempalace-*.sql.gz' -mtime +$KEEP_DAYS -delete
echo "[$(date)] mempalace dump: $(du -h "$BACKUP_DIR/mempalace-$DATE.sql.gz" | cut -f1)"
