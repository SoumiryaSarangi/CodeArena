# Testing

How the suites fit together, what each proves, and how to run it. Rules: every change comes with tests, named after
the requirement they cover (`it('FR-BOARD-02: …')`); a test that blocks a change is updated with the reason, never
deleted silently.

## The suites

| Suite | Where | Needs | Run | Size (October 2026) |
| --- | --- | --- | --- | --- |
| API unit and integration | `apps/api/src/**/*.test.ts` | Compose Postgres and Redis (each file makes its own database) | `pnpm --filter @codearena/api test` | about 520 tests, 50 files |
| Web unit | `apps/web/tests/` | nothing | `pnpm --filter @codearena/web test` | about 200 tests |
| Collab | `apps/collab` | Postgres, Redis | `pnpm --filter @codearena/collab test` | about 86 tests |
| Contracts | `packages/contracts` | nothing | `pnpm --filter @codearena/contracts test` | 12 tests |
| Browser (Playwright) | `apps/web/e2e/` | nothing for most (a stubbed API); some start real collab servers | `pnpm e2e` | 472 tests in 34 files |
| Go worker | `apps/worker` | isolate and cgroup v2 for the sandbox tests | `go test ./...` | about 86 test functions |
| Plagiarism | `apps/plag` | uv | `uv run pytest` | about 100 tests |
| Infra scripts | `infra/prod/tests/*.test.sh`, Terraform tests | nothing | run by CI | 14 script suites, `terraform test` |
| Sandbox attack suite | `tests/attack-suite` | a judge VM (cgroup v2, isolate) | `pnpm attack`; nightly in CI | 28 attack programs |
| Failure drills | `tests/chaos` | the stack | `pnpm chaos:local`; production per [runbook](runbooks/failure-drills.md) | 6 drills |
| Load and capacity | `tests/load` | the stack | `pnpm load:local`; production per [runbook](runbooks/contest-day.md) | burst and pad runs |
| Quality evals | `apps/api/eval/hints`, `apps/plag/eval` | provider keys / the model | `pnpm eval:hints`; `python -m plag.evalset` | 66 hint items; 3,476 labelled pairs |

## What is checked beyond behaviour

- **Accessibility:** the browser tests run axe (WCAG 2.2 AA) on the screens at 1280 and 390 px in both themes, and check
  for horizontal scroll.
- **Design rules as tests:** no hard-coded colours or gradients outside `apps/web/app/tokens.css`; contrast ratios of
  every text and status colour in both themes; the design tables in [UI/UX](UI_UX.md) must match the code
  (`pnpm ui-ux:sync --check`).
- **Contracts freshness:** `pnpm contracts:check` fails when generated JSON Schema or Go types are stale.
- **Security:** CodeQL and Dependabot in CI; the nightly attack suite; a test sweeps every route to prove interviewer
  notes are readable by that interviewer only.
- **Mutation checks:** for several cards a deliberately broken variant was run to prove the test fails
  (recorded in [PROGRESS](PROGRESS.md)).

## The gate

| When | What runs |
| --- | --- |
| Pre-commit (lefthook) | Prettier and ESLint on staged files |
| Every push (CI) | lint, typecheck, unit suites, contract freshness, infra tests, Terraform checks, Compose and Caddy structure tests, browser tests |
| Nightly | the sandbox attack suite against a real judge VM |
| After a green CI on `main` | the deploy workflow, with a health check and automatic rollback |

Locally, `pnpm check` runs lint, typecheck, unit tests and the contract check; `pnpm e2e` runs the browser suite.
Running every API test file in parallel can exceed Postgres' 100 connections: if you see odd connection errors, run
`pnpm --filter @codearena/api exec vitest run --maxWorkers=6`.

## Known flaky tests

A replay timing test (`replay.spec.ts`, "4× covers four times as much") and one collab test have failed once each
under load and passed on rerun. They are listed in the [roadmap](ROADMAP.md).

## Writing a test

Name it after the requirement, put a real-Postgres test next to the module it covers, stub the API in browser tests
(`apps/web/e2e/stub-api.ts`), and for UI changes run the accessibility check and look at the screen in both themes.
