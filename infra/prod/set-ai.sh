#!/usr/bin/env bash
# Turns the AI features on: stores the Groq and/or Google AI Studio key on the API server and restarts the API.
#   infra/prod/set-ai.sh groq      # asks for the Groq key (starts with gsk_)
#   infra/prod/set-ai.sh gemini    # asks for the Google AI Studio key (starts with AIza)
#   infra/prod/set-ai.sh all       # both (recommended: each is the other's fallback)
# Each key is typed or pasted ONCE at a hidden prompt (nothing is echoed). Paste only the value, never a
# command. The values go straight to the server's prod.env and are never printed or logged.
set -euo pipefail

host="${API_HOST:-40.83.75.34}" key="${DEPLOY_KEY:-$HOME/.ssh/codearena_deploy}" user=codearena
which="${1:-}"
case "$which" in
  groq) keys="GROQ_API_KEY" ;;
  gemini) keys="GEMINI_API_KEY" ;;
  all) keys="GROQ_API_KEY GEMINI_API_KEY" ;;
  *) echo "usage: set-ai.sh groq|gemini|all" >&2; exit 2 ;;
esac

remote='cd /opt/codearena && set -e'
for k in $keys; do
  # Older installs do not have the line yet: add it as "not-configured" (the API ignores that value), then set it.
  remote="$remote; ./init-env.sh ensure prod $k not-configured >/dev/null; echo; echo '--> $k: paste the key once, then press Enter'; ./init-env.sh set $k"
done
remote="$remote; echo; echo 'restarting the API...'; API_IMAGE=\$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml up -d --force-recreate api"
remote="$remote; for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/health/ready >/dev/null 2>&1 && echo 'API is back up.' && exit 0; sleep 2; done; echo 'API did not come back: run docker compose logs api on the server'; exit 1"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scp -q -i "$key" "$here/init-env.sh" "$user@$host:/opt/codearena/init-env.sh"

exec ssh -t -i "$key" "$user@$host" "$remote"
