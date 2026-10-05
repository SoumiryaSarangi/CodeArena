# ADR-014: Upgrade paths documented but not built

- **Status:** Accepted (pending Ayush's review, U1.2)
- **Date:** 2026-10-05

## Context

Some scale and isolation improvements are valuable to discuss but out of scope for the build window.

## Decision

We document, and do not build, these steps (SD-§19): more judge VMs, then Kubernetes with KEDA scaling on stream length; gVisor (`runsc`) around the worker for stronger isolation; stateless API instances behind Caddy (SSE fan-out already goes through Redis); a Postgres read replica and monthly partitioning of `submissions`; y-redis for very large collaboration scale (noting its AGPL licence); a paid or self-hosted model for AI sufficiency and removal steps.

## Alternatives considered

- **Build them now:** adds risk and time with no user-visible benefit at the expected load.
- **Do not record them:** loses the reasoning that makes the current design defensible.

## Consequences

The current architecture can be defended as a deliberate stopping point with a clear next move for each pressure.
