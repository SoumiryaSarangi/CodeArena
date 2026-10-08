#!/usr/bin/env bash
# Adds or removes judge VMs. Run from your laptop (WSL) in the repository, logged in to Azure (`az login`)
# and GitHub (`gh auth login`). Wraps Terraform; judges find the queue themselves (heartbeat), so nothing
# else needs configuring.
#
#   scripts/scale-judges.sh status
#   scripts/scale-judges.sh up 1                 # add 1 judge (2 in total if there is 1 now)
#   scripts/scale-judges.sh down 1               # remove 1
#   scripts/scale-judges.sh to 1                 # end state: exactly 1
#   options: --size Standard_B2s_v2   VM size for `up` (the default; D2s_v5 has no quota on Azure for Students)
#            --yes                    do not ask before creating or destroying VMs
#            --dry-run                show the plan, change nothing
#            --allow-running-contest  go on although a contest is running (see below)
#
# Azure for Students allows 3 public IPs per region and the API VM uses one, so only the NEW judges get a
# temporary IP, at most 2 at a time; `up 5` therefore runs in rounds (each with its own firewall window).
#
# Why scaling up has a window: a new judge builds isolate on first boot, which needs the internet, and the
# judge firewall is one rule for the whole subnet. So `up` runs Terraform with judge_bootstrap=true (every
# judge gets a temporary public IP and open egress), waits for the new VMs, locks the judges down again and
# only then installs the worker. That takes several minutes; do it hours before a contest, never during
# one (the script refuses while a contest is running). `down` never opens the firewall.
#
# After `up`: the new judges are authorised for the deploy key, their host keys and addresses are written to
# the GitHub variables JUDGE_HOSTS / JUDGE_HOST_KEYS (so later deploys reach them), the worker from the last
# successful deploy is installed on them, and the script waits until they report to the queue.
# The wanted count and size are saved in infra/terraform/judges.auto.tfvars so a later plain
# `terraform apply` keeps them; `to 1` writes the steady state (1 judge, default size, locked down).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="${TF_DIR:-$ROOT/infra/terraform}"
TERRAFORM="${TERRAFORM:-terraform}"
SSH="${SSH:-ssh}"
GH="${GH:-gh}"
CURL="${CURL:-curl}"
AZ="${AZ:-az}"
USER_NAME="${ADMIN_USER:-codearena}"
DEPLOY_KEY="${DEPLOY_KEY_FILE:-$HOME/.ssh/codearena_deploy}"
READY_TIMEOUT="${READY_TIMEOUT:-900}"
POLL="${POLL:-10}"
# D2s_v5 has no quota on the Azure for Students subscription (checked in the first real run); B2s_v2 does.
DEFAULT_SIZE=Standard_B2s_v2
MAX_JUDGES=10
# Azure for Students allows 3 public IPs per region and the API VM uses one: at most 2 new judges can be
# bootstrapped (given a temporary IP) at a time, so a bigger `up` runs in rounds.
MAX_BATCH=2

die() { echo "error: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
now() { date +%s; }

mode="${1:-}"; shift || true
amount=""
case "$mode" in up | down | to) amount="${1:-}"; shift || true ;; status) ;; *)
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
size="" yes=0 dry=0 allow=0
while [ $# -gt 0 ]; do
  case "$1" in
    --size) size="${2:?--size needs a VM size}"; shift 2 ;;
    --yes) yes=1; shift ;;
    --dry-run) dry=1; shift ;;
    --allow-running-contest) allow=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -z "$size" || "$size" =~ ^Standard_[A-Za-z0-9_]+$ ]] || die "--size must look like Standard_D2s_v5"

tf() { (cd "$TF_DIR" && "$TERRAFORM" "$@"); }
out() { tf output -json "$1"; }
json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); $1"; }

current_ips() { out judge_private_ips | json 'print("\n".join(d))'; }
mapfile -t ips < <(current_ips)
cur="${#ips[@]}"
api_ip="$(out api_public_ip | json 'print(d)')"
api_url="https://$(out api_host_sslip | json 'print(d)')"

judges_reporting() {
  "$CURL" -fsS --max-time 10 "$api_url/api/status" 2>/dev/null \
    | python3 -I -c 'import json,re,sys
d=json.load(sys.stdin)
for c in d.get("components", []):
    if c.get("id") == "judges":
        m = re.match(r"(\d+) judge", c.get("detail", ""))
        print(m.group(1) if m else 0)
        break
else:
    print(0)' 2>/dev/null || echo 0
}

if [ "$mode" = status ]; then
  say "judge VMs in Terraform state: $cur (${ips[*]:-none})"
  [ -f "$TF_DIR/judges.auto.tfvars" ] && { say "saved wanted state:"; sed 's/^/  /' "$TF_DIR/judges.auto.tfvars"; } || say "no judges.auto.tfvars (Terraform defaults apply)"
  say "reporting to the queue now: $(judges_reporting)"
  exit 0
fi

[[ "$amount" =~ ^[0-9]+$ ]] || die "$mode needs a whole number"
case "$mode" in
  up) target=$((cur + amount)) ;;
  down) target=$((cur - amount)) ;;
  to) target="$amount" ;;
esac
[ "$target" -ge 1 ] || die "at least 1 judge must stay (asked for $target)"
[ "$target" -le "$MAX_JUDGES" ] || die "at most $MAX_JUDGES judges (asked for $target)"
[ "$target" -ne "$cur" ] || { say "already at $cur judge(s): nothing to do"; exit 0; }
direction=up; [ "$target" -lt "$cur" ] && direction=down

# Size: `up` uses --size or the contest default; `down` keeps the saved size, except going back to 1,
# which returns to Terraform's default (steady state) unless --size is given.
saved_size=""
[ -f "$TF_DIR/judges.auto.tfvars" ] && saved_size="$(sed -n 's/^judge_vm_size *= *"\(.*\)"/\1/p' "$TF_DIR/judges.auto.tfvars")"
if [ "$direction" = up ]; then
  size="${size:-${saved_size:-$DEFAULT_SIZE}}"
elif [ "$target" -eq 1 ]; then
  : # back to one judge: the default size, unless --size says otherwise (a 1-judge test on a D2s_v5)
else
  size="${size:-$saved_size}"
fi

confirm() {
  [ "$yes" = 1 ] && return 0
  read -r -p "$1 Type yes to go on: " a
  [ "$a" = yes ]
}

say "judges: $cur -> $target (${direction}), size: ${size:-<Terraform default>}"
if [ "$direction" = up ] && [ $((target - cur)) -gt "$MAX_BATCH" ]; then
  rounds=$(((target - cur + MAX_BATCH - 1) / MAX_BATCH))
  say "adding $((target - cur)) judges in $rounds rounds of at most $MAX_BATCH (the subscription allows 3 public IPs, the API VM uses one); the judge firewall is open during each round"
  if [ "$dry" = 1 ]; then exit 0; fi
  confirm "This creates $((target - cur)) judge VMs (about \$0.13/h each) in $rounds rounds." || die "cancelled"
  flags=(--yes --size "$size")
  if [ "$allow" = 1 ]; then flags+=(--allow-running-contest); fi
  have="$cur"
  while [ "$have" -lt "$target" ]; do
    step=$((target - have))
    if [ "$step" -gt "$MAX_BATCH" ]; then step="$MAX_BATCH"; fi
    say "== round: $have -> $((have + step))"
    bash "$0" up "$step" "${flags[@]}" || die "a round failed: stopped at $have judge(s) (run status, and lock the judges down if the firewall is still open)"
    have=$((have + step))
  done
  exit 0
fi
if [ "$dry" = 1 ]; then
  if [ "$direction" = up ]; then
    say "would: apply with judge_bootstrap=true, wait for cloud-init on the $((target - cur)) new VM(s), lock the judges down,"
    say "authorise the deploy key, set JUDGE_HOSTS / JUDGE_HOST_KEYS, install the worker, wait for heartbeats."
  else
    say "would: drain and stop the worker on the $((cur - target)) judge(s) being removed, apply judge_count=$target, update the GitHub variables."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------------------------
write_state() { # count size
  {
    echo "# Written by scripts/scale-judges.sh: the wanted number and size of judge VMs. Delete the file only"
    echo "# together with a deliberate change of these values."
    echo "judge_count     = $1"
    [ -n "$2" ] && echo "judge_vm_size   = \"$2\""
    echo "judge_bootstrap = false"
  } > "$TF_DIR/judges.auto.tfvars"
}
size_arg=()
if [ -n "$size" ]; then size_arg=(-var "judge_vm_size=$size"); fi

sshj() { # host cmd...  (through the API VM; first contact trusts the new host key, as bootstrap.sh does)
  local host="$1"; shift
  "$SSH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -J "$USER_NAME@$api_ip" "$USER_NAME@$host" "$@"
}

set_vars() { # all judge IPs (args) -> JUDGE_HOSTS and JUDGE_HOST_KEYS
  local keys="" ip k
  for ip in "$@"; do
    k="$(sshj "$ip" 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk -v h="$ip" '{print h " " $1 " " $2}')"
    [ -n "$k" ] || die "could not read the host key of $ip"
    keys="${keys}${k}"$'\n'
  done
  "$GH" variable set JUDGE_HOSTS --body "$*" >/dev/null
  printf '%s' "${keys%$'\n'}" | "$GH" variable set JUDGE_HOST_KEYS >/dev/null
  say "GitHub variables updated: JUDGE_HOSTS=$*"
}

# ---- guards learnt in the first real run ----------------------------------------------------
# Azure for Students allows 6 vCPUs per region in total and gives some VM families no quota at all, and a
# failed apply used to leave the judge firewall open and a judge stopped (a resize stops the VM first).
rg_name() { out resource_group | json 'print(d)'; }

# Refuses, before anything is created, a scale-up that the subscription's quota cannot hold.
quota_check() { # size new
  local size="$1" new="$2" rg loc vcpu fam current resize=0
  rg="$(rg_name)"
  loc="$("$AZ" group show -g "$rg" --query location -o tsv)" || { say "(could not read the region: quota not checked)"; return 0; }
  vcpu="$(printf '%s' "$size" | sed -n 's/^Standard_[A-Za-z]*\([0-9][0-9]*\).*/\1/p')"
  [ -n "$vcpu" ] || { say "(cannot read the vCPU count from $size: quota not checked)"; return 0; }
  fam="$("$AZ" vm list-skus -l "$loc" --size "$size" --resource-type virtualMachines --query '[0].family' -o tsv 2>/dev/null || true)"
  current="$("$AZ" vm show -g "$rg" -n "$("$AZ" vm list -g "$rg" --query "[?tags.role=='judge'].name | [0]" -o tsv)" --query hardwareProfile.vmSize -o tsv 2>/dev/null || true)"
  [ -n "$current" ] && [ "$current" != "$size" ] && resize=1
  USAGE_JSON="$("$AZ" vm list-usage -l "$loc" -o json)" python3 -I - "$new" "$vcpu" "$cur" "$resize" "$fam" <<'PY' || die "the subscription's quota cannot hold this (see above). Nothing was created. Ask for a quota increase in the Azure portal, pick another size with --size, or add fewer judges."
import json, os, sys
usage = {u["name"]["value"].lower(): u for u in json.loads(os.environ["USAGE_JSON"])}
new, vcpu, cur, resize, fam = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5].lower()


def room(key):
    u = usage.get(key)
    return None if u is None else int(u["limit"]) - int(u["currentValue"])


need_total = new * vcpu
need_family = (new + (cur if resize else 0)) * vcpu
problems = []
t = room("cores")
if t is not None and t < need_total:
    c = usage["cores"]
    problems.append(
        f'the region allows {c["limit"]} vCPUs in total and {c["currentValue"]} are in use: '
        f"{need_total} more do not fit (at most {max(0, t // vcpu)} more judge(s) of this size)"
    )
f = room(fam) if fam else None
if f is not None and f < need_family:
    problems.append(f"the {fam} family has {f} vCPUs free and this needs {need_family}")
if problems:
    print("QUOTA: " + "; ".join(problems))
    sys.exit(1)
PY
}

# Puts the locked-down fleet back after a failed scale-up: firewall closed, extra VMs and IPs gone, and
# every judge that is still in the fleet running (a resize that fails halfway leaves its VM stopped).
restore() {
  say "restoring the locked-down state with $cur judge(s)"
  (cd "$TF_DIR" && ./lock-judges.sh -auto-approve -var "judge_count=$cur") || say "COULD NOT RESTORE THE LOCKDOWN: run: cd infra/terraform && ./lock-judges.sh -var judge_count=$cur"
  local rg name
  rg="$(rg_name)"
  while read -r name || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    say "starting stopped judge $name"
    "$AZ" vm start -g "$rg" -n "$name" -o none || say "could not start $name: start it in the portal"
  done < <("$AZ" vm list -g "$rg" -d --query "[?tags.role=='judge' && powerState!='VM running'].name" -o tsv)
}
opened=0 finished=0
trap 'if [ "$opened" = 1 ] && [ "$finished" != 1 ]; then restore; fi' EXIT

if [ "$direction" = down ]; then
  remove=("${ips[@]:$target}")
  confirm "This destroys ${#remove[@]} judge VM(s): ${remove[*]}. Jobs they are running finish first." || die "cancelled"
  for ip in "${remove[@]}"; do
    say "draining $ip (the worker stops taking jobs and finishes the running ones)"
    sshj "$ip" 'sudo systemctl stop codearena-worker' || say "  could not stop the worker on $ip (is it already gone?): the queue re-delivers its jobs"
  done
  write_state "$target" "$size"
  tf apply -auto-approve -var "judge_count=$target" -var judge_bootstrap=false "${size_arg[@]}"
  keep=("${ips[@]:0:$target}")
  set_vars "${keep[@]}"
  say "done: $target judge(s). Reporting now: $(judges_reporting)"
  exit 0
fi

# ---- up -------------------------------------------------------------------------------------
if [ "$allow" = 0 ]; then
  running="$("$CURL" -fsS --max-time 10 "$api_url/api/contests" | json 'print(sum(1 for c in d["items"] if c["state"] == "running" and not c["slug"].startswith("lt-")))')"
  [ "$running" = 0 ] || die "a contest is running: scaling up opens the judge firewall for several minutes. Use --allow-running-contest only if you accept that."
fi
new=$((target - cur))
quota_check "$size" "$new"
confirm "This creates $new judge VM(s) ($size, about \$0.13/h each) and opens the judge firewall for several minutes." || die "cancelled"

started="$(now)"
opened=1
tf apply -auto-approve -var "judge_count=$target" -var judge_bootstrap=true -var "judge_bootstrap_from=$cur" "${size_arg[@]}"
mapfile -t all < <(current_ips)
fresh=("${all[@]:$cur}")
[ "${#fresh[@]}" -eq "$new" ] || die "expected $new new judge(s), Terraform has ${#fresh[@]}"

say "waiting for cloud-init on: ${fresh[*]}"
for ip in "${fresh[@]}"; do
  t0="$(now)"
  until sshj "$ip" 'cloud-init status --wait' >/dev/null 2>&1; do
    [ $(($(now) - t0)) -lt "$READY_TIMEOUT" ] || die "$ip did not finish cloud-init within ${READY_TIMEOUT}s"
    sleep "$POLL"
  done
  say "  $ip: cloud-init finished after $(($(now) - t0)) s"
  # the deploy pipeline connects with its own key
  sshj "$ip" "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$(cat "$DEPLOY_KEY.pub")' ~/.ssh/authorized_keys || echo '$(cat "$DEPLOY_KEY.pub")' >> ~/.ssh/authorized_keys"
done

write_state "$target" "$size"
say "locking the judges down (no public IP, egress only to Redis and storage)"
(cd "$TF_DIR" && ./lock-judges.sh -auto-approve)
opened=0 # the lockdown above closed the firewall again
for ip in "${fresh[@]}"; do
  if sshj "$ip" 'curl -m 5 -sI https://example.com >/dev/null 2>&1'; then die "$ip still reaches the internet: the lockdown did not take; do not run contests until fixed"; fi
done
say "  new judges have no internet (good)"

set_vars "${all[@]}"

say "installing the worker on the new judges"
run="$("$GH" run list --workflow deploy --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
[ -n "$run" ] || die "no successful deploy run to take the worker from: run the deploy workflow, it will install it on every judge"
bin="$(mktemp -d)"
trap 'rm -rf "$bin"' EXIT
"$GH" run download "$run" -n judge-binaries -D "$bin" || die "the worker artifact has expired: run the deploy workflow (it installs the worker on every judge)"
cfg_dir="$(mktemp -d)"; trap 'rm -rf "$bin" "$cfg_dir"' EXIT
api_key="$("$GH" api "repos/{owner}/{repo}/actions/variables/API_HOST_KEY" --jq .value)"
host_keys="$("$GH" api "repos/{owner}/{repo}/actions/variables/JUDGE_HOST_KEYS" --jq .value)"
SSH_DIR="$cfg_dir" DEPLOY_SSH_KEY="$(cat "$DEPLOY_KEY")" API_HOST="$api_ip" API_HOST_KEY="$api_key" JUDGE_HOST_KEYS="$host_keys" \
  bash "$ROOT/infra/prod/ci/ssh-config.sh" >/dev/null
SSH_CONFIG="$cfg_dir/config" JUDGE_HOSTS="${fresh[*]}" \
  bash "$ROOT/infra/prod/ci/deploy-judges.sh" "$bin/worker" "$bin/node_exporter"

say "waiting for the new judges to report to the queue"
t0="$(now)"
until [ "$(judges_reporting)" -ge "$target" ]; do
  [ $(($(now) - t0)) -lt 300 ] || die "only $(judges_reporting) of $target judges report after 5 minutes (check: ssh -J ... 'journalctl -u codearena-worker')"
  sleep 5
done
finished=1
say "done: $target judge(s) report. Whole scale-out took $(($(now) - started)) s."
say "Remember: scale back with 'scripts/scale-judges.sh to 1' when you no longer need them (about \$0.13/h per extra D2s_v5)."
