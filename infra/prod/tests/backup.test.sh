#!/usr/bin/env bash
# D-03: backup.sh with fake `docker` and `curl` (no server, no network). Covers the good path and every way a
# backup can go wrong, and that the SAS token never reaches a command line or a log.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$HERE/../backup.sh"
pass=0 fail=0
SAS='sv=2022-11-02&sr=c&sig=SECRETSIGNATURE%2Bvalue&sp=racwl'

check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }
setup() {
  T="$(mktemp -d)"
  export APP_DIR="$T/app" PG_CONTAINER=fakepg FAKE_DIR="$T/fake" OUT="$T/out"
  mkdir -p "$APP_DIR/state" "$FAKE_DIR" "$T/bin"
  printf 'BACKUP_URL=https://codearenabk.blob.core.windows.net/backups\nBACKUP_SAS=%s\n' "$SAS" > "$APP_DIR/backup.env"
  chmod 600 "$APP_DIR/backup.env"
  cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_DIR/docker.log"
case "$*" in
  *pg_dump*) [ "${FAKE_DUMP_FAIL:-}" = 1 ] && exit 1; head -c "${FAKE_DUMP_BYTES:-4096}" /dev/zero | tr '\0' 'x' ;;
  *"pg_restore --list"*) cat > /dev/null; [ "${FAKE_NO_DATA:-}" = 1 ] && echo "; no data" || echo "215; 0 16385 TABLE DATA public users codearena" ;;
esac
exit 0
F
  cat > "$T/bin/curl" <<'F'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_DIR/curl-argv.log"
cfg="$(cat)"; printf '%s\n----\n' "$cfg" >> "$FAKE_DIR/curl-config.log"
method="$(sed -n 's/^request = "\(.*\)"/\1/p' <<< "$cfg")"
file="$(sed -n 's/^upload-file = "\(.*\)"/\1/p' <<< "$cfg")"
if [ "$method" = PUT ]; then
  [ "${FAKE_PUT_FAIL:-}" = 1 ] && exit 22
  stat -c %s "$file" > "$FAKE_DIR/blob-size"
  sed -n 's/^header = "x-ms-meta-sha256: \(.*\)"/\1/p' <<< "$cfg" > "$FAKE_DIR/blob-sha"
  exit 0
fi
printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nx-ms-meta-sha256: %s\r\n\r\n' "${FAKE_HEAD_SIZE:-$(cat "$FAKE_DIR/blob-size")}" "${FAKE_HEAD_SHA:-$(cat "$FAKE_DIR/blob-sha")}"
F
  chmod +x "$T/bin/docker" "$T/bin/curl"
  export PATH="$T/bin:$PATH"
}
teardown() { rm -rf "$T"; unset FAKE_DUMP_FAIL FAKE_DUMP_BYTES FAKE_NO_DATA FAKE_PUT_FAIL FAKE_HEAD_SIZE FAKE_HEAD_SHA; }
metric() { grep "^$1 " "$APP_DIR/state/backup.prom" 2>/dev/null | cut -d' ' -f2; }
uploaded() { [ -f "$FAKE_DIR/blob-size" ]; }
run() { "$BACKUP" "$@" > "$OUT" 2>&1; }

echo "D-03: backup.sh"

echo "- good run"
setup
run; rc=$?
name="$(cat "$APP_DIR/state/last-backup" 2>/dev/null)"
check "exits 0" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "blob is pg/codearena-<UTC time>.dump" "$([[ "$name" =~ ^pg/codearena-[0-9]{8}T[0-9]{6}Z\.dump$ ]] && echo 0 || echo 1)"
check "uploaded to the configured container, as a block blob" "$(grep -q 'url = "https://codearenabk.blob.core.windows.net/backups/pg/codearena-' "$FAKE_DIR/curl-config.log" && grep -q 'x-ms-blob-type: BlockBlob' "$FAKE_DIR/curl-config.log" && echo 0 || echo 1)"
check "the checksum sent is the real SHA-256 of the dump (4096 x's)" "$([ "$(cat "$FAKE_DIR/blob-sha")" = "$(head -c 4096 /dev/zero | tr '\0' 'x' | sha256sum | cut -d' ' -f1)" ] && echo 0 || echo 1)"
check "success metric is 1 with the size" "$([ "$(metric codearena_backup_last_run_success)" = 1 ] && [ "$(metric codearena_backup_last_size_bytes)" = 4096 ] && echo 0 || echo 1)"
check "the SAS is not on any command line" "$(! grep -q 'SECRETSIGNATURE\|sig=' "$FAKE_DIR/curl-argv.log" && ! grep -q 'SECRETSIGNATURE' "$FAKE_DIR/docker.log" && echo 0 || echo 1)"
check "the SAS is not in the output or the metrics" "$(! grep -q 'SECRETSIGNATURE' "$OUT" && ! grep -q 'SECRETSIGNATURE' "$APP_DIR/state/backup.prom" && echo 0 || echo 1)"
check "the SAS is sent to curl on stdin" "$(grep -q 'SECRETSIGNATURE' "$FAKE_DIR/curl-config.log" && echo 0 || echo 1)"
check "the temporary dump is removed" "$([ -z "$(ls -d "$APP_DIR"/state/backup.?????? 2>/dev/null)" ] && echo 0 || echo 1)"
check "it dumps from the codearena database in custom format" "$(grep -q 'exec fakepg pg_dump -U codearena -d codearena -Fc' "$FAKE_DIR/docker.log" && echo 0 || echo 1)"
teardown

echo "- manual backup label"
setup
run --label pre-c1; rc=$?
check "the label is part of the blob name" "$([ $rc = 0 ] && [[ "$(cat "$APP_DIR/state/last-backup")" =~ -pre-c1\.dump$ ]] && echo 0 || echo 1)"
run --label 'Bad Label;rm'; rc=$?
check "an unsafe label is refused (exit 2)" "$([ $rc = 2 ] && echo 0 || echo 1)"
run --bogus; rc=$?
check "unknown arguments are refused (exit 2)" "$([ $rc = 2 ] && echo 0 || echo 1)"
teardown

echo "- failures"
setup; export FAKE_DUMP_FAIL=1
run; rc=$?
check "pg_dump failure: exit 1, nothing uploaded, failure metric" "$([ $rc = 1 ] && ! uploaded && [ "$(metric codearena_backup_last_run_success)" = 0 ] && echo 0 || echo 1)"
teardown

setup; export FAKE_DUMP_BYTES=100
run; rc=$?
check "a dump under 1 KiB is refused, not uploaded" "$([ $rc = 1 ] && ! uploaded && grep -q 'refusing to upload' "$OUT" && echo 0 || echo 1)"
teardown

setup; export FAKE_NO_DATA=1
run; rc=$?
check "a dump with no table data is refused, not uploaded" "$([ $rc = 1 ] && ! uploaded && echo 0 || echo 1)"
teardown

setup; export FAKE_PUT_FAIL=1
run; rc=$?
check "upload failure: exit 1 and a failure metric" "$([ $rc = 1 ] && [ "$(metric codearena_backup_last_run_success)" = 0 ] && echo 0 || echo 1)"
teardown

setup; export FAKE_HEAD_SIZE=1
run; rc=$?
check "a size mismatch after upload fails the run" "$([ $rc = 1 ] && grep -q 'does not match' "$OUT" && echo 0 || echo 1)"
teardown

setup; export FAKE_HEAD_SHA=deadbeef
run; rc=$?
check "a checksum mismatch after upload fails the run" "$([ $rc = 1 ] && grep -q 'checksum' "$OUT" && [ ! -f "$APP_DIR/state/last-backup" ] && echo 0 || echo 1)"
teardown

setup
run; first="$(metric codearena_backup_last_success_timestamp_seconds)"
export FAKE_PUT_FAIL=1; run
check "a failed run keeps the last-success time (so alerts can see its age)" "$([ -n "$first" ] && [ "$(metric codearena_backup_last_success_timestamp_seconds)" = "$first" ] && [ "$(metric codearena_backup_last_run_success)" = 0 ] && echo 0 || echo 1)"
teardown

echo "- configuration"
setup; rm "$APP_DIR/backup.env"
run; rc=$?
check "no backup.env: exit 1 with a pointer to enable-backups.sh" "$([ $rc = 1 ] && grep -q enable-backups "$OUT" && echo 0 || echo 1)"
teardown

setup; printf 'BACKUP_URL=https://evil.example.com/x\nBACKUP_SAS=%s\n' "$SAS" > "$APP_DIR/backup.env"
run; rc=$?
check "a URL that is not an Azure blob container is refused (the SAS is never sent elsewhere)" "$([ $rc = 1 ] && [ ! -f "$FAKE_DIR/curl-argv.log" ] && echo 0 || echo 1)"
teardown

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
