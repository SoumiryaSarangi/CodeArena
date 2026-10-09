#!/usr/bin/env bash
# PL-06: deploy-plag.sh (server side) and ci/deploy-plag.sh (pipeline side) with fake docker/ssh.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$HERE/../deploy-plag.sh"
CI="$HERE/../ci/deploy-plag.sh"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }
D() { printf "$1%.0s" $(seq 64); }
NEW="ghcr.io/o/codearena-plag@sha256:$(D b)"
OLD="ghcr.io/o/codearena-plag@sha256:$(D a)"
API="ghcr.io/o/codearena-api@sha256:$(D c)"

setup() {
  T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/app/state"
  export APP_DIR="$T/app" FAKE_LOG="$T/calls.log" SETTLE=0 PATH="$T/bin:$PATH"
  : > "$FAKE_LOG"
  printf 'POSTGRES_PASSWORD=x\nPLAG_SERVICE_TOKEN=tok\n' > "$APP_DIR/prod.env"
  printf '%s\n' "$API" > "$APP_DIR/state/current"
  printf '#!/usr/bin/env bash\necho "init-env $*" >> "$FAKE_LOG"\n' > "$APP_DIR/init-env.sh"; chmod +x "$APP_DIR/init-env.sh"
  cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
# like the real Compose file: every command fails to render without API_IMAGE
[ "$1" = compose ] && [ -z "${API_IMAGE:-}" ] && { echo "required variable API_IMAGE is missing a value" >&2; exit 1; }
echo "docker $* [PLAG_IMAGE=${PLAG_IMAGE:-} API_IMAGE=${API_IMAGE:-}]" >> "$FAKE_LOG"
case "$*" in
  *" pull plag"*) [ "${FAKE_PULL_FAIL:-}" = 1 ] && exit 1 ;;
  *" up -d"*) echo "${PLAG_IMAGE:-}" > "$FAKE_LOG.last" ;;
  *" ps "*) [ "$(cat "$FAKE_LOG.last" 2>/dev/null)" = "${FAKE_CRASH_IMAGE:-none}" ] || echo plag ;;
esac
exit 0
F
  chmod +x "$T/bin/docker"
}
teardown() { rm -rf "$T"; unset FAKE_PULL_FAIL FAKE_CRASH_IMAGE; }
has() { grep -qF -- "$1" "$FAKE_LOG"; }

echo "PL-06: deploy-plag.sh"

echo "- refuses anything not pinned by digest"
setup
for bad in "" "ghcr.io/o/codearena-plag:latest" "x@sha256:abc" "x@sha256:$(D a); rm -rf /"; do
  "$SERVER" "$bad" >/dev/null 2>&1; rc=$?
  check "rejects '${bad:0:30}'" "$([ $rc = 1 ] && [ ! -s "$FAKE_LOG" ] && echo 0 || echo 1)"
done
teardown

echo "- first start"
setup
"$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 0" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "records the running image" "$([ "$(cat "$APP_DIR/state/plag-current")" = "$NEW" ] && echo 0 || echo 1)"
check "starts only the plag service under its profile, without touching its dependencies" "$(has '--profile plag up -d --no-deps plag [PLAG_IMAGE='"$NEW" && echo 0 || echo 1)"
check "does not add a token or recreate the API when the token exists" "$(has init-env && echo 1 || { has 'up -d --no-deps api' && echo 1 || echo 0; })"
check "never touches caddy, postgres or the migration" "$(grep -qE 'caddy|postgres|migrate' "$FAKE_LOG" && echo 1 || echo 0)"
teardown

echo "- an older install without the token"
setup
printf 'POSTGRES_PASSWORD=x\n' > "$APP_DIR/prod.env"
"$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "adds the token and recreates the API (with the current release) exactly once" "$(has 'init-env ensure prod PLAG_SERVICE_TOKEN' && [ "$(grep -c 'up -d --no-deps api' "$FAKE_LOG")" = 1 ] && has "API_IMAGE=$API" && echo 0 || echo 1)"
teardown

echo "- the job does not stay up"
setup
printf '%s\n' "$OLD" > "$APP_DIR/state/plag-current"
FAKE_CRASH_IMAGE="$NEW" "$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "the previous image is put back" "$(has "plag [PLAG_IMAGE=$OLD" && echo 0 || echo 1)"
check "the recorded image is still the previous one" "$([ "$(cat "$APP_DIR/state/plag-current")" = "$OLD" ] && echo 0 || echo 1)"
teardown
setup
FAKE_CRASH_IMAGE="$NEW" "$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "with no previous image the job is stopped, nothing is recorded" "$([ $rc = 1 ] && has '--profile plag stop plag' && [ ! -f "$APP_DIR/state/plag-current" ] && echo 0 || echo 1)"
teardown
setup
FAKE_PULL_FAIL=1 "$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "a failed pull exits 1 and starts nothing" "$([ $rc = 1 ] && ! has 'up -d' && echo 0 || echo 1)"
teardown

echo "PL-06: ci/deploy-plag.sh"
setup
cat > "$T/bin/ssh" <<'F'
#!/usr/bin/env bash
echo "ssh $*" >> "$FAKE_LOG"
case "$*" in *"--password-stdin"*) cat > "$FAKE_LOG.stdin" ;; esac
case "$*" in *"deploy-plag.sh"*) exit "${FAKE_REMOTE_RC:-0}" ;; esac
exit 0
F
chmod +x "$T/bin/ssh"
export SSH_CONFIG=/x/config GHCR_USER=ayush GHCR_TOKEN=SECRET-TOKEN
PLAG_IMAGE_REF="$NEW" "$CI" >"$T/out" 2>&1; rc=$?
check "exits 0 and runs the server script with the digest" "$([ $rc = 0 ] && has "deploy-plag.sh '$NEW'" && echo 0 || echo 1)"
check "the registry token travels by stdin, never in an argument or the output" "$([ "$(cat "$FAKE_LOG.stdin")" = SECRET-TOKEN ] && ! has SECRET-TOKEN && ! grep -q SECRET-TOKEN "$T/out" && echo 0 || echo 1)"
check "logs out of the registry afterwards" "$(has 'docker logout ghcr.io' && echo 0 || echo 1)"
: > "$FAKE_LOG"
FAKE_REMOTE_RC=1 PLAG_IMAGE_REF="$NEW" "$CI" >/dev/null 2>&1; rc=$?
check "a failed start fails the step, and still logs out" "$([ $rc = 1 ] && has 'docker logout' && echo 0 || echo 1)"
PLAG_IMAGE_REF="ghcr.io/o/p:latest" "$CI" >/dev/null 2>&1
check "refuses an image that is not digest-pinned" "$([ $? = 1 ] && echo 0 || echo 1)"
teardown

echo "- the workflow keeps the job off and non-blocking"
wf="$HERE/../../../.github/workflows/deploy.yml"
check "plag jobs only run when PLAG_ENABLED is true" "$(grep -c "vars.PLAG_ENABLED == 'true'" "$wf" | grep -qx 1 && echo 0 || echo 1)"
check "both plag jobs are continue-on-error" "$([ "$(awk '/^  (plag-image|deploy-plag):/{f=1} f&&/continue-on-error: true/{n++; f=0} END{print n+0}' "$wf")" = 2 ] && echo 0 || echo 1)"
check "nothing else needs a plag job (the API/judge deploy cannot wait for it)" "$(grep -E '^\s+needs:.*plag' "$wf" | grep -vq 'plag-image' && echo 1 || echo 0)"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
