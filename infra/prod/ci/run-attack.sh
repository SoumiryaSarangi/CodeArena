#!/usr/bin/env bash
# Pipeline step: run the sandbox attack suite ON a judge VM, with the real isolate (SD-§16, ADR-009).
# The runner builds the `attack` binary and tars tests/attack-suite; nothing is built on the judge
# (it has no internet and no Go toolchain).
#
#   usage: run-attack.sh <attack-binary> <attack-suite.tar.gz> <judge-private-ip>
#   env:   SSH_CONFIG
set -euo pipefail
bin="${1:?attack binary}" tarball="${2:?attack suite tarball}" host="${3:?judge private ip}"
: "${SSH_CONFIG:?}"
[[ "$host" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "refusing judge host '$host'" >&2; exit 1; }
j() { ssh -F "$SSH_CONFIG" "$host" "$@"; }

dir=/tmp/codearena-attack
j "rm -rf $dir && install -d -m 0755 $dir"
scp -q -F "$SSH_CONFIG" "$bin" "$host:$dir/attack"
scp -q -F "$SSH_CONFIG" "$tarball" "$host:$dir/suite.tar.gz"
# Runs as the unprivileged login user (isolate is setuid), alongside the worker: box ids do not clash
# (the suite uses its own range) but it does use CPU, so it is scheduled at night.
rc=0
j "cd $dir && tar -xzf suite.tar.gz && chmod +x attack && ./attack -j 2 -v tests/attack-suite" || rc=$?
j "rm -rf $dir" || true
exit "$rc"
