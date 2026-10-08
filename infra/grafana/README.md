# Grafana as code (O-01)

Dashboards and alert rules for CodeArena, kept as JSON so they are reviewed and versioned like code.

| File                          | What                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboards/contest-ops.json` | What an organiser watches in a contest: queue depth per lane, time to verdict p50/p95, queue wait, verdicts, dead letters, board update and delivery p95, SSE connections |
| `dashboards/judge-fleet.json` | Judge workers: busy ratio, jobs in flight, outcomes, job duration, reclaimed/lease-lost/quarantined, checker errors                                                       |
| `dashboards/api.json`         | Requests, latency, 5xx share, slowest routes, results handled, rate limiting                                                                                              |
| `alerts.json`                 | The alerts of SD-§15.3: dead letters > 0, no judge heartbeat for 30 s, contest p95 > 10 s for 2 min, 5xx > 2 % for 2 min, board propagation p95 > 5 s                     |
| `push.sh`                     | Uploads all of it to a Grafana Cloud stack with a service-account token (hidden prompt)                                                                                   |

## Wiring (once)

1. `terraform apply` (new port 4318 judge → API VM, ADR-009 addendum).
2. `infra/prod/set-grafana.sh`: stores the OTLP endpoint, instance id and token on the API server, starts the collector, restarts the API.
3. Re-run the deploy workflow so the judges get `OTEL_EXPORTER_OTLP_ENDPOINT` in their `worker.env`.
4. `infra/grafana/push.sh https://<stack>.grafana.net`.

Manual fallback for step 4: Dashboards > New > Import, paste each file (choose your Prometheus data source); alert rules can be recreated from the `expr` and threshold in `alerts.json`.

## Finding the trace of one submission

Spans carry the submission id. Grafana > Explore > Tempo > TraceQL: `{ span.submission.id = "<submission id>" }`, open the trace it finds (the API request log line also has the `traceId`). One trace shows `http POST /api/submissions` → `queue.enqueue` → `judge.claim` (the wait in the queue) → `judge.job` → `judge.compile`, `judge.test` (+ `judge.checker`) per test → `judge.publish` → `queue.result` → `board.update` and `sse.publish`.

## Metric names

SD-§15.2 lists `ca_dlq_total`; it exists as two series, `ca_queue_dlq_total` (worker) and `ca_results_dlq_total` (API). The dashboards and alerts use those. `infra`-level tests check that every metric a dashboard or alert uses is emitted by the code.
