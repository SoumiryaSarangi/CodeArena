# CodeArena — Master Build Plan

> **Where this file lives:** `docs/PLAN.md` in the repo. `CLAUDE.md` (repo root) points here.
> **Who reads it:** Soumirya (owner) and Claude Code (builder).
> **Build window:** Day 0 = Wed 30 Sep 2026 → Day 14 = Wed 14 Oct 2026.
> **Scope:** everything in `docs/research.md` (the CodeArena research doc), nothing cut, plus the additions in §14.
> **Rule for Claude Code:** never read this whole file in one go. Find your task card by ID (`grep -n "#### J-03" docs/PLAN.md`) and read that card plus any section it links to.
> **Spec set:** `docs/PRD.md` (what/why, stories `US-*`) · `docs/SRS.md` (requirements `FR-*`/`NFR-*`, API) · `docs/SYSTEM_DESIGN.md` (how, `SD-§n`) · `docs/UI_UX.md` (design, screens `S01–S18`). This plan says *when* and *who*; the specs say *what* and *how*. §0.1 maps each task prefix to the spec sections to read.

---

## 0. How this document works

| Section | Read by | When |
|---|---|---|
| §1 Mission and "done" | Both | Day 0, then whenever scope feels fuzzy |
| §2 Who does what | Both | Day 0. This is the contract |
| §3 Working protocol | Claude Code | Every session (the short version is in `CLAUDE.md`) |
| §4 Locked decisions | Both | Before any design change. Locked means locked |
| §5 Accounts and infra | Soumirya | Day 0 |
| §6 Architecture spec | Claude Code | When a task card links to it |
| §7 Frontend spec | Claude Code | Any `UI-*` task |
| §8–9 Schedule and task cards | Both | Daily |
| §10 Contest-day runbook | Soumirya | Day 9 and Day 10 |
| §11–13 Quality, metrics, risks | Both | End of each day |

Every task has an ID. Prefixes:
`F` foundation · `J` judge · `Q` queue/realtime · `P` problems · `S` submissions · `UI` frontend · `D` deploy · `C` contests · `O` ops/observability · `AI` AI Coach · `PL` plagiarism · `IN` integrity signals · `CP` collaborative pad · `W` wrap-up.
Soumirya's tasks use `U` + day number (e.g. `U3.2`).

### 0.1 Which spec sections each task needs

| Task prefix | Read (only these) |
|---|---|
| `F` foundation | SD-§4, §6 (F-04), §18.1; SRS §3.1.2, §3.2.1 (F-06); UI_UX §5–§7 (F-07) |
| `J` judge | SD-§8, §16.1; SRS §3.2.4 |
| `Q` queue/realtime | SD-§5.2–5.3, §7, §10; SRS §3.2.5–3.2.6 |
| `P` problems | SRS §3.1.6, §3.2.2; SD-§6.2 (problems) |
| `S` submissions | SRS §3.1.3 (submissions), §3.2.3 |
| `UI` frontend | UI_UX §5–§7 + the screen `S..` named on the card; SRS NFR-A11Y |
| `D` deploy | SD-§3.2, §18; PLAN §5 |
| `C` contests | SD-§5.5–5.6, §9; SRS §3.2.7–3.2.9; PRD §9.1–9.4; UI_UX S07–S11, S16 |
| `O` ops | SD-§15, §17; SRS §3.2.10, §3.3.1 |
| `AI` | SD-§12; SRS §3.2.11; PRD §9.5; UI_UX HintLadder, S11 |
| `PL` / `IN` | SD-§13–14; SRS §3.2.12; UI_UX S17 |
| `CP` pad | SD-§5.8, §11; SRS §3.2.13; UI_UX S13–S14 |
| `W` wrap-up | PRD §6.3; SD-§20; PLAN §12 |

Name tests after requirement IDs (`it('FR-QUEUE-06: duplicate results change nothing', …)`) so traceability is automatic.

---

## 1. Mission and definition of done

**Mission:** a production-grade online judge that real people used, with security depth, measured performance under load, a measured AI layer, and a real-time interview pad, all of which Soumirya can explain line by line in an interview.

**CodeArena is "done" on Day 14 when all of these are true:**

1. ✅ Deployed on a public URL with HTTPS, CI/CD, and monitoring.
2. ✅ 5 languages judged in isolate with AC/WA/TLE/MLE/RE/CE/OLE/SE verdicts and custom checkers.
3. ✅ Attack suite (25+ cases) passes: 100% blocked, runs automatically.
4. ✅ Queue with lanes, leases, retries, DLQ, and idempotent verdicts. Killing a worker mid-judge still yields exactly one verdict.
5. ✅ Live verdicts (per test) over SSE, queue position and ETA, live leaderboard with freeze and a resolver ceremony.
6. ✅ **A real contest ran on Sat 10 Oct with 20+ classmates.** Numbers recorded.
7. ✅ k6 burst test results (p50/p95 queue wait and time to verdict) recorded in `docs/METRICS.md`.
8. ✅ Plagiarism pipeline (winnowing + embeddings + clustering + human review UI) with precision/recall on a labelled set that includes obfuscated variants.
9. ✅ AI Coach (practice hint ladder + post-contest review) with a measured leak rate before and after the code-removal pass.
10. ✅ Collaborative pad: roles, live cursors, judge-backed Run/Submit, private notes, persistence, multi-instance, playback, version restore, plus the stretch items (offline, whiteboard, AI interview summary).
11. ✅ 5–10 real mock interviews hosted on the pad.
12. ✅ README with architecture, GIFs, and metrics; ADRs; interview answer notes; demo video.

---

## 2. Who does what (the contract)

### 2.1 The rule

> **Claude Code writes everything that can be written. Soumirya does everything that needs a human identity, a secret, root on his own machine, money, or other humans, and he must understand everything before it's merged.**

| Soumirya does (only Soumirya) | Claude Code does (only Claude Code) |
|---|---|
| Creating accounts, verifying student status, anything involving billing | All application code: web, API, worker, collab, plagiarism |
| Creating and storing secrets (`.env`, GitHub Actions secrets, API keys, OAuth apps) | Tests of every kind (unit, integration, e2e, property, attack, load scripts) |
| Running `sudo` commands on his own machine (Claude writes the script, Soumirya runs it) | Scripts, Dockerfiles, Compose, Terraform, cloud-init, Caddyfile, CI workflows |
| `terraform apply` / `destroy` and anything in the Azure portal | Grafana dashboards as JSON, alert rules, runbook drafts |
| DNS and domain setup | ADRs, specs, `PROGRESS.md` handoffs, PR descriptions |
| **Writing contest problem statements** (original ideas; Claude helps polish) | Reference solutions, brute-force solutions, generators, validators, checkers, stress tests for every problem |
| Recruiting participants, running the contest, answering clarifications | Seed data, 20 practice problems (original, textbook-style), eval datasets |
| Manual QA on real devices, reviewing and merging PRs | The eval harnesses and `docs/METRICS.md` generator |
| **Explain-back checkpoints** (§3.6) | First drafts of interview answer notes (Soumirya rewrites them in his own words) |
| Hosting mock interviews, recording the demo video, the resume | README, architecture diagrams, demo script |

### 2.2 Claude Code must stop and ask Soumirya when

1. A step needs a secret, a password, or an API key value.
2. A step needs `sudo` on Soumirya's machine, or touches cloud billing (creating/destroying cloud resources).
3. The task would change a **locked decision** (§4) or a contract in `packages/contracts`.
4. A new runtime dependency is not on the approved list in §4.2.
5. The same bug has survived two fix attempts.
6. The work is growing past its task card (scope creep). Finish the card, then write a follow-up card in `PROGRESS.md`.
7. Anything could delete data (DB migrations that drop columns, cleanup scripts).

---

## 3. Working protocol for Claude Code (tuned for the Pro plan)

Pro has usage limits that reset on a rolling window, plus weekly caps. This protocol exists so that none of that budget is wasted on re-exploring the repo or re-debating decisions.

### 3.1 One task card = one session

1. Soumirya starts a session with: `Do task J-03.` (or several small cards: `Do UI-05 and UI-06.`)
2. Claude Code reads `CLAUDE.md` (automatic), then `docs/PROGRESS.md` (last 40 lines), then **only** the task card and the sections it links to.
3. Model check against the card's tag (§3.7). Cards tagged **P** or **O** (all 🧠 cards are one of these) start in plan mode and show the plan before writing code.
4. Implement → test → run the quality gate (`pnpm check`, `go test ./...`, `uv run pytest` as relevant).
5. Append a handoff entry to `docs/PROGRESS.md` (template in §3.4).
6. Commit on a branch `t/<ID>-<slug>`, open a PR with `gh pr create` using the PR template. Soumirya merges.
7. Soumirya runs `/clear` before the next card.

### 3.2 Token economy rules

- Don't open files you don't need. Use `rg` / `grep` to locate symbols before reading.
- Never read `node_modules`, lockfiles, generated files, build output, or `docs/research.md` unless the card says so.
- Keep explanations in chat short. Put durable explanations in docs, not in chat.
- Follow the model tag on each card heading (§3.7). Opus costs several times more per turn than Sonnet, so only **P** and **O** cards use it.
- Don't spawn subagents unless Soumirya asks.

### 3.3 Git and PRs

- Trunk-based: `main` is always deployable. Short-lived branches `t/<ID>-<slug>`.
- Conventional commits: `feat(judge): …`, `fix(queue): …`, `test(pad): …`.
- PR template sections: **What** · **Why** · **How to test** · **Explain-back notes** (3–6 bullets Soumirya must understand) · **Risks**.
- CI must be green before merge.

### 3.4 `docs/PROGRESS.md` handoff template

```md
## <date> · <task ID> · <status: done | partial | blocked>
- Built: <1–3 bullets>
- Tests: <what runs, what passes>
- Decisions: <any small decision + why> (big ones → new ADR)
- Next: <exact next step, or follow-up card IDs>
- Soumirya must: <any action needed from Soumirya, e.g. run script X with sudo>
- Model: <tag> · ran on <model(s) actually used>
```

### 3.5 Definition of Done (every card)

- [ ] Acceptance criteria on the card all met
- [ ] Tests written and passing; no skipped tests without a linked follow-up
- [ ] Lint + typecheck clean; contracts regenerated if touched
- [ ] No secrets in code, logs, or commits
- [ ] UI work uses design tokens only (§7.2), works at 1280px and 390px widths, keyboard-accessible
- [ ] Observability: new endpoints/jobs emit a trace span and a metric
- [ ] `PROGRESS.md` updated; ADR added if a decision was made

### 3.6 Explain-back checkpoints (Soumirya)

The project is worthless in interviews if Soumirya can't defend it. Each day has a 30–45 minute explain-back: Soumirya explains the day's component out loud (or in writing in `docs/interview/notes.md`) without looking at the code, then checks against the code. Anything he can't explain becomes a question for the next Claude Code session: `Explain how XAUTOCLAIM gives us leases in our worker, using our code.`

### 3.7 Model routing (Sonnet vs Opus)

Opus "costs several times more per turn than Sonnet" (Anthropic support, *Models & usage limits in Claude Code*), and Pro quota is the main schedule risk (§13). So Sonnet does the bulk of the build, and Opus is spent only where a subtle bug is expensive: security, concurrency, ordering and scoring logic. Every card heading ends with a tag:

| Tag | Meaning | Soumirya types | Cards |
|---|---|---|---|
| **S** | Sonnet does the whole card (spec in SYSTEM_DESIGN / SRS / UI_UX is precise) | `/model sonnet` | 46 |
| **S·high** | Sonnet at higher effort (fiddly but well specified) | `/model sonnet` then `/effort high` | 5 |
| **P** | Opus plans, Sonnet builds (design choices up front, then mostly mechanical) | `/model opusplan` | 15 |
| **O** | Opus end to end at `/effort high` (a wrong answer is a security hole or silent data corruption) | `/model opus` then `/effort high` | 6 |

**O** (security / concurrency / scoring): F-06, J-01, J-07, J-08, Q-02, C-02
**P** (design first, build second): F-03, Q-03, Q-05, UI-02, D-01, P-02, O-01, O-06, AI-02, AI-04, CP-01, CP-03, CP-05, CP-06, CP-07
**S·high**: J-03, J-05, Q-04, PL-01, C-08
Everything else is **S**.

**Rules**
1. **Model check before any work, both directions.** Claude Code finds the heading with `grep -n "#### <ID>" docs/PLAN.md`, reads the tag, and compares it with the model it is running (for **P**: enter plan mode first, and you should be on Opus there). If it differs, it stops and prints exactly `🔁 MODEL SWITCH: next is <ID> (<title>) — recommended <opus|opusplan|sonnet>. Type /model <that>, then say continue.` Otherwise it prints `✓ Model OK: <ID> on <model>`. "Both directions" matters: `/model <alias>` can be saved as your default for later sessions, so an Opus card can leave you on Opus for the next Sonnet card.
2. **Claude Code cannot change its own model.** Only you can, with `/model`. This is an instruction Claude follows, not something the tool enforces, so if a card runs on the wrong model, tell Claude and it will stop and print the switch line.
3. **Batch by tag.** Ask for cards that share a tag in one request (`Do UI-05 and UI-06.`), because every tag change costs a stop. If the tags differ, Claude stops at each boundary.
4. **Escalate on failure.** If the same bug survives two fix attempts on Sonnet, Claude stops (CLAUDE.md rule) and recommends Opus with the same switch line. Drop back to Sonnet for the next card.
5. **Opus may not be on your plan.** Anthropic's pages disagree on whether Pro includes Opus in Claude Code: an older support article says it does not, a newer one says `/model` lists what your account has. Task **U0.8** settles it with one command. If Opus is unavailable, **P** and **O** cards run on Sonnet at `/effort high`; Claude prints `⚠ Opus unavailable: running <ID> on Sonnet at /effort high` once and continues. For **O** cards you then also do the explain-back before merging, because there was no stronger model to catch mistakes. Scope does not change.
6. **Spend Opus carefully.** Start **O** cards at the beginning of a fresh usage window, keep one card per session, and `/clear` between cards (switching models does not clear the conversation, so the existing `/clear` rule still applies).
7. **Record it.** Each `PROGRESS.md` entry gets a `Model:` line (tag, and the model actually used), so after the build you can see where Opus really paid off.

**Open check (first P card, F-03):** I could not test `opusplan` from here. When F-03 runs, note in `PROGRESS.md` whether planning ran on Opus and building on Sonnet. If not, use the manual route for P cards: `/model opus` for the plan, `/model sonnet` after you approve it.

---

## 4. Locked decisions

### 4.1 Decisions (each gets an ADR in `docs/adr/` during F-09)

| # | Decision | Why (one line) |
|---|---|---|
| ADR-001 | Monorepo: pnpm workspaces + Turborepo | One repo, one CI, shared contracts |
| ADR-002 | Web: Next.js 16.x (latest patched release, App Router) + React 19 + TypeScript + Tailwind v4 + shadcn/ui | Soumirya already knows it (SenseiAI) |
| ADR-003 | API: NestJS (Express adapter) + TypeScript + Drizzle ORM + Postgres | Module/DI structure = LLD talking points; stable SSE |
| ADR-004 | Judge worker: **Go** controlling **isolate 2.x** (cgroup v2) | Small, systems-level service; clean process control and concurrency |
| ADR-005 | Queue: **Redis Streams** with consumer groups, one stream per lane, leases via `XAUTOCLAIM` | Works natively from Go; leases, retries, and DLQ are explainable primitives |
| ADR-006 | Realtime: **SSE** for verdicts/leaderboard/clarifications, **WebSocket** (Hocuspocus) for the pad; Redis pub/sub fan-out | Simplest correct transport per use case |
| ADR-007 | Auth: OAuth only (Google + GitHub), access JWT (15 min) + rotating refresh cookie; short-lived **realtime tickets** for SSE/WS | No password storage; classmates all have Google |
| ADR-008 | Contracts: Zod is the source of truth → JSON Schema → Go types via quicktype; CI fails if generated code is stale | Frontend, API, and worker can never drift |
| ADR-009 | Judge hosts are **untrusted**: separate VM, no DB credentials, Redis ACL user limited to job/result keys, read-only object storage key, egress blocked | Judge0 CVE lessons |
| ADR-010 | Collab: Yjs + y-monaco + **Hocuspocus v4** (MIT, needs Node 22+), Postgres persistence, Redis extension, room-hash sticky routing in Caddy | CRDT = stateless relay; Redis gives availability, not CPU scaling |
| ADR-011 | Plagiarism: separate **Python** batch service (tree-sitter + winnowing + UniXcoder embeddings) | ML ecosystem lives in Python |
| ADR-012 | LLM: provider abstraction; Groq primary, Gemini (free tier) fallback; one guardrail pipeline for all AI features | Free, fast, no single point of failure |
| ADR-013 | Hosting: Vercel (web) + Azure for Students VMs (API VM + judge VMs), Terraform-managed | $100 credit, no card needed |
| ADR-014 | Upgrade paths documented but not built: gVisor, KEDA on Kubernetes, y-redis | Interview "what would you do next" answers |
| ADR-015 | Postgres is the source of truth; Redis is always rebuildable | Failure drills prove it |

### 4.2 Approved dependencies

- **Web:** next, react, tailwindcss, shadcn/ui (Radix), @tanstack/react-query, zustand, @monaco-editor/react, motion (Framer Motion), react-resizable-panels, cmdk, sonner, react-hook-form, zod, react-markdown + remark-math + rehype-katex + rehype-sanitize, recharts, @sentry/nextjs (approved by Soumirya for O-01, 2026-10-08), yjs, y-monaco, @hocuspocus/provider, y-indexeddb, perfect-freehand, lucide-react, geist (font).
- **API/collab:** @nestjs/*, drizzle-orm, drizzle-kit, pg, ioredis, zod, jose, @hocuspocus/server + extension-database + extension-redis, @opentelemetry/*, pino, @aws-sdk/client-s3, @sentry/node.
- **Worker (Go):** go-redis v9, minio-go, OpenTelemetry Go SDK, `log/slog`.
- **Plagiarism (Python, managed with uv):** tree-sitter + grammars (cpp, python, java, c, javascript), transformers, torch (CPU), numpy, scikit-learn, networkx, pytest; dev: ruff, mypy.
- **Testing:** vitest, @playwright/test, @axe-core/playwright, testcontainers, fast-check, k6 + xk6-sse (community extension; k6 has no built-in SSE), supertest; Go dev: staticcheck.
- **Checkers:** testlib.h (vendored with its licence).

Anything else → stop and ask (§2.2).

---

## 5. Accounts, infrastructure, and free services

### 5.1 Accounts (Soumirya, Day 0)

| Service | Used for | Card? | Notes |
|---|---|---|---|
| **GitHub Student Developer Pack** | Domain (.me via Namecheap), DigitalOcean credit (needs card/PayPal), Sentry perks | No | **Apply today** — verification can take days. Nothing in the plan blocks on it |
| **Azure for Students** | All VMs, Blob storage for backups | **No** | $100 / 12 months, sign up with LPU email. Also check its free-service list for included VM hours |
| GitHub | Repo (public), Actions, GHCR images, CodeQL, Dependabot | No | Public repo = free Actions minutes + resume visibility |
| Vercel (Hobby) | Frontend hosting | No | |
| Groq | LLM primary | No | Free tier; rate-limited, so AI jobs are queued |
| Google AI Studio | LLM fallback (Gemini) | No | |
| Grafana Cloud (Free) | Metrics, logs, traces, dashboards | No | |
| Sentry (Developer) | Frontend + API error tracking | No | |
| UptimeRobot or Better Stack | External uptime checks | No | |
| Google Cloud Console + GitHub OAuth Apps | OAuth clients (dev + prod callbacks) | No | |

**Budget rules for Azure:** set a budget with alerts at 25/50/75%. Steady state = 1 API VM + 1 judge VM. Burst judge VMs only exist for load tests and contest day, then get destroyed. Use Central India if your subscription allows it; otherwise the nearest allowed region. Check the pricing calculator before choosing sizes; the sizes below are starting points.

### 5.2 Environments

| Env | Where | Purpose |
|---|---|---|
| **dev** | WSL2 Ubuntu on Soumirya's laptop, Docker Compose | Everything, including isolate (WSL2 + systemd + cgroup v2) |
| **prod** | Vercel + Azure | Real users. Staging = prod before Day 10 (no separate env; budget) |

### 5.3 Production topology

```
Vercel (Next.js)  ──/api/* rewrite──▶  Caddy on API VM (HTTPS)
     │                                   ├─ api (NestJS) ×1
     │  SSE / WS (direct, ticket auth)   ├─ collab (Hocuspocus) ×2  ← room-hash routing
     └──────────────────────────────────▶├─ postgres, redis, minio (Docker volumes)
                                         └─ otel collector → Grafana Cloud
                     private VNet only
API VM ◀──────────────────────────────▶ Judge VM(s): worker (Go) + isolate
                                         NSG: no inbound from internet, egress blocked
                                         except Redis + MinIO on the private network
```

- **API VM:** 2 vCPU / 4–8 GB (B-series). **Judge VM:** 2 vCPU; one sandbox per core, pinned.
- **Why the `/api` rewrite:** REST goes through the Vercel domain so auth cookies are first-party on any domain. SSE and WebSocket can't go through Vercel rewrites reliably, so they connect directly to the API domain with a 60-second single-use ticket.
- **Domain:** use the Student Pack `.me` domain when it arrives (`codearena.me`, `api.codearena.me`). Until then: Vercel's default domain + `api.<VM-IP>.sslip.io` with Caddy auto-TLS.
- **Backups:** nightly `pg_dump` to Azure Blob; weekly restore test (script).
- **Hidden tests never enter the public repo.** Contest problems live in `problems-private/` (gitignored) and are uploaded to MinIO via the admin CLI.

---

## 6. Architecture spec

### 6.1 Repo layout

```
codearena/
├─ CLAUDE.md
├─ docs/  PLAN.md  research.md  PROGRESS.md  METRICS.md  adr/  runbooks/  interview/  design/
├─ apps/
│  ├─ web/       Next.js
│  ├─ api/       NestJS
│  ├─ worker/    Go (judge)
│  ├─ collab/    Hocuspocus
│  └─ plag/      Python (uv)
├─ packages/
│  ├─ contracts/ Zod schemas → JSON Schema → generated Go types
│  └─ config/    tsconfig, eslint, prettier presets
├─ problems/           public practice packages (samples only public)
├─ problems-private/   gitignored: contest packages + hidden tests
├─ infra/  docker/  compose/  terraform/  cloud-init/  caddy/  grafana/
├─ tests/  attack-suite/  load/ (k6)  chaos/
└─ scripts/
```

### 6.2 Data model (Postgres, Drizzle)

- **users** (id, handle, name, avatar, role: user|setter|admin, rating, created_at) · **oauth_accounts** · **refresh_tokens** (hashed, family id for rotation reuse detection)
- **problems** (id, slug, title, visibility, current_version_id) · **problem_versions** (statement_md, limits json, checker kind, testset_hash, package_uri) · **tags**
- **submissions** (id, user_id, problem_version_id, contest_id?, language, source (≤64 KB), lane, status, verdict, time_ms, mem_kb, created_at) · **judge_runs** (submission_id, run_version, worker_id, started_at, finished_at, verdict) **unique(submission_id, run_version)** · **test_results** (judge_run_id, test_no, verdict, time_ms, mem_kb)
- **contests** (id, slug, starts_at, ends_at, freeze_at, rules json, status) · **contest_problems** (label A–F, points) · **participants** · **clarifications** · **announcements** · **rating_changes**
- **hint_requests** (user, problem, level, prompt_version, response, leaked_flag, helpful) · **reviews** (submission/contest, content, prompt_version, tokens)
- **plag_runs** · **plag_pairs** (score_a, score_b) · **plag_clusters** · **review_decisions** (decision, reviewer, note) · **editor_signals** (advisory telemetry)
- **rooms** (id, owner, problem_id?, status, expires_at) · **room_members** (role) · **room_updates** (seq, ts, user_id, bytes) · **room_checkpoints** · **room_events** (run clicked, verdict, lang change, join/leave) · **interviewer_notes** (never in the Y.Doc) · **room_snapshots**
- **audit_log** (actor, action, target, ts) for every admin action

### 6.3 Contracts (`packages/contracts`)

Core messages (Zod → JSON Schema → Go):

```ts
JudgeJob = { jobId, submissionId, runVersion, lane: 'contest'|'interactive'|'practice'|'rejudge',
  language, source, problem: { versionId, testsetHash, testsetUri, checker, limits:{timeMs,memMb,outputKb} },
  mode: 'submit'|'run', customInput?, stopOnFirstFailure, traceparent, enqueuedAt, seq }
JudgeProgress = { submissionId, runVersion, phase: 'claimed'|'compiling'|'running'|'done',
  workerId, test?: { no, verdict, timeMs, memKb }, ts }
JudgeResult = { submissionId, runVersion, verdict, timeMs, memKb, compileLog?, tests[], workerId, finishedAt }
```

### 6.4 Queue spec (ADR-005)

- Streams: `jobs:contest`, `jobs:interactive`, `jobs:practice`, `jobs:rejudge`; consumer group `judges`.
- **Priority with anti-starvation:** each worker checks lanes in order; every 8th pick starts from the lowest non-empty lane. (Document the ratio; interview talking point.)
- **Lease:** a claimed job stays pending. The worker refreshes it every 2 s (`XCLAIM … JUSTID`, which resets idle time). A reaper runs `XAUTOCLAIM` with min-idle 10 s, so a dead worker's job is re-delivered.
- **Retries/DLQ:** delivery count > 3 → move to `jobs:dlq`, write verdict `SE` (System Error), alert. A job that crashed a worker twice → `jobs:quarantine`.
- **Idempotency:** results go to stream `results`. The API's verdict consumer upserts `judge_runs` on `(submission_id, run_version)`; a duplicate result is a no-op.
- **Queue position/ETA:** every enqueue takes `INCR seq:<lane>`; workers advance `claimed:<lane>` watermarks. Position = jobs ahead in own lane + all jobs in higher lanes. ETA = position × EWMA(service time) ÷ active workers.
- **Redis ACL:** user `judge` may only `XREADGROUP/XACK/XCLAIM/XAUTOCLAIM` on `jobs:*`, `XADD` on `results`, `PUBLISH` on `progress:*`, `SET` on `hb:*`. Nothing else.

### 6.5 Judge spec (ADR-004, ADR-009)

- **Box pool:** N boxes = N cores; each box pinned to one core; boxes are initialised per run and cleaned after.
- **Compile inside a sandbox** too (higher limits, no network, only the source file visible).
- **Run:** `isolate --cg` with `--cg-mem`, `--time`, `--wall-time`, `--extra-time`, `--processes`, `--fsize`, `--stack`, `--open-files`, no network, minimal `--dir` binds, empty env except `PATH`.
- **CPU time is total across all processes/threads** (cgroup mode does this); test with a thread spawner.
- **Reading outputs (Judge0 lesson):** the host never runs `cp`, `chown`, `cat`, or similar on box paths. Output files are opened with `O_NOFOLLOW`, checked with `fstat` to be regular files, read with a size cap, and only then compared.
- **Checkers:** `exact`, `tokens` (default), `float:<eps>`, `testlib` custom checker (compiled once per problem version, also run inside a box).
- **Test cache:** `/var/cache/codearena/tests/<testsetHash>/`, fetched read-only from MinIO, verified by hash.
- **Languages (config file `apps/worker/languages.yaml`):** C (gcc), C++17/20 (g++), Python 3, Java 21, JavaScript (Node). Per-language compile/run commands, memory overhead allowances, and process limits (JVM and Node need more threads).
- **Verdicts:** AC, WA, TLE, MLE, RE, CE, OLE (output limit), SE.

### 6.6 Realtime spec

- `POST /realtime/ticket` → `{ ticket }` (random, 60 s TTL, single use, stored in Redis with user + scopes).
- `GET /sse?ticket=…&topics=sub:<id>,contest:<id>` with `Last-Event-ID` resume (events kept 5 min in a capped stream).
- Channels: `sub:<id>` (progress), `contest:<id>:board` (leaderboard diffs, throttled to 2/s), `contest:<id>:clar` (clarifications/announcements), `sys:status`.

### 6.7 Leaderboard spec

- ICPC rules: rank by solved desc, penalty asc (20 min per wrong attempt before AC, CE excluded), then earliest last-AC time.
- One ZSET per contest, composite score packing (solved, penalty, lastAc). **Bounds must be documented and a unit test must prove the max value < 2^53.**
- Cells: attempts, time of AC, first-solve flag.
- **Freeze:** at `freeze_at` the public board is served from a frozen snapshot; submissions after freeze show as pending (`?`) cells. The internal board keeps updating (admins only).
- **Resolver:** after the contest, cells are revealed one at a time from the bottom rank up; rows animate to their new positions.
- **Rebuild:** `POST /admin/contests/:id/rebuild-board` recomputes from Postgres (drill in O-06).

### 6.8 Security model (summary)

Untrusted judge hosts (ADR-009) · attack suite in CI · OAuth only · refresh token rotation with reuse detection · CSRF protected by SameSite cookies + double-submit token on mutating routes · Zod validation everywhere · per-user rate limits (Redis token bucket): submit 6/min, run 12/min, hints 10/hour · CSP and security headers · CodeQL + Dependabot · audit log for all admin actions · awareness identities in the pad come from the auth context only · private notes never in the shared doc · `.env*` denied to Claude Code via `.claude/settings.json`.

---

## 7. Frontend spec

### 7.1 Design direction: "Instrument panel"

Calm, dense, precise, like a professional tool rather than a toy. Dark-first (light mode fully supported). **No gradients, no glassmorphism, no decorative animation.** Colour is reserved for meaning (verdicts, live state, the brand accent). Motion is used only to show that something changed. The inspiration is how well-made developer tools feel (dense tables, hairline borders, monospace numbers), not any particular product's look.

### 7.2 Design tokens

**Authoritative values: `docs/UI_UX.md` §5.1** (contrast-checked). Three values from the first draft of this plan failed WCAG AA and were replaced there: dark `--text-3` #6B7280 → **#858C97**, dark `--accent` #7C6CFF → **#8B7FFF**, dark `--v-wa` #EF4444 → **#F87171** (and `--v-mle` → #F472B6); light theme gets its own darker verdict colours and `--text-3` #636A75; inputs use a new `--border-control` token (≥ 3:1). Implement tokens by copying UI_UX §5.1 into `apps/web/app/tokens.css`.

- **Type:** Geist Sans (UI), Geist Mono (code, numbers, timers, verdict badges). Tabular numerals everywhere numbers change. Scale 12/13/14/16/20/24/32/48. App UI base 14px; problem statements 16px / 1.7, max 72ch.
- **Spacing:** 4px grid. **Borders:** 1px hairlines; elevation via surface steps, not shadows.
- **Icons:** lucide, 16px, 1.5 stroke.
- **Motion:** 120–180 ms ease-out for UI state; 350 ms spring for leaderboard reorders; a slow pulse only on "judging" state. All of it disabled under `prefers-reduced-motion`.
- **Brand:** wordmark `codearena` in Geist Mono with an accent-coloured caret `▍` that blinks only on the landing page.

### 7.3 App shell

- Left rail (collapsible to icons): Home · Practice · Contests · Interview · Profile · Admin (role-gated).
- Top bar: ⌘K command palette (jump to problem, contest, submission, action), live system dot (green/amber/red from `sys:status`), contest countdown when inside a contest, avatar menu.
- Global shortcuts: `⌘K`, `g p` practice, `g c` contests, `Ctrl+Enter` run, `Ctrl+Shift+Enter` submit, `?` shortcut sheet.

### 7.4 Screens

| # | Screen | Key elements |
|---|---|---|
| 1 | **Landing** | Wordmark, one-line pitch, **live stats from the real system** (submissions judged, contests hosted, p95 verdict time), live anonymised verdict ticker, sections: Practice · Contests · Interview Pad · Under the hood · Security |
| 2 | Sign in / onboarding | Google + GitHub buttons; pick handle, preferred language |
| 3 | Home | Upcoming contest card with countdown, continue-practising list, recent submissions, activity heatmap |
| 4 | Practice list | Dense table: status icon, title, difficulty, tags, acceptance %; filters; search |
| 5 | **Problem workspace** | Resizable split: statement ↔ editor, console drawer; verdict grid; Coach tab (practice only) |
| 6 | **Submission detail** | Verdict header, **journey timeline**, per-test table, code (read-only Monaco), compile log |
| 7 | Contests list | Upcoming / running / past; register button |
| 8 | Contest lobby | Big countdown, rules, problem count, registered count |
| 9 | Contest arena | Problem tabs A–F with solved state, workspace, my submissions, clarifications drawer, freeze banner |
| 10 | **Scoreboard** | Live table with FLIP reorders, cells (attempts/time), first-solve marks, freeze state, **resolver** mode |
| 11 | Post-contest | Editorial links, AI review per submission, rating change, upsolve |
| 12 | Profile | Rating graph, heatmap, solved by tag, contest history |
| 13 | **Interview pad** | Room editor with named cursors, run panel, timer, roles, notes (interviewer only), whiteboard tab |
| 14 | **Playback** | Read-only editor + timeline scrubber with event markers, 1×/2×/4× |
| 15 | Admin · problem setter | Package upload, statement editor with live preview, tests table, "Validate" (runs all reference/wrong solutions and checks expected verdicts) |
| 16 | Admin · contest ops | Queue depth per lane, workers with heartbeat, p95, DLQ, rejudge, extend, broadcast, clarifications inbox |
| 17 | Admin · plagiarism review | Cluster graph, pair list, side-by-side diff, advisory signals, decision buttons |
| 18 | **Status / Under the hood** | Public: live system health, architecture diagram, attack suite results, load test numbers |

### 7.5 Wireframes (the four that matter most)

**Problem workspace**
```
┌────┬──────────────────────────────────────────────────────────────────────┐
│ ▣  │ ⌘K  Search…                               ● Judges OK    ⏱ 01:12:44  │
│ ◇  ├───────────────────────────┬──────────────────────────────────────────┤
│ ◇  │ B · Balanced Ropes         │ [C++20 ▾]  [Reset]     Run ⌃↵  Submit ⌃⇧↵│
│ ◇  │ 1 s · 256 MB · tokens      │                                          │
│ ◇  │ ───────────────────────── │   Monaco (theme matches tokens)          │
│    │ Statement (Markdown+KaTeX) │                                          │
│    │ Input · Output · Notes     │                                          │
│    │ Sample 1   [copy] [→ run]  ├──────────────────────────────────────────┤
│    │ Sample 2   [copy] [→ run]  │ Console │ Tests │ Submissions │ Coach    │
│    │                            │ #2 in queue · ETA ~3 s                   │
│    │                            │ ■■■■■■■□□□□   7/11   AC AC AC … judging  │
└────┴───────────────────────────┴──────────────────────────────────────────┘
```

**Scoreboard (frozen → resolver)**
```
 ICPC Warm-up #1   ● FROZEN  (last 30 min hidden)          [Resolve ▸] (admin)
 #  Handle        Solved  Penalty   A      B      C      D      E      F
 1  riya_k          4      312     ✓12    ✓31    ✓58   +2✓97    ?1     ·
 2  ayush.dev       4      340     ✓9★    ✓40   +1✓72   ✓110    ·      ?2
 3  …
 ★ = first solve · ✓mm = AC at minute · +n = wrong tries · ?n = pending after freeze
```

**Submission journey**
```
 Submission #4821 · B · C++20 · WA on test 7
 ○ Queued 18:02:11.204 (#4 in contest lane)
 ● Claimed by judge-2 (+1.8 s)
 ● Compiled (0.9 s)
 ● Tests 1–6 AC · test 7 WA  (total 2.4 s)
 ● Verdict published (+12 ms)            trace ↗ (admin)
```

**Interview pad**
```
┌ Room: mock-ds-01 · 32:10 left ─────────────── ● Riya (candidate) ● You (interviewer)
│ [Python ▾]   Run ⌃↵   Submit                         Code │ Whiteboard │ Notes 🔒
│  1  def two_sum(nums, t):          ▍Riya                                        │
│  2      seen = {}                                                                 │
├──────────── Output (shared) ─────────────────────────────────────────────────────┤
│ Run #3 by Riya · AC on 3/3 samples · 41 ms                                       │
└──────────────────────────────────────────────────────────── ● Connected (2 users)
```

### 7.6 Signature moments (what makes people say "wow")

1. **Live verdict grid:** one square per test, filling left to right in real time; hover shows time/memory.
2. **Journey timeline:** users see their submission move through the actual system (queue → worker → compile → tests), with real timings. Admins can jump to the trace.
3. **Leaderboard motion:** rows glide to new ranks; a first solve flashes the cell once.
4. **Resolver ceremony:** after the freeze, pending cells reveal one by one from the bottom up; rows climb. Built for projecting on a screen at the end of the contest.
5. **Playback:** scrub through an interview and watch the code being written, with markers for each Run and verdict.
6. **Under the hood page:** live queue depth, workers, p95, and "25/25 attacks blocked" on a public page.

### 7.7 User flows

- **Practice:** Landing → Sign in → Practice list → Workspace → Run samples → Submit → verdict grid → (WA) → Coach hint level 1 → fix → AC → next problem.
- **Contest:** Contests → Register → Lobby countdown → Arena → submit → board updates → freeze banner → end → resolver → post-contest page (AI review, rating change) → upsolve.
- **Interview:** Interview → New room (pick problem or blank, language, duration) → copy invite → candidate joins → code together → Run/Submit → end → playback + notes + AI summary.
- **Setter/admin:** Admin → New problem → upload package → Validate (all expected verdicts ✓) → add to contest → contest-day ops console.

### 7.8 States, feedback, accessibility

- Every async view has skeleton, empty, error (with retry), and offline states. SSE disconnects show a small "Reconnecting…" pill and resume via `Last-Event-ID`.
- Optimistic submission row appears immediately with "Queued".
- Toasts (sonner) only for things the user didn't just see happen.
- WCAG AA contrast, visible focus rings (`--focus`), all actions keyboard-reachable, verdicts always carry text, live regions announce verdicts to screen readers.
- Responsive: full workspace ≥1024px; below that, tabs (Statement / Code / Console). Scoreboard scrolls horizontally inside its own container only.

### 7.9 Frontend architecture

- Server components for public, SEO-relevant pages (landing, problem statements, past scoreboards). Client components for the workspace, arena, pad, and admin.
- TanStack Query for server state; SSE events patch the query cache. Zustand only for local UI state (panel sizes, editor settings).
- Typed API client generated from contracts. All forms: react-hook-form + Zod.
- Monaco loaded lazily with a matching theme built from tokens.

---

## 8. Schedule overview

| Day | Date | Theme | Milestone at end of day |
|---|---|---|---|
| 0 | Wed 30 Sep | Setup | Accounts applied, WSL2 ready, repo scaffolded |
| 1 | Thu 1 Oct | Foundation | Auth works, contracts + DB + CI + design system in place |
| 2 | Fri 2 Oct (holiday) | Judge engine | 5 languages judged in isolate with correct verdicts |
| 3 | Sat 3 Oct | Sandbox hardening + queue | Attack suite green; lanes/leases/DLQ; worker kill = 1 verdict |
| 4 | Sun 4 Oct | Submissions + live UI | Submit from the browser, watch tests fill live |
| 5 | Mon 5 Oct | Deploy + problem setting | Running on Azure + Vercel with CI/CD; setter UI |
| 6 | Tue 6 Oct | Contests | Contest with live board and freeze |
| 7 | Wed 7 Oct | Resolver, ops, observability | **Dry-run contest with 5 friends** |
| 8 | Thu 8 Oct | Load + AI Coach | k6 burst numbers; hint ladder live |
| 9 | Fri 9 Oct | Integrity + freeze | Plagiarism pipeline + eval; contest problems validated; code freeze 11 PM |
| 10 | **Sat 10 Oct** | 🎯 **Contest** | Real contest 7–9 PM, resolver at 9:15 PM |
| 11 | Sun 11 Oct | Post-contest + pad start | Plagiarism/AI reviews on real data; pad with cursors + auth |
| 12 | Mon 12 Oct | Pad core | Persistence, multi-instance, Run/Submit, notes |
| 13 | Tue 13 Oct | Pad advanced + tests | Playback, restore, convergence/chaos/load tests; mock interviews begin |
| 14 | Wed 14 Oct | Stretch + wrap | Offline, whiteboard, AI summary; README, video, metrics |

**Critical path:** F → J → Q → S/UI → D → C → contest. Everything else hangs off it. If a Claude Code usage limit hits, the next card on the critical path always goes first when it resets.

**Daily rhythm (Pro-friendly):** three Claude Code blocks per day aligned with usage windows (morning, afternoon, late evening). Soumirya's tasks for the day are sized to fill the gaps between blocks.

---

## 9. Day-by-day plan

Legend: 🧑 Soumirya · 🤖 Claude Code · 🧠 plan-mode card · ⏱ rough effort.

### Day 0 — Wed 30 Sep · Setup

🧑 **Soumirya**
- **U0.1** Apply for the GitHub Student Developer Pack (LPU email + ID proof). ⏱ 20 min
- **U0.2** Activate Azure for Students with LPU email. Create a budget with alerts at $25/$50/$75. ⏱ 20 min
- **U0.3** Windows setup ⏱ 90 min:
  - `wsl --install -d Ubuntu-24.04`; in `/etc/wsl.conf` add `[boot]\nsystemd=true`; `wsl --shutdown`; reopen and confirm `systemctl` works and `/sys/fs/cgroup/cgroup.controllers` exists (cgroup v2).
  - Docker: Docker Desktop with WSL integration **or** Docker Engine inside WSL (either works; pick one, not both).
  - Inside WSL: git, `nvm` → Node LTS, `corepack enable` (pnpm), Go (latest stable), Python 3.12 + `uv`, `gh` CLI, k6, Terraform, Azure CLI.
  - VS Code + "WSL" extension. **Keep the repo in the Linux filesystem (`~/code/codearena`), never under `/mnt/c`** (much slower, breaks file watching).
  - Install Claude Code **inside WSL**.
- **U0.4** Create accounts: Vercel, Groq, Google AI Studio, Grafana Cloud, Sentry, UptimeRobot. Save keys in a password manager, not in chat. ⏱ 40 min
- **U0.5** Create GitHub repo `codearena` (public). Put `CLAUDE.md` at root; put `PLAN.md`, `PRD.md`, `SRS.md`, `SYSTEM_DESIGN.md`, `UI_UX.md` in `docs/`; research doc at `docs/research.md`. ⏱ 10 min
- **U0.6** Create OAuth apps: Google (Cloud Console) and GitHub. Dev callback `http://localhost:3000/api/auth/callback/<provider>`. ⏱ 30 min
- **U0.7** Message 8–10 friends: "Help me test my coding platform, Wed 7 Oct, 9 PM, 45 min." (dry run). ⏱ 10 min
- **U0.8** In Claude Code run `/model` and see whether Opus is listed for your plan, then try `/model opusplan` once. Edit the `Opus available:` line in CLAUDE.md to `yes` or `no` (§3.7 rule 5). ⏱ 5 min

🤖 **Claude Code** (after U0.3 and U0.5)

#### F-01 · Monorepo scaffold · **S**
- Build: pnpm workspace + Turborepo; `apps/{web,api,worker,collab,plag}`, `packages/{contracts,config}`; shared tsconfig/eslint/prettier; Go module; uv project; lefthook pre-commit (lint-staged, gofmt, ruff); root scripts `pnpm dev`, `pnpm check`, `pnpm test`; `.claude/settings.json` denying reads of `.env*`; `.env.example` for every app; PR template; `docs/PROGRESS.md`.
- Accept: `pnpm i && pnpm check` passes on a clean clone; each app has a hello-world that runs.

#### F-02 · Dev stack (Docker Compose) · **S**
- Build: Postgres 16, Redis 7 (with ACL file), MinIO (+ bucket bootstrap), OTel collector (logs to console in dev). Healthchecks. `scripts/dev-up.sh`.
- Accept: `docker compose up -d` is healthy; API can connect to all services.

---

### Day 1 — Thu 1 Oct · Foundation

🧑 **Soumirya**
- **U1.1** Fill `.env` files from `.env.example` (OAuth IDs/secrets, JWT keys generated by a script Claude writes). ⏱ 20 min
- **U1.2** Review ADRs from F-09 (15 min each is fine). Reply "approved" or raise concerns. ⏱ 60 min
- **U1.3** Read isolate's man page sections INSTALLATION and REPRODUCIBILITY. ⏱ 45 min
- **U1.4** Run `scripts/setup-isolate-wsl.sh` (written in J-00) with sudo. Paste the output of `isolate --version` and the smoke test into the Claude session. ⏱ 20 min
- **U1.5** Explain-back: OAuth flow, refresh-token rotation, why realtime tickets exist. ⏱ 30 min

🤖 **Claude Code**

#### F-03 · Contracts package 🧠 · **P**
- Build: Zod schemas for §6.3 messages + core DTOs; JSON Schema export; quicktype → `apps/worker/internal/contracts`; `pnpm contracts:gen`; CI check that generated files are fresh.
- Accept: changing a Zod field without regenerating fails CI.

#### F-04 · Database schema · **S**
- Build: Drizzle schema for all of §6.2, migrations, seed (admin user, 3 sample problems), `pnpm db:reset`.
- Accept: migrations apply from empty; seed runs; unique `(submission_id, run_version)` enforced.

#### F-05 · API skeleton · **S**
- Build: NestJS modules (auth, users, problems, submissions, contests, realtime, admin, ai, rooms, health); config validated with Zod; RFC 7807 errors; request IDs; pino logs; OTel bootstrap; Redis token-bucket rate-limit guard; OpenAPI served at `/docs` (dev only).
- Accept: `/health` reports DB/Redis/MinIO; error shape consistent; rate limit test passes.

#### F-06 · Auth 🧠 · **O**
- Build: Google + GitHub OAuth; access JWT (15 min, `jose`); refresh cookie (httpOnly, SameSite=Lax, rotation, reuse detection revokes the family); roles; `POST /realtime/ticket`; CSRF double-submit for mutations; `scripts/gen-keys.sh`.
- Accept: integration tests for login, refresh, reuse detection, logout, role guard, ticket single use.

#### F-07 · Design system + app shell · **S**
- Build: tokens (§7.2), Geist fonts, theme toggle, shadcn components restyled to tokens, rail + top bar + ⌘K (cmdk), shortcut sheet, `VerdictBadge`, `VerdictGrid`, `Timer`, `DataTable`, skeleton/empty/error components, `/dev/ui` kitchen-sink route.
- Accept: kitchen sink renders all components in both themes; no hard-coded colours (lint rule or grep check in CI).

#### F-08 · CI · **S**
- Build: GitHub Actions: install → lint → typecheck → unit → integration (Testcontainers) → contracts freshness; Go test; pytest; CodeQL; Dependabot.
- Accept: PR shows all checks; runs under 10 min.

#### F-09 · ADRs · **S**
- Build: ADR-001…015 using a short template (context, decision, alternatives, consequences).
- Accept: Soumirya approves (U1.2).

#### J-00 · isolate setup script for WSL2 · **S**
- Build: `scripts/setup-isolate-wsl.sh` (install build deps or Debian package, enable `isolate.service`, run `isolate-check-environment`, smoke test running `/bin/echo` in a box). Idempotent. Also `infra/cloud-init/judge.yaml` for the VM equivalent.
- Accept: Soumirya runs it (U1.4) and it prints a passing smoke test.

---

### Day 2 — Fri 2 Oct (Gandhi Jayanti, long day) · Judge engine

🧑 **Soumirya**
- **U2.1** Pick the 6 contest problem ideas (difficulty ladder A easy → F hard). Write rough statements in `problems-private/<slug>/statement.md`. Original ideas only; don't copy statements from other platforms. ⏱ 3 h (spread over Claude's gaps)
- **U2.2** Manually submit wrong solutions to fixture problems and confirm each verdict looks right. ⏱ 45 min
- **U2.3** Explain-back: what isolate does with namespaces and cgroups; how TLE vs wall-time differ. ⏱ 30 min

🤖 **Claude Code**

#### J-01 · Box manager (Go) 🧠 · **O**
- Build: box pool (one per core, pinned), init/cleanup, command builder for isolate flags (§6.5), meta-file parser, safe output reader (`O_NOFOLLOW`, `fstat`, size cap).
- Accept: unit tests for meta parsing and flag building; integration test runs a C program in a box.

#### J-02 · Language registry · **S**
- Build: `languages.yaml` for C, C++17, C++20, Python 3, Java 21, JavaScript; compile step inside a box; per-language limits.
- Accept: hello-world AC in every language.

#### J-03 · Checkers + verdict engine · **S·high**
- Build: exact/tokens/float/testlib checkers (testlib compiled and run in a box); verdict logic incl. OLE and SE; `stopOnFirstFailure` flag.
- Accept: golden test per verdict per language (matrix test).

#### J-04 · Test cache + object storage · **S**
- Build: fetch testset from MinIO by hash, verify, cache on disk, LRU eviction.
- Accept: second run of the same problem doesn't hit MinIO (test asserts).

#### J-05 · Worker loop (single lane, temporary) · **S·high**
- Build: consume `jobs:practice`, publish `JudgeProgress` per test and `JudgeResult`; heartbeat key; graceful shutdown (finish current job).
- Accept: end-to-end from `redis-cli XADD` to a result on `results`.

#### J-06 · 20 practice fixture problems · **S**
- Build: 20 original, textbook-style problems (sums, prefix sums, binary search, BFS, DP, greedy…) with statements, generators, reference + wrong solutions (one per verdict type), tests. Stored as problem packages in `problems/`.
- Accept: `scripts/validate-problem` passes for all 20 (every reference solution AC; every wrong solution gets its expected verdict).

---

### Day 3 — Sat 3 Oct · Sandbox hardening + queue

🧑 **Soumirya**
- **U3.1** Read the Judge0 CVE write-ups linked in `docs/research.md` [1][2][18]. Write the 3 design rules in your own words in `docs/interview/notes.md`. ⏱ 60 min
- **U3.2** Continue contest problem statements; send them to Claude for the P-02 card. ⏱ 2 h
- **U3.3** Explain-back: consumer groups, pending entries, XAUTOCLAIM, why the submission ID + run version is the idempotency key. ⏱ 30 min

🤖 **Claude Code**

#### J-07 · Attack suite 🧠 · **O**
- Build: `tests/attack-suite/` with 25+ cases, each with expected verdict/outcome: fork bomb, memory bomb, CPU burner threads (total CPU time), sleep (wall time), disk fill, huge output, stdout flood, symlink to `/etc/passwd` in output file, `/proc` and `/sys` reads, network connect (IPv4/IPv6/DNS), reading another box's files, env variable dump (must contain no secrets), `ptrace`, `setuid`, raw sockets, compile-time `#include "/etc/shadow"` / `/dev/urandom`, template-recursion compiler bomb, huge source, Java/Node thread explosions, zombie processes, signal abuse.
- Accept: `pnpm attack` prints a table; 100% pass. Runs in CI on an Ubuntu runner with isolate installed; if the runner can't run isolate, a nightly workflow runs it on the judge VM over SSH (set up in D-02).

#### J-08 · Hardening fixes · **O**
- Build: whatever J-07 exposes; env scrubbing; non-root worker user where possible; resource caps on the compile step.
- Accept: attack suite green; ADR-009 updated with findings.

#### Q-01 · Lanes + weighted priority · **S**
- Build: four lane streams; anti-starvation rule (§6.4); enqueue service in API with `seq` counters.
- Accept: unit test proves ordering and starvation bound.

#### Q-02 · Leases, retries, DLQ, quarantine 🧠 · **O**
- Build: lease refresh loop, reaper with `XAUTOCLAIM`, delivery-count → DLQ + SE verdict, crash-twice → quarantine; metrics for each.
- Accept: `tests/chaos/kill-worker.sh` (kill -9 mid-judge) → exactly one verdict in Postgres, every time (run 20 times).

#### Q-03 · Verdict consumer + idempotency · **P**
- Build: API consumer reading `results`, upsert `judge_runs`/`test_results`, update submission, publish to `sub:<id>`.
- Accept: replaying the same result 3× changes nothing (test).

#### Q-04 · Redis ACLs · **S·high**
- Build: ACL file with `api` and `judge` users (§6.4).
- Accept: test proves `judge` user can't `GET`/`KEYS`/`FLUSHALL` or touch other keys.

---

### Day 4 — Sun 4 Oct · Submissions + live UI

🧑 **Soumirya**
- **U4.1** Use the workspace for an hour like a real user; log every papercut in a GitHub issue list. ⏱ 60 min
- **U4.2** Finish all 6 contest statements. ⏱ 2 h
- **U4.3** Draft the contest announcement (date, time, rules, prizes if any, "sign in with Google"). ⏱ 20 min
- **U4.4** Explain-back: SSE vs WebSockets, `Last-Event-ID`, queue-position maths. ⏱ 30 min

🤖 **Claude Code**

#### P-01 · Problems API + package import · **S**
- Build: package format (`problem.yaml`, `statement.md`, `tests/`, `checker.cpp?`, `solutions/`, `generators/`, `validator`); CLI `pnpm problem:import <dir>` uploads tests to MinIO and creates a version; problems list/detail endpoints; KaTeX-safe Markdown.
- Accept: 20 fixture problems imported; statement renders with maths.

#### S-01 · Submissions API · **S**
- Build: `POST /submissions` (validate, rate-limit, size cap, choose lane, enqueue), `POST /runs` (custom input, `mode: run`), list/detail endpoints, queue position endpoint.
- Accept: integration test: submit → verdict persisted → detail endpoint shows per-test results.

#### Q-05 · SSE gateway + queue position/ETA · **P**
- Build: `/sse` with ticket auth, topic subscriptions, capped replay stream, heartbeat comments every 15 s; ETA estimator (§6.4).
- Accept: e2e test receives progress events in order; reconnect with `Last-Event-ID` gets missed events.

#### UI-01 · Practice list · **S**
- Build: screen 4 (§7.4) with filters, search, solved state.

#### UI-02 · Problem workspace 🧠 · **P**
- Build: screen 5 + wireframe; resizable panels, Monaco with token theme, language switch (per-problem draft saved in localStorage), Run on samples/custom input, Submit, console tabs, `VerdictGrid` driven by SSE, queue position line, shortcuts.
- Accept: Playwright: open problem → run sample → submit → see AC; keyboard-only path works.

#### UI-03 · Submission detail + journey timeline · **S**
- Build: screen 6 + wireframe; timeline from `JudgeProgress` timestamps.

---

### Day 5 — Mon 5 Oct · Deploy + problem setting

🧑 **Soumirya**
- **U5.1** `terraform apply` (after reading the plan output with Claude). Add GitHub Actions secrets (SSH key, registry token, env values). ⏱ 60 min
- **U5.2** Connect the repo to Vercel; set env vars; add production OAuth callbacks. ⏱ 30 min
- **U5.3** If the Student Pack arrived: claim the `.me` domain and point `@`, `api` DNS records. Otherwise stay on sslip.io. ⏱ 20 min
- **U5.4** Post the contest announcement in class groups; target 30+ registrations (registration on the site opens Day 6). ⏱ 20 min
- **U5.5** Explain-back: why judge VMs have no DB credentials; what the NSG blocks. ⏱ 30 min

🤖 **Claude Code**

#### D-01 · Terraform (Azure) 🧠 · **P**
- Build: resource group, VNet + subnets, NSGs (judge: no public inbound, egress deny except private subnet), API VM, judge VM (`judge_count` variable), static IP, Blob storage for backups, budget resource; outputs; README for Soumirya.
- Accept: `terraform plan` clean; Soumirya applies (U5.1).

#### D-02 · Server provisioning + deploy pipeline · **S**
- Build: cloud-init (Docker, isolate, worker systemd unit, node exporter), Caddy (TLS, `/api` + `/sse` + `/collab` routes, room-hash routing prepared), prod Compose, GH Actions: build images → GHCR → deploy over SSH with health-check and automatic rollback; nightly attack-suite job on the judge VM.
- Accept: merge to `main` deploys; `/health` green in prod; rollback tested once.

#### D-03 · Backups · **S**
- Build: nightly `pg_dump` → Blob; `scripts/restore-test.sh`.
- Accept: restore test passes once.

#### P-02 · Contest problem tooling 🧠 · **P**
- Build: for each of Soumirya's 6 statements: reference solution (C++), alternative solution (Python), brute force, generator(s), validator, checker if needed, 2+ wrong solutions per expected verdict, stress-test script (brute vs reference on 1,000 random cases). Packages in `problems-private/`.
- Accept: `validate-problem` green for all 6; stress tests find no mismatch. Soumirya reviews statements vs tests.

#### UI-04 · Admin: problem setter · **S**
- Build: screen 15; upload package, edit statement with live preview, tests table, "Validate" button showing each solution's expected vs actual verdict.

---

### Day 6 — Tue 6 Oct · Contests

🧑 **Soumirya**
- **U6.1** Create "CodeArena Warm-up #1" (Sat 10 Oct 7–9 PM IST, freeze last 30 min) in the admin UI. Share the registration link. ⏱ 20 min
- **U6.2** Create the dry-run contest (Wed 7 Oct 9 PM, 45 min, 3 fixture problems). ⏱ 15 min
- **U6.3** Explain-back: composite leaderboard score and its 2^53 bound; how the freeze works. ⏱ 30 min

🤖 **Claude Code**

#### C-01 · Contest model + registration · **S**
- Build: contest CRUD (admin), registration, contest-scoped problem visibility (hidden until start), contest lane for submissions, contest clock from the server.
- Accept: problems are invisible before start (test); submissions after end go to practice.

#### C-02 · Leaderboard engine 🧠 · **O**
- Build: §6.7 — ZSET per contest, composite score + bounds test, per-cell state in a hash, board diffs published (throttled), frozen snapshot, rebuild from Postgres, penalty rules (CE excluded).
- Accept: property test: random submission sequences → ZSET ranking equals a slow reference ranking computed from Postgres.

#### C-03 · Scoreboard UI · **S**
- Build: screen 10 + wireframe; FLIP row animation (Motion `layout`), first-solve mark, pending cells, sticky header and handle column, virtualisation for 500+ rows.

#### C-04 · Contest lobby + arena UI · **S**
- Build: screens 8 and 9; countdown synced to server time; freeze banner; problem tabs with solved state.

#### C-05 · Clarifications + announcements · **S**
- Build: ask/answer (private or broadcast), announcement broadcast; realtime via SSE; admin inbox.

---

### Day 7 — Wed 7 Oct · Resolver, ops, observability · Dry run tonight

🧑 **Soumirya**
- **U7.1** 9 PM: run the dry-run contest with 5+ friends. Watch the ops console. Afterward, collect feedback in a form (3 questions). ⏱ 90 min
- **U7.2** Log every bug from the dry run as a GitHub issue with steps. ⏱ 30 min
- **U7.3** Explain-back: a trace from the browser through Redis to the worker (how `traceparent` travels). ⏱ 30 min

🤖 **Claude Code**

#### C-06 · Resolver ceremony · **S**
- Build: admin-driven step-through (space bar = next reveal), auto mode, full-screen presenter view.
- Accept: replay of the dry-run contest resolves to the same final board as the unfrozen board.

#### C-07 · Admin contest ops console · **S**
- Build: screen 16 — lane depths, worker heartbeats, p95 time-to-verdict, DLQ list with re-enqueue, rejudge (submission / problem / contest), extend contest, broadcast.

#### O-01 · Observability 🧠 · **P**
- Build: OTel traces API → Redis (traceparent in `JudgeJob`) → worker spans per phase; metrics (queue depth per lane, time-to-verdict histogram, worker busy ratio, SSE connections, verdict counts); Grafana dashboards as JSON in `infra/grafana/`; alert rules (DLQ > 0, no heartbeat 30 s, p95 > 10 s); Sentry for web + API; UptimeRobot checks documented.
- Accept: one submission shows as a single end-to-end trace in Grafana.

#### O-02 · Status / Under the hood page · **S**
- Build: screen 18 (public): health, live metrics (cached 5 s), architecture diagram, attack suite results (from the last nightly run), load test numbers from `docs/METRICS.md`.

#### UI-05 · Home, contests list, profile (first version) · **S**
- Build: screens 3, 7, 12 (rating graph comes in C-08).

---

### Day 8 — Thu 8 Oct · Load test + AI Coach

🧑 **Soumirya**
- **U8.1** Before the load test: `scripts/scale-judges.sh up 1` (2 judges, the quota maximum; wraps `terraform apply`, Claude can run it with you). After: `scripts/scale-judges.sh to 1`. ⏱ 20 min
- **U8.2** Review hint samples: rate 20 hints as good/bad/leaky. Your labels become part of the eval set. ⏱ 60 min
- **U8.3** Contest reminder message; aim for 30 registered. ⏱ 10 min
- **U8.4** Explain-back: CodeHelp guardrails; what "leak rate" means and how it's measured. ⏱ 30 min

🤖 **Claude Code**

Dry-run bug fixes first (from U7.2 issues), then:

#### O-03 · k6 burst tests · **S**
- Build: `tests/load/` — seed N load-test users (staging-only flag), scenario: 500 submissions in 2 minutes (mix of AC/WA/TLE across languages) + 200 SSE listeners (k6 with the xk6-sse extension, or a small Node script if the extension is a hassle); results written to `docs/METRICS.md` by `scripts/metrics-report`. Run at judge_count 1, 3, and 6 (SD-§2.3 predicts drain times to compare against).
- Accept: METRICS.md has p50/p95 queue wait, time-to-verdict, and burst drain time for each judge count, the measured mean service time per language, and the scale-out time for a new worker.

#### O-04 · Judge scaling runbook · **S**
- Build: `scripts/scale-judges.sh up|down <n>` wrapping Terraform; workers self-register via heartbeat; `docs/runbooks/contest-day.md` draft (§10).

#### O-06 · Failure drills · **P**
- Build: `tests/chaos/` scripts + runbooks in `docs/runbooks/` for: kill a worker mid-judge, kill the api container, restart Redis (then `rebuild-board` and SSE resume), stop a judge VM, a poison submission reaching the DLQ. Each drill records detection time and recovery time.
- Accept: every drill ends with exactly one verdict per submission and a board equal to the Postgres rebuild (SRS NFR-REL-01, FR-BOARD-03); results appended to `docs/METRICS.md`.

#### AI-01 · LLM provider layer · **S**
- Build: provider interface (Groq, Gemini), **per-task model routing with fallback chains and per-model daily token/request budgets (SD-§12.1, §12.3 — Groq's free llama-3.3-70b allows only ~100K tokens/day)**, retries honouring `retry-after`, per-user and global rate limits, token accounting per feature, hint cache, versioned prompt templates in `apps/api/src/ai/prompts/`, async AI job queue (Redis stream `ai:jobs`).
- Accept: switching provider is config-only; tests with a fake provider.

#### AI-02 · Hint ladder 🧠 · **P**
- Build: CodeHelp-style pipeline: sufficiency check → main response (problem + editorial summary + user code + last verdict) → **code-removal pass** → avoid-set scoring; levels: concept / approach / next step; **disabled in rated contests**; practice score penalty (10/25/50%); "Was this helpful?"; everything logged in `hint_requests`.
- Accept: API refuses hints during a running contest for that contest's problems (test).

#### UI-06 · Coach tab · **S**
- Build: ladder UI in the workspace (locked levels, cost shown, helpful buttons).

---

### Day 9 — Fri 9 Oct · Integrity + code freeze

🧑 **Soumirya**
- **U9.1** Final review of all 6 contest problems: statement, samples, limits. Solve A and B yourself on the platform. ⏱ 2 h
- **U9.2** Read `docs/runbooks/contest-day.md` end to end; rehearse the resolver on the dry-run data. ⏱ 45 min
- **U9.3** Write the contest rules page text (includes the advisory telemetry notice and "flagged for review, never auto-banned"). ⏱ 20 min
- **U9.4** **Code freeze at 11 PM.** After this, only P0 fixes until the contest ends. ⏱ —
- **U9.5** Explain-back: winnowing, why obfuscation beats token matching, why embeddings help. ⏱ 30 min

🤖 **Claude Code**

#### UI-07 · Design skills setup · **S**
- Build: `scripts/setup-design-skills.sh` (Emil Kowalski's skills, Impeccable without hooks, hairline; idempotent, project scope), `.gitignore` entries so third-party skill files are not committed, `docs/design-skills.md` (sources, licences, installed versions, what each skill is for, how to reinstall, pre-approved dependencies), CLAUDE.md edits (UI rule, precedence, a short "Design skills" section). No product code.
- Accept: `pnpm check` passes; the script is re-runnable; the PR lists what Soumirya must do for the `taste` analyser.

#### UI-08 · Design direction + audit (read-only, no product code) · **P**
- Build: `/impeccable init` (answer from PRD and UI_UX, ask Soumirya only for gaps), then `/impeccable document`. Screenshot S01–S18 with Playwright at 1280 and 390. Run `/impeccable audit` and `critique`, Emil `review-animations` and `find-animation-opportunities`, `mobile-native` at 390, `break-ui` with worst-case data on S03, S06, S08, S10, S12, S17. If taste is installed, `/taste` https://linear.app and https://vercel.com into `docs/design-refs/` as references. Decide ONE design direction (palette, type, spacing, density, motion, any hairline figures and where) and write `docs/design/DIRECTION.md` (why, in plain language, with the tokens it implies) and `docs/design/AUDIT.md` (findings ranked by severity: screen, fix, owning card). List every new dependency proposed.
- Accept: DIRECTION.md and AUDIT.md exist; every AUDIT item names its owning card (UI-09 to UI-13).

#### UI-09 · Design foundation: tokens, fonts, base components, app shell · **P**
- Build: apply DIRECTION.md to `tokens.css`, fonts, `apps/web/components/ui` and the shell; update any token tests that assert old values (keep: colours only in tokens.css, no gradients) and say so in the PR. Before/after screenshots of S01 and S03 as a pilot.
- Accept: `pnpm check` and the e2e pass; the pilot screens show the new direction.

#### UI-10 · Polish S01–S04 · **S**
- Build: Each: fix that group's AUDIT.md items using /impeccable polish, typeset, layout, harden, clarify, colorize, bolder and delight as the skills judge best, plus emil-design-eng and apple-design for interaction feel; before/after screenshots at 1280 and 390 in the PR; pnpm check and the e2e for touched screens pass.

#### UI-11 · Polish S05–S06 · **S**
- Build: Each: fix that group's AUDIT.md items using /impeccable polish, typeset, layout, harden, clarify, colorize, bolder and delight as the skills judge best, plus emil-design-eng and apple-design for interaction feel; before/after screenshots at 1280 and 390 in the PR; pnpm check and the e2e for touched screens pass.

#### UI-12 · Polish S07–S12 · **S**
- Build: Each: fix that group's AUDIT.md items using /impeccable polish, typeset, layout, harden, clarify, colorize, bolder and delight as the skills judge best, plus emil-design-eng and apple-design for interaction feel; before/after screenshots at 1280 and 390 in the PR; pnpm check and the e2e for touched screens pass.

#### UI-13 · Polish S13–S18 · **S**
- Build: Each: fix that group's AUDIT.md items using /impeccable polish, typeset, layout, harden, clarify, colorize, bolder and delight as the skills judge best, plus emil-design-eng and apple-design for interaction feel; before/after screenshots at 1280 and 390 in the PR; pnpm check and the e2e for touched screens pass.

#### UI-14 · Sync docs to what was built · **S**
- Build: update `docs/UI_UX.md` (§5.1 tokens, screens, "As built" notes), `docs/design/DIRECTION.md` and the README screenshots; confirm UI_UX and the code agree.
- Accept: no token or screen in UI_UX.md differs from the code.

#### UI-15 · Round 2: review of the built UI, direction delta, top-bar wordmark, foundation changes (fonts, colours, materials, shared components, shell) · **P**
- Build: capture the built UI with the existing harness into `docs/design/round2/before/`; run the design skills on it (critique, audit, review-animations, find-animation-opportunities, apple-design, emil-design-eng, mobile-native, break-ui, taste on leetcode.com/problemset/, codeforces.com/contests and linear.app); write `docs/design/ROUND2.md` (what stays, what changes, ranked per screen with owning card, fonts, colours, materials, motion, wordmark, twist, dependencies) and a line at the top of DIRECTION.md. Apply the top-bar wordmark twist (font and colour only in `Wordmark()`, subset font, tokens, contrast tests) and the foundation-level changes; add `scripts/sync-ui-ux.mjs` so UI_UX's token and type blocks are generated, not hand-edited.
- Accept: gate green (lint, typecheck, unit incl. drift tests, full e2e with axe in both themes, detector 0 findings); before/after of the top bar and two screens; ROUND2.md read by Soumirya.

#### UI-16 · Landing S01, round 2 · **P**
- Build: the landing page per ROUND2.md: a hero that plays one real-timed verdict journey, the live verdict ticker (`GET /api/status/verdicts`, approved by Soumirya 2026-10-10), the proof as numerals, the 500-run verdict mix, a framed sample board. Only real numbers from `docs/METRICS.md`; no gradients.
- Accept: gate green; before/after at 1280 and 390.

#### UI-17 · Round 2 screens S02–S06 · **S**
- Build: ROUND2.md's list for S02 to S06, **including "the wire"** (a thin segmented line under the Submit button on S05 and on the S03 Recent submissions rows, driven by the real submission events and settling into the verdict colour; approved by Soumirya 2026-10-10); tier-coloured handles; before/after at 1280 and 390 in the PR.
- Accept: gate green for the touched screens.

#### UI-18 · Round 2 screens S07–S12 · **S**
- Build: ROUND2.md's list for S07 to S12, **including "the wire" on the board rows** (S10; needs a per-row live subscription: capped, none when the tab is hidden; approved by Soumirya 2026-10-10); tier-coloured handles; before/after at 1280 and 390.
- Accept: gate green for the touched screens.

#### UI-19 · Round 2 screens S13–S18, then sync docs and README screenshots · **S**
- Build: ROUND2.md's list for S13 to S18; then sync `docs/UI_UX.md` (run the sync script), `apps/web/DESIGN.md`, `docs/design/DIRECTION.md` "As built" and the README screenshots. Unblocks the W-02 demo footage.
- Accept: gate green; UI_UX, DESIGN.md and the code agree (drift tests).

#### AI-03 · Post-contest review · **S**
- Build: reviews of each participant's final submission per attempted problem (complexity, missed edge cases, intended-approach comparison, readability), **generated on demand when opened plus a paced background job within the daily budget** (SD-§12.3); review page UI (S11) with ready / generating / queued states.

#### AI-04 · Leak-rate eval 🧠 · **P**
- Build: `apps/api/eval/hints/` — 60+ prompts (incl. adversarial "just give me the code", role-play, code-completion tricks), plus Soumirya's labels; automatic leak detector (code-block/AST heuristics + LLM judge), report leak rate with vs without code-removal pass → `docs/METRICS.md`.

#### PL-01 · Normalisation + winnowing (Python) · **S·high**
- Build: tree-sitter parse (C, C++, Python, Java, JS), canonical identifier renaming, strip comments/dead code/formatting, k-gram hashing, winnowing fingerprints, candidate pairs above a threshold.

#### PL-02 · Embeddings + clustering · **S**
- Build: UniXcoder embeddings (CPU), cosine similarity for candidates and for a nearest-neighbour sweep; combined score; clusters via connected components over high-confidence edges; results posted to `POST /admin/plag/runs/:id`.

#### PL-03 · Labelled eval set · **S**
- Build: generator for obfuscated variants (renames, reordering independent statements, dead-code insertion, loop rewrites, helper extraction) over the 20 fixture problems' solutions + independent solutions as negatives; report precision/recall for Stage A vs A+B → `docs/METRICS.md`.

#### PL-04 · Review UI · **S**
- Build: screen 17 — cluster graph, pair list sorted by score, Monaco diff side by side, advisory signals panel, decisions (clear / confirm / needs discussion) → `review_decisions` + audit log.

#### IN-01 · Advisory behavioural signals · **S**
- Build: editor telemetry in contests (large paste events with size, time from problem open to AC, style-shift score vs the user's own history); shown in the review UI clearly labelled **advisory only**.

#### IN-02 · Canary text toggle · **S**
- Build: optional, off by default, per-problem hidden instruction text that an LLM would follow; detection rule; the review UI marks it as a weak signal. ADR noting trade-offs (accessibility, screen readers).

---

### Day 10 — Sat 10 Oct · 🎯 Contest day

🧑 **Soumirya** (follow §10 exactly)
- **U10.1** 2:00 PM: scale judges up; run the pre-flight checklist.
- **U10.2** 6:30 PM: open lobby; post the link.
- **U10.3** 7:00–9:00 PM: run the contest from the ops console; answer clarifications.
- **U10.4** 9:15 PM: resolver ceremony (screen-share or project).
- **U10.5** 10:00 PM: scale down; export metrics; post thanks + feedback form.

🤖 **Claude Code** — on standby for P0 fixes only. After 10 PM:

#### C-08 · Ratings · **S·high**
- Build: Elo-style rating update (documented formula, deterministic, recomputable), rating changes table, profile rating graph.
- Accept: recomputing twice gives identical ratings.

---

### Day 11 — Sun 11 Oct · Post-contest + pad begins

🧑 **Soumirya**
- **U11.1** Run the plagiarism pipeline on contest data; review every flagged cluster yourself; record decisions. ⏱ 60 min
- **U11.2** Write a short incident/retro note: what broke, what held, numbers. ⏱ 45 min
- **U11.3** Recruit 5–10 people for mock interviews on Tue 13 and Wed 14 (30–40 min each). ⏱ 20 min
- **U11.4** Explain-back: OT vs CRDT; how Yjs orders concurrent inserts. ⏱ 45 min

🤖 **Claude Code**

#### W-00 · Contest metrics report · **S**
- Build: `scripts/metrics-report` extended with contest stats (participants, submissions, peak/min, p50/p95, verdict mix, workers, DLQ count, plagiarism clusters flagged, AI reviews generated/cost) → `docs/METRICS.md`.

#### CP-01 · Collab service 🧠 · **P**
- Build: Hocuspocus server in `apps/collab`; `onAuthenticate` verifies realtime ticket → user + role; `readOnly` for observers; token-expiry check in `beforeHandleMessage`; awareness identity overridden from auth context.
- Accept: tests: bad ticket rejected; observer edits ignored; spoofed awareness name is replaced.

#### CP-02 · Rooms + pad UI · **S**
- Build: room model and API (create, signed expiring invite, close/revoke), screen 13 + wireframe: y-monaco binding, named coloured cursors, synced language, room timer, connection badge, member list with roles.
- Accept: Playwright with two browser contexts: both see each other's edits and cursors.

---

### Day 12 — Mon 12 Oct · Pad core

🧑 **Soumirya**
- **U12.1** Test the pad with one friend for 20 minutes; log issues. ⏱ 30 min
- **U12.2** Email one faculty member or lab TA offering CodeArena for a programming lab (auto-grading + plagiarism reports). Attach the contest stats. ⏱ 30 min
- **U12.3** Explain-back: why the Redis extension doesn't reduce CPU load, and what room-hash routing fixes. ⏱ 30 min

🤖 **Claude Code**

#### CP-03 · Persistence + multi-instance · **P**
- Build: Database extension (fetch/store `BYTEA`, debounce ~2 s, flush on last disconnect), Redis extension, 2 collab instances, Caddy `/collab/<roomId>` routed by URI hash.
- Accept: chaos test: kill instance mid-edit → clients reconnect, no edits lost.

#### CP-04 · Run/Submit from the pad · **S**
- Build: interactive lane jobs from rooms, per-room rate limit (1 run / 2 s), run IDs, shared output via stateless broadcast; events logged.
- Accept: both users see the same verdict; a contest load doesn't delay pad runs beyond the priority rule (test with synthetic load).

#### CP-05 · Private notes · **P**
- Build: interviewer notes as a separate API resource (never in the Y.Doc), autosave, visible only to the interviewer role.
- Accept: test that a candidate token can't read notes by any route.

---

### Day 13 — Tue 13 Oct · Pad advanced + tests · Mock interviews begin

🧑 **Soumirya**
- **U13.1** Host 3–5 mock interviews (you as interviewer or swap roles). ⏱ 2–3 h
- **U13.2** Watch two playbacks; note what felt off. ⏱ 30 min
- **U13.3** Explain-back: playback and fast seeking; restoring a version without breaking other clients. ⏱ 30 min

🤖 **Claude Code**

#### CP-06 · Update log + playback 🧠 · **P**
- Build: log every update (seq, ts, user, bytes) and events via `onChange`/hooks; checkpoints every N updates; screen 14: fresh `Y.Doc` replay with 1×/2×/4×, scrubber with event markers, seek = nearest checkpoint + replay forward.
- Accept: **replay fidelity test**: full log replay equals the stored final doc for 20 random sessions.

#### CP-07 · Snapshots + version restore · **P**
- Build: `gc: false` for room docs, session length cap, snapshots at events (each Run), restore via anti-operation (apply the diff that undoes changes since the snapshot) rather than replacing state; archive + compact after room close.
- Accept: restore while another client is typing converges for both.

#### CP-08 · Test suite · **S**
- Build: convergence property test (3–5 docs, random concurrent edits and delivery order, fast-check), Playwright two-context e2e (cursors, roles, notes privacy), chaos (kill instance), load script (N rooms × 2–4 simulated typists) measuring p95 edit-propagation latency, memory per room, CPU per instance → `docs/METRICS.md`.

---

### Day 14 — Wed 14 Oct · Stretch + wrap

🧑 **Soumirya**
- **U14.1** Host the remaining mock interviews. ⏱ 2 h
- **U14.2** Record the demo video (script from W-02): contest replay + resolver, sandbox blocking a fork bomb, live verdict grid, trace in Grafana, plagiarism cluster, hint ladder, pad with playback. ⏱ 90 min
- **U14.3** Rewrite `docs/interview/answers.md` in your own words; fill the resume bullet with measured numbers. ⏱ 90 min

🤖 **Claude Code**

#### CP-09 · Offline editing · **S**
- Build: y-indexeddb persistence, offline banner, merge on reconnect; demo script.

#### CP-10 · Whiteboard · **S**
- Build: whiteboard tab with strokes in a `Y.Array` (perfect-freehand rendering), shapes: pen, rectangle, arrow, text, eraser; included in playback.

#### CP-11 · AI interview summary · **S**
- Build: reuses AI-01 pipeline: summary of the session (approach, complexity, communication moments from event log, bugs fixed) visible only to the interviewer.

#### ED-01 · Code completion · **S**
- Build: keyword, library-name and snippet suggestions in every editor (`apps/web/lib/completions/`: per-language data, one provider per Monaco language, an on/off switch per editor); per-contest rule `suggestions` (organiser, before the start; no migration) and a per-room switch the interviewer can flip live (`rooms.suggestions`, migration 0012, `PATCH /api/rooms/{id}/settings`, SSE `room.settings`). A convenience applied by the browser, not an integrity control.
- Accept: typing `whi` offers `while` and Tab inserts the snippet (C++, C, Java, Python, JS); a contest with the rule off never opens the list, Ctrl+Space included; in a room the interviewer's switch reaches the candidate's editor live; practice is unaffected by either.

#### W-01 · README + docs · **S**
- Build: README (pitch, GIFs, architecture Mermaid, metrics table from METRICS.md, security section, how to run locally), `docs/interview/answers.md` first draft for §13 of the research doc + §6.13, ADR index.

#### W-02 · Demo script + final metrics · **S**
- Build: shot list for the video; final `docs/METRICS.md`; resume bullet template filled with real numbers only.

---

## 10. Contest-day runbook (Sat 10 Oct)

**T-5 h (2:00 PM)**
- [ ] `scripts/scale-judges.sh up 1` → both judges (the most this subscription's quota allows) show heartbeats in the ops console
- [ ] Nightly attack suite green; `/health` green; Grafana alerts armed
- [ ] Backup taken manually; restore test from last night passed
- [ ] Run all 6 problems' Validate again in prod
- [ ] Submit a warm-up run in each language on prod

**T-30 min (6:30 PM)**
- [ ] Open lobby; post link; pin rules
- [ ] Ops console open on one screen, Grafana on another, clarifications inbox open
- [ ] Hints confirmed disabled for contest problems (try one)

**During (7:00–9:00 PM)**
- Watch: lane depth, p95, DLQ, worker heartbeats. If p95 > 10 s for 2 min and only 1 judge runs → `scale-judges.sh up 1 --allow-running-contest` (opens the judge firewall for a few minutes; see the runbook).
- DLQ entry → inspect, re-enqueue once; if it repeats, rejudge the submission after the contest.
- Wrong test data discovered → fix package → rejudge that problem → announce.
- A judge VM dies → the reaper re-delivers its jobs; confirm in the console.
- Redis dies → restart; `rebuild-board`; announce "board refreshed".

**After**
- [ ] 9:00 Freeze remains; 9:15 resolver ceremony
- [ ] 9:45 Finalise contest → ratings (C-08) → AI reviews queued
- [ ] 10:00 `scale-judges.sh to 1`; export metrics; feedback form
- [ ] 11:00 Start plagiarism run (review tomorrow, U11.1)

---

## 11. Testing and quality gates

| Layer | Tooling | Gate |
|---|---|---|
| Unit | Vitest, go test, pytest | Every PR |
| Integration | Testcontainers (Postgres, Redis, MinIO) | Every PR |
| Contract | Zod → JSON Schema freshness | Every PR |
| E2E | Playwright (practice flow, contest flow, pad two-context) | Every PR touching web |
| Sandbox | Attack suite | Every PR touching worker + nightly on judge VM |
| Chaos | kill-worker, kill-collab, restart-redis | Before Day 7 and Day 13 |
| Property | Leaderboard vs reference ranking; CRDT convergence | Every PR touching them |
| Load | k6 burst; pad typists | Day 8, Day 13 |
| Evals | Hint leak rate; plagiarism precision/recall | Day 9, re-run on prompt/pipeline change |

---

## 12. Metrics and evidence (becomes the resume)

`docs/METRICS.md` is generated, never hand-edited. It must end the project with:

- Total submissions judged; peak submissions/min; contests hosted; unique participants
- p50/p95 queue wait and time-to-verdict (k6 at 1 and 3 workers; real contest)
- Worker throughput; scale-out time for a new judge VM
- Attack suite: N cases, % blocked
- Plagiarism: precision/recall (Stage A vs A+B); clusters flagged/confirmed in the real contest
- AI Coach: leak rate before/after code-removal pass; hints used; helpful %; cost per contest
- Pad: p95 edit propagation latency at N rooms; reconnect recovery time; doc size per 45-min session; mock interviews hosted

**Resume bullet (fill with measured numbers only):**
> Built CodeArena, a distributed online judge (Next.js, NestJS, Go, Redis Streams, Postgres, isolate); sustained **N submissions/min** across **M sandboxed workers** with p95 verdict in **X s**; hosted **K contests for P students**; blocked **25/25** sandbox attacks; flagged plagiarism clusters via AST-normalised winnowing + code embeddings (precision **Z%**); AI hint pipeline leak rate cut from **A%** to **B%**; real-time CRDT interview pad with session playback (**Q** mock interviews).

---

## 13. Risks and contingencies

| Risk | Signal | Response |
|---|---|---|
| **Pro usage limits slow the build** (the biggest risk to a 14-day schedule) | Hitting limits before finishing a day's critical-path cards | Critical-path cards always first; Soumirya's tasks fill cooldowns; keep sessions to one card; follow the model tags (§3.7) so Opus is spent only on the 21 P/O cards; if the weekly cap blocks the critical path before Day 9, consider Max 5x for these two weeks, or let the non-critical tail run into Days 15–17. **Scope stays the same either way.** |
| isolate misbehaves in WSL2 | J-00 smoke test fails | Use a small Azure Linux VM as the dev judge from Day 2 (worker connects to local Redis via SSH tunnel) |
| Student Pack not approved in time | No domain by Day 5 | sslip.io + Vercel domain (already the default plan) |
| Azure region/size blocked by subscription policy | Terraform error | Pick an allowed region; document the latency |
| Fewer than 20 contest participants | < 20 registrations on Day 8 | Ask each registered friend to bring one person; ask a class representative to forward; move start to 8 PM if that helps |
| Wrong test data mid-contest | Clarifications/complaints | Stress tests (P-02) make this unlikely; rejudge flow is ready |
| Groq/Gemini free-tier limits | 429s | AI jobs are queued and retried; hints degrade to "try again in a minute" |
| Scope creep during the build | Card grows | Finish the card, write a follow-up card, keep going |

---

## 14. What this plan adds beyond the research doc

1. **Resolver ceremony** for unfreezing the board (ICPC-style), built for a live screen.
2. **Submission journey timeline** in the product and **end-to-end traces** (traceparent carried inside the queue job).
3. **Public "Under the hood" status page** with live queue depth, attack-suite results, and load numbers.
4. **Custom checkers (testlib) and problem validation** (every reference and wrong solution must get its expected verdict), plus a stress-test harness per problem.
5. **Weighted lane priority with a starvation bound**, Redis **ACLs** for judge hosts, and **refresh-token reuse detection**.
6. **Clarifications and announcements**, rejudge tools, and a contest ops console: what real contests need.
7. **Ratings** with a documented, recomputable formula.
8. **Contracts pipeline** (Zod → JSON Schema → Go) so three languages can't drift.
9. **Terraform-managed scaling** as the Phase 1 autoscaling story (KEDA stays the documented upgrade).
10. **Explain-back checkpoints** so every component is interview-defensible.
