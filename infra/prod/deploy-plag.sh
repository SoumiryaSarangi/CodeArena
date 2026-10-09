#!/usr/bin/env bash
# Starts (or updates) the plagiarism job on the API VM (PL-06). Run by the pipeline after the API deploy, only when the
# repository variable PLAG_ENABLED is "true"; never part of deploy.sh, so it cannot hold up or roll back an API release.
#
#   usage: deploy-plag.sh <image@sha256:digest>        env: APP_DIR (/opt/codearena), SETTLE (seconds, default 20)
#
# 1. makes sure prod.env has PLAG_SERVICE_TOKEN; if it was just added the API is recreated once so it reads it,
# 2. pulls the image and starts the `plag` service (profile `plag`),
# 3. checks that it stays up; if not, puts the previous image back (or stops the job when there was none).
# Exit 0 = job running, 1 = it did not start (previous state restored).
set -euo pipefail
ref="${1:-}"
[[ "$ref" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "usage: deploy-plag.sh <image@sha256:digest> (pinned by digest)" >&2; exit 1; }
APP_DIR="${APP_DIR:-/opt/codearena}"
SETTLE="${SETTLE:-20}"
STATE="$APP_DIR/state"
mkdir -p "$STATE"
log() { echo "[plag $(date -u +%H:%M:%S)] $*"; }
compose() { (cd "$APP_DIR" && docker compose --env-file prod.env -f docker-compose.yml "$@"); }
previous="$(cat "$STATE/plag-current" 2>/dev/null || true)"

if ! grep -q '^PLAG_SERVICE_TOKEN=.' "$APP_DIR/prod.env"; then
  (cd "$APP_DIR" && ./init-env.sh ensure prod PLAG_SERVICE_TOKEN "$(openssl rand -hex 24)")
  api="$(cat "$STATE/current" 2>/dev/null || true)"
  [ -n "$api" ] || { echo "no API release recorded in $STATE/current; cannot recreate the API" >&2; exit 1; }
  log "token added; recreating the API so it reads it"
  API_IMAGE="$api" compose up -d --no-deps api
fi

up() { PLAG_IMAGE="$1" API_IMAGE="$(cat "$STATE/current" 2>/dev/null || true)" compose --profile plag up -d --no-deps plag; }
running() { compose --profile plag ps --status running --services 2>/dev/null | grep -qx plag; }

log "pulling $ref"
PLAG_IMAGE="$ref" compose --profile plag pull plag || { log "ERROR: could not pull the image"; exit 1; }
if up "$ref"; then
  sleep "$SETTLE"
  if running; then
    printf '%s\n' "$ref" > "$STATE/plag-current"
    log "job running on $ref"
    exit 0
  fi
fi

log "ERROR: the job did not stay up (docker compose --profile plag logs plag)"
if [ -n "$previous" ] && up "$previous"; then
  log "previous image restored: $previous"
else
  compose --profile plag stop plag || true
  log "job stopped (no previous image)"
fi
exit 1
