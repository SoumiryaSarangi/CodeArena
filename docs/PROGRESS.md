# PROGRESS

## 2026-10-05 · F-01 · done
- Built: pnpm workspace + Turborepo; apps web/api/worker/collab/plag (hello-worlds); packages config/contracts; lefthook, lint-staged, eslint, prettier; `.claude/settings.json` denying `.env*`; `.env.example` per app; PR template. Docs moved to `docs/` (U0.5); CLAUDE.md Opus line set to yes.
- Tests: `pnpm check` passes in WSL (lint, typecheck, unit for all 6 packages); `go test ./...` passes in apps/worker.
- Decisions: TypeScript pinned to 6.x (typescript-eslint does not support 7.0). Tooling deps (turbo, eslint, prettier, lefthook, lint-staged, tsx, typescript-eslint) are not in PLAN §4.2 but F-01 requires them. pnpm `allowBuilds` for esbuild + lefthook.
- Next: F-03.
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-02 · done
- Built: `docker-compose.yml` (Postgres 16, Redis 7 with rendered ACL file incl. restricted `judge` user, S3 store + `codearena` bucket init, OTel collector with debug exporter); healthchecks; `scripts/dev-up.sh` (also verifies connectivity).
- Tests: `scripts/dev-up.sh` passes in WSL, all services healthy. Verified judge ACL: `SET hb:*` allowed; `SET other`, `GET`, `XADD other` denied.
- Decisions: **MinIO no longer publishes Docker images (Docker Hub and Quay both refuse pulls), so dev uses SeaweedFS 4.00 (pinned; `latest` was broken here) as an S3-compatible store — approved by Ayush. S3 clients are unchanged.** Redis ACL rendered at container start from env; dev-only default passwords; Postgres healthcheck connects over TCP to avoid the init-server race; OTel image is distroless so health is probed from the host on :13133.
- Next: Q-04 tightens and tests the ACLs. Revisit the PLAN/SD mentions of MinIO for prod (Azure Blob / other).
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · Day 0 setup · partial
- Built: nothing in code. Ayush finished U0.3 (WSL on D:, Docker, Node/pnpm, Go, uv, gh), U0.4 accounts, U0.5 repo, U0.6 OAuth apps (Google + GitHub), U0.7 dry run booked, U0.8 Opus confirmed available.
- Tests: n/a.
- Decisions: GitHub Student Pack granted. Azure for Students activation is pending; revisit before the deploy cards.
- Next: F-03 (needs `/model opusplan`).
- Ayush must: Azure activation + budget alerts (U0.2) before the deploy cards; install k6, Terraform, Azure CLI before load-test/deploy days; fix duplicate `systemd` line in /etc/wsl.conf.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-03 · done
- Built: Zod contracts in `packages/contracts/src` (enums, `JudgeJob`/`JudgeProgress`/`JudgeResult`/`TestOutcome`, `ProblemDetails` + error codes, `page()`, SSE envelope); `pnpm contracts:gen` writes JSON Schema (`packages/contracts/generated/json-schema`) and Go types (`apps/worker/internal/contracts/contracts.gen.go`); `pnpm contracts:check` fails on stale output and is part of `pnpm check`; `.github/workflows/contracts.yml` runs it plus `go test` in CI.
- Tests: `pnpm check` green (judge.test.ts, gen.test.ts freshness); `go test ./...` green incl. fixture round-trip against the same JSON fixtures. Acceptance verified: adding a Zod field without regenerating makes `contracts:check` fail.
- Decisions: Zod 4 `z.toJSONSchema` (no extra dep); `quicktype-core` 26.0.0 pinned (not in PLAN §4.2 — needed by the card). Timestamps are epoch ms integers. Checker is a flat object with refinements (float needs eps, testlib needs binaryUri). Registry-wide bundle under one wrapper root so quicktype shares types; wrapper struct and quicktype's inconsistent constant casing are post-processed (`VerdictAC`, `LaneContest`, …). Generated files are committed.
- Next: F-04.
- Ayush must: nothing.
- Model: P · planned on Opus (`/model opus`, not `opusplan`); build ran on Sonnet 5.5 after a mid-session model change — opusplan itself untested.

## 2026-10-05 · F-04 · done
- Built: Drizzle schema for all 37 §6.2 tables in `apps/api/src/db/schema/*` (enums reuse `Verdict`/`Lane` from contracts); `drizzle/0000_init.sql` (starts with `CREATE EXTENSION citext`); `uuidv7()` helper (no extra dep); `db:migrate`, `db:seed`, `db:reset` (root `pnpm db:reset`); idempotent seed (admin user + 3 public sample problems with versions and tags).
- Tests: `pnpm check` green. `schema.test.ts` creates a throwaway database on the compose Postgres: migrations from empty (37 tables), seed idempotent, `(submission_id, run_version)` unique (FR-QUEUE-06). `uuid.test.ts` covers v7 format and ordering.
- Decisions: `drizzle-orm`, `drizzle-kit`, `pg`, `@types/pg` (approved list + types). Dev DB URL defaults to the compose one; `DATABASE_URL` overrides. `db reset` refuses non-local hosts. `problems.current_version_id` has no FK (circular). Enum values not given in SD were chosen: `user_role`, `problem_visibility`, `run_reason`, `decision_kind`, `signal_kind`, `room_event_kind`, `room_role`, `run_status` — revisit if a later card needs different ones.
- Follow-up (F-08): `schema.test.ts` is skipped when Postgres is unreachable; F-08 must provide a Postgres service/Testcontainers in CI so it always runs.
- Next: F-05.
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · J-00 · partial
- Built: `scripts/setup-isolate-wsl.sh` (checks cgroup v2 + systemd PID 1, installs build deps, builds isolate v2.7 from source with the tag's commit SHA verified, `make install` to /usr/local, enables `isolate.service`, runs `isolate-check-environment`, smoke-tests `/bin/echo` in box 99 with `--cg`). Idempotent: skips the build when v2.7 is installed. `infra/cloud-init/judge.yaml` does the same for the judge VM.
- Tests: `bash -n` and a YAML parse only. The script needs root, so it has NOT been run; build deps (pkg-config, libcap-dev, libsystemd-dev) are not installed on this machine yet.
- Decisions: isolate is not packaged for Ubuntu 24.04, so it is built from source, pinned to v2.7. Docs (`make install-doc`) are skipped to avoid asciidoc.
- Next: Ayush runs it (U1.4); J-00 becomes done once the smoke test passes.
- Ayush must: `sudo scripts/setup-isolate-wsl.sh`, then paste the `isolate --version` and smoke-test output.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-05 · done
- Built: NestJS skeleton under `apps/api/src`: nine empty feature modules (auth, users, problems, submissions, contests, realtime, admin, ai, rooms) plus health; Zod-validated config (`config/config.ts`, production refuses dev defaults); RFC 7807 `ProblemFilter` + `ProblemError` for the whole SRS §3.1.8 catalogue; request IDs (`X-Request-Id`, also the `instance` of errors); pino JSON logs with request/trace IDs; OTel bootstrap (OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set), an `http <method> <path>` span and `ca_http_request_seconds` per request, `ca_rate_limited_total`; Redis token-bucket guard (`rl:{scope}:{id}`, Lua, Redis TIME, `@RateLimit({scope, perMinute})` or `false`); `GET /api/health/live`, `/api/health/ready` and `/api/health` (DB, Redis, S3); Swagger at `/docs` only in development; `X-Powered-By` off; JSON body limit 1.5 MB.
- Tests: `pnpm check` green. `app.test.ts` covers config, problem+json shape, request IDs, Zod 400, no leak on 500, 400/413 body errors, `/docs` hidden in test, `/health` against the compose stack, and the token bucket 429 + Retry-After (NFR-SEC-06). Stack tests skip if Redis is unreachable (same F-08 follow-up as the DB test). Manually verified `tsx src/main.ts`: `/api/health` all ok, `/docs` 200, 404 is problem+json.
- Decisions: added `express`, `@nestjs/swagger`, `@nestjs/testing`, `supertest`, `ioredis`, `pino`, `zod`, `@opentelemetry/*`, `@aws-sdk/client-s3` (all on the approved list or implied by `@nestjs/*`). tsx/vitest do not emit decorator metadata, so DI uses explicit `@Inject(token)` everywhere — keep doing that. The rate limiter fails open if Redis is down (logged); `/health/ready` reports Redis. Default limit 120/min per user-or-IP; specific limits (6/min submit etc.) come with their endpoints. `createApp(config, extraModules)` is the test seam for throwaway routes.
- Next: F-06 needs `/model opus` and `/effort high` (tag O).
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-09 · partial
- Built: `docs/adr/001…015` (context, decision, alternatives, consequences) plus `docs/adr/README.md` index. ADR-004 records the pinned source build of isolate; ADR-008 records the real contracts pipeline (Zod 4 JSON Schema, quicktype-core, committed output, epoch-ms timestamps); ADR-003 records the explicit `@Inject` rule.
- Tests: n/a (docs).
- Decisions: status is "Accepted (pending Ayush's review, U1.2)"; edit the status line when approved.
- Next: Ayush reviews (U1.2). F-09 becomes done on approval.
- Ayush must: review the ADRs and reply "approved" or raise concerns.
- Model: S · Sonnet 5.5
