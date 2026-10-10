# Changelog

All notable changes to CodeArena, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/);
this project has not cut tagged releases, so entries are grouped by the day they were deployed. Every entry is a
card ID (for example `UI-16`) that you can find in [`docs/PLAN.md`](docs/PLAN.md), with the full story of what was
built, tested and decided in [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Unreleased

### Added

- A notice bar when the servers are paused or unreachable, with a live-demo request by e-mail (UI-23).
- The owner appoints **setters** (problem authors) from the Admins page (UI-24, migration 0015).
- `scripts/teardown-export.sh` and the [revive runbook](docs/runbooks/revive.md): save everything into one encrypted
  archive, delete the Azure resources, rebuild later. [Hibernate runbook](docs/runbooks/hibernate.md) (W-04, W-05).
- Project documents: LICENSE (MIT), SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, this changelog, product overview,
  architecture overview, roadmap, testing guide, docs index, issue templates, CODEOWNERS.

### Fixed

- The database pool now listens for idle-connection errors, so a Postgres restart no longer risks crashing the API.

## 2026-10-10: design round 2, owner tools, polish

### Added

- **Design round 2** (UI-15 to UI-19): wordmark, frosted chrome, tier-coloured handles, the **submission wire** (a
  five-segment line that follows a submission's real events), a live **verdict ticker** and a judge window on the
  landing page (new public `GET /api/status/verdicts`, anonymised), 36 px board rows with a pinned own row.
- **Match Day redesign** (UI-08 to UI-14): blue brand, ink primary, 16 px root, 44 px touch targets, landing page,
  contest-day screens, admin and pad screens; UI/UX document kept in sync with the code by tests.
- Owner and admins: `OWNER_EMAIL`, admin list and the **Admins** page (FR-AUTH-12 to 14).
- Contest rules page, favicon, "Add to calendar" opening Google Calendar (UI-21, UI-22).
- A professional README, a demo script and final numbers ([DEMO](docs/DEMO.md)).

### Changed

- Exam mode shows only clarifications and the board; the profile moved to the bottom of the rail; the interview pad
  status is real.

## 2026-10-09: interview pad, plagiarism, hint evaluation

### Added

- **Interview pad** (CP-02 to CP-11): Hocuspocus collab servers (two instances, documents in Postgres), rooms and
  invites, run and submit from the pad, private interviewer notes, version snapshots and restore, a replay with exact
  checkpoints, a whiteboard, offline editing, an interviewer-only AI summary, code suggestions (ED-01).
- **Plagiarism** (PL-01 to PL-06): tree-sitter normalisation and winnowing, UniXcoder embeddings, a labelled evaluation
  set (held-out 92.1 % recall at 88.7 % precision), a review screen with decisions, and a pipeline job.
- **Fair-play signals** (IN-01, IN-02): advisory editor signals, time to first AC, style shift, optional canary sentence.
- **Hint leak evaluation** (AI-04): `hint-main@1` failed the 2 % target, `hint-main@2` passed (0 of 54 hints).
- Contest metrics report (W-00), public editorials after a contest, review-ready updates on the results page.

### Fixed

- The 2 MB document cap never refuses a delete (CP-07); deploy scripts for the plagiarism job.

## 2026-10-08: AI, drills, load tests, exam mode

### Added

- **AI Coach** (AI-01 to AI-03, UI-06): provider layer with budgets and retries, a three-level hint ladder with a
  guardrail pipeline, an egress relay on Vercel, post-contest reviews and the results page.
- **Failure drills** (O-06): six drills pass on production; **load test** (O-03): 500 submissions, p95 2.1 s with two
  judges; production capacity numbers in [METRICS](docs/METRICS.md).
- **Exam mode** (C-10), the resolver ceremony (C-06), the ops console showing judge restarts (X-15), automatic retry of
  a refused submission (X-14).

### Fixed

- Rate limits no longer punish a campus or the Vercel rewrite (X-10); a dead-lettered job's retry kept its old run
  version, so its verdict was discarded (found by the poison drill, O-06).

## 2026-10-07: contests, setter tools, production

### Added

- **Contests** (C-01 and following): registration, contest-scoped lanes, lobby and admin screens, live board.
- **Setter screen** (UI-04): folder upload, live preview, live Validate in the real judge.
- **Production** (D-01 to D-03): Terraform for Azure, the deploy pipeline with automatic rollback, judge provisioning,
  nightly backups with a weekly restore test; privacy and terms pages.

## 2026-10-06: judging, queue, practice

### Added

- **Queue** (Q-01 to Q-05): lanes with a fairness rule, leases, takeover, dead-letter queue, a reconciler, idempotent
  result processing, Redis ACL for the judge, the SSE gateway with resume.
- **Submissions and problems** (S-01, P-01, J-06): the API, content-addressed tests, 20 practice problems, the
  `validate-problem` tool, sandbox attack-suite harness.
- **Web** (UI-01 to UI-03): practice list, workspace with Monaco and live verdicts, submission page with its timeline.

## 2026-10-05: foundation

### Added

- Monorepo, Docker Compose dev stack, the Zod to JSON Schema to Go contracts pipeline, the Drizzle schema, the NestJS
  API skeleton, OAuth sign-in with rotating refresh tokens, design tokens and the app shell.
- **Judge** (J-00 to J-05): isolate setup, box manager, language registry and sandboxed compile, checkers and verdict
  engine, hash-verified test cache, the Redis worker loop.
