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
