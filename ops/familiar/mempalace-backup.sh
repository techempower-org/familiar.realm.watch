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
DB_CONTAINER="mempalace-db"
DB_USER="palace"
DB_NAME="mempalace_2026_05_13"
# Healthy dumps are ~1.1G; anything tiny means pg_dump died mid-stream.
MIN_DUMP_BYTES=$((10 * 1024 * 1024))

# Wait for postgres before dumping. With Persistent=true, a missed 02:15 run
# fires at boot — before docker has mempalace-db accepting connections — and
# pg_dump gets "Connection refused" (the 2026-06-09 20-byte-dump incident).
waited=0
until docker exec "$DB_CONTAINER" pg_isready -q -U "$DB_USER" -d "$DB_NAME" 2>/dev/null; do
    if [ "$waited" -ge 300 ]; then
        echo "[$(date)] ERROR: $DB_CONTAINER not ready after ${waited}s; aborting" >&2
        exit 1
    fi
    sleep 5
    waited=$((waited + 5))
done

# Free host RAM during the dump. familiar (15.5G) is RAM-oversubscribed; with
# llama-server (~3.1G) running, a pg_dump COPY of the embedding-laden drawers
# table tips the host below earlyoom's ~10%-free threshold and the dump's
# postgres backend gets SIGTERM'd mid-COPY (familiar.realm.watch#87). Stop
# llama for the dump window, restore its PRIOR state afterward (so we never
# resurrect a deliberately-stopped llama, e.g. during a benchmark). kg-extract
# retries against the dead endpoint (mempalace#307), so no triples are lost.
llama_was_active="$(systemctl is-active "$LLAMA_SVC" 2>/dev/null || true)"
TMP="$BACKUP_DIR/.mempalace-$DATE.sql.gz.tmp"
cleanup() {
    if [ "$llama_was_active" = "active" ]; then
        systemctl start "$LLAMA_SVC" || true
    fi
    rm -f "$TMP"
}
trap cleanup EXIT

if [ "$llama_was_active" = "active" ]; then
    systemctl stop "$LLAMA_SVC"
fi

# Dump to a tmp file and promote only after validation, so a failed run can
# never leave a truncated/empty .sql.gz masquerading as a backup.
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --clean --if-exists \
    | gzip > "$TMP"

gzip -t "$TMP"
size=$(stat -c%s "$TMP")
if [ "$size" -lt "$MIN_DUMP_BYTES" ]; then
    echo "[$(date)] ERROR: dump is only ${size} bytes (< $MIN_DUMP_BYTES); not promoting" >&2
    exit 1
fi
mv "$TMP" "$BACKUP_DIR/mempalace-$DATE.sql.gz"

find "$BACKUP_DIR" -name 'mempalace-*.sql.gz' -mtime +$KEEP_DAYS -delete
echo "[$(date)] mempalace dump: $(du -h "$BACKUP_DIR/mempalace-$DATE.sql.gz" | cut -f1)"
