#!/usr/bin/env bash
# Connects the API server (and, after the next deploy, the judges) to Grafana Cloud, from your own machine.
#   infra/prod/set-grafana.sh
# You are asked for three values, each typed or pasted ONCE at a hidden prompt (nothing is echoed):
#   1. the OTLP endpoint of your Grafana Cloud stack   (Connections > OpenTelemetry > "OTLP endpoint", ends in /otlp)
#   2. the instance ID                                 (the number next to it)
#   3. an access-policy token with the scopes metrics:write and traces:write
# They go straight to the server's prod.env and are never printed or logged. The script then starts the
# collector and restarts the API so it begins exporting.
set -euo pipefail

host="${API_HOST:-40.83.75.34}" key="${DEPLOY_KEY:-$HOME/.ssh/codearena_deploy}" user=codearena

remote='cd /opt/codearena && set -e'
for k in GRAFANA_OTLP_ENDPOINT GRAFANA_INSTANCE_ID GRAFANA_TOKEN; do
  remote="$remote; ./init-env.sh ensure prod $k not-configured >/dev/null; echo; echo '--> $k: paste the value once, then press Enter'; ./init-env.sh set $k"
done
# The API talks to the collector inside the Compose network; the judges use its private address.
remote="$remote; ./init-env.sh ensure prod OTEL_EXPORTER_OTLP_ENDPOINT http://otelcol:4318"
remote="$remote; ip=\$(grep '^API_PRIVATE_IP=' prod.env | cut -d= -f2); ./init-env.sh ensure judge OTEL_EXPORTER_OTLP_ENDPOINT http://\$ip:4318"
remote="$remote; echo; echo 'starting the collector and restarting the API...'"
remote="$remote; API_IMAGE=\$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml --profile observability up -d --force-recreate otelcol api"
remote="$remote; sha256sum otelcol.yaml | cut -d' ' -f1 > state/otelcol.sha"
remote="$remote; for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/health/ready >/dev/null 2>&1 && echo 'API is back up; telemetry is flowing to Grafana Cloud.' && exit 0; sleep 2; done; echo 'API did not come back: run docker compose logs api on the server'; exit 1"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scp -q -i "$key" "$here/init-env.sh" "$here/otelcol.yaml" "$here/docker-compose.yml" "$user@$host:/opt/codearena/"
exec ssh -t -i "$key" "$user@$host" "$remote"
