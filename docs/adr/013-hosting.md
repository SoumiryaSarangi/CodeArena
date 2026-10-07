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

## Addendum (D-01, 2026-10-07): how the Terraform is set up

- **Code:** `infra/terraform/` (azurerm ~> 4, local state, gitignored; lock file committed). Ayush runs `plan`/`apply`; offline `terraform test` (mock provider) asserts the firewall properties so a careless edit fails in CI instead of production.
- **Region and sizes:** the Azure for Students policy on this account only allows `eastasia`, `malaysiawest`, `polandcentral`, `koreacentral` and `uaenorth` (checked with `az policy assignment list`), and `az vm list-skus` shows only `eastasia` has the sizes needed; Central India (the plan's first choice) is not permitted. The old `Standard_B2s` is not offered there, so the B-series default is its successor `Standard_B2s_v2` (2 vCPU / 8 GB), approved by Ayush in spirit ("B2s now, D2s_v5 later"). B-series is burstable: sustained judging exhausts the CPU credits and the VM is throttled, which skews timings. `Standard_D2s_v5` (non-burstable) is the documented upgrade for the load test and contest day, one variable (`judge_vm_size`).
- **Judge bootstrap exception:** a judge VM needs the internet once (packages, isolate source). `judge_bootstrap = true` (first apply) attaches a temporary public IP and keeps egress open; `judge_bootstrap = false` removes the public IP and adds the catch-all egress deny. This avoids a NAT Gateway (about $32/month). Even in bootstrap mode a judge cannot reach anything else inside the VNet (the database included).
- **SSH:** key-only SSH on the API VM is open to the internet (Ayush's decision) so GitHub Actions can deploy; password login is off and fail2ban runs (cloud-init). Judge VMs are reachable only by SSH from the API VM (jump host).
- **Backups:** private Blob container. The plan was a managed identity for the API VM with `Storage Blob Data Contributor`, so uploads would need no secret; **it failed at apply** (`FailedIdentityOperation`: the university Entra tenant's directory-object quota is exhausted), and every Azure identity type needs such an object. So storage-account key access is on only to mint a **container-scoped SAS** (read/write/list, no delete, expires 2027-04-07) that D-03 puts on the VM; blob versioning and 14-day soft-delete make an overwritten or deleted backup recoverable, and the account key/token live only in Terraform state. Retention is 30 days by lifecycle policy (simpler than SD-§18.3's 7 daily + 4 weekly; D-03 can label weekly dumps inside the window).
- **Budget:** `azurerm_consumption_budget_resource_group` with alerts at 25/50/75 %; optional (`create_budget`) because Azure for Students may not offer Cost Management budgets.
- **Lock-down is two applies (found in the first real run):** removing a judge's temporary public IP in one `apply` fails, because Azure refuses to delete an IP still attached to the NIC and Terraform has no ordering edge between the NIC update and the IP deletion. `infra/terraform/lock-judges.sh` applies the NIC change first (targeted), then the rest. The egress deny rule is applied either way, so the judge has no internet from the first step.
