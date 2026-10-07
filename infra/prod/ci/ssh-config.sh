#!/usr/bin/env bash
# Writes an ssh_config for the pipeline and prints its path. The API VM is reached directly; judges
# (private 10.x addresses, no public IP) are reached through it with ProxyJump.
#
# Host keys are PINNED (StrictHostKeyChecking yes + a known_hosts file built from values you recorded
# once with bootstrap.sh), so a hijacked address cannot impersonate a server to the pipeline.
#
#   env: DEPLOY_SSH_KEY   private key (contents)         API_HOST      public IP or name of the API VM
#        API_HOST_KEY     known_hosts line(s) for it     JUDGE_HOST_KEYS  known_hosts lines for the judges
#        SSH_DIR          where to write (default: a new temp dir)
set -euo pipefail

: "${DEPLOY_SSH_KEY:?DEPLOY_SSH_KEY is not set}"
: "${API_HOST:?API_HOST is not set}"
: "${API_HOST_KEY:?API_HOST_KEY is not set (run bootstrap.sh and set the GitHub variable)}"
[[ "$API_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "API_HOST has unexpected characters" >&2; exit 1; }

dir="${SSH_DIR:-$(mktemp -d)}"
mkdir -p "$dir"; chmod 700 "$dir"
umask 077
printf '%s\n' "$DEPLOY_SSH_KEY" > "$dir/key"
chmod 600 "$dir/key"
{
  printf '%s\n' "$API_HOST_KEY"
  printf '%s\n' "${JUDGE_HOST_KEYS:-}"
} | grep -v '^$' > "$dir/known_hosts"

cat > "$dir/config" <<CFG
Host api
  HostName $API_HOST
  User codearena

Host 10.*
  User codearena
  ProxyJump api

Host *
  IdentityFile $dir/key
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  UserKnownHostsFile $dir/known_hosts
  ConnectTimeout 20
  ServerAliveInterval 15
  ServerAliveCountMax 4
CFG
printf '%s\n' "$dir/config"
