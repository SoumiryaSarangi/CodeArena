# ADR-005: Queue: Redis Streams with consumer groups, one stream per lane, XAUTOCLAIM leases

- **Status:** Accepted (approved by Soumirya, 2026-10-05)
- **Date:** 2026-10-05

## Context

Submissions need priority (contest over practice), at-least-once delivery, recovery when a worker dies mid-judge, and a place to park poison jobs. The system must stay explainable end to end.

## Decision

Four streams `jobs:{contest,interactive,practice,rejudge}` with consumer group `judges`. Workers pick lanes in priority order, but every 8th claim starts from the lowest non-empty lane (anti-starvation). A claimed job stays pending; the worker refreshes its lease every 2 s and a reaper uses `XAUTOCLAIM` with a 10 s idle limit. More than 3 deliveries moves a job to `jobs:dlq` and writes verdict SE; a job that crashes a worker twice goes to `jobs:quarantine`. Results go to stream `results` and are idempotent on `(submission_id, run_version)`, enforced by a database unique constraint (FR-QUEUE-06).

## Alternatives considered

- **BullMQ:** good API, but hides the lease and retry mechanics we want to demonstrate, and has no first-class Go client.
- **RabbitMQ / NATS:** solid brokers, but one more service to run on a small budget.
- **Postgres as a queue (`SKIP LOCKED`):** simple and transactional, but weaker for fan-out and pub/sub, and it puts judge hosts on the database.

## Consequences

Native from Go and Node, every primitive explainable. Cost: lease and retry logic is ours to get right, hence the chaos tests (kill-worker, restart-redis). Redis holds no source of truth (ADR-015).

## The anti-starvation ratio (Q-01, FR-QUEUE-02)

A worker probes lanes for each claim in strict priority order: contest, interactive, practice, rejudge. Every 8th claim (`FairnessEvery`, `apps/worker/internal/lanes`) probes them lowest-first, so it takes the **lowest non-empty lane**. The counter is per worker and counts claim attempts; under backlog every attempt is a claim, so the ratio is exact (7 of 8 to the top lane, 1 of 8 to the lowest non-empty one). Within a lane order is FIFO.

- **Bound:** a job in the lowest non-empty lane waits for at most 8 claims per job ahead of it in that lane, however deep the higher lanes are. Tested: with an endless contest backlog, the k-th rejudge job is judged at exactly claim 8k.
- **Why 8:** a contest keeps 87.5% of the capacity, which is what the 15 s p95 target needs on contest day, while a rejudge or practice backlog still drains instead of waiting for a quiet moment. 4 would cost contests 25% of capacity; 16 would let a low lane wait twice as long.
- **Known limit:** the guarantee covers the lowest non-empty lane only. If contest and practice are both permanently backlogged, interactive (a middle lane) is served only when no higher lane has a job. Interactive runs are short and rate-limited, and this system is not sized for two lanes backlogged at once, so the rule stays as specified; the test `documented limit` pins the behaviour so a change is deliberate.
- **Wrong-lane jobs:** priority comes from the stream a job is in, so a job whose `lane` field disagrees with its stream is dead-lettered instead of run under a misleading label.

The API side stamps each job with a per-lane counter `seq:{lane}` (INCR) and appends it in one Lua script, so counter order and stream order always agree. Queue position (Q-05) is derived from the stream itself, not from `seq`.

## Leases, takeover, DLQ and quarantine as built (Q-02)

- **Lease:** while judging, a worker checks every 2 s that it still owns the entry (`XPENDING <stream> judges <id> <id> 1`) and refreshes it with `XCLAIM … 0 <id> JUSTID` (idle reset, no delivery counted). If someone else owns it, the worker cancels judging and publishes nothing, and it checks ownership once more right before publishing.
- **Takeover (the reaper):** every worker, at most once per 2 s, scans `XPENDING <stream> judges IDLE 10000 - + 10` in the claim's lane order and takes stale entries with `XCLAIM <stream> judges <me> 10000 <id>`. The min-idle guard makes each takeover atomic (only one worker wins), and without `JUSTID` the delivery count grows.
- **Fate of a taken-over job:** if the previous owner's `hb:{id}` key is gone, its process died: `HINCRBY jobs:crashes <stream>:<id> 1`. Two crashes → `jobs:quarantine` + SE verdict (FR-QUEUE-05). Otherwise more than 3 deliveries → `jobs:dlq` reason `max-deliveries` + SE verdict (FR-QUEUE-04). Both raise `ca_queue_quarantined_total` / `ca_queue_dlq_total` and an ERROR log (the alert). Otherwise it is judged.
- **Deviations from SD-§5.3, and why:**
  - *No leader lock.* `lock:*` is outside the judge's Redis ACL (ADR-009), and the per-entry min-idle `XCLAIM` is already atomic, so every worker can safely act as reaper.
  - *`XPENDING IDLE` + `XCLAIM` instead of `XAUTOCLAIM`.* `XAUTOCLAIM` takes the entry before saying who held it, but telling a crash from a hang needs the previous owner.
  - *Lease check is two commands, not one script.* `EVAL` is outside the judge ACL too. The race (the reaper takes the entry in the instant between check and refresh, after a 10 s stall) at worst yields a duplicate result, which Q-03's idempotent upsert absorbs.
- **Proof:** `tests/chaos/kill-worker.sh` kills -9 the judging worker mid-job, 20 rounds; every round ends with exactly one result, from the surviving worker, nothing pending and nothing dead-lettered.

## The verdict consumer (Q-03, FR-QUEUE-06)

The API reads `results` as consumer group `api` (`apps/api/src/modules/submissions/results.*.ts`). One result is handled in one Postgres transaction:

- **Idempotency is the unique constraint.** `judge_runs` is unique on `(submission_id, run_version)` and the insert is `ON CONFLICT DO NOTHING`. No row back means a duplicate: nothing else is touched, nothing is published. Concurrent API instances racing on the same result are serialised by the constraint, so exactly one stores it.
- **Run versions.** A result for the submission's current version sets its summary (`verdict`, time, memory, `failed_test`, `status`). An older version is kept in `judge_runs` as history and never overwrites a newer summary. A version the submission never started is parked (SD-§16.1).
- **Acknowledge after commit.** A crash between commit and `XACK` redelivers the entry, and the duplicate check absorbs it. The one cost: a crash between commit and the realtime publish loses that event (the verdict is safe in Postgres, and a reconnecting client reads the submission). Publishing only for the call that stored the verdict is what keeps replays silent.
- **Failures.** A transient error is retried in process, then left pending for takeover (`XAUTOCLAIM`, idle > 60 s). Unusable results (bad JSON, schema violation, unknown submission or version, more than 5 deliveries) go to `results:dlq` with the reason and are acknowledged, so one poison entry cannot block the queue. `results` is trimmed to the last hour, never past an unacknowledged or undelivered entry.
- **Custom runs** reuse the same stream: a result whose id is a `custom_runs` row completes that row once, with its output and stderr.
- **Realtime.** On the first store the API appends a `submission.verdict` envelope to `evt:sub:{id}` (replay buffer, 5 min idle expiry) and publishes `{id, envelope}` on `rt:sub:{id}`, where `id` is the replay-stream id the SSE endpoint (Q-05) sends as `id:`.
- **Reconciler (Q-03b, FR-QUEUE-09):** a submission is saved before its job is queued, so a crash between the two (or a wiped Redis) can leave it `queued` forever. Every 30 s one API instance (`lock:reconciler`) finds submissions still `queued`/`judging` after 2 minutes with no verdict and checks whether their job is *live* (the stream entry remembered in `sub:entry:{id}` still exists: waiting, or claimed and unacknowledged, which Q-02's takeover owns). A lost job is queued again through the same `buildJob()` with the same run version; a job in `jobs:dlq`/`jobs:quarantine` fails the submission instead; at most 3 re-queues, one per stuck period (`recon:cool:{id}`, `recon:attempts`), then the submission fails as SE and the user is told. A double verdict is harmless (unique `(submission, run version)`). Known limit: `sub:entry` lives 1 h, so a job still genuinely waiting after an hour can be queued a second time (idempotent, just wasted work). Custom runs stuck over 10 minutes are failed so the user runs them again.
