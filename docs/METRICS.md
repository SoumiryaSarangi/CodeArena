# Metrics

Measured numbers, not estimates. Sections are written by scripts (`scripts/metrics-report.mjs` for the load
test) and replaced when the same run is repeated, so edit the text around them, not inside the markers.
Capacity maths and the predictions each result is compared with are in SYSTEM_DESIGN §2.3.

## Load test (O-03)

<!-- load-summary -->
| Run | Judges | Queue wait p50 / p95 | Time to verdict p50 / p95 | Burst drain | Predicted (SD-§2.3) | Throughput |
|---|---|---|---|---|---|---|
| judges=1 (B2s_v2) | 1 | 26.1 / 48.6 s | 26.6 / 50.8 s | 58 s | 15 min 0 s | 2.76/s |
| judges=2 (B2s_v2) | 2 | 0.0 / 0.5 s | 0.4 / 2.1 s | 2 s | – | 4.00/s |
<!-- /load-summary -->

### How to read these (written by hand; the blocks below are generated)

- **The estimate was too pessimistic.** SYSTEM_DESIGN §2.2 assumed a blended 4 s of judge time per submission (0.5 submissions/s per judge). Measured on the production judge: C++ 0.44-0.51 s and Python 0.92-1.12 s on average, so one judge sustained 2.8 submissions/s and drained the whole burst 58 s after the last submit (predicted 15 minutes). Two judges split the work evenly (264 and 236 runs) and the queue never grew beyond 8.
- **Caveat.** The three test problems are light (a handful of small tests each). The six contest problems may take longer per submission; a TLE costs the full limit once (8.8% of the mix). Use the 2-judge result as headroom, not as a promise.
- **Only 1 and 2 judges could be measured.** This Azure for Students subscription allows 6 vCPUs per region in total (API 2 + 2 per judge) and has no quota for the D2s_v5 family, so the planned runs at 3 and 6 judges and on non-burstable VMs are not possible without a quota increase. Both runs used Standard_B2s_v2 (burstable).
- **Burstable CPU.** The judge started the first run with 1,210 CPU credits and ran at 87-98% CPU during the burst; the burst (3 minutes) used a small part of them. Sustained full load would use roughly 70 credits a minute (about 17 minutes of 100% on both vCPUs), so a long, heavy queue could throttle a single judge; the contest load (about 0.17 submissions/s at the peak) is far below that.
- **Scale-out of one judge** (from the script's log, `scripts/scale-judges.sh up 1`): VM created in 55 s, first-boot setup done 26 s after it answered, firewall lockdown apply about 45 s, worker installed and reporting about 1 minute later: **about 6-7 minutes** end to end. (This run's last step was finished by hand because of a bug in the script, fixed afterwards, so the end-to-end figure is from the step timings.)
- **Live updates.** 194-195 of 200 listeners connected; the rest and about 3,900 retries were refused with HTTP 429: `GET /api/sse` uses the default per-IP limit of 120 requests a minute and all 200 test listeners came from one address. Contestants behind one campus address could meet the same limit (follow-up X-10 in PROGRESS). **After X-10 (limits changed, same test with 30 submissions): all 200 listeners connected in about 9 s with 0 refusals and 0 drops (before: 5 refused, about 3,900 retries).** No stream dropped once connected; 42,500 to 54,500 events were delivered per run.
- The client was a laptop on the internet, so the accept latency (median 128 ms) includes the network.


<!-- load:judges=1-B2s_v2- -->
### Burst — judges=1 (B2s_v2)

2026-10-08 14:12 UTC · 500 submissions in 120 s · 1 judge VM(s) · 200 SSE listeners · client: remote

| What | Value |
|---|---|
| Accepted (HTTP 201) | 500 of 500 |
| Judged with a verdict | 500 of 500 |
| Accept latency p50 / p95 | 128 / 153 ms |
| Queue wait p50 / p95 / max | 26.1 / 48.6 / 57.1 s |
| Time to verdict p50 / p95 / max | 26.6 / 50.8 / 58.1 s |
| Burst drain (last submit → last verdict) | 58 s |
| Throughput while judging | 2.76 submissions/s |
| Peak queue depth (contest lane) | 146 |
| Workers seen | 1 (vm-codearena-prod-judge-0: 500) |
| Dead-letter entries | 0 |
| SSE | 194/200 connected, 54510 events, 0 drops, 3916 errors |

Verdicts: RE 11 · TLE 44 · AC 337 · WA 108

| Language | Runs | Mean service time | p50 | p95 |
|---|---|---|---|---|
| cpp17 | 331 | 0.51 s | 0.41 s | 1.55 s |
| python3 | 169 | 1.12 s | 0.42 s | 2.49 s |
<!--data {"label":"judges=1 (B2s_v2)","judges":1,"accepted":500,"submissions":500,"judged":500,"queueWaitP50":26.1370145,"queueWaitP95":48.64488915,"ttvP50":26.621983,"ttvP95":50.7672121,"drainSeconds":57.955405,"throughput":2.7642483179548987,"mean":{"cpp17":0.514012084592145,"python3":1.119112426035503},"scaleSeconds":null} -->
<!-- /load:judges=1-B2s_v2- -->

<!-- load:judges=2-B2s_v2- -->
### Burst — judges=2 (B2s_v2)

2026-10-08 14:28 UTC · 500 submissions in 120 s · 2 judge VM(s) · 200 SSE listeners · client: remote

| What | Value |
|---|---|
| Accepted (HTTP 201) | 500 of 500 |
| Judged with a verdict | 500 of 500 |
| Accept latency p50 / p95 | 128 / 167 ms |
| Queue wait p50 / p95 / max | 0.0 / 0.5 / 1.3 s |
| Time to verdict p50 / p95 / max | 0.4 / 2.1 / 3.3 s |
| Burst drain (last submit → last verdict) | 2 s |
| Throughput while judging | 4.00 submissions/s |
| Peak queue depth (contest lane) | 8 |
| Workers seen | 2 (vm-codearena-prod-judge-1: 264, vm-codearena-prod-judge-0: 236) |
| Dead-letter entries | 0 |
| SSE | 195/200 connected, 42501 events, 0 drops, 3949 errors |

Verdicts: RE 11 · TLE 44 · WA 108 · AC 337

| Language | Runs | Mean service time | p50 | p95 |
|---|---|---|---|---|
| cpp17 | 331 | 0.44 s | 0.35 s | 1.42 s |
| python3 | 169 | 0.92 s | 0.39 s | 2.40 s |
<!--data {"label":"judges=2 (B2s_v2)","judges":2,"accepted":500,"submissions":500,"judged":500,"queueWaitP50":0.0029890000000000003,"queueWaitP95":0.5088921499999988,"ttvP50":0.38339100000000004,"ttvP95":2.0752273499999987,"drainSeconds":2.24075,"throughput":3.9964192083892836,"mean":{"cpp17":0.4435317220543807,"python3":0.9172130177514793},"scaleSeconds":null} -->
<!-- /load:judges=2-B2s_v2- -->

## Failure drills (O-06)

Each drill judges a real contest of fake users, injects one fault and waits until every accepted
submission has a verdict. **Detected** = the first signal an operator would see (a judge gone from the ops
summary, a failed health check, a dead letter); **healthy** = the API answers again; **all judged** = the
fault until every accepted submission had its verdict; **after the last submit** = how long the last verdict took once submissions stopped (the lag the fault left behind). A drill passes only if every verdict exists exactly
once, nothing is stuck and the board equals the rebuild from Postgres (NFR-REL-01, FR-BOARD-03).

### How to read the drills (written by hand; the blocks below are generated)

- **Production passes all six drills; so does the local stack.** In each, every accepted submission got exactly one verdict, nothing stayed claimed or parked, and the board equalled the rebuild from Postgres.
- **A worker kill is invisible on production** (systemd restarts it within 3 s, before the console's 10 s threshold) and the other judge or the restarted one finishes the job; the last verdict came 4.5 s after the last submit. A judge VM that really stops (deallocated) vanishes from the console after about 11 s and the remaining judge takes over (31 s after the last submit with one judge left); the VM was back and reporting 26 s after `az vm start`.
- **The 40 s API "recovery" was a flaw in the drill, not a slow start (X-13, corrected).** The drill used `docker kill`, which Docker treats as a manual stop: the restart policy never fires (re-measured: container still `exited` after 90 s) and the drill's fallback `docker compose up -d api` ran after its 30 s wait. The app itself is listening about 3 s after the container starts (`/api/health/ready` 200 after about 6 s). A real crash (SIGKILL of the node process, as an out-of-memory kill would be) was measured directly on production: **back and ready in about 4 s, `RestartCount` 1**. The 37 refused submissions in the table below belong to the 40 s run and overstate a crash; the drill now kills the process itself. Not re-run as a full drill on production.
- **A Redis restart costs a few seconds of refused submissions:** clean restart about 5 s (6 of 60 refused), hard kill about 16 s (13 refused). A refused submission is stored as `failed` and the contestant gets an error, by design; nothing accepted was lost, and the live stream kept delivering events without reconnecting. Follow-up X-14 (retry safely with the idempotency key).
- **The poison drill found a real defect** (re-queueing a dead job kept its old run version, so the retry's verdict was discarded and the contestant stayed on SE); fixed in O-06 and shown passing on production: dead letter visible after 5 s, Re-queue ended in AC at run 2, dead-letter queue empty.
- Local numbers: a laptop, 2 workers of concurrency 1; the frozen worker is a SIGSTOP. "All judged after" is dominated by the 40 s of traffic; the useful figure is "after the last submit".

<!-- drills:local -->
### local

Run 2026-10-08 18:08 UTC.

| Drill | Fault | Detected after | Healthy after | All judged after | After the last submit | Accepted / refused | Result |
|---|---|---|---|---|---|---|---|
| Kill a judge worker while it is judging | kill -9 of the worker process | 9.2 s | 0.1 s | 27.6 s | 3.2 s | 60 / 0 | ✓ pass |
| Kill the API while submissions arrive | kill -9 of the API process (container) | 0 s | 5.6 s | 27.6 s | 3.2 s | 53 / 7 | ✓ pass |
| Restart Redis (clean shutdown) | docker restart of Redis (flushes its append-only file) | 0.8 s | 1.3 s | 27.6 s | 3.2 s | 60 / 0 | ✓ pass |
| Kill Redis hard (up to 1 s of writes can be lost) | kill -9 of Redis, then start it again | 0.4 s | 2.8 s | 27.6 s | 3.2 s | 60 / 0 | ✓ pass |
| A judge VM stops (frozen, then back) | the judge stops answering; later it comes back and may publish late | 8.7 s | 0 s | 49.5 s | 25.1 s | 60 / 0 | ✓ pass |
| A poison submission reaches the dead-letter queue | a job whose testset cannot be fetched (the outage ends later) | 1.3 s | 1.3 s | 26.7 s | 2.3 s | 60 / 0 | ✓ pass |

- kill-worker: killed chaos-b
- freeze-judge: stopped chaos-a
- freeze-judge: back after 0 s
<!-- /drills:local -->

<!-- drills:production -->
### production

Run 2026-10-08 18:15 UTC.

| Drill | Fault | Detected after | Healthy after | All judged after | After the last submit | Accepted / refused | Result |
|---|---|---|---|---|---|---|---|
| Kill a judge worker while it is judging | kill -9 of the worker process | no signal | 3.3 s | 52.4 s | 4.5 s | 60 / 0 | ✓ pass |
| Kill the API while submissions arrive (`docker kill`, a manual stop: superseded, see note) | docker kill of the API container | 4.1 s | 39.8 s | 43.7 s | 4 s | 23 / 37 | ✓ pass |
| Restart Redis (clean shutdown) | docker restart of Redis (flushes its append-only file) | 3.6 s | 5.1 s | 28.5 s | 4 s | 54 / 6 | ✓ pass |
| Kill Redis hard (up to 1 s of writes can be lost) | kill -9 of Redis, then start it again | 4 s | 15.7 s | 28 s | 3.5 s | 47 / 13 | ✓ pass |
| A judge VM stops (frozen, then back) | the judge stops answering; later it comes back and may publish late | 10.9 s | 1.9 s | 55.4 s | 31 s | 60 / 0 | ✓ pass |
| A poison submission reaches the dead-letter queue | a job whose testset cannot be fetched (the outage ends later) | 5.3 s | 5.6 s | 35.7 s | 11.2 s | 60 / 0 | ✓ pass |

- kill-worker: killed vm-codearena-prod-judge-0
- freeze-judge: stopped vm-codearena-prod-judge-1
- freeze-judge: back after 26.2 s
<!-- /drills:production -->
