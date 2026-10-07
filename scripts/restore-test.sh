#!/usr/bin/env bash
# D-03: proves a backup can actually be restored (NFR-REL-04: run it weekly; a backup nobody has restored is a hope).
#   scripts/restore-test.sh --latest            newest dump in the Blob container (needs $APP_DIR/backup.env)
#   scripts/restore-test.sh --file path.dump    a dump you already have
#
# It starts a throwaway Postgres container with no published port and a random password, restores the dump into
# it, and passes only if every table in the dump exists afterwards and `users` has rows (an empty restore is not
# a pass). It prints each table's row count, then removes the container whatever happens. It never touches the
# live database.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/codearena}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"
REQUIRE_ROWS_IN="${REQUIRE_ROWS_IN:-users}"   # set empty to skip (fresh install)

METRIC_FILE="${METRIC_FILE:-}"   # e.g. /opt/codearena/state/restore-test.prom (weekly timer sets it)
write_metric() { # ok(0|1)
  [ -n "$METRIC_FILE" ] || return 0
  {
    echo "# HELP codearena_restore_test_last_run_success 1 if the last restore test passed."
    echo "# TYPE codearena_restore_test_last_run_success gauge"
    echo "codearena_restore_test_last_run_success $1"
    if [ "$1" = 1 ]; then
      echo "# HELP codearena_restore_test_last_success_timestamp_seconds Unix time of the last passing restore test."
      echo "# TYPE codearena_restore_test_last_success_timestamp_seconds gauge"
      echo "codearena_restore_test_last_success_timestamp_seconds $(date +%s)"
    elif [ -f "$METRIC_FILE" ]; then
      grep -E 'last_success_timestamp' "$METRIC_FILE" || true
    fi
  } > "$METRIC_FILE.tmp" && mv "$METRIC_FILE.tmp" "$METRIC_FILE"
}
die() { echo "restore-test: FAIL: $*" >&2; write_metric 0; exit 1; }
log() { echo "restore-test: $*"; }

mode="${1:-}" file="${2:-}"
case "$mode" in
  --file) [ -f "$file" ] || die "no such file: $file" ;;
  --latest) ;;
  *) echo "usage: restore-test.sh --latest | --file path.dump" >&2; exit 2 ;;
esac

tmp="$(mktemp -d)"
cid=""
cleanup() { [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1; rm -rf "$tmp"; return 0; }
trap cleanup EXIT

if [ "$mode" = "--latest" ]; then
  [ -f "$APP_DIR/backup.env" ] || die "$APP_DIR/backup.env is missing"
  # Plain-text read, never sourced: a SAS contains `&`.
  BACKUP_URL="$(sed -n 's/^BACKUP_URL=//p' "$APP_DIR/backup.env" | head -1)"
  BACKUP_SAS="$(sed -n 's/^BACKUP_SAS=//p' "$APP_DIR/backup.env" | head -1)"
  [[ "$BACKUP_URL" =~ ^https://[a-z0-9]+\.blob\.core\.windows\.net/[a-z0-9-]+$ ]] || die "BACKUP_URL in backup.env is not an Azure blob container URL"
  [ -n "$BACKUP_SAS" ] || die "BACKUP_SAS in backup.env is empty"
  blob() { # URL-suffix output-file ; the SAS goes to curl on stdin, not argv
    printf 'url = "%s/%s"\n' "$BACKUP_URL" "$1" | curl -fsS --retry 3 --connect-timeout 20 -K - -o "$2"
  }
  blob "?restype=container&comp=list&prefix=pg/&$BACKUP_SAS" "$tmp/list.xml" || die "could not list the backups"
  latest="$(grep -o '<Name>[^<]*</Name>' "$tmp/list.xml" | sed 's/<[^>]*>//g' | sort | tail -1)"
  [ -n "$latest" ] || die "the container has no backups under pg/"
  log "newest backup: $latest"
  blob "$latest?$BACKUP_SAS" "$tmp/dump" || die "could not download $latest"
  file="$tmp/dump"
fi

[ "$(stat -c %s "$file")" -ge 1024 ] || die "the dump is suspiciously small"

pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
cid="$(docker run -d -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=restore "$PG_IMAGE")" || die "could not start a throwaway Postgres"
for _ in $(seq 1 60); do
  docker exec "$cid" pg_isready -U postgres -d restore -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$cid" pg_isready -U postgres -d restore -h 127.0.0.1 >/dev/null 2>&1 || die "the throwaway Postgres did not become ready"

psql() { docker exec "$cid" psql -U postgres -d restore -h 127.0.0.1 -v ON_ERROR_STOP=1 -At "$@"; }

log "restoring"
docker exec -i "$cid" pg_restore -U postgres -d restore -h 127.0.0.1 --no-owner --no-privileges --exit-on-error < "$file" \
  || die "pg_restore reported errors"

# Every table in the dump's table of contents must exist now (a TOC line: "215; 1259 16385 TABLE public users codearena").
docker exec -i "$cid" pg_restore --list < "$file" | awk '$4=="TABLE" && $5!="DATA" {print $5"."$6}' | sort -u > "$tmp/expected"
[ -s "$tmp/expected" ] || die "the dump contains no tables"
psql -c "select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema')" | sort -u > "$tmp/restored"
missing="$(comm -23 "$tmp/expected" "$tmp/restored" | tr '\n' ' ')"
[ -z "$missing" ] || die "tables missing after restore: $missing"

total=0
while IFS= read -r t; do
  schema="${t%%.*}" table="${t#*.}"
  n="$(psql -c "select count(*) from \"$schema\".\"$table\"")"
  printf '  %-40s %s rows\n' "$t" "$n"
  total=$((total + n))
  if [ "$table" = "$REQUIRE_ROWS_IN" ] && [ "$schema" = public ] && [ "$n" -lt 1 ]; then die "$t is empty after restore"; fi
done < "$tmp/expected"
if [ -n "$REQUIRE_ROWS_IN" ] && ! grep -qx "public.$REQUIRE_ROWS_IN" "$tmp/expected"; then die "the dump has no public.$REQUIRE_ROWS_IN table"; fi

write_metric 1
log "PASS: $(wc -l < "$tmp/expected" | tr -d ' ') tables restored, $total rows"
