# CodeArena — Software Requirements Specification (SRS)

| | |
|---|---|
| **Doc** | `docs/SRS.md` · v1.0 · 30 Sep 2026 |
| **Structure** | Follows the ISO/IEC/IEEE 29148 SRS outline (introduction, overall description, specific requirements, verification, traceability) |
| **Companion docs** | `PRD.md` (stories `US-*`) · `SYSTEM_DESIGN.md` (`SD-§n`) · `UI_UX.md` (screens `S01–S18`) · `PLAN.md` (task cards) |

> **For Claude Code:** requirement IDs are stable. Reference them in tests (`it('FR-SUB-03: …')`) and PR descriptions. "Shall" = mandatory. Priority: **P0** needed for the Day 10 contest · **P1** needed by Day 14 · **P2** planned stretch. Verification: **T** automated test · **D** demo/manual · **I** inspection/review · **A** analysis/measurement.

---

## 1. Introduction

### 1.1 Purpose
Defines the functional and non-functional requirements of CodeArena v1 precisely enough to build, test, and accept it.

### 1.2 Scope
CodeArena v1: OAuth accounts; practice judge; ICPC-style contests with live leaderboard, freeze, resolver, clarifications; problem packages and validation; contest operations; ratings; AI Coach (hints, reviews); plagiarism pipeline and review; advisory integrity signals; collaborative interview pad with playback; public status page. Out of scope: PRD §6.2.

### 1.3 Definitions
See PRD §15. Additional: **Lane** — queue priority class. **Run version** — the n-th judging of a submission. **Ticket** — single-use short-lived realtime credential. **Service token** — shared secret for internal calls between api, collab, and plag.

### 1.4 References
PRD, SYSTEM_DESIGN, UI_UX, PLAN, research doc; isolate man page; Redis Streams docs (XAUTOCLAIM/XCLAIM); Hocuspocus v4 server hooks; WHATWG SSE; RFC 7807 (Problem Details); RFC 6749 + PKCE (RFC 7636); WCAG 2.2; OWASP Top 10:2025; Codeforces rating formula (2015); testlib checker conventions.

---

## 2. Overall description

### 2.1 Product perspective
A self-hosted web system: Next.js frontend (Vercel), NestJS API + Hocuspocus collab + Postgres + Redis + MinIO on an API VM, Go judge workers on isolated VMs, a Python plagiarism batch job. See SD-§3.

### 2.2 Product functions (summary)
Authenticate · browse/read problems · run/submit code · watch live judging · compete in contests · view live standings · ask clarifications · set and validate problems · operate contests · compute ratings · get AI hints and reviews · detect and review plagiarism · run interview rooms with playback · view system status.

### 2.3 User classes and permissions

| Capability | Guest | User | Contestant | Setter | Admin |
|---|---|---|---|---|---|
| View landing, status, public problems, public/past boards | ✓ | ✓ | ✓ | ✓ | ✓ |
| Run/submit practice, hints, profile | | ✓ | ✓ | ✓ | ✓ |
| See contest problems during contest, submit in contest, ask clarifications | | | ✓ | ✓ (not scored) | ✓ |
| Create/edit problems, upload packages, validate, download own hidden tests | | | | ✓ | ✓ |
| Create/edit contests, answer clarifications, rejudge, extend, resolver, finalize | | | | | ✓ |
| Plagiarism runs and decisions, DLQ, audit log, ops console | | | | | ✓ |
| Create rooms (become interviewer) | | ✓ | | ✓ | ✓ |

Per-room roles: **interviewer** (edit, run, notes, playback, restore, close) · **candidate** (edit, run) · **observer** (read-only, sees output).

### 2.4 Operating environment
- Browsers: last 2 versions of Chrome, Edge, Firefox, Safari; min viewport 360 px (full workspace ≥ 1024 px).
- Server: Ubuntu 24.04 LTS VMs (Azure); Docker; Node 22 LTS (Hocuspocus v4 requires Node 22+); Go current stable; Python 3.12; Postgres 16; Redis 7; isolate 2.x on cgroup v2.
- Dev: Windows + WSL2 Ubuntu 24.04 with systemd enabled.

### 2.5 Design and implementation constraints
- Locked decisions PLAN §4.1; approved dependencies PLAN §4.2.
- Free/student services only (Azure for Students, Vercel Hobby, Groq/Gemini free tiers, Grafana Cloud free, Sentry free).
- Judge must not run on serverless platforms.
- No passwords stored; OAuth only.

### 2.6 Assumptions and dependencies
PRD §12.

---

## 3. Specific requirements

### 3.1 External interface requirements

#### 3.1.1 User interface
Defined in `UI_UX.md` (screens S01–S18, components, tokens, accessibility). All UI requirements there are part of this SRS by reference.

#### 3.1.2 REST API conventions
- Base path `/api` (served via Vercel rewrite to the API VM). Internal endpoints under `/internal` are reachable only on the private network and require the service token.
- JSON, UTF-8; request bodies validated with Zod; unknown fields rejected.
- Auth: `Authorization: Bearer <accessToken>` (ES256 JWT, 15 min). Mutations also require header `X-CSRF-Token` matching the `ca_csrf` cookie.
- Pagination: cursor-based `?cursor=&limit=` (max 100); responses `{ items, nextCursor }`.
- Errors: RFC 7807 `application/problem+json` `{ type, title, status, detail, instance, code, errors? }` with `type` = `https://codearena.dev/errors/<code>` (catalogue §3.1.8).
- Rate-limited responses: 429 with `Retry-After`.
- Idempotency: `POST /submissions`, `/runs`, `/rooms/{id}/runs` accept `Idempotency-Key` (UUID); same key within 10 min returns the original response.
- Versioning: unversioned in v1; breaking changes require a contracts change + ADR.

#### 3.1.3 REST endpoints

**Auth and account**

| Method & path | Role | Purpose | Key request → response | Errors |
|---|---|---|---|---|
| GET `/api/auth/{google\|github}` | Guest | Start OAuth (PKCE) | → 302 | — |
| GET `/api/auth/callback/{provider}` | Guest | OAuth callback | → 302 + cookies | oauth-failed |
| POST `/api/auth/refresh` | cookie | Rotate refresh, issue access | → `{accessToken, expiresAt}` | unauthorized, token-reused |
| POST `/api/auth/logout` · `/logout-all` | User | End session(s) | → 204 | — |
| GET `/api/me` | User | Current user | → `User` | unauthorized |
| PATCH `/api/me` | User | Set handle / default language | `{handle?, defaultLanguage?}` → `User` | validation, handle-taken |
| GET `/api/handles/{h}/available` | User | Handle check | → `{available, reason?}` | — |
| DELETE `/api/me` | User | Request account deletion | → 202 | — |
| POST `/api/realtime/ticket` | User (or Guest for public topics) | Realtime ticket | `{topics[] \| roomId}` → `{ticket, expiresAt}` | forbidden-topic, rate-limited |

**Problems and practice**

| Method & path | Role | Purpose | Request → response | Errors |
|---|---|---|---|---|
| GET `/api/problems` | Guest | List | `?q&tags&minDiff&maxDiff&status&cursor` → `{items: ProblemSummary[]}` | — |
| GET `/api/problems/{slug}` | Guest | Statement, samples, limits, checker description | → `ProblemDetail` | not-found |
| POST `/api/runs` | User | Custom/sample run | `{problemSlug?, language, source, input \| sampleIds[]}` → `{runId}` | rate-limited, unsupported-language, payload-too-large |
| GET `/api/runs/{id}` | owner | Run result | → `RunResult` | not-found |
| POST `/api/submissions` | User | Submit | `{problemSlug \| contestSlug+label, language, source}` → `{id, position, etaSeconds}` | contest-not-started, contest-ended, rate-limited, … |
| GET `/api/submissions` | User | List (own; admin any) | `?problem&contest&verdict&language&cursor` → `{items}` | — |
| GET `/api/submissions/{id}` | owner/admin | Detail with tests + journey | → `SubmissionDetail` | forbidden, not-found |
| GET `/api/submissions/{id}/position` | owner | Queue position | → `{position, etaSeconds, lane}` | — |

**Contests**

| Method & path | Role | Purpose |
|---|---|---|
| GET `/api/contests` | Guest | List upcoming/running/past |
| GET `/api/contests/{slug}` | Guest | Details, rules, registered count, my registration |
| POST `/api/contests/{slug}/register` | User | Register (409 if already) |
| GET `/api/contests/{slug}/problems` · `/{label}` | Contestant (after start), Guest (after end) | Contest problems |
| GET `/api/contests/{slug}/board` | Guest (public board) | Board snapshot (frozen view for non-admins during freeze) |
| GET/POST `/api/contests/{slug}/clarifications` | Contestant | List (mine + public) / ask |
| GET `/api/contests/{slug}/announcements` | Contestant | List |
| GET `/api/contests/{slug}/results` | Guest (after finalize) | Final standings + rating changes |

**Setter and admin**

| Method & path | Role | Purpose |
|---|---|---|
| POST `/api/admin/problems` | Setter | Create problem shell |
| POST `/api/admin/problems/{id}/packages` | Setter | Upload package zip (multipart, ≤ 100 MB) → new version |
| PATCH `/api/admin/problems/{id}/statement` | Setter | Edit statement/editorial → new version |
| POST `/api/admin/problem-versions/{vid}/validate` | Setter | Start validation run |
| GET `/api/admin/validation-runs/{id}` | Setter | Validation results |
| GET `/api/admin/problem-versions/{vid}/tests.zip` | Setter (owner)/Admin | Download tests |
| POST/PATCH `/api/admin/contests[/{id}]` | Admin | Create/edit contest |
| PUT `/api/admin/contests/{id}/problems` | Admin | Set problem list (only validated versions) |
| POST `/api/admin/contests/{id}/extend` | Admin | `{minutes}` (1–180) + auto-announcement. *As built (C-07):* refused once the contest is over or if it would pass 1023 minutes; the freeze time does not move; audit-logged. |
| POST `/api/admin/contests/{id}/announcements` | Admin | Broadcast |
| POST `/api/admin/clarifications/{id}/answer` | Admin | `{answer, isPublic}` |
| POST `/api/admin/contests/{id}/problems/{label}/visibility` | Admin | Hide/unhide, `{hidden}`. *As built (C-07):* `contest_problems.hidden` (migration 0005); a hidden problem is not listed, not accepted for submits and runs, and is dropped from the board, which is rebuilt. Re-saving the problem list resets it. |
| POST `/api/admin/contests/{id}/finalize` | Admin | Finalize → ratings, reviews queued. *As built (C-08):* ended contests only, once; answer `{rated, changes}`; reviews are queued by the AI cards. Also `POST .../recompute-ratings` → `{differing, changes}`; `GET /contests/{slug}/results` (guest, 404 until final) → `{serverNow, rated, changes:[{userId, handle, rank, oldRating, newRating, delta}]}`; `GET /users/{handle}/ratings` (guest) → `{handle, rating, history:[{contestSlug, contestTitle, endedAt, rank, oldRating, newRating, delta}]}`. |
| POST `/api/admin/contests/{id}/rebuild-board` | Admin | Rebuild from Postgres |
| POST `/api/admin/contests/{id}/resolver/{start\|step\|auto\|stop}` | Admin | Resolver control. *As built (C-06): not built; the ceremony runs in the admin's browser from `GET /contests/{slug}/board?view=frozen` (admin: the frozen view) and the live board.* |
| GET `/api/admin/ops/summary` | Admin | Lanes, workers, p50/p95, DLQ count, subs/min. *As built (C-07):* lane depth = jobs not yet read by the `judges` group; workers come from the `hb:*` heartbeats; times are submit→verdict over 15 min. |
| GET `/api/admin/dlq` · POST `/api/admin/dlq/{entryId}/requeue` | Admin | DLQ |
| POST `/api/admin/rejudge` | Admin | `{scope: submission\|problem\|contest, id, urgent?}`. *As built (C-07):* `id` is a submission, problem or contest id; the run version goes up and a job for the original problem version goes to the `rejudge` lane (`contest` if urgent); submissions still waiting are skipped; at most 2000 per call (`truncated`); the old verdict stays until the new result arrives; audit-logged. Answer `{queued, skipped, truncated}`. |
| POST `/api/admin/submissions/{id}/disqualify` | Admin | `{reason, clusterId}` → board recompute |
| GET `/api/admin/audit` | Admin | Audit log |

*As built (UI-04, setter screen S15):* the problem endpoints above differ in these ways. `POST /api/admin/problems` (create shell) is not offered: the first upload creates the problem (private). `POST /api/admin/problems/packages` takes a **folder**, not a zip: multipart, one part per file named by its package-relative path plus a `slug` part (≤ 100 MB, one file ≤ 50 MB; only `problem.yaml`, `statement.md`, `editorial.md`, `validator.cpp`, `checker.cpp`, `tests/*`, `solutions/*` are read); it is bearer-authenticated and exempt from the cookie CSRF check, and Caddy allows CORS for the web origin on exactly this path so the body goes straight to the API host rather than through the Vercel rewrite. Tests download as `GET /api/admin/problem-versions/{vid}/tests.tar` (the testset archive) plus `.../tests` (list) and `.../tests/{NN}.in|.ans`, all `Cache-Control: no-store`, setter-owner or admin only (FR-PROB-06). A setter reaches only problems they uploaded (admins all; CLI-imported problems have no author, so admins only). `PATCH .../visibility` is admin only. A validation run (`POST .../validate`, `GET /api/admin/validation-runs/{id}`) is one judge job per package solution plus one `validate` job for the validator, all on the `rejudge` lane; the result of each arrives on the normal results stream and is matched to its `validation_items` row; a run that is still waiting after 10 minutes is failed when read. The screen polls every 1.5 s.

*As built (C-01, contests):* a contest is `draft` (admin only; stored), `scheduled`/`running`/`ended` (derived from the server clock, never stored) or `finalized` (stored). Every contest response carries `serverNow` so countdowns use the server's clock (FR-CONT-03). Admin: `POST/PATCH /api/admin/contests[/{id}]` (`PATCH {published:true}` publishes and needs at least one problem and every pinned version `validation_status = passed`, FR-PROB-05), `PUT /api/admin/contests/{id}/problems` (`{items:[{label, slug}]}`, pins each problem's current version; fixed once the contest begins), `GET /api/admin/contests[/{id}]`. A contest's problems are `GET /api/contests/{slug}/problems[/{label}]`: staff any time, registered contestants while it runs, everyone after it ends; before the start others get 404 (FR-PROB-09). A problem is shown in practice (`/api/problems…`) only when no published contest that includes it is still unfinished. `POST /api/submissions` takes either `problemSlug` or `contestSlug` + `label`: before the start 422 `contest-not-started`; while running it needs registration, goes to the `contest` lane and is stamped with the contest minute and the freeze flag; after the end it is accepted as practice (no contest id, so never on the board) (FR-SUB-03/08). Registration is open until the end, or until the start when `lateRegistration` is off; a repeat is 409. Migration `0004` adds `contests.description`.

*As built (C-02, board):* `GET /api/contests/{slug}/board` → `BoardSnapshot` `{serverNow, version, frozen, problems:[{label, solvedCount, firstSolverId}], rows:[{rank, userId, handle, solved, penalty, lastAcMinute, score, cells:{label:{attempts, acMinute, pending, first}}}]}`; public once published (draft: 404 except admins); from `freezeAt` until finalize non-admins get the frozen view, with their own cells live (FR-BOARD-05). `board.diff` events go to `contest:{id}:board` (public view) and `admin:contest:{id}:board` (live), at most 2 per second per contest, each with the board `version`; a client applies only diffs newer than its snapshot and re-ranks by `score`. `POST /api/admin/contests/{id}/rebuild-board` → `{version}`. Contest rules now limit `penaltyMinutes` to 0–40 and contests to 1023 minutes (SD-§9.2).

*As built (C-04, arena):* `POST /api/runs` takes the same two forms as submissions (`problemSlug`, or `contestSlug` + `label`) with the same gating: 422 `contest-not-started` before the start, registration required while running, allowed after the end; runs use the `practice` lane and never touch the board. `GET /api/contests/{slug}/problems/{label}` now includes `checker` (`{kind, eps?}`; never the checker source).

*As built (C-05, clarifications):* `GET/POST /api/contests/{slug}/clarifications` (registered contestants and admins; `GET` returns my questions plus every public answer; `POST {problemLabel?, question ≤ 2000}` only while the contest runs, 6 per minute, `contest-not-started` / `contest-ended` otherwise), `GET /api/contests/{slug}/announcements`, and for admins `GET /api/admin/contests/{id}/clarifications` (the inbox, with askers), `POST /api/admin/clarifications/{id}/answer {answer, isPublic}` (also edits an answer), `POST /api/admin/contests/{id}/announcements {body}`; answers and announcements are written to the audit log. Realtime topics: `admin:contest:{id}:clar` (`clar.new`, with the asker), `contest:{id}:clar` (`clar.answer` for public answers, `announce.new`; registered contestants), `contest:{id}:u:{userId}` (`clar.answer` for a private answer; only that user, or an admin, can open it). Public events never name the asker.

**Profiles and ratings**: GET `/api/users/{handle}` · `/rating-history` · `/activity?from&to` · `/solved-stats` (Guest).

**AI Coach**

| Method & path | Role | Purpose | Errors |
|---|---|---|---|
| POST `/api/hints` | User | `{problemSlug, level, submissionId?}` → `{hintId, level, text, pointsPenalty}` | hints-disabled-in-contest, hint-level-locked, rate-limited, ai-busy |
| POST `/api/hints/{id}/feedback` | owner | `{helpful: boolean}` | — |
| GET `/api/reviews?contest={slug}` | User | My reviews with status | — |
| GET `/api/reviews/by-submission/{id}` | owner | Review; triggers on-demand generation if missing → `{status, content?}` | ai-busy |

**Integrity**

| Method & path | Role | Purpose |
|---|---|---|
| POST `/api/signals` | Contestant | Batch of editor signals (contest running only) |
| POST `/api/admin/plag/runs` | Admin | `{contestId, params?}` → run id (starts plag job) |
| GET `/api/admin/plag/runs/{id}` | Admin | Status, metrics, clusters |
| POST `/api/admin/plag/runs/{id}/results` | plag service token | Upload pairs + clusters |
| GET `/api/admin/plag/clusters/{id}` | Admin | Members, pairs, code (original + normalised), signals |
| POST `/api/admin/plag/clusters/{id}/decisions` | Admin | `{decision, note}` |

**Rooms (interview pad)**

| Method & path | Role | Purpose |
|---|---|---|
| POST `/api/rooms` | User | `{problemSlug?, language, durationMin}` → room + interviewer membership |
| GET `/api/rooms` · `/api/rooms/{id}` | member | My rooms / room details |
| POST `/api/rooms/{id}/invites` | interviewer | `{role: candidate\|observer}` → `{url, expiresAt}` |
| POST `/api/rooms/join` | User | `{token}` → membership |
| POST `/api/rooms/{id}/close` | interviewer | Close; revoke invites; flush doc |
| POST `/api/rooms/{id}/runs` | interviewer/candidate | `{runId, mode: run\|submit, language, source, input?}` |
| GET/PUT `/api/rooms/{id}/notes` | interviewer only | Private notes |
| GET `/api/rooms/{id}/timeline` | interviewer | Events + duration + checkpoints index |
| GET `/api/rooms/{id}/playback?toSeq=` | interviewer | Binary: checkpoint + updates up to seq |
| POST `/api/rooms/{id}/restore` | interviewer | `{seq}` |
| POST `/api/rooms/{id}/summary` | interviewer | AI summary (P2) |
| POST `/internal/rooms/{id}/authorize` | collab | `{ticket}` → `{userId, name, color, role, readOnly, expiresAt}` |
| POST `/internal/rooms/{id}/updates` (optional) | collab | Batched update log writes if not written directly |

Collab exposes (private network): POST `/internal/collab/{roomId}/broadcast` `{type, payload}` (service token).

**Platform**: GET `/api/status` (Guest, cached 5 s; *as built (O-02):* `{serverNow, overall, components[{id,label,state,detail}], queue[{lane,depth}], p50Ms, p95Ms, totals{submissionsJudged, contestsHosted}}`; "down" for the database, Redis or no judge reporting, "degraded" for more than 20 contest jobs waiting, the pad is "planned"; cached in the API for 5 s and `Cache-Control: public, max-age=5`) · GET `/api/health/live` · `/api/health/ready` · POST `/api/events` (User, batch ≤ 50).

#### 3.1.4 SSE interface
`GET https://api.<domain>/sse?ticket=<t>&topics=<comma list>` — see SD-§10 for envelope, types, authorisation, and resume. Payload schemas are Zod contracts `SseEvent<T>` in `packages/contracts`.

#### 3.1.5 WebSocket (collab) interface
`wss://api.<domain>/collab/<roomId>` using the Hocuspocus provider; `token` = realtime ticket scoped `room:{id}`. Document name `room:{roomId}`. Stateless message types (JSON): `run.started`, `run.result`, `lang.changed`, `timer.sync`, `room.closed`, `restore.applied`.

#### 3.1.6 Problem package format

```
<slug>/
  problem.yaml        # title, difficulty, tags, limits {timeMs, memMb, outputKb}, checker {kind, eps?},
                      # practicePoints, avoidSet {1:[..],2:[..]}, samples: [01, 02]
  statement.md        # Markdown + KaTeX; sections Input, Output, Notes
  editorial.md        # private; key ideas used by AI Coach grounding
  tests/NN.in NN.ans  # NN = 01..99; samples must be the first tests listed in problem.yaml
  checker.cpp         # optional (testlib)
  validator.cpp       # testlib validator for inputs
  generators/*.cpp    # optional; with gen script in problem.yaml
  solutions/
    main.cpp          # expected: AC   (declared in problem.yaml solutions list)
    alt.py            # expected: AC
    wa-*.cpp          # expected: WA
    tle-*.py          # expected: TLE
```

Import rejects: missing files, test numbering gaps, tests > 50 MB total, solutions without expected verdicts, validator failures.

#### 3.1.7 External services
Google & GitHub OAuth (PKCE); Groq and Gemini HTTP APIs (OpenAI-compatible for Groq); Grafana Cloud OTLP; Sentry; Azure (Terraform provider); GHCR; Vercel.

#### 3.1.8 Error catalogue (`code` field)

| code | HTTP | When |
|---|---|---|
| `validation` | 400 | Body/query failed schema; `errors[]` lists fields |
| `unauthorized` / `token-reused` | 401 | Missing/invalid token / refresh reuse detected |
| `forbidden` / `forbidden-topic` | 403 | Role or resource check failed |
| `not-found` | 404 | Unknown or invisible resource (also used to hide existence) |
| `handle-taken`, `already-registered` | 409 | Conflicts |
| `payload-too-large` | 413 | Source > 64 KB, input > 1 MB, package > 100 MB |
| `unsupported-language` | 422 | Language not enabled |
| `contest-not-started`, `contest-ended`, `problem-hidden` | 422 | Contest timing rules |
| `hints-disabled-in-contest`, `hint-level-locked` | 422 | AI rules |
| `invalid-package` | 422 | Package import failures (`errors[]`) |
| `room-closed` | 410 | Room no longer open |
| `rate-limited` | 429 | Limits (+ `Retry-After`) |
| `ai-busy` | 503 | All AI providers/budgets exhausted |
| `internal` | 500 | Unexpected; includes `instance` = request ID |

### 3.2 Functional requirements

#### 3.2.1 Authentication and accounts (AUTH)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-AUTH-01 | The system shall authenticate users only via Google or GitHub OAuth 2.0 with PKCE and state validation. | P0 | US-1.1 · F-06 | T |
| FR-AUTH-02 | On first login the system shall create a user and require handle selection before any scored action. | P0 | US-1.2 | T |
| FR-AUTH-03 | Handles shall be 3–20 chars, match `^[a-z][a-z0-9_.]{2,19}$`, be unique case-insensitively, and not be reserved. | P0 | US-1.2 | T |
| FR-AUTH-04 | The system shall issue ES256 access tokens valid 15 min and refresh tokens valid 30 days (sliding), stored hashed. | P0 | US-1.3 | T |
| FR-AUTH-05 | Each refresh shall rotate the token; presenting a previously rotated token shall revoke the whole token family. | P0 | US-1.3 | T |
| FR-AUTH-06 | Refresh cookies shall be httpOnly, Secure, SameSite=Lax, path-scoped to `/api/auth`. | P0 | F-06 | T |
| FR-AUTH-07 | All mutating requests shall require a CSRF token matching the `ca_csrf` cookie (double submit). | P0 | F-06 | T |
| FR-AUTH-08 | Users shall be able to sign out of the current device or all devices. | P0 | US-1.3 | T |
| FR-AUTH-09 | Role checks (user/setter/admin) shall be enforced server-side on every protected endpoint. | P0 | F-05 | T |
| FR-AUTH-10 | Account deletion shall anonymise the handle in standings and delete personal data and code within 7 days. | P1 | US-1.4 | T |
| FR-AUTH-11 | Realtime tickets shall be random (≥ 128 bits), single-use, valid 60 s, bound to user and scopes. | P0 | F-06 | T |

#### 3.2.2 Problems and packages (PROB)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-PROB-01 | Setters shall create problems by uploading a package conforming to §3.1.6; invalid packages shall be rejected with itemised errors. | P0 | US-5.1 · P-01 | T |
| FR-PROB-02 | Each upload or statement edit shall create a new immutable problem version; submissions reference the version judged. | P0 | US-5.1 | T |
| FR-PROB-03 | Test files shall be stored in object storage under a content hash; the DB stores hash, URI, count. | P0 | P-01 | T |
| FR-PROB-04 | Validation shall run every package solution and compare actual vs expected verdicts, and run the validator on every test input. | P0 | US-5.2 · UI-04 | T |
| FR-PROB-05 | Only versions whose validation passed shall be attachable to a published contest. | P0 | US-5.2 | T |
| FR-PROB-06 | Hidden test contents shall never be returned to non-setter/non-admin users by any endpoint. | P0 | US-5.4 | T |
| FR-PROB-07 | Statements shall render Markdown with KaTeX, sanitised (no raw HTML/script). | P0 | US-2.2 | T |
| FR-PROB-08 | The problem list shall support filters (tags, difficulty range, status, text) combined with AND, reflected in the URL. | P0 | US-2.1 | T |
| FR-PROB-09 | Contest problems shall be invisible (404) to everyone but setters/admins until the contest starts, and appear in practice after it ends. | P0 | US-4.2 | T |
| FR-PROB-10 | Setters shall be able to define an avoid-set per hint level and editorial key ideas in the package. | P1 | AI-02 | I |

#### 3.2.3 Submissions and runs (SUB)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-SUB-01 | Users shall submit source ≤ 64 KB in an enabled language; the system shall persist it and enqueue a judge job before responding. | P0 | US-2.4 · S-01 | T |
| FR-SUB-02 | The submit response shall include queue position and ETA. | P0 | US-3.2 | T |
| FR-SUB-03 | Lane assignment: contest submissions during a running contest → `contest`; pad → `interactive`; otherwise `practice`; rejudges → `rejudge` (or `contest` if urgent). | P0 | Q-01 | T |
| FR-SUB-04 | Submit shall be rate-limited to 6/min per user; runs 12/min; excess returns 429 with Retry-After. | P0 | S-01 | T |
| FR-SUB-05 | Custom runs shall execute on samples or user input (≤ 1 MB), return stdout/stderr (≤ 64 KB each), time, memory, and a diff vs expected for samples, and never affect scores. | P0 | US-2.3 | T |
| FR-SUB-06 | Submission detail shall show per-test verdict/time/memory (test contents hidden), first failing test number, compile log (≤ 16 KB) for CE, and the journey timeline. | P0 | US-2.4, US-3.3 | T |
| FR-SUB-07 | Users shall list their submissions with filters; admins may list anyone's. | P0 | US-2.5 | T |
| FR-SUB-08 | Submitting within a contest shall be rejected before start (`contest-not-started`); after end, it shall be accepted as practice and flagged as such. | P0 | C-01 | T |
| FR-SUB-09 | `Idempotency-Key` on submit/run shall return the original response for repeats within 10 min. | P1 | S-01 | T |

#### 3.2.4 Judging (JUDGE)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-JUDGE-01 | The judge shall support C, C++17, C++20, Python 3, Java 21, JavaScript (Node) per SD-§8.3. | P0 | J-02 | T |
| FR-JUDGE-02 | Compilation shall run inside an isolate sandbox with its own limits (10 s CPU, 512 MB, 1 MB output). | P0 | J-02 | T |
| FR-JUDGE-03 | Each run shall execute in isolate cgroup mode with CPU-time, wall-time (3T+1 s), memory, process, file-size, stack, and open-file limits, no network, and an environment containing only PATH. | P0 | J-01 | T |
| FR-JUDGE-04 | CPU time shall be measured across all processes and threads of the submission. | P0 | J-01 | T |
| FR-JUDGE-05 | Verdicts shall be mapped per SD-§8.4 (AC, WA, TLE, MLE, RE, CE, OLE, SE). | P0 | J-03 | T |
| FR-JUDGE-06 | Checkers `exact`, `tokens`, `float:eps`, `testlib` shall be supported; testlib checkers run sandboxed; `_fail` yields SE and an alert. | P0 | J-03 | T |
| FR-JUDGE-07 | In contest lanes, judging shall stop at the first failing test (ICPC); in practice, the setting defaults to stop-on-first-failure (configurable per problem). | P0 | J-03 | T |
| FR-JUDGE-08 | The host process shall never execute file operations that follow paths inside a sandbox; outputs are read with O_NOFOLLOW, regular-file check, and a size cap. | P0 | J-01, J-08 | T, I |
| FR-JUDGE-09 | Judge workers shall hold no database credentials; they access Redis only as ACL user `judge` and object storage read-only. | P0 | Q-04 | I, T |
| FR-JUDGE-10 | The attack suite (≥ 25 cases, SD-§16.1, PLAN J-07) shall pass 100% in CI and nightly on a judge VM. | P0 | J-07 | T |
| FR-JUDGE-11 | Workers shall publish per-test progress events and a final result carrying submission ID and run version. | P0 | J-05 | T |
| FR-JUDGE-12 | Testsets shall be cached on each judge by hash and verified by SHA-256 before use. | P0 | J-04 | T |
| FR-JUDGE-13 | Each sandbox shall be pinned to a dedicated core; a calibration benchmark at startup shall mark a judge unhealthy if > 15% off the fleet median. | P1 | J-01, O-01 | T |

#### 3.2.5 Queue (QUEUE)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-QUEUE-01 | Jobs shall be Redis Stream entries per lane consumed by group `judges`. | P0 | Q-01 | T |
| FR-QUEUE-02 | Workers shall choose lanes in priority order contest > interactive > practice > rejudge, and every 8th claim shall start from the lowest non-empty lane. | P0 | Q-01 | T |
| FR-QUEUE-03 | A claimed job's lease shall be refreshed every 2 s; jobs idle > 10 s shall be reclaimed by another worker. | P0 | Q-02 | T |
| FR-QUEUE-04 | After more than 3 deliveries a job shall move to the DLQ and its submission shall get verdict SE; the admin is alerted. | P0 | Q-02 | T |
| FR-QUEUE-05 | A job that crashes a worker process twice shall be quarantined. | P1 | Q-02 | T |
| FR-QUEUE-06 | Result processing shall be idempotent on (submission ID, run version); duplicate results shall change nothing. | P0 | Q-03 | T |
| FR-QUEUE-07 | Killing a worker mid-judge shall produce exactly one final verdict (20/20 chaos runs). | P0 | Q-02 | T |
| FR-QUEUE-08 | Queue position shall equal jobs ahead in the same lane plus all jobs in higher lanes; ETA = position × EWMA service time ÷ active workers. | P0 | Q-05 | T |
| FR-QUEUE-09 | A reconciler shall re-enqueue submissions stuck in queued/judging > 2 min without a live job. | P1 | Q-03 | T |

#### 3.2.6 Realtime (RT)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-RT-01 | The system shall deliver events over SSE authenticated by realtime tickets, with per-topic authorisation per SD-§10. | P0 | Q-05 | T |
| FR-RT-02 | Events shall carry monotonically increasing IDs; reconnecting with Last-Event-ID shall replay missed events from a 5-minute buffer, or send a snapshot if older. | P0 | Q-05 | T |
| FR-RT-03 | The server shall send a heartbeat comment every 15 s and a `retry: 3000` hint. | P0 | Q-05 | T |
| FR-RT-04 | Events shall reach clients connected to any API instance (Redis pub/sub fan-out). | P1 | Q-05 | T |
| FR-RT-05 | Slow clients exceeding a 256 KB buffer shall be disconnected (they resume via replay). | P1 | Q-05 | T |

#### 3.2.7 Contests (CONT)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-CONT-01 | Admins shall create contests with title, slug, start, end, freeze time, rules (penalty minutes, CE counts, language multipliers, rated, late registration), and labelled problems. | P0 | C-01 | T |
| FR-CONT-02 | Users shall register until the contest ends (unless late registration is disabled). | P0 | US-4.1 | T |
| FR-CONT-03 | Contest state (scheduled/running/ended) shall be derived from server time; clients shall display countdowns computed from a server time offset. | P0 | US-4.2 | T |
| FR-CONT-04 | Contestants shall ask clarifications per problem or general; admins answer privately or publicly; new answers/announcements are pushed in real time. | P0 | US-4.6 · C-05 | T |
| FR-CONT-05 | Admins shall extend a running contest; an announcement is sent automatically. | P0 | US-6.3 | T |
| FR-CONT-06 | Admins shall hide/unhide a contest problem during the contest. | P0 | US-6.3 | T |
| FR-CONT-07 | Finalising a contest shall freeze results, compute ratings (if rated and ≥ 5 participants), move problems to practice, and queue AI reviews. | P1 | US-4.7 · C-08 | T |
| FR-CONT-08 | Hints and all AI features shall be disabled for a contest's problems while it runs. | P0 | US-8.3 | T |

#### 3.2.8 Leaderboard (BOARD)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-BOARD-01 | Ranking shall follow PRD §9.1 exactly (solved desc, penalty asc, last AC asc, ties share rank). | P0 | US-4.4 · C-02 | T |
| FR-BOARD-02 | The board shall use a packed composite score (SD-§9.2) with a unit test proving bounds < 2^53 and ordering. | P0 | C-02 | T |
| FR-BOARD-03 | The live board shall equal a board rebuilt from Postgres for any submission sequence (property test). | P0 | C-02 | T |
| FR-BOARD-04 | Board updates shall reach clients within 2 s p95 of the verdict being persisted, coalesced to ≤ 2 updates/s. | P0 | C-03 | A |
| FR-BOARD-05 | During freeze, non-admins shall see post-freeze attempts of others as pending with attempt counts; own results remain visible to their owner. | P0 | US-4.5 | T |
| FR-BOARD-06 | The resolver shall reveal pending cells bottom-up, leftmost first, one step at a time or automatically, and end equal to the unfrozen board. | P1 | C-06 | T |
| FR-BOARD-07 | Cells shall show attempts and AC minute; first solves shall be marked; per-problem solve counts shown in headers. | P0 | C-03 | T |
| FR-BOARD-08 | Admins shall rebuild the board from Postgres on demand. | P0 | O-06 | T |
| FR-BOARD-09 | Disqualified submissions shall be excluded and the board recomputed. | P1 | US-9.2 | T |

#### 3.2.9 Ratings and profiles (RATE)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-RATE-01 | Ratings shall be computed per SD-§9.5; initial rating 1400; unrated if < 5 participants. | P1 | C-08 | T |
| FR-RATE-02 | Recomputing a contest's ratings shall yield identical results; the sum of deltas shall be ≤ 0. | P1 | C-08 | T |
| FR-RATE-03 | Profiles shall show rating history, activity heatmap (12 months), solved stats by tag/difficulty, contest history. | P1 | US-7.2 · UI-05 | T |

#### 3.2.10 Operations (OPS)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-OPS-01 | The ops console shall show lane depths, workers + heartbeat age, p50/p95 time-to-verdict (5 min), submissions/min, DLQ entries, refreshed ≥ every 2 s. | P0 | US-6.1 · C-07 | D |
| FR-OPS-02 | Admins shall rejudge a submission, a problem, or a contest; rejudges increment run version and are audit-logged. | P0 | US-6.2 | T |
| FR-OPS-03 | Admins shall view and re-enqueue DLQ entries. | P0 | C-07 | T |
| FR-OPS-04 | All admin actions shall write an audit log entry (actor, action, target, metadata, time). | P0 | C-07 | T |
| FR-OPS-05 | A script shall scale judge VMs up/down; new workers begin claiming jobs automatically. | P0 | US-6.4 · O-04 | D |
| FR-OPS-06 | Alerts shall fire per SD-§15.3. | P0 | O-01 | D |
| FR-OPS-07 | The public status page shall show health, queue depth, p95 verdict time, last attack-suite result, load-test numbers, and an architecture diagram. | P1 | US-11.1 · O-02 | D |

#### 3.2.11 AI Coach (AI)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-AI-01 | Hints shall have 3 levels; level n+1 is available only after level n was delivered for that user/problem. | P1 | US-8.1 · AI-02 | T |
| FR-AI-02 | Each hint shall pass the pipeline in SD-§12.2 (sufficiency → main → code removal → deterministic filter). | P1 | AI-02 | T |
| FR-AI-03 | Hints shall not contain fenced code, 2+ consecutive code-like lines, or avoid-set terms below their allowed level. | P1 | AI-02 | T |
| FR-AI-04 | Hint penalties shall reduce practice points by 10/25/50% (cumulative max) and be disclosed before unlock. | P1 | US-8.1 | T |
| FR-AI-05 | Users shall rate hints helpful/not helpful. | P1 | US-8.1 | T |
| FR-AI-06 | Hints shall be limited to 10/hour/user; the system shall enforce per-model daily token/request budgets before calling a provider and fall back per SD-§12.1. | P1 | AI-01 | T |
| FR-AI-07 | User code sent to LLMs shall be delimited as untrusted data; no secrets or other users' data shall be included in prompts. | P1 | AI-02 | I |
| FR-AI-08 | Post-contest reviews shall be generated on demand or by a paced background job after finalisation, for each participant's final submission per attempted problem. | P1 | US-8.2 · AI-03 | T |
| FR-AI-09 | The leak-rate eval shall run from a CLI and write results to METRICS.md (with vs without removal pass). | P1 | AI-04 | A |
| FR-AI-10 | Every AI call shall log model, task, tokens, latency, and outcome. | P1 | AI-01 | T |
| FR-AI-11 | Interview summaries (P2) shall be visible only to the interviewer. | P2 | CP-11 | T |

#### 3.2.12 Integrity (PLAG / SIG)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-PLAG-01 | Admins shall start a plagiarism run for a contest; the plag job processes final submissions per problem per SD-§13. | P1 | US-9.1 · PL-01 | T |
| FR-PLAG-02 | Boilerplate fingerprints (in > 30% of submissions or in setter templates) shall be ignored. | P1 | PL-01 | T |
| FR-PLAG-03 | Results shall include pair scores from both stages, a combined score, and clusters sorted by max score. | P1 | PL-02 | T |
| FR-PLAG-04 | The review UI shall show original and normalised code side by side with matched regions, and advisory signals separately labelled. | P1 | US-9.2 · PL-04 | D |
| FR-PLAG-05 | Decisions (clear/confirm/discuss) shall require a note and be audit-logged; no automatic penalty is ever applied. | P1 | US-9.2 | T |
| FR-PLAG-06 | The eval harness shall report precision/recall/F1 for Stage A vs A+B on the labelled set. | P1 | PL-03 | A |
| FR-SIG-01 | During contests the client shall send paste events > 50 chars (size, time), problem-open and focus-loss counts; the server derives time-to-AC and a style-shift score. | P1 | IN-01 | T |
| FR-SIG-02 | Signals shall be deleted 30 days after the contest ends and never used to alter scores. | P1 | IN-01 | T |
| FR-SIG-03 | Canary text shall be off by default and configurable per problem. | P2 | IN-02 | T |

#### 3.2.13 Interview pad (PAD)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-PAD-01 | Users shall create rooms with optional problem, language, and duration (30/45/60/90). | P1 | US-10.1 · CP-02 | T |
| FR-PAD-02 | Invites shall be signed, role-specific, expiring tokens revoked when the room closes. | P1 | US-10.1 | T |
| FR-PAD-03 | Collab connections shall authenticate via ticket in `onAuthenticate`; observers shall be read-only. | P1 | CP-01 | T |
| FR-PAD-04 | Awareness identities shall be overwritten with server-verified identities (`beforeHandleAwareness`). | P1 | US-10.2 · CP-01 | T |
| FR-PAD-05 | Sessions shall close connections on expiry or room close (`beforeHandleMessage`/`onTokenSync`). | P1 | CP-01 | T |
| FR-PAD-06 | Document state shall be persisted (debounced ≤ 10 s) and flushed on unload/shutdown; every update shall be logged with seq, ts, user. | P1 | CP-03, CP-06 | T |
| FR-PAD-07 | Two collab instances shall serve rooms with Redis sync; killing one shall cause no lost edits. | P1 | US-10.7 · CP-03 | T |
| FR-PAD-08 | Run/Submit from rooms shall use the interactive lane, be limited to 1 per 2 s per room, and broadcast identical results to all members. | P1 | US-10.3 · CP-04 | T |
| FR-PAD-09 | Interviewer notes shall be stored outside the Y.Doc and returned only to the interviewer. | P1 | US-10.4 · CP-05 | T |
| FR-PAD-10 | Playback shall replay updates with 1×/2×/4× speeds and event markers; seek shall complete < 1 s for 60-minute sessions via checkpoints every 200 updates. | P1 | US-10.5 · CP-06 | T, A |
| FR-PAD-11 | Replaying the full update log shall reproduce the stored final document exactly. | P1 | CP-06 | T |
| FR-PAD-12 | Restoring a snapshot shall apply an anti-operation; all connected clients shall converge. | P1 | US-10.6 · CP-07 | T |
| FR-PAD-13 | Documents shall use `gc: false`, capped at 2 MB and 90-minute sessions. | P1 | CP-07 | T |
| FR-PAD-14 | Offline edits shall persist locally (y-indexeddb) and merge on reconnect. | P2 | CP-09 | T |
| FR-PAD-15 | A whiteboard (pen, rect, arrow, text, eraser) shall sync and appear in playback; every action has a non-drag alternative. | P2 | CP-10 | T |

#### 3.2.14 Analytics (EVT)

| ID | Requirement | Pri | Trace | Ver |
|---|---|---|---|---|
| FR-EVT-01 | The client shall send events listed in PRD §11 in batches ≤ 50; server stores them in `product_events`. | P1 | PRD §11 | T |
| FR-EVT-02 | Events shall never include source code, email, or tokens. | P0 | — | T, I |

### 3.3 Non-functional requirements

#### 3.3.1 Performance

| ID | Requirement | Target | Ver |
|---|---|---|---|
| NFR-PERF-01 | API read endpoints latency (excluding judging) | p95 ≤ 200 ms at 50 req/s | A (k6) |
| NFR-PERF-02 | API write endpoints (submit, register, clarify) | p95 ≤ 300 ms | A |
| NFR-PERF-03 | Time-to-verdict, contest lane, realistic load (λ ≤ 0.5/s, contest-day fleet of 4 judges) | p95 ≤ 15 s | A |
| NFR-PERF-04 | Verdict persisted → SSE delivered | p95 ≤ 1 s | A |
| NFR-PERF-05 | Board propagation | p95 ≤ 2 s | A |
| NFR-PERF-06 | Pad edit propagation (remote render) | p95 ≤ 200 ms with 10 rooms × 3 users | A |
| NFR-PERF-07 | Core Web Vitals (landing, practice list, problem page) at p75 on a mid-range laptop | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 | A |
| NFR-PERF-08 | Initial JS per route (gzip), Monaco excluded and lazy-loaded | ≤ 250 KB | A |
| NFR-PERF-09 | Playback seek, 60-min session | ≤ 1 s | A |
| NFR-PERF-10 | Burst test (500 submissions / 2 min): no loss, bounded Redis memory, drain time recorded for 1/3/6 judges | Recorded in METRICS.md | A |

#### 3.3.2 Capacity
200 concurrent users, 200 SSE connections, 25 rooms, 60 tests/problem, 100 problems, 10k submissions without degradation beyond §3.3.1.

#### 3.3.3 Reliability and availability

| ID | Requirement |
|---|---|
| NFR-REL-01 | Zero lost or duplicated verdicts under worker crash, API restart, and Redis restart drills (T). |
| NFR-REL-02 | API availability ≥ 99.5% during scheduled contests (A). |
| NFR-REL-03 | Leaderboard fully rebuildable from Postgres within 30 s for 1,000 submissions (T). |
| NFR-REL-04 | Backups nightly; restore test weekly; RPO 24 h (minutes on contest days via manual backup); RTO 1 h (D). |
| NFR-REL-05 | Graceful shutdown: workers finish the current job (≤ 60 s) or release it; collab flushes documents (T). |
| NFR-REL-06 | Deployments roll back automatically on failed health checks (D). |

#### 3.3.4 Security

| ID | Requirement |
|---|---|
| NFR-SEC-01 | Controls in SD-§16 implemented; OWASP Top 10:2025 mapping reviewed before Day 10 (I). |
| NFR-SEC-02 | TLS 1.2+ everywhere public; HSTS; security headers per SD-§16.3 (T via header test). |
| NFR-SEC-03 | Secrets only in env/GitHub secrets; never logged; `.env*` denied to Claude Code (I). |
| NFR-SEC-04 | Dependency scanning (Dependabot) and CodeQL on every PR; no high/critical open issues at release (I). |
| NFR-SEC-05 | Authorisation tests for every resource type (submissions, notes, hidden tests, admin routes) (T). |
| NFR-SEC-06 | Rate limits per FR-SUB-04, FR-AI-06, ticket 30/min, events 60/min (T). |
| NFR-SEC-07 | Judge VM network: no inbound from internet; egress only to Redis and MinIO private IPs (I via Terraform). |

#### 3.3.5 Usability
| ID | Requirement |
|---|---|
| NFR-USE-01 | New user reaches first submission in ≤ 2 min median (A via product events). |
| NFR-USE-02 | SUS ≥ 75 in the contest feedback survey (A). |
| NFR-USE-03 | Every error message states what happened and what to do next (I against UI_UX §10). |

#### 3.3.6 Privacy
| ID | Requirement |
|---|---|
| NFR-PRIV-01 | Data collected limited to PRD §9.7; privacy notice page published (I). |
| NFR-PRIV-02 | Email never shown publicly or in logs (T, I). |
| NFR-PRIV-03 | Retention per SD-§6.4 enforced by scheduled jobs (T). |
| NFR-PRIV-04 | No third-party analytics or trackers (I). |

#### 3.3.7 Accessibility
| ID | Requirement |
|---|---|
| NFR-A11Y-01 | Core flows (sign-in, practice, submit, contest, board, pad basics) conform to WCAG 2.2 AA (I + axe-core in Playwright, 0 serious/critical violations) (T). |
| NFR-A11Y-02 | Full keyboard operability; visible focus; focus never fully obscured by sticky UI (T/D). |
| NFR-A11Y-03 | Pointer targets ≥ 24×24 CSS px or sufficiently spaced (I). |
| NFR-A11Y-04 | All drag interactions (panel resize, scrubber, whiteboard moves) have non-drag alternatives (D). |
| NFR-A11Y-05 | `prefers-reduced-motion` disables non-essential motion (T). |

#### 3.3.8 Maintainability
| ID | Requirement |
|---|---|
| NFR-MAIN-01 | Line coverage: worker `sandbox`, `judge`, `queue` ≥ 80%; API services ≥ 70%; plag core ≥ 70% (A). |
| NFR-MAIN-02 | Strict TypeScript; Go vet + staticcheck; ruff + mypy for Python; CI enforces (T). |
| NFR-MAIN-03 | Each significant decision has an ADR (I). |
| NFR-MAIN-04 | Contracts generated code must be fresh (CI check) (T). |

#### 3.3.9 Portability and compatibility
| ID | Requirement |
|---|---|
| NFR-PORT-01 | Full local stack runs on WSL2 Ubuntu 24.04 via `pnpm dev` + `docker compose` (D). |
| NFR-PORT-02 | Browsers per §2.4 (D). |
| NFR-PORT-03 | Infrastructure reproducible from Terraform + cloud-init (D). |

#### 3.3.10 Observability
| ID | Requirement |
|---|---|
| NFR-OBS-01 | Every HTTP request, job, judge phase, AI call emits a span; one submission = one trace (T/D). |
| NFR-OBS-02 | Metrics per SD-§15.2 exported; dashboards as code (I). |
| NFR-OBS-03 | Logs structured JSON with trace/request IDs; no PII beyond user ID (I). |

#### 3.3.11 Legal and licensing
| ID | Requirement |
|---|---|
| NFR-LEG-01 | Third-party licences recorded in `THIRD_PARTY.md` (isolate — invoked as a separate binary; testlib vendored with its licence; Hocuspocus, Yjs, Monaco — MIT; UniXcoder — Apache-2.0) (I). |
| NFR-LEG-02 | No y-redis (AGPL) code included (I). |
| NFR-LEG-03 | Problems are original or used with permission (I). |

### 3.4 Data requirements

| Entity | Key validation rules |
|---|---|
| User | handle per FR-AUTH-03; email from OAuth only; role enum |
| Submission | source ≤ 64 KB UTF-8; language enabled; problem version exists and visible |
| Custom run input | ≤ 1 MB |
| Problem version | limits: timeMs 100–10,000; memMb 16–1024; outputKb 64–65,536; tests 1–99; package ≤ 100 MB |
| Contest | ends_at > starts_at; duration ≤ 1,023 min; freeze_at within [starts_at, ends_at]; labels A–Z unique |
| Clarification | question 1–2,000 chars |
| Room | duration ∈ {30, 45, 60, 90}; doc ≤ 2 MB |
| Notes | ≤ 50 KB |
| Signals | batch ≤ 100 items; only during running contests |

Data model: SD-§6.2. Retention: SD-§6.4.

### 3.5 Business rules

| ID | Rule | Source |
|---|---|---|
| BR-01 | ICPC scoring with 20-minute penalty; CE excluded by default | PRD §9.1 |
| BR-02 | Freeze default last 30 min; own results visible during freeze | PRD §9.2 |
| BR-03 | Language time multipliers C/C++ 1×, Java/JS 2×, Python 3× | PRD §9.3 |
| BR-04 | Rating algorithm and 1400 start; unrated below 5 participants | PRD §9.4 |
| BR-05 | Hints practice-only; penalties 10/25/50% | PRD §9.5 |
| BR-06 | Plagiarism: flag and human review; no automatic penalty | PRD §9.6 |
| BR-07 | Signals advisory, deleted after 30 days | PRD §9.6 |
| BR-08 | Rate limits: submit 6/min, run 12/min, hints 10/h, tickets 30/min, pad runs 1/2 s/room | SD-§16.1 |

---

## 4. Verification

### 4.1 Approach
- **T** requirements: automated tests named with the requirement ID; CI runs them on every PR.
- **A** requirements: measured by k6, OTel, Lighthouse, or eval harnesses; results committed to `docs/METRICS.md` by `scripts/metrics-report`.
- **D** requirements: demonstrated in the dry run (Day 7), contest (Day 10), or demo video (Day 14).
- **I** requirements: reviewed in the PR checklist or the pre-contest security review.

### 4.2 Acceptance test suites

| Suite | Covers | When |
|---|---|---|
| `AT-practice` | Sign-in → handle → problem → run → submit → verdict grid → detail | Every PR (Playwright) |
| `AT-contest` | Register → lobby → start → submit → board update → freeze → end → resolver → finalize | Every PR touching contests; Day 7 |
| `AT-setter` | Upload package → validate → attach to contest | Every PR touching problems |
| `AT-judge` | Verdict matrix per language + attack suite | Every worker PR + nightly |
| `AT-chaos` | Kill worker / API / Redis restart → exactly one verdict; board rebuild | Days 3, 7, 13 |
| `AT-ai` | Hint guards + filter unit tests; leak eval | Day 8–9 |
| `AT-plag` | Pipeline on labelled set | Day 9 |
| `AT-pad` | Two-context edit, cursors, roles, notes privacy, run broadcast, replay fidelity, restore convergence, instance kill | Days 11–13 |
| `AT-a11y` | axe-core on S01–S18 | Every UI PR |

---

## 5. Traceability matrix (epic level)

| Epic (PRD) | FR groups | PLAN tasks | Acceptance suites |
|---|---|---|---|
| E1 Accounts | AUTH | F-06, UI-05 | AT-practice |
| E2 Practice | PROB-07/08, SUB | P-01, S-01, UI-01..03 | AT-practice |
| E3 Judging | JUDGE, QUEUE, RT | J-01..08, Q-01..05 | AT-judge, AT-chaos |
| E4 Contests | CONT, BOARD | C-01..06 | AT-contest |
| E5 Problem setting | PROB-01..06, 09, 10 | P-01, P-02, UI-04 | AT-setter |
| E6 Operations | OPS | C-07, O-01, O-04, O-06 | AT-chaos, D |
| E7 Ratings/profiles | RATE | C-08, UI-05 | unit |
| E8 AI Coach | AI | AI-01..04, UI-06, CP-11 | AT-ai |
| E9 Integrity | PLAG, SIG | PL-01..04, IN-01..02 | AT-plag |
| E10 Pad | PAD | CP-01..10 | AT-pad |
| E11 Status | OPS-07 | O-02 | D |
| E12 Quality | NFR-* | J-07, O-*, D-* | all |

Story-level trace is in each FR row's **Trace** column.

---

## Appendix A — Verdict definitions (user-facing)

| Verdict | Meaning shown to users |
|---|---|
| AC | Accepted — all tests passed |
| WA | Wrong answer on test N |
| TLE | Time limit exceeded on test N |
| MLE | Memory limit exceeded on test N |
| RE | Runtime error on test N (exit code or signal shown) |
| CE | Compilation error — see compiler output |
| OLE | Output limit exceeded on test N |
| SE | System error — not your fault; the organisers have been alerted and it will be rejudged |
