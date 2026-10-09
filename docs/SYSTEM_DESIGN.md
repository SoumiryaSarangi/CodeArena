# CodeArena — System Design

| | |
|---|---|
| **Doc** | `docs/SYSTEM_DESIGN.md` · v1.0 · 30 Sep 2026 |
| **Owner** | Ayush · **Builder** Claude Code |
| **Companion docs** | `PRD.md` (what/why) · `SRS.md` (requirements, API) · `UI_UX.md` · `PLAN.md` (task cards, ADRs §4) |

> **For Claude Code:** sections are numbered `SD-§n`. Task cards in PLAN link here. Read only the section you need. Where this doc and PLAN disagree, this doc wins for *how*; PLAN wins for *when*. Locked decisions live in PLAN §4 and `docs/adr/`.

---

## §1. Goals and design principles

1. **Untrusted code is hostile.** Judge hosts are disposable, hold no secrets, and can't reach the network (Judge0 CVE lessons, research §4.1).
2. **Postgres is the truth; Redis is fast and rebuildable.** Any Redis loss is recoverable from Postgres.
3. **Pull, don't push.** Workers claim jobs; backpressure is natural; scale by adding workers.
4. **Exactly-once effects on at-least-once delivery.** Idempotency keys everywhere (`submissionId + runVersion`, `runId`).
5. **One contract, three languages.** Zod → JSON Schema → Go types (ADR-008).
6. **Observable by default.** Every request, job, and judge phase is a span; every queue has a depth metric.
7. **Boring where possible.** Standard components, documented upgrade paths for scale (ADR-014).

---

## §2. Key numbers and capacity estimates

### 2.1 Load assumptions

| Quantity | Realistic (Warm-up #1) | Design / burst test |
|---|---|---|
| Concurrent contestants | 20–60 | 200 |
| Submissions per contestant per contest | ~10 | ~10 |
| Peak submission rate | ~0.17/s (25% of 600 subs in last 15 min) | **500 in 2 min ≈ 4.2/s** (k6) |
| SSE connections | ≤ 60 | 200+ |
| Interview rooms | ≤ 10 | 25 (load test) |
| Problems per contest | 6 | 6 |
| Tests per problem | 20–60 | 100 |

### 2.2 Judge service time (per submission, CPU-seconds on one core)

| Language | Compile | Per-test run (typical) | 30 tests (AC) |
|---|---|---|---|
| C++ | ~1.5 s | ~50 ms | ~3 s |
| Python 3 | — | ~150 ms | ~4.5 s |
| Java | ~2 s | ~300 ms (JVM start dominates) | ~11 s |
| **Blended mean (S)** | | | **≈ 4 s** (failures stop early) |

Measure the real value in O-03 and replace this estimate in `METRICS.md`.

*Measured (O-03, production, 8 Oct 2026, `docs/METRICS.md`):* mean service time C++ 0.44-0.51 s, Python 0.92-1.12 s on the three test problems (not the 4 s above), so one judge sustained 2.8 submissions/s and cleared the 500-in-2-minutes burst 58 s after the last submit (§2.3 predicted ~15 min); two judges: queue wait p95 0.5 s. Only 1 and 2 judges can run on this subscription (6 vCPU region quota).

*As built (O-03):* the harness is `tests/load/` (driver, rehearsal and production runbook) plus `apps/api/src/modules/load/` (seed, report, cleanup of tagged fake data); `scripts/metrics-report.mjs` writes `docs/METRICS.md`. Service time per language is read from the journey stored with each verdict (`claimed` → verdict). Queue wait = worker claim − submit. Java is not measured: no package has a Java solution yet.

### 2.3 Throughput and queueing (Little's law: L = λW)

One judge VM has 2 vCPUs → 2 sandboxes → μ ≈ 2 / 4 s = **0.5 submissions/s**.

| Judges (cores) | Capacity μ | Realistic contest (λ=0.17/s) | Burst: backlog after 2 min | Burst: drain time (≈ worst wait) |
|---|---|---|---|---|
| 1 (2) | 0.5/s | utilisation 34%, waits ≈ seconds | 440 | ~15 min |
| 3 (6) | 1.5/s | 11% | 320 | ~3.5 min |
| 6 (12) | 3.0/s | — | 140 | ~47 s |
| 9 (18) | 4.5/s | — | 0 (μ > λ) | ≈ service time |

**Conclusions**
- Warm-up #1 needs 1 judge; on contest day run **4** (the steady judge + 3 added by `scale-judges.sh up 3`, PLAN §10) for headroom and fault tolerance (SLO: p95 time-to-verdict ≤ 15 s).
- The burst test proves correctness under overload (no loss, bounded memory, accurate ETA) and that drain time falls linearly with judges. It is *not* expected to meet the 15 s SLO with 3 judges. This is the honest interview answer: "sustained X/s; burst drained in Y s; adding judges scales linearly because the queue is pull-based."
- Everything else (API, Postgres, Redis, SSE) is far below its limits at this scale; the judge is the only bottleneck by design.

### 2.4 Storage

- Source ≤ 64 KB × a few thousand submissions → tens of MB.
- Tests ≤ 50 MB per problem in MinIO; judges cache by hash.
- Pad: update log ≈ 1–5 MB per 60-minute room (measure in CP-08).

---

## §3. Architecture (C4)

### 3.1 Context (level 1)

```mermaid
flowchart LR
  U[Students / contestants] --> CA[CodeArena]
  A[Organiser / setter / admin] --> CA
  I[Interviewer + candidate] --> CA
  CA --> OAuth[Google / GitHub OAuth]
  CA --> LLM[Groq / Gemini APIs]
  CA --> Obs[Grafana Cloud · Sentry · UptimeRobot]
```

### 3.2 Containers (level 2)

```mermaid
flowchart TB
  subgraph Vercel
    WEB[web · Next.js 16]
  end
  subgraph APIVM[API VM · Azure · Docker Compose]
    CADDY[Caddy · TLS · HTTP/2 · routing]
    API[api · NestJS]
    COLLAB1[collab-1 · Hocuspocus v4]
    COLLAB2[collab-2 · Hocuspocus v4]
    PG[(Postgres 16)]
    RD[(Redis 7)]
    MINIO[(MinIO · tests, packages, backups staging)]
    OTEL[otel-collector]
  end
  subgraph JUDGES[Judge VMs · private subnet · no internet egress]
    W1[worker · Go + isolate]
    WN[worker · Go + isolate]
  end
  PLAG[plag · Python batch job]
  WEB -- "REST via /api rewrite" --> CADDY
  WEB -- "SSE /sse, WS /collab (direct, ticket auth)" --> CADDY
  CADDY --> API
  CADDY -- "uri hash on roomId" --> COLLAB1 & COLLAB2
  API --> PG & RD & MINIO
  COLLAB1 & COLLAB2 --> PG & RD
  COLLAB1 & COLLAB2 -- "run/submit via internal HTTP" --> API
  W1 & WN -- "Redis ACL user judge" --> RD
  W1 & WN -- "read-only key" --> MINIO
  PLAG --> API
  API & COLLAB1 & W1 --> OTEL
```

### 3.3 Components (level 3)

**api (NestJS modules)**

| Module | Responsibility |
|---|---|
| `auth` | OAuth flows, JWT issue/verify, refresh rotation, CSRF, realtime tickets |
| `users` | Profiles, handles, settings, deletion |
| `problems` | Problems, versions, packages, validation runs, statements |
| `submissions` | Create, list, detail, custom runs, queue position |
| `queue` | Enqueue (lanes, seq), verdict consumer, reaper, DLQ admin |
| `contests` | Contests, registration, visibility, clock, clarifications, announcements |
| `board` | Leaderboard engine, freeze, resolver state, rebuild |
| `ratings` | Rating computation on finalise |
| `realtime` | SSE gateway, topics, replay buffers, Redis pub/sub bridge |
| `ai` | Provider router, budgets, prompts, hint pipeline, reviews, room summaries |
| `integrity` | Plagiarism run ingestion, clusters, decisions, editor signals |
| `rooms` | Rooms, invites, notes, snapshots, playback data, internal run endpoint for collab |
| `admin` | Ops console data, rejudge, audit log |
| `status` | Public status metrics (cached) |
| `events` | Product analytics ingestion |
| `health` | Liveness/readiness |

**worker (Go packages):** `cmd/worker` · `internal/queue` (claim, lease, ack, reaper) · `internal/sandbox` (box pool, isolate command builder, meta parser, safe reader) · `internal/lang` (registry) · `internal/checker` · `internal/tests` (cache) · `internal/judge` (pipeline, verdict engine) · `internal/telemetry` · `internal/contracts` (generated).

**collab (Hocuspocus v4, Node 22+):** server config + extensions: `auth` (onAuthenticate, onTokenSync, beforeHandleMessage), `awarenessStamp` (beforeHandleAwareness), `Database` (fetch/store), `Redis`, `updateLog` (onChange → room_updates), `events` (stateless → room_events), `limits` (doc size, session length).

---

## §4. Repository and module boundaries

See PLAN §6.1 for the tree. Rules:
- `apps/*` never import from each other; shared types only via `packages/contracts`.
- API modules talk through services, never another module's repository.
- The worker depends only on `internal/contracts` generated code for message shapes.

---

## §5. Key flows (sequence diagrams)

### 5.1 Sign-in and token refresh

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as web (Vercel)
  participant A as api
  participant G as Google
  B->>W: GET /api/auth/google (rewrite → api)
  A-->>B: 302 to Google (state + PKCE verifier in short-lived cookie)
  B->>G: consent
  G-->>B: 302 /api/auth/callback/google?code&state
  B->>A: callback (via /api rewrite)
  A->>G: exchange code (+ PKCE)
  A->>A: upsert user + oauth_account, create refresh family
  A-->>B: Set-Cookie ca_rt (httpOnly, Secure, SameSite=Lax, Path=/api/auth) + ca_csrf, 302 /onboarding or back
  B->>A: POST /api/auth/refresh (cookie) → { accessToken (15 min) }
  Note over B,A: Access token kept in memory only, refreshed silently before expiry
  B->>A: POST /api/auth/refresh with an already-rotated token
  A->>A: reuse detected → revoke whole family → 401
```

### 5.2 Submit → verdict (happy path)

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as api
  participant R as Redis
  participant W as worker
  participant P as Postgres
  B->>A: POST /api/submissions {problem, lang, source}
  A->>A: validate, rate-limit, choose lane
  A->>P: insert submission (queued, runVersion=1)
  A->>R: INCR seq:{lane}, XADD jobs:{lane} JudgeJob(traceparent)
  A-->>B: 201 {id, position, eta}
  B->>A: GET /sse?ticket&topics=sub:{id}
  W->>R: XREADGROUP judges (lane order)
  W->>R: PUBLISH progress:{id} claimed
  W->>W: compile in box → run tests → checker
  W->>R: PUBLISH progress:{id} test n (each)
  W->>R: XADD results JudgeResult, XACK jobs:{lane}, XDEL
  A->>R: XREADGROUP api results
  A->>P: UPSERT judge_runs (submission_id, run_version) + test_results, update submission
  A->>R: board update (if contest), XADD evt:sub:{id}, PUBLISH rt:sub:{id}
  A-->>B: SSE submission.verdict
```

Progress events from the worker are relayed by the API's `progress:*` subscriber into `evt:sub:{id}` so they're replayable.

### 5.3 Worker dies mid-judge (lease expiry)

```mermaid
sequenceDiagram
  participant W1 as worker-1
  participant R as Redis
  participant RP as reaper (in every worker, leader via lock)
  participant W2 as worker-2
  W1->>R: XREADGROUP → job J (pending, owner W1)
  loop every 2 s while judging
    W1->>R: XCLAIM jobs:lane judges W1 0 J JUSTID (resets idle, no retry++)
  end
  Note over W1: kill -9
  RP->>R: XAUTOCLAIM jobs:lane judges W2 10000 0-0 (idle > 10 s)
  R-->>RP: J (delivery count 2)
  RP->>W2: J handed to local runner
  W2->>R: XADD results (runVersion same), XACK
  Note over R: If W1 was only slow and also finishes, its result is a duplicate: the verdict consumer's upsert makes it a no-op
```

- Heartbeat refresh uses `XCLAIM … JUSTID`, which resets the entry's idle time without incrementing the delivery counter (Redis docs).
- `XAUTOCLAIM` claims entries idle longer than `min-idle-time`, resets their idle time, and increments the delivery count unless `JUSTID` is given (the reaper does **not** use JUSTID so the count grows).
- Entries deleted from the stream are dropped from the PEL by `XAUTOCLAIM`, which is why jobs are only `XDEL`-ed after `XACK`.
- **As built (Q-02, ADR-005):** no leader lock (outside the judge ACL); each worker scans `XPENDING … IDLE 10000` and takes stale entries with a min-idle `XCLAIM` (atomic per entry, delivery counted), which also reveals the previous owner. A missing `hb:{owner}` counts a crash in `jobs:crashes`; two crashes quarantine the job, more than 3 deliveries dead-letter it, both with an SE verdict. A worker that finds its entry owned by someone else cancels judging and publishes nothing.

### 5.4 Rejudge

Admin → `POST /api/admin/rejudge {scope}` → for each submission: `runVersion += 1`, status `queued`, enqueue in `rejudge` lane (or `contest` lane when urgent) → consumer upserts by the new runVersion; the submission's *current* verdict is the one with the highest completed runVersion → board recomputed for affected users → audit log entry.

### 5.5 Leaderboard update

On a contest submission's final verdict:
1. Load cell `board:{cid}:cells` field `{uid}:{label}` (attempts, acMinute, pending).
2. Apply rules (§9.1): if already solved → ignore; if AC → set acMinute, recompute user's (solved, penalty, lastAc) → `ZADD board:{cid}` new score; if rejected (not CE unless configured, not SE) → attempts++.
3. If `now ≥ freeze_at` and viewer isn't the owner/admin → public diff says "pending" instead of the verdict; `board:{cid}:frozen` unchanged.
4. First AC on a problem → `HSETNX first:{cid} {label} {uid}`.
5. Publish `board.diff` to `rt:contest:{cid}:board` (coalesced to ≤ 2/s).
All steps run in one Lua script per update for atomicity.
- *As built (C-02):* the incremental rules above give wrong answers when verdicts arrive out of order (an earlier WA judged after a later AC would be ignored) and cannot undo a rejudge or a disqualification. So every update **recomputes the whole (user, problem) cell from Postgres**: all of that user's submissions on that problem in the contest, in submission order, through one pure function (`apps/api/src/modules/board/scoring.ts`). A Lua script then stores the cell (live and frozen view) and recomputes the user's two row scores from all their cells atomically. Triggers: a contest submission is created (pending), a verdict is stored (`ResultsProcessor`, after the commit), a rejudge or disqualification (`BoardService.update`), a registration (zero row). The read-then-write of a cell runs in a short Postgres transaction holding `pg_advisory_xact_lock_shared(board:{cid})` and `pg_advisory_xact_lock(cell:{cid}:{uid}:{label})`, so the last write has always read the latest committed state; a rebuild takes the contest lock exclusively. Board failures never fail a verdict or a submit: they are logged, counted (`ca_board_update_failures_total`, as `ca_board_updates_total{outcome=error}`), and retried at 1, 3 and 10 s. First solves and solve counts are derived from the cells when read (the earliest AC by submission time), so `first:{cid}`/`solved:{cid}` are not stored and stay right after a rejudge. Diffs: after an update `SET board:{cid}:flush NX PX 500`; the winner publishes the changed rows 500 ms later as `board.diff` `{contestId, version, frozen, rows}` (rows carry the packed `score`; clients re-rank) to `contest:{cid}:board` (the public view, frozen during the freeze) and `admin:contest:{cid}:board` (live). No timer runs at the freeze: the frozen view is maintained all along from the `after_freeze` flag, and readers switch by the server clock.

### 5.6 Freeze and resolver

- At `freeze_at`: `COPY board:{cid} board:{cid}:frozen`; public board reads `:frozen` + per-cell pending counters.
- Resolver (admin-driven, state in `resolver:{cid}`):
  1. Start from the frozen ranking.
  2. Repeat: pick the lowest-ranked row that still has pending cells; reveal its leftmost pending cell (apply the true result); if it becomes solved, re-sort (row may move up); emit `board.resolve.step`.
  3. When no pending cells remain, the board equals `board:{cid}` (assert in test C-06).
- Steps are deterministic and replayable from the submissions table.
- *As built (C-02):* there is no `COPY` at `freeze_at`. `board:{cid}:frozen` and `board:{cid}:frozen:cells` are kept up to date with every update, computed from the same submissions with every attempt made after the freeze shown as pending. Non-admins read them from `freeze_at` until the contest is finalized; a signed-in contestant sees their own cells live in place of the frozen ones (rank and totals stay frozen; FR-BOARD-05).

- *As built (C-06):* the resolver is a pure function in the web app (`apps/web/lib/resolver.ts`), not server state: the admin's browser reads the frozen view (`?view=frozen`) and the live view and walks one to the other, bottom rank first and leftmost cell first, with the packed score recomputed per step. Nothing is written to `resolver:{cid}`. It is deterministic, so a replay gives the same sequence, and its end equals the live board (tested on 200 random contests).

### 5.7 Realtime connection

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as api (Caddy → api)
  participant R as Redis
  B->>A: POST /api/realtime/ticket {topics}
  A->>R: SET tkt:{t} {uid, topics, scopes} EX 60 NX
  A-->>B: {ticket}
  B->>A: GET https://api.<domain>/sse?ticket=t&topics=… (EventSource)
  A->>R: GETDEL tkt:{t} (single use), authorise each topic
  A-->>B: 200 text/event-stream, retry: 3000
  Note over A,B: ": ping" comment every 15 s
  B--xA: network drop
  B->>A: reconnect with Last-Event-ID (needs new ticket: client fetches one first)
  A->>R: XRANGE evt:{topic} (lastId …  → replay missed events
```

### 5.8 Pad connect, edit, run

```mermaid
sequenceDiagram
  participant C as Candidate browser
  participant H as collab (Hocuspocus)
  participant A as api
  participant P as Postgres
  C->>A: POST /api/realtime/ticket {scope: room:{id}}
  C->>H: WS /collab/{roomId} + token=ticket
  H->>A: POST /internal/rooms/{id}/authorize {ticket} (service token)
  A-->>H: {userId, name, role, readOnly, expiresAt}
  H->>H: connection.readOnly = role==observer, context = user
  H->>P: onLoadDocument → fetch room_docs.state
  C->>H: Yjs update
  H->>P: append room_updates (seq, ts, user, bytes), debounced store state
  C->>A: POST /api/rooms/{id}/runs {runId, lang, source, input}
  A->>A: per-room rate limit, enqueue interactive lane
  A->>H: POST /internal/collab/{id}/broadcast {run.started}
  H-->>C: stateless message to all in room
  Note over A,H: verdict arrives → api → collab broadcast run.result + room_events row
```

### 5.9 AI hint pipeline

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as api (ai module)
  participant L as LLM router
  B->>A: POST /api/hints {problemId, level, submissionId?}
  A->>A: guard: practice only, level order, rate limit, budget check, cache lookup
  A->>L: step 1 sufficiency (small model)
  A->>L: step 2 main hint (large model)
  A->>L: step 3 code-removal rewrite (small model)
  A->>A: step 4 deterministic filter (code-like lines, avoid-set scoring)
  A->>A: store hint_requests, cache
  A-->>B: {hint, level, pointsPenalty}
```

---

## §6. Data design

### 6.1 Conventions

- IDs: UUIDv7 (time-ordered) for all primary keys.
- Timestamps `timestamptz`, UTC in storage; UI renders IST by default.
- Enums as Postgres enums (created in migrations).
- Soft delete only for users (`deleted_at`); everything else hard-deletes or is immutable.

### 6.2 Schema (Drizzle; columns abbreviated where obvious)

```sql
-- identity
users(id uuid pk, handle citext unique not null, name text, email citext unique not null,
      avatar_url text, role user_role not null default 'user', rating int not null default 1400,
      default_language text, created_at, deleted_at)
oauth_accounts(id uuid pk, user_id fk, provider oauth_provider, provider_user_id text,
      unique(provider, provider_user_id))
refresh_tokens(id uuid pk, user_id fk, family_id uuid, token_hash bytea unique,
      created_at, expires_at, revoked_at, replaced_by uuid, user_agent text)
      index(user_id), index(family_id)

-- problems
problems(id uuid pk, slug text unique, title text, difficulty int, visibility problem_visibility,
      current_version_id uuid, author_id fk, practice_points int, created_at)
problem_versions(id uuid pk, problem_id fk, version int, statement_md text, editorial_md text,
      limits jsonb /* {timeMs, memMb, outputKb, wallMultiplier} */,
      checker jsonb /* {kind:'exact'|'tokens'|'float'|'testlib', eps?, sourceUri?} */,
      testset_hash text, testset_uri text, tests_count int, samples jsonb,
      validation_status validation_status, validated_at, created_by fk, created_at,
      unique(problem_id, version))
problem_tags(problem_id fk, tag text, pk(problem_id, tag))
package_solutions(id uuid pk, version_id fk, name text, language text, expected_verdict verdict, source_uri text)
validation_runs(id uuid pk, version_id fk, status run_status, results jsonb, created_at, finished_at)

-- judging
submissions(id uuid pk, user_id fk, problem_version_id fk, contest_id fk null, language text,
      source text, source_bytes int, lane lane, status submission_status, verdict verdict null,
      time_ms int, mem_kb int, failed_test int, current_run_version int not null default 1,
      contest_minute int, after_freeze bool default false, disqualified bool default false,
      created_at, judged_at)
      index(user_id, created_at desc), index(contest_id, created_at), index(problem_version_id, verdict)
judge_runs(id uuid pk, submission_id fk, run_version int, reason run_reason, worker_id text,
      started_at, finished_at, verdict verdict, time_ms int, mem_kb int, compile_log text,
      unique(submission_id, run_version))
test_results(judge_run_id fk, test_no int, verdict verdict, time_ms int, mem_kb int,
      checker_msg varchar(256), pk(judge_run_id, test_no))
custom_runs(id uuid pk, user_id fk, room_id fk null, problem_version_id fk null, language text,
      source text, input text, status run_status, result jsonb, created_at)  -- purge after 7 days

-- contests
contests(id uuid pk, slug text unique, title text, starts_at, ends_at, freeze_at null,
      rules jsonb /* {penaltyMinutes:20, ceCountsAsAttempt:false, langMultipliers, rated, lateRegistration} */,
      status contest_status, created_by fk, finalized_at)
contest_problems(contest_id fk, label char(1), problem_id fk, version_id fk, position int,
      pk(contest_id, label))
participants(contest_id fk, user_id fk, registered_at, final_rank int, finished_at, finish_reason, leave_count int default 0, last_leave_at, pk(contest_id, user_id))  -- finished_at.. = exam mode (C-10)
clarifications(id uuid pk, contest_id fk, problem_label char(1) null, asker_id fk, question text,
      answer text, answered_by fk, is_public bool, created_at, answered_at)
announcements(id uuid pk, contest_id fk, body text, created_by fk, created_at)
rating_changes(contest_id fk, user_id fk, old_rating int, new_rating int, delta int,
      seed numeric, rank int, pk(contest_id, user_id))

-- AI
hint_requests(id uuid pk, user_id fk, problem_id fk, level smallint, submission_id fk null,
      prompt_version text, models jsonb, tokens_in int, tokens_out int, response text,
      leak_flag bool, blocked_reason text, helpful bool null, created_at)
reviews(id uuid pk, user_id fk, contest_id fk, problem_id fk, submission_id fk, status review_status,
      content_md text, prompt_version text, model text, tokens int, created_at, ready_at,
      unique(submission_id))

-- integrity
plag_runs(id uuid pk, contest_id fk, params jsonb, status run_status, metrics jsonb, started_at, finished_at)
plag_pairs(run_id fk, problem_id fk, sub_a uuid, sub_b uuid, fp_score real, emb_score real,
      combined real, pk(run_id, sub_a, sub_b))
plag_clusters(id uuid pk, run_id fk, problem_id fk, submission_ids uuid[], max_score real)
review_decisions(id uuid pk, cluster_id fk, decision decision_kind, note text not null,
      reviewer_id fk, created_at)
editor_signals(id bigserial pk, user_id fk, contest_id fk, problem_id fk, kind signal_kind,
      size int, at timestamptz)  -- purge 30 days after contest end

-- interview pad
rooms(id uuid pk, owner_id fk, problem_id fk null, language text, duration_min int,
      status room_status, created_at, closed_at, doc_bytes int)
room_members(room_id fk, user_id fk, role room_role, joined_at, pk(room_id, user_id))
room_invites(id uuid pk, room_id fk, role room_role, token_hash bytea unique, expires_at, revoked_at)
room_docs(room_id pk fk, state bytea, updated_at)
room_updates(room_id fk, seq bigint, ts timestamptz, user_id fk, update bytea, pk(room_id, seq))
room_checkpoints(room_id fk, seq bigint, state bytea, pk(room_id, seq))
room_events(room_id fk, seq bigint, ts, user_id fk, kind room_event_kind, payload jsonb)
room_snapshots(id uuid pk, room_id fk, seq bigint, label text, snapshot bytea, created_at)
interviewer_notes(room_id pk fk, author_id fk, body_md text, updated_at)
room_summaries(room_id pk fk, content_md text, model text, created_at)

-- platform
product_events(id bigserial pk, user_id fk null, name text, props jsonb, at)  index(name, at)
audit_log(id bigserial pk, actor_id fk, action text, target_type text, target_id text, meta jsonb, at)
```

### 6.3 State machines

```
Submission:  queued ──claim──▶ judging ──result──▶ done
                 ▲                 │                 │
                 └──── retry ◀─────┘ (lease expiry)  └── rejudge (runVersion+1) ──▶ queued
             judging ── deliveries > 3 ──▶ failed (verdict SE, DLQ)

Contest:     draft ─publish▶ scheduled ─(starts_at)▶ running ─(ends_at)▶ ended ─finalize▶ finalized
             (running/ended derived from server time; status column updated by a scheduler for queries)

Validation:  pending ▶ running ▶ passed | failed          Room: open ▶ closed ▶ archived
Review:      pending ▶ ready | failed                     Plag run: queued ▶ running ▶ done | failed
```

### 6.4 Retention

| Data | Retention |
|---|---|
| editor_signals | 30 days after contest end |
| custom_runs | 7 days |
| room_updates / checkpoints | 90 days after room close (then compacted to final state) |
| Logs (Grafana Cloud) | 14 days (free tier) |
| Everything else | Until account deletion (anonymised in standings) |

---

## §7. Redis keyspace

| Key | Type | TTL | Writer → Reader | Purpose |
|---|---|---|---|---|
| `jobs:{lane}` | stream (group `judges`) | none; `XDEL` after ack | api → worker | Judge jobs per lane |
| `jobs:dlq`, `jobs:quarantine` | stream | none | worker/api → admin | Failed / poison jobs |
| `results` | stream (group `api`) | trimmed `MINID` older than 1 h after ack | worker → api | Judge results |
| `seq:{lane}` | string | none | api | Per-lane job counter (`INCR` and `XADD` in one Lua script at enqueue, so counter order = stream order); stamps `JudgeJob.seq`. The API's `api` ACL user needs `EVAL` on `seq:*` and `jobs:*` (Q-04) |
| `ewma:svc:{lane}` | string | none | api (progress bridge) | Service-time EWMA for ETA |
| `lock:bridge` | string | 5 s lease | api | Leader of the progress bridge (Q-05) |
| `pclaim:{id}` | string | 10 min | api | When a judge claimed a job (for the EWMA) |
| `sub:entry:{id}` | string | 1 h | api | `lane:entryId` of a queued job (queue position, S-01) |
| `idem:{scope}:{uid}:{key}` | string | 10 min | api | `Idempotency-Key` result (S-01) |
| `hb:{workerId}` | string (JSON) | 10 s | worker | Heartbeat |
| `progress:{submissionId}` | pub/sub | — | worker → api | Per-test progress |
| `evt:{topic}` | stream `MAXLEN ~ 2000` | 5 min idle expiry | api → api | SSE replay buffer |
| `rt:{topic}` | pub/sub | — | api → all api instances | SSE fan-out |
| `tkt:{ticket}` | string | 60 s | api | Realtime ticket (single use via `GETDEL`) |
| `board:{cid}` / `board:{cid}:frozen` | zset | 30 days | api | Leaderboard (userId → packed score), live and frozen view |
| `board:{cid}:cells` / `board:{cid}:frozen:cells` | hash | 30 days | api | Cell state `{uid}:{label}` → `{a, m, t, p}` (attempts, AC minute, AC submission time, pending) |
| `board:{cid}:ver`, `board:{cid}:dirty`, `board:{cid}:flush` | string, set, string | 30 days, 30 days, 500 ms | api | Board version (diffs), users changed since the last diff, diff lease (C-02). First solves and solve counts are derived from the cells, not stored |
| `resolver:{cid}` | hash | 7 days | api | Resolver progress |
| `rl:{scope}:{id}` | hash | window | api | Token-bucket rate limits |
| `ai:jobs` | stream | none | api | AI reviews / summaries |
| `ai:budget:{model}:{yyyymmdd}` | hash | 48 h | api | Token/request ledger |
| `ai:cache:{sha256}` | string | 7 d | api | Hint cache |
| `lock:{name}` | string | lease | any | Singleton jobs (`SET NX PX`): `lock:bridge` (Q-05), `lock:reconciler` (Q-03b) |
| `recon:cool:{id}`, `recon:attempts` | string, hash | stuck period, 24 h | api | Reconciler attempt spacing and count (Q-03b) |
| Hocuspocus Redis extension keys | managed | — | collab | Cross-instance sync |

_Queue position (decision, J-05):_ the judge user may only `SET hb:*` (ADR-009), so there is no `claimed:{lane}` key. The API derives position from the stream itself: jobs ahead in a lane = entries between the group's `last-delivered-id` (`XINFO GROUPS`) and the job's own entry id, counted with `XRANGE … COUNT` (capped; beyond the cap it shows "100+"), plus the same figure for every higher lane (FR-QUEUE-08). This keeps a compromised judge from lying about queue state and needs no extra ACL.

_Custom runs (decision, J-05):_ a job with `mode: run` and `customInput` runs the source once on that input with no checker; the result's `output` and `stderr` (≤ 64 KB each) are set only for these runs, and the verdict says how the run ended (AC = ran to completion). Problem tests never return program output.

_Wire format (J-05):_ a `jobs:{lane}` entry has one field, `job`, holding the `JudgeJob` JSON; a `results` entry has one field, `result`, holding the `JudgeResult` JSON; `jobs:dlq` entries carry `job`, `reason` (`invalid-job` or `execution-failed`), `error`, `workerId`, `lane`, `entry`, `ts`. `hb:{workerId}` holds `{workerId, lane, ts, busy, concurrency}`; `progress:{submissionId}` carries `JudgeProgress` JSON. The consumer name is the worker id, and a restarted worker resumes its own unacknowledged entries first. A testlib checker's `sourceUri` points at the checker's C++ **source** under `checkers/` (compiled on each judge, SD-§8.5).

---

## §8. Judge engine

### 8.1 Pipeline

```
claim job ─▶ ensure testset cached (hash) ─▶ init compile box ─▶ compile (sandboxed)
  └─ CE? ─▶ result CE (compile log ≤ 16 KB)
  └─ ok ─▶ init run box (same core) ─▶ for each test (ordered):
            copy input into box (host writes only into fresh box dir, O_EXCL)
            isolate --run … < input > out  (meta file)
            read out safely (O_NOFOLLOW, fstat regular, size cap)
            map meta → verdict; if OK → run checker (in its own box) → verdict
            publish progress; stop on first failure if stopOnFirstFailure
         ─▶ cleanup boxes ─▶ publish result ─▶ XACK + XDEL
```

### 8.2 isolate invocation (run step)

```
isolate --box-id=<core> --cg --init
isolate --box-id=<core> --cg --run \
  --meta=<metafile> --time=<T> --extra-time=0.5 --wall-time=<3T+1> \
  --cg-mem=<MEM_KB> --processes=<P> --fsize=<OUTPUT_KB> --stack=<STACK_KB> \
  --open-files=64 --env=PATH=/usr/bin:/bin --stdin=in.txt --stdout=out.txt --stderr=err.txt \
  --dir=/usr/lib/jvm --dir=… (language runtime dirs only, read-only) \
  -- <run command>
isolate --box-id=<core> --cg --cleanup
```

- Network is off by default (isolate creates a fresh network namespace with only loopback); never pass `--share-net`.
- `T` = problem time limit × language multiplier. Wall time guards sleeping programs.
- Box directories are created by isolate; the host never follows paths inside them except via the safe reader.
- Each box is pinned to a dedicated core (`taskset` on the isolate invocation) for timing fairness.

### 8.3 Language registry (`apps/worker/languages.yaml`)

_Implemented as `apps/worker/internal/languages/languages.yaml` (embedded with `go:embed`, which cannot reach a parent directory). Tool paths are absolute because isolate does not search PATH._

| id | Compile | Run | Processes | Memory overhead allowance |
|---|---|---|---|---|
| `c` | `gcc -O2 -std=c17 -static -o main main.c -lm` | `./main` | 1 | 0 |
| `cpp17` / `cpp20` | `g++ -O2 -std=c++17/20 -static -o main main.cpp` | `./main` | 1 | 0 |
| `python3` | `python3 -m py_compile main.py` (syntax check → CE) | `python3 main.py` | 1 | 16 MB |
| `java21` | `javac -encoding UTF-8 Main.java` | `java -Xss64m -XX:+UseSerialGC -Xmx<MEM> Main` | 32 | 64 MB |
| `node` | `node --check main.js` | `node --stack-size=65500 main.js` | 16 | 48 MB |

Compile limits: 10 s CPU, 512 MB, output 1 MB, 64 processes (javac needs threads).

### 8.4 Verdict mapping

| Condition (from meta / checker) | Verdict |
|---|---|
| Compile step non-zero exit or killed | CE |
| `status:TO` (time or wall time exceeded) | TLE |
| `cg-oom-killed` present | MLE |
| Output file hit `--fsize` (SIGXFSZ) or stdout > limit | OLE |
| `status:SG` (signal) or `status:RE` (non-zero exit) | RE (signal name shown) |
| `status:XX` (sandbox internal error) | SE (retry, then DLQ) |
| Exit 0 → checker `_ok` (exit 0) | AC |
| Checker `_wa` (1) or `_pe` (2) | WA (PE merged into WA, like Codeforces) |
| Checker `_fail` (3) | SE + alert "checker failed" (jury error) |
| Checker partial `_pc` | WA (partial scoring out of scope, NG2) |

Reported time = meta `time` (CPU time of the whole control group). Reported memory = meta `cg-mem` (whole group, KB). Note: `cg-mem` can be lower than `max-rss` because shared pages (libc, JVM) are accounted differently; the limit is enforced by the cgroup either way.

### 8.5 Checkers

| Kind | Rule |
|---|---|
| `exact` | Byte-equal after normalising trailing whitespace at line ends and final newline |
| `tokens` (default) | Whitespace-separated tokens equal |
| `float:eps` | Tokens equal, numeric tokens within absolute or relative error `eps` |
| `testlib` | `checker <input> <output> <answer>`; exit code decides (0 OK, 1 WA, 2 PE, 3 FAIL); message ≤ 256 chars stored |

Custom checkers are compiled once per problem version on each judge (cached by hash) and run inside a box.

### 8.6 Test cache

- Path: `/var/cache/codearena/tests/<testsetHash>/{NN.in,NN.ans}`, owned by a non-root user, mode 0440.
- Download from MinIO with a read-only key; verify SHA-256 of the tar before extracting (tar extraction rejects absolute paths and `..`).
- LRU eviction when the cache exceeds 5 GB.

### 8.7 Timing fairness

- Same VM size for every judge; one box per core; boxes pinned.
- A calibration program runs at worker start; its time is exported as a metric. If a judge's calibration deviates > 15% from the fleet median, it marks itself unhealthy and stops claiming.

---

## §9. Contests, leaderboard, ratings

### 9.1 Scoring rules — see PRD §9.1.

### 9.2 Composite score packing

Redis sorted-set scores are IEEE-754 doubles, exact for integers < 2^53. We pack three fields into one integer:

```
S = solved            (0 … 26)
P = penalty minutes   (0 … 131071, capped; 2^17 − 1)
T = last AC minute    (0 … 1023;  contests ≤ 1023 minutes)

score = S · 2^27 + (2^17 − 1 − P) · 2^10 + (1023 − T)
```

Higher is better (`ZREVRANGE`). Max value = 26·2^27 + 2^27 − 1 ≈ 3.6 × 10^9 ≪ 2^53. Rejected attempts counted per problem are capped at 99 so `P ≤ 26 × (1023 + 20 × 99) = 78,078 < 131,071`. Unit test asserts the bounds and ordering (C-02).

Equal scores share a rank: rank = 1 + number of rows with a strictly greater score (`ZCOUNT key (score +inf`).
- *As built (C-02):* the 17-bit penalty holds only if `penaltyMinutes ≤ 40` (26 · (1023 + 40 · 99) = 129,558 < 131,071), so `ContestRules.penaltyMinutes` is limited to 0–40, and a contest may last at most 1023 minutes (`MAX_CONTEST_MINUTES`) so T fits its 10 bits. `scoring.test.ts` proves the maximum is below 2^53 and, with fast-check, that score order equals the ICPC comparator for any two results.

### 9.3 Board rebuild

`rebuildBoard(cid)`: delete keys → replay all contest submissions ordered by `created_at` through the same pure function used live → write ZSET/hash → if frozen, rebuild `:frozen` from submissions before `freeze_at`. Property test: live board == rebuilt board for random sequences.
- *As built (C-02):* `BoardService.rebuild` computes every cell and row with the same functions, writes them under temporary names and swaps them in with `RENAME` in one `MULTI`, so a reader never sees an empty board; a board that has gone missing (expired, Redis flushed) is rebuilt on the next read or update. `POST /api/admin/contests/{id}/rebuild-board` (admin). The property test (`board.test.ts`) drives random contests through the real `ResultsProcessor` with shuffled and repeated verdicts, rejudges and disqualifications and checks the ZSET ranking against an independently written reference from Postgres, for the live and the frozen view, then checks a rebuild changes nothing.

### 9.4 Freeze and resolver — see §5.6.

### 9.5 Rating (C-08)

Deterministic implementation of the Codeforces-style algorithm (PRD §9.4):
1. For each participant compute `seed_i = 1 + Σ_j P(j beats i)` using ratings before the contest.
2. `m_i = sqrt(seed_i × rank_i)`; binary-search rating `R` in [−4000, 8000] such that seed with rating `R` ≈ `m_i`; `d_i = (R − r_i) / 2`.
3. Anti-inflation: `inc = −Σd_i / n − 1`, add to all; then for the top `min(n, 4√n)` by pre-contest rating, `inc2 = min(max(−Σd_top / s, −10), 0)`, add to all.
4. Round; store in `rating_changes`; update `users.rating`.
Test: identical inputs → identical outputs; sum of deltas ≤ 0.
- *As built (C-08):* `apps/api/src/modules/ratings/ratings.ts` is a pure function. Players are sorted by id before any sum, the binary search runs exactly 100 halvings, and the output is rounded, so the same field gives the same numbers in any input order. Tied players share the middle of the places they occupy (a tie of ranks 3–4 counts as 3.5), which is the Codeforces treatment. The seed uses `P(j beats i)` for every other player. `inc` and `inc2` are as above, with `top = min(n, round(4√n))`, and the tie-break for "top by rating" is the id. **Who is rated:** registered participants with at least one submission that is not disqualified (a registered user who never submitted is not in the field), ranked among themselves by the packed board score; the board is rebuilt from the database first so the standings are what the submissions say. **Finalising** (`POST /admin/contests/{id}/finalize`) needs an ended contest and runs once: in one transaction it sets `status = finalized` (the board stops being frozen for everyone), and for a rated contest with at least 5 such participants inserts `rating_changes` (old, new, delta, seed, rank) and updates `users.rating` (rows locked in id order). **Recompute** (`POST .../recompute-ratings`) starts from the stored `old_rating`, takes the standings again, rewrites the rows and moves a user's current rating only if it is still the one this contest gave them (a later contest is not undone); with unchanged submissions it changes nothing. Not done here: queueing AI reviews on finalise (the AI cards) and moving problems to practice (already follows from the contest being over, FR-PROB-09).
- *As built (C-10, exam mode):* a per-contest rule (`rules.examMode`) switches on a small state machine kept on the `participants` row, so a reload or a modified client cannot change it. Flow: the arena shows a gate ("Start the test", full screen where the browser allows it); while *armed* the browser reports `visibilitychange` (hidden), window `blur` and leaving full screen to `POST /leave`, coalesced client-side for 2 s; the server's atomic `UPDATE` (see SRS) increments `leave_count` unless the previous leave is under 2 s old and sets `finished_at` on the 3rd; the reply drives the warning dialog or the finished screen. A finished participant is refused at the two choke points, `ContestsService.gate()` and `SubmissionsService.target()`, with 403 `contest-finished`; the arena turns that response into the finished screen, so a second tab or device learns on its next call (no new SSE event). `Reopen` clears the four columns and writes `audit_log` (`contest.reopen`). Honest limit: the site cannot stop Alt-Tab or a second device, and focus events can fire for notifications or devtools; that is why it is opt-in, announced on the rules page, and reversible by an admin.
- *As built (X-10, rate limits behind a proxy):* the 500-submission load test showed that limits keyed by address punish people who share one: a campus, and everyone who reaches the API through the Vercel rewrite (Caddy sees Vercel's address, not the visitor's; only `/api/sse`, which goes straight to the API host, sees the real one). Signed-in requests are limited per user, so contestants were never affected; the unsigned-in paths were: `GET /sse` (200 test listeners from one address: 5 refused, 3,900 retries), `POST /auth/refresh` (every page load of every visitor, one shared bucket of 120/min) and the sign-in routes. Now: anonymous default 600/min per address; refresh 30/min **per session** (hash of the refresh cookie; without a cookie the anonymous bucket); `/sse` not limited per address. Trade-off: a flood of invalid tickets is cheap for the API (one regex, one `GETDEL`) and every valid ticket needs a signed-in user. Not done: restoring the visitor's real address behind the rewrite (Vercel's forwarded address cannot be trusted without a shared secret).
- *As built (O-06, failure drills):* every drill ends with the same checks (`apps/api/src/modules/load/verify.ts`): every accepted submission has a final verdict; one `judge_runs` row per (submission, current run version); one entry per job in the retained part of the `results` stream; `results:dlq` empty; `jobs:dlq` as expected; no job still claimed in `jobs:*`; and `GET board` equal to `GET board` after `POST rebuild-board`. Faults: `kill -9` of a worker (the other worker takes the job over 10 s after the last lease refresh), `kill -9` of the API (results the dead instance read are taken over after 60 s idle), Redis restarted clean and killed hard (append-only persistence, the API reconnects by itself, the stream stays up), a judge stopped for longer than the takeover time and then resumed (its late result is not published because it checks it still owns the job), and a poison job (a re-packed copy of a real testset that the judge has never seen, absent from the store until "the outage ends"). **Defect found by the poison drill:** `OpsService.requeue` put a dead job back with its old run version; an `execution-failed` job has already stored SE for that version, so the retry's result was discarded as a duplicate and the submission stayed on SE. A re-queued job whose submission already has a verdict now gets a new run version, like a rejudge.

---

## §10. Realtime (SSE)

- **Transport:** SSE over HTTP/2 through Caddy (avoids the browser's 6-connections-per-domain limit that applies to SSE over HTTP/1.1). One `EventSource` per tab carrying multiple topics.
- **Envelope:** `id: <evt stream id>` · `event: <type>` · `data: {"topic","type","ts","data"}`.
- **Types:** `submission.progress`, `submission.queue`, `submission.verdict`, `board.snapshot`, `board.diff`, `board.freeze`, `board.resolve.step`, `clar.new`, `clar.answer`, `announce.new`, `contest.state`, `review.ready`, `sys.status`.
- **Authorisation per topic:** `sub:{id}` owner or admin · `contest:{id}:*` registered or public board · `admin:*` admin · `sys` anyone.
- **Resume:** replay from `evt:{topic}` after `Last-Event-ID`; if the ID is older than the buffer, send `board.snapshot` / full state instead.
- **Heartbeat:** comment every 15 s; `retry: 3000`.
- **Fan-out:** every API instance subscribes to `rt:*` it has clients for; publishing is decoupled from delivery.
  - *As built (Q-03):* the `rt:{topic}` message is `{"id": "<evt stream id>", "envelope": {topic, type, ts, data}}`, so a subscriber can send the SSE `id:` without reading the stream. `submission.verdict` data is `SubmissionVerdictData` (contracts).
  - *As built (Q-05):* `GET /sse?ticket=&topics=a,b` redeems the ticket (single use) and refuses topics it was not issued for (401). The stream starts with `retry: 3000`, then `: ping` every 15 s. **Resume:** `Last-Event-ID` (header) replays `evt:{topic}` after that id; the hub subscribes to `rt:` first, then reads the replay, then flushes live events, and drops any id it already sent, so nothing is lost or doubled. Ids are compared as stream ids across all topics of a connection (one `Last-Event-ID` covers them; fine for the usual one-topic-per-submission case). A client with **no** `Last-Event-ID` still catches up on `sub:` topics from the buffer. If the buffer is gone (5 min idle) or starts after the client's id, a finished submission is sent as a **snapshot** `submission.verdict` without an `id:` so it cannot move the client's cursor. At most 20 topics per connection and 5 connections per user (the oldest is closed).
  - *Progress bridge:* workers can only publish to `progress:{id}` (ADR-009), so one API instance at a time (a lease on `lock:bridge`, 5 s, renewed every third; released on shutdown) subscribes `progress:*` and copies each message into `evt:sub:{id}` + `rt:sub:{id}` as `submission.progress`. A single writer keeps event ids in the order the worker published; if it dies another instance takes over within one lease (progress in the gap is lost, the verdict is not).
  - *Queue events:* `submission.queue` `{submissionId, lane, position, etaSeconds, capped}` is **live only** (no `id:`, never replayed): every 2 s each instance checks the queued submissions its clients watch and sends when the numbers changed, and once with position 0 when a judge takes the job. A reconnecting client reads `GET /api/submissions/{id}/position`.
  - *ETA:* position × `ewma:svc:{lane}` ÷ live judges (`hb:*`), as in FR-QUEUE-08. The bridge writes the EWMA (α = 0.2) from `claimed` → `done` progress timestamps; a cold start assumes 3 s.
  - *Shutdown:* the hub closes its streams in `onModuleDestroy` (before the HTTP server closes): an event stream never ends by itself and would otherwise stall a graceful shutdown.
  - *Browser client (UI-02):* `EventSource` reconnects by itself but would reuse the URL, and a ticket is single use, so the client (`apps/web/lib/realtime.ts`) closes the source on any error, fetches a **new ticket**, and reopens with the last event id as `lastEventId`, with back-off 1 s to 15 s plus jitter. A run's verdict is watched on `sub:{runId}` (the ticket check accepts the caller's own custom runs as well as submissions). The access token lives in memory only; the httpOnly refresh cookie renews it (`apps/web/lib/api.ts`), and a refused refresh marks the visitor a guest for 30 s instead of retrying on every request.
  - *Journey (UI-03, US-3.3):* progress events live only minutes in `evt:sub:{id}`, so when the verdict is stored `ResultsProcessor` reads that buffer, takes the first time of each phase (`claimed`, `compiling`, `running`, `done`) **for that run version**, and keeps `{steps:[{phase, at}]}` in `judge_runs.journey` in the same transaction. Missing events (bridge off, Redis down) give a shorter or empty list, never a failure. The detail endpoint returns them as ISO `journey.steps`; the page builds "claimed by judge-2 · compiled in 1.6 s · tests · verdict published" from them and says so when nothing was recorded. Admins also get `runs` (every judging run).
- **Backpressure:** per-connection write buffer cap 256 KB; slow clients are disconnected and resume via replay.

---

## §11. Collaborative pad

### 11.1 Documents

- One Y.Doc per room, name `room:{roomId}`, `gc: false` (needed for snapshots), session cap 90 min, doc cap 2 MB.
- Shared types: `Y.Text('code')`, `Y.Map('meta')` (language, problemId), `Y.Array('strokes')` (whiteboard), all in the same doc.
- Interviewer notes are **not** in the doc (API resource, §3.3).

### 11.2 Hooks used (Hocuspocus v4)

| Hook | Use |
|---|---|
| `onAuthenticate` | Verify ticket with api; set `connection.readOnly` for observers; return `{user, role, expiresAt}` as context |
| `onTokenSync` / `beforeHandleMessage` | Close connection when the session expires or the room closes |
| `beforeHandleAwareness` | Overwrite each awareness state's `user` with the server-verified identity (name, colour, role) |
| `onLoadDocument` / `onStoreDocument` (Database extension) | Fetch/store `room_docs.state` (debounced ~2 s, max 10 s; flushed on unload/shutdown) |
| `onChange` | Append `room_updates` (seq, ts, user from context, update bytes); every 200 updates write a checkpoint |
| `onStateless` | Client events (e.g. language changed) → `room_events` |
| `afterUnloadDocument` | Mark doc idle; nothing kept in memory |

### 11.3 Multi-instance and routing

- Two collab instances with the Redis extension (availability + cross-instance fan-out). Every instance still processes every message for a doc it holds, so Redis doesn't reduce CPU per doc.
- Caddy routes `/collab/{roomId}` by URI hash so a room normally lives on one instance; if that instance dies, the client reconnects, is routed to the other, which loads the doc from Postgres/Redis.

### 11.4 Playback

- Data: `room_updates` (ordered by seq) + `room_checkpoints` + `room_events`.
- Seek(t): find last checkpoint with `ts ≤ t` → load state → apply updates with `seq > checkpoint.seq and ts ≤ t`.
- API streams the needed slice as a binary response; the client applies it to a fresh `Y.Doc` bound to a read-only Monaco.
- Fidelity test: apply all updates from empty → `encodeStateAsUpdate` equals stored state (semantic comparison: same `toString()` and same `meta` map).

### 11.5 Version restore (anti-operation)

1. Build doc A at snapshot seq, doc B = current.
2. Compute text diff A→B; apply, in a single transaction on the live doc, the inverse edits (delete B-only ranges, insert A-only ranges).
3. Connected clients receive normal updates and converge; nothing is replaced wholesale.
4. Record `room_events` `restore` with the target seq.

### 11.6 Run from the pad

Rooms call the same judge through the `interactive` lane (priority: contest > interactive > practice > rejudge). Results are broadcast with Hocuspocus stateless messages so everyone sees the same output simultaneously; every run is a `room_event`.

---

## §12. AI subsystem

### 12.1 Provider router

- Interface: `complete({task, messages, maxTokens, temperature}) → {text, usage, model}`.
- Task → model chain (configurable in `ai.config.ts`):

| Task | Primary | Fallbacks |
|---|---|---|
| `sufficiency` | Groq llama-3.1-8b-instant | Gemini Flash |
| `hint_main` | Groq llama-3.3-70b-versatile | Groq gpt-oss-120b → Gemini Flash |
| `code_removal` | Groq llama-3.1-8b-instant | Gemini Flash |
| `review` | Groq gpt-oss-120b | llama-3.3-70b → Gemini Flash |
| `room_summary` | Gemini Flash | Groq gpt-oss-120b |
| `leak_judge` (eval only) | Gemini Flash | Groq 70b |

- Before each call: check `ai:budget:{model}:{day}` against configured daily budgets; skip to the next model if exhausted; honour `retry-after` on 429.

### 12.2 Guardrail pipeline (hints)

1. **Guards:** practice-only (no running contest includes the problem), level order, 10/hour/user, global budget.
2. **Cache:** key = sha256(problemVersion, level, normalised code, last verdict, promptVersion).
3. **Sufficiency check** (small model): is there enough context? If not, return a clarifying nudge.
4. **Main hint** (large model): system prompt with rules; problem statement summary (≤ 300 tokens, pre-computed per version), editorial key ideas (setter-provided), user code (≤ 150 lines, delimited as untrusted data), last verdict + failing test number, level-specific instruction.
5. **Code-removal pass** (small model): rewrite removing any code or pseudo-code that solves the problem.
6. **Deterministic filter:** reject if it contains fenced code, ≥ 2 consecutive code-like lines, or avoid-set terms for levels below the level where they're allowed (setter-defined per problem) → regenerate once → else return a safe generic hint.
7. **Log** everything (tokens, models, leak flag).

**Prompt-injection note:** user code and comments are untrusted input. They are wrapped in clearly delimited blocks, the system prompt says to treat them as data, and the independent code-removal pass + deterministic filter don't depend on the main model obeying.

### 12.3 Free-tier capacity (verify live limits; they change)

Groq's published free limits as of Aug–Sep 2026 are per organisation (not per key): llama-3.3-70b-versatile ≈ 30 RPM, 1,000 requests/day, 12K tokens/min, 100K tokens/day; llama-3.1-8b-instant ≈ 30 RPM, 14,400 requests/day, 500K tokens/day.

| Item | Tokens | Daily capacity on primary model |
|---|---|---|
| Hint main step (~2.5K in + 250 out) | ~2.75K | ~36 hints/day on 70b alone → fallbacks required |
| Small-model steps (~1.2K) | ~1.2K | ~400/day on 8b |
| Review (~3K) | ~3K | spread across gpt-oss-120b + fallbacks |

Design responses: model routing above; prompt compression (pre-summarised statements, code trimmed); caching; reviews generated on demand + paced background generation; per-user and global caps; the ledger enforces budgets before calling. Multiple accounts to multiply quota are **not** used (limits are per organisation and it would breach provider terms).

### 12.4 Evaluation (AI-04)

- Dataset: 60+ prompts per level across 10 problems, including adversarial ("ignore previous instructions", "write the code in comments", "complete this function", role-play), plus Ayush's 20 labelled hints.
- Leak detector: code-block/regex heuristics + tree-sitter parse attempt + LLM judge with a rubric; disagreements reviewed manually.
- Report: leak rate with/without the removal pass, false-refusal rate, mean tokens, p95 latency.

---

## §13. Plagiarism pipeline (Python, `apps/plag`)

### 13.1 Steps

1. **Fetch** final submissions per problem for a contest (only the last AC or last attempt per user) via admin API.
2. **Normalise** with tree-sitter: drop comments; rename identifiers to `v1, v2…` by first appearance (functions `f1…`, types kept); canonicalise literals (numbers → `N`, strings → `S`); drop unreachable code after `return`; remove `#include`/imports; sort independent top-level declarations.
3. **Boilerplate removal:** fingerprints that appear in > 30% of submissions for the problem, or in the setter's template/sample code, are ignored (like MOSS's base-file option).
4. **Stage A — winnowing:** hash k-grams of normalised tokens (k = 12 tokens), window w = 8 → guarantees detecting any shared run of ≥ w + k − 1 = 19 tokens. Score = max containment `|A∩B| / min(|A|,|B|)`. Candidate pairs: score ≥ 0.35.
5. **Stage B — embeddings:** UniXcoder (`microsoft/unixcoder-base`, 125M params, 768-dim) on CPU; inputs over 512 tokens are chunked and mean-pooled; cosine similarity on all pairs (n ≤ 200 per problem → trivial).
6. **Combine:** logistic regression on features (fp containment, embedding cosine, length ratio, same language) trained on the labelled set; decision threshold chosen for precision ≥ 0.9.
7. **Cluster:** graph of pairs above threshold → connected components → clusters sorted by max score.
8. **Post** results to `POST /api/admin/plag/runs/{id}`.

### 13.2 Evaluation set (PL-03)

- Positives: for each of the 20 fixture problems' reference solutions, generated variants: identifier renames, statement reordering, dead-code insertion (Mossad-style), loop-form changes (for ↔ while), helper extraction, comment/format noise; plus combinations.
- Negatives: independently written solutions to the same problem (the package's alternative solutions + Claude-written independent solutions).
- Report precision/recall/F1 for Stage A alone vs A+B at several thresholds.

---

## §14. Integrity signals (advisory)

- Client emits during contests: `paste` (chars, timestamp) when > 50 chars, `problem_open`, `focus_lost` count; server derives time-to-AC and a style-shift score (token distribution distance vs the user's past submissions).
- Stored in `editor_signals`; shown only in the review UI with the label "advisory only"; never used to change scores.
- Optional canary text (IN-02): off by default; if enabled, a hidden instruction in the statement that an LLM might follow produces a distinctive identifier; weak signal only.

---

## §15. Observability

### 15.1 Traces

Span names: `http <route>` · `queue.enqueue` · `judge.claim` · `judge.compile` · `judge.test` (attr `test.no`) · `judge.checker` · `queue.result` · `board.update` · `sse.publish` · `ai.<task>` · `collab.store` · `plag.run`. The API injects W3C `traceparent` into `JudgeJob`; the worker continues the trace, so one submission is one trace.

- *As built (O-01):* the span tree of one submission is `http POST /api/submissions` → `submissions.submit` → `queue.enqueue` → (worker, continued from the job's `traceparent`) `judge.job` → `judge.claim` (starts at the enqueue time, so it draws the wait in the queue), `judge.compile`, `judge.test` (attr `test.no`, `verdict`; each with a `judge.checker` child), `judge.publish`; and, back in the API, `queue.result` → `board.update`, `sse.publish`. The HTTP middleware makes its span active so everything started during the request is a child (before O-01 each service span was a root of its own trace). The worker's result carries no trace id, so `queue.enqueue` stores the job's traceparent at `trace:{submissionId}:{runVersion}` (1 h TTL) and `queue.result` parents itself on it; no contract change. Shipping: API and judges → OpenTelemetry Collector on the API VM (port 4318, private address for the judges; ADR-009 addendum) → Grafana Cloud OTLP. Exports every 10 s. Errors: `@sentry/node` in the API (5xx only, with request and trace id, request and user data stripped) and `@sentry/nextjs` in the browser (errors only, same stripping); both inert without a DSN. Logs are not shipped (JSON on the VM). Dashboards and alert rules are in `infra/grafana/` and a test checks every metric they use is emitted.

### 15.2 Metrics (Prometheus names)

| Metric | Type | Labels |
|---|---|---|
| `ca_queue_depth` | gauge | lane |
| `ca_queue_wait_seconds` | histogram | lane |
| `ca_time_to_verdict_seconds` | histogram | lane, language |
| `ca_judge_busy_ratio` | gauge | worker |
| `ca_judge_calibration_ms` | gauge | worker | *(not built: the worker has no calibration step yet)* |
| `ca_verdicts_total` | counter | verdict, language |
| `ca_dlq_total` | counter | reason | *(as built: two series, `ca_queue_dlq_total` from the worker and `ca_results_dlq_total` from the API)* |
| `ca_sse_connections` | gauge | — |
| `ca_board_update_seconds` | histogram | — |
| `ca_ai_tokens_total` | counter | model, task |
| `ca_ai_requests_total` | counter | model, task, outcome |
| `ca_collab_docs_open` / `ca_collab_edit_latency_seconds` | gauge / histogram | instance |
| `ca_http_request_seconds` | histogram | route, status |

### 15.3 SLOs and alerts

| SLO | Target | Alert |
|---|---|---|
| Time-to-verdict p95 (contest lane) | ≤ 15 s over 5 min | p95 > 10 s for 2 min (early warning) |
| Board propagation p95 | ≤ 2 s | > 5 s for 2 min |
| API availability during contests | 99.5% | 5xx rate > 2% for 2 min |
| Judge fleet | ≥ 1 healthy worker | heartbeat missing 30 s |
| DLQ | 0 | any entry |
| Pad edit propagation p95 | ≤ 200 ms | > 500 ms for 5 min |

Logs: JSON (pino / slog) with `traceId`, `requestId`, `userId` (never email or source code).

---

## §16. Security

### 16.1 Threat model (STRIDE, highest-risk items)

| Component | Threat | Control |
|---|---|---|
| Judge sandbox | **E**levation: sandbox escape | isolate (namespaces, cgroups), no network, minimal binds, empty env, compile sandboxed, judge VM holds no secrets, attack suite in CI + nightly |
| Judge host | **I**nfo disclosure via symlinks (Judge0 CVE-2024-28185/28189 class) | Host never runs file ops on box paths; safe reader with O_NOFOLLOW + fstat |
| Judge host | SSRF to internal services (CVE-2024-29021 class) | No network in box; NSG denies egress except Redis/MinIO private IPs; Redis ACL user limited to job keys |
| Redis | **T**ampering by a compromised judge | ACL (Q-04, `infra/redis/users.acl.tmpl`): `judge` can only touch `jobs:*`, `results`, `progress:*`, `hb:*`, each with only the commands it needs, and cannot add jobs to a lane; results validated by schema; verdict consumer ignores results for unknown runVersions |
| Auth | **S**poofing via stolen refresh token | Rotation + reuse detection revokes family; httpOnly Secure cookies; short access TTL |
| API | **T**ampering: CSRF | SameSite=Lax cookies + double-submit CSRF token on mutations; access token in header, not cookie |
| API | **E**levation: IDOR on submissions/notes | Resource-level authorisation checks in services; tests for every protected resource (candidate can't read notes) |
| SSE/WS | **S**poofing | Single-use 60 s tickets bound to user + scopes; topic authorisation |
| Pad | Identity spoofing via awareness | `beforeHandleAwareness` stamps server identity |
| AI | Prompt injection via user code | Delimited untrusted input, independent removal pass, deterministic filter |
| Problems | Hidden test leak | Never served to users; separate storage prefix; setter/admin role checks |
| Admin | **R**epudiation | Audit log for every admin action |
| All | **D**oS | Rate limits (submit 6/min, run 12/min, hints 10/h, tickets 30/min), request size caps, per-room run limit, SSE buffer caps |

### 16.2 OWASP Top 10:2025 mapping

| Category | Where addressed |
|---|---|
| A01 Broken Access Control (incl. SSRF) | Role + resource checks, IDOR tests, judge egress block |
| A02 Security Misconfiguration | Terraform-managed NSGs, CSP/headers via Caddy, no default creds, config validated at boot |
| A03 Software Supply Chain Failures | Lockfiles, Dependabot, CodeQL, images pinned by digest, approved dependency list |
| A04 Cryptographic Failures | TLS everywhere, token hashes (SHA-256) at rest, ES256 JWT keys |
| A05 Injection | Parameterised queries (Drizzle), Zod validation, Markdown sanitised (rehype-sanitize), no shell interpolation in worker (exec with argv) |
| A06 Insecure Design | This threat model; ADRs; attack suite |
| A07 Authentication Failures | OAuth only, PKCE, rotation, reuse detection |
| A08 Software or Data Integrity Failures | CI builds from protected main, image digests, testset hash verification |
| A09 Security Logging & Alerting Failures | Audit log, alerts in §15.3 |
| A10 Mishandling of Exceptional Conditions | RFC 7807 errors, SE + DLQ instead of silent failure, fail-closed authorisation |

### 16.3 Security headers (Caddy + Next.js)

`Content-Security-Policy` (self + Monaco CDN if used + fonts), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, mic, geolocation off), `frame-ancestors 'none'`.

---

## §17. Reliability: failure modes

| Failure | Detection | User impact | Recovery | Test |
|---|---|---|---|---|
| Worker process crash | heartbeat missing | Slight delay | Reaper re-delivers after 10 s | `tests/chaos/kill-worker.sh` |
| Judge VM lost | heartbeats missing | Less capacity | Others continue; scale script adds VM | Contest-day drill |
| Poison submission | delivery count, crash count | That submission SE | DLQ/quarantine, admin inspects | Unit + chaos |
| Redis restart | health check | Brief realtime gap | Streams persist (AOF everysec); boards rebuilt from Postgres; SSE clients resume | O-06 drill |
| Postgres down | health check | Submissions rejected (503) | Restart; restore from backup if corrupt | Restore test weekly |
| API crash | uptime check | Requests fail briefly | Docker restart policy; SSE clients reconnect | Kill api container |
| Collab instance crash | WS close | Reconnect in < 3 s | Other instance loads doc | CP-08 chaos |
| LLM provider down / 429 | error rate | Hints slower | Fallback chain | Fake provider tests |
| Bad test data | clarifications | Wrong verdicts | Fix package → rejudge problem | Rejudge integration test |
| Clock skew between VMs | NTP metric | Contest timing off | Server time is the single source (API clock); chrony on all VMs | — |

Redis persistence: AOF `everysec` + RDB snapshots; losing ≤ 1 s of stream data is recoverable because submissions are in Postgres and a `reconcile` job re-enqueues `queued/judging` submissions older than 2 minutes with no live job.

---

## §18. Deployment and operations

### 18.1 Environments and config

| Env var (examples, full list in `.env.example`) | Used by |
|---|---|
| `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET_TESTS` | api |
| `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (ES256), `OAUTH_GOOGLE_*`, `OAUTH_GITHUB_*` | api |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `AI_DAILY_BUDGETS` | api |
| `COLLAB_SERVICE_TOKEN`, `API_INTERNAL_URL` | collab, api |
| `REDIS_JUDGE_URL` (ACL user), `S3_READONLY_*`, `WORKER_ID`, `BOXES` | worker |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN` | all |

Config is validated with Zod (TS) / struct validation (Go) at boot; the process exits on invalid config.

### 18.2 CI/CD

PR: lint → typecheck → unit → integration (Testcontainers) → contracts freshness → e2e (Playwright, changed web) → attack suite (worker changes). Main: build images → push GHCR (tag = git SHA, deploy by digest) → SSH deploy → health check → auto-rollback to previous digest on failure. Vercel deploys web on push.

*As built (D-02):* `ci.yml` also has an `infra` job (Terraform fmt/validate and the offline firewall tests, the shell tests for the deploy/provision/pipeline scripts with fake docker and ssh, the Compose/Caddy/storage-key structure tests, an image build and boot check, actionlint). `deploy.yml` runs after CI passes on `main` and only when the repository variable `DEPLOY_ENABLED` is `true`: image → GHCR by digest → `deploy.sh` on the API VM (pull, migrate with the new image, switch, health check on `/api/health/ready`, rollback to the previous digest) → worker binary to each judge through the API VM as jump host (each judge restores its previous binary if the new worker does not log `worker started`; the first failure stops the rollout). The pipeline uses one SSH key (`DEPLOY_SSH_KEY`, admin on both servers) with pinned host keys; the registry login is the workflow's own short-lived token and is removed from the server after each deploy. A manual `workflow_dispatch` with `rollback_drill` makes the new release look unhealthy to prove the rollback. `nightly-attack.yml` runs the attack suite on a judge at 03:00 IST. See `infra/prod/README.md` and `docs/runbooks/deploy.md`.

### 18.3 Backups and DR

- Nightly `pg_dump` → Azure Blob (7 daily, 4 weekly). Manual backup before and after each contest.
- *As built (D-03):* `infra/prod/backup.sh` (systemd timer, 03:00 IST) dumps in custom format, checks the dump reads back, uploads with a container-scoped SAS (no delete, token on stdin only), then verifies size and SHA-256; retention is Azure's lifecycle rule (30 daily dumps instead of 7 daily + 4 weekly: the SAS cannot delete, and the cost is cents). `scripts/restore-test.sh` restores the newest dump into a throwaway Postgres and requires every table plus rows in `users`; a weekly timer runs it. Scope is Postgres only (object-store packages re-import from `problems*/`). Procedure: `docs/runbooks/backup-restore.md`.
- RPO 24 h (contest days: minutes, via manual backups); RTO 1 h (restore script tested weekly).

### 18.4 Cost model (Azure for Students, $100)

Steady state: 1 API VM + 1 judge VM (B-series). Contest/load-test days: +2 judge VMs for a few hours, on a non-burstable size (`Standard_D2s_v5`: burstable CPUs are throttled under sustained judging). Budget alerts at 25/50/75%. Check the Azure pricing calculator before choosing sizes. The infrastructure is `infra/terraform/` (see its README and ADR-013's addendum).

---

## §19. Scaling path (documented, not built — ADR-014)

| Pressure | Next step |
|---|---|
| Judge throughput | More judge VMs via Terraform → Kubernetes + KEDA scaling on stream length |
| Stronger isolation | gVisor (`runsc`) around the worker |
| API instances | Stateless already; add instances behind Caddy; SSE fan-out via Redis already in place |
| Postgres | Read replica for boards/profiles; partition `submissions` by month |
| Collab CPU | Room-hash routing already; y-redis for very large scale (note AGPL licence) |
| AI | Paid tier or self-hosted small model for sufficiency/removal steps |

---

## §20. Interview question → section map

| Question (research §13, §6.13) | Section |
|---|---|
| Running untrusted code safely; Judge0 escape | §8, §16.1 |
| 500 submissions in 2 minutes | §2.3, §5.2 |
| Worker dies mid-judge | §5.3 |
| Leaderboard, ties, freeze, Redis restart | §9, §5.5–5.6, §17 |
| SSE vs WebSockets | §10, §11 |
| Fair time limits | §8.2, §8.7, PRD §9.3 |
| Plagiarism: how it works, how to beat it, how measured | §13 |
| AI Coach: no spoilers, how you know | §12.2, §12.4 |
| OT vs CRDT, cursors, scaling collab, crash recovery, playback, restore | §11 |

> **As built (AI-01):** `apps/api/src/modules/ai/` (the existing module, not `src/ai/`). `AiRouter.complete({task, feature, messages, maxTokens})` walks the task's chain from `ai.config.ts`; per model it skips cool-downs (`ai:cool:{model}`, set when a provider asks us to wait longer than `AI_RETRY_MAX_WAIT_MS`), reserves tokens and one request against `ai:budget:{provider:model}:{utc-day}:{tokens|requests}` in one Lua step (a model with no budget entry is never called), calls the provider (Groq over its OpenAI-compatible endpoint, Gemini `generateContent`; plain `fetch`, keys in headers), retries 429/5xx/network errors up to `AI_MAX_RETRIES` honouring `retry-after`, then falls back; the reservation is replaced by the provider's reported usage, or given back when the call failed. Limits: all calls together `AI_GLOBAL_PER_MIN` (25, under Groq's 30 RPM, 503 `ai-busy`), per user per feature `guardUser(feature, userId, perHour)` (429 + `Retry-After`). Accounting per feature/model/day in `ai:usage:{day}`; every call logs model, task, feature, tokens, latency, fallbacks (FR-AI-10) and counts `ca_ai_calls_total` / `ca_ai_tokens_total` / `ca_ai_latency_ms`. `AiCache` (key = SHA-256 of problem version, level, normalised code, verdict, prompt version), versioned prompts in `prompts/` (`definePrompt`, `untrusted()` delimiter helper), and `AiQueue` (`ai:jobs`, group `ai`, one job at a time with `paceMs`, takeover after 2 min, 3 deliveries then `ai:jobs:dlq`). Config only: `GROQ_API_KEY`, `GEMINI_API_KEY`, `AI_ROUTES`, `AI_BUDGETS` (JSON), `AI_GLOBAL_PER_MIN`, `AI_USER_PER_HOUR`, `AI_MAX_RETRIES`, `AI_RETRY_MAX_WAIT_MS`, `AI_WORKER`. Default budgets are conservative (70b 90K tokens/day) and must be checked against the providers' live limits.

> **As built (AI-02):** `apps/api/src/modules/ai/hints/`. Endpoints: `GET /api/hints?problemSlug=` (ladder state: per level locked/available/delivered, cost %, text, rating; `enabled` + reason; practice points and points after the penalty; requests left this hour), `POST /api/hints {problemSlug, level, submissionId?}` (a hint, or `{nudge}` when there is nothing to go on: nothing stored or charged), `POST /api/hints/{id}/rating {helpful}`. Guard order: problem exists → a running contest that includes it → 422 `hints-disabled-in-contest` for everyone (checked before practice visibility, which would answer 404) → visible in practice → a level already delivered is returned from `hint_requests` (free) → `hint-level-locked` → hint cache (free, still logged for the user with `models:["cache"]`) → one generation at a time per user/problem/level → 10/hour (`guardUser`) → pipeline. Pipeline: sufficiency (only when there is code; JSON, unreadable = sufficient) → main hint → code removal (always) → deterministic filter (`hint-filter.ts`: fenced code, ≥ 2 consecutive code-like lines, inline code spans over 40 characters or with `;`/`{`, avoid-set terms) → on failure one stricter regeneration → else the static generic hint for the level (`blocked_reason = 'filter'`, no penalty). `leak_flag` = the first main answer already failed the filter (the number AI-04 reports before/after the removal pass). Grounding without a summary model call: statement clipped to 1,500 characters, editorial to 1,800, code to 150 lines, all inside delimited data blocks. The avoid-set is stored per problem version (`problem_versions.avoid_set`, migration 0007): `avoidSet[n]` binds hints of level ≤ n; setters write it in `problem.yaml` (no UI yet). The penalty (10/25/50 %, highest real level, not additive) is reported by the state endpoint; there is no per-user points ledger yet, so nothing is deducted from a stored score. Metrics `ca_hints_total{level,outcome}`, span `hints.request`, product events `hint_requested` / `hint_rated`.

> **As built (AI egress relay):** Groq (`403 Forbidden`) and Google AI Studio (`User location is not supported`) refuse the API VM (Azure East Asia, Hong Kong). The API therefore sends model calls to a relay on the Vercel web app, `apps/web/app/relay/ai/[provider]/[...path]` (`lib/ai-relay.ts`), which forwards them from the Vercel function region. It is a narrow forwarder: POST only; two fixed upstream hosts; exactly one allowed path shape each (`openai/v1/chat/completions`, `v1beta/models/<model>:generateContent`); shared secret `x-relay-secret` (constant-time check, 503 when `AI_RELAY_SECRET` is unset or shorter than 24 characters, so a missing variable is never "open"); body ≤ 256 KB; redirects refused; bodies are never logged or stored (they hold student code); the provider key is passed through from the API (`Authorization` / `x-goog-api-key`) and never kept on Vercel. The API uses it when `AI_RELAY_URL` and `AI_RELAY_SECRET` are both set (`providersFromConfig`); `GET /relay/health` reports the function region. Set up with `infra/prod/set-ai-relay.sh` plus the secret as `AI_RELAY_SECRET` in the Vercel project (it is in `turbo.json`'s build env). Privacy: student code sent for a hint now reaches the AI provider via Vercel; update `/privacy` when the Coach tab (UI-06) goes live.

> **As built (models, October 2026):** the SD table's models no longer exist for this account: Groq answers `model_not_found` for `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, the Llama 4 and Kimi models and `groq/compound`; Gemini 2.5 and 2.0 are closed to new keys. Verified live through the relay: Groq `openai/gpt-oss-120b`, `openai/gpt-oss-20b` (and `-safeguard-20b`), Gemini `gemini-3.5-flash`, `gemini-flash-lite-latest` (`gemini-3.8-flash` exists but was overloaded). New default chains in `ai.config.ts`: sufficiency and code removal gpt-oss-20b → flash-lite; hint main gpt-oss-120b → gpt-oss-20b → gemini-3.5-flash; review gpt-oss-120b → gemini-3.5-flash → gpt-oss-20b; room summary and leak judge gemini-3.5-flash → gpt-oss-120b. gpt-oss and Gemini 3 think before answering and the thinking counts against the output limit, so providers add 600 tokens of headroom and send `reasoning_effort: low` to gpt-oss; an empty answer is an error (falls back). Model names change: override with `AI_ROUTES` without a deploy; the budgets (`AI_BUDGETS`) are conservative guesses to check against each console.

> **As built (AI-03):** `apps/api/src/modules/ai/reviews/`. `reviews` rows (migration 0008 adds `helpful`) are created for the **final** submission of each (participant, problem): the latest judged, not disqualified submission in the contest (`ensureRows`, idempotent, unique on `submission_id`). Only a **finalised** contest has reviews (403 otherwise). `GET /api/reviews?contest=` lists mine with status `queued` / `generating` (a generation lock is held) / `ready` / `failed`; `GET /api/reviews/by-submission/{id}` (owner and final submission only, else 404) writes the review **on demand** when it is not ready (one `review` call; the answer must contain the four `###` sections in order, one stricter retry, then `failed`, and opening again retries); a busy AI (budget used up, rate limit) leaves it `queued`, not failed; `POST /api/reviews/{id}/rating`. Opening is limited to 30 per user per hour. **Paced background writer** (`ReviewsService.sweep`, every `AI_REVIEW_EVERY_MS` = 60 s, off in tests, one instance per interval through a Redis lock): finds contests finalised in the last 14 days, creates missing rows, writes up to `AI_REVIEW_PER_TICK` = 3 oldest pending reviews, and **stops while the first review model's daily budget is more than 70 % used** so hints keep their share; it stops on the first "busy". It uses the `reviews` table as its queue (durable across restarts) rather than the `ai:jobs` stream. Prompt `review@1` (statement 1,500 characters, editorial 1,800, code 150 lines in delimited data blocks, verdict and failing test, time limit; ≤ 250 words). Capacity: about 3K tokens a review, so roughly 50 a day on the primary model's conservative budget; the rest wait (`queued`) or fall back down the chain. Metric `ca_reviews_total{outcome,trigger}`, span `reviews.generate`, product events `review_opened` / `review_rated`.

> **As built (editorial and review notification):** the editorial rule lives in `ProblemsService.editorial` / `detail` (`editorialPublished`: a `finalized` contest includes the problem; staff bypass). `GET /api/me/home` carries `reviews {contestSlug, contestTitle, ready, total}` for the latest finalised contest where I have review rows (the background writer creates the rows within a minute of finalising). `ReviewItem.hasEditorial` lets the results page link the editorial.

> **As built (AI-04, leak eval; deviation from §12.4):** `apps/api/eval/hints/` (`pnpm eval:hints build | run | sheet | report`). **No tree-sitter**: it is not an approved API dependency and `apps/plag` has no code yet, so the "parse attempt" is replaced by two detectors that need none: D1 structure heuristics (fenced code, code-like lines, statement-like inline spans, shared with the shipping filter through `isStatementSpan`) and D2 overlap (identifier-, number- and string-normalised 4-grams of the hint's code-like content against the problem's accepted solutions, minus 4-grams that occur in the solutions of three or more problems, threshold 50 % with at least 6 grams), plus D3 an LLM judge (`leak_judge` task, JSON rubric `code-leak` / `spoiler` / `ok`). Leak = D1 ∪ D2 ∪ D3(code-leak); over-reveal = the judge's "spoiler"; avoid-set violations are counted apart. `HintsService` and the eval share `runHintPipeline` (`hint-pipeline.ts`), which keeps every stage: A the main model's raw answer (no removal pass), B after the removal pass, C what ships. Dataset (`dataset.json`, 66 items from the public `problems/`): 10 problems × 3 levels normal + the same with one of 10 injections in the code's comments (the endpoint takes no free text, so the code is the only way in) + 6 "nothing to go on" items. Run on the production VM only (the keys), dataset on stdin, JSONL on stdout, `QUEUE_KEY_PREFIX` apart, resumable. Results and the reading notes are in METRICS.md; Ayush's 20-hint label sheet is `labels.json`.
>
> **Hint pipeline changes found by the eval (v2):** the main prompt is told the avoid-set terms for the level and has stricter level scopes and "no formulas or expressions"; the shipping filter rejects statement-like inline spans (`pref[i]=pref[i-1]+a[i]`, `a - b`, `dp[i-1]`); "not enough context" is always one fixed sentence (a model-written nudge skipped the removal pass and gave algorithms away); the removal pass's `<hint>` wrapper is stripped; sufficiency (v2) treats any real attempt as sufficient and code comments as data.

> **As built (PL-01):** `apps/plag/src/plag/` (Python 3.11+, `uv`, tree-sitter 0.25 with the C, C++, Python, Java and JavaScript grammars; ruff, strict mypy and pytest run in the `python` CI job). `languages.py` maps the platform's language ids (`cpp17`, `cpp20`, `c`, `python3`, `java21`, `node`) to a grammar and to the node types that matter; `normalise.py` turns a program into a token stream: comments, `#include`/imports, `using namespace`, package lines and Python docstrings dropped; code after `return`/`break`/`continue`/`throw` in the same block dropped; identifiers renamed `v1, v2…` and function names `f1, f2…` by first appearance (standard-library names such as `printf`, `sort`, `cin`, `print`, `System`, `console` and `main` are kept, because renaming them only blurs the signal); numbers `N`, strings and characters `S`; the `std::` qualifier ignored; independent top-level definitions (C/C++ functions, structs, declarations; Python `def`/`class`; Java classes and class members; JavaScript functions, classes and class members) are numbered **on their own** and sorted into the slots they occupy, so moving a function changes no token, while the statements of a Python script keep their order and one shared numbering. Each token keeps its source line (for the review page's evidence). `winnow.py` is the Schleimer-Wilkerson-Aiken algorithm with k = 12 and w = 8 over a rolling polynomial hash (stable across processes), rightmost minimum on ties; the guarantee (any shared run of w + k − 1 = 19 tokens shares a fingerprint) is a randomised test. `stage_a.py`: fingerprints per submission, hashes in more than 30 % of a problem's submissions (when there are at least 5) and the setter's template fingerprints removed, an inverted index to find pairs, score = shared fingerprints / the smaller set, candidates at ≥ 0.35; same person and different language families are never paired (C, C++ are one family), an unsupported language is reported in `skipped`, not an error. No API, database or queue code yet: PL-02 adds embeddings and the posting of results, PL-04 the review screens. Measured: the 20 problems' main solutions plus one disguised copy: only the copy and its original pair (containment 1.00, 80 shared fingerprints of 84/80), 13 ms for the 21.

> **As built (PL-02):** `apps/plag/src/plag/` gains `embed.py` (UniXcoder `microsoft/unixcoder-base` on CPU: encoder-only mode, mean over tokens, files over 512 tokens split into chunks that are averaged by length, L2-normalised, loaded only on first use; a deterministic `TokenBagEmbedder` stands in for tests and dry runs), `combine.py` (logistic model over `fp`, `emb`, `len_ratio`, `same_language`, `fit()` with sklearn, `choose_threshold()` for a precision target, JSON weights; **until PL-03 fits one, `DEFAULT` is hand-set**: shared fingerprints are strong alone, a cosine alone never reaches the 0.5 cluster threshold), `cluster.py` (connected components over pairs at or above the threshold, strongest first), `pipeline.py` (`run_problem`: Stage A candidates, embeddings of the normalised text, cosine for every candidate, a **nearest-neighbour sweep** that adds each submission's 3 nearest by cosine when at least 0.95 even if Stage A found nothing, combined score, pairs at or above 0.30 reported, clusters at the combiner's threshold), `payload.py` (`to_payload` in the shape of the `plag_pairs` and `plag_clusters` columns; `post_results` to `POST /api/admin/plag/runs/{id}/results` with the service token as a bearer, retrying network errors and 5xx, never a 4xx) and `cli.py` (`python -m plag run --input submissions.json [--out] [--post API_URL --token-env NAME]`, token from the environment only). **Measured with the real model on the 20 problems' solutions** (40 files embedded in 15 s on CPU): a disguised copy scores 0.92 on average (0.71 worst) against 0.60 on average (0.91 at most) for different problems on the raw source, and 0.92 (0.76) against 0.56 (0.918) on the normalised text, which is what is embedded; the same problem's wrong-answer variant against the accepted one scores 0.92 (0.78) normalised. **So the embedding alone separates poorly** (the ranges overlap): it is a feature of the combined score, not a verdict, and PL-03 measures Stage A alone against A + B on labelled data. The API side (fetching final submissions, receiving the results, service-token authentication, starting the job) is not built: follow-up PL-05.

> **As built (PL-03):** `apps/plag/src/plag/evalset/` (`python -m plag.evalset filter | build | report`). `transforms.py` makes the disguises with tree-sitter edits (rename every user identifier, swap independent neighbours that do not read input, scatter dead code, `for` → `while`, move `main`'s body into a helper, noise), `validate.py` compiles (g++) and runs a candidate independent solution on all the problem's tests (token comparison; a testlib checker only requires a clean run), `build.py` makes the pools and labels (copy-copy and original-copy are positive, anything with an independent solution negative) and computes each pair's features (language-wide boilerplate removed; **no per-problem boilerplate rule here**, see METRICS), `metrics.py` cross-validates leaving one problem out (the model and every threshold for precision ≥ 0.9 are fitted on the other problems) and reports Stage A at 0.35, Stage A, Stage B and A + B, average precision, recall per disguise and the hard negatives, and `report.py` writes the block in METRICS.md. The independent solutions come from `apps/api/eval/plag/generate.ts` (four writing styles, run on the production VM through the AI layer). Results: A + B F1 90.4 % against Stage A's 81.4 % (92.1 % recall at 88.7 % precision against 74.8 % at 89.4 %). The combiner fitted on all 3,476 pairs is now `DEFAULT` (`fitted_combiner.json`: weights fp 3.41, emb 18.52, length ratio −3.83, same language 0.03, bias −13.22, cluster threshold 0.537); the hand-set weights remain as `HAND_SET`.

> **As built (PL-05):** the API side of the plagiarism job, `apps/api/src/modules/plag/`. **Runs:** `POST /api/admin/plag/runs {contestId, params?}` (admin; only for an ended or finalised contest, one queued or running run per contest, audit `plag.run.start`), `GET /api/admin/plag/runs[?contestId=]`, `GET /api/admin/plag/runs/{id}` (status, params, metrics, clusters strongest first). **The job** is pull-based, so the API starts no process: `POST /api/admin/plag/runs/claim` takes the oldest `queued` run (or a `running` one older than `PLAG_STALE_MINUTES`, whose job died) with `FOR UPDATE SKIP LOCKED` (two jobs never share a run), marks it running and returns the **final submission per person per contest problem** (the last accepted one, else the last judged attempt, disqualified ones excluded; persons as opaque user ids, never handles or e-mails; 204 when there is nothing); `POST .../{id}/results` stores pairs (ordered `sub_a < sub_b`) and clusters in one transaction after checking that every problem and submission belongs to the run's contest (a bad payload writes nothing and leaves the run running), then marks it `done` once; `POST .../{id}/fail {error}` marks it `failed`. **Service-token authentication** (new): `ServiceTokenGuard` compares `X-Service-Token` with `PLAG_SERVICE_TOKEN` in constant time (a different header from `Authorization`, which belongs to user sessions and whose guard would reject the token); the job routes are `@Public()` and `@SkipCsrf()`; with no token configured they answer 403 "not configured", so a missing variable is never "open". Metric `ca_plag_runs_total{outcome}`, spans `plag.create`, `plag.claim`, `plag.results`. **The job** (`apps/plag`, `plag.runner`): `python -m plag serve --api URL` polls every 15 s, scores each problem with `run_problem`, posts the payload (or `/fail`), takes the admin's `params` only for a short checked list (`stage_a_threshold`, `sweep_cosine`, `report_threshold`, `neighbours`, `embed_on`). **Deployment:** `apps/plag/Dockerfile` (CPU torch, model baked in, non-root) and a Compose service `plag` behind its own profile (read-only, 1 CPU, 2 GB, only the service token, no data access); **off by default and not part of the deploy pipeline yet**; the steps are in `docs/runbooks/plagiarism.md`. Not built here: the cluster-detail and decision endpoints and the review screen (PL-04).

> **As built (PL-04):** the review screen and its two endpoints. `GET /api/admin/plag/clusters/{id}` (admin) returns the members (handle, language, verdict, time and the **original source**), only the pairs inside the cluster (strongest first), the advisory editor signals of those people on that problem (empty until IN-01 records any), and the decisions so far; `POST /api/admin/plag/clusters/{id}/decisions {decision: clear|confirm|discuss, note}` stores a `review_decisions` row (`dismissed`/`confirmed`/`needs_more`; the note is required, 3 to 2000 characters) with the reviewer and an `audit_log` entry `plag.decision`, in one transaction, and changes nothing else (no score, no account, no flag: FR-PLAG-05). A cluster's status is its latest decision (`open` until one exists); the run's cluster list carries it. Metric `ca_plag_decisions_total{decision}`, spans `plag.cluster` and `plag.decide`. **Screens:** `/admin/integrity` (past runs, and a contest picker that starts a check for a contest that has ended) and `/admin/integrity/[runId]` (S17): clusters list, members, pair table with shared-code / structure / combined percentages, a read-only Monaco diff of two chosen submissions (our theme, diff tints from the verdict tokens at low strength so text keeps its contrast), the signals card labelled "Advisory only", the decision bar and the audit trail. Wording is "similar submissions", never an accusation. **Not built (follow-up PL-07):** the *normalised* view and the matched regions of FR-PLAG-04: the job does not store normalised text or match ranges yet (the payload and `plag_clusters` would need them), so the screen shows the code as submitted and says so.

> **As built (IN-01):** `modules/signals`. **Client** (`lib/signals.ts`, used by the contest workspace only, for a signed-in user): reports `problem_open`, `paste` (the size, only above 50 characters, never the text: Monaco's `onDidPaste` range length), and `blur` / `tab_hidden` / `focus`; a loss of focus within 2 s of the last one is the same departure; batches of at most 50 every 10 s and on leaving the window; best effort, a failed batch is dropped and never shown. **`POST /api/signals {contest, problem, events[]}`** (signed in, 30/min, 204): stores only for a registered contestant while the contest runs (staff, strangers, over/not started: silently nothing; unknown contest or problem: 404), drops pastes of 50 characters or fewer, keeps only the first `problem_open` per problem, moves times outside [now - 15 min, now] to now, caps 3000 rows per person and contest; metric `ca_signals_total{kind}`, span `signals.record`. Migration 0009 adds `problem_open` to `signal_kind`. **Derived at review time** (nothing is stored): time to AC = minutes from the first `problem_open` to the first accepted submission; **style shift** = Jensen-Shannon divergence (bits, 0 to 1) between the feature distribution of the person's final submission (keywords, punctuation, identifier length classes with `_`/camelCase, literals, indentation, line-length classes, comment markers; names are not kept) and the pooled distribution of their up to 20 earlier programs in the same language; null with fewer than 3 earlier programs of at least 120 characters. The review screen shows one row per member, "not recorded" when nothing came from the browser, with the sentence that these are never evidence alone. **Retention (FR-SIG-02):** `SignalsService.purge` deletes the signals of contests that ended more than 30 days ago, at start and every 6 hours (idempotent, so every instance may run it; off in tests). **Never alters a score:** only `modules/plag`, `modules/signals` and the schema reference `editorSignals` (a test scans the sources for it). Disclosure: the privacy page lists what is recorded during a contest and when it is deleted. Not built: a "problem_open" for people who never open the editor tab again after a reload is simply the first one kept; no signals for the interview pad.

> **As built (IN-02, ADR-016):** `contest_problems.canary_on` (default false) and `canary_token` (migration 0010). `POST /api/admin/contests/{id}/problems/{label}/canary {enabled}` (admin, audited `contest.canary-on` / `-off`) creates the token once (`ans_` + 8 random characters) and keeps it; the contest problem endpoint returns `canaryText` only while it is on, and the statement pane draws it as an `sr-only` paragraph with `aria-hidden` (in the copied text, not seen, not read); replacing the contest's problem list keeps a surviving problem's canary. `GET /api/admin/plag/clusters/{id}` marks each member `canary: true | false | null` (null = no token for the problem): a case-insensitive whole-identifier match of the token in the member's code. The review shows it as "present (weak signal)" / "absent" / "not set for this problem" among the advisory signals; the ops console has a per-problem switch with the caveat. Never used for a score. The trade-offs (screen readers, copy/paste, easy to defeat, one name per problem) are in ADR-016, which is **Proposed**: it awaits Ayush's decision.

> **As built (CP-01):** `apps/collab/src` (`server.ts`, `auth.ts`, `identity.ts`, `session.ts`, `main.ts`) and `modules/collab` in the API. **Authentication:** the browser connects to `room:{uuid}` with a realtime ticket as its token; `onAuthenticate` posts it to **`POST /api/internal/rooms/{roomId}/authorize`** (header `X-Service-Token` = `COLLAB_SERVICE_TOKEN`, a secret of its own, not the plag job's; 403 "not configured" when unset), which redeems the ticket (single use), checks it was issued for that room, that the room is `open`, that the session is under 90 minutes old (`rooms.created_at` + 90 min, FR-PAD-13; the 30/45/60/90 duration stays a UI timer) and that the person is a member, and answers `CollabIdentity {userId, name (handle), role, readOnly, expiresAt, colorIndex}` (contract `collab.ts`, parsed on both sides). The colour index is the person's place in the room's member list (oldest first) modulo the 8 palette entries. Any refusal, 5xx, timeout, nonsense answer or a document name that is not `room:{uuid}` is a denial; an API that is down never lets anyone in. **Observers** get `connectionConfig.readOnly`, so their updates are ignored and they still receive everyone's. **Sessions:** `beforeHandleMessage` closes the connection (reason `session-ended`) and drops the message once `now > expiresAt`; a sweep (30 s) closes idle ones. **Awareness (FR-PAD-04):** `beforeHandleAwareness` replaces `user` in every state a connection sends with `{name, role, colorIndex}` from the verified identity (cursor and selection stay), drops states over 4 KB, and **a connection can only write client ids it owns** (first writer owns an id until it disconnects), so nobody can rename or remove another person's presence. **Closing a room:** `closeRoom(roomId)` and `POST /internal/rooms/{roomId}/close` on the collab server (same token) end every session of that room (the room-close API in CP-02 calls it). Documents use `gc: false` already (SD-§11.1). Metrics `ca_collab_connections_total{outcome}`, `ca_collab_connections_open`, `ca_collab_awareness_total{result}`, `ca_collab_sessions_closed_total{reason}` and spans `collab.authenticate` / API `collab.authorize` (`ca_collab_authorize_total{outcome}`); the collab process has no OTel SDK yet, so its instruments are no-ops until the deployment card. **Deviations:** `onStateless` is not used (Hocuspocus does not relay client stateless messages, so there is nothing to forbid yet; CP-02/04 define events); `onTokenSync` is not used (the expiry is checked on every message and by the sweep, which does not depend on the client re-sending a token). **Not built here:** persistence and Redis (CP-03), update log (CP-06), the 2 MB cap (CP-07), room CRUD, invites and the API call to close a room (CP-02). **Not deployed:** no Compose service, no Caddy route yet (it still answers 503), `COLLAB_SERVICE_TOKEN` is not in `init-env.sh`.

> **As built (CP-02):** rooms and the pad screen. **API** (`modules/rooms`, contract `rooms.ts`): `POST /api/rooms {problemSlug?, language, durationMin ∈ 30|45|60|90}` (signed in with a handle; becomes the interviewer; a plain user may only use a public problem, staff any; at most 5 open rooms per person; audited), `GET /api/rooms` (mine, newest first), `GET /api/rooms/{id}` (members only, anyone else gets 404; members listed by handle, never e-mail), `POST /api/rooms/{id}/invites {role: candidate|observer}` (interviewer only; a random 192-bit token, **stored only as a SHA-256 hash**, valid until the room closes or its 90 minutes end; the link is `WEB_URL/r/join?token=`), `POST /api/rooms/join {token}` (membership with the invited role; someone already in keeps their role, so opening your own candidate link does not demote you; at most 8 members; unknown, revoked, expired, closed-room links are all the same 404), `POST /api/rooms/{id}/close` (interviewer; status `closed`, every invite revoked, `COLLAB_URL` told to drop the sessions through `POST /internal/rooms/{id}/close`, best effort: the room is closed in the database whatever the collab server answers; repeatable). A room older than 90 minutes reads as `closed` even if nobody pressed End. Metric `ca_rooms_events_total{kind}`, spans `rooms.*`. **Web:** `/interview` (new room form: problem or blank, language, duration; my rooms with role and state), `/r/{roomId}` (S13) and `/r/join?token=`. The room page connects a Hocuspocus provider to `NEXT_PUBLIC_COLLAB_URL/{roomId}` (the room id is in the path so the edge can route by URI hash) with a **fresh single-use ticket for every (re)connect**; Monaco is bound to `Y.Text('code')` and the awareness by y-monaco; the language is `Y.Map('meta').language`, so a change reaches everyone (disabled for observers); remote cursors take their colour from the `--presence-0..7` tokens by the index the server assigned and their name from the verified identity (UI_UX §5.1); the person list shows name and role in words, "you" from what the API said about this member (the server does not echo one's own awareness back); an observer sees "You're observing: read-only" and a read-only editor; timer from the room's creation against the chosen duration ("Planned time is up" is a note, the hard end is `expiresAt`); invite buttons copy a candidate or observer link (shown in a box when the clipboard is refused); End room asks first; closed, expired, denied and not-a-member states have their own words. **y-monaco and Monaco:** y-monaco imports its own `monaco-editor`, which would bundle a second copy; `next.config.ts` aliases that import (`turbopack.resolveAlias`) to `lib/monaco-global.ts`, which re-exports `Range`, `Selection` and `SelectionDirection` from the Monaco that `@monaco-editor/react` already loaded, so y-monaco is imported only after an editor has mounted. **Not built here:** Run/Submit and the shared output panel (CP-04), Notes and Whiteboard tabs (CP-05, CP-10), "typing" indicator and the phone tab layout (tabs Code / Output / Problem arrive with CP-04; today the problem sits under the editor), playback link on End (CP-06), offline editing (CP-09). **Not deployed:** the collab container and its edge route (CP-DEPLOY); until then `/r/{id}` shows "Joining the room…" in production.

> **As built (CP-03):** persistence and two instances. **Documents:** `DocStore` (`store.ts`) with `PgDocStore` (`pg-store.ts`): `fetch` reads `room_docs.state`; `store` upserts it and sets `rooms.doc_bytes` in one transaction, and a room that no longer exists (foreign-key violation) is logged and ignored, never a crash. Wired through `@hocuspocus/extension-database` (a document name that is not `room:{uuid}` has no state). Hocuspocus's own defaults are the card's: store 2 s after the last change, at most 10 s after the first (`debounce`/`maxDebounce`), **immediately when the last person leaves** (`unloadImmediately`), and **`destroy()` (SIGTERM in `main.ts`) flushes every pending document first**; a failed store keeps the document in memory. **Instances:** `@hocuspocus/extension-redis` (priority before Database: it takes a Redis lock around each store so two instances never store the same room at once, and a store that finds the lock held is skipped because the other instance is storing; `lockTimeout` 1.5 s so a lock left by a killed instance expires inside the library's retry window) fans updates and awareness out between instances. Every instance can serve any room: clients reconnecting after a crash hold their own copy of the document and hand it to whichever instance they reach, which is why a `SIGKILL` loses no edit even though up to 2 s of server-side state is gone. **Awareness ownership across instances (FR-PAD-04):** `AwarenessOwners` takes a claim backend; with Redis (`RedisClaims`) the first write of a client id does `SET hocuspocus:own:{doc}:{clientId} {instance}:{socket} NX PX 120000`, owned ids are cached per connection (one round trip per id), refreshed every 30 s, released on disconnect and expiring by themselves if their instance dies; an unreachable Redis refuses the claim (presence may drop, it is never taken over). **Edge:** `/collab/*` is `reverse_proxy {$COLLAB_UPSTREAMS:collab1:1234 collab2:1234}` with `lb_policy uri_hash` (the URL is `/collab/{roomId}`, nothing in it changes between reconnects), an active health check (`/`, 5 s), `lb_try_duration 3s` so a connection to a dead instance is retried on the other, and `handle_errors` answering the same "The collaborative pad is not available right now." 503 as before when no instance runs. **Infra, opt-in:** `apps/collab/Dockerfile` (+ `Dockerfile.dockerignore`), Compose services `collab1`/`collab2` under profile `collab` (variables optional with defaults like `plag`; they receive `DATABASE_URL`, `REDIS_URL`, `COLLAB_SERVICE_TOKEN`, `API_URL`, `COLLAB_INSTANCE` and **no `env_file`**, so no JWT key or AI keys; nothing published; read-only; 0.5 CPU / 512 MB; `stop_grace_period` 20 s for the flush). `main.ts` refuses to start without `DATABASE_URL` and `REDIS_URL`. **Limits:** collab uses the API's Postgres user and Redis `api` user (same VM, same trust; a dedicated least-privilege pair is a hardening step); the extension's own Redis connections log errors if Redis is unreachable at start instead of exiting; the update log and checkpoints (CP-06), snapshots and the 2 MB cap (CP-07) are not here. **Not deployed:** nothing runs in production; see CP-DEPLOY.

> **As built (CP-DEPLOY):** the pipeline can now run the pad, off until the repository variable `COLLAB_ENABLED` is `true`. Jobs `collab-image` (builds `apps/collab/Dockerfile`, pushes `codearena-collab:<sha>`, scope-separated build cache) and `deploy-collab` (`infra/prod/ci/deploy-collab.sh` → `infra/prod/deploy-collab.sh` on the VM) run after `deploy-api`, are `continue-on-error` and needed by nothing, so a failure never fails or rolls back an API or judge deploy. The server script: digest-pinned image only; ensures `COLLAB_SERVICE_TOKEN` and `COLLAB_URL=http://collab1:1234,http://collab2:1234` in `prod.env` (new installs get both from `init-env.sh`) and recreates the API once if it had to add them; pulls; **updates `collab1` then `collab2`, each only after its own health check passes**, so a room always has a server and clients reconnect to the other one; if any instance fails, **all** instances return to the previous image (or stop when there was none) so two versions never run side by side; state in `state/collab-current`. **Room close reaches both instances:** `COLLAB_URL` now takes several addresses (comma or space separated) and `POST /api/rooms/{id}/close` tells each of them (a room may live on either; Redis shares edits, not connection closures). **Edge:** `/api/internal/*` is answered `404 Not found` by Caddy before the `/api/*` handle: the collab servers reach it over the private network (`http://api:4000`), never through the edge. Runbook: `docs/runbooks/collab.md`. **Left for you:** `NEXT_PUBLIC_COLLAB_URL` in Vercel (inlined at build time) and the decision to set `COLLAB_ENABLED`. **Still not done (hardening):** a dedicated Postgres role and Redis user for collab, OpenTelemetry in the collab process.

> **As built (CP-04):** Run and Submit from the pad. **API:** `POST /api/rooms/{id}/runs {runId, mode: run|submit, language, source, input?}` (202; interviewer and candidate only, observers 403; a closed or over-90-minutes room 400; 64 KB limits in bytes; `runId` is the client's UUID, so a retry answers the same and runs nothing twice) and `GET /api/rooms/{id}/runs` (the last 30, every member including observers). A run is a `custom_runs` row with `room_id` (no new table): `run` carries the input (even empty), `submit` carries none and needs the room's problem, so the **mode is `input is null`**. The job goes to the **`interactive` lane** (strict priority contest, interactive, practice, rejudge: ADR-005, `lanes.go`), `run` with `customInput` (the judge never reads the testset for it, so a room **without a problem** uses a scratch version: default limits, a well-formed placeholder reference), `submit` with the attached problem's current version and full testset; a submission here is judged but is **not a submission**: it is in nobody's practice record, board or rating. **One run per room every 2 seconds** (`SET room-run:{id} NX PX 2000`, whoever presses; 429 with `Retry-After`); the token is taken only after a retry check and the other validations, so a refused or repeated request costs nothing. Each start writes a `room_events` row (`kind run`, `seq` per room under an advisory lock; the verdict lives in `custom_runs` and playback joins on `runId`). **Broadcast (deviation from SD-§11.6):** not Hocuspocus stateless messages but the existing SSE hub on topic **`room:{roomId}`** (event `room.run`, members only: the ticket service authorises it like `sub:` and `contest:` topics), because SSE already fans out across API instances through Redis, has replay with `Last-Event-ID`, needs no new collab surface (the two collab instances do not relay stateless messages to each other anyway) and the room page already holds an SSE connection for nothing else; the cost is a second connection beside the WebSocket. The event is sent when the run is queued (who pressed it) and again when the judge's result is stored (`ResultsProcessor` publishes it for runs that have a `room_id`, once, replays are silent), both built by one function from the stored row (`roomRunView`), so the live event and the history are identical and **every member reads the same row**. Output is cut at 16 KB in what is sent (full text stays in the database); per-test entries are `{no, verdict, timeMs}` only, never a checker message or any test content. **Web:** the output panel under the editor (input box, Run with Ctrl/Cmd+Enter, Submit disabled without a problem, history newest first with who, mode, language, verdict badge in words, time, per-test list, compiler / output / error blocks, "cut" note); observers see the history and a note instead of live buttons. **A real bug the browser test found:** the client's SSE listener list (`TYPES` in `lib/realtime.ts`) had no `room.run`, so the events would have been ignored in production; the list is now exported and a test requires it to equal every `SseEventType`. Metric `ca_room_runs_total{mode,outcome}`, span `rooms.run`. **Priority:** the API test fills the contest and practice lanes with 40 jobs each and checks the room's job is in the interactive lane only (the worker's own lane tests prove the order). **Not built:** the typing indicator; room-run events in playback (CP-06 reads `room_events` + `custom_runs`).

> **As built (CP-05):** the interviewer's private notes. **API** (`room-notes.service.ts`, contract `RoomNotes`/`RoomNotesPut`): `GET` and `PUT /api/rooms/{id}/notes`, `interviewer_notes` is the only place the text lives (never the Y.Doc, an event, an audit row, a log line or a metric label; `ca_room_notes_total{op}` counts read / save / denied / conflict). The interviewer of that room gets it; a stranger is told 404, a candidate or observer 403, a guest 401; it is readable and editable after the room has ended (the candidate still cannot); `Cache-Control: no-store`; 64 KB limit in bytes (413); 120 saves a minute. **Two windows:** a save names the time it was based on (`baseUpdatedAt`, null for the first); inside one transaction (`select … for update`) a different stored time, or a first save over saved notes, is **409 `conflict`** (new, additive error code, SRS catalogue) and nothing is overwritten; every save gets a time strictly later than the one it replaces. **Web:** the room page has tabs **Code** and **Notes** (lock icon, interviewer only; Whiteboard joins with CP-10); both stay mounted so the editor binding and unsaved text survive a tab switch; the notes box saves 1 s after the last keystroke, on blur, when the page is hidden and when the panel goes away, and says "Saving…" / "Saved 12:03" / "Not saved: …"; on a conflict it stops saving and offers **Use the saved version** or **Keep mine**. A candidate or observer has no tab and **makes no request to the notes endpoint** (the browser test records it). **The acceptance test is a sweep:** it writes a secret note, lists every registered GET route from Express's own router (a route added later is included), calls each as candidate, observer, stranger and guest and finds the secret in none; called as the interviewer, the secret comes back from exactly one route (the notes route), so it also never leaks into the room view, the list, the runs or a ticket; and it is absent from `audit_log`, `room_events`, `custom_runs`, `room_docs`, `room_updates`, `rooms`, `room_invites` and every Redis key of the test prefix. **Not built:** the playback side panel (CP-06), the AI summary reading notes (CP-11), a retention rule beyond "with the room".

> **As built (CP-06):** the update log and the replay. **Log (collab, `update-log.ts`):** every update from a connection or a direct connection (an update relayed by Redis is logged by the instance that received it, so never twice) is queued per room and written in batches (200 ms or 100 updates; awaited when a document unloads and on `destroy()`), with the server's receipt time and the verified author. **`seq` comes from the database:** one transaction takes the same `pg_advisory_xact_lock(hashtext(roomId))` as the API's event writes, appends `max(seq)+1…`, and for each multiple of **200** crossed writes a checkpoint **exactly at that seq** (the previous checkpoint plus the rows after it, read back: ≤ 200 rows), so a checkpoint never contains later edits and no in-memory shadow is needed across instances; a failed write keeps its batch and retries after a second and never touches editing. **Fidelity by construction (FR-PAD-11, deviation: a synthetic catch-up update):** when a document is loaded and when it is unloaded the log is replayed from its last checkpoint and compared (`Y.equalSnapshots`) with the document; whatever the log lacks (a tail lost to a crash, a batch that never flushed) is appended as **one catch-up update with no author** (`Y.diffUpdate`), so replaying the whole log equals the stored document whatever happened. Loading a stored document logs nothing. **Events:** collab writes `join`, `leave` and the new `language` (observing `meta.language`; migration 0011 adds the enum value); `run` events come from the API (CP-04); verdicts are read from `custom_runs` at replay time. **API (interviewer only, readable any time, `no-store`):** `GET /api/rooms/{id}/timeline` (`startedAt` = the earliest of the room, first edit and first event, `endedAt`, `durationMs`, update count, `lastSeq`, `checkpointEvery`, up to 2000 events with who, run mode and verdict, language) and `GET /api/rooms/{id}/playback?toTs=|toSeq=` (a seek: the last checkpoint at or before the point plus the updates after it) or `?fromSeq=&toSeq=` (a chunk to play on, at most 1000), as `application/octet-stream` records `[u8 kind (0 checkpoint, 1 update)][u32 seq][f64 ts ms][u32 length][bytes]` with `X-Playback-From-Seq` / `-To-Seq`. **Measured:** over a 60-minute session of 36,000 updates (10 a second, checkpoints every 200) a seek by time takes 9 to 16 ms and carries one checkpoint and at most 200 updates; the answer does not grow with the session. **Retention (§6.4):** `RoomsRetention` deletes the log and checkpoints 90 days after a room closed (a room nobody closed counts from the end of its 90 minutes); `room_docs`, the events and the notes stay. **Web:** `lib/playback.ts` is a pure player (no DOM, injected slice source): `seek` builds a fresh `Y.Doc` from a checkpoint and a short tail, `advance` applies updates when their time comes at 1×, 2× or 4×, fetches ahead in 500-update pieces, skips silences longer than 5 s, clamps to the session, and discards a slice or a seek that a later seek has overtaken. `/r/[roomId]/replay` (S14): read-only Monaco with the replayed language, Play / Pause, speed buttons with `aria-pressed`, a range scrubber (1 ms steps so End is the end; arrows ±5 s, Page keys ±30 s; `aria-valuetext` "00:03 of 00:06") with a marker per event placed by time and a clickable list in words ("@asha ran: Accepted", "Language changed to Python 3", "@meera submitted: Wrong answer"), Space and ←/→ on the page, the interviewer's notes beside it, a loading hint only after 300 ms; End room now leads here and closed rooms in `/interview` show **Replay** for the interviewer only; a candidate or observer gets a refusal and the page makes no request. **Not built here:** restore and snapshots (CP-07), the AI summary (CP-11), strokes in the replay (CP-10, same document). **Rare race, accepted:** if one instance loads a room while another still holds an unflushed batch, the loader may add a catch-up update that duplicates content that arrives a moment later (harmless: applying an update twice changes nothing).

