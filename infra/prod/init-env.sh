#!/usr/bin/env bash
# Creates the production secrets file on the API VM. Run once, ON the server:
#
#   ./init-env.sh init --api-ip 40.83.75.34 --api-private-ip 10.20.1.4 --web-url https://codearena.vercel.app
#   ./init-env.sh set OAUTH_GOOGLE_CLIENT_ID          # prompts (hidden), updates one value
#   ./init-env.sh ensure prod|judge KEY VALUE         # adds KEY=VALUE if the key is missing (not secret values)
#   ./init-env.sh show-keys                           # lists which keys are set (never the values)
#
# Every password and key is generated here with openssl, so no secret is ever typed, pasted into a
# chat, or stored in GitHub. Files are written 0600. APP_DIR (default /opt/codearena) can be
# overridden for tests.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/codearena}"
ENV_FILE="$APP_DIR/prod.env"
JUDGE_ENV_FILE="$APP_DIR/judge-worker.env"

die() { echo "error: $*" >&2; exit 1; }
rand() { openssl rand -hex 24; }

# Values end up in an env file read by Docker and by systemd: keep them to a safe alphabet so
# nothing needs escaping and nothing can inject a second variable.
safe() { [[ "$2" =~ ^[A-Za-z0-9._:/@+=,-]+$ ]] || die "$1 contains characters that are not allowed ($2)"; }

cmd="${1:-}"; shift || true

case "$cmd" in
init)
  api_ip="" private_ip="" web_url="" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --api-ip) api_ip="$2"; shift 2 ;;
      --api-private-ip) private_ip="$2"; shift 2 ;;
      --web-url) web_url="$2"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -n "$api_ip" ] && [ -n "$private_ip" ] && [ -n "$web_url" ] || die "need --api-ip, --api-private-ip and --web-url"
  [[ "$api_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--api-ip must be an IPv4 address"
  [[ "$private_ip" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--api-private-ip must be a 10.x.x.x address"
  [[ "$web_url" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "--web-url must look like https://name.vercel.app (no path, no trailing slash)"
  if [ -e "$ENV_FILE" ] && [ "$force" != 1 ]; then
    die "$ENV_FILE already exists; refusing to overwrite secrets (pass --force only if you mean to rotate everything)"
  fi
  command -v openssl >/dev/null || die "openssl is required"
  mkdir -p "$APP_DIR/state"

  api_host="api.${api_ip//./-}.sslip.io"
  pg="$(rand)" r_admin="$(rand)" r_api="$(rand)" r_judge="$(rand)" plag_token="$(rand)" collab_token="$(rand)"
  s3_api_ak="api$(openssl rand -hex 8)" s3_api_sk="$(rand)"
  s3_judge_ak="judge$(openssl rand -hex 8)" s3_judge_sk="$(rand)"

  # ES256 access-token keys, one line each with literal \n (the API turns them back into PEM).
  private="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)"
  public="$(printf '%s\n' "$private" | openssl pkey -pubout 2>/dev/null)"
  oneline() { printf '%s' "$1" | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }

  umask 077
  cat > "$ENV_FILE" <<ENV
# Production settings (D-02). Created by init-env.sh. Mode 0600. Do not commit or paste.
NODE_ENV=production
PORT=4000
TRUST_PROXY=1

# Edge (Caddy)
API_HOST=$api_host
WEB_ORIGIN=$web_url
API_PRIVATE_IP=$private_ip

# API
WEB_URL=$web_url
# The address the BROWSER uses for /api/*: the web origin, because the web app forwards /api to this
# server (Vercel rewrite). OAuth callbacks come back through it, so the login cookie is set on the web
# domain, where the browser will send it again. (Using the API host here would set the cookie on the
# wrong domain and sign-in would never stick.) The API host above carries the realtime stream only.
PUBLIC_API_URL=$web_url
DATABASE_URL=postgres://codearena:$pg@postgres:5432/codearena
REDIS_URL=redis://api:$r_api@redis:6379
S3_ENDPOINT=http://s3:8333
S3_BUCKET_TESTS=codearena
S3_ACCESS_KEY=$s3_api_ak
S3_SECRET_KEY=$s3_api_sk
JWT_PRIVATE_KEY='$(oneline "$private")'
JWT_PUBLIC_KEY='$(oneline "$public")'
JWT_ISSUER=codearena

# Sign-in. The API refuses to start without these four, so they start as placeholders: the site
# comes up, sign-in does not work until you set the real values (./init-env.sh set <NAME>).
OAUTH_GOOGLE_CLIENT_ID=not-configured
OAUTH_GOOGLE_CLIENT_SECRET=not-configured
OAUTH_GITHUB_CLIENT_ID=not-configured
OAUTH_GITHUB_CLIENT_SECRET=not-configured

# Plagiarism job (PL-05): the shared secret between the API and the plag job (header X-Service-Token). The job itself
# stays off until it is started with `--profile plag`; an older install adds this with `init-env.sh ensure prod`.
PLAG_SERVICE_TOKEN=$plag_token

# Interview pad (CP-DEPLOY): the secret between the API and the collab servers (header X-Service-Token), and where the API
# reaches both instances to end a room's sessions. The servers stay off until started with `--profile collab`; an older
# install adds these with `init-env.sh ensure prod`.
COLLAB_SERVICE_TOKEN=$collab_token
COLLAB_URL=http://collab1:1234,http://collab2:1234

# Containers (Compose reads these for the services themselves)
POSTGRES_PASSWORD=$pg
REDIS_ADMIN_PASSWORD=$r_admin
REDIS_API_PASSWORD=$r_api
REDIS_JUDGE_PASSWORD=$r_judge
S3_API_ACCESS_KEY=$s3_api_ak
S3_API_SECRET_KEY=$s3_api_sk
S3_JUDGE_ACCESS_KEY=$s3_judge_ak
S3_JUDGE_SECRET_KEY=$s3_judge_sk
ENV

  # What a judge host gets: the Redis `judge` user and the read-only object-storage key, and nothing
  # else (no database, no API secrets: ADR-009). The pipeline copies this file to the judges.
  cat > "$JUDGE_ENV_FILE" <<ENV
# Judge worker settings (D-02). Created by init-env.sh. Mode 0600.
REDIS_URL=redis://judge:$r_judge@$private_ip:6379
S3_ENDPOINT=http://$private_ip:8333
S3_BUCKET=codearena
S3_ACCESS_KEY=$s3_judge_ak
S3_SECRET_KEY=$s3_judge_sk
WORKER_LANES=contest,interactive,practice,rejudge
WORKER_CONCURRENCY=2
WORKER_CORES=0,1
WORKER_CACHE_DIR=/var/cache/codearena/tests
ENV
  chmod 600 "$ENV_FILE" "$JUDGE_ENV_FILE"
  echo "Created $ENV_FILE and $JUDGE_ENV_FILE (mode 600)."
  echo "API host: $api_host"
  echo "Next: set the four OAUTH_* values with: ./init-env.sh set OAUTH_GOOGLE_CLIENT_ID (and the other three)"
  ;;

set)
  key="${1:-}"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "usage: init-env.sh set KEY   (KEY in capitals, e.g. OAUTH_GOOGLE_CLIENT_ID)"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist; run init first"
  grep -q "^$key=" "$ENV_FILE" || die "$key is not in $ENV_FILE"
  read -r -s -p "Value for $key (hidden): " value; echo
  value="${value//[[:space:]]/}"
  [ -n "$value" ] || die "$key: nothing was entered, nothing changed"
  safe "$key" "$value"
  # A Google client ID is exactly one "<digits>-<letters>.apps.googleusercontent.com". Pasting twice (or
  # pasting a whole command into the prompt) makes a longer string that Google reports as "client not found".
  if [ "$key" = OAUTH_GOOGLE_CLIENT_ID ]; then
    [[ "$value" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]] \
      || die "$key is not a single Google client ID (expected <digits>-<letters>.apps.googleusercontent.com, got ${#value} characters); nothing changed"
  fi
  tmp="$(mktemp "$APP_DIR/.env.XXXXXX")"
  chmod 600 "$tmp"
  # Replace the line without ever putting the value on a command line.
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "$key="* ]]; then printf '%s=%s\n' "$key" "$value"; else printf '%s\n' "$line"; fi
  done < "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "$key updated (${#value} characters)."
  ;;

ensure)
  which="${1:-}" key="${2:-}" value="${3:-}"
  case "$which" in prod) file="$ENV_FILE" ;; judge) file="$JUDGE_ENV_FILE" ;; *) die "usage: init-env.sh ensure prod|judge KEY VALUE" ;; esac
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "KEY must be in capitals"
  [ -f "$file" ] || die "$file does not exist; run init first"
  safe "$key" "$value"
  # Existing values are never touched (use `set` to change one); this only adds what an older
  # install does not have yet.
  if grep -q "^$key=" "$file"; then echo "$key is already in $(basename "$file")."; else printf '%s=%s\n' "$key" "$value" >> "$file"; echo "$key added to $(basename "$file")."; fi
  ;;

show-keys)
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist"
  grep -v '^#' "$ENV_FILE" | grep '=' | while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    case "$v" in not-configured|'') echo "$k  (NOT SET)" ;; *) echo "$k  (set)" ;; esac
  done
  ;;

*)
  die "usage: init-env.sh init|set|ensure|show-keys (see the header of this file)"
  ;;
esac
