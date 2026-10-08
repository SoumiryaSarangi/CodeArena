# Load test (O-03)

500 submissions in 2 minutes (≈ 4.2/s, SD-§2.1) with 200 browsers watching the contest board, run at 1, 3 and 6
judge VMs. The results go to [`docs/METRICS.md`](../../docs/METRICS.md) next to SD-§2.3's predictions.

| Piece                                   | What it does                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/load/load-cli.ts` | `seed` (fake users + a running `lt-*` contest + a refresh token each), `report` (what the database recorded), `cleanup` (deletes only `@loadtest.invalid` users, `lt-*` contests and their submissions). Refuses to run without `LOAD_TEST=on`.       |
| `tests/load/burst.mjs`                  | `run`: logs the users in, opens the SSE listeners, sends the burst, samples queue depth every 2 s until the queue is empty. `watch`: records when each judge worker first appears (scale-out time). Plain Node (k6 would need the xk6-sse extension). |
| `scripts/metrics-report.mjs`            | Merges one run + one report (+ scale file) into `docs/METRICS.md`; the same label replaces its block.                                                                                                                                                 |
| `tests/load/local.sh`                   | Rehearsal on this machine: real API, one real worker, small burst. Proves the pieces fit; its numbers say nothing about production.                                                                                                                   |
| `tests/load/prod.sh`                    | Runs `seed` / `report` / `cleanup` on the API VM over SSH with the deploy key.                                                                                                                                                                        |

Submissions are the reference solutions of the three contest problems (`sum-two-numbers`, `stair-climb`,
`rainfall-totals`): about 70 % AC (C++ and Python), 20 % WA, 7 % TLE, 3 % RE. There is no Java solution in the
packages yet, so Java service time is not measured.

## Rehearse locally

```bash
docker compose up -d postgres redis s3          # and problems imported once: pnpm problem:import --publish problems
SUBS=150 WINDOW=15 LISTENERS=40 USERS=40 tests/load/local.sh
```

## Run against production (one judge count)

Run it when no real contest is on: the fake contest `Load test …` appears in the public contest list while it exists.

```bash
API=https://api.40-83-75-34.sslip.io
tests/load/prod.sh seed 150 /tmp/load-seed.json            # prints the contest slug
node tests/load/burst.mjs run --api $API --seed /tmp/load-seed.json --judges 1 --out /tmp/run-1.json
tests/load/prod.sh report <slug> /tmp/report-1.json
node scripts/metrics-report.mjs --run /tmp/run-1.json --report /tmp/report-1.json --label "judges=1"
tests/load/prod.sh cleanup && rm /tmp/load-seed.json
```

One run per judge count: scale the judges (`terraform apply -var judge_count=3 …`), wait until
`/api/admin/ops/summary` shows them, then repeat with a fresh seed and `--judges 3`. A drained 1-judge run takes
about 15 minutes (`--drain-timeout` is 40 minutes). To time a scale-out, start
`node tests/load/burst.mjs watch --api $API --seed /tmp/load-seed.json --out /tmp/scale.json` just before the
`terraform apply`, press Ctrl-C when the new worker has appeared, and pass `--scale /tmp/scale.json` to
`metrics-report`. **Afterwards scale back to 1 judge** (`terraform apply -var judge_count=1 …`): a forgotten extra
D2s_v5 costs about $95 a month.

## What is measured where

- Client (`run.json`): accept latency, rejected requests, SSE connections / events / drops, queue depth over time.
- Database (`report.json`): queue wait (worker claim − submit), time to verdict, service time per language,
  verdict mix, drain time, per-worker share. The claim time comes from the journey stored with each verdict.
- The client may be far from the VM: accept latency includes the network round trip.
