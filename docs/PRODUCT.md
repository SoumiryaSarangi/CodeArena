# CodeArena: product overview

A two-page orientation to what CodeArena is, who it is for and why it is built the way it is. The full requirements
are in [PRD](PRD.md); this page is the version you can read before a meeting.

## In one sentence

An online judge and contest platform for a campus: students practise and compete on problems that a real sandboxed
judge checks, get hints from an AI coach that never gives the answer away, and run mock interviews in a shared
editor that runs code, while organisers get the tools to set problems, run a fair contest and review suspected
copying.

## The problem

| Who | What hurts today |
| --- | --- |
| Students preparing for placements | Large platforms are great for practice but not for _your_ class: no campus contests, no shared leaderboard with peers, and no help that stops short of the answer. |
| Contest organisers (clubs, TAs) | Running a contest means forms, manual grading or an external platform with no control over timing, problems or data; public judges can queue submissions for many minutes at busy times. |
| Organisers after a contest | Checking for copied code is manual; MOSS sends code to external servers; detectors for AI-written code are unreliable. |
| Students practising interviews | Mock interviews happen in documents or paid tools: no code execution, no replay to learn from. |

## Who it is for

| Persona | Needs |
| --- | --- |
| **Practice student** | Build consistency, get unstuck without spoilers, see progress. |
| **Contest regular** | Fair, fast contests, live standings, a rating. |
| **Organiser / setter / admin** | Create problems safely, run a smooth contest, catch cheating fairly, see what is happening during a contest. |
| **Interviewer and candidate** | A shared editor that runs code, private notes, a replay for feedback. |

Roles in the product: guest, user, **setter** (writes and validates their own problems), **admin** and the **owner**
(the one account that manages who is admin or setter). Details: [PRD §4](PRD.md#4-users).

## What the product does

1. **Practice.** Twenty problems with rendered maths, runnable samples, and a submission page that shows the journey of
   every submission (queued, claimed, compiling, running, verdict) as it happens.
2. **Contests.** ICPC scoring, a freeze near the end, a live board, clarifications, the resolver ceremony that reveals
   the frozen board, ratings, optional exam mode.
3. **AI Coach.** Three hint levels (concept, approach, next step) behind guardrails so a hint never contains code, off
   during contests, plus a review of your final submission afterwards.
4. **Fair play.** Plagiarism clusters for a person to review, advisory behavioural signals, an optional canary sentence.
   Nothing is decided automatically.
5. **Interview pad.** A real-time shared editor with interviewer, candidate and observer roles, Run and Submit,
   private interviewer notes, a whiteboard and a full session replay.
6. **Operations.** A public status page, an ops console for contests, backups with a restore test, failure drills.

## Principles that shape decisions

- **Transparent judging.** A user always knows where their submission is.
- **Humans decide fairness.** No automatic bans, no claim to detect AI-written code ([non-goals](PRD.md#62-non-goals-explicitly-out-of-scope)).
- **Untrusted code, untrusted judge hosts.** The machines that run submissions hold no database credentials
  ([ADR-009](adr/009-untrusted-judge-hosts.md)).
- **Measured, not claimed.** Numbers in the README come from scripts and are recorded with their caveats in
  [METRICS](METRICS.md).
- **Calm, readable interface.** Ink-on-paper design, no gradients, light and dark themes, accessibility checked in tests
  ([UI/UX](UI_UX.md)).

## What it deliberately does not do

Team accounts, partial-score (IOI-style) problems, interactive problems, video or voice in the pad, native mobile
apps, proctoring, automatic penalties from plagiarism scores, payments and multi-tenant organisations. Reasons are in
[PRD §6.2](PRD.md#62-non-goals-explicitly-out-of-scope). Later directions: [ROADMAP](ROADMAP.md).

## How success is measured

The north-star metric is _verdicts delivered to real users with p95 time-to-verdict under target_. The product
metrics (participation, lost verdicts, sandbox attack suite, hint leak rate, plagiarism precision, pad latency) and
their targets are in [PRD §6.3](PRD.md#63-success-metrics); the results so far are in [METRICS](METRICS.md).

## Where the product stands

Built and deployed: everything on the plan's critical path ([PLAN](PLAN.md), log in [PROGRESS](PROGRESS.md)). The
interface has had two design rounds ([audit](design/AUDIT.md), [round 2](design/ROUND2.md)). Not yet measured:
participation numbers from a real contest (a report is produced with `contest-report`, see
[contest day](runbooks/contest-day.md)). The system can be switched off to save cloud credits and rebuilt from one
encrypted archive ([revive](runbooks/revive.md)).
