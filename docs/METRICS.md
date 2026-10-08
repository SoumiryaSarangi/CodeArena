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
- **Live updates.** 194-195 of 200 listeners connected; the rest and about 3,900 retries were refused with HTTP 429: `GET /api/sse` uses the default per-IP limit of 120 requests a minute and all 200 test listeners came from one address. Contestants behind one campus address could meet the same limit (follow-up X-10 in PROGRESS). No stream dropped once connected; 42,500 to 54,500 events were delivered per run.
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
