# Contributing

CodeArena is a personal project and is **not taking outside pull requests right now**. Issues with a clear
reproduction, and security reports (see [SECURITY.md](SECURITY.md)), are welcome. This page is also the working
agreement for anyone who does change the code.

## Set up

Follow [Getting started in the README](README.md#getting-started): Linux or WSL2, Docker, Node.js 22+, pnpm 12,
Go 1.26, and uv for the plagiarism service.

## Before you change anything

- Read the card or requirement you are working on. The plan is [`docs/PLAN.md`](docs/PLAN.md), the requirements are in
  [`docs/SRS.md`](docs/SRS.md) (IDs like `FR-BOARD-02`), and decisions that must not change without discussion are in
  [`docs/adr/`](docs/adr/README.md).
- Find things by ID: `grep -n "FR-QUEUE-06" docs/*.md`.

## Rules for the code

- TypeScript strict; Zod validation at every boundary; errors as RFC 7807.
- The Zod schemas in `packages/contracts` are the source of truth. After changing one, run `pnpm contracts:gen`
  (CI fails on stale generated files).
- Database changes are **additive migrations** (a rollback keeps the new schema): add, never drop or rename in the
  same release. Generate them with `pnpm --filter @codearena/api db:generate`.
- Every new endpoint or job gets a trace span and a metric.
- UI: no gradients and no hard-coded colours; colours, type and spacing come from `apps/web/app/tokens.css`. Design
  rules are tests (`apps/web/tests/design-system.test.ts`).
- Never commit secrets, `.env` files or hidden tests (`problems-private/` is ignored).

## Tests

Every change comes with tests, named after the requirement they cover:
`it('FR-BOARD-02: packed score stays below 2^53', …)`. Run `pnpm check` (lint, typecheck, unit, contract freshness)
before committing, and `pnpm e2e` for anything the browser can see. How the suites fit together:
[`docs/TESTING.md`](docs/TESTING.md). If a test blocks a change, update the test and say why in the commit or PR;
never delete a test silently.

## Commits and pull requests

- Conventional commits: `feat(web): …`, `fix(api): …`, `docs: …`, `test(…): …`. Mention the requirement IDs you cover in
  the body.
- Each logical change is its own commit; the pre-commit hook (lefthook) formats and lints staged files.
- A pull request fills in the template: what and why, how to test, risks, and the requirement IDs covered.
- Do not force-push `main`.

## Reporting bugs and ideas

Use the issue templates. For a bug, include the steps, what you expected, what happened, the browser or version, and
(for the live site) the request id shown on the error.

## Conduct

Be kind. See the [code of conduct](CODE_OF_CONDUCT.md).
