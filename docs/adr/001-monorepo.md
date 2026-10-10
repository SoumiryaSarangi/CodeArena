# ADR-001: Monorepo with pnpm workspaces and Turborepo

- **Status:** Accepted (approved by Soumirya, 2026-10-05)
- **Date:** 2026-10-05

## Context

Six deployables (web, api, worker, collab, plag, contracts) share message shapes and evolve together on a two-week schedule with one developer. Cross-repo versioning of contracts would cost time we do not have.

## Decision

One repository, pnpm workspaces for the TypeScript packages, Turborepo for cached `lint`/`typecheck`/`test`/`build` tasks. The Go worker and the Python plagiarism service live in `apps/` too and are wrapped by a small `package.json` so Turborepo can run their tests. Apps never import from each other; shared types go only through `packages/contracts` (SD-§4).

## Alternatives considered

- **Polyrepo:** independent releases, but contract changes would need coordinated PRs and a publishing step.
- **Nx:** richer graph tooling, but heavier to learn, and Turborepo's caching is enough for six packages.
- **npm/yarn workspaces:** work, but pnpm's strict `node_modules` catches undeclared dependencies early.

## Consequences

One CI, one PR per change, atomic contract updates. Cost: Go and Python tasks are second-class citizens in Turborepo (no remote cache benefit), and every contributor needs Node, Go and uv installed.
