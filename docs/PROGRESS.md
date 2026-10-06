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

## 2026-10-05 · J-01 · done
- Built: `apps/worker/internal/sandbox` (stdlib only):
  - `RunSpec` + `Validate`: SD-§8.2 defaults (extra 0.5 s, wall 3T+1 s, stack = memory, 64 open files). No field can emit `--share-net`, extra `--env`, or rw/dev binds. `--dir` only takes clean absolute paths outside `/etc /var /proc /dev /sys /run /home /root /tmp /box`.
  - `RunArgs`/`InitArgs`/`CleanupArgs`: always `--cg`, env exactly `PATH=/usr/bin:/bin`.
  - `ParseMeta`: strict, 64 KB cap, unknown keys ignored; `Meta.Signal()` gives names like SIGSEGV.
  - `ReadFile`/`WriteFileExcl`: dir opened with `O_NOFOLLOW`, then `openat(O_NOFOLLOW|O_NONBLOCK)`; reads need `fstat` regular file with nlink 1 and are capped (reports truncation). Writes use `O_CREAT|O_EXCL|O_NOFOLLOW` with an exact mode.
  - `Box` (Init/Run/Cleanup/WriteFile/ReadFile): every call goes through `taskset -c <core> isolate …`. isolate exit 2, status XX or a bad meta file → `ErrSandbox`.
  - `Pool`: one slot per core, each with compile/run/checker boxes at ids `base+3i+{0,1,2}`. On startup it cleans every id; `Release` always cleans; `Acquire` honours ctx. `doc.go` lists the safety rules.
- Tests: `go test ./...` green; gofmt and vet clean (staticcheck not installed here). Unit tests cover argv golden, defaults, forbidden flags, 23 spec rejections, meta parsing (good and malformed), the safe reader (symlink, symlinked dir, FIFO without blocking, hard link, directory, bad names, cap) and the pool (with a fake executor).
  - Integration (`JUDGE_REQUIRE_ISOLATE=1`, real isolate 2.7, boxes 900+): C sum program AC with output read back (card accept); FR-JUDGE-03 env = PATH only, no UDP or TCP, CPU TO, wall TO at 3T+1, cgroup OOM kill, SIGXFSZ on fsize, fork blocked; FR-JUDGE-04 four threads → ≥ 1.15 s CPU and parent + child summed; FR-JUDGE-13 affinity = slot core; FR-JUDGE-08 planted symlink/FIFO never followed. Ran stably 4 times with no leftover boxes. The test skips when isolate/gcc are missing (as in the CI `go` job).
  - Mutation check: dropping `O_NOFOLLOW` (read), the `S_IFREG` check, the nlink check, `O_EXCL|O_NOFOLLOW` (write) or changing the wall default to 2T+1 each made the matching test fail; all restored.
- Decisions:
  - isolate always adds `LIBC_FATAL_STDERR_=1` (a built-in rule that only sends glibc fatal messages to stderr). The env test allows exactly that and PATH.
  - isolate 2.7 deletes non-regular files (symlinks, FIFOs) from the box after each run, so our safe reader is a second layer, not the only one. Documented in `doc.go` and the test.
  - Pinning is done with `taskset` on the isolate call (SD-§8.2); 3 boxes per core (84 of `num_boxes = 1000` on 28 cores).
  - No OTel span or metric here: J-01 is a library with no endpoint or job. J-05 adds spans and metrics around judging.
  - `/etc` binds are refused for now. Java's `conf` links into `/etc/java-21-openjdk`, so J-02 may need a narrow allowlist entry.
- Next: J-02 (language registry, S). Heads-up: `languages.yaml` needs a YAML parser and none is on the approved Go list (PLAN §4.2). Options: approve `gopkg.in/yaml.v3`, or use JSON instead.
- Ayush must: decide YAML lib vs JSON for J-02. Optional: `go install honnef.co/go/tools/cmd/staticcheck@latest` so the Go lint gate runs locally.
- Model: O · Opus 5.5

## 2026-10-05 · J-02 · partial
- Built: `apps/worker/internal/languages` plus `languages.yaml` (embedded, strict parse with unknown keys rejected, gopkg.in/yaml.v3 approved by Ayush):
  - Six languages with compile and run commands, `artifacts`, process limit, memory overhead and time multiplier (c/cpp 1, java 2, node 2, python 3).
  - `Language.RunSpec(limits, …)`: T = limit × multiplier, memory + overhead, `{MEM_MB}` for Java `-Xmx`, process limit and fsize per SD-§8.3.
  - `Registry.Compile(ctx, box, lang, source)` runs the compiler inside the compile box with the compile limits (10 s CPU, 512 MB, 64 processes). It returns a `CompileResult` with a ≤ 16 KB log and CE for non-zero exit, signal, timeout or OOM; an error return only for sandbox failure or source over 64 KB.
  - Artifacts are listed and read back with the safe reader (`sandbox.ListFiles`, new), then `Install` writes them into the run box with O_EXCL; the host never follows a box path.
  - `sandbox`: `ListFiles`, and a narrow `/etc/java-<n>-openjdk` bind allowance (Java conf).
  - `scripts/setup-judge-runtimes.sh` (sudo, idempotent) installs build-essential, python3, openjdk-21-jdk-headless and nodejs and checks every tool path in the YAML. `infra/cloud-init/judge.yaml` now installs the same packages.
- Tests: `go test ./...` green (gofmt and vet clean). With `JUDGE_REQUIRE_ISOLATE=1`: hello world is AC in **c, cpp17, cpp20, python3** (compile in the compile box, install in the run box, run, output matches). Also passing: C compile error returns the compiler log; Python syntax error is CE; the compiler cannot read `/etc/passwd`; a spinning compiler is killed at the 1 s CPU limit and reported as a timeout; oversize source refused; spec and registry unit tests including 11 bad-registry rejections.
- **Not verified:** hello world in **java21** and **node**. The JDK is not installed and this machine's Node is under nvm (`~/.nvm`), which a box cannot see. Those two subtests skip until the runtimes exist; `JUDGE_REQUIRE_RUNTIMES=1` makes a skip a failure.
- Decisions:
  - isolate does `execve` with no PATH lookup, so every tool in the YAML is an absolute path under /usr (Java uses `/usr/lib/jvm/java-21-openjdk-amd64/bin`, since `/usr/bin/java` goes through `/etc/alternatives`, not visible in a box). Paths are Ubuntu 24.04 amd64; other architectures need edits.
  - SD says compile "output 1 MB". Static C++ binaries are a few MB, so the compile step's per-file limit is 64 MB; the 1 MB meaning is applied to the kept log (16 KB) only. Say if you want a strict 1 MB.
  - Registry file lives at `internal/languages/languages.yaml`, not `apps/worker/languages.yaml` (go:embed cannot read a parent directory); SD-§8.3 updated.
  - Time multipliers (java 2, node 2, python 3) are my choice, SD only says "language multiplier". Adjust after J-06 calibration.
  - apt `nodejs` on 24.04 is v18. It supports `--check` and `--stack-size`; revisit if a problem needs newer syntax.
- Next: J-03 (checkers and verdict engine, S·high).
- Ayush must: run `sudo scripts/setup-judge-runtimes.sh`, then `cd apps/worker && JUDGE_REQUIRE_ISOLATE=1 JUDGE_REQUIRE_RUNTIMES=1 go test -count=1 -v ./internal/languages/` and paste the java21 and node results. J-02 becomes done when both pass.
- Model: S · Sonnet 5.5

## 2026-10-05 · J-02 · done
- Tests: Ayush ran `sudo scripts/setup-judge-runtimes.sh` (all tool paths ok, including `/etc/java-21-openjdk`) and `JUDGE_REQUIRE_ISOLATE=1 JUDGE_REQUIRE_RUNTIMES=1 go test -count=1 -v ./internal/languages/`: hello world is AC in all six languages (java21 0.75 s, node 0.26 s), and every compile and registry test passes. Installed: openjdk 21.0.12, nodejs 18.19.1.
- Model: S · Sonnet 5.5

## 2026-10-05 · J-03 · done
- Built: `apps/worker/internal/judge`:
  - `MapRun` (SD-§8.4): TLE, then MLE (cg-oom-killed), then OLE, then RE with the signal name, XX → SE. OLE is checked before RE and also fires when output is larger than the limit. `languages.RunSpec` sets the sandbox file-size limit one KB above `OutputKB`, so "output over the limit" means the program was cut off. Python, Java and Node ignore SIGXFSZ and exit 1 on a full file, and would otherwise be RE.
  - `languages.yaml` has `oomMarkers` (Java `OutOfMemoryError`, Node heap errors): a runtime error that names one is MLE. The JVM's `-Xmx` fires before the cgroup does.
  - Checkers: `exact` (strict apart from trailing whitespace on each line and one final newline), `tokens`, `float` (`|a-b| ≤ eps·max(1,|b|)`, NaN only matches an identical token, inf must be equal), each with a position-bearing message ≤ 256 chars.
  - testlib: vendored `testlib.h` 0.9.45 + MIT licence (`internal/judge/testlib/`, sha256 bb323e3c…), embedded. `CompileChecker` builds it in the compile box via the new `Registry.CompileWith` (extra files). `RunTestlib` runs `./checker in out ans` in the checker box: 0 AC, 1/2 WA, 3 and anything abnormal (crash, kill, other exit code) → jury error; `_pc` partial credit (exit 50–150) → WA (NG2).
  - `Engine.Run`: compile → CE with log, else every test in a freshly initialised run box (no state carries between tests), safe read of `out.txt`, map, check. `StopOnFirstFailure` stops at the first non-AC; a jury error stops judging regardless and sets `Outcome.JuryError` for the alert. Sandbox failure returns an error (the worker retries, then DLQ); a failing checker is an SE verdict. Progress callback per phase and test.
- Tests: `go test ./...` green twice (judge ≈ 47 s, mostly testlib compiles and the 5 s spinning checker), gofmt and vet clean, no leftover boxes. With `JUDGE_REQUIRE_ISOLATE=1 JUDGE_REQUIRE_RUNTIMES=1`:
  - Verdict matrix: 6 languages × AC, WA, TLE, MLE, RE, OLE, CE = 42 cases, plus SIGSEGV name for a C segfault.
  - testlib: ncmp accepts and rejects, `_pe` → WA, partial → WA, `_fail` / crash / spinning checker → SE with JuryError, checker that does not compile, missing binary, jury error stops after one test.
  - Others: stopOnFirstFailure on and off, progress, unknown language, no tests, oversize source, symlinked `out.txt` → WA, a file written by one test is gone in the next.
  - Unit: 13 MapRun cases, checker status mapping, exact/tokens/float tables.
  - Mutation check: removing OOM markers broke java21 MLE; moving OLE after RE broke c, cpp17, cpp20 and python3 OLE. Both restored.
- Decisions:
  - `exact` does not ignore extra blank lines at the end (only one final newline). Say if you want it lenient.
  - Matrix limits are 500 ms, 128 MB, 64 KB output, which are loose enough for JVM start-up on a laptop; J-06/J-07 calibration should confirm them on the judge VM.
  - Java and Node MLE depend on the markers above; other managed runtimes added later need their own.
  - Testlib checkers are not cached by hash yet: J-04/J-05 own the cache; `CompileChecker` returns the bytes to cache.
  - The compile and run boxes are separate (SD-§8.1), so artifacts are copied through the host with the safe reader/writer.
- Next: J-04 (test cache + object storage, S). Heads-up: it needs MinIO (`minio-go` is approved) and a running object store for the integration test; Docker/compose state is unknown to me, I'll check before starting.
- Model: S·high · Sonnet 5.5 (`/effort high` not confirmed by Ayush)

## 2026-10-05 · J-04 · done
- Built: `apps/worker/internal/testcache` (adds `minio-go/v7`, approved; talks to the SeaweedFS S3 endpoint from compose with path-style access):
  - `Cache.Get(ctx, hash, uri)` returns a `Testset` (ordered cases, `Load(no)` through the safe reader, `Release()`). A hit never touches the store. Concurrent Gets of one hash share one download. A failed or hash-mismatched download stores nothing and is not cached.
  - Download streams to a temp file inside the cache root with a 1 GB cap and SHA-256 computed on the way. Extraction only starts if the hash equals the job's `testsetHash` (FR-JUDGE-12).
  - Archive format: a plain tar of flat `NN.in` / `NN.ans` (2–4 digits). Symlinks, hard links, directories, nested, absolute or `..` names, odd names, duplicates, orphan or missing halves, empty archives, truncated archives and one test under two names (`01`/`001`) are all rejected. Limits: 2000 tests, 128 MB per file, 1 GB total. Files are created `O_EXCL` mode 0440, directories 0550, and the finished directory is renamed into `<root>/<hash>` atomically (SD-§8.6).
  - URIs must be `s3://<configured bucket>/testsets/...`: no other bucket, scheme, `..`, query or fragment (FR-JUDGE-09, a job cannot aim the judge elsewhere).
  - LRU eviction when the cache exceeds `MaxBytes` (default 5 GB): oldest `lastUsed` first, never a testset in use or the one just fetched; rename-then-delete so a crash leaves no half-evicted directory.
  - Restart: re-indexes `<root>`, deletes the temp area and any directory that is not a valid testset, restores LRU order from directory mtimes.
  - `Stats()` (hits, misses, downloads, evictions, failures) for the J-05 metrics.
- Tests: `go test ./...` green (gofmt, vet, `-race` clean on testcache; 35 testcache cases; no leftover boxes). With `JUDGE_REQUIRE_S3=1` against the running SeaweedFS: the card's accept test (second run of the same testset: the store is opened once, counted by a wrapper around the real store) plus wrong hash and missing key.
  - Mutation check: removing hash verification, evicting in-use testsets, evicting newest first, and accepting links or any tar names were each caught; all restored.
- Decisions:
  - The dev object store is SeaweedFS (ADR), not MinIO; the card says MinIO, `minio-go` is just the S3 client.
  - The integration test defaults to the compose dev credentials (`codearena` / `codearena-dev`, in the committed compose file) with `S3_*` env overrides; it skips when `:8333` is unreachable (as in CI). It writes and removes its own fixture object under `testsets/j04-*`.
  - Worker still needs a read-only object-store key in production (D cards): `NewS3` only ever reads.
  - Checker binaries (testlib) are not yet cached by hash; the same pattern (`<root>/checkers/<hash>`) belongs in J-05 where `testsetUri` and `Checker.BinaryURI` are both resolved.
- Next: J-05 (worker loop, single lane, S·high): consume `jobs:practice`, publish `JudgeProgress` per test and `JudgeResult`, heartbeat, graceful shutdown. Needs Redis as ACL user `judge` (REDIS_URL in `apps/worker/.env`; I cannot read it) and `go-redis` v9 (approved).
- Ayush must: before J-05, make sure `apps/worker/.env` has `REDIS_URL` for the judge ACL user (Q-04 owns the ACL itself; for J-05 the default Redis user is fine locally).
- Model: S · Sonnet 5.5

## 2026-10-05 · J-05 · done
- Built: the temporary single-lane worker (`apps/worker`, deps go-redis v9 and the OTel Go SDK, both approved):
  - `internal/worker`: `Worker` creates group `judges` on `jobs:practice`, resumes its own unacknowledged entries (cursor-based, before any claiming loop starts), then `XREADGROUP` loops (`WORKER_CONCURRENCY`, one slot and core each). Each job is validated like the Zod schema (`ParseJob`: unknown fields, ranges, traceparent, checker rules), judged by an `Executor`, and committed with one transaction: `XADD results` then `XACK` and `XDEL`. Progress goes to `progress:{submissionId}` (claimed, compiling, one event per test, done); heartbeat `hb:{workerId}` JSON every 3 s with a 10 s TTL.
  - Failures: unparseable job → `jobs:dlq` and ack. Infrastructure errors retry 3 times with backoff, permanent ones (bad testset URI, hash mismatch, unknown language, unsupported job) do not; then the submission gets an SE result and the job goes to the DLQ (FR-QUEUE-04, done in-process until Q-02's reaper). A jury error is an SE verdict plus an ERROR log and `ca_judge_jury_errors_total`, no DLQ.
  - Shutdown: SIGINT/SIGTERM stop claiming; running jobs finish and publish; after `DrainTimeout` (2 min) running jobs are cancelled and left pending (no result, nothing lost); a second signal kills.
  - `Runner` (production Executor): testset via the J-04 cache, slot from the pool, testlib checker source fetched from `checkers/…` (same bucket and prefix rules as testsets), compiled once per problem version and cached (64 entries), then `judge.Engine.Run`.
  - `internal/telemetry` (OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, as in the API), a `judge.job` span parented on the job's traceparent, metrics `ca_judge_jobs_total{lane,verdict,outcome}`, `ca_judge_job_seconds`, `ca_judge_inflight`, `ca_judge_jury_errors_total`.
  - `main.go` + `config.go` (blank env values mean unset; secrets never echoed in errors); `pnpm dev` in the worker now sources `apps/worker/.env`.
- Tests: `go test -race ./...` green across the worker (gofmt, vet clean; no leftover boxes or containers):
  - Unit: 27 `ParseJob` rejections, result mapping, settings loader.
  - Protocol with a fake executor on a throwaway `redis:7` container: result on `results`, entry acked and deleted, progress events, heartbeat TTL, invalid job → DLQ, retry then success, 3 failures → SE + DLQ, permanent error not retried, jury error metric, graceful shutdown (waits, claims nothing new), drain timeout leaves the job pending and a restarted worker resumes it, concurrency 2 (each job judged exactly once), span parent and counter.
  - End to end with real isolate and Redis: c AC / WA / CE, testlib AC / WA, broken checker → SE, custom-input job → SE + DLQ; seven jobs fetched the testset once and the checker once.
  - Real binary smoke (throwaway Redis, real SeaweedFS, job via `redis-cli XADD`): AC result with per-test outcome, queue empty, heartbeat present, `kill -TERM` → exit 0. Fixtures removed.
- Bug found and fixed while testing: the first version resumed pending entries inside the first claiming loop, so with concurrency above 1 it also re-read a job a sibling loop was judging and judged it twice. Resume now runs once, before any loop starts, with a cursor so an entry that stays pending cannot loop.
- Decisions:
  - Wire format: one JSON field (`job`, `result`) per stream entry; written into SD-§7. Q-01's enqueue must use it.
  - `checker.binaryUri` is the checker's C++ **source** (compiled on each judge per SD-§8.5), under `checkers/`. The field name suggests a binary; rename to `sourceUri` in contracts if you agree (follow-up).
  - I did not write `claimed:{lane}` (SD §5.2 flow lists it, ADR-009 and SD §16.1 limit the judge's `SET` to `hb:*`). Q-05's position calculation needs a decision: allow `SET claimed:*` in the ACL, or derive it from the stream.
  - Custom-input runs (`mode: run` with `customInput`) are unsupported: `TestOutcome` has no output field. They get an SE result and a DLQ entry. Follow-up with the contracts owner (interactive lane, CP cards).
  - Consumer name = worker id; the default is the hostname, so two workers on one host need distinct `WORKER_ID`. Cross-worker reclaim is Q-02.
  - Throwaway Redis in tests is started with the docker CLI (CI runners have docker); tests skip without it unless `JUDGE_REQUIRE_REDIS=1`.
- Next: J-06 (20 practice fixture problems, S). It needs original problem statements, generators, reference and wrong solutions and a package format that matches `testsetHash`/`testsetUri` (flat `NN.in`/`NN.ans` tar, SHA-256 of the tar).
- Ayush must: add the worker variables to `apps/worker/.env`: `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (I cannot read or write `.env*`; `.env.example` already lists them); `pnpm --filter @codearena/worker dev` then starts a worker on `jobs:practice`. Decide the three follow-ups above (`sourceUri` rename, `claimed:*` ACL, custom-run output).
- Model: S·high · Sonnet 5.5 (`/effort high` not confirmed by Ayush)

## 2026-10-06 · J-05 follow-ups · done
Ayush delegated the three open decisions; each was resolved as follows.
- Built:
  - `checker.binaryUri` is now `checker.sourceUri` (Zod, regenerated JSON Schema and Go types, API schema comment, SD). A job still carrying `binaryUri` is rejected as an unknown field.
  - `JudgeResult` gains optional `output` and `stderr` (≤ 64 KB each, Zod-checked), set only for custom runs. `Engine.RunCustom` and `Runner.executeCustom` run `mode: run` + `customInput` jobs: compile, run once on the input, no checker, no testset needed. The verdict says how the run ended (AC = ran to completion), with time, memory and signal; output is cut at 64 KB and made valid UTF-8. Problem tests never return program output (asserted).
  - The shared run step is now `runProgram` (fresh box, safe reads, `MapRun`), used by both judged tests and custom runs.
- Decisions:
  - **Queue position (`claimed:{lane}`)**: no judge `SET` beyond `hb:*`. The API derives position from the stream (`XINFO GROUPS` last-delivered-id plus an `XRANGE … COUNT` between it and the job's entry id, capped, plus higher lanes), exact and with no extra ACL. Why: ADR-009's untrusted-judge model should not give a compromised host a way to falsify queue state, and concurrent workers writing one `claimed` key would race anyway. SD §5.2 flow and §7 keyspace updated; Q-05 implements it.
  - **Custom-run output**: on `JudgeResult` (not `TestOutcome`) so per-test outcomes, which are shown for hidden tests, can never carry program output.
- Tests: `go test -race ./...` green (worker end to end now expects the custom job to be AC with `output "3\n"` and the other six jobs to carry none; 8 new `RunCustom` cases: stdout+stderr, no expected answer, SIGSEGV with output before the crash, TLE, CE, OLE with partial output, 64 KB cut, invalid UTF-8). Contracts vitest 9/9 (new FR-SUB-05 cap test, old field name rejected); API typecheck clean.
- Model: S·high · Sonnet 5.5

## 2026-10-06 · J-06 · done
- Built:
  - **20 practice packages** in `problems/` (ratings 800–1700): sum-two-numbers, peak-reading, rainfall-totals, unique-badges, shelf-search, budget-windows, hall-of-fame (`exact` checker), matching-pair (testlib checker, any valid pair), maze-runner, hop-distances, network-islands, cheapest-route, stair-climb, packing-the-van, rising-subsequence, spell-fixer, room-booking, fractional-loot (`float` checker, eps 1e-6), divisor-census, needle-in-text. Topics: implementation, prefix sums, sorting, hashing, binary search, two pointers, BFS, DSU, Dijkstra, DP (counting, knapsack, LIS, edit distance), greedy, sieve, KMP. Statements are my own wording and stories on classic algorithm ideas (the rule was original text, not copied from another platform). `problems/README.md` lists them.
  - Every package: `problem.yaml`, `statement.md` (Input, Output, Notes), `editorial.md`, a testlib `validator.cpp`, a seeded `generators/gen.py`, committed tests, and 7–8 declared solutions: C++ reference, an independently written Python AC, one or two realistic WA (overflow, off-by-one, wrong greedy, ties, self-pairing…), a naive TLE, plus `re-crash`, `mle-hog`, `ole-flood`, so all six non-CE verdicts are exercised in every package.
  - `scripts/validate-problem` (Go, `cmd/validate-problem`): structure, the validator on every input, then every solution through the real `judge.Engine` in isolate boxes against its expected verdict (compile errors are shown, `-v` lists per-test outcomes, `-j` sets parallel cores, `-tar` writes the testset archive and prints its hash). `scripts/problem-build.py` regenerates tests (generator, then the reference writes the `.ans`). `internal/problempkg` is the loader (strict `problem.yaml`, itemised errors) and builds the reproducible testset tar the J-04 cache accepts. `judge.RunValidator` is new. Root scripts `pnpm problems:build` and `pnpm problems:validate`. `problems/` is ignored by prettier and eslint (it is data).
- Tests: `go test ./...` green in `apps/worker` with all `JUDGE_REQUIRE_*` set (gofmt, vet clean; no leftover boxes). `scripts/validate-problem -j 4 problems/`: **20 packages, 0 failed, 2 min 7 s** (every reference and alt AC, every wrong solution its expected verdict). New tests: 29 `problempkg` rejections (FR-PROB-01), tar reproducibility and a round trip through the testset cache (FR-PROB-03), `TestRepositoryProblems` (all 20 load and cover AC WA TLE RE MLE OLE), and `validate-problem` end to end: a good package passes, a mislabelled solution, a validator-rejected input, a wrong `.ans` and a missing statement each fail the package (FR-PROB-04).
- Things the validator caught while I wrote the set (all fixed): a shrinking `replace` that corrupted `1000000000` in several validators; a generator that wrote more edges than the validator allowed; and `wa-int32` in budget-windows passing because the answer fit in 32 bits at n = 6·10⁴ (n is now 7·10⁴).
- Decisions:
  - Size: tests are committed (SRS package format) but kept small: ~23 MB raw, ~8 MB compressed for all twenty, by using short numbers unless overflow is the point and limiting big tests.
  - Time limits are tight (250–1000 ms). I measured every TLE solution natively: all fail by at least 2.5× the limit on their slowest test (most 4–16×); six packages were tightened from 500 to 250 ms for that margin. Reference solutions run in 1–25 ms and the Python alternates at most 330 ms (limit ×3 for Python).
  - `avoidSet` lists are short keyword lists I chose; Ayush or the AI cards (AI-02) should review them. Ratings are my estimates, not calibrated on real solve rates.
  - Boxes 800+ are reserved for `validate-problem`, 850+ for its tests.
- Next: Day 2 cards done. Day 3 starts with J-07 (attack suite, O). Ayush's Day 2 tasks remain: U2.1 contest problem ideas, U2.2 try wrong solutions by hand (the packages now give you 20 × 4 to try), U2.3 explain-back on isolate.
- Ayush must: skim a few statements and editorials in `problems/` for tone and correctness; run `pnpm problems:validate` once on your machine and paste the last line.
- Model: S · Sonnet 5.5

## 2026-10-06 · U2.1 contest statements · done
- Ayush wrote the six contest statements (A easy to F hard) and delegated storing them. They are in `problems-private/<slug>/statement.md` with a private `README.md` (spoilers, intended solutions, test traps for P-02). The folder is gitignored; nothing about the problems is in this repo.
- B was given a twist (the keeper's walks grow longer: the j-th lantern costs `t_i + w·(j−1)`), which turns it from a plain sort-and-sum into prefix sums with a quadratic term and a real 64-bit trap. Ayush authorised the change.
- I checked every sample in every Notes section by hand; all are correct and the constraints are consistent (64-bit where it matters).
- Settings change, with Ayush's approval: `.claude/settings.json` denied all reads of `problems-private/**`, which also blocked writing statements. It now denies only `problems-private/**/tests/**`, so hidden test files stay unreadable to Claude while statements, generators and solutions are workable. P-02 builds the packages with scripts that generate and validate the tests rather than reading them.
- Model: S · Sonnet 5.5

## 2026-10-06 · J-07 · partial (harness only)
- Context: planning the full suite (a list of concrete exploit probes) was stopped by the safety classifier twice; the runner-only plan was not. Ayush chose to write the probe programs himself; I built the harness.
- Built:
  - `apps/worker/internal/attacksuite`: loads a case (`case.yaml` + `main.<ext>`, strict parse, itemised errors), and `Case.Match(Outcome)` decides pass/fail from the verdict, forbidden/required output strings and host-check results. Pure logic, no I/O, so it is fully unit-tested.
  - `apps/worker/cmd/attack` (`pnpm attack` → `scripts/attack`): runs each case through `judge.Engine` (RunCustom for `mode: run`, Run for `mode: submit`) on its own pool (box ids 870+, `-j` cores), then host checks outside the box: `no-leftover-procs` (no survivor runs as a box uid, read from isolate's `first_uid`), `worker-alive` (runner + parent still alive), `env-clean` (a secret canary env var never appears in output). Prints a table; exits non-zero on any failure, on inability to start isolate, or on fewer than 25 cases (FR-JUDGE-10 floor — the suite cannot pass vacuously).
  - `tests/attack-suite/`: `README.md` (case format, the BLOCKED/ESCAPED convention, how to add a case), empty `cases/`, and `selftest/` with two harmless cases (a clean one that must pass, one that prints a forbidden marker and must be reported as failing) used by the runner's own tests.
  - CI `attack` job (`.github/workflows/ci.yml`): installs isolate + runtimes, but first checks systemd + cgroup v2; if the hosted runner lacks them (or setup fails) it says so and passes, since the nightly judge-VM run (D-02) is the real home for this. When cases exist it runs the Go tests and `scripts/attack`.
- Tests: `go test ./...` green across the worker (gofmt, vet clean; no leftover boxes). attacksuite unit tests cover valid load, defaults, language-from-extension, ~13 rejections, every Match branch and LoadAll. `cmd/attack` selftest (isolate-gated): the clean case passes, the forbidden-marker case is caught as failing, the under-25 floor fails, a missing target is a usage error. Ran `scripts/attack tests/attack-suite/selftest` by hand: table correct, 1 pass + 1 (intended) fail + the min-cases line.
- Decisions:
  - Harness vs probes split: the probe catalogue is the part the classifier flagged and is Ayush's to author; the harness is content-neutral and useful now. This also matches ADR-009's intent (defensive).
  - Containment is judged by an allowed *set* of verdicts (e.g. a fork bomb may end TLE, RE or AC), not one fixed verdict; the real assertions are the ESCAPED/host checks.
  - CI job is non-blocking only when isolate is genuinely unavailable on the runner; a real case failure is always red. GitHub hosted runners may not run systemd, so D-02 must wire the nightly SSH run to the judge VM.
- Next: J-07 completes when ≥ 25 probe cases exist and pass. Then J-08 (hardening) consumes whatever they expose. (Day 3 also has Q-01 lanes next on the build side.)
- Ayush must: write probe programs under `tests/attack-suite/cases/<NN-name>/` (one `main.<ext>` + `case.yaml` each; `README.md` shows the format and the BLOCKED/ESCAPED convention). Run `pnpm attack` as you add them. The card's list (fork/memory/CPU/sleep, output floods, symlink to /etc/passwd, /proc and /sys reads, network incl. IPv6/DNS, other-box reads, env dump, ptrace, setuid, raw sockets, compile-time includes, compiler bombs, huge source, Java/Node thread blowups, zombies, signal abuse) is the checklist; send me any you want turned into a case and I'll wire the case.yaml.
- Model: O · Opus 4.8 (`/effort high` not confirmed by Ayush; the generate-probes step was declined by the safety classifier, so I did not do it — note PLAN §3.6 explain-back matters more here)
