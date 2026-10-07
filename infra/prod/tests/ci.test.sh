#!/usr/bin/env bash
# Tests for the pipeline scripts in infra/prod/ci with fake ssh/scp: host-key pinning, what is uploaded,
# that secrets travel by stdin and never by argument or output, stop-at-first-failure for judges.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CI="$HERE/../ci"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }

setup() {
  T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/stdin"
  export FAKE_LOG="$T/calls.log" FAKE_STDIN="$T/stdin" PATH="$T/bin:$PATH"
  : > "$FAKE_LOG"
  # ssh/scp: log every call, save what arrives on stdin, and answer a few remote commands.
  cat > "$T/bin/ssh" <<'F'
#!/usr/bin/env bash
args="$*"
echo "ssh $args" >> "$FAKE_LOG"
n="$(ls "$FAKE_STDIN" | wc -l)"
# Only the commands that really read stdin (upload, registry login, settings file) consume it.
case "$args" in
  *"tar -xz"*|*"--password-stdin"*|*"cat > "*) cat > "$FAKE_STDIN/$n.stdin" ;;
esac
case "$args" in
  *"cat /opt/codearena/judge-worker.env"*) echo "REDIS_URL=redis://judge:TOP-SECRET-PASSWORD@10.20.1.4:6379" ;;
  *"/opt/codearena/deploy.sh '"*) exit "${FAKE_DEPLOY_RC:-0}" ;;
  *"provision.sh"*) [[ "$args" == *"${FAKE_FAIL_HOST:-no-such-host}"* ]] && exit 1 ;;
  *"attack -j"*) exit "${FAKE_ATTACK_RC:-0}" ;;
esac
exit 0
F
  cat > "$T/bin/scp" <<'F'
#!/usr/bin/env bash
echo "scp $*" >> "$FAKE_LOG"; exit 0
F
  chmod +x "$T/bin/ssh" "$T/bin/scp"
  echo "worker-binary" > "$T/worker"
}
teardown() { rm -rf "$T"; }
has() { grep -qF -- "$1" "$FAKE_LOG"; }

echo "D-02: pipeline scripts"

echo "- ssh-config.sh pins host keys and jumps to judges through the API VM"
setup
export DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
fake
-----END OPENSSH PRIVATE KEY-----" API_HOST=40.83.75.34 API_HOST_KEY="40.83.75.34 ssh-ed25519 AAAAapi" JUDGE_HOST_KEYS="10.20.2.4 ssh-ed25519 AAAAjudge"
cfg="$(SSH_DIR="$T/ssh" "$CI/ssh-config.sh")"
check "prints the config path" "$([ "$cfg" = "$T/ssh/config" ] && [ -f "$cfg" ] && echo 0 || echo 1)"
check "key is mode 600, directory 700" "$([ "$(stat -c %a "$T/ssh/key")" = 600 ] && [ "$(stat -c %a "$T/ssh")" = 700 ] && echo 0 || echo 1)"
check "host checking is strict and keys come from the pinned file" "$(grep -q 'StrictHostKeyChecking yes' "$cfg" && grep -q "UserKnownHostsFile $T/ssh/known_hosts" "$cfg" && echo 0 || echo 1)"
check "known_hosts holds the API and judge keys" "$(grep -q AAAAapi "$T/ssh/known_hosts" && grep -q AAAAjudge "$T/ssh/known_hosts" && echo 0 || echo 1)"
check "judges (10.*) are reached via ProxyJump api" "$(awk '/^Host 10\./{f=1} f&&/ProxyJump api/{print "ok"; exit}' "$cfg" | grep -q ok && echo 0 || echo 1)"
check "no password prompts (BatchMode) and only the deploy key (IdentitiesOnly)" "$(grep -q 'BatchMode yes' "$cfg" && grep -q 'IdentitiesOnly yes' "$cfg" && echo 0 || echo 1)"
env -u API_HOST_KEY SSH_DIR="$T/ssh2" "$CI/ssh-config.sh" >/dev/null 2>&1
check "refuses to run without a pinned API host key" "$([ $? != 0 ] && echo 0 || echo 1)"
API_HOST='evil;rm' SSH_DIR="$T/ssh3" "$CI/ssh-config.sh" >/dev/null 2>&1
check "refuses an API_HOST with unexpected characters" "$([ $? != 0 ] && echo 0 || echo 1)"
SSH_CONFIG="$cfg"; export SSH_CONFIG
unset DEPLOY_SSH_KEY
teardown

echo "- deploy-api.sh"
setup
export SSH_CONFIG=/x/config GHCR_USER=ayush GHCR_TOKEN=ghs_SUPERSECRETTOKEN
IMG="ghcr.io/owner/codearena-api@sha256:$(printf 'a%.0s' $(seq 64))"
IMAGE_REF="$IMG" "$CI/deploy-api.sh" >"$T/out.txt" 2>&1; rc=$?
check "exits 0 when deploy.sh succeeds" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "the token is sent on stdin, never as an argument or in the output" "$(! grep -q ghs_SUPERSECRETTOKEN "$FAKE_LOG" && ! grep -q ghs_SUPERSECRETTOKEN "$T/out.txt" && grep -lq ghs_SUPERSECRETTOKEN "$FAKE_STDIN"/* && echo 0 || echo 1)"
check "logs in with --password-stdin" "$(has 'docker login ghcr.io' && has '--password-stdin' && echo 0 || echo 1)"
check "deploys exactly the digest it was given" "$(has "/opt/codearena/deploy.sh '$IMG'" && echo 0 || echo 1)"
check "logs out of the registry afterwards" "$(has 'docker logout ghcr.io' && echo 0 || echo 1)"
tarlist="$(for f in "$FAKE_STDIN"/*; do tar -tzf "$f" 2>/dev/null; done | sort -u)"
check "uploads the compose file, Caddyfile, deploy script and the redis templates" "$(echo "$tarlist" | grep -qx 'docker-compose.yml' && echo "$tarlist" | grep -qx 'Caddyfile' && echo "$tarlist" | grep -qx 'deploy.sh' && echo "$tarlist" | grep -q '^redis/entrypoint.sh$' && echo "$tarlist" | grep -q '^redis/users.acl.tmpl$' && echo 0 || echo 1)"
check "does not upload tests or the CI scripts" "$(echo "$tarlist" | grep -qE '^(tests|ci)/' && echo 1 || echo 0)"
check "does not upload any secrets file" "$(echo "$tarlist" | grep -qE 'prod\.env|judge-worker\.env' && echo 1 || echo 0)"
: > "$FAKE_LOG"
FAKE_DEPLOY_RC=1 IMAGE_REF="$IMG" "$CI/deploy-api.sh" >/dev/null 2>&1; rc=$?
check "passes a rollback (exit 1) through so the workflow fails" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "still logs out after a failed deploy" "$(has 'docker logout ghcr.io' && echo 0 || echo 1)"
FAKE_DEPLOY_RC=2 IMAGE_REF="$IMG" "$CI/deploy-api.sh" >/dev/null 2>&1
check "passes exit 2 (rollback unhealthy) through too" "$([ $? = 2 ] && echo 0 || echo 1)"
: > "$FAKE_LOG"
IMAGE_REF="ghcr.io/owner/codearena-api:latest" "$CI/deploy-api.sh" >/dev/null 2>&1; rc=$?
check "refuses a tag and contacts nothing" "$([ $rc = 1 ] && [ ! -s "$FAKE_LOG" ] && echo 0 || echo 1)"
FORCE_UNHEALTHY=1 IMAGE_REF="$IMG" "$CI/deploy-api.sh" >/dev/null 2>&1
check "the rollback drill flag reaches deploy.sh" "$(has "FORCE_UNHEALTHY='1'" && echo 0 || echo 1)"
unset GHCR_USER GHCR_TOKEN
teardown

echo "- deploy-judges.sh"
setup
export SSH_CONFIG=/x/config
JUDGE_HOSTS="10.20.2.4" "$CI/deploy-judges.sh" "$T/worker" >"$T/out.txt" 2>&1; rc=$?
check "exits 0 and reports all judges updated" "$([ $rc = 0 ] && grep -q 'all judges updated' "$T/out.txt" && echo 0 || echo 1)"
check "the judge secret reached the judge over stdin" "$(grep -lq TOP-SECRET-PASSWORD "$FAKE_STDIN"/* && echo 0 || echo 1)"
check "the judge secret was never printed or put in an argument" "$(! grep -q TOP-SECRET-PASSWORD "$T/out.txt" && ! grep -q TOP-SECRET-PASSWORD "$FAKE_LOG" && echo 0 || echo 1)"
check "the settings file is written with umask 077" "$(has 'umask 077' && echo 0 || echo 1)"
check "provisioning runs with sudo on the judge" "$(has 'sudo bash /tmp/codearena-incoming/provision.sh' && echo 0 || echo 1)"
check "binary and unit are copied through scp" "$(has 'scp -q -F /x/config' && grep -q 'worker' "$FAKE_LOG" && echo 0 || echo 1)"
: > "$FAKE_LOG"; rm -f "$FAKE_STDIN"/*
JUDGE_HOSTS="10.20.2.4 10.20.2.5 10.20.2.6" FAKE_FAIL_HOST=10.20.2.5 "$CI/deploy-judges.sh" "$T/worker" >"$T/out.txt" 2>&1; rc=$?
check "stops at the first failing judge (exit 1)" "$([ $rc = 1 ] && echo 0 || echo 1)"
check "the third judge is never touched, so it keeps serving the old release" "$(has '10.20.2.6' && echo 1 || echo 0)"
check "the first judge was updated" "$(has '10.20.2.4' && echo 0 || echo 1)"
JUDGE_HOSTS="8.8.8.8" "$CI/deploy-judges.sh" "$T/worker" >/dev/null 2>&1
check "refuses a host that is not a private 10.x address" "$([ $? = 1 ] && echo 0 || echo 1)"
JUDGE_HOSTS="" "$CI/deploy-judges.sh" "$T/worker" >/dev/null 2>&1
check "refuses an empty host list" "$([ $? != 0 ] && echo 0 || echo 1)"
JUDGE_HOSTS="10.20.2.4" "$CI/deploy-judges.sh" "$T/missing" >/dev/null 2>&1
check "refuses a missing binary" "$([ $? = 1 ] && echo 0 || echo 1)"
teardown

echo "- run-attack.sh"
setup
export SSH_CONFIG=/x/config
echo b > "$T/attack"; echo t > "$T/suite.tgz"
"$CI/run-attack.sh" "$T/attack" "$T/suite.tgz" 10.20.2.4 >/dev/null 2>&1; rc=$?
check "exits 0 when the suite passes" "$([ $rc = 0 ] && echo 0 || echo 1)"
: > "$FAKE_LOG"
FAKE_ATTACK_RC=1 "$CI/run-attack.sh" "$T/attack" "$T/suite.tgz" 10.20.2.4 >/dev/null 2>&1; rc=$?
check "a failing suite fails the run, and the files are still cleaned up" "$([ $rc = 1 ] && has 'rm -rf /tmp/codearena-attack' && echo 0 || echo 1)"
"$CI/run-attack.sh" "$T/attack" "$T/suite.tgz" 8.8.8.8 >/dev/null 2>&1
check "refuses a non-private host" "$([ $? = 1 ] && echo 0 || echo 1)"
teardown

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
