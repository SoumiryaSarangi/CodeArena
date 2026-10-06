# ADR-005: Queue: Redis Streams with consumer groups, one stream per lane, XAUTOCLAIM leases

- **Status:** Accepted (approved by Ayush, 2026-10-05)
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
