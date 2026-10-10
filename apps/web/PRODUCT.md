# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users, confirmed by Ayush on 2026-10-09, are **students who practise and compete**: Riya (3rd-year placement-prep student, practises 1 to 2 hours a day, mostly C++ and Python) and Arjun (contest regular, club member, wants fast fair contests and live standings). Second: **organisers** (Ayush: problem setter, contest operator, admin), **interviewers** (a senior student running a mock interview) and **candidates** (a junior student practising interviews). A faculty or lab TA is a possible future user, not a current one. Sources: `docs/PRD.md` §4.1.

A second audience exists for the public landing page and status page: **reviewers and recruiters** following a resume link, who need to see within a minute what the platform does and that it is built well. Confirmed by Ayush as "both audiences" for the landing page; students remain first everywhere else.

## Product Purpose

CodeArena is a campus-scale online judge and contest platform. Students practise problems, compete in live ICPC-style contests with a real-time leaderboard, get AI hints that do not give the solution and post-contest reviews of their final code, and run mock interviews in a shared code editor that runs code on the same judge. Organisers get a problem-setting toolkit, a live contest operations console, and a plagiarism review workflow that flags clusters for a human to decide. Success is a contest that runs smoothly for a campus (first targets in `docs/PRD.md` §6.3: at least 20 participants, nothing lost, p95 time to verdict within 15 s) and a practice habit students come back to. It is also its owner's flagship engineering project for placement interviews, which is why correctness, security and measured claims matter as much as the interface.

## Positioning

For students and organisers on a campus, it is a judge the campus owns: its problems, its timing, its data, its people. What a neighbouring product could not truthfully copy: contests and a leaderboard private to the campus; **transparent judging** (the user sees where a submission is in the queue, live per-test progress and a journey timeline); a **measured** AI Coach whose hint leaks are counted; plagiarism checks where algorithms flag and **people decide**; and an interview pad that replays a whole session. Public platforms (Codeforces, LeetCode) are the comparison users already know.

## Operating Context

Students use it on laptops (coding) and on phones (reading statements, watching the board, checking results; coding on a phone is possible but not optimised). Contests are time-boxed (typically 2 hours, a freeze in the last 30 minutes, an ICPC-style resolver ceremony to unfreeze the board on a shared screen). Contest day is the peak: many people submitting at once, watching one live board. Admins work in a console during a contest. Interview rooms last up to 90 minutes with two or three people. Time is shown from the server's clock, not the browser's. Code is judged on separate judge machines in a sandbox. Theme follows the system (dark and light both supported).

## Capabilities and Constraints

Languages: C, C++17 and 20, Java 21, Python 3, JavaScript (Node). Verdicts: AC, WA, TLE, MLE, RE, CE, OLE, SE; every verdict must carry a text label, never colour alone. Screens S01 to S18 are listed in `docs/UI_UX.md` with their routes and copy. The live board, verdicts and clarifications arrive over Server-Sent Events; the interview pad over WebSocket. Hard product rules: hints are off during contests; hidden test data never appears in the interface; the interviewer's notes and AI summary are visible only to the interviewer; plagiarism flags are never acted on automatically (an administrator reviews each cluster). Technical: Next.js App Router, Tailwind v4, shadcn/ui, Monaco for code, Geist fonts today (starting points, not commitments, per the design decision of 2026-10-09). **The only visual rule fixed by Ayush: no gradients.** Everything else about look and feel is decided by the design process. Existing tests are the gate for changes. Undecided and left to the design work: palette, typography, density, motion, imagery.

## Brand Commitments

Only two, confirmed by Ayush: the name **CodeArena** and the tagline **"The place your campus codes together"** (PRD vision: "practise, compete, and interview, on a judge you can trust"). There is no logo, favicon or brand colour in the repository; a wordmark may be proposed. Voice in existing copy is plain and factual (error messages say what happened and what to do); `docs/UI_UX.md` §10 has the current copy.

## Evidence on Hand

Real, measured, and citable: load, failure-drill, sandbox, AI-hint, plagiarism and interview-pad numbers in `docs/METRICS.md` (for example: p95 time to verdict 2.1 s with two judge VMs under about 4 submissions a second; 6 of 6 failure drills pass on production; 28 sandbox attack programs contained; interview pad p95 edit propagation 2.1 ms at 10 rooms of 3). 20 public practice problems in `problems/`. A live site (web on Vercel, API and judges on Azure) and a public "Under the hood" status page at `/status`. **Absent, and not to be invented:** testimonials, customer or user counts, a logo, real contest results (the first real contest has not run at the time of writing, 2026-10-09), and screenshots or recordings (listed in `README.md`, not yet made).

## Product Principles

1. **Fairness first.** Same limits for everyone, transparent rules, no automatic punishment.
2. **Show the system.** Users see where their submission is and why; the interface exposes queue position, per-test progress and the journey.
3. **Teach, don't tell.** The AI helps a student think and never writes the solution.
4. **Humans decide.** Algorithms flag; people judge.
5. **Measured, not claimed.** Statements about speed, safety or quality in the product and its copy are backed by a number in `docs/METRICS.md`.

## Accessibility & Inclusion

WCAG 2.2 AA is the standard the tests enforce today (axe at 1280 px and 390 px in dark and light on every screen). Keyboard access everywhere, a text label on every verdict, respect for reduced motion, no drag-only interactions (a non-drag alternative for anything draggable), and a layout that works at 390 px without horizontal scroll. Many users are students on shared or modest devices and on campus networks.
