#!/usr/bin/env bash
# Pipeline step: install the worker binary on every judge VM, one at a time. Judges have no internet,
# so the binary, the unit and the settings all travel through the API VM (ProxyJump); each judge
# rolls itself back (provision.sh) if the new worker does not start, and we stop at the first
# failure so the remaining judges keep serving the old release.
#
#   usage: deploy-judges.sh <worker-binary> [node_exporter-binary]
#   env:   SSH_CONFIG (from ssh-config.sh)    JUDGE_HOSTS  space-separated private IPs (10.x.x.x)
#
# The judge-only settings (Redis `judge` user, read-only storage key) are streamed from
# /opt/codearena/judge-worker.env on the API VM straight into the judge: they pass through this
# process but are never written to disk here or printed.
set -euo pipefail
worker="${1:?usage: deploy-judges.sh <worker-binary> [node_exporter-binary]}"
exporter="${2:-}"
: "${SSH_CONFIG:?}" "${JUDGE_HOSTS:?JUDGE_HOSTS is empty: set the GitHub variable (space-separated private IPs)}"
here="$(cd "$(dirname "$0")" && pwd)"
judge_dir="$(cd "$here/../judge" && pwd)"
[ -f "$worker" ] || { echo "no such binary: $worker" >&2; exit 1; }

incoming=/tmp/codearena-incoming
for host in $JUDGE_HOSTS; do
  [[ "$host" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "refusing judge host '$host' (expected a private 10.x address)" >&2; exit 1; }
done

for host in $JUDGE_HOSTS; do
  echo "== judge $host"
  j() { ssh -F "$SSH_CONFIG" "$host" "$@"; }
  j "rm -rf $incoming && install -d -m 0700 $incoming"
  scp -q -F "$SSH_CONFIG" "$worker" "$host:$incoming/worker"
  scp -q -F "$SSH_CONFIG" "$judge_dir/codearena-worker.service" "$judge_dir/provision.sh" "$host:$incoming/"
  if [ -n "$exporter" ] && [ -f "$exporter" ]; then
    scp -q -F "$SSH_CONFIG" "$exporter" "$host:$incoming/node_exporter"
    scp -q -F "$SSH_CONFIG" "$judge_dir/node-exporter.service" "$host:$incoming/"
  fi
  # API VM -> (this process) -> judge. Nothing is echoed.
  ssh -F "$SSH_CONFIG" api 'cat /opt/codearena/judge-worker.env' \
    | j "umask 077 && cat > $incoming/worker.env"
  if ! j "sudo bash $incoming/provision.sh"; then
    echo "judge $host failed to start the new worker (it rolled itself back); stopping here so the other judges stay on the old release" >&2
    exit 1
  fi
done
echo "== all judges updated"
