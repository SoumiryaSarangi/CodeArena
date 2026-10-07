#!/usr/bin/env bash
# Tests for judge/provision.sh with fake systemctl/journalctl: install, permissions, secrets not left
# behind, and rollback to the previous binary when the new worker does not start.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROVISION="$HERE/../judge/provision.sh"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }

setup() {
  T="$(mktemp -d)"
  export PROVISION_TEST=1 INCOMING="$T/in" BIN_DIR="$T/bin" ETC_DIR="$T/etc" UNIT_DIR="$T/units" START_TIMEOUT=2
  export FAKE_LOG="$T/calls.log" SYSTEMCTL="$T/fake-systemctl" JOURNALCTL="$T/fake-journalctl"
  mkdir -p "$INCOMING" "$BIN_DIR" "$ETC_DIR" "$UNIT_DIR"; : > "$FAKE_LOG"
  printf 'NEW-BINARY' > "$INCOMING/worker"
  printf 'REDIS_URL=redis://judge:secret@10.20.1.4:6379\n' > "$INCOMING/worker.env"
  printf '[Service]\n' > "$INCOMING/codearena-worker.service"
  cat > "$SYSTEMCTL" <<'F'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
case "$1" in is-active) [ "${FAKE_INACTIVE:-}" = 1 ] && exit 3 ;; esac
exit 0
F
  cat > "$JOURNALCTL" <<'F'
#!/usr/bin/env bash
# The worker logs one JSON line when it is up; "bad" binaries never do.
if [ "$(cat "$BIN_DIR/worker")" = "BAD-BINARY" ]; then echo 'worker: cannot reach redis'; else echo '{"level":"INFO","msg":"worker started","id":"judge-0"}'; fi
F
  chmod +x "$SYSTEMCTL" "$JOURNALCTL"
}
teardown() { rm -rf "$T"; unset FAKE_INACTIVE; }

echo "D-02: judge/provision.sh"

echo "- first install"
setup
"$PROVISION" >/dev/null 2>&1; rc=$?
check "exits 0 when the worker starts" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "binary installed, executable" "$([ "$(cat "$BIN_DIR/worker")" = NEW-BINARY ] && [ -x "$BIN_DIR/worker" ] && echo 0 || echo 1)"
check "settings file is 640 (service user only)" "$([ "$(stat -c %a "$ETC_DIR/worker.env")" = 640 ] && echo 0 || echo 1)"
check "unit installed" "$([ -f "$UNIT_DIR/codearena-worker.service" ] && echo 0 || echo 1)"
check "service enabled and restarted" "$(grep -q 'systemctl enable codearena-worker' "$FAKE_LOG" && grep -q 'systemctl restart codearena-worker' "$FAKE_LOG" && echo 0 || echo 1)"
check "the secrets are not left in the incoming directory" "$([ ! -e "$INCOMING/worker.env" ] && echo 0 || echo 1)"
check "no previous binary was invented" "$([ ! -e "$BIN_DIR/worker.prev" ] && echo 0 || echo 1)"
teardown

echo "- update keeps the previous binary"
setup
printf 'OLD-BINARY' > "$BIN_DIR/worker"; chmod 755 "$BIN_DIR/worker"
"$PROVISION" >/dev/null 2>&1
check "previous kept as worker.prev" "$([ "$(cat "$BIN_DIR/worker.prev")" = OLD-BINARY ] && [ "$(cat "$BIN_DIR/worker")" = NEW-BINARY ] && echo 0 || echo 1)"
teardown

echo "- a worker that does not start is rolled back"
setup
printf 'OLD-BINARY' > "$BIN_DIR/worker"; chmod 755 "$BIN_DIR/worker"
printf 'BAD-BINARY' > "$INCOMING/worker"
# the old binary logs "worker started"; the bad one does not
"$PROVISION" >"$T/out.txt" 2>&1; rc=$?
check "exits 1 so the pipeline fails" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "the previous binary is back in place" "$([ "$(cat "$BIN_DIR/worker")" = OLD-BINARY ] && echo 0 || echo 1)"
check "it says so" "$(grep -q 'rolled back: the previous worker is running again' "$T/out.txt" && echo 0 || echo 1)"
check "the secrets are still cleaned up" "$([ ! -e "$INCOMING/worker.env" ] && echo 0 || echo 1)"
teardown

echo "- a first install that does not start has nothing to go back to"
setup
printf 'BAD-BINARY' > "$INCOMING/worker"
"$PROVISION" >"$T/out.txt" 2>&1; rc=$?
check "exits 1 and says there is no previous binary" "$([ $rc = 1 ] && grep -q 'no previous binary' "$T/out.txt" && echo 0 || echo 1)"
teardown

echo "- the unit is not active"
setup
FAKE_INACTIVE=1 "$PROVISION" >/dev/null 2>&1; rc=$?
check "exits 1 if systemd says the service is not active" "$([ $rc = 1 ] && echo 0 || echo 1)"
teardown

echo "- missing inputs"
setup
rm "$INCOMING/worker.env"
"$PROVISION" >"$T/out.txt" 2>&1; rc=$?
check "refuses without the settings file and touches nothing" "$([ $rc = 1 ] && [ ! -e "$BIN_DIR/worker" ] && echo 0 || echo 1)"
teardown

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
