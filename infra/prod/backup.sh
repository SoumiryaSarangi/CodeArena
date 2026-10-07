#!/usr/bin/env bash
# D-03: one Postgres backup, from the API VM to the private Azure Blob container.
#   backup.sh                   nightly (systemd timer codearena-backup.timer, 03:00 IST)
#   backup.sh --label pre-c1    manual, e.g. before and after each contest (name gets the label)
#
# What it does: pg_dump (custom format) from the running Postgres container -> checks the dump can be read
# back (pg_restore --list shows table data) -> uploads it with the container SAS -> reads the blob's size and
# SHA-256 back and compares. Any failed step exits 1, writes a failed-run metric and leaves nothing behind.
# The SAS lives in $APP_DIR/backup.env (mode 600, written by enable-backups.sh) and is handed to curl on
# stdin, so it never appears on a command line, in `ps`, or in a log.
#
# Retention is Azure's lifecycle rule (Terraform: backup_retention_days, 30); the SAS cannot delete.
# Metrics (read by node_exporter's textfile collector or by hand): $APP_DIR/state/backup.prom
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/codearena}"
STATE="$APP_DIR/state"
ENV_FILE="$APP_DIR/backup.env"
MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"

log() { echo "[backup $(date -u +%H:%M:%S)] $*"; }
write_metric() { # ok(0|1) [size]
  mkdir -p "$STATE"
  local tmp="$STATE/.backup.prom.$$"
  {
    echo "# HELP codearena_backup_last_run_success 1 if the last backup run succeeded."
    echo "# TYPE codearena_backup_last_run_success gauge"
    echo "codearena_backup_last_run_success $1"
    if [ "$1" = 1 ]; then
      echo "# HELP codearena_backup_last_success_timestamp_seconds Unix time of the last good backup."
      echo "# TYPE codearena_backup_last_success_timestamp_seconds gauge"
      echo "codearena_backup_last_success_timestamp_seconds $(date +%s)"
      echo "# HELP codearena_backup_last_size_bytes Size of the last good backup."
      echo "# TYPE codearena_backup_last_size_bytes gauge"
      echo "codearena_backup_last_size_bytes ${2:-0}"
    elif [ -f "$STATE/backup.prom" ]; then
      grep -E '^(# (HELP|TYPE) codearena_backup_last_(success_timestamp|size)|codearena_backup_last_(success_timestamp_seconds|size_bytes) )' "$STATE/backup.prom" || true
    fi
  } > "$tmp"
  mv "$tmp" "$STATE/backup.prom"
}
tmpdir=""
cleanup() { [ -n "$tmpdir" ] && rm -rf "$tmpdir"; return 0; }
trap cleanup EXIT
die() { log "ERROR: $*" >&2; write_metric 0; exit 1; }

label=""
if [ "${1:-}" = "--label" ]; then
  label="${2:-}"
  [[ "$label" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "label must be lowercase letters, digits and dashes" >&2; exit 2; }
elif [ -n "${1:-}" ]; then
  echo "usage: backup.sh [--label name]" >&2; exit 2
fi

[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing (run infra/prod/enable-backups.sh from your machine)"
# Read the two settings as plain text. The file is never sourced: a SAS contains `&`, which a shell would act on.
BACKUP_URL="$(sed -n 's/^BACKUP_URL=//p' "$ENV_FILE" | head -1)"
BACKUP_SAS="$(sed -n 's/^BACKUP_SAS=//p' "$ENV_FILE" | head -1)"
[[ "$BACKUP_URL" =~ ^https://[a-z0-9]+\.blob\.core\.windows\.net/[a-z0-9-]+$ ]] || die "BACKUP_URL in backup.env is not an Azure blob container URL"
[[ "$BACKUP_SAS" =~ ^[A-Za-z0-9%\&=:._~+/-]+$ ]] || die "BACKUP_SAS in backup.env is empty or has unexpected characters"

# curl with the URL and headers on stdin (keeps the SAS out of argv). args: METHOD URL-SUFFIX [curl-config lines...]
blob() {
  local method="$1" suffix="$2"; shift 2
  { printf 'url = "%s/%s?%s"\n' "$BACKUP_URL" "$suffix" "$BACKUP_SAS"
    printf 'request = "%s"\n' "$method"
    printf '%s\n' "$@"
  } | curl -fsS --retry 3 --retry-delay 5 --connect-timeout 20 -K -
}

pg="${PG_CONTAINER:-}"
if [ -z "$pg" ]; then
  export API_IMAGE="${API_IMAGE:-$(cat "$STATE/current" 2>/dev/null || echo unused)}"
  pg="$(cd "$APP_DIR" && docker compose --env-file prod.env -f docker-compose.yml ps -q postgres)"
fi
[ -n "$pg" ] || die "the postgres container is not running"

mkdir -p "$STATE"
tmpdir="$(mktemp -d "$STATE/backup.XXXXXX")"
name="pg/codearena-$(date -u +%Y%m%dT%H%M%SZ)${label:+-$label}.dump"
dump="$tmpdir/dump"

log "dumping the database to a temporary file"
docker exec "$pg" pg_dump -U codearena -d codearena -Fc > "$dump" || die "pg_dump failed"
size="$(stat -c %s "$dump")"
[ "$size" -ge "$MIN_BYTES" ] || die "the dump is only $size bytes: refusing to upload it"

log "checking the dump can be read back"
docker exec -i "$pg" pg_restore --list < "$dump" > "$tmpdir/toc" || die "pg_restore cannot read the dump"
grep -q 'TABLE DATA' "$tmpdir/toc" || die "the dump lists no table data"

sha="$(sha256sum "$dump" | cut -d' ' -f1)"
log "uploading $name ($size bytes)"
blob PUT "$name" "upload-file = \"$dump\"" 'header = "x-ms-blob-type: BlockBlob"' "header = \"x-ms-meta-sha256: $sha\"" >/dev/null \
  || die "upload failed"

log "verifying the uploaded blob"
head="$(blob HEAD "$name" 'head = true' 'include = true' 2>/dev/null)" || die "could not read the uploaded blob back"
remote_size="$(printf '%s' "$head" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
remote_sha="$(printf '%s' "$head" | tr -d '\r' | awk 'tolower($1)=="x-ms-meta-sha256:"{print $2}')"
[ "$remote_size" = "$size" ] || die "uploaded size $remote_size does not match the dump ($size)"
[ "$remote_sha" = "$sha" ] || die "uploaded checksum does not match the dump"

printf '%s\n' "$name" > "$STATE/last-backup"
write_metric 1 "$size"
log "done: $name ($size bytes, sha256 $sha)"
