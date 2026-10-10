# Architecture overview

A map for someone new to the codebase. The detailed design (schemas, key names, maths, budgets) is in
[SYSTEM_DESIGN](SYSTEM_DESIGN.md); each decision with its alternatives is an [ADR](adr/README.md). The diagram is in
the [README](../README.md#architecture).

## Components

| Component | Where | Does | Talks to |
| --- | --- | --- | --- |
| **Web** | `apps/web` (Vercel) | Next.js App Router UI; forwards `/api/*` to the API (a Vercel rewrite); streams events directly from the API host | API (REST, SSE), collab (WebSocket) |
| **API** | `apps/api` (API VM) | NestJS: REST, SSE gateway, queue producer, results processor, leaderboard, ratings, AI orchestration, rooms, admin | Postgres, Redis, object storage, AI relay |
| **Judge worker** | `apps/worker` (judge VM) | Go: claims jobs, compiles and runs in isolate, publishes verdicts | Redis (judge ACL user), object storage (read-only) |
| **Collab** | `apps/collab` (API VM, two instances) | Hocuspocus (Yjs) server for the interview pad, one document per room | Postgres, Redis |
| **Plagiarism** | `apps/plag` (API VM job) | Python: fingerprints and code embeddings for a contest's submissions | API (service token) |
| **AI relay** | `apps/web/app/relay` (Vercel) | Forwards model calls from a region the providers accept | Groq, Gemini |
| **Contracts** | `packages/contracts` | Zod schemas, generated JSON Schema and Go types | everything |

## Data: what lives where

| Store | Holds | Is it the truth? |
| --- | --- | --- |
| **Postgres** | users, problems and versions, submissions and per-test results, contests, participants, ratings, rooms and pad logs, audit log, admin and setter lists | **Yes.** Everything else can be rebuilt from it. |
| **Redis** | job streams per lane, leases, results stream, the live leaderboard, SSE replay buffers, rate limits, AI budgets | No: queues and caches. |
| **Object storage** (SeaweedFS) | test sets, hidden tests, checkers, setter solutions (content-addressed) | From the problem packages (`problems/`, `problems-private/`). |
| **Browser** | session cookie, editor drafts | No. |

## Request flows

### A submission

1. The browser posts the code with an idempotency key. The API validates it, stores a `submissions` row in Postgres
   and appends a job to the Redis stream of its **lane** (contest, interactive, practice, rejudge).
2. A worker claims jobs in strict lane priority (every 8th claim comes from the lowest non-empty lane so nothing
   starves), holding a lease it refreshes every 2 s. A reaper takes over the job with `XAUTOCLAIM` if the worker dies;
   after 3 failed deliveries it goes to the dead-letter queue.
3. The worker compiles and runs the code in isolate (cgroup v2, no network, empty environment), compares output with
   the checker and publishes the verdict on the `results` stream.
4. The API applies the result **idempotently** (a run version guards against late duplicates), updates Postgres,
   recomputes the leaderboard cell from Postgres and publishes events.
5. Every browser watching gets the change over **SSE**, which can resume from the last event id after a reconnect.

### The live board and the freeze

Scores come from Postgres, not from counting events, so a rebuild (`rebuild-board`) always matches. From the freeze
time the public board shows other people's new attempts as pending while each user still sees their own verdicts;
the resolver ceremony replays the frozen interval.

### The interview pad

The browser connects by WebSocket (through Caddy) to one of two collab instances, chosen by a hash of the room id.
Identity comes from a single-use ticket issued by the API, never from what the client claims. Edits are Yjs updates;
every keystroke is also logged to Postgres, which is what the replay plays back. Interviewer notes and the AI summary
are **not** in the shared document.

### An AI hint

The API checks the budget and that the contest rules allow hints, sends the problem, the attempt and the setter's
avoid-list inside delimited data blocks to the model through the relay, then passes the answer through a
code-removal pass and a deterministic filter before storing it. Failures fall back to a fixed sentence.

### Sign-in

OAuth (Google, GitHub) with PKCE; the API issues a 15-minute access token and a rotating, hashed refresh cookie.
The web app and the API share one origin from the browser's point of view (the Vercel rewrite), so cookies are on the
web domain.

## Trust boundaries

1. **Browser ↔ API:** untrusted client; validation at every boundary, CSRF token on mutations, per-user rate limits.
2. **API ↔ judge:** judge hosts are assumed hostile; they reach only Redis (judge ACL user) and read-only storage and
   hold no database credentials. Results are checked by schema and run version.
3. **Submission ↔ judge host:** the sandbox (no network, resource limits, empty environment) and the host firewall
   are two independent layers.
4. **Pad:** the server decides roles; observers are read-only on the server.

## Failure behaviour (measured)

A killed worker or API, a Redis restart, a stopped judge VM and a poison job are all drilled; every accepted
submission ends with exactly one verdict ([METRICS](METRICS.md), [failure drills](runbooks/failure-drills.md)). When
the servers are off the website says so ([UI/UX, UI-23](UI_UX.md)).

## Where to look in the code

| You want | Start at |
| --- | --- |
| A REST endpoint | `apps/api/src/modules/<area>/*.controller.ts` (areas: auth, problems, submissions, contests, board, ai, rooms, admin, plag, signals, status) |
| The queue and results | `apps/api/src/modules/submissions/`, `apps/worker/` |
| Leaderboard maths | `apps/api/src/modules/board/` |
| A screen | `apps/web/app/<route>/page.tsx` and `apps/web/components/<area>/` |
| Colours, type, spacing | `apps/web/app/tokens.css` |
| The data model | `apps/api/src/db/schema/` and `apps/api/drizzle/` |
| A shared type | `packages/contracts/src/` |
| Deployment | `infra/terraform/`, `infra/prod/`, `.github/workflows/` |
