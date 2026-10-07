#!/usr/bin/env bash
# Deploys one API image on the API VM and rolls back by itself if it does not come up healthy.
# Runs ON the server (the pipeline calls it over SSH):  ./deploy.sh ghcr.io/owner/codearena-api@sha256:<digest>
#
# Order: pull -> make sure postgres/redis/s3 are up -> migrate with the NEW image -> switch the API
# -> health check -> (if unhealthy) switch back to the previous image. A failed migration stops
# before the running API is touched. Migrations must therefore be additive (the old release has to
# keep working on the new schema if we roll back); see docs/runbooks/deploy.md.
#
# Exit codes: 0 deployed · 1 deploy failed but the previous release is running again (or there was
# nothing to roll back to) · 2 deploy failed and the rollback is not healthy either.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/codearena}"
STATE="$APP_DIR/state"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health/ready}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"
# Rollback drill: make the NEW release look unhealthy so the automatic rollback can be tested for real.
FORCE_UNHEALTHY="${FORCE_UNHEALTHY:-}"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }

new="${1:-}"
# Only an image pinned by digest is accepted: a tag can move, a digest cannot, and the value comes
# from CI so it is validated before it reaches a shell or Compose.
[[ "$new" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || die "image must be <repo>@sha256:<64 hex> (got: ${new:-nothing})"

mkdir -p "$STATE"
exec 9>"$STATE/deploy.lock"
flock -n 9 || die "another deploy is running"

compose() { (cd "$APP_DIR" && docker compose --env-file prod.env -f docker-compose.yml "$@"); }
previous="$(cat "$STATE/current" 2>/dev/null || true)"

healthy() { # $1 = new|previous
  local url="$HEALTH_URL"
  [ "$1" = new ] && [ "$FORCE_UNHEALTHY" = 1 ] && url="${HEALTH_URL%/*}/__rollback_drill__"
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then return 0; fi
    sleep "$HEALTH_INTERVAL"; waited=$((waited + HEALTH_INTERVAL))
  done
  return 1
}

log "deploying $new (previous: ${previous:-none})"
export API_IMAGE="$new"

compose pull api caddy || die "could not pull images"
compose up -d postgres redis s3
compose run --rm s3-init || die "bucket check failed"
if ! compose run --rm migrate; then
  die "migration failed; the running API was not touched"
fi
compose up -d api caddy

# Caddy reads its Caddyfile once, and `compose up` does not recreate a container because a
# bind-mounted file changed, so an edited Caddyfile would never reach the server by itself. After a
# healthy release the edge is checked: when the Caddyfile differs from the one it was last started
# with, it is validated and, if valid, the edge is recreated (certificates live in a volume). A
# failure here never fails the deploy: the release is healthy and the old edge keeps serving.
edge() {
  local sum
  sum="$(sha256sum "$APP_DIR/Caddyfile" | cut -d' ' -f1)"
  [ "$(cat "$STATE/caddyfile.sha" 2>/dev/null || true)" = "$sum" ] && return 0
  if ! compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    log "WARNING: the new Caddyfile does not validate; the edge keeps its old configuration"
    return 0
  fi
  if compose up -d --force-recreate --no-deps caddy; then
    printf '%s\n' "$sum" > "$STATE/caddyfile.sha"
    log "the edge was recreated with the new Caddyfile"
  else
    log "WARNING: the edge could not be recreated (docker compose logs caddy)"
  fi
}

if healthy new; then
  printf '%s\n' "$previous" > "$STATE/previous"
  printf '%s\n' "$new" > "$STATE/current"
  docker image prune -f >/dev/null 2>&1 || true
  edge
  log "healthy: $new is live"
  exit 0
fi

log "the new release is NOT healthy"
if [ -z "$previous" ]; then
  log "there is no previous release to go back to; leaving the new one up for inspection (docker compose logs api)"
  exit 1
fi
log "rolling back to $previous"
export API_IMAGE="$previous"
compose up -d api
if healthy previous; then
  log "rolled back: $previous is live again; $new was NOT deployed"
  exit 1
fi
log "ROLLBACK IS NOT HEALTHY EITHER: manual intervention needed (docker compose logs api)"
exit 2
