#!/usr/bin/env bash
# Pipeline step: start or update the plagiarism job on the API VM. Needs the files deploy-api.sh already uploaded.
#
#   env: SSH_CONFIG   PLAG_IMAGE_REF (<repo>@sha256:...)   GHCR_USER, GHCR_TOKEN (the workflow's own, logged out after)
set -euo pipefail
: "${SSH_CONFIG:?}" "${PLAG_IMAGE_REF:?}" "${GHCR_USER:?}" "${GHCR_TOKEN:?}"
ssh_api() { ssh -F "$SSH_CONFIG" api "$@"; }
[[ "$PLAG_IMAGE_REF" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "PLAG_IMAGE_REF must be pinned by digest" >&2; exit 1; }
[[ "$GHCR_USER" =~ ^[A-Za-z0-9-]+$ ]] || { echo "GHCR_USER has unexpected characters" >&2; exit 1; }

logout() { ssh_api 'docker logout ghcr.io >/dev/null 2>&1 || true' || true; }
trap logout EXIT
printf '%s' "$GHCR_TOKEN" | ssh_api "docker login ghcr.io -u '$GHCR_USER' --password-stdin >/dev/null"
ssh_api "bash /opt/codearena/deploy-plag.sh '$PLAG_IMAGE_REF'"
