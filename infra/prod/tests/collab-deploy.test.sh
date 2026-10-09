#!/usr/bin/env bash
# CP-DEPLOY: deploy-collab.sh (server side) and ci/deploy-collab.sh (pipeline side) with fake docker/ssh, and the
# workflow's gating. `bash infra/prod/tests/collab-deploy.test.sh`
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$HERE/../deploy-collab.sh"
CI="$HERE/../ci/deploy-collab.sh"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }
D() { printf "$1%.0s" $(seq 64); }
NEW="ghcr.io/o/codearena-collab@sha256:$(D b)"
OLD="ghcr.io/o/codearena-collab@sha256:$(D a)"
API="ghcr.io/o/codearena-api@sha256:$(D c)"

setup() {
  T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/app/state"
  export APP_DIR="$T/app" FAKE_LOG="$T/calls.log" HEALTH_TIMEOUT=1 HEALTH_INTERVAL=1 PATH="$T/bin:$PATH"
  : > "$FAKE_LOG"
  printf 'POSTGRES_PASSWORD=x\nCOLLAB_SERVICE_TOKEN=tok\nCOLLAB_URL=http://collab1:1234,http://collab2:1234\n' > "$APP_DIR/prod.env"
  printf '%s\n' "$API" > "$APP_DIR/state/current"
  printf '#!/usr/bin/env bash\necho "init-env $*" >> "$FAKE_LOG"\n' > "$APP_DIR/init-env.sh"; chmod +x "$APP_DIR/init-env.sh"
  # docker: records every call; remembers which image each service was last started with; a service is "healthy" unless
  # it runs FAKE_BAD_IMAGE (and, if FAKE_BAD_SVC is set, only that service).
  cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
# like the real Compose file: every compose command fails to render without API_IMAGE
[ "$1" = compose ] && [ -z "${API_IMAGE:-}" ] && { echo "required variable API_IMAGE is missing a value" >&2; exit 1; }
echo "docker $* [COLLAB_IMAGE=${COLLAB_IMAGE:-} API_IMAGE=${API_IMAGE:-}]" >> "$FAKE_LOG"
last() { echo "${!#}"; }
case "$*" in
  *" pull "*) [ "${FAKE_PULL_FAIL:-}" = 1 ] && exit 1 ;;
  *" up -d --no-deps collab"*) echo "${COLLAB_IMAGE:-}" > "$FAKE_LOG.img.$(last "$@")" ;;
  *" stop collab"*) rm -f "$FAKE_LOG.img.$(last "$@")" ;;
  *" ps -q "*) echo "cid-$(last "$@")" ;;
  inspect*)
    svc="${!#}"; svc="${svc#cid-}"
    img="$(cat "$FAKE_LOG.img.$svc" 2>/dev/null)"
    if [ -n "${FAKE_BAD_IMAGE:-}" ] && [ "$img" = "$FAKE_BAD_IMAGE" ] && { [ -z "${FAKE_BAD_SVC:-}" ] || [ "$svc" = "$FAKE_BAD_SVC" ]; }; then echo starting; else [ -n "$img" ] && echo healthy; fi ;;
esac
exit 0
F
  chmod +x "$T/bin/docker"
}
teardown() { rm -rf "$T"; unset FAKE_PULL_FAIL FAKE_BAD_IMAGE FAKE_BAD_SVC; }
has() { grep -qF -- "$1" "$FAKE_LOG"; }
img() { cat "$FAKE_LOG.img.$1" 2>/dev/null || true; }
line() { grep -nF -- "$1" "$FAKE_LOG" | head -1 | cut -d: -f1; }

echo "CP-DEPLOY: deploy-collab.sh"

echo "- refuses anything not pinned by digest"
setup
for bad in "" "ghcr.io/o/codearena-collab:latest" "x@sha256:abc" "x@sha256:$(D a); rm -rf /"; do
  "$SERVER" "$bad" >/dev/null 2>&1; rc=$?
  check "rejects '${bad:0:30}'" "$([ $rc = 1 ] && [ ! -s "$FAKE_LOG" ] && echo 0 || echo 1)"
done
teardown

echo "- first start: one instance at a time, each healthy before the next"
setup
"$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 0 and both instances run the new image" "$([ $rc = 0 ] && [ "$(img collab1)" = "$NEW" ] && [ "$(img collab2)" = "$NEW" ] && echo 0 || echo 1)"
check "records the running image" "$([ "$(cat "$APP_DIR/state/collab-current")" = "$NEW" ] && echo 0 || echo 1)"
c1="$(line 'up -d --no-deps collab1')"; c2="$(line 'up -d --no-deps collab2')"; h1="$(line 'ps -q collab1')"
check "collab1 is started and checked before collab2 is touched (a room always has a server)" "$([ -n "$c1" ] && [ -n "$c2" ] && [ -n "$h1" ] && [ "$c1" -lt "$h1" ] && [ "$h1" -lt "$c2" ] && echo 0 || echo 1)"
check "starts only the two instances, under their profile, without their dependencies" "$(has '--profile collab up -d --no-deps collab1' && has '--profile collab up -d --no-deps collab2' && echo 0 || echo 1)"
check "does not touch the API, caddy, postgres or the migration when the settings exist" "$(grep -qE 'up -d --no-deps api|caddy|postgres|migrate|init-env' "$FAKE_LOG" && echo 1 || echo 0)"
teardown

echo "- an older install without the settings"
setup
printf 'POSTGRES_PASSWORD=x\n' > "$APP_DIR/prod.env"
"$SERVER" "$NEW" >/dev/null 2>&1
check "adds the token and the instance addresses, and recreates the API (with the live release) once" "$(has 'init-env ensure prod COLLAB_SERVICE_TOKEN' && has 'init-env ensure prod COLLAB_URL http://collab1:1234,http://collab2:1234' && [ "$(grep -c 'up -d --no-deps api' "$FAKE_LOG")" = 1 ] && has "API_IMAGE=$API" && echo 0 || echo 1)"
check "the API is recreated before the first instance starts" "$([ "$(line 'up -d --no-deps api')" -lt "$(line 'up -d --no-deps collab1')" ] && echo 0 || echo 1)"
teardown

echo "- an update"
setup
printf '%s\n' "$OLD" > "$APP_DIR/state/collab-current"; echo "$OLD" > "$FAKE_LOG.img.collab1"; echo "$OLD" > "$FAKE_LOG.img.collab2"
"$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "moves both to the new image and records it" "$([ $rc = 0 ] && [ "$(img collab1)" = "$NEW" ] && [ "$(img collab2)" = "$NEW" ] && [ "$(cat "$APP_DIR/state/collab-current")" = "$NEW" ] && echo 0 || echo 1)"
teardown

echo "- an instance that does not become healthy"
setup
printf '%s\n' "$OLD" > "$APP_DIR/state/collab-current"; echo "$OLD" > "$FAKE_LOG.img.collab1"; echo "$OLD" > "$FAKE_LOG.img.collab2"
FAKE_BAD_IMAGE="$NEW" FAKE_BAD_SVC=collab2 "$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "exits 1 and BOTH instances are back on the previous image (never two versions)" "$([ $rc = 1 ] && [ "$(img collab1)" = "$OLD" ] && [ "$(img collab2)" = "$OLD" ] && echo 0 || echo 1)"
check "the recorded image is still the previous one" "$([ "$(cat "$APP_DIR/state/collab-current")" = "$OLD" ] && echo 0 || echo 1)"
teardown
setup
FAKE_BAD_IMAGE="$NEW" FAKE_BAD_SVC=collab1 "$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "the first instance failing stops the roll-out before collab2 is touched" "$([ $rc = 1 ] && ! has 'up -d --no-deps collab2' && echo 0 || echo 1)"
check "with no previous image the instances are stopped and nothing is recorded" "$([ -z "$(img collab1)" ] && has '--profile collab stop collab1' && [ ! -f "$APP_DIR/state/collab-current" ] && echo 0 || echo 1)"
teardown
setup
FAKE_PULL_FAIL=1 "$SERVER" "$NEW" >/dev/null 2>&1; rc=$?
check "a failed pull exits 1 and starts nothing" "$([ $rc = 1 ] && ! has 'up -d' && echo 0 || echo 1)"
teardown

echo "CP-DEPLOY: ci/deploy-collab.sh"
setup
cat > "$T/bin/ssh" <<'F'
#!/usr/bin/env bash
echo "ssh $*" >> "$FAKE_LOG"
case "$*" in *"--password-stdin"*) cat > "$FAKE_LOG.stdin" ;; esac
case "$*" in *"deploy-collab.sh"*) exit "${FAKE_REMOTE_RC:-0}" ;; esac
exit 0
F
chmod +x "$T/bin/ssh"
export SSH_CONFIG=/x/config GHCR_USER=ayush GHCR_TOKEN=SECRET-TOKEN
COLLAB_IMAGE_REF="$NEW" "$CI" >"$T/out" 2>&1; rc=$?
check "exits 0 and runs the server script with the digest" "$([ $rc = 0 ] && has "deploy-collab.sh '$NEW'" && echo 0 || echo 1)"
check "the registry token travels by stdin, never in an argument or the output" "$([ "$(cat "$FAKE_LOG.stdin")" = SECRET-TOKEN ] && ! has SECRET-TOKEN && ! grep -q SECRET-TOKEN "$T/out" && echo 0 || echo 1)"
check "logs out of the registry afterwards" "$(has 'docker logout ghcr.io' && echo 0 || echo 1)"
: > "$FAKE_LOG"
FAKE_REMOTE_RC=1 COLLAB_IMAGE_REF="$NEW" "$CI" >/dev/null 2>&1; rc=$?
check "a failed start fails the step, and still logs out" "$([ $rc = 1 ] && has 'docker logout' && echo 0 || echo 1)"
COLLAB_IMAGE_REF="ghcr.io/o/p:latest" "$CI" >/dev/null 2>&1
check "refuses an image that is not digest-pinned" "$([ $? = 1 ] && echo 0 || echo 1)"
teardown

echo "- the workflow keeps the collab jobs off and non-blocking"
wf="$HERE/../../../.github/workflows/deploy.yml"
check "collab jobs only run when COLLAB_ENABLED is true" "$(grep -c "vars.COLLAB_ENABLED == 'true'" "$wf" | grep -qx 1 && echo 0 || echo 1)"
check "both collab jobs are continue-on-error" "$([ "$(awk '/^  (collab-image|deploy-collab):/{f=1} f&&/continue-on-error: true/{n++; f=0} END{print n+0}' "$wf")" = 2 ] && echo 0 || echo 1)"
check "nothing else needs a collab job (the API/judge deploy cannot wait for it)" "$(grep -E '^\s+needs:.*collab' "$wf" | grep -vq 'collab-image' && echo 1 || echo 0)"
check "the image is built from the collab Dockerfile at the repository root" "$(grep -q 'file: apps/collab/Dockerfile' "$wf" && grep -A3 'file: apps/collab/Dockerfile' "$wf" >/dev/null && echo 0 || echo 1)"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
