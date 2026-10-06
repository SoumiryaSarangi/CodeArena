#!/usr/bin/env bash
# Start the dev stack and verify every service is reachable.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait --wait-timeout 90 postgres redis s3 otel-collector
docker compose run --rm s3-init

docker compose exec -T postgres psql -U codearena -d codearena -c 'select 1' >/dev/null
docker compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_ADMIN_PASSWORD" redis-cli --user admin ping' | grep -q PONG
docker compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_JUDGE_PASSWORD" redis-cli --user judge ping' | grep -q PONG
docker compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_API_PASSWORD" redis-cli --user api ping' | grep -q PONG
curl -s -o /dev/null -w '%{http_code}' http://localhost:8333/ | grep -q '^[234]'
curl -fsS http://localhost:13133/ >/dev/null
echo "✓ postgres, redis (admin+api+judge), s3 (seaweedfs), otel-collector are up"
