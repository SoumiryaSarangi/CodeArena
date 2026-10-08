# CodeArena — Product Requirements Document (PRD)

| | |
|---|---|
| **Doc** | `docs/PRD.md` · v1.0 · 30 Sep 2026 |
| **Owner** | Ayush (product, admin, problem setter) |
| **Builder** | Claude Code |
| **Status** | Approved for build (Day 0) |
| **Companion docs** | `docs/PLAN.md` (schedule + task cards) · `docs/SRS.md` (requirements, API) · `docs/SYSTEM_DESIGN.md` (architecture) · `docs/UI_UX.md` (design) · `docs/research.md` (background research) |

> **For Claude Code:** this doc answers *what* and *why*. Stories are `US-<epic>.<n>`; each maps to SRS requirements (`FR-…`) and PLAN task cards. Read only the epic your card points to.

---

## 1. Summary

CodeArena is a campus-scale online judge and contest platform. Students practise problems, compete in live ICPC-style contests with a real-time leaderboard, get non-spoiling AI hints and post-contest code reviews, and run mock interviews in a shared code editor that executes code on the same judge. Organisers get a problem-setting toolkit, a live contest operations console, and a plagiarism review workflow that flags suspicious clusters for humans to decide.

It is built to production standards (sandbox security, queueing under burst load, observability, measured AI quality) because it is also its owner's flagship engineering project for placement interviews.

---

## 2. Problem

| # | Who hurts | Problem today | Evidence |
|---|---|---|---|
| P1 | Students preparing for placements | Big platforms are great for practice but useless for *your* class: no campus contests, no shared leaderboard with peers, no mentor-style help that doesn't hand over the answer | Hint features on big platforms are either absent or reveal solutions |
| P2 | Campus contest organisers (clubs, TAs) | Running a contest means juggling Google Forms, manual grading, or external platforms with no control over timing, problems, or data | Public judges queue submissions for 20–30 minutes at busy times (research §4.2, refs 22–23) |
| P3 | Organisers after a contest | No practical way to check for copied code; MOSS sends code to external servers and has usage limits; detectors for AI-written code are unreliable | research §5.1–5.2 (refs 7, 29, 31, 34, 35) |
| P4 | Students practising interviews | Pair mock interviews happen in Google Docs or paid tools; no way to run code, no playback to learn from | CoderPad-class tools are paid, enterprise-focused (research §6.1) |
| P5 | Faculty running programming labs | Manual grading of lab programs; no plagiarism report | research §11 |

---

## 3. Vision and positioning

**Vision:** *The place your campus codes together — practise, compete, and interview, on a judge you can trust.*

**Positioning statement:** For students and organisers on a campus who want to practise and compete together, CodeArena is a self-hosted online judge that runs real contests with a live, fair leaderboard, teaches with hints that never spoil, and keeps contests honest with human-reviewed plagiarism checks. Unlike public judges, it is owned by the campus: its problems, its timing, its data, and its people.

**Product principles** (used to break ties in every decision):
1. **Fairness first.** Same limits for everyone, transparent rules, no auto-punishment.
2. **Show the system.** Users see where their submission is and why (queue position, per-test progress, journey).
3. **Teach, don't tell.** AI helps you think; it never writes the solution.
4. **Humans decide.** Algorithms flag, people judge.
5. **Calm, fast, precise UI.** A tool, not a toy.

---

## 4. Users

### 4.1 Personas

| ID | Persona | Context | Goals | Frustrations |
|---|---|---|---|---|
| **PE1** | **Riya — placement-prep student** (3rd year) | Practises 1–2 h/day, mostly C++/Python | Build consistency, get unstuck without spoilers, track progress | Editorials give away everything; no peer benchmark |
| **PE2** | **Arjun — contest regular** (club member) | Codeforces-rated, competes weekly | Fair, fast contests; live standings; rating | Slow queues; unclear verdicts; boring standings |
| **PE3** | **Ayush — organiser / setter / admin** | Runs the platform and contests | Create problems safely, run a smooth contest, catch cheating fairly | Bad test data, judge outages, no visibility during contests |
| **PE4** | **Mentor-interviewer** (senior student) | Runs mock interviews for juniors | A shared editor that runs code; notes; replay to give feedback | Screen sharing is clumsy; no replay |
| **PE5** | **Candidate** (junior student) | Practising interviews | Realistic interview feel; feedback | Anxiety; tools that break mid-session |
| **PE6** | **Faculty / lab TA** (future) | Runs weekly programming labs | Auto-grading and plagiarism reports | Manual checking |

### 4.2 User classes and permissions (summary; full matrix in SRS §2.3)

Guest · User · Contestant (User registered for a contest) · Setter · Admin · Interviewer / Candidate / Observer (per-room roles).

### 4.3 Jobs to be done

- *When I'm stuck on a problem, I want a nudge in the right direction so I can still solve it myself.* (PE1)
- *When a contest is running, I want to know exactly where I stand and what's happening to my submission.* (PE2)
- *When I'm preparing a contest, I want proof that my tests and solutions are right before anyone sees them.* (PE3)
- *When the contest ends, I want to know if anyone copied, without accusing innocent people.* (PE3)
- *When I run a mock interview, I want to watch how the candidate got to the answer, not just the final code.* (PE4)

---

## 5. Competitive landscape

| Product | What it is | Strengths | Gaps for our users | What we borrow |
|---|---|---|---|---|
| Codeforces | Public contest platform | Huge problem set, open rating formula, testlib ecosystem | No campus-private contests with own timing/data; queue delays at peak | ICPC-style rules, open rating approach, testlib checkers |
| LeetCode | Interview-prep practice | Polished editor, interview focus | Not a contest host for your campus; hints are problem-level, not code-aware | Workspace layout conventions |
| HackerRank / HackerEarth | Assessment + hiring platforms | Hiring workflows, proctoring | Enterprise-oriented; not for student-run contests | Admin workflows |
| CodeChef / AtCoder | Contest platforms | Regular contests, clear rules | Same as Codeforces | Contest rules clarity |
| DMOJ / DOMjudge / CMS | Open-source judges | Proven judge architectures | Heavy to operate, dated UX, no AI/pad | Site–bridge–judge split; isolate sandbox (CMS) |
| Judge0 | Code-execution API | Easy integration | 2024 sandbox-escape CVEs; not a contest product | The security lessons (research §4.1) |
| CoderPad | Live interview pad | Collaborative IDE, playback, notes | Paid, enterprise | Playback + private notes pattern |

**Our differentiators:** campus-owned contests · transparent judging (queue position, live per-test progress, journey timeline) · non-spoiling, measured AI Coach · human-in-the-loop plagiarism with evidence · interview pad wired to the same judge and problem bank · a public "under the hood" page with live health and security results.

---

## 6. Goals, non-goals, success metrics

### 6.1 Goals

| ID | Goal |
|---|---|
| G1 | Host a real ICPC-style contest for 20+ students on Sat 10 Oct 2026 with zero lost verdicts |
| G2 | Make judging transparent and fast: users always know where their submission is |
| G3 | Help practising students without spoiling solutions, and prove it with a leak-rate metric |
| G4 | Keep contests fair with a flag-and-review plagiarism workflow with measured precision/recall |
| G5 | Provide a reliable mock-interview pad with playback, used for 5–10 real sessions |
| G6 | Meet production engineering standards (security, observability, CI/CD) that hold up in interviews |

### 6.2 Non-goals (explicitly out of scope)

| ID | Non-goal | Why |
|---|---|---|
| NG1 | Team accounts (3-person ICPC teams) | Individual contests only for v1; data model leaves room |
| NG2 | IOI-style partial scoring / subtasks | ICPC binary scoring only; checker `_pc` treated as WA |
| NG3 | Interactive problems (judge ↔ program dialogue) | Complex sandbox plumbing; document as future work |
| NG4 | Video/voice in the interview pad | Use Google Meet alongside |
| NG5 | Native mobile apps | Responsive web only; contests expected on laptops |
| NG6 | Claiming "AI-written code detection" | Research shows detectors are unreliable; we only show advisory signals |
| NG7 | Automatic bans or penalties from plagiarism scores | Humans decide |
| NG8 | Payments, public sign-up marketing, multi-tenant organisations | Campus scale |
| NG9 | Proctoring (webcam, screen capture) | Invasive; out of scope |

### 6.3 Success metrics

**North-star metric:** *Verdicts delivered to real users with p95 time-to-verdict under target* (combines usage and reliability).

| ID | Metric | Target (by 14 Oct) | Source |
|---|---|---|---|
| M1 | Contest participants (Warm-up #1) | ≥ 20 | DB |
| M2 | Participants with ≥ 1 AC in the contest | ≥ 80% | DB |
| M3 | Lost or duplicated verdicts | 0 | Chaos tests + contest audit |
| M4 | p95 time-to-verdict during the real contest | ≤ 15 s | OTel histogram |
| M5 | Sandbox attack suite | 100% blocked (25+ cases) | CI |
| M6 | System Usability Scale (SUS) from contest feedback form | ≥ 75 | Feedback form (10 standard SUS items) |
| M7 | Hint leak rate after code-removal pass | ≤ 2% on the eval set (and reported before/after) | AI eval harness |
| M8 | Hints rated helpful | ≥ 60% of rated hints | `hint_requests.helpful` |
| M9 | Plagiarism precision at the chosen threshold | ≥ 0.9 on the labelled set (reported with recall) | PL eval |
| M10 | Mock interviews hosted | 5–10 | `rooms` |
| M11 | Pad replay fidelity | 100% of sessions replay to the exact final doc | CP-08 test |
| M12 | Time from landing to first submission for a new user | ≤ 2 min median | product events |

**Guardrail metrics (must not regress):** error rate on API < 1%; SSE reconnect success > 99%; zero secrets in logs; Azure spend within budget alerts.

---

## 7. Scope overview (epics)

Priority: **P0** = required for the Day 10 contest · **P1** = required for "done" on Day 14 · **P2** = planned stretch (scheduled Day 14).

| Epic | Name | Priority | PLAN tasks |
|---|---|---|---|
| E1 | Accounts and identity | P0 | F-06, UI-05 |
| E2 | Practice | P0 | P-01, S-01, UI-01..03 |
| E3 | Judging and transparency | P0 | J-01..08, Q-01..05 |
| E4 | Contests and leaderboard | P0 | C-01..07 |
| E5 | Problem setting | P0 | P-01, P-02, UI-04 |
| E6 | Contest operations | P0 | C-07, O-01, O-04 |
| E7 | Ratings and profiles | P1 | C-08, UI-05 |
| E8 | AI Coach | P1 | AI-01..04, UI-06 |
| E9 | Integrity (plagiarism + signals) | P1 | PL-01..04, IN-01..02 |
| E10 | Interview pad | P1 (P2 for offline, whiteboard, AI summary) | CP-01..11 |
| E11 | Transparency and trust (status page) | P1 | O-02 |
| E12 | Platform quality (security, reliability, a11y) | P0 | J-07, O-*, D-* |

---

## 8. User stories and acceptance criteria

Format: **As a** … **I want** … **so that** …, then acceptance criteria (AC) in Given/When/Then form. "Must" means the story fails without it.

### E1 — Accounts and identity

**US-1.1 · Sign in with Google or GitHub** (P0)
As a student, I want to sign in with an account I already have, so that I don't create another password.
- AC1: Given I'm signed out, when I click "Continue with Google" and consent, then I land on onboarding (first time) or my previous page (returning).
- AC2: No password field exists anywhere in the product.
- AC3: If OAuth fails or I cancel, I see a plain-language error with a retry button, not a stack trace.

**US-1.2 · Choose a handle** (P0)
As a new user, I want to pick a public handle, so that I appear on leaderboards under a name I choose.
- AC1: Handle rules shown inline: 3–20 chars, `a–z 0–9 _ .`, starts with a letter, unique (case-insensitive).
- AC2: Availability check responds while typing (debounced); reserved words (admin, root, codearena…) rejected.
- AC3: I also pick a default language (pre-selected in the editor).

**US-1.3 · Stay signed in safely** (P0)
- AC1: Sessions last up to 30 days of inactivity without re-login; closing the browser doesn't sign me out.
- AC2: "Sign out" ends the session on this device; "Sign out everywhere" (profile settings) revokes all sessions.

**US-1.4 · Delete my account** (P1)
- AC1: From settings, I can request deletion; my handle is replaced with `deleted-user-<n>` on past standings; my code and personal data are deleted within 7 days (contest rankings keep the anonymised row for integrity).

### E2 — Practice

**US-2.1 · Browse problems** (P0)
As Riya, I want to find problems by difficulty, tag, and status, so that I practise what I need.
- AC1: List shows status (solved / attempted / new), title, difficulty (800–3000 scale, shown as label + number), tags, acceptance %.
- AC2: Filters combine (AND); search matches title and tags; URL reflects filters (shareable).
- AC3: Contest problems appear in practice only after their contest ends.

**US-2.2 · Read a problem** (P0)
- AC1: Statement renders Markdown with LaTeX (KaTeX), samples with copy buttons, limits (time, memory), and the checker type in plain words ("any valid answer accepted", "floating-point tolerance 1e-6").
- AC2: Per-language time limits are shown when multipliers apply.

**US-2.3 · Write and run code** (P0)
As Riya, I want to run my code on samples or my own input before submitting, so that I catch mistakes cheaply.
- AC1: Editor keeps my draft per problem and language across reloads (local only).
- AC2: "Run" executes on selected samples or custom input and shows stdout, stderr (truncated at 64 KB), time, memory, and a diff vs expected for samples.
- AC3: Runs never count as submissions and never affect scores.

**US-2.4 · Submit and see progress live** (P0)
As Arjun, I want to see my submission progress test by test, so that I'm never staring at a spinner.
- AC1: After Submit, a row appears immediately with "Queued · #N · ETA ~Xs".
- AC2: Within the same view, a grid fills one square per test as each finishes (colour + label).
- AC3: Final verdict shows the first failing test number (hidden tests' content stays hidden), time, and memory.
- AC4: If my connection drops, reconnecting shows all events I missed, without a page reload.

**US-2.5 · See my submission history** (P0)
- AC1: Per problem and globally; filter by verdict/language; each row links to the submission detail page.

**US-2.6 · Understand a compile error** (P0)
- AC1: CE shows the compiler output (truncated at 16 KB) with line numbers clickable to jump in my editor.

### E3 — Judging and transparency

**US-3.1 · Fair and correct verdicts** (P0)
- AC1: Verdicts AC, WA, TLE, MLE, RE, CE, OLE, SE exist and each has a one-line explanation (UI_UX §10.2).
- AC2: Time counts CPU time across all threads/processes; wall-clock is capped separately to catch sleeping programs.
- AC3: A program can't read other submissions, the network, or system files; attempting it yields RE or no effect.

**US-3.2 · Queue position and ETA** (P0)
- AC1: While queued, I see my position and an ETA that updates at least every 2 s.
- AC2: ETA accuracy: within ±50% of actual for 80% of submissions in the load test (reported, not a hard gate).

**US-3.3 · Submission journey** (P1)
As a curious user, I want to see the steps my submission took, so that I trust the judge.
- AC1: Detail page shows: queued (lane, position), claimed (by which judge), compiled (duration), tests (progress), verdict published, each with timestamps.
- AC2: Admins see a link to the distributed trace.

**US-3.4 · Nothing gets lost** (P0)
- AC1: If a judge machine dies mid-run, my submission is re-judged automatically and I get exactly one final verdict.
- AC2: If judging fails repeatedly, I get "System Error — the organisers have been alerted", not an endless spinner.

### E4 — Contests and leaderboard

**US-4.1 · Register for a contest** (P0)
- AC1: Contest page shows start time (IST and my local time), duration, rules, problem count, and registered count.
- AC2: I can register until the contest ends (late registration allowed by default; admin can disable).

**US-4.2 · Contest lobby and start** (P0)
- AC1: Before start, a countdown synced to server time; problems are invisible (API and UI) until start.
- AC2: At start, the arena opens without a manual refresh.

**US-4.3 · Compete in the arena** (P0)
- AC1: Problem tabs A–F show my state (solved/attempted/new) and the count of people who solved each.
- AC2: A countdown is always visible; the last 5 minutes are highlighted.
- AC3: Hints are disabled for contest problems during the contest, with a clear message why.

**US-4.4 · Live leaderboard** (P0)
As Arjun, I want the standings to update live, so that the contest feels alive.
- AC1: Rows update within 2 s of a verdict; rank changes animate (respecting reduced-motion).
- AC2: Cells show attempts and AC minute; first solve of each problem is marked.
- AC3: I can jump to my own row; the table works for 500 rows smoothly.
- AC4: Ranking follows the rules in §9.1 exactly; ties share a rank.

**US-4.5 · Freeze and reveal** (P0 freeze, P1 resolver)
- AC1: From the freeze time, the public board stops showing other people's results; new attempts show as pending (`?`). I still see my own verdicts.
- AC2: After the contest, the admin runs a resolver ceremony revealing pending cells one by one from the bottom rank upwards.
- AC3: After resolving, the final board equals the unfrozen board.

**US-4.6 · Clarifications and announcements** (P0)
- AC1: I can ask a question about a problem; I see answers to mine and all public answers; new answers and announcements pop up as toasts and live in a drawer.
- AC2: Admin can answer privately or publish to all.

**US-4.7 · After the contest** (P1)
- AC1: Final standings, my rating change, AI reviews of my final submissions, and links to upsolve.
- AC2: Problems move to practice; contest submissions stay visible on my profile.

### E5 — Problem setting

**US-5.1 · Create a problem from a package** (P0)
As Ayush, I want to upload a problem package, so that statements, tests, checker, and solutions arrive together.
- AC1: Package format is documented (SRS §3.1.6); invalid packages are rejected with a list of what's wrong.
- AC2: Tests are uploaded to object storage and versioned; changing tests creates a new version.

**US-5.2 · Validate a problem before release** (P0)
- AC1: "Validate" runs every solution in the package; each must receive its declared expected verdict; the result table shows expected vs actual per solution with times.
- AC2: A validator program checks every test input against the constraints.
- AC3: A problem cannot be added to a published contest unless its latest version validated green.

**US-5.3 · Edit statements with live preview** (P0)
- AC1: Side-by-side Markdown + KaTeX preview; saving creates a new version; old versions remain viewable.

**US-5.4 · Keep hidden tests private** (P0)
- AC1: Hidden test contents are never returned by any user-facing API; only setters/admins can download them.

### E6 — Contest operations

**US-6.1 · Live ops console** (P0)
As Ayush during a contest, I want one screen with queue depth, workers, and latency, so that I spot trouble early.
- AC1: Shows per-lane queue depth, active workers with last heartbeat, p50/p95 time-to-verdict (last 5 min), DLQ entries, submissions/min.
- AC2: Alerts (DLQ > 0, a worker silent 30 s, p95 > 10 s for 2 min) appear on the console and in Grafana.

**US-6.2 · Rejudge** (P0)
- AC1: Rejudge one submission, all submissions for a problem, or a whole contest; rejudges run in the lowest-priority lane unless marked urgent; the board updates when rejudged verdicts arrive; each rejudge is audit-logged.

**US-6.3 · Adjust a running contest** (P0)
- AC1: Extend end time (announced automatically); broadcast an announcement; hide/unhide a broken problem.

**US-6.4 · Scale judges** (P0)
- AC1: A single script adds or removes judge machines; new judges start taking jobs without restarting anything else.

### E7 — Ratings and profiles

**US-7.1 · Rating after rated contests** (P1)
- AC1: After finalisation, ratings update using the formula in §9.4; everyone's change is visible on the final standings.
- AC2: Recomputing gives identical results.

**US-7.2 · Profile** (P1)
- AC1: Handle, rating graph, activity heatmap (submissions per day, last 12 months), solved count by tag and difficulty, contest history.

### E8 — AI Coach

**US-8.1 · Hint ladder in practice** (P1)
As Riya, I want progressively stronger hints, so that I use only as much help as I need.
- AC1: Three levels: 1 Concept → 2 Approach → 3 Next step. Level n+1 unlocks only after viewing level n.
- AC2: Hints are grounded in my code, my last verdict, and the problem's editorial notes.
- AC3: Hints never contain solution code (verified by the leak eval, M7).
- AC4: Each level reduces practice points for the problem (10% / 25% / 50%), shown before I unlock it.
- AC5: I can rate each hint helpful / not helpful.
- AC6: Limit 10 hint requests per hour per user; when the AI service is busy, I see "Hints are busy, try again in a minute."

**US-8.2 · Post-contest review** (P1)
- AC1: After a contest is finalised, each participant gets a review of their final submission for each attempted problem: complexity, missed edge cases, comparison with the intended approach, readability.
- AC2: Opening a review generates it on demand if it isn't ready (target: ready within 30 s when AI capacity is available); a background job also pre-generates reviews at a paced rate within the free-tier token budget (SYSTEM_DESIGN §12.3). If capacity is exhausted, I see "Your review is queued — we'll notify you when it's ready."

**US-8.3 · Fairness** (P0)
- AC1: No AI feature is reachable for a contest's problems while that contest runs.

### E9 — Integrity

**US-9.1 · Plagiarism run** (P1)
As Ayush, I want to run a similarity analysis after a contest, so that I find copied solutions.
- AC1: Results show clusters (groups of 2+ users) with scores from both methods, ordered by confidence.
- AC2: Shared boilerplate (fast-IO templates, code given in the statement) doesn't cause matches.

**US-9.2 · Review with evidence** (P1)
- AC1: Side-by-side diff of normalised and original code with matching regions highlighted; advisory signals shown separately and labelled "advisory only".
- AC2: Decisions: Clear · Confirm · Needs discussion, with a required note; decisions are audit-logged.
- AC3: No automatic penalty; a confirmed decision can mark submissions as disqualified, which the admin applies explicitly, recomputing the board.

**US-9.3 · Consent and transparency** (P0)
- AC1: Contest rules state what is collected (paste events, timing), why, and that nothing is decided automatically. *Exception, only when the organiser turns on exam mode (§9.2a):* the third time a contestant leaves the test window, the test is finished automatically; the rules page and the start screen say so first, and an admin can reopen it.

### E10 — Interview pad

**US-10.1 · Create and share a room** (P1)
As a mentor, I want to create a room with a problem and invite a candidate, so that we can start in seconds.
- AC1: Create with: optional problem, language, duration (30/45/60/90 min); get an invite link for candidate and a separate observer link; links expire when the room closes.

**US-10.2 · Code together** (P1)
- AC1: Both see each other's edits and named, coloured cursors within 200 ms p95 on a normal connection.
- AC2: Language switch syncs for both; observers can't type.
- AC3: Names shown are the signed-in identities, never client-supplied text.

**US-10.3 · Run and submit from the room** (P1)
- AC1: Run (custom input) and Submit (hidden tests, if a problem is attached) — both see the same output at the same time; runs limited to 1 per 2 s per room.

**US-10.4 · Private notes** (P1)
- AC1: Interviewer notes autosave and are never visible to the candidate by any means (UI, API, WebSocket).

**US-10.5 · Playback** (P1)
- AC1: After the session, the interviewer can replay the coding at 1×/2×/4× with a scrubber showing Run clicks, verdicts, language changes, joins/leaves.
- AC2: Seeking to any point takes < 1 s for a 60-minute session.

**US-10.6 · Restore a version** (P1)
- AC1: Interviewer can restore the code to the moment of any Run; other connected users converge to the restored state without reloading.

**US-10.7 · Reliability** (P1)
- AC1: If a server instance restarts, users reconnect automatically with no lost edits; a status pill shows connection state.

**US-10.8 · Offline editing** (P2) — edits made while disconnected merge on reconnect.
**US-10.9 · Whiteboard** (P2) — pen, rectangle, arrow, text, eraser; synced; included in playback; all actions have keyboard/button alternatives.
**US-10.10 · AI interview summary** (P2) — interviewer-only summary of approach, complexity, bugs fixed, and communication moments from the event log.

### E11 — Transparency and trust

**US-11.1 · Status / under the hood page** (P1)
- AC1: Public page with live health (API, judges, realtime), queue depth, p95 verdict time, attack-suite result from the last nightly run, load-test numbers, and an architecture diagram.

### E12 — Platform quality

**US-12.1 · Accessible** (P0) — WCAG 2.2 AA for all core flows (UI_UX §11).
**US-12.2 · Fast** (P0) — performance budgets in SRS §3.3.1.
**US-12.3 · Secure** (P0) — SRS §3.3.4; OWASP Top 10:2025 addressed (SYSTEM_DESIGN §16).

---

## 9. Product rules (the authoritative definitions)

### 9.1 Contest scoring (ICPC style)

- Rank by **problems solved** (desc), then **penalty minutes** (asc), then **time of the last accepted submission** (asc). Remaining ties share a rank.
- Penalty for a solved problem = minutes from contest start to its first AC + **20 × rejected attempts before that AC**.
- **Compile errors do not count** as rejected attempts (setting `ceCountsAsAttempt`, default false — this is the common convention in ICPC regionals, though some regionals differ).
- System Errors don't count. Submissions after the first AC on a problem are ignored for scoring.
- Unsolved problems add no penalty.
- Time is measured in whole minutes, floored, from the contest's official start.

### 9.2 Freeze

- Default: the last 30 minutes of a 2-hour contest (configurable; 0 disables).
- During freeze, contestants see their own verdicts; the public board shows other people's post-freeze attempts as pending.

### 9.2a Exam mode (optional, per contest)

Off by default; the organiser ticks **Exam mode** when setting up a contest (`rules.examMode`). Warm-up contests stay ICPC-style. When it is on:

- A contestant has **one entry**: they can press **Finish test** at any time, and after that they cannot open the problems, submit or run code while the contest is still running. Verdicts of submissions already sent are still produced and stay on the scoreboard. After the contest ends it is a normal contest again.
- Leaving the test window (switching tab or app, or leaving full screen) is **counted by the server**. The first two leaves show a warning; the **third finishes the test** for the contestant. A leave closer than 2 seconds to the previous one counts once.
- The contest rules page says so before the test starts. What is recorded: the number of leaves and the time the test finished (and whether the contestant or the third leave ended it). Nothing else about the screen, the device or other tabs.
- It is a deterrent with an audit trail, **not proctoring**: a website cannot stop a second device or Alt-Tab, and a notification or pop-up can also count as leaving. Organisers can **Reopen** a test (audit-logged) after a false positive.
- Staff (setters, admins) are never counted and never locked out.

### 9.3 Language time multipliers

Default for campus contests (configurable per contest, shown in every statement):

| Language | Multiplier |
|---|---|
| C, C++ | 1× |
| Java, JavaScript | 2× |
| Python 3 | 3× |

Memory limits are the same for all languages; each language's runtime overhead allowance is set in `languages.yaml` (SYSTEM_DESIGN §8.3).

### 9.4 Rating

Codeforces-style multi-player Elo (open formula published by Codeforces in 2015):
- Probability that i beats j: `P(i>j) = 1 / (1 + 10^((r_j − r_i)/400))`.
- Seed (expected rank) of i: `1 + Σ_{j≠i} P(j>i)`.
- `m_i = sqrt(seed_i × actual_rank_i)`; binary-search the rating `R_i` whose seed equals `m_i`; delta `d_i = (R_i − r_i)/2`.
- Anti-inflation adjustments: subtract a common value so the sum of deltas is ≤ 0, and adjust the top-4√n group so their average delta is ≥ 0 (details in SYSTEM_DESIGN §9.5).
- New users start at 1400. Contests with fewer than 5 participants are unrated.

### 9.5 AI Coach rules

- Practice only. Disabled for problems in a running contest (including for users not registered in it).
- Hint point penalties: level 1 −10%, level 2 −25%, level 3 −50% of the problem's practice points (cumulative max, not additive).
- AI never outputs code blocks longer than 1 line or any line that compiles as a solution fragment (enforced by the code-removal pass + filter).

### 9.6 Fair play policy (shown on every contest page)

1. Solve problems yourself. No sharing code during the contest. No use of AI tools to solve contest problems (matching Codeforces' 2024 AI rule approach).
2. After the contest, similarity analysis runs. Matches are **reviewed by a person**; nothing is decided automatically.
3. If two contestants' code matches and that code wasn't public before the round, that counts as evidence of cheating (Codeforces policy).
4. You can ask the organiser for the evidence and respond before a decision is final.
5. Signals collected during contests: paste events (size, time), time from opening a problem to AC, code style statistics. They are advisory and deleted 30 days after the contest.

### 9.7 Privacy (summary; SRS §3.3.6)

- Collected: OAuth name, email, avatar; handle; code and submissions; product events; contest-time editor signals.
- Not collected: passwords, webcam, screen, location.
- Email is never shown publicly. Code is private to the author, admins, and (after a contest) anyone if the admin publishes solutions — default private.
- Retention: editor signals 30 days after contest; logs 14 days; everything else until account deletion.

### 9.8 Content policy

- All problems are original or used with permission. Statements from other platforms are never copied.
- Hidden tests stay out of the public repository.

---

## 10. Release plan

| Milestone | Date | Includes | Exit criteria |
|---|---|---|---|
| M0 Foundations | Thu 1 Oct | Auth, DB, contracts, CI, design system | CI green; login works |
| M1 Judge | Sat 3 Oct | Judge + attack suite + queue | Attack suite 100%; chaos test passes |
| M2 Practice live (staging=prod) | Mon 5 Oct | Practice end to end, deployed | Deployed; 20 problems validated |
| M3 Contest ready | Wed 7 Oct | Contests, board, freeze, resolver, ops console | Dry run with 5+ friends |
| M4 Contest + AI + integrity | Sat 10 Oct | AI Coach, plagiarism, k6 numbers | **Warm-up #1 held** |
| M5 Pad + wrap | Wed 14 Oct | Pad (all tiers), README, metrics | All §1 "done" criteria in PLAN |

### 10.1 Launch plan for Warm-up #1 (Sat 10 Oct, 7–9 PM IST)

| When | What | Owner |
|---|---|---|
| Mon 5 Oct | Announcement in class groups: date, rules, sign-in link | Ayush |
| Tue 6 Oct | Registration opens on the site | Ayush |
| Wed 7 Oct | Dry run with 5+ friends | Ayush |
| Thu 8 Oct | Reminder #1 ("2 days to go", link to practice problems) | Ayush |
| Sat 10 Oct, 12 PM | Reminder #2 with rules summary | Ayush |
| Sat 10 Oct, 6:45 PM | Final reminder; lobby open | Ayush |
| Sat 10 Oct, 9:15 PM | Resolver ceremony (screen-share) | Ayush |
| Sat 10 Oct, 10 PM | Thanks + feedback form (includes SUS) | Ayush |

### 10.2 Feedback loop

- Feedback form after the dry run (3 questions) and after the contest (SUS + 3 open questions).
- Every bug report becomes a GitHub issue labelled `from-users`.
- Weekly metrics snapshot appended to `docs/METRICS.md`.

---

## 11. Product analytics

Lightweight first-party events stored in Postgres table `product_events` (no third-party trackers). Names are `object_action`.

| Event | Properties | Used for |
|---|---|---|
| `user_signed_up` | provider | M12 |
| `problem_opened` | problemId, source (list/search/contest) | Funnel |
| `code_run` | problemId, language, sample/custom | Funnel |
| `submission_created` | problemId, language, lane | Funnel |
| `verdict_viewed` | submissionId, verdict, msSinceSubmit | Transparency |
| `hint_requested` / `hint_rated` | problemId, level / helpful | M8 |
| `contest_registered` / `contest_entered` | contestId | M1 |
| `board_viewed` | contestId, frozen | Engagement |
| `room_created` / `room_joined` / `playback_opened` | roomId, role | M10 |
| `review_opened` | contestId, problemId | AI value |

Funnel to watch: `user_signed_up → problem_opened → code_run → submission_created → AC`.

---

## 12. Assumptions and dependencies

| Type | Item |
|---|---|
| Assumption | Participants use laptops with a modern Chromium/Firefox/Safari |
| Assumption | 20–60 contest participants; up to 10 concurrent interview rooms |
| Assumption | Participants have Google accounts |
| Dependency | Azure for Students credit ($100, no card) for VMs |
| Dependency | Groq free tier (primary LLM) with Gemini fallback; free-tier limits constrain AI throughput (SYSTEM_DESIGN §12.3) |
| Dependency | Vercel Hobby for frontend; Grafana Cloud free for observability |
| Dependency | isolate 2.x on cgroup v2 (WSL2 in dev, Ubuntu VM in prod) |

---

## 13. Risks (product)

| Risk | Impact | Mitigation |
|---|---|---|
| Low turnout | Weak evidence | Personal invites; "bring a friend"; practice problems as teasers |
| Wrong test data in the contest | Unfair results | Mandatory validation + stress tests; rejudge flow |
| AI hints feel useless or spoil | Trust loss | Ladder design, grounding in editorial, leak eval, helpful rating |
| Plagiarism false positive | Harm to an honest student | Human review only, evidence shown, right to respond |
| Contest-day outage | Contest ruined | Dry run, runbook, scale-up, failure drills |

---

## 14. Open questions (with default decisions so the build never blocks)

| # | Question | Default until Ayush decides |
|---|---|---|
| Q1 | Is Warm-up #1 rated? | Yes, if ≥ 5 participants |
| Q2 | Publish all solutions after the contest? | No; each user can choose to make theirs public |
| Q3 | Allow late registration during the contest? | Yes |
| Q4 | Contest length and freeze | 2 h, freeze last 30 min |
| Q5 | Practice points per problem | Equal to difficulty rating / 100 (e.g. 1200 → 12 points) |
| Q6 | Include Go/Rust languages? | No for v1 (5 languages) |

---

## 15. Glossary

| Term | Meaning |
|---|---|
| AC / WA / TLE / MLE / RE / CE / OLE / SE | Accepted / Wrong Answer / Time Limit Exceeded / Memory Limit Exceeded / Runtime Error / Compilation Error / Output Limit Exceeded / System Error |
| Run | Execute code on samples or custom input; never scored |
| Submit | Judge code on all hidden tests; scored |
| Lane | A priority class in the judge queue (contest, interactive, practice, rejudge) |
| Freeze | Period at the end of a contest when the public board hides new results |
| Resolver | Post-contest ceremony that reveals frozen results one by one |
| Checker | Program deciding whether an output is correct (exact, tokens, float, testlib) |
| Package | A folder/zip with a problem's statement, tests, checker, and solutions |
| Room | An interview pad session |
| Playback | Replaying a room's editing history |
| Leak rate | Share of AI hints that contain solution code |
