#!/usr/bin/env bash
# Tests for init-env.sh: what it writes must pass the API's production config check, secrets must be
# strong, private to the file mode, and judge hosts must get only what ADR-009 allows them.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INIT="$HERE/../init-env.sh"
ROOT="$(cd "$HERE/../../.." && pwd)"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }

new_dir() { T="$(mktemp -d)"; export APP_DIR="$T/app"; mkdir -p "$APP_DIR"; }
init() { "$INIT" init --api-ip 40.83.75.34 --api-private-ip 10.20.1.4 --web-url https://codearena.vercel.app "$@"; }
validate() { (cd "$ROOT/apps/api" && pnpm exec tsx "$HERE/check-config.mts" "$1" 2>&1 | tail -1); }

echo "D-02: init-env.sh"

new_dir
init >/dev/null 2>&1; rc=$?
check "init succeeds" "$([ $rc = 0 ] && echo 0 || echo 1)"
check "prod.env is mode 600" "$([ "$(stat -c %a "$APP_DIR/prod.env")" = 600 ] && echo 0 || echo 1)"
check "judge-worker.env is mode 600" "$([ "$(stat -c %a "$APP_DIR/judge-worker.env")" = 600 ] && echo 0 || echo 1)"
out="$(validate "$APP_DIR/prod.env")"
check "the API's production config accepts it ($out)" "$([[ "$out" == OK* ]] && echo 0 || echo 1)"
check "the API talks to Redis as the 'api' user, over TRUST_PROXY=1" "$([[ "$out" == *"trust=1"* && "$out" == *"redis=api"* ]] && echo 0 || echo 1)"
check "OAuth callbacks are built on the WEB origin, so the login cookie is first-party there" "$([[ "$out" == *"api=https://codearena.vercel.app"* ]] && echo 0 || echo 1)"
check "the API host is kept separately for Caddy and the realtime stream" "$(grep -q '^API_HOST=api.40-83-75-34.sslip.io$' "$APP_DIR/prod.env" && grep -q '^WEB_ORIGIN=https://codearena.vercel.app$' "$APP_DIR/prod.env" && echo 0 || echo 1)"

echo "- secrets"
pw() { grep "^$1=" "$APP_DIR/prod.env" | cut -d= -f2-; }
check "passwords are 48 hex characters" "$([ "$(pw POSTGRES_PASSWORD | tr -d '\n' | wc -c)" = 48 ] && pw POSTGRES_PASSWORD | grep -qE '^[0-9a-f]{48}$' && echo 0 || echo 1)"
check "the three Redis users and Postgres all differ" "$([ "$(printf '%s\n' "$(pw POSTGRES_PASSWORD)" "$(pw REDIS_ADMIN_PASSWORD)" "$(pw REDIS_API_PASSWORD)" "$(pw REDIS_JUDGE_PASSWORD)" | sort -u | wc -l)" = 4 ] && echo 0 || echo 1)"
first="$(pw POSTGRES_PASSWORD)"
T2="$(mktemp -d)"; APP_DIR="$T2/app" init >/dev/null 2>&1
check "two runs give different secrets" "$([ "$first" != "$(grep '^POSTGRES_PASSWORD=' "$T2/app/prod.env" | cut -d= -f2-)" ] && echo 0 || echo 1)"
check "JWT private key is a PEM written on one line" "$(grep -q "^JWT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----" "$APP_DIR/prod.env" && ! grep -q '^-----' "$APP_DIR/prod.env" && echo 0 || echo 1)"

echo "- the judge only gets what it may have (ADR-009)"
keys="$(grep -v '^#' "$APP_DIR/judge-worker.env" | cut -d= -f1 | sort | tr '\n' ' ')"
check "exact set of judge variables" "$([ "$keys" = "REDIS_URL S3_ACCESS_KEY S3_BUCKET S3_ENDPOINT S3_SECRET_KEY WORKER_CACHE_DIR WORKER_CONCURRENCY WORKER_CORES WORKER_LANES " ] && echo 0 || echo 1)"
check "no database, JWT or OAuth secret reaches the judge file" "$(grep -qiE 'DATABASE|POSTGRES|JWT|OAUTH|REDIS_ADMIN|REDIS_API' "$APP_DIR/judge-worker.env" && echo 1 || echo 0)"
check "the judge connects as the 'judge' Redis user on the private address" "$(grep -q '^REDIS_URL=redis://judge:.*@10.20.1.4:6379$' "$APP_DIR/judge-worker.env" && echo 0 || echo 1)"
check "the judge's Redis password is the one Redis was configured with" "$([ "$(grep '^REDIS_URL=' "$APP_DIR/judge-worker.env" | sed 's|.*judge:\(.*\)@.*|\1|')" = "$(pw REDIS_JUDGE_PASSWORD)" ] && echo 0 || echo 1)"
check "the judge's storage key is the read-only identity, not the API's" "$([ "$(grep '^S3_ACCESS_KEY=' "$APP_DIR/judge-worker.env" | cut -d= -f2)" = "$(pw S3_JUDGE_ACCESS_KEY)" ] && [ "$(pw S3_JUDGE_ACCESS_KEY)" != "$(pw S3_API_ACCESS_KEY)" ] && echo 0 || echo 1)"

echo "- safety"
"$INIT" init --api-ip 40.83.75.34 --api-private-ip 10.20.1.4 --web-url https://codearena.vercel.app >/dev/null 2>&1; rc=$?
check "refuses to overwrite existing secrets" "$([ $rc != 0 ] && [ "$(pw POSTGRES_PASSWORD)" = "$first" ] && echo 0 || echo 1)"
for bad in "--api-ip 1.2.3.4;rm" "--api-ip 8.8.8.8x"; do
  N="$(mktemp -d)"; APP_DIR="$N/app" "$INIT" init $bad --api-private-ip 10.20.1.4 --web-url https://x.vercel.app >/dev/null 2>&1
  check "rejects a bad address ($bad)" "$([ $? != 0 ] && [ ! -e "$N/app/prod.env" ] && echo 0 || echo 1)"
done
N="$(mktemp -d)"; APP_DIR="$N/app" "$INIT" init --api-ip 1.2.3.4 --api-private-ip 192.168.0.4 --web-url https://x.vercel.app >/dev/null 2>&1
check "rejects a private address outside 10.x" "$([ $? != 0 ] && echo 0 || echo 1)"
N="$(mktemp -d)"; APP_DIR="$N/app" "$INIT" init --api-ip 1.2.3.4 --api-private-ip 10.0.0.4 --web-url "https://x.vercel.app/path" >/dev/null 2>&1
check "rejects a web URL with a path" "$([ $? != 0 ] && echo 0 || echo 1)"

echo "- setting a value"
before="$(pw JWT_ISSUER)"
printf '123456-abc.apps.googleusercontent.com\n' | "$INIT" set OAUTH_GOOGLE_CLIENT_ID >/dev/null 2>&1; rc=$?
check "set updates one value" "$([ $rc = 0 ] && [ "$(pw OAUTH_GOOGLE_CLIENT_ID)" = "123456-abc.apps.googleusercontent.com" ] && [ "$(pw JWT_ISSUER)" = "$before" ] && echo 0 || echo 1)"
check "the file is still mode 600 after an update" "$([ "$(stat -c %a "$APP_DIR/prod.env")" = 600 ] && echo 0 || echo 1)"
printf '123456-abc.apps.googleusercontent.com123456-abc.apps.googleusercontent.com\n' | "$INIT" set OAUTH_GOOGLE_CLIENT_ID >/dev/null 2>&1
check "a Google client ID pasted twice is refused and the good one is kept" "$([ $? != 0 ] && [ "$(pw OAUTH_GOOGLE_CLIENT_ID)" = "123456-abc.apps.googleusercontent.com" ] && echo 0 || echo 1)"
printf '  123456-def.apps.googleusercontent.com  \n' | "$INIT" set OAUTH_GOOGLE_CLIENT_ID >/dev/null 2>&1
check "spaces around a pasted value are trimmed" "$([ "$(pw OAUTH_GOOGLE_CLIENT_ID)" = "123456-def.apps.googleusercontent.com" ] && echo 0 || echo 1)"
printf 'abc;rm -rf /\n' | "$INIT" set OAUTH_GOOGLE_CLIENT_SECRET >/dev/null 2>&1
check "set refuses unsafe characters" "$([ $? != 0 ] && [ "$(pw OAUTH_GOOGLE_CLIENT_SECRET)" = not-configured ] && echo 0 || echo 1)"
printf 'x\n' | "$INIT" set NOT_A_KEY >/dev/null 2>&1
check "set refuses a key that is not in the file" "$([ $? != 0 ] && echo 0 || echo 1)"
shown="$("$INIT" show-keys)"
check "show-keys lists what is set without printing any secret" "$(echo "$shown" | grep -q 'OAUTH_GOOGLE_CLIENT_ID  (set)' && echo "$shown" | grep -q 'OAUTH_GITHUB_CLIENT_ID  (NOT SET)' && ! echo "$shown" | grep -q "$first" && echo 0 || echo 1)"
out="$(validate "$APP_DIR/prod.env")"
check "the config is still valid after an update" "$([[ "$out" == OK* ]] && echo 0 || echo 1)"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
