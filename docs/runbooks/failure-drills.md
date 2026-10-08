# Runbook: failure drills and what to do when something breaks

Built in O-06. The drills kill things on purpose in a contest of fake users and check that nothing is lost:
every accepted submission ends with **exactly one verdict**, nothing is stuck, and **the board equals a rebuild
from Postgres** (NFR-REL-01, FR-QUEUE-06/07, FR-BOARD-03). The measured times are in `docs/METRICS.md`
("Failure drills"); this page says how to run them and what an operator does in the real thing.

## Run the drills

```bash
pnpm chaos:local                          # all six, on this machine (about 12 minutes)
node tests/chaos/drill.mjs local poison   # one of them
node tests/chaos/drill.mjs local --out /tmp/drills.json && node scripts/metrics-report.mjs --drills /tmp/drills.json
```

The local run starts a real API from source, two real isolate workers, a throwaway Redis (append-only, like
production) and a throwaway database; the dev database and Redis are not touched. It needs Docker, `isolate`
(`scripts/setup-isolate-wsl.sh`), Go and Node.

Production (only when no real contest is on; the driver refuses otherwise, and only fake `lt-*` data is used):

```bash
scripts/scale-judges.sh up 1              # 2 judges (about $0.12/h while it runs)
tests/chaos/prod.sh --yes --out /tmp/drills-prod.json
scripts/scale-judges.sh to 1
```

A drill that cannot fail is not a drill: to check one, break the thing it protects (for example put back the
old DLQ re-queue) and run it; it must report FAIL. `tests/chaos/kill-worker.sh` (Q-02) stays as the 20-round
proof of FR-QUEUE-07.

## Is everything still exactly once? (any time, read-only)

```bash
tests/load/prod.sh verify <contest-slug>
```

It prints `ok` and a list of problems: submissions without a verdict, a verdict stored twice, a job that published
two results, a parked result (`results:dlq`), a job still claimed by a judge. Run it after any incident on a real
contest. It never changes anything.

## What an operator sees and does

| What happened | What you see | What to do | Measured |
|---|---|---|---|
| **A judge worker dies** (crash, OOM) | The judge disappears from the ops console workers table after about 10 s (its heartbeat expires); lane depth may rise briefly | Nothing is lost: another judge takes its job over 10 s after the last lease refresh. systemd restarts the worker in 3 s. Check `journalctl -u codearena-worker` on the judge if it keeps dying | Production: invisible (restarted in 3 s), last verdict 4.5 s after the last submit. Local without a restart: gone from the console after 9 s |
| **A judge VM stops** (host problem, deallocated) | Same as above, but it does not come back | The other judge reclaims its jobs; if it was the only judge, submissions wait: start the VM (Azure portal or `az vm start`), or `scripts/scale-judges.sh up 1`. A judge that returns late publishes nothing stale (it checks that it still owns the job) | Production (VM deallocated): gone from the console after 11 s, the other judge finished everything, VM back and reporting 26 s after `az vm start` |
| **The API process dies** | `/api/health/ready` fails; contestants get "could not send" while it is down | Docker restarts it (`unless-stopped`); the ops console judges table shows "restarted N× (last … ago)" for a worker that restarted. Accepted submissions are safe (they are in Postgres and the queue); verdicts of jobs the dead API had read are taken over after 60 s idle. If it does not come back in a minute: `ssh` to the API VM, `docker compose ps`, `docker compose logs --tail 100 api`, `docker compose up -d api` | Production: **about 4 s** after a real crash (measured by killing the node process; `docker kill` is a manual stop and is NOT restarted, so after a manual `docker kill` or `docker stop` run `docker compose up -d api`); local 5.6 s |
| **Redis restarts** | `/api/health/ready` fails for a few seconds; the live board and verdict streams may pause | Append-only persistence keeps queues and results; the API and judges reconnect by themselves; the live stream continues. A hard kill can lose up to 1 s of writes: the reconciler re-enqueues a submission that was accepted but lost its job after 2 minutes. To be sure the board is right press **Rebuild board** in the ops console, then announce "board refreshed" | Production: clean restart about 5 s (6 of 60 submissions refused with an error), hard kill about 16 s (13 refused); nothing accepted was lost |
| **A poison job reaches the dead-letter queue** | The ops console shows a dead letter (red tile); the submission shows SE | Read the reason: `execution-failed` means the environment failed (object store, disk, testset), not the contestant's code. Fix the cause, then **Re-queue**: the submission gets a **new run version** and judges again (before O-06 the retry's result was thrown away as a duplicate and the contestant stayed on SE). `invalid-job` entries cannot be re-queued. If the same entry comes back, rejudge it after the contest | Production: dead letter visible after 5 s; Re-queue after the outage ended in AC at run 2 |

## Limits of these drills

- Local numbers come from a laptop with two workers of concurrency 1; production has its own timings (systemd,
  Docker, the network), which is why the production run exists.
- The drills use light problems (about half a second a submission); a heavy queue takes longer to clear.
- A judge VM stop is a freeze (SIGSTOP) locally and a real deallocation (`az vm deallocate`) on production.
- They do not cover: the whole API VM dying (see `docs/runbooks/backup-restore.md`), a full disk, a bad deploy
  (`docs/runbooks/deploy.md`), or two faults at once.
