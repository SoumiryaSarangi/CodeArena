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

## 2026-10-05 · F-08 · done
- Built: `.github/workflows/ci.yml` (jobs `node`: install, lint, typecheck, unit + integration against the Compose dev stack via `scripts/dev-up.sh`, contracts freshness; `go`: gofmt, vet, test; `python`: ruff, mypy, pytest), `codeql.yml` (JS/TS, Python, Go; weekly + on push/PR), `dependabot.yml` (npm, gomod, uv, actions, docker-compose). Replaces the interim `contracts.yml`. DB and API stack tests now fail (not skip) when `CI` is set and the stack is down, which closes the F-04/F-05 follow-up.
- Tests: first run failed on two real issues (pnpm `ERR_PNPM_IGNORED_BUILDS` for `@scarf/scarf` and `protobufjs`, now `allowBuilds: false` in `pnpm-workspace.yaml`; CodeQL Go does not support `build-mode: none`, now `autobuild`). Re-run on fbe32e7: `ci` and `codeql` both green in ~80 s (limit 10 min).
- Decisions: integration tests use the Compose stack instead of Testcontainers (same services as dev, one source of truth; Testcontainers stays approved for tests that need throwaway containers). Node 24 in CI to mirror dev.
- Next: F-07, then F-06 (O).
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-07 · partial
- Built: `apps/web` design system and shell. `app/tokens.css` (UI_UX §5.1 verbatim, dark default + light), Tailwind v4 with the default palette removed (`--color-*: initial`) so only token colours exist, Geist Sans/Mono, theme toggle with pre-paint init script (OS preference, localStorage in try/catch), components `Button`/`IconButton`/`Input`/`Kbd`/`Tabs`/`Tooltip`/`Dialog`+drawer (Radix), `Skeleton`/`EmptyState`/`ErrorState`, `VerdictBadge`, `VerdictGrid`, `Timer`, `DataTable` (sortable, `aria-sort`, ↑↓/Enter), `CommandPalette` (cmdk, ⌘K), `ShortcutSheet` (`?`), global `g`+key navigation, shell (top bar, rail → icons at md / labels at xl / bottom bar under md, skip link, same footer links everywhere), `/dev/ui` kitchen sink (404 in production). `next.config.ts` transpiles `@codearena/contracts`.
- Tests: `pnpm check` green (21 web tests). No-hard-coded-colour check runs as a vitest test (hex, rgb/hsl/oklch, gradients, default palette classes; verified it fails on a planted violation). Contrast of every text, verdict, control-border, focus and accent-button pair is computed from tokens.css in both themes: all spec ratios hold. SSR render tests cover verdict labels, grid roles/live region, timer tones, loading button, error/empty states. `next build` passes.
- NOT verified: the pages have never been rendered in a browser. Playwright's Chromium cannot start here (missing libnss3/libnspr4/libasound2; installing them needs sudo), so no screenshots, no axe run, no 1280/390 visual check, and no manual keyboard pass. Dev server returned 200 for `/dev/ui`.
- Decisions: Radix packages individually (dialog, tabs, tooltip, slot, dropdown-menu) plus cva/clsx/tailwind-merge (shadcn's standard helpers); components are hand-written, restyled shadcn-style, not generated by the CLI. `next-env.d.ts` is committed (TS 6 checks side-effect CSS imports). Rail links point at routes that do not exist yet (404) until their cards land; Admin entry waits for roles (F-06); the system dot is static until `sys:status` SSE exists. DataTable virtualisation (> 200 rows) deferred to the first screen that needs it. Verdict-grid tooltips use `title`/`aria-label`, not a Radix tooltip per square.
- Next: F-06 (O). Follow-up card: browser verification of F-07 (screenshots at 1280 and 390 in both themes, axe 0 serious/critical, keyboard pass) once Chromium deps are installed.
- Ayush must: `sudo npx playwright install-deps chromium` (or `sudo apt-get install -y libnss3 libnspr4 libasound2t64`) so I can run the browser checks; then say so and I will do the F-07 visual/axe pass. Optionally open `pnpm dev` and visit `/dev/ui` yourself in both themes.
- Model: S · Sonnet 5.5

## 2026-10-05 · J-00 · done
- Built: fixes found by Ayush's real runs (U1.4): isolate 2.7 also needs `libseccomp-dev`; its default `subid_user = isolate` needs a system user with `/etc/subuid` entries, so the script (and `infra/cloud-init/judge.yaml`) now sets a fixed range (`first_uid/first_gid = 60000`, `num_boxes = 1000`) and restarts the service on every run.
- Tests: Ayush ran `sudo scripts/setup-isolate-wsl.sh` three times (idempotent). Final run: `isolate --version` = 2.7, `isolate.service` active, all cgroup feature checks PASS, smoke test PASSED (`/bin/echo` in box 99, `exitcode:0`, `cg-mem:332`).
- Decisions: `isolate-check-environment` reports timing-variability warnings on this WSL2 host (SMT on, swap on, ASLR on, transparent hugepages on, core files piped). They are expected on a dev laptop and do not affect correctness; they matter for timing fairness. The judge VM (D-02/J cards) should turn them off (`echo never > /sys/kernel/mm/transparent_hugepage/enabled`, `randomize_va_space=0`, `core_pattern=core`, SMT off where the VM allows) and J-06/J-07 calibration should record the variance.
- Next: J-01 (Day 2).
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-09 · done
- Built: nothing new. Ayush approved ADR-001…015 (U1.2); status lines updated to "Accepted (approved by Ayush, 2026-10-05)".
- Next: F-06.
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-07 · done
- Built: browser verification of the F-07 design system (Ayush installed the Chromium libraries). `apps/web/e2e/ui.spec.ts` + `playwright.config.ts` (`pnpm e2e`, new CI job `e2e`): `/dev/ui` at 1280 and 390 px in dark and light (OS colour scheme, reduced motion on): theme applied before paint, no horizontal overflow (WCAG 1.4.10), axe wcag2a/2aa/21aa/22aa with 0 serious/critical; theme toggle persists across reload; Ctrl+K opens/filters/closes the palette; `?` opens the shortcut sheet but not while typing; DataTable ↑/↓ row focus. I also viewed the screenshots (1280 dark, 390 light): layout, rail → bottom bar, wrapping and both themes look as intended.
- Bugs the browser found (all fixed, with unit tests): (1) `tailwind-merge` read the custom `text-14` size classes as colours and dropped `text-accent-fg`/`text-bg`, so primary and danger buttons had light text on light fills (2.3–2.6:1); `lib/cn.ts` now declares the type scale. (2) The loading button's label was `invisible`, leaving it without an accessible name; now `opacity-0` + spinner. (3) The kitchen-sink timers row overflowed 74 px at 390 px; it wraps now. (4) vitest was picking up the Playwright spec; `e2e/` excluded.
- Spec change (UI_UX §5.1 updated): the 14% verdict-badge tint cannot meet 4.5:1 in the light theme (verdict colours are ~4.6:1 on `--bg`, so any tint drops them below 4.5:1; measured by axe at 3.7–4.3:1). Dark keeps the 14% tint; light badges have no tint and use a 1 px inset ring in the verdict colour at 40% (`light:` Tailwind variant). The `judging…` pulse still dips below 4.5:1 mid-animation (axe measured 4.2:1 while it ran); acceptable for a transient state and removed under reduced motion, where the check passes.
- Not covered: manual keyboard pass of every component and an NVDA check (UI_UX §11 schedules NVDA for S05/S10 before Day 10); toast and drawer/dialog focus-return are Radix behaviour and only the palette's Esc path is asserted.
- Tests: `pnpm check` green (23 web tests); `pnpm e2e` 8/8.
- Next: F-06 (O).
- Ayush must: nothing.
- Model: S · Sonnet 5.5

## 2026-10-05 · F-06 · done
- Built:
  - Google (OIDC; id_token checked against JWKS, iss/aud/nonce/email_verified) and GitHub (PKCE, `/user` + primary verified email) OAuth with fetch + jose. State/verifier/nonce/returnTo live in a 10-min `ca_oauth` cookie; safe `returnTo`; every failure → `WEB_URL/signin?error=oauth-failed`.
  - ES256 access JWT (15 min, `sub/role/sid`, `typ at+jwt`, ES256-only verify).
  - Refresh tokens: SHA-256 stored, 30-day sliding. Rotation under `SELECT … FOR UPDATE`; reuse after 5 s revokes the family (`token-reused`); reuse within 5 s is a tab race (401, nothing revoked, cookie kept).
  - Cookies: `ca_rt` (httpOnly, Secure, Lax, `/api/auth`) and `ca_csrf` double-submit for all POST/PUT/PATCH/DELETE (guests get the cookie too).
  - Default-deny guards (Auth → CSRF → Roles → RequireHandle → RateLimit) with `@Public`, `@Roles` (admin ⊇ setter ⊇ user), `@RequireHandle`, `@SkipCsrf`.
  - Endpoints: `/api/auth/{google,github}`, `/callback/*`, `/refresh`, `/logout`, `/logout-all`; `GET/PATCH /api/me`; `GET /api/handles/:h/available`; `POST /api/realtime/ticket` (256-bit, `SET tkt:* EX 60 NX`, `redeem()` with GETDEL plus requested ⊆ granted, SD-§10 topic policy, 30/min).
  - Contracts `auth.ts` (Role, Me, PatchMe, HANDLE_RE, RESERVED_HANDLES, AccessToken, Topic, Ticket*).
  - Migration `0001` (`setter` role, nullable handle). Drizzle `DB` provider. `ca_auth_events_total{event}`.
  - `scripts/gen-keys.sh`. API `dev` now loads `apps/api/.env` (`--env-file-if-exists`).
- Tests: `pnpm check` green (api 46, incl. 29 in `auth.test.ts`), using an in-process fake Google/GitHub that enforces PKCE. Coverage:
  - FR-AUTH-01: login, state, missing cookie, wrong verifier, unverified email, returning user, cross-provider link.
  - FR-AUTH-02/03: handle onboarding and rules. FR-AUTH-04: ES256, 900 s, hashes only; `none`/HS256/tampered/expired rejected.
  - FR-AUTH-05: rotation, reuse revokes family, tab race, concurrent refresh, expiry. FR-AUTH-06: cookie flags. FR-AUTH-07: CSRF. FR-AUTH-08: logout and logout-all. FR-AUTH-09: roles.
  - FR-AUTH-11: entropy, TTL, single use, scope, topic policy, 30/min. Production refuses endpoint overrides or missing keys.
  - Mutation check: I broke family revocation, CSRF comparison, the grace window and the role check one at a time; each was caught by exactly its test, then restored.
  - Gen-keys output loads and verifies through `loadConfig`. Live smoke on `tsx src/main.ts`: problem+json 401s, guest ticket, OAuth without client IDs → signin error.
- Decisions:
  - Account linking by verified email.
  - 5 s refresh race window.
  - Logout works with only the cookie; access tokens stay valid ≤ 15 min after logout (accepted).
  - Clients must not send `Authorization` to `/auth/refresh` or `/auth/logout` (an invalid bearer is always 401).
  - API test hook timeout raised to 60 s: create + migrate a test DB takes 6–12 s on WSL2. The auth suite sets a high default rate limit because the shared per-IP bucket in Redis made back-to-back runs fail.
- Follow-ups: `DELETE /api/me` + anonymisation job (FR-AUTH-10, P1). Web auth client (memory access token, silent refresh, CSRF header, single-flight refresh across tabs) belongs to the web/UI cards.
- Next: Day 2 (J-01, O).
- Ayush must:
  - (U1.1) Run `scripts/gen-keys.sh` and paste both lines into `apps/api/.env`. My permissions block `.env*` files, so also add these names, without values, to `apps/api/.env.example`: `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `WEB_URL`, `PUBLIC_API_URL`, `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`.
  - ~~Register callbacks on :4000~~ superseded, see the dev-rewrite entry below.
  - Run `pnpm --filter @codearena/api db:migrate` (or `pnpm db:reset`) on your dev DB; I already migrated it here.
- Model: O · Opus 5.5 (plan and build; `/effort high` not confirmed by Ayush)
- CI note (F-06, 6287488): `node`, `python`, CodeQL JS/TS and CodeQL Go passed on GitHub. The `go`, `e2e` and CodeQL Python jobs were cancelled twice with "The job was not acquired by Runner of type hosted even after multiple attempts" (GitHub runner capacity or Actions allowance, not a test failure). I ran them locally on the same commit: gofmt/vet/`go test` ok, pytest ok, `pnpm e2e` 8/8. Ayush: check Settings → Billing → Actions usage for the repo, and re-run the workflow when runners are available.

## 2026-10-05 · F-06 follow-up · done
- Built: `apps/web/next.config.ts` rewrites `/api/*` to the API (`API_PROXY_URL`, default `http://localhost:4000`), mirroring the production Vercel rewrite (SD-§5.1, PLAN §5.3), so the browser and OAuth callbacks use the web origin.
- Tests: with the API and `next dev` running, `localhost:3000/api/health/live` → API; `localhost:3000/api/auth/github` → 302 to GitHub with `redirect_uri=http://localhost:3000/api/auth/callback/github` and the `ca_csrf`/`ca_oauth` cookies passed through; callback without flow cookie → `/signin?error=oauth-failed`. Web typecheck and tests green.
- Decisions: dev callbacks are on :3000 (matching what Ayush registered on Day 0). The API sees every request from the Next proxy's IP, so per-IP rate limits are effectively global in dev; the deploy card must set Express `trust proxy` for Caddy/Vercel so `req.ip` is the client.
- Ayush must: in `apps/api/.env` set `PUBLIC_API_URL=http://localhost:3000` (leave `JWT_ISSUER` and `WEB_URL` unset; defaults are right). OAuth callbacks: GitHub `http://localhost:3000/api/auth/callback/github` (already registered), Google `http://localhost:3000/api/auth/callback/google`. Production needs a second GitHub OAuth app (one callback per app).
- Model: O · Opus 5.5

## 2026-10-05 · F-06 live check · done
- Tests: Ayush signed in with real GitHub OAuth on `localhost:3000/api/auth/github` → landed on `/onboarding` (first login, no handle yet). Confirms PKCE, state cookie, token exchange, `/user/emails`, user creation and refresh cookie against the real provider through the dev `/api` rewrite.
- Fixes made while getting there: Redis errors are handled (one warning per 30 s instead of an unhandled-error flood); blank `KEY=` values in `.env` now mean "use the default" instead of failing boot.
- Still to try: Google login (callback `http://localhost:3000/api/auth/callback/google`).
- Model: O · Opus 5.5
