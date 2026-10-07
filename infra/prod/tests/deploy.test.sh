#!/usr/bin/env bash
# Tests for deploy.sh with fake `docker` and `curl`, so every path (migration failure, health failure,
# rollback, the rollback drill, concurrent deploys) runs without a server. `bash infra/prod/tests/deploy.test.sh`
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$HERE/../deploy.sh"
pass=0 fail=0

NEW="ghcr.io/owner/codearena-api@sha256:$(printf 'b%.0s' $(seq 64))"
OLD="ghcr.io/owner/codearena-api@sha256:$(printf 'a%.0s' $(seq 64))"
OLDER="ghcr.io/owner/codearena-api@sha256:$(printf 'c%.0s' $(seq 64))"

setup() {
  T="$(mktemp -d)"
  export APP_DIR="$T/app" FAKE_LOG="$T/calls.log" FAKE_BAD_IMAGES="$T/bad_images"
  mkdir -p "$APP_DIR/state" "$T/bin"
  printf 'edge v1\n' > "$APP_DIR/Caddyfile"
  : > "$FAKE_LOG"; : > "$FAKE_BAD_IMAGES"
  # docker: records every call with the API_IMAGE it ran under; can fail on demand.
  cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
echo "docker $* [API_IMAGE=${API_IMAGE:-}]" >> "$FAKE_LOG"
case "$*" in
  *"run --rm migrate"*) [ "${FAKE_MIGRATE_FAIL:-}" = 1 ] && exit 1 ;;
  *" pull "*) [ "${FAKE_PULL_FAIL:-}" = 1 ] && exit 1 ;;
  *"caddy validate"*) [ "${FAKE_CADDY_INVALID:-}" = 1 ] && exit 1 ;;
esac
exit 0
F
  # curl: healthy unless the running image is listed as bad, or the URL is the drill URL.
  cat > "$T/bin/curl" <<'F'
#!/usr/bin/env bash
url="${*: -1}"
[[ "$url" == *__rollback_drill__* ]] && exit 22
grep -qxF "${API_IMAGE:-}" "$FAKE_BAD_IMAGES" && exit 22
exit 0
F
  chmod +x "$T/bin/docker" "$T/bin/curl"
  export PATH="$T/bin:$PATH" HEALTH_TIMEOUT=2 HEALTH_INTERVAL=1
}
teardown() { rm -rf "$T"; unset FAKE_MIGRATE_FAIL FAKE_PULL_FAIL FORCE_UNHEALTHY FAKE_CADDY_INVALID; }

check() { # name, condition result (0 = ok)
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi
}
has() { grep -qF -- "$1" "$FAKE_LOG"; }
current() { cat "$APP_DIR/state/current" 2>/dev/null || true; }

echo "D-02: deploy.sh"

echo "- refuses anything that is not a digest-pinned image"
setup
for bad in "" "ghcr.io/owner/codearena-api:latest" "ghcr.io/owner/codearena-api@sha256:abc" "x@sha256:$(printf 'a%.0s' $(seq 64)); rm -rf /" 'UPPER/Case@sha256:'"$(printf 'a%.0s' $(seq 64))"; do
  "$DEPLOY" "$bad" >/dev/null 2>&1; rc=$?
  check "rejects '${bad:0:40}'" "$([ $rc = 1 ] && [ ! -s "$FAKE_LOG" ] && echo 0 || echo 1)"
done
teardown

echo "- first deploy"
setup
"$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 0" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "records the live image" "$([ "$(current)" = "$NEW" ] && echo 0 || echo 1)"
migrate_line="$(grep -n 'run --rm migrate' "$FAKE_LOG" | head -1 | cut -d: -f1)"
switch_line="$(grep -n 'up -d api caddy' "$FAKE_LOG" | head -1 | cut -d: -f1)"
check "migrates BEFORE switching the API" "$([ -n "$migrate_line" ] && [ -n "$switch_line" ] && [ "$migrate_line" -lt "$switch_line" ] && echo 0 || echo 1)"
check "the database, queue and storage are started before the migration" "$(grep -n 'up -d postgres redis s3' "$FAKE_LOG" | head -1 | cut -d: -f1 | awk -v m="$migrate_line" '{print ($1 < m) ? 0 : 1}')"
check "runs under the env file and the compose file" "$(has '--env-file prod.env -f docker-compose.yml' && echo 0 || echo 1)"
teardown

echo "- second deploy remembers the previous release"
setup
echo "$OLD" > "$APP_DIR/state/current"
"$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 0" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "current is the new image" "$([ "$(current)" = "$NEW" ] && echo 0 || echo 1)"
check "previous is the old image" "$([ "$(cat "$APP_DIR/state/previous")" = "$OLD" ] && echo 0 || echo 1)"
teardown

echo "- a failed migration leaves the running API alone"
setup
echo "$OLD" > "$APP_DIR/state/current"
FAKE_MIGRATE_FAIL=1 "$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "never switches the API" "$(has 'up -d api caddy' && echo 1 || echo 0)"
check "current is unchanged" "$([ "$(current)" = "$OLD" ] && echo 0 || echo 1)"
teardown

echo "- a failed pull changes nothing"
setup
echo "$OLD" > "$APP_DIR/state/current"
FAKE_PULL_FAIL=1 "$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1 without starting anything" "$([ $rc = 1 ] && ! has 'up -d' && echo 0 || echo 1)"
teardown

echo "- an unhealthy release is rolled back automatically"
setup
echo "$OLD" > "$APP_DIR/state/current"
echo "$NEW" > "$FAKE_BAD_IMAGES"
"$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1 (deploy failed, but we are safe)" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "switches the API back to the previous image" "$(has "up -d api [API_IMAGE=$OLD]" && echo 0 || echo 1)"
check "current still names the previous image" "$([ "$(current)" = "$OLD" ] && echo 0 || echo 1)"
teardown

echo "- first deploy that is unhealthy: nothing to go back to"
setup
echo "$NEW" > "$FAKE_BAD_IMAGES"
"$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "does not record it as current" "$([ -z "$(current)" ] && echo 0 || echo 1)"
check "does not try a rollback" "$(has "up -d api [API_IMAGE=]" && echo 1 || echo 0)"
teardown

echo "- the rollback is unhealthy too"
setup
echo "$OLD" > "$APP_DIR/state/current"
printf '%s\n%s\n' "$NEW" "$OLD" > "$FAKE_BAD_IMAGES"
"$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 2 (needs a human)" "$([ $rc = 2 ] && echo 0 || echo 1)"
teardown

echo "- the rollback drill (FORCE_UNHEALTHY=1) proves rollback with a perfectly good image"
setup
echo "$OLD" > "$APP_DIR/state/current"
FORCE_UNHEALTHY=1 "$DEPLOY" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1 because the drill made the new release look unhealthy" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "rolled back to the previous image" "$(has "up -d api [API_IMAGE=$OLD]" && echo 0 || echo 1)"
check "the previous release is the one still recorded as live" "$([ "$(current)" = "$OLD" ] && echo 0 || echo 1)"
teardown

echo "- a changed Caddyfile reaches the edge (it is a bind mount: compose would not notice)"
setup
"$DEPLOY" "$NEW" >"$T/out.txt" 2>&1; rc=$?
check "the first deploy validates the Caddyfile and recreates the edge once" "$([ $rc = 0 ] && has 'caddy validate --config /etc/caddy/Caddyfile' && has 'up -d --force-recreate --no-deps caddy' && echo 0 || echo 1)"
check "the Caddyfile that was applied is remembered" "$([ "$(cat "$APP_DIR/state/caddyfile.sha")" = "$(sha256sum "$APP_DIR/Caddyfile" | cut -d' ' -f1)" ] && echo 0 || echo 1)"
: > "$FAKE_LOG"
"$DEPLOY" "$NEW" >/dev/null 2>&1
check "an unchanged Caddyfile does not touch the edge again" "$(! has 'force-recreate' && ! has 'caddy validate' && echo 0 || echo 1)"
printf 'edge v2\n' > "$APP_DIR/Caddyfile"
: > "$FAKE_LOG"
"$DEPLOY" "$NEW" >"$T/out.txt" 2>&1
check "an edited Caddyfile recreates the edge" "$(has 'up -d --force-recreate --no-deps caddy' && grep -q 'edge was recreated' "$T/out.txt" && echo 0 || echo 1)"
printf 'edge v3 (broken)\n' > "$APP_DIR/Caddyfile"
: > "$FAKE_LOG"
FAKE_CADDY_INVALID=1 "$DEPLOY" "$NEW" >"$T/out.txt" 2>&1; rc=$?
check "a Caddyfile that does not validate is left out, the deploy still succeeds, and it says so" "$([ $rc = 0 ] && ! has 'force-recreate' && grep -q 'does not validate' "$T/out.txt" && [ "$(cat "$APP_DIR/state/caddyfile.sha")" != "$(sha256sum "$APP_DIR/Caddyfile" | cut -d' ' -f1)" ] && echo 0 || echo 1)"
teardown

echo "- a rolled-back release does not touch the edge"
setup
echo "$OLD" > "$APP_DIR/state/current"
FORCE_UNHEALTHY=1 "$DEPLOY" "$NEW" >/dev/null 2>&1
check "no validation and no recreation when the release is rejected" "$(! has 'caddy validate' && ! has 'force-recreate' && echo 0 || echo 1)"
teardown

echo "- two deploys cannot run at once"
setup
( exec 8>"$APP_DIR/state/deploy.lock"; flock 8; sleep 4 ) &
holder=$!
sleep 1
"$DEPLOY" "$NEW" >"$T/out.txt" 2>&1; rc=$?
check "the second deploy is refused" "$([ $rc = 1 ] && grep -q 'another deploy is running' "$T/out.txt" && ! has 'up -d' && echo 0 || echo 1)"
wait "$holder" 2>/dev/null
teardown

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
