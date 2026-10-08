#!/usr/bin/env bash
# O-03 rehearsal on this machine: the real API, one real worker (isolate) and the Compose
# Postgres/Redis/S3, with a small burst. Proves seed → burst → report → cleanup end to end before
# anything touches production. Numbers from here say nothing about production capacity.
#
#   tests/load/local.sh            # 40 submissions in 20 s, 20 SSE listeners
#   SUBS=100 WINDOW=40 LISTENERS=50 tests/load/local.sh
#
# Needs: docker compose up (postgres redis s3), problems imported (`pnpm problem:import --publish
# problems`), isolate (scripts/setup-isolate-wsl.sh), go, node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUBS="${SUBS:-40}" WINDOW="${WINDOW:-20}" LISTENERS="${LISTENERS:-20}" USERS="${USERS:-20}"
PORT="${PORT:-4010}"
TMP="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  (cd "$ROOT/apps/api" && LOAD_TEST=on npx tsx src/modules/load/load-cli.ts cleanup) || true
  chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"
}
trap cleanup EXIT
say() { printf '\n== %s\n' "$*"; }

say "building the worker"
(cd "$ROOT/apps/worker" && go build -o "$TMP/worker" .)

say "starting the API on :$PORT and one worker"
# `node --import tsx` is one process (npx would leave a child behind when the script ends).
(cd "$ROOT/apps/api" && PORT="$PORT" NODE_ENV=development LOG_LEVEL=warn RATE_LIMIT_DEFAULT_PER_MIN=100000 \
  exec node --import tsx src/main.ts >"$TMP/api.log" 2>&1) &
PIDS+=("$!")
env -i PATH="$PATH" HOME="$HOME" \
  REDIS_URL="redis://judge:judge-dev@localhost:6379" \
  S3_ENDPOINT=http://localhost:8333 S3_BUCKET=codearena S3_ACCESS_KEY=codearena S3_SECRET_KEY=codearena-dev \
  WORKER_ID=load-local WORKER_LANES=contest,practice,rejudge WORKER_CONCURRENCY=2 \
  WORKER_BOX_BASE=600 WORKER_CORES=0,1 WORKER_CACHE_DIR="$TMP/cache" \
  "$TMP/worker" >"$TMP/worker.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 60); do curl -fsS "http://localhost:$PORT/api/health/ready" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://localhost:$PORT/api/health/ready" >/dev/null || { tail -20 "$TMP/api.log"; exit 1; }

say "seeding $USERS users"
(cd "$ROOT/apps/api" && LOAD_TEST=on npx tsx src/modules/load/load-cli.ts seed --users "$USERS" --out "$TMP/seed.json")
SLUG="$(node -p "require('$TMP/seed.json').contest.slug")"

say "burst: $SUBS submissions in ${WINDOW}s, $LISTENERS listeners"
node "$ROOT/tests/load/burst.mjs" run --api "http://localhost:$PORT" --seed "$TMP/seed.json" \
  --submissions "$SUBS" --window "$WINDOW" --listeners "$LISTENERS" --judges 1 --out "$TMP/run.json" \
  || { echo "burst failed"; tail -15 "$TMP/worker.log"; tail -15 "$TMP/api.log"; exit 1; }

say "server-side report"
(cd "$ROOT/apps/api" && LOAD_TEST=on npx tsx src/modules/load/load-cli.ts report "$SLUG" --out "$TMP/report.json")
node "$ROOT/scripts/metrics-report.mjs" --run "$TMP/run.json" --report "$TMP/report.json" --out "${METRICS_OUT:-$TMP/METRICS.md}" --label "local rehearsal"
echo "metrics written to ${METRICS_OUT:-$TMP/METRICS.md}"
cat "${METRICS_OUT:-$TMP/METRICS.md}"
