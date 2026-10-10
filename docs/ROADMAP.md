# Roadmap, known limits and open follow-ups

What is not done, on purpose or not yet. Nothing here is a promise of a date. Sources: [PRD §6.2](PRD.md#62-non-goals-explicitly-out-of-scope)
(non-goals), [ADR-014](adr/014-upgrade-paths.md) (upgrade paths), and the follow-up cards in
[PROGRESS](PROGRESS.md) (IDs like X-17).

## Known limits you should say out loud

| Limit | What it means |
| --- | --- |
| Capacity was measured with two small judge VMs | 2.1 s p95 time to verdict for a 500-submission burst on `Standard_B2s_v2`; the student subscription's quota blocked larger runs and non-burstable VMs ([METRICS](METRICS.md)). Heavy contest problems may be slower than the light test problems. |
| Exam mode is a deterrent | A website cannot stop a second device or Alt-Tab; a notification can count as a leave. Organisers can reopen a test. |
| Plagiarism and AI signals are advice | Held-out precision is 88.7 % (about one false alarm in nine), and the independent solutions in the evaluation were AI-written, not students'. A person decides. |
| Hints can over-reveal | No leaked code in 54 hints, but the judge model flags 24.5 % as saying more than their level allows, mostly at level 1. |
| One database, one API server | Postgres, Redis and object storage share one VM; losing it means restoring from the nightly backup (database only) and re-importing test data. |
| The servers may be switched off | To save cloud credit the Azure servers can be deleted and rebuilt ([revive](runbooks/revive.md)); the website then shows a "paused" notice. |
| Two judge VMs at most | Azure for Students allows 6 vCPUs per region. |

## Open follow-ups (small, scoped)

| ID | What | Why |
| --- | --- | --- |
| X-1 to X-9 | Exam mode: count a leave only after N seconds hidden; a leave log for disputes; finish or reopen by hand with extra minutes; lock other tabs at once; a heartbeat; "Leaves: 1 of 3" in the bar; a policy for phones; one headed real-browser run; export in the post-contest report | Fewer false alarms and evidence for disputes |
| X-16 | Drill the whole API VM dying (restore from backup) and a full disk | The one failure not rehearsed |
| X-17, X-18 | Stricter hint level scopes so level 1 names the idea without explaining it; more realistic wrong attempts in the eval set | The open hint problem |
| X-19 to X-21 | Label a real contest's submissions as a human test set and re-fit the plagiarism model; more independent solutions; disguises a person would try | Evidence beyond AI-written copies |
| Admin preview of exam mode | A "view as contestant" switch, because staff are exempt and cannot see the lockdown | Testing exam mode without a second account |
| Setter badges | Show who is a setter in the UI and which problems are theirs | Small polish after UI-24 |
| Paused sign-in | Disable the sign-in buttons while the paused notice shows | Avoids a dead-end click |
| Test flakes | A replay timing test (4×) and one collab test failed once under load and pass on rerun | Remove flaky tests |
| Interview answers | Rewrite [`docs/interview/answers.md`](interview/answers.md) in the owner's own words | The first draft was written by the assistant |

## Possible next features

- **Team contests** (3-person ICPC teams): the data model leaves room.
- **Interactive problems** and **IOI-style partial scoring**: need sandbox plumbing and a scoring model.
- **A faculty mode**: weekly lab auto-grading with plagiarism reports (persona PE6 in the PRD).
- **A real domain** instead of the `sslip.io` address, with proper e-mail for sign-in notices.
- **A public problem archive** with editorials and difficulty tags (tag chips and tighter rows were left out of design round 2).
- **Documented public API** (OpenAPI generated from the Zod contracts).

## Upgrade paths the design left out on purpose

[ADR-014](adr/014-upgrade-paths.md): more judge VMs and then Kubernetes with KEDA scaling on queue length, gVisor around
the worker for stronger isolation, stateless API instances and the other steps listed there. The ADR records why the
design stops where it does and the next move for each pressure.

## What will not be built

Proctoring (webcam or screen capture), automatic bans, "AI-written code" detection, video or voice in the pad, native
mobile apps, payments and multi-tenant organisations. See the [non-goals](PRD.md#62-non-goals-explicitly-out-of-scope).
