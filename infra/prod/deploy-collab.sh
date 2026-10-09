#!/usr/bin/env bash
# Starts (or updates) the two collab servers of the interview pad on the API VM (CP-DEPLOY). Run by the pipeline after the API
# deploy, only when the repository variable COLLAB_ENABLED is "true"; never part of deploy.sh, so it cannot hold up or roll
# back an API release.
#
#   usage: deploy-collab.sh <image@sha256:digest>     env: APP_DIR (/opt/codearena), HEALTH_TIMEOUT (90 s), HEALTH_INTERVAL (3 s)
#
# 1. makes sure prod.env has COLLAB_SERVICE_TOKEN and COLLAB_URL (the API reads both); if either was just added the API is
#    recreated once so it picks them up,
# 2. pulls the image, then updates the instances ONE AT A TIME (collab1, then collab2), waiting for each to be healthy, so
#    a room is never without a server (clients reconnect to the other one, SD-§11.3),
# 3. if any instance does not become healthy, every instance goes back to the previous image (or is stopped when there was
#    none), so the two never run different versions for long.
# Exit 0 = both running the new image, 1 = it did not work (previous state restored).
set -euo pipefail
ref="${1:-}"
[[ "$ref" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "usage: deploy-collab.sh <image@sha256:digest> (pinned by digest)" >&2; exit 1; }
APP_DIR="${APP_DIR:-/opt/codearena}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"
STATE="$APP_DIR/state"
SERVICES=(collab1 collab2)
mkdir -p "$STATE"
log() { echo "[collab $(date -u +%H:%M:%S)] $*"; }
compose() { (cd "$APP_DIR" && docker compose --env-file prod.env -f docker-compose.yml "$@"); }
previous="$(cat "$STATE/collab-current" 2>/dev/null || true)"
# Compose renders the whole file for every command and the file requires API_IMAGE: always the live release.
API_IMAGE="$(cat "$STATE/current" 2>/dev/null || true)"
[ -n "$API_IMAGE" ] || { echo "no API release recorded in $STATE/current" >&2; exit 1; }
export API_IMAGE

changed=0
ensure() { # KEY VALUE: adds it to prod.env only if missing
  if ! grep -q "^$1=." "$APP_DIR/prod.env"; then
    (cd "$APP_DIR" && ./init-env.sh ensure prod "$1" "$2")
    changed=1
  fi
}
ensure COLLAB_SERVICE_TOKEN "$(openssl rand -hex 24)"
ensure COLLAB_URL "http://collab1:1234,http://collab2:1234"
if [ "$changed" = 1 ]; then
  log "settings added; recreating the API so it reads them"
  compose up -d --no-deps api
fi

up() { COLLAB_IMAGE="$1" compose --profile collab up -d --no-deps "$2"; }
healthy() { # waits for the service's own health check
  local waited=0 cid status
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    cid="$(compose --profile collab ps -q "$1" 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      [ "$status" = healthy ] && return 0
    fi
    sleep "$HEALTH_INTERVAL"
    waited=$((waited + HEALTH_INTERVAL))
  done
  return 1
}

log "pulling $ref"
COLLAB_IMAGE="$ref" compose --profile collab pull "${SERVICES[0]}" || { log "ERROR: could not pull the image"; exit 1; }

touched=()
for svc in "${SERVICES[@]}"; do
  touched+=("$svc")
  if up "$ref" "$svc" && healthy "$svc"; then
    log "$svc healthy on $ref"
  else
    log "ERROR: $svc did not become healthy (docker compose --profile collab logs $svc)"
    for s in "${touched[@]}"; do
      if [ -n "$previous" ]; then up "$previous" "$s" || true; else compose --profile collab stop "$s" || true; fi
    done
    [ -n "$previous" ] && log "previous image restored: $previous" || log "collab stopped (no previous image)"
    exit 1
  fi
done
printf '%s\n' "$ref" > "$STATE/collab-current"
log "both instances running on $ref"
