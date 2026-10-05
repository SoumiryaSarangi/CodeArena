# ADR-015: PostgreSQL is the source of truth; Redis is always rebuildable

- **Status:** Accepted (approved by Ayush, 2026-10-05)
- **Date:** 2026-10-05

## Context

Redis is fast but treated as volatile. Losing it must never lose a submission, a verdict or a score.

## Decision

Submissions, verdicts, judge runs, contests, ratings and room documents are written to Postgres. Redis holds queues, caches, rate-limit buckets, replay buffers, tickets and leaderboards that can be rebuilt: boards are recomputed from `submissions`, the queue from submissions still in `queued` or `judging`, and SSE replay falls back to a full snapshot. Results are applied idempotently (ADR-005). Chaos drills (restart-redis, kill-worker) prove recovery.

## Alternatives considered

- **Redis as primary for hot data:** faster, but durability and recovery become our problem.
- **Event sourcing everywhere:** powerful, but far more machinery than needed.

## Consequences

Simple recovery story and safe cache flushes. Cost: some paths (board rebuild after a flush) are slower than reading Redis directly, which is acceptable because it is rare.
