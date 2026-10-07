#!/usr/bin/env bash
# Sets sign-in credentials on the API server and restarts the API, from your own machine.
#   infra/prod/set-oauth.sh google     # asks for the Google client ID, then the secret
#   infra/prod/set-oauth.sh github     # asks for the GitHub client ID, then the secret
#   infra/prod/set-oauth.sh all        # both
# Each value is typed or pasted ONCE at a hidden prompt (nothing is echoed). Paste only the value, never
# a command. The values go straight to the server's prod.env and are never printed or logged.
set -euo pipefail

host="${API_HOST:-40.83.75.34}" key="${DEPLOY_KEY:-$HOME/.ssh/codearena_deploy}" user=codearena
which="${1:-}"
case "$which" in
  google) keys="OAUTH_GOOGLE_CLIENT_ID OAUTH_GOOGLE_CLIENT_SECRET" ;;
  github) keys="OAUTH_GITHUB_CLIENT_ID OAUTH_GITHUB_CLIENT_SECRET" ;;
  all) keys="OAUTH_GOOGLE_CLIENT_ID OAUTH_GOOGLE_CLIENT_SECRET OAUTH_GITHUB_CLIENT_ID OAUTH_GITHUB_CLIENT_SECRET" ;;
  *) echo "usage: set-oauth.sh google|github|all" >&2; exit 2 ;;
esac

remote='cd /opt/codearena && set -e'
for k in $keys; do remote="$remote; echo; echo '--> $k: paste the value once, then press Enter'; ./init-env.sh set $k"; done
remote="$remote; echo; echo 'restarting the API...'; docker compose --env-file prod.env -f docker-compose.yml up -d --force-recreate api"
remote="$remote; for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/health/ready >/dev/null 2>&1 && echo 'API is back up.' && exit 0; sleep 2; done; echo 'API did not come back: run docker compose logs api on the server'; exit 1"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Make sure the server has the current checker (a deploy also uploads it).
scp -q -i "$key" "$here/init-env.sh" "$user@$host:/opt/codearena/init-env.sh"

exec ssh -t -i "$key" "$user@$host" "$remote"
