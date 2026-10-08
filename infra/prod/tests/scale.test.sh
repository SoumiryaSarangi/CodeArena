#!/usr/bin/env bash
# Tests for scripts/scale-judges.sh (O-04) with fake terraform, ssh, scp, gh and curl on PATH:
# the order of steps (firewall closed again before the worker is installed, nodes drained before
# they are destroyed), what is saved, which GitHub variables are written, and the refusals.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SCALE="$ROOT/scripts/scale-judges.sh"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }
has() { grep -qE -- "$1" "$LOG"; echo $?; }
line() { grep -nE -- "$1" "$LOG" | head -1 | cut -d: -f1; }

setup() { # initial judge count
  T="$(mktemp -d)"; LOG="$T/log"; : > "$LOG"
  export T LOG PATH="$T/bin:$PATH" TF_DIR="$T/tf" DEPLOY_KEY_FILE="$T/key" READY_TIMEOUT=5 POLL=0
  mkdir -p "$T/bin" "$TF_DIR"
  echo "$1" > "$T/count"
  echo '{"items":[]}' > "$T/contests.json"
  echo "fake-private-key" > "$T/key"; echo "ssh-ed25519 AAAAdeploy deploy" > "$T/key.pub"
  printf '#!/usr/bin/env bash\necho "lock $*" >> "$LOG"\n' > "$TF_DIR/lock-judges.sh"; chmod +x "$TF_DIR/lock-judges.sh"
  cat > "$T/bin/terraform" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = output ]; then
  case "$3" in
    judge_private_ips) python3 -c "import json,sys; print(json.dumps(['10.20.2.%d' % (4+i) for i in range(int(open('$T/count').read()))]))" ;;
    api_public_ip) echo '"40.83.75.34"' ;;
    api_host_sslip) echo '"api.40-83-75-34.sslip.io"' ;;
    resource_group) echo '"rg-test"' ;;
  esac
  exit 0
fi
echo "terraform $*" >> "$LOG"
if [ -n "${FAKE_APPLY_FAIL:-}" ] && [[ "$*" == *judge_bootstrap=true* ]]; then echo "Error: boom" >&2; exit 1; fi
for a in "$@"; do case "$a" in judge_count=*) echo "${a#judge_count=}" > "$T/count" ;; esac; done
FAKE
  cat > "$T/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
echo "ssh $*" >> "$LOG"
case "$*" in
  *ssh_host_ed25519_key.pub*) echo "ssh-ed25519 AAAAfakehostkey root@judge" ;;
  *"curl -m 5"*) exit "${INTERNET_EXIT:-1}" ;;
  *"cat /opt/codearena/judge-worker.env"*) echo "REDIS_URL=redis://judge" ;;
esac
exit 0
FAKE
  cat > "$T/bin/az" <<'FAKE'
#!/usr/bin/env bash
echo "az $*" >> "$LOG"
case "$*" in
  "group show"*) echo eastasia ;;
  "vm list-skus"*"Standard_D2s_v5"*) echo standardDSv5Family ;;
  "vm list-skus"*) echo standardBsv2Family ;;
  "vm show"*) echo "${FAKE_CURRENT_SIZE:-Standard_B2s_v2}" ;;
  "vm list-usage"*)
    echo "[{\"name\":{\"value\":\"cores\"},\"currentValue\":${FAKE_CORES_USED:-4},\"limit\":${FAKE_CORES_LIMIT:-100}},{\"name\":{\"value\":\"standardDSv5Family\"},\"currentValue\":0,\"limit\":${FAKE_DS_LIMIT:-100}},{\"name\":{\"value\":\"standardBsv2Family\"},\"currentValue\":4,\"limit\":100}]" ;;
  "vm list -g"*"powerState"*) printf '%s' "${FAKE_STOPPED:-}" ;;
  "vm list -g"*) echo vm-test-judge-0 ;;
esac
exit 0
FAKE
  printf '#!/usr/bin/env bash\necho "ssh-keygen $*" >> "$LOG"\n' > "$T/bin/ssh-keygen"
  printf '#!/usr/bin/env bash\necho "scp $*" >> "$LOG"\n' > "$T/bin/scp"
  cat > "$T/bin/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >> "$LOG"
case "$1 $2" in
  "variable set") [ -t 0 ] || echo "stdin: $(cat)" >> "$LOG" ;;
  "api repos"*) echo "40.83.75.34 ssh-ed25519 AAAAapi" ;;
  "run list") echo 4242 ;;
  "run download") d="$(echo "$*" | sed 's/.*-D //')"; echo bin > "$d/worker"; echo bin > "$d/node_exporter" ;;
esac
exit 0
FAKE
  cat > "$T/bin/curl" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  */api/contests*) cat "$T/contests.json" ;;
  */api/status*) echo "{\"components\":[{\"id\":\"judges\",\"detail\":\"$(cat "$T/count") judges reporting\"}]}" ;;
esac
FAKE
  chmod +x "$T"/bin/*
}
run() { "$SCALE" "$@" >"$T/out" 2>&1 </dev/null; echo $? > "$T/rc"; rc="$(cat "$T/rc")"; }

echo "O-04: scale-judges.sh"

echo "- status and refusals"
setup 1
run status
check "status shows the count and what reports" "$(grep -q 'judge VMs in Terraform state: 1' "$T/out" && grep -q 'reporting to the queue now: 1' "$T/out" && echo 0 || echo 1)"
run up 2 --dry-run
check "dry run changes nothing" "$([ $rc = 0 ] && ! grep -q '^terraform' "$LOG" && grep -q '1 -> 3' "$T/out" && echo 0 || echo 1)"
run to 1 --yes
check "asking for the current count does nothing" "$([ $rc = 0 ] && grep -q 'nothing to do' "$T/out" && echo 0 || echo 1)"
run to 0 --yes
check "never fewer than one judge" "$([ $rc != 0 ] && grep -q 'at least 1' "$T/out" && echo 0 || echo 1)"
run up 10 --yes
check "never more than ten judges" "$([ $rc != 0 ] && grep -q 'at most 10' "$T/out" && ! grep -q '^terraform' "$LOG" && echo 0 || echo 1)"
run up 1 --size 'D2 v5; rm -rf'
check "a size is validated" "$([ $rc != 0 ] && grep -q 'must look like' "$T/out" && echo 0 || echo 1)"
echo no | "$SCALE" up 1 >"$T/out" 2>&1; rc=$?
check "without --yes it asks, and 'no' creates nothing" "$([ $rc != 0 ] && grep -q cancelled "$T/out" && ! grep -q '^terraform' "$LOG" && echo 0 || echo 1)"

echo "- a running contest blocks scaling up"
setup 1
echo '{"items":[{"slug":"warmup-1","state":"running"}]}' > "$T/contests.json"
run up 2 --yes
check "refused while a contest runs; nothing created" "$([ $rc != 0 ] && grep -q 'a contest is running' "$T/out" && ! grep -q '^terraform' "$LOG" && echo 0 || echo 1)"
run up 1 --yes --allow-running-contest
check "the override is explicit" "$([ $rc = 0 ] && grep -q '^terraform apply' "$LOG" && echo 0 || echo 1)"
setup 1
echo '{"items":[{"slug":"lt-abc123","state":"running"}]}' > "$T/contests.json"
run up 1 --yes
check "a load-test contest does not block it" "$([ $rc = 0 ] && echo 0 || echo 1)"

echo "- up"
setup 1
run up 2 --yes
check "succeeds" "$([ $rc = 0 ] && echo 0 || (cat "$T/out"; echo 1))"
apply="$(line 'terraform apply.*judge_bootstrap=true')"
lock="$(line '^lock ')"
deploy="$(line 'ssh -F .* 10\.20\.2\.5 ')"
vars="$(line 'gh variable set JUDGE_HOSTS')"
check "creates with the firewall open, count 3, the default size B2s_v2, temporary IPs only from judge 1 on" "$([ -n "$apply" ] && grep -q 'judge_count=3' "$LOG" && grep -q 'judge_vm_size=Standard_B2s_v2' "$LOG" && grep -q 'judge_bootstrap_from=1' "$LOG" && echo 0 || echo 1)"
check "locks the judges down (non-interactively) after creating them" "$([ -n "$lock" ] && [ "$apply" -lt "$lock" ] && grep -q 'lock -auto-approve' "$LOG" && echo 0 || echo 1)"
check "installs the worker only after the lockdown" "$([ -n "$deploy" ] && [ "$lock" -lt "$deploy" ] && echo 0 || echo 1)"
check "the worker goes to the new judges only" "$(grep -q 'ssh -F .* 10\.20\.2\.6 ' "$LOG" && ! grep -qE 'ssh -F .* 10\.20\.2\.4 ' "$LOG" && echo 0 || echo 1)"
check "a stale host key of a reused address is forgotten before the first connection" "$(l1="$(line 'ssh-keygen -R 10.20.2.5')"; l2="$(line 'ssh .*10\.20\.2\.5 .*cloud-init')"; [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ] && echo 0 || echo 1)"
check "the deploy key is authorised on each new judge" "$([ "$(grep -c 'AAAAdeploy' "$LOG")" -ge 2 ] && echo 0 || echo 1)"
check "JUDGE_HOSTS lists all three judges" "$(grep -q 'gh variable set JUDGE_HOSTS --body 10.20.2.4 10.20.2.5 10.20.2.6' "$LOG" && echo 0 || echo 1)"
check "JUDGE_HOST_KEYS has a line per judge" "$([ "$(grep -c 'stdin: .*' "$LOG")" -ge 1 ] && grep -q '10.20.2.6 ssh-ed25519 AAAAfakehostkey' "$LOG" && echo 0 || echo 1)"
check "variables are written after the lockdown" "$([ "$lock" -lt "$vars" ] && echo 0 || echo 1)"
check "the wanted state is saved, locked down, with the size" "$(grep -qx 'judge_count     = 3' "$TF_DIR/judges.auto.tfvars" && grep -qx 'judge_vm_size   = "Standard_B2s_v2"' "$TF_DIR/judges.auto.tfvars" && grep -qx 'judge_bootstrap = false' "$TF_DIR/judges.auto.tfvars" && echo 0 || echo 1)"
check "it ends by waiting for the heartbeats and reminds about scaling back" "$(grep -q '3 judge(s) report' "$T/out" && grep -q 'to 1' "$T/out" && echo 0 || echo 1)"

setup 1
INTERNET_EXIT=0 run up 1 --yes
check "a new judge that still reaches the internet stops the run" "$([ $rc != 0 ] && grep -q 'still reaches the internet' "$T/out" && ! grep -q 'gh variable set' "$LOG" && echo 0 || echo 1)"

echo "- up in rounds (Azure allows 3 public IPs: the API VM and at most 2 judges being set up)"
setup 1
run up 5 --dry-run
check "a dry run of 5 says it will run in 3 rounds and changes nothing" "$([ $rc = 0 ] && grep -q '3 rounds of at most 2' "$T/out" && ! grep -q '^terraform' "$LOG" && echo 0 || echo 1)"
run up 5 --yes
check "succeeds" "$([ $rc = 0 ] && echo 0 || (cat "$T/out"; echo 1))"
check "three bootstrap applies, each adding at most 2 judges and starting at the first new one" "$([ "$(grep -c '^terraform apply.*judge_bootstrap=true' "$LOG")" = 3 ] && grep -q 'judge_count=3.*judge_bootstrap_from=1' "$LOG" && grep -q 'judge_count=5.*judge_bootstrap_from=3' "$LOG" && grep -q 'judge_count=6.*judge_bootstrap_from=5' "$LOG" && echo 0 || echo 1)"
check "each round is locked down before the next one starts" "$([ "$(grep -c '^lock ' "$LOG")" = 3 ] && [ "$(line 'judge_count=5.*judge_bootstrap_from=3')" -gt "$(line '^lock ')" ] && echo 0 || echo 1)"
check "all six judges end up in JUDGE_HOSTS" "$(grep -q 'gh variable set JUDGE_HOSTS --body 10.20.2.4 10.20.2.5 10.20.2.6 10.20.2.7 10.20.2.8 10.20.2.9' "$LOG" && echo 0 || echo 1)"
setup 1
run up 3 --allow-running-contest --yes
check "the override is passed on to each round" "$([ $rc = 0 ] && [ "$(grep -c '^terraform apply.*judge_bootstrap=true' "$LOG")" = 2 ] && echo 0 || echo 1)"

echo "- quota (Azure for Students: 6 vCPUs in total, some families have none)"
setup 1
FAKE_CORES_LIMIT=6 FAKE_CORES_USED=4 run up 2 --yes
check "two more 2-vCPU judges do not fit in 6 vCPUs: refused before anything is created" "$([ $rc != 0 ] && grep -q 'QUOTA: the region allows 6 vCPUs in total and 4 are in use' "$T/out" && grep -q 'at most 1 more' "$T/out" && ! grep -q '^terraform' "$LOG" && echo 0 || echo 1)"
FAKE_CORES_LIMIT=6 FAKE_CORES_USED=4 run up 1 --yes
check "one more fits" "$([ $rc = 0 ] && grep -q '^terraform apply.*judge_count=2' "$LOG" && echo 0 || echo 1)"
setup 1
FAKE_DS_LIMIT=0 run up 1 --size Standard_D2s_v5 --yes
check "a family without quota (D2s_v5 here) is refused" "$([ $rc != 0 ] && grep -q 'standarddsv5family family has 0 vCPUs free' "$T/out" && ! grep -q '^terraform' "$LOG" && echo 0 || echo 1)"

echo "- a failed scale-up puts the locked-down fleet back"
setup 1
FAKE_APPLY_FAIL=1 FAKE_STOPPED=vm-test-judge-0 run up 2 --yes
check "the scale-up fails" "$([ $rc != 0 ] && echo 0 || echo 1)"
check "the firewall is closed again with the old count (lock with judge_count=1)" "$(grep -q '^lock -auto-approve -var judge_count=1' "$LOG" && echo 0 || echo 1)"
check "a judge left stopped by the failed resize is started" "$(grep -q '^az vm start -g rg-test -n vm-test-judge-0' "$LOG" && echo 0 || echo 1)"
setup 1
run up 1 --yes
check "after a successful scale-up there is no restore" "$([ "$(grep -c '^lock ' "$LOG")" = 1 ] && ! grep -q '^az vm start' "$LOG" && echo 0 || echo 1)"

echo "- down"
setup 3
printf 'judge_count     = 3\njudge_vm_size   = "Standard_D2s_v5"\njudge_bootstrap = false\n' > "$TF_DIR/judges.auto.tfvars"
run to 1 --yes
check "succeeds" "$([ $rc = 0 ] && echo 0 || (cat "$T/out"; echo 1))"
stop5="$(line 'ssh .*10\.20\.2\.5 .*systemctl stop codearena-worker')"
stop6="$(line 'ssh .*10\.20\.2\.6 .*systemctl stop codearena-worker')"
apply="$(line '^terraform apply')"
check "the judges to remove are drained before Terraform destroys them" "$([ -n "$stop5" ] && [ -n "$stop6" ] && [ "$stop6" -lt "$apply" ] && echo 0 || echo 1)"
check "the judge that stays is not stopped" "$(grep -qE 'ssh .*10\.20\.2\.4 .*systemctl' "$LOG" && echo 1 || echo 0)"
check "down never opens the firewall" "$(grep -q 'judge_bootstrap=true' "$LOG" && echo 1 || echo 0)"
check "applies count 1 and returns to the default size" "$(grep -q 'judge_count=1' "$LOG" && ! grep -q 'judge_vm_size' "$LOG" && ! grep -q 'judge_vm_size' "$TF_DIR/judges.auto.tfvars" && grep -qx 'judge_count     = 1' "$TF_DIR/judges.auto.tfvars" && echo 0 || echo 1)"
check "the host keys of the removed judges are forgotten" "$(grep -q 'ssh-keygen -R 10.20.2.5' "$LOG" && grep -q 'ssh-keygen -R 10.20.2.6' "$LOG" && echo 0 || echo 1)"
check "JUDGE_HOSTS shrinks to the remaining judge" "$(grep -q 'gh variable set JUDGE_HOSTS --body 10.20.2.4$' "$LOG" && echo 0 || echo 1)"

setup 4
printf 'judge_count     = 4\njudge_vm_size   = "Standard_D2s_v5"\njudge_bootstrap = false\n' > "$TF_DIR/judges.auto.tfvars"
run down 1 --yes
check "down 1 removes one judge and keeps the contest size" "$(grep -q 'judge_count=3' "$LOG" && grep -q 'judge_vm_size=Standard_D2s_v5' "$LOG" && grep -qE 'ssh .*10\.20\.2\.7 .*systemctl stop' "$LOG" && echo 0 || echo 1)"

setup 6
printf 'judge_count     = 6\njudge_vm_size   = "Standard_D2s_v5"\njudge_bootstrap = false\n' > "$TF_DIR/judges.auto.tfvars"
run down 5 --size Standard_D2s_v5 --yes
check "going to 1 with an explicit --size keeps that size (a 1-judge test on the contest size)" "$(grep -q 'judge_count=1' "$LOG" && grep -q 'judge_vm_size=Standard_D2s_v5' "$LOG" && grep -qx 'judge_vm_size   = "Standard_D2s_v5"' "$TF_DIR/judges.auto.tfvars" && echo 0 || echo 1)"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
