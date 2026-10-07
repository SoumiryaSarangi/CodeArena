#!/usr/bin/env bash
# One-time setup of the servers for the deploy pipeline. Run from your laptop (WSL), in the repository:
#
#   infra/prod/bootstrap.sh --api-ip 40.83.75.34 --api-private-ip 10.20.1.4 \
#       --judges "10.20.2.4" --web-url https://your-site.vercel.app
#
# What it does, in order (re-running is safe):
#   1. creates a SEPARATE ssh key for the pipeline (~/.ssh/codearena_deploy) unless it exists
#   2. authorizes that key on the API VM and on each judge (using YOUR key, as today)
#   3. creates /opt/codearena on the API VM and uploads the production files
#   4. generates every server secret ON the API VM (init-env.sh init), unless prod.env exists
#   5. reads the servers' host keys and prints the GitHub secret/variables to set; with --set-github
#      it sets them for you through the `gh` CLI (the private key is read from the file, never printed)
#
# Nothing secret is printed or passed through this chat: passwords are generated on the server, and the
# deploy key's private half only ever goes from its file into a GitHub secret.
set -euo pipefail

api_ip="" private_ip="" judges="" web_url="" set_github=0 user=codearena
key="${DEPLOY_KEY_FILE:-$HOME/.ssh/codearena_deploy}"
while [ $# -gt 0 ]; do
  case "$1" in
    --api-ip) api_ip="$2"; shift 2 ;;
    --api-private-ip) private_ip="$2"; shift 2 ;;
    --judges) judges="$2"; shift 2 ;;
    --web-url) web_url="$2"; shift 2 ;;
    --set-github) set_github=1; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[ -n "$api_ip" ] && [ -n "$private_ip" ] && [ -n "$judges" ] && [ -n "$web_url" ] || die "need --api-ip --api-private-ip --judges --web-url (see the header of this file)"
[[ "$api_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--api-ip must be an IPv4 address"
[[ "$private_ip" =~ ^10\.[0-9.]+$ ]] || die "--api-private-ip must be a 10.x address"
for j in $judges; do [[ "$j" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "judge '$j' must be a private 10.x address"; done
[[ "$web_url" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "--web-url must look like https://name.vercel.app (no path)"

here="$(cd "$(dirname "$0")" && pwd)"
infra="$(cd "$here/.." && pwd)"
api="$user@$api_ip"

echo "== 1/5 deploy key"
if [ ! -f "$key" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "codearena-deploy-pipeline" -f "$key"
  echo "created $key (private) and $key.pub"
else
  echo "using the existing $key"
fi
pub="$(cat "$key.pub")"

echo "== 2/5 authorize the key on the servers"
authorize='umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF "$KEYLINE" ~/.ssh/authorized_keys || echo "$KEYLINE" >> ~/.ssh/authorized_keys'
ssh -o StrictHostKeyChecking=accept-new "$api" "KEYLINE='$pub'; $authorize"
for j in $judges; do
  ssh -J "$api" -o StrictHostKeyChecking=accept-new "$user@$j" "KEYLINE='$pub'; $authorize"
done

echo "== 3/5 /opt/codearena and the production files"
ssh "$api" "sudo install -d -o $user -g $user /opt/codearena /opt/codearena/state && sudo usermod -aG docker $user"
tar -C "$infra" -cz --transform 's,^prod/,,' --exclude='prod/tests' --exclude='prod/ci' prod redis \
  | ssh "$api" 'tar -xz -C /opt/codearena && chmod +x /opt/codearena/deploy.sh /opt/codearena/init-env.sh'

echo "== 4/5 server secrets (generated on the server)"
if ssh "$api" 'test -f /opt/codearena/prod.env'; then
  echo "prod.env already exists: leaving the secrets alone"
else
  ssh "$api" "/opt/codearena/init-env.sh init --api-ip '$api_ip' --api-private-ip '$private_ip' --web-url '$web_url'"
fi

echo "== 5/5 host keys and GitHub settings"
api_key="$(ssh-keyscan -t ed25519 "$api_ip" 2>/dev/null | grep -v '^#' | head -1 || true)"
[ -n "$api_key" ] || die "could not read the API VM host key"
judge_keys=""
for j in $judges; do
  k="$(ssh -J "$api" "$user@$j" 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk -v h="$j" '{print h " " $1 " " $2}')"
  judge_keys="${judge_keys}${k}"$'\n'
done
judge_keys="${judge_keys%$'\n'}"

echo
echo "Host key fingerprints (compare with what you accepted the first time you logged in):"
ssh-keygen -lf <(printf '%s\n' "$api_key") | sed 's/^/  API VM:  /'
while IFS= read -r line; do [ -n "$line" ] && ssh-keygen -lf <(printf '%s\n' "$line") | sed 's/^/  judge:   /'; done <<< "$judge_keys"
echo

if [ "$set_github" = 1 ]; then
  command -v gh >/dev/null || die "--set-github needs the gh CLI (gh auth login)"
  gh secret set DEPLOY_SSH_KEY < "$key"
  gh variable set API_HOST --body "$api_ip"
  gh variable set API_HOST_KEY --body "$api_key"
  gh variable set JUDGE_HOSTS --body "$judges"
  gh variable set JUDGE_HOST_KEYS --body "$judge_keys"
  echo "GitHub secret DEPLOY_SSH_KEY and variables API_HOST, API_HOST_KEY, JUDGE_HOSTS, JUDGE_HOST_KEYS are set."
  echo "Still to do by hand: gh variable set DEPLOY_ENABLED --body true   (turns the pipeline on)"
else
  cat <<MSG
Run these in the repository to give the pipeline what it needs:

  gh secret set DEPLOY_SSH_KEY < $key
  gh variable set API_HOST --body '$api_ip'
  gh variable set API_HOST_KEY --body '$api_key'
  gh variable set JUDGE_HOSTS --body '$judges'
  gh variable set JUDGE_HOST_KEYS --body '$judge_keys'

(or re-run this script with --set-github), then turn the pipeline on with:

  gh variable set DEPLOY_ENABLED --body true
MSG
fi
echo
echo "Next: on the API VM set the four OAuth values (see infra/prod/README.md), then run the deploy workflow."
