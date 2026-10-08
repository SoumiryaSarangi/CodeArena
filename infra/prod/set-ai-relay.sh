#!/usr/bin/env bash
# Connects the API to the AI relay on Vercel (the AI providers refuse the API VM's region, so the API sends its
# model calls to the relay and the relay forwards them from a supported region).
#   infra/prod/set-ai-relay.sh            # makes a secret, stores it on the API server, copies it to your clipboard
# What you do next (once): in Vercel -> your project -> Settings -> Environment Variables, add
#   AI_RELAY_SECRET = <paste>  (Production), then Deployments -> Redeploy. Nothing is printed here; the secret
# is kept only in the server's prod.env and in a mode-600 file on this machine (~/.codearena-relay-secret) until
# you have pasted it into Vercel (delete that file afterwards).
set -euo pipefail

host="${API_HOST:-40.83.75.34}" key="${DEPLOY_KEY:-$HOME/.ssh/codearena_deploy}" user=codearena
web="${WEB_URL:-https://code-arena-eta-mauve.vercel.app}"
file="${RELAY_SECRET_FILE:-$HOME/.codearena-relay-secret}"

if [ ! -s "$file" ]; then
  umask 077
  openssl rand -hex 24 > "$file"   # 48 hex characters
fi
chmod 600 "$file"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scp -q -i "$key" "$here/init-env.sh" "$user@$host:/opt/codearena/init-env.sh"

# The value goes over ssh on stdin, never on a command line. `init-env.sh ensure` adds the two lines when they
# are missing; `set` then replaces the value.
ssh -i "$key" "$user@$host" "cd /opt/codearena && set -e; ./init-env.sh ensure prod AI_RELAY_URL $web >/dev/null; ./init-env.sh ensure prod AI_RELAY_SECRET not-configured >/dev/null; ./init-env.sh set AI_RELAY_URL >/dev/null; ./init-env.sh set AI_RELAY_SECRET >/dev/null; echo stored" < <(printf '%s\n%s\n' "$web" "$(cat "$file")")

ssh -i "$key" "$user@$host" 'cd /opt/codearena && API_IMAGE=$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml up -d --force-recreate api >/dev/null && for i in $(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/health/ready >/dev/null 2>&1 && echo "API is back up." && exit 0; sleep 2; done; echo "API did not come back"; exit 1'

if command -v clip.exe >/dev/null 2>&1; then tr -d '\n' < "$file" | clip.exe && echo "The secret is on your clipboard: paste it into Vercel as AI_RELAY_SECRET (Production), then Redeploy."
else echo "Copy the secret from $file into Vercel as AI_RELAY_SECRET (Production), then Redeploy."; fi
