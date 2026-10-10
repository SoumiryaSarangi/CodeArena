# Demo video and resume bullets (W-02)

Written for Ayush, who records the video and writes the resume. Every number below is copied from
[METRICS.md](METRICS.md); where METRICS.md has no number yet, the line says so and nothing is invented.
Nothing here is a claim you cannot show on screen.

## 1. Video: about 4 minutes, one take per scene

Record at 1280 × 800, dark theme, browser zoom 100 %. Use a signed-in test account with a few solved problems and
a finished practice contest so the profile and board are not empty. Sample-data screens are fine if you say so.

| # | Scene (screen) | Seconds | Do this | Say this | Proof on screen |
|---|---|---|---|---|---|
| 1 | Landing (S01) | 20 | Open `/` and let the six steps light up; point at the live strip. | "An online judge and contest platform I built end to end." | The judge window, the live verdicts strip, the 500-run bar. |
| 2 | Practice → workspace (S04, S05) | 35 | Pick a problem, paste a wrong C++ solution, Submit, then the fixed one. | "Code runs in a sandbox on separate judge machines." | The wire under the toolbar moving queued → claimed → compiling → running → verdict; WA then AC. |
| 3 | Submission detail (S06) | 15 | Open the AC submission; show time and memory. | "Every run keeps its tests, time and memory." | Per-test table, 24-hour times. |
| 4 | Hint (AI Coach) | 25 | Ask for a hint on a problem you have not solved. | "Hints never ship code; I measured the leak rate." | A level 1 hint; say "0 of 54 shipped hints leaked, a wide interval, 7 % at most". |
| 5 | Contest board (S10) | 40 | Open a finished contest board; click a row; show the freeze notice and your sticky row. | "ICPC-style board over server-sent events." | Rank changes, wires on rows, the freeze notice. |
| 6 | Resolver ceremony | 25 | Run the resolver on the frozen board. | "The reveal after the freeze, like ICPC." | Cells flipping one by one. |
| 7 | Interview pad (S13) and replay (S14) | 40 | Two windows, type in both, Run, open the replay. | "A collaborative pad with an interviewer view and a replay." | Both cursors, the Run result, the timeline scrubber. |
| 8 | Integrity (S17) | 20 | Open one plagiarism cluster. | "Flags go to a person; nothing is automatic." | The cluster, the advisory label. |
| 9 | Ops and status (S16, S18) | 20 | Open `/status` (public) then the ops console. | "One judge machine against two: the queue drained in 58 seconds against 2." | Judges answering, the pad line. |
| 10 | Close | 10 | Back to the landing. | The repo link, nothing else. | – |

Do not show: secrets, the production server address bar with a token, any real student's handle on the
integrity or board screens (use test accounts), and the Admins page until `OWNER_EMAIL` is set.

Cut list if it runs long: scene 6, then scene 8.

## 2. Final numbers (one place; the sections of METRICS.md hold the runs and their caveats)

| Claim | Number | Where | Say it like this |
|---|---|---|---|
| Time to verdict with two judges | p50 0.4 s, p95 2.1 s | METRICS "Load test (O-03)" | "Measured on production with 500 submissions in a burst, two small judge VMs." |
| Queue wait with two judges | p50 0.0 s, p95 0.5 s | same | same |
| One judge against two | 58 s against 2 s to drain the burst | same | "The estimate said 15 minutes for one judge; it took 58 seconds." |
| Throughput | 2.76/s with one judge, 4.00/s with two | same | |
| Live updates | 200 listeners connected in about 9 s, 0 refused, 0 dropped | same (after X-10) | "30 submissions, 200 listeners." |
| Sandbox | 28 attack programs, all contained in the nightly run | METRICS "Sandbox attack suite" | "Nightly, on a real judge VM; not in the normal CI run." |
| Failure drills | 6 of 6 pass on production, every accepted submission judged exactly once | METRICS "Failure drills (O-06)" | "A real crash of the API was back and ready in about 4 s." |
| Interview pad | p95 2.1 ms at 10 rooms of 3 (target 200 ms), 5.8 ms at 292 clients in 100 rooms, 0 lost keystrokes | METRICS "Interview pad load test" | "On one machine, no network." |
| Hint leaks | 0 of 54 shipped hints, 95 % interval up to 7 % | METRICS "Hint leak eval" | Add "over-reveals are the open problem". |
| Plagiarism | held out by problem: 92.1 % recall at 88.7 % precision, F1 90.4 % | METRICS "Plagiarism eval" | "Independent solutions were AI-written, not students'." |

**Not available yet:** contest-day numbers (participants, submissions, busiest minute, real verdict times). Run
`tests/load/prod.sh contest-report <slug> FILE` and `node scripts/metrics-report.mjs --contest FILE` once
(runbook: [runbooks/contest-day.md](runbooks/contest-day.md)); it writes "Contest reports (W-00)" into METRICS.md
with the PRD targets next to it. Then fill the one bracket in bullet 1 below, or delete it.

## 3. Resume bullets (template: replace nothing except the bracket; cut what you cannot defend in an interview)

Pick three or four. Each can be defended from METRICS.md.

- Built CodeArena, an online judge and contest platform (Next.js, NestJS, Go, Postgres, Redis) with ICPC-style live boards, a freeze and a resolver, [N participants in its first contest: fill from the contest report, or delete this clause].
- Designed an untrusted-host judge on isolate and cgroup v2 with Redis Streams leases; measured on production, a 500-submission burst on two judge VMs had a median time to verdict of 0.4 s (p95 2.1 s), and the queue drained in 2 s against 58 s with one judge (the capacity estimate said 15 minutes).
- Wrote 28 sandbox attack programs (fork and memory bombs, symlink and `/proc` reads, network, ptrace, mount, chroot) that run nightly against a real judge VM; all contained.
- Ran six fault drills on production (worker kill, API kill, Redis restart and hard kill, a stopped judge VM, a dead-letter job); every accepted submission was judged exactly once, which also exposed and fixed a real retry bug.
- Built a collaborative interview pad (Yjs, Hocuspocus) with replay; 10 rooms of 3 typists saw a 2.1 ms p95 keystroke delivery against a 200 ms target, with no keystroke lost across 152,201 deliveries at 292 clients.
- Added an AI hint coach with a leak eval of 66 items: the first prompt leaked 2 of 54 shipped hints, the second 0 of 54, after the eval found four real flaws.
- Built plagiarism detection (fingerprints plus code embeddings): held out by problem, 92.1 % recall at 88.7 % precision against disguised copies; flags are reviewed by a person.

Rules for the resume and the interview: say "measured on production" only for the load test and drills; say
"on one machine" for the pad; say "AI-written test solutions" for the plagiarism eval; never say "handles N users"
without the numbers above.
