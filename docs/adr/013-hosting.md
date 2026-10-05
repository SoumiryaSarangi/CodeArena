# ADR-013: Hosting: Vercel for web, Azure for Students VMs for API and judges, Terraform

- **Status:** Accepted (approved by Ayush, 2026-10-05)
- **Date:** 2026-10-05

## Context

The project needs a public, TLS-terminated deployment on a roughly $100 credit with no card, plus separate hosts for untrusted judging.

## Decision

The web app deploys to Vercel. REST goes through a Vercel `/api` rewrite so cookies are first-party; SSE and WebSocket connect directly to the API domain with a single-use ticket. The API, two collab instances, Redis, Postgres and object storage run on one Azure VM with Docker Compose behind Caddy, and the OpenTelemetry collector forwards to Grafana Cloud; judge workers run on separate Azure VMs (ADR-009). Everything is defined in Terraform and cloud-init; cloud resources are created by Ayush running the scripts, not by the agent. Steady state is one API VM plus one judge VM (B-series), with extra judge VMs only on contest and load-test days; budget alerts at 25, 50 and 75 percent. Image deploys are by digest with automatic rollback on a failed health check.

## Alternatives considered

- **Kubernetes:** scalable but heavy for the budget and the time (see ADR-014).
- **A single VM for everything:** cheaper, but breaks the untrusted-judge boundary.
- **Managed Postgres/Redis:** convenient, but eats the credit.

## Consequences

Cheap and reproducible. Cost: we operate Postgres backups and upgrades ourselves, and Azure for Students activation is a dependency for the deploy cards.
