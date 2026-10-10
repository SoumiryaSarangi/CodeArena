# Interview answers: first draft

**Status: a first draft written by Claude, to be rewritten by Soumirya in his own words (plan task U14.3).** An answer you cannot give without looking at this page is not yet yours. Read the "where to look" line, open the code, and say it out loud first.

**About the source list.** The card asked for answers to "§13 of the research doc and §6.13". `docs/research.md` is not in this repository, so I could not match its question list. These questions come from the project itself: its decisions (ADRs), its numbers (`docs/METRICS.md`) and the bugs it had. Add the research doc's own questions at the bottom when you have it open, and point each at the nearest answer here.

Rules for good answers: say the decision, the alternative you rejected and why, the cost you accepted, and the number you measured. Say "I measured" only where `METRICS.md` has it.

---

## 1. The pitch

**Describe CodeArena in thirty seconds.**
An online judge and contest platform. Students submit code, which runs in a sandbox on separate judge VMs and comes back with a verdict in seconds; contests have a live ICPC-style board, a freeze and a resolver ceremony; an AI coach gives hints without giving the solution; a plagiarism pipeline flags similar submissions for a human; and an interview pad lets two people edit code together, run it, and replay the session. It is one monorepo (Next.js, NestJS, a Go judge worker, a Hocuspocus collab server, a Python plagiarism service) deployed on Vercel and Azure, and I measured it: p95 time to verdict 2.1 s with two judges under 4 submissions a second, six failure drills passing, 28 sandbox attacks contained.

---

## 2. The judge and the sandbox

**Why isolate and not Docker per submission, or Judge0?**
Docker is slow to start and gives noisy timings; Judge0 had real sandbox CVEs (a symlink file read, SSRF) of exactly the kind I wanted to design out, and using it would have taught me nothing about the internals. isolate is purpose-built for contests: per-group CPU accounting through cgroup v2, one box per core. The cost is root-capable setup (systemd, cgroup v2), so judge hosts are Linux VMs and WSL2 needs systemd on. *Where: `docs/adr/004-judge-worker.md`.*

**What can a hostile submission try, and what stops it?**
Fork bombs, memory and disk bombs, output floods, reading `/proc` or other boxes, network (IPv4, IPv6, DNS), `ptrace`, `setuid`, raw sockets, `mount`, `chroot`, symlink tricks in the output file, a compiler bomb through templates or `#include`. Process, memory, CPU, wall, disk and output limits, no network, an empty environment except `PATH`, compile sandboxed with the same limits, the output read with `O_NOFOLLOW` + `fstat` + a size cap. I have 28 such programs in `tests/attack-suite`, run in CI and nightly. *Where: `tests/attack-suite/README.md`, ADR-009.*

**Did the attack suite find anything?**
Yes, which is why it exists. The first run passed 27 of 28, and showed that every box could see the host's whole `/dev` (about 200 device nodes; `/dev/kmsg` was readable). The fix removes isolate's default `/dev` rule and binds only what is needed, and `dmesg_restrict` is set as a second layer. *Where: ADR-009, "Hardening from the attack suite".*

**Why are the judge hosts treated as untrusted?**
Because they run arbitrary code: if one is compromised the attacker should gain nothing valuable. Workers run on separate VMs with no database credentials, and reach Redis as an ACL user that may only read job streams and write results. At worst a compromised judge forges the result of a job it was given, and schema and run-version checks limit that. *Where: ADR-009.*

---

## 3. The queue

**How does a submission survive a judge dying halfway through?**
Redis Streams with a consumer group. A claimed job stays "pending"; the worker refreshes its lease every 2 s; a reaper uses `XAUTOCLAIM` to take over jobs idle for 10 s. After 3 deliveries a job goes to a dead-letter queue and the submission gets SE. I tested it by killing a worker mid-judge, on production too: the other judge finished it, nothing was lost. *Where: ADR-005, `apps/worker/internal/lanes`, drills in `METRICS.md`.*

**Why four lanes, and why every 8th claim from the lowest lane?**
Contest, interactive, practice and rejudge, in strict priority, so a contest is never stuck behind practice. Strict priority alone would starve rejudges, so every 8th claim takes the lowest non-empty lane: a contest keeps 7/8 of the capacity, which is what the 15 s p95 target needs, and a low lane still drains (a job waits at most 8 claims per job ahead of it). 4 would cost contests 25 %; 16 doubles the wait. I documented a known limit: with contest and practice both permanently backlogged, the middle lane starves, and a test pins that behaviour so changing it is deliberate. *Where: ADR-005.*

**How do you guarantee one verdict per submission?**
Results are applied idempotently, keyed by the submission and its run version; there is one `judge_runs` row per (submission, run version). A judge that comes back late checks it still owns the job before publishing. The poison-job drill found a real bug here: re-queueing a dead job kept its old run version, so the retry's verdict was discarded as a duplicate and the submission stayed on SE. Re-queued jobs with a verdict now get a new run version, like a rejudge. *Where: SD "As built (O-06)".*

**Why not BullMQ, RabbitMQ or Postgres `SKIP LOCKED`?**
BullMQ hides the lease and retry mechanics I wanted to demonstrate and has no Go client; RabbitMQ is one more service on a small budget; Postgres as a queue would put judge hosts on the database, which ADR-009 forbids. The cost of Streams is that the lease logic is mine to get right, which is why there are chaos tests.

---

## 4. Data, boards and realtime

**What happens if Redis is flushed?**
Nothing is lost: Postgres is the source of truth (ADR-015). Boards are recomputed from `submissions`, the queue from submissions still `queued` or `judging`, SSE replay falls back to a snapshot. I drilled a clean restart (about 5 s of refused submissions) and a hard kill (about 16 s). A refused submission is stored as failed and the contestant gets an error: by design, nothing accepted was lost. *Where: ADR-015, failure drills.*

**How is the leaderboard computed, and kept right when verdicts arrive out of order or a submission is rejudged?**
Every update recomputes the whole (user, problem) cell from Postgres through one pure function, instead of applying incremental rules, which are wrong when an earlier WA is judged after a later AC. The read and write run under advisory locks; a Lua script stores the cell and recomputes the user's row score atomically. The score is packed into one integer (solved, then penalty, then last-AC time) that stays below 2^53 so the sorted set orders correctly; there is a test for the bound. Diffs are published 500 ms after a change as `board.diff`, and a rebuild from Postgres must equal the live board (the drills check that). *Where: SD "As built (C-02)", `apps/api/src/modules/board/scoring.ts`.*

**How do the freeze and the resolver work?**
The frozen view is maintained all along (a cell has an after-freeze flag) and readers switch by the server clock, so no timer fires at the freeze. The resolver is a pure function in the browser: it reads the frozen and live views and walks one to the other, bottom rank first, leftmost cell first. It is deterministic, so a replay gives the same sequence, and its end equals the live board, tested on 200 random contests. *Where: SD "As built (C-06)", `apps/web/lib/resolver.ts`.*

**Why SSE for boards and WebSocket for the pad?**
Verdicts and boards are one-way pushes: SSE over HTTP/2 passes through Caddy and Vercel, reconnects with `Last-Event-ID` against a Redis replay stream, and is simple. The pad is bidirectional and high-frequency CRDT sync, which is what Hocuspocus does over WebSocket. The cost is two realtime stacks. Both authenticate with single-use realtime tickets because neither `EventSource` nor a WebSocket can send a bearer header, and a long-lived token in a URL leaks into logs. *Where: ADR-006, ADR-007.*

**Auth: why OAuth only, and how are tokens protected?**
Students have Google accounts; passwords would add risk (hashing, reset, breaches) for no benefit. The access token is a 15-minute ES256 JWT sent as a bearer header, so it is not ambient and CSRF cannot ride on it. The refresh token is a 30-day sliding, hashed, httpOnly cookie scoped to `/api/auth`, rotated on every use; presenting an already-rotated token revokes the whole family. Mutations also need a double-submit CSRF token. *Where: ADR-007.*

---

## 5. The AI parts

**How do you stop the coach from giving away the solution, and how do you know it works?**
A pipeline, not a prompt: a sufficiency check, the main hint, a code-removal pass, then a deterministic filter (no fenced code, no two consecutive code-like lines, no formula-like spans, no words from the problem's avoid-set below their level), one stricter retry, then a static generic hint. Hints are off during contests. That is measured: a 66-item eval including prompt injections hidden in code comments. The first prompt version leaked 3.7 % (2 of 54) and failed my target; the eval showed why (the prompt never told the model the avoid-set; the filter let formulas through in backticks), and `hint-main@2` leaked 0 of 54. 0 of 54 means "below about 7 % with 95 % confidence", not "zero". *Where: SD AI-02 and AI-04, `METRICS.md`.*

**What is still wrong with the hints?**
Over-reveal: a model judge says 24.5 % of shipped hints say more than their level allows (mostly "sort by finish time" at level 1). They contain no code, so they are not leaks, but they spoil the thinking, and the removal pass does not help. Also, the 20 labels in the eval are Claude's, disclosed in the report, so they are not independent evidence. Say this plainly: it is a stronger answer than claiming it is solved.

**How do you protect the models from prompt injection in user code?**
Everything from a user (code, comments, notes) goes into labelled blocks the system prompt says are data, not instructions; a forged closing tag inside the text is broken up so it cannot end the block; the prompt says never to reveal the rules. The eval has 30 adversarial items. For the interview summary a test puts a forged `</code>` and "ignore all previous instructions" in the code and the notes and checks they stay inside the blocks and never reach the rules. It reduces the risk; it does not remove it, which is why the output is also filtered (hints) or only shown to the interviewer (summary).

**How does plagiarism detection work, and why does a human decide?**
Two stages: token fingerprints with winnowing (finds copies that rename and reformat) and code embeddings (UniXcoder), combined into one score. Held out by problem the combined score reaches 92.1 % recall at 88.7 % precision, against 74.8 % recall for fingerprints alone at the same precision target. About one flag in nine is a false alarm, and independent solutions to the same short problem do overlap, so the output is clusters in a review UI: nothing is ever automatic. The caveat: the independent solutions in the eval were written by AI models, not students, so the real test is a real contest. *Where: SD §13, `METRICS.md`, ADR-011.*

---

## 6. The interview pad

**Why a CRDT, and what does the server do?**
Two people editing one document need to converge whatever order edits arrive in, including after one goes offline. Yjs guarantees that; Hocuspocus is the server that authenticates connections, stores the document in Postgres (debounced, flushed when the last person leaves), and shares updates between two instances through Redis. A property test (fast-check) runs 3 to 5 replicas through random concurrent edits, restores and late, repeated, reordered delivery and requires identical documents. A chaos test kills one of two collab processes mid-edit and checks no edit is lost. *Where: ADR-010, `apps/collab/src/convergence.test.ts`, `chaos.test.ts`.*

**How do you know who typed what, and keep the interviewer's notes private?**
Identity comes from the single-use ticket the API redeemed, never from what a client claims: awareness states are rewritten with the verified name and role, and a connection can only write the client ids it owns. Observers are read-only on the server. Notes and the AI summary live in their own tables, outside the shared document, and only the interviewer's routes return them: a test enumerates every registered GET route as candidate, observer, stranger and guest and finds the secret in none. The update log records the verified user id for every update, which is how the replay and the summary can attribute edits. *Where: SD "As built (CP-01)", "(CP-05)", "(CP-11)".*

**How does "restore this version" work while someone is typing?**
It is an anti-operation, not a replacement. The server diffs the live text against the snapshot (a code-point diff, so it never splits an emoji) and applies the edits in one transaction, so what survives keeps its identity: cursors stay, and what others type at that moment is kept. A test asserts a relative position into the surviving text is unchanged, which a delete-everything-and-insert implementation would fail. The API asks one collab instance, Redis relays to the other; asking both would apply it twice. *Where: SD "As built (CP-07)", `apps/collab/src/restore.ts`.*

**How can the replay seek in milliseconds?**
The log records every update with the server's time and the verified author; a checkpoint is written exactly every 200 updates, computed from the log in the database. A seek takes the last checkpoint before the moment plus the updates after it, at most 200: 9 to 16 ms for a 60-minute session of 36,000 updates, and the answer does not grow with the session. When a document loads or unloads, the log is compared with the document and one catch-up update closes any gap, so replaying the whole log always equals the stored document (a test over 20 random sessions). *Where: SD "As built (CP-06)".*

**What does `gc: false` cost?**
Yjs keeps deleted content so snapshots, restore and the replay work. The cost is that a document only grows: deleting does not make room under the 2 MB cap, and the server refuses a change that would pass it (closing that connection with a reason). Fine for a 90-minute interview; a long-lived document would need compaction.

**How does the pad work offline?**
Mostly it already did (the document accepts edits while disconnected and syncs on reconnect). I added `y-indexeddb`, so edits survive a reload or a crashed tab, and the editor opens from that copy when the room cannot be reached. It cannot open a room with no network at all (the page needs the API; that would need a service worker). The copy is deleted when the room ends. *Where: SD "As built (CP-09)".*

---

## 7. Testing and measuring

**How did you test it?**
Layers: unit tests with requirement ids in their names; integration tests against real Postgres and Redis; a property test for the pad's convergence and a 200-random-contest test that the resolver ends on the live board; a 28-case sandbox attack suite; failure drills that inject one fault into a real contest and check every verdict exists once and the board equals its rebuild; browser tests with real Monaco and a real collab server. A habit on every card: after the tests were written the code was broken in specific ways on purpose (a "mutation check") and a test had to fail; some mutations survived and showed a weak test, which I fixed, or showed the mutation was equivalent.

**What did the load test say, and what did you expect?**
500 submissions in 2 minutes with 200 browsers watching: with one judge the queue drained 58 s after the last submit, against a design estimate of 15 minutes (the estimate assumed 4 s per submission; measured about 0.5 to 1 s). With two judges p95 time to verdict was 2.1 s. Caveats I state myself: the three test problems are light, the VMs are burstable (a long heavy queue could be throttled), the subscription allowed only two judges so 3 and 6 were not measured, and the client was a laptop on the internet. *Where: `METRICS.md`.*

**What would break first at ten times the load?**
The honest answer is a list: the single API VM and the single Redis (no failover; Redis loss is survivable by design but costs seconds of refused submissions); judge capacity scales by Terraform in about 6 to 7 minutes, not instantly; the free AI tiers' daily token budgets (hints and reviews would queue or fall back); the board's per-user recompute under a very large field; the collab servers' memory at about 1 to 5 MB per room plus a base. Autoscaling with KEDA is the documented upgrade, not built (ADR-014).

---

## 8. Honest weaknesses and what I would change

- **Evidence is from synthetic data in two places**: plagiarism "independent" solutions and some hint attempts are AI-written; the 20 hint labels were Claude's. The real test is a real contest.
- **Hint over-reveal** (24.5 % by a model judge) is unsolved.
- **The load numbers are one run each** on burstable VMs, from one client.
- **Browser tests are sensitive to load** when run all at once on a big machine (CI and a laptop both showed flakes in untouched specs); I fixed the ones I found and run them with fewer workers.
- **No service worker**, so no true offline start; **no undo** and no resize on the whiteboard; the AI summary uses the code at the last Run as the final code.
- **Dependence on free AI tiers**, and on a relay on Vercel because the providers refuse the API VM's region (Hong Kong). Model names changed during the project; routing is config only.
- **A single region, a single API VM.** Fine for a campus contest, not for a product.

## 9. Bugs worth telling as stories

1. **The poison job** (queue): a re-queued dead job kept its old run version, so its verdict was discarded as a duplicate and the contestant stayed on SE. Found by a failure drill, not by a unit test, because it needed the real stream, a real worker and a real outage.
2. **The `/dev` exposure** (sandbox): the attack suite showed the box could see the host's devices.
3. **The hint prompt that leaked** (AI): 2 leaks in 54, traced to a missing instruction and a filter hole, found only because I built an eval.
4. **A silent test crash** (Nest): a provider forgotten in a module's list after a formatter reflowed it made the app abort at start-up with only a vague worker error. Lesson: after editing a module, check dependency injection first.
5. **The load test that stored nothing** (pad): simulated typists without user rows made every log write fail its foreign key and retry forever. In production the same silent retry would hide a missing user row: an alert on repeated log-write failures is a recorded follow-up.

## 10. Using an AI pair programmer, honestly

**Check every sentence here is true for you before you say it.** What the repository itself supports: the plan, the decisions and the acceptance checks are written down before the code (`docs/PLAN.md`, `docs/adr/`), and each locked decision and each new dependency was approved by Soumirya (the ADRs say "approved by Soumirya" with a date; `CLAUDE.md` lists what needs his approval). An AI pair programmer wrote most of the code under the rules in `CLAUDE.md`: a model per card, explain-back checkpoints, tests named after requirement IDs, a quality gate before every commit. What keeps that honest is that claims are measured by scripts and written with their caveats, that bugs found by the suites are in the log (`docs/PROGRESS.md`), and that the places where the AI's own work was the weak evidence (the hint labels) are disclosed in the report. The commits are authored by Soumirya, who owns what ships; be ready to explain any file in them without opening it.

---

## Draft resume bullets (rewrite, and keep only numbers you can defend)

- Built a contest-grade online judge (Go + isolate on cgroup v2) with strict-priority Redis Streams lanes and lease-based recovery; p95 time to verdict 2.1 s at 4 submissions/s on two judge VMs; 6 of 6 failure drills pass on production, 28 sandbox attacks contained.
- Designed judge hosts as untrusted (separate VMs, no database credentials, ACL-limited Redis user) and built a nightly attack suite that found and fixed a host `/dev` exposure.
- Built a guarded AI hint ladder and measured it: a 66-item eval with prompt injection cut shipped leaks from 3.7 % to 0 of 54 hints; documented the remaining over-reveal rate.
- Built a collaborative interview pad (Yjs, Hocuspocus, two instances behind Redis) with version restore, replay, offline editing and a whiteboard; p95 edit propagation 2.1 ms at 10 rooms × 3 users, property-tested convergence and a kill-an-instance chaos test.
