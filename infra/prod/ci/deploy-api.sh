#!/usr/bin/env bash
# Pipeline step: ship the production files to the API VM and deploy one image on it.
#
#   env: SSH_CONFIG (from ssh-config.sh)   IMAGE_REF (<repo>@sha256:...)
#        GHCR_USER, GHCR_TOKEN             a short-lived token (the workflow's own) so the server can pull
#        FORCE_UNHEALTHY=1                 rollback drill: make the new release look unhealthy
#
# The server pulls with the workflow's token and logs out again right after, so no registry
# credential is stored on it. The exit code is deploy.sh's: 0 deployed, 1 rolled back, 2 broken.
set -euo pipefail
: "${SSH_CONFIG:?}" "${IMAGE_REF:?}" "${GHCR_USER:?}" "${GHCR_TOKEN:?}"
here="$(cd "$(dirname "$0")" && pwd)"
infra="$(cd "$here/../.." && pwd)"
ssh_api() { ssh -F "$SSH_CONFIG" api "$@"; }

[[ "$IMAGE_REF" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "IMAGE_REF must be pinned by digest" >&2; exit 1; }
[[ "$GHCR_USER" =~ ^[A-Za-z0-9-]+$ ]] || { echo "GHCR_USER has unexpected characters" >&2; exit 1; }

ssh_api 'test -d /opt/codearena' || { echo "/opt/codearena does not exist: run infra/prod/bootstrap.sh once first" >&2; exit 1; }
ssh_api 'test -f /opt/codearena/prod.env' || { echo "/opt/codearena/prod.env is missing: run init-env.sh on the server (see infra/prod/README.md)" >&2; exit 1; }

echo "== uploading production files"
# prod/* to the top of /opt/codearena, redis/ next to it; never the tests or this CI directory.
tar -C "$infra" -cz --transform 's,^prod/,,' --exclude='prod/tests' --exclude='prod/ci' prod redis \
  | ssh_api 'tar -xz -C /opt/codearena && chmod +x /opt/codearena/deploy.sh /opt/codearena/init-env.sh'

echo "== deploying $IMAGE_REF"
logout() { ssh_api 'docker logout ghcr.io >/dev/null 2>&1 || true' || true; }
trap logout EXIT
printf '%s' "$GHCR_TOKEN" | ssh_api "docker login ghcr.io -u '$GHCR_USER' --password-stdin >/dev/null"

rc=0
ssh_api "FORCE_UNHEALTHY='${FORCE_UNHEALTHY:-}' /opt/codearena/deploy.sh '$IMAGE_REF'" || rc=$?
exit "$rc"
