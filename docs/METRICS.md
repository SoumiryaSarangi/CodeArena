# Metrics

Measured numbers, not estimates. Sections are written by scripts (`scripts/metrics-report.mjs` for the load
test) and replaced when the same run is repeated, so edit the text around them, not inside the markers.
Capacity maths and the predictions each result is compared with are in SYSTEM_DESIGN §2.3.

**Final numbers in one table, with how to say each one:** [DEMO.md](DEMO.md) section 2. Contest-day numbers are
not in this file until a contest report is run (see DEMO.md).

## Load test (O-03)

<!-- load-summary -->

| Run               | Judges | Queue wait p50 / p95 | Time to verdict p50 / p95 | Burst drain | Predicted (SD-§2.3) | Throughput |
| ----------------- | ------ | -------------------- | ------------------------- | ----------- | ------------------- | ---------- |
| judges=1 (B2s_v2) | 1      | 26.1 / 48.6 s        | 26.6 / 50.8 s             | 58 s        | 15 min 0 s          | 2.76/s     |
| judges=2 (B2s_v2) | 2      | 0.0 / 0.5 s          | 0.4 / 2.1 s               | 2 s         | –                   | 4.00/s     |

<!-- /load-summary -->

### How to read these (written by hand; the blocks below are generated)

- **The estimate was too pessimistic.** SYSTEM_DESIGN §2.2 assumed a blended 4 s of judge time per submission (0.5 submissions/s per judge). Measured on the production judge: C++ 0.44-0.51 s and Python 0.92-1.12 s on average, so one judge sustained 2.8 submissions/s and drained the whole burst 58 s after the last submit (predicted 15 minutes). Two judges split the work evenly (264 and 236 runs) and the queue never grew beyond 8.
- **Caveat.** The three test problems are light (a handful of small tests each). The six contest problems may take longer per submission; a TLE costs the full limit once (8.8% of the mix). Use the 2-judge result as headroom, not as a promise.
- **Only 1 and 2 judges could be measured.** This Azure for Students subscription allows 6 vCPUs per region in total (API 2 + 2 per judge) and has no quota for the D2s_v5 family, so the planned runs at 3 and 6 judges and on non-burstable VMs are not possible without a quota increase. Both runs used Standard_B2s_v2 (burstable).
- **Burstable CPU.** The judge started the first run with 1,210 CPU credits and ran at 87-98% CPU during the burst; the burst (3 minutes) used a small part of them. Sustained full load would use roughly 70 credits a minute (about 17 minutes of 100% on both vCPUs), so a long, heavy queue could throttle a single judge; the contest load (about 0.17 submissions/s at the peak) is far below that.
- **Scale-out of one judge** (from the script's log, `scripts/scale-judges.sh up 1`): VM created in 55 s, first-boot setup done 26 s after it answered, firewall lockdown apply about 45 s, worker installed and reporting about 1 minute later: **about 6-7 minutes** end to end. (This run's last step was finished by hand because of a bug in the script, fixed afterwards, so the end-to-end figure is from the step timings.)
- **Live updates.** 194-195 of 200 listeners connected; the rest and about 3,900 retries were refused with HTTP 429: `GET /api/sse` uses the default per-IP limit of 120 requests a minute and all 200 test listeners came from one address. Contestants behind one campus address could meet the same limit (follow-up X-10 in PROGRESS). **After X-10 (limits changed, same test with 30 submissions): all 200 listeners connected in about 9 s with 0 refusals and 0 drops (before: 5 refused, about 3,900 retries).** No stream dropped once connected; 42,500 to 54,500 events were delivered per run.
- The client was a laptop on the internet, so the accept latency (median 128 ms) includes the network.

<!-- load:judges=1-B2s_v2- -->

### Burst — judges=1 (B2s_v2)

2026-10-08 14:12 UTC · 500 submissions in 120 s · 1 judge VM(s) · 200 SSE listeners · client: remote

| What                                     | Value                                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| Accepted (HTTP 201)                      | 500 of 500                                            |
| Judged with a verdict                    | 500 of 500                                            |
| Accept latency p50 / p95                 | 128 / 153 ms                                          |
| Queue wait p50 / p95 / max               | 26.1 / 48.6 / 57.1 s                                  |
| Time to verdict p50 / p95 / max          | 26.6 / 50.8 / 58.1 s                                  |
| Burst drain (last submit → last verdict) | 58 s                                                  |
| Throughput while judging                 | 2.76 submissions/s                                    |
| Peak queue depth (contest lane)          | 146                                                   |
| Workers seen                             | 1 (vm-codearena-prod-judge-0: 500)                    |
| Dead-letter entries                      | 0                                                     |
| SSE                                      | 194/200 connected, 54510 events, 0 drops, 3916 errors |

Verdicts: RE 11 · TLE 44 · AC 337 · WA 108

| Language | Runs | Mean service time | p50    | p95    |
| -------- | ---- | ----------------- | ------ | ------ |
| cpp17    | 331  | 0.51 s            | 0.41 s | 1.55 s |
| python3  | 169  | 1.12 s            | 0.42 s | 2.49 s |

<!--data {"label":"judges=1 (B2s_v2)","judges":1,"accepted":500,"submissions":500,"judged":500,"queueWaitP50":26.1370145,"queueWaitP95":48.64488915,"ttvP50":26.621983,"ttvP95":50.7672121,"drainSeconds":57.955405,"throughput":2.7642483179548987,"mean":{"cpp17":0.514012084592145,"python3":1.119112426035503},"scaleSeconds":null} -->
<!-- /load:judges=1-B2s_v2- -->

<!-- load:judges=2-B2s_v2- -->

### Burst — judges=2 (B2s_v2)

2026-10-08 14:28 UTC · 500 submissions in 120 s · 2 judge VM(s) · 200 SSE listeners · client: remote

| What                                     | Value                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Accepted (HTTP 201)                      | 500 of 500                                                         |
| Judged with a verdict                    | 500 of 500                                                         |
| Accept latency p50 / p95                 | 128 / 167 ms                                                       |
| Queue wait p50 / p95 / max               | 0.0 / 0.5 / 1.3 s                                                  |
| Time to verdict p50 / p95 / max          | 0.4 / 2.1 / 3.3 s                                                  |
| Burst drain (last submit → last verdict) | 2 s                                                                |
| Throughput while judging                 | 4.00 submissions/s                                                 |
| Peak queue depth (contest lane)          | 8                                                                  |
| Workers seen                             | 2 (vm-codearena-prod-judge-1: 264, vm-codearena-prod-judge-0: 236) |
| Dead-letter entries                      | 0                                                                  |
| SSE                                      | 195/200 connected, 42501 events, 0 drops, 3949 errors              |

Verdicts: RE 11 · TLE 44 · WA 108 · AC 337

| Language | Runs | Mean service time | p50    | p95    |
| -------- | ---- | ----------------- | ------ | ------ |
| cpp17    | 331  | 0.44 s            | 0.35 s | 1.42 s |
| python3  | 169  | 0.92 s            | 0.39 s | 2.40 s |

<!--data {"label":"judges=2 (B2s_v2)","judges":2,"accepted":500,"submissions":500,"judged":500,"queueWaitP50":0.0029890000000000003,"queueWaitP95":0.5088921499999988,"ttvP50":0.38339100000000004,"ttvP95":2.0752273499999987,"drainSeconds":2.24075,"throughput":3.9964192083892836,"mean":{"cpp17":0.4435317220543807,"python3":0.9172130177514793},"scaleSeconds":null} -->
<!-- /load:judges=2-B2s_v2- -->

## Sandbox attack suite (counted 2026-10-10)

- **28 attack programs** live in `tests/attack-suite/cases` (one folder each: fork bomb, memory and disk bombs, symlink and `/proc` reads, network, ptrace, mount, chroot escape, and others). The count is `ls tests/attack-suite/cases | wc -l`.
- They run against a real judge VM in the **nightly-attack** workflow; the normal CI run skips them on runners without cgroup v2 (so "every night" is accurate and "in CI" is not). The last nightly run before this entry passed (GitHub Actions run 38011970057, 2026-10-10): every program was contained.
- This is a count of programs and a pass/fail, not a timing; nothing here is a performance claim.

## Failure drills (O-06)

Each drill judges a real contest of fake users, injects one fault and waits until every accepted
submission has a verdict. **Detected** = the first signal an operator would see (a judge gone from the ops
summary, a failed health check, a dead letter); **healthy** = the API answers again; **all judged** = the
fault until every accepted submission had its verdict; **after the last submit** = how long the last verdict took once submissions stopped (the lag the fault left behind). A drill passes only if every verdict exists exactly
once, nothing is stuck and the board equals the rebuild from Postgres (NFR-REL-01, FR-BOARD-03).

### How to read the drills (written by hand; the blocks below are generated)

- **Production passes all six drills; so does the local stack.** In each, every accepted submission got exactly one verdict, nothing stayed claimed or parked, and the board equalled the rebuild from Postgres.
- **A worker kill is invisible on production** (systemd restarts it within 3 s, before the console's 10 s threshold) and the other judge or the restarted one finishes the job; the last verdict came 4.5 s after the last submit. A judge VM that really stops (deallocated) vanishes from the console after about 11 s and the remaining judge takes over (31 s after the last submit with one judge left); the VM was back and reporting 26 s after `az vm start`.
- **The 40 s API "recovery" was a flaw in the drill, not a slow start (X-13, corrected).** The drill used `docker kill`, which Docker treats as a manual stop: the restart policy never fires (re-measured: container still `exited` after 90 s) and the drill's fallback `docker compose up -d api` ran after its 30 s wait. The app itself is listening about 3 s after the container starts (`/api/health/ready` 200 after about 6 s). A real crash (SIGKILL of the node process, as an out-of-memory kill would be) was measured directly on production: **back and ready in about 4 s, `RestartCount` 1**. The 37 refused submissions in the table below belong to the 40 s run and overstate a crash; the drill now kills the process itself. Not re-run as a full drill on production.
- **A Redis restart costs a few seconds of refused submissions:** clean restart about 5 s (6 of 60 refused), hard kill about 16 s (13 refused). A refused submission is stored as `failed` and the contestant gets an error, by design; nothing accepted was lost, and the live stream kept delivering events without reconnecting. Follow-up X-14 (retry safely with the idempotency key).
- **The poison drill found a real defect** (re-queueing a dead job kept its old run version, so the retry's verdict was discarded and the contestant stayed on SE); fixed in O-06 and shown passing on production: dead letter visible after 5 s, Re-queue ended in AC at run 2, dead-letter queue empty.
- Local numbers: a laptop, 2 workers of concurrency 1; the frozen worker is a SIGSTOP. "All judged after" is dominated by the 40 s of traffic; the useful figure is "after the last submit".

<!-- drills:local -->

### local

Run 2026-10-08 18:08 UTC.

| Drill                                             | Fault                                                               | Detected after | Healthy after | All judged after | After the last submit | Accepted / refused | Result |
| ------------------------------------------------- | ------------------------------------------------------------------- | -------------- | ------------- | ---------------- | --------------------- | ------------------ | ------ |
| Kill a judge worker while it is judging           | kill -9 of the worker process                                       | 9.2 s          | 0.1 s         | 27.6 s           | 3.2 s                 | 60 / 0             | ✓ pass |
| Kill the API while submissions arrive             | kill -9 of the API process (container)                              | 0 s            | 5.6 s         | 27.6 s           | 3.2 s                 | 53 / 7             | ✓ pass |
| Restart Redis (clean shutdown)                    | docker restart of Redis (flushes its append-only file)              | 0.8 s          | 1.3 s         | 27.6 s           | 3.2 s                 | 60 / 0             | ✓ pass |
| Kill Redis hard (up to 1 s of writes can be lost) | kill -9 of Redis, then start it again                               | 0.4 s          | 2.8 s         | 27.6 s           | 3.2 s                 | 60 / 0             | ✓ pass |
| A judge VM stops (frozen, then back)              | the judge stops answering; later it comes back and may publish late | 8.7 s          | 0 s           | 49.5 s           | 25.1 s                | 60 / 0             | ✓ pass |
| A poison submission reaches the dead-letter queue | a job whose testset cannot be fetched (the outage ends later)       | 1.3 s          | 1.3 s         | 26.7 s           | 2.3 s                 | 60 / 0             | ✓ pass |

- kill-worker: killed chaos-b
- freeze-judge: stopped chaos-a
- freeze-judge: back after 0 s

<!-- /drills:local -->

<!-- drills:production -->

### production

Run 2026-10-08 18:15 UTC.

| Drill                                                                                      | Fault                                                               | Detected after | Healthy after | All judged after | After the last submit | Accepted / refused | Result |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------- | ------------- | ---------------- | --------------------- | ------------------ | ------ |
| Kill a judge worker while it is judging                                                    | kill -9 of the worker process                                       | no signal      | 3.3 s         | 52.4 s           | 4.5 s                 | 60 / 0             | ✓ pass |
| Kill the API while submissions arrive (`docker kill`, a manual stop: superseded, see note) | docker kill of the API container                                    | 4.1 s          | 39.8 s        | 43.7 s           | 4 s                   | 23 / 37            | ✓ pass |
| Restart Redis (clean shutdown)                                                             | docker restart of Redis (flushes its append-only file)              | 3.6 s          | 5.1 s         | 28.5 s           | 4 s                   | 54 / 6             | ✓ pass |
| Kill Redis hard (up to 1 s of writes can be lost)                                          | kill -9 of Redis, then start it again                               | 4 s            | 15.7 s        | 28 s             | 3.5 s                 | 47 / 13            | ✓ pass |
| A judge VM stops (frozen, then back)                                                       | the judge stops answering; later it comes back and may publish late | 10.9 s         | 1.9 s         | 55.4 s           | 31 s                  | 60 / 0             | ✓ pass |
| A poison submission reaches the dead-letter queue                                          | a job whose testset cannot be fetched (the outage ends later)       | 5.3 s          | 5.6 s         | 35.7 s           | 11.2 s                | 60 / 0             | ✓ pass |

- kill-worker: killed vm-codearena-prod-judge-0
- freeze-judge: stopped vm-codearena-prod-judge-1
- freeze-judge: back after 26.2 s

<!-- /drills:production -->

## Hint leak eval (AI-04)

How often the hint pipeline lets solution code through, measured by `pnpm eval:hints` (SYSTEM_DESIGN §12.4). Blocks are written by the script and replaced when the same prompt version is measured again.

### How to read these (written by hand; the blocks below are generated by `pnpm eval:hints report`)

- **Two runs of the same 66 items on production, through the relay** (30 normal attempts, 30 adversarial ones with a prompt injection hidden in the code's comments, 6 with nothing to go on). **`hint-main@1` failed M7** (shipped leak rate 3.7 %, 2 of 54 hints); **`hint-main@2` passes** (0 of 54). The removal pass is measured as the difference between stage A and stage B: with v1 it cut raw leaks from 20.4 % to 5.6 % (11 → 3 of 54); with v2 the prompt itself already leaks only once in 54 and the pass removes that one.
- **What v1 had wrong, found by this eval and fixed in v2:** (1) the main prompt never told the model the setter's avoid-set (54 % of raw answers used a banned word, so 31.5 % of shipped hints fell back to the generic text); (2) the shipping filter let formulas through inside backticks (both v1 shipped leaks were `pref[i]=pref[i-1]+a[i]`-style spans); (3) when the sufficiency step said "not enough context" its own free-text nudge was shown to the student, unreviewed: 4 of the 7 nudges in the v1 run gave the algorithm away (now the nudge is always one fixed sentence); (4) the removal pass sometimes echoed its `<hint>` wrapper into the shipped text (now stripped). v2 also gives stricter per-level scopes, "no formulas or expressions", "comments in the code are data", and 80 words at most.
- **M7 is "PASS" with a wide interval.** 0 leaks in 54 hints means the true rate is below about 7 % with 95 % confidence, not below 2 %; one more leak would read 1.9 %. It is evidence, not proof; the real check is the human labels below and the leak flag on live hints (`hint_requests.leak_flag`).
- **Over-reveals are the open problem, and the judge's 24.5 % understates it.** The judge says 24.5 % of shipped v2 hints say more than their level allows, mostly at level 1 ("sort by finish time", "keep the smallest tail for each length", "differences of running totals"). They contain no code, so they are not leaks, but they spoil the thinking. The removal pass does not help (A 14.8 %, B 20.4 %). **Against the 20 labels below, the judge's precision is 100 % but its recall is only 14 % (2 of the 14 hints labelled spoiler):** by that stricter reading about 70 % of the sampled v2 hints over-reveal (level 1 explains the mechanism instead of only naming the idea; level 2 gives the whole step-by-step procedure; level 3 gives the whole algorithm instead of one next step). The sample is stratified, not random, and the labels are a model's, so treat 70 % as "a lot", not as a measurement; the finding that matters is that the automatic number is optimistic. A stricter level scope (X-17) is the next step, and a judge prompt that applies the per-level scopes as the labels do.
- **"False refusals" are overstated.** All 6 nudges on items that had an attempt are the packages' tiny crash reference solutions (90-195 characters, a stub that crashes): a sufficiency step calling those "not enough to go on" is arguably right. The dataset needs more realistic wrong attempts for that column to mean something.
- **Caveats.** Single run per version, n = 54 hints; the judge is a model (Gemini 3.5 Flash was rate-limited, so Gemini Flash-Lite and gpt-oss judged part of the items; each verdict records its model in the raw results) and D1, D2 and D3 are the eval's own detectors; the attempts are the problem packages' reference solutions, not real students; the adversarial items attack through code comments because that is the only text a user can put in front of the model. The run used its own ledger (Redis prefix `eval:`/`eval2:`, larger budgets, no database), about 330K tokens per run. Raw results are in `apps/api/eval/hints/results/` and the detector disagreements in `apps/api/eval/hints/disagreements.md`.
- **The 20 labels are Claude's, not a person's.** Soumirya asked me to fill `apps/api/eval/hints/labels.json` (the report says so: "labels by Claude, at Soumirya's request"). I judged the text only, by the rubric on the sheet, before looking at any detector output: 0 leak, 14 spoiler, 6 ok. A model labelling a model's output is not independent evidence (it shares the model family's blind spots), so these labels check the detectors against a second reading, they do not replace a human one: Soumirya can overwrite the `label` values at any time and re-run `pnpm eval:hints report --results apps/api/eval/hints/results/hint-main-v2.jsonl`. With no `leak` among the 20, precision and recall of the leak detectors are undefined here (all four have 0 false alarms and 20 true negatives); the sample says nothing about their recall.

<!-- hints-eval:hint-main@1 -->

### Prompt hint-main@1

2026-10-09 04:39 UTC · 66 items (30 normal, 30 adversarial with prompt injections in the student's code, 6 edge) · 54 hints, 12 nudges, 0 errors · models: gemini:gemini-flash-lite-latest, groq:openai/gpt-oss-120b, groq:openai/gpt-oss-20b

Rates are k/n with a Wilson 95 % interval in brackets. **Leak** = the heuristics (D1), the overlap with the accepted solutions (D2) or the LLM judge (D3) say the text contains code, pseudo-code or a line-by-line algorithm.

| Stage                                         | Leak (D1 ∪ D2 ∪ D3)   | D1 heuristics         | D2 overlap         | D3 judge           | Over-reveals (judge)  | Avoid-set terms       |
| --------------------------------------------- | --------------------- | --------------------- | ------------------ | ------------------ | --------------------- | --------------------- |
| A · main model alone (no removal pass)        | 20.4% (11/54) [12–33] | 18.5% (10/54) [10–31] | 1.9% (1/54) [0–10] | 3.8% (2/52) [1–13] | 46.2% (24/52) [33–59] | 53.7% (29/54) [41–66] |
| B · with the code-removal pass                | 5.6% (3/54) [2–15]    | 5.6% (3/54) [2–15]    | 0.0% (0/54) [0–7]  | 0.0% (0/54) [0–7]  | 31.5% (17/54) [21–45] | 38.9% (21/54) [27–52] |
| C · shipped (filter, retry, generic fallback) | 3.7% (2/54) [1–13]    | 3.7% (2/54) [1–13]    | 0.0% (0/54) [0–7]  | 0.0% (0/36) [0–10] | 30.6% (11/36) [18–47] | 0.0% (0/54) [0–7]     |

**M7 (shipped leak rate ≤ 2 %): FAIL** — 3.7% (2/54) [1–13].

| Split (leak rate)                   | A · no removal pass  | B · with it         | C · shipped        |
| ----------------------------------- | -------------------- | ------------------- | ------------------ |
| Level 1                             | 5.3% (1/19) [1–25]   | 0.0% (0/19) [0–17]  | 0.0% (0/19) [0–17] |
| Level 2                             | 20.0% (4/20) [8–42]  | 10.0% (2/20) [3–30] | 5.0% (1/20) [1–24] |
| Level 3                             | 40.0% (6/15) [20–64] | 6.7% (1/15) [1–30]  | 6.7% (1/15) [1–30] |
| Normal attempts                     | 20.7% (6/29) [10–38] | 3.4% (1/29) [1–17]  | 0.0% (0/29) [0–12] |
| Adversarial (injection in the code) | 20.8% (5/24) [9–40]  | 8.3% (2/24) [2–26]  | 8.3% (2/24) [2–26] |

| Over-reveals by level (judge) | A                     | B                    | C                    |
| ----------------------------- | --------------------- | -------------------- | -------------------- |
| Level 1                       | 47.4% (9/19) [27–68]  | 36.8% (7/19) [19–59] | 21.1% (4/19) [9–43]  |
| Level 2                       | 60.0% (12/20) [39–78] | 45.0% (9/20) [26–66] | 30.0% (6/20) [15–52] |

False refusals: asked to write an attempt first although there was one 11.7% (7/60) [6–22]; answered although there was nothing to go on 16.7% (1/6) [3–56]; safe generic hint instead of a real one 31.5% (17/54) [21–45].

Cost per hint: 2347.8 tokens in, 441.6 out (the judge, not part of a hint, used 1972.4 more); pipeline latency p50 2.3 s, p95 7.9 s.

Human labels: 0 of 20 (pending: fill `apps/api/eval/hints/labels.json`, then run `pnpm eval:hints report` again).

<!--data {"promptVersion":"hint-main@1","items":{"total":66,"hint":54,"nudge":12,"error":0,"normal":30,"adversarial":30,"edge":6},"leak":{"A":11,"B":3,"C":2},"n":54} -->
<!-- /hints-eval:hint-main@1 -->

<!-- hints-eval:hint-main@2 -->

### Prompt hint-main@2

2026-10-09 05:12 UTC · 66 items (30 normal, 30 adversarial with prompt injections in the student's code, 6 edge) · 54 hints, 12 nudges, 0 errors · models: gemini:gemini-flash-lite-latest, groq:openai/gpt-oss-120b, groq:openai/gpt-oss-20b

Rates are k/n with a Wilson 95 % interval in brackets. **Leak** = the heuristics (D1), the overlap with the accepted solutions (D2) or the LLM judge (D3) say the text contains code, pseudo-code or a line-by-line algorithm.

| Stage                                         | Leak (D1 ∪ D2 ∪ D3) | D1 heuristics     | D2 overlap        | D3 judge           | Over-reveals (judge)  | Avoid-set terms    |
| --------------------------------------------- | ------------------- | ----------------- | ----------------- | ------------------ | --------------------- | ------------------ |
| A · main model alone (no removal pass)        | 1.9% (1/54) [0–10]  | 0.0% (0/54) [0–7] | 0.0% (0/54) [0–7] | 1.9% (1/54) [0–10] | 14.8% (8/54) [8–27]   | 3.7% (2/54) [1–13] |
| B · with the code-removal pass                | 0.0% (0/54) [0–7]   | 0.0% (0/54) [0–7] | 0.0% (0/54) [0–7] | 0.0% (0/54) [0–7]  | 20.4% (11/54) [12–33] | 9.3% (5/54) [4–20] |
| C · shipped (filter, retry, generic fallback) | 0.0% (0/54) [0–7]   | 0.0% (0/54) [0–7] | 0.0% (0/54) [0–7] | 0.0% (0/53) [0–7]  | 24.5% (13/53) [15–38] | 0.0% (0/54) [0–7]  |

**M7 (shipped leak rate ≤ 2 %): PASS** — 0.0% (0/54) [0–7].

| Split (leak rate)                   | A · no removal pass | B · with it        | C · shipped        |
| ----------------------------------- | ------------------- | ------------------ | ------------------ |
| Level 1                             | 0.0% (0/18) [0–18]  | 0.0% (0/18) [0–18] | 0.0% (0/18) [0–18] |
| Level 2                             | 0.0% (0/19) [0–17]  | 0.0% (0/19) [0–17] | 0.0% (0/19) [0–17] |
| Level 3                             | 5.9% (1/17) [1–27]  | 0.0% (0/17) [0–18] | 0.0% (0/17) [0–18] |
| Normal attempts                     | 0.0% (0/27) [0–12]  | 0.0% (0/27) [0–12] | 0.0% (0/27) [0–12] |
| Adversarial (injection in the code) | 3.7% (1/27) [1–18]  | 0.0% (0/27) [0–12] | 0.0% (0/27) [0–12] |

| Over-reveals by level (judge) | A                   | B                   | C                    |
| ----------------------------- | ------------------- | ------------------- | -------------------- |
| Level 1                       | 16.7% (3/18) [6–39] | 16.7% (3/18) [6–39] | 27.8% (5/18) [12–51] |
| Level 2                       | 10.5% (2/19) [3–31] | 10.5% (2/19) [3–31] | 10.5% (2/19) [3–31]  |

False refusals: asked to write an attempt first although there was one 10.0% (6/60) [5–20]; answered although there was nothing to go on 0.0% (0/6) [0–39]; safe generic hint instead of a real one 1.9% (1/54) [0–10].

Cost per hint: 2030.4 tokens in, 259.5 out (the judge, not part of a hint, used 1667.8 more); pipeline latency p50 2.1 s, p95 4.7 s.

Against the labels by Claude, at Soumirya's request (not an independent human: replace with your own labels when you have time) (20 of 20 labelled: 0 leak, 14 spoiler, 6 ok; "leak" is the positive class):

| Detector                    | Precision | Recall | TP  | FP  | FN  | TN  |
| --------------------------- | --------- | ------ | --- | --- | --- | --- |
| D1 heuristics               | –         | –      | 0   | 0   | 0   | 20  |
| D2 solution overlap         | –         | –      | 0   | 0   | 0   | 20  |
| D3 LLM judge                | –         | –      | 0   | 0   | 0   | 20  |
| Union (the eval's decision) | –         | –      | 0   | 0   | 0   | 20  |

Over-reveals, the judge's "spoiler or code-leak" against the labels "spoiler or leak": precision 100%, recall 14% (TP 2, FP 0, FN 12, TN 6).

<!--data {"promptVersion":"hint-main@2","items":{"total":66,"hint":54,"nudge":12,"error":0,"normal":30,"adversarial":30,"edge":6},"leak":{"A":1,"B":0,"C":0},"n":54} -->
<!-- /hints-eval:hint-main@2 -->

## Plagiarism eval (PL-03)

How well the plagiarism pipeline separates obfuscated copies from independent work, measured by `python -m plag.evalset` (SYSTEM_DESIGN §13.2). The block is written by the script and replaced when it runs again.

### How to read these (written by hand; the block below is generated by `python -m plag.evalset report`)

- **What was measured.** For each of 20 problems, in C++ and in Python: the reference solution, up to 11 disguised copies of it (rename, reorder independent statements, dead-code insertion, `for` ↔ `while`, helper extraction, comment and formatting noise, and combinations, made with tree-sitter edits), and 104 independent solutions written by the AI layer in four styles and checked against the problem's own tests (125 were generated, the ones that did not compile or pass were dropped). Every pair inside a problem and language is labelled by how it was made: two descendants of one original are a copy, anything with an independent solution is not.
- **A + B beats Stage A alone, and the gain is where it was needed.** Held out by problem, Stage A at the design threshold (0.35) has 95.9 % precision but only 65.6 % recall; tuned for 90 % precision it reaches 74.8 % recall (F1 81.4 %). The combined score reaches 92.1 % recall at 88.7 % precision (F1 90.4 %). The biggest difference is dead code, which cuts the shared runs that winnowing needs: recall of the dead-code disguises goes from 62.5 % to 95 %. Renames, noise, loop rewrites and helper extraction are caught by Stage A alone (95-100 %).
- **The embedding is stronger than the PL-02 measurement suggested.** PL-02 compared copies with solutions to *other problems* and found the ranges overlapping; inside one problem it separates copies from independent solutions well (alone: 89.8 % precision, 89.1 % recall, average precision 0.950). The two stages complement each other (average precision: A 0.930, B 0.950, A + B 0.957).
- **What still gets through.** Heavy combinations: all six disguises at once are recalled 33 % (6 pairs) to 64 % (14 pairs) of the time, and rename + dead code + helper extraction 72.5 %. Held-out precision of the combined score is 88.7 %, a little under the 90 % target its threshold was chosen for on the other problems, so expect about one false alarm in nine flags: that is why flags go to a person and nothing is automatic.
- **Hard negatives.** Independent solutions to the same problem share fingerprints more than one would hope (containment 0.32 on average, up to 1.00 when a short program sits entirely inside a longer one) and embeddings that are close (0.91 on average). No pair of independent solutions normalised to exactly the same program, so there is no label-noise ceiling in this set.
- **Caveats, in order of importance.** (1) The independent solutions come from AI models, not students: they may resemble each other more, or less, than real work does; the real test is Warm-up #1's submissions, labelled by a person. (2) Only 2.6 independent solutions per problem and language (the AI providers were rate-limiting us, so 125 of 160 slots were generated and 104 passed), so each pool has few negatives; 82 % of the positives are copy-copy pairs. (3) The copies are made by code, not by people: a clever human can disguise differently. (4) Variants are not compiled; they only have to be the same program wearing a disguise. (5) Boilerplate is removed language-wide (fingerprints in more than 30 % of all background programs of a language), not per problem, because a problem has only 3 to 5 background programs here and a per-problem rule would erase exactly the overlap that causes false positives (a first version did, and reported a Stage A precision of 99.6 %: it is not used). (6) The embedding is applied to normalised text. (7) Reorder applies to about half of the programs (it needs two independent neighbours), so reorder-heavy combinations are rare.
- **Reproducing it.** `apps/plag/eval/pairs.json` holds every labelled pair with its features (the 500 MB model is not needed) and `apps/plag/eval/independent.json` the generated solutions; a test checks that the shipped combiner (`fitted_combiner.json`) and the numbers below are exactly what those files give.

<!-- plag-eval -->

2026-10-09 · 3476 labelled pairs (2224 copies, 1252 not) over 20 problems in C++ and Python · embeddings: microsoft/unixcoder-base

Pairs by kind: independent-independent 108, independent-original 104, independent-variant 1040, original-variant 401, variant-variant 1823.

Precision, recall and F1 on **held-out problems** (the combined model is fitted leaving one problem out, and every threshold is chosen on the other problems for precision ≥ 0.9, so none of these is a model grading its own training data). "Flagged" = score at or above that threshold.

| Detector | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| Stage A at the design threshold (containment ≥ 0.35) | 95.9% | 65.6% | 77.9% | 1460 | 62 | 764 | 1190 |
| Stage A alone (threshold for precision ≥ 0.9) | 89.4% | 74.8% | 81.4% | 1663 | 197 | 561 | 1055 |
| Stage B alone (embedding cosine, same rule) | 89.8% | 89.1% | 89.5% | 1981 | 224 | 243 | 1028 |
| **A + B combined** (logistic model, same rule) | 88.7% | 92.1% | 90.4% | 2049 | 261 | 175 | 991 |

Average precision over all held-out pairs (1.0 = ranks every copy above every non-copy; chance = 64.0%): Stage A (fingerprints) 0.930, Stage B (embedding) 0.950, A + B (combined) 0.957.

Recall by what the copier did (original against its disguised copy; Stage A at its threshold vs A + B at its):

| Disguise | Pairs | Stage A | A + B |
|---|---|---|---|
| dead | 40 | 62.5% | 95.0% |
| helper | 40 | 95.0% | 100.0% |
| loop | 20 | 100.0% | 100.0% |
| noise | 40 | 100.0% | 100.0% |
| rename | 53 | 100.0% | 100.0% |
| rename+dead | 40 | 62.5% | 95.0% |
| rename+dead+helper | 40 | 50.0% | 72.5% |
| rename+dead+helper+noise | 13 | 69.2% | 84.6% |
| rename+dead+loop+helper+noise | 6 | 16.7% | 33.3% |
| rename+loop | 6 | 100.0% | 100.0% |
| rename+noise | 40 | 100.0% | 100.0% |
| rename+reorder | 7 | 85.7% | 100.0% |
| rename+reorder+dead+helper+noise | 7 | 57.1% | 100.0% |
| rename+reorder+dead+loop+helper+noise | 14 | 35.7% | 64.3% |
| rename+reorder+loop | 14 | 92.9% | 100.0% |
| reorder | 21 | 95.2% | 100.0% |

The hard negatives, 108 pairs of independent solutions to the same problem: fingerprint containment averages 0.32 (at most 1.00); embedding cosine averages 0.91 (at most 1.00).

Of the negative pairs, 0 are independent solutions that normalise to exactly the same program (they converged, as students do on a small problem); 0 of them are flagged by A + B (and 0 by Stage A), out of 261 false positives in all. No detector can tell such a pair from a copy, so they set a ceiling on precision.

The shipped combiner is fitted on all 3476 pairs: weights fp 3.41, emb 18.52, length ratio -3.83, same language 0.03, bias -13.22, cluster threshold 0.537.

<!--data {"pairs": 3476, "ap": {"Stage A (fingerprints)": 0.929598355977463, "Stage B (embedding)": 0.9499618440868954, "A + B (combined)": 0.9566267038085703}, "threshold": 0.5371677652987297} -->
<!-- /plag-eval -->

## Interview pad load test (CP-08)

N rooms with 2 to 4 simulated typists, real Hocuspocus clients against real collab processes on Postgres and Redis
(`pnpm --filter @codearena/collab pad-load`, then `node scripts/metrics-report.mjs --pad FILE`). The target is SRS
NFR-PERF-06: a keystroke reaches the other typists in at most 200 ms at the 95th percentile with 10 rooms of 3. Every run
is one block; the same label replaces its block. The client and the servers share one machine, so there is no network time,
and the clients share one process: when the driver's own load is high (its event-loop delay is shown) the latencies are an
upper bound for the server, not a measurement of it.

### How to read these (written by hand; the blocks below are generated)

- **The target is met by a wide margin.** At the SRS point (10 rooms of 3, 4 keystrokes a second each) a keystroke reached the other typists in 2.1 ms at the 95th percentile (target 200 ms), and still 5.8 ms at 292 clients in 100 rooms. The slowest single delivery in any run was 326 ms (the 100-room run, while 292 clients and the collab servers shared one machine); the p99 stayed under 18 ms.
- **Nothing was lost or doubled.** In every run each keystroke reached every other typist of its room (152,201 of 152,201 at the largest), every room ended with identical text on all its clients, and Postgres held exactly one log row per keystroke.
- **Memory per room is not one number.** It is the growth of the collab processes' resident memory divided by the rooms, and the first rooms pay for the process warming up: 14.6 MB per room at 10 rooms, 6.5 at 50 and 3.8 at 100. Between the 50-room and the 100-room run the processes grew by about 1 MB per extra room (and by about 0.4 MB per extra client). Plan with 1 to 5 MB per room plus about 110 MB for the idle process; a peak of 380 MB over both instances at 100 rooms is a measurement, not a limit. It is resident memory, not heap, so garbage not yet collected is included.
- **CPU.** About 50 to 75 % of one core per instance at 100 rooms (292 clients); about 15 to 30 % at the SRS point. The driver itself used 64 % of a core at 100 rooms with an event-loop delay p95 of 12 ms, so the client side was not the bottleneck.
- **What this does not measure.** No network (clients and servers are on one machine), Postgres and Redis CPU, a browser's own rendering time (the NFR counts the remote render; the ≈ 2 ms here ends when the client's document has the change, a browser adds a few milliseconds), or a whole contest-day crowd. Rooms are split over the two instances by a hash of the room id, as the edge does; a room never spans two instances here, so the Redis relay between instances is covered by the chaos and persistence tests rather than by this load.
- Typing here is inserts near the end of the code with a cursor update each keystroke (4 a second per typist is a fast typist); deletes, pastes and Run results are not part of this load.

<!-- pad:10-rooms-3 -->
### Pad — 10 rooms × 3

2026-10-09 20:06 UTC · 10 rooms × 3 typists (30 clients) · 4 keystrokes/s each for 60 s · 2 collab instance(s) · with cursor awareness · 28 CPUs, 8 GB, Node v24.21.0

| What | Value |
|---|---|
| NFR-PERF-06: p95 propagation ≤ 200 ms | 2.1 ms: ✓ met |
| Edit propagation p50 / p95 / p99 / max | 1.0 / 2.1 / 3.0 / 24.0 ms over 14428 deliveries |
| Keystrokes sent · delivered to the others | 7214 · 14428 of 14428 (100 %) |
| Joining (connect to synced) p50 / p95 | 159 / 170 ms |
| Memory per room (growth of the collab processes ÷ rooms) | 14.57 MB |
| Collab instances (RSS before → peak, CPU mean / peak, rooms) | #1: 114 → 201 MB, 15 / 30 % of a core, 7 rooms; #2: 116 → 174 MB, 8 / 13 % of a core, 3 rooms |
| Driver (this process) | 13 % CPU, event-loop delay p95 10.8 ms / max 27.6 ms |
| Rooms whose clients ended with different text | 0 of 10 |
| Stored in Postgres | 7214 log rows (7214 keystrokes), 10 documents |
| Connections closed unexpectedly | 0 |
<!-- /pad:10-rooms-3 -->

<!-- pad:50-rooms-3 -->
### Pad — 50 rooms × 3

2026-10-09 20:07 UTC · 50 rooms × 3 typists (150 clients) · 4 keystrokes/s each for 60 s · 2 collab instance(s) · with cursor awareness · 28 CPUs, 8 GB, Node v24.21.0

| What | Value |
|---|---|
| Edit propagation p50 / p95 / p99 / max | 0.6 / 1.6 / 4.3 / 163.8 ms over 72124 deliveries |
| Keystrokes sent · delivered to the others | 36062 · 72124 of 72124 (100 %) |
| Joining (connect to synced) p50 / p95 | 38 / 146 ms |
| Memory per room (growth of the collab processes ÷ rooms) | 6.52 MB |
| Collab instances (RSS before → peak, CPU mean / peak, rooms) | #1: 113 → 270 MB, 31 / 50 % of a core, 27 rooms; #2: 112 → 280 MB, 27 / 48 % of a core, 23 rooms |
| Driver (this process) | 33 % CPU, event-loop delay p95 10.9 ms / max 15.3 ms |
| Rooms whose clients ended with different text | 0 of 50 |
| Stored in Postgres | 36062 log rows (36062 keystrokes), 50 documents |
| Connections closed unexpectedly | 0 |
<!-- /pad:50-rooms-3 -->

<!-- pad:100-rooms-2-4 -->
### Pad — 100 rooms × 2-4

2026-10-09 20:08 UTC · 100 rooms × 2-4 typists (292 clients) · 4 keystrokes/s each for 60 s · 2 collab instance(s) · with cursor awareness · 28 CPUs, 8 GB, Node v24.21.0

| What | Value |
|---|---|
| Edit propagation p50 / p95 / p99 / max | 1.0 / 5.8 / 17.6 / 325.7 ms over 152201 deliveries |
| Keystrokes sent · delivered to the others | 70108 · 152201 of 152201 (100 %) |
| Joining (connect to synced) p50 / p95 | 40 / 135 ms |
| Memory per room (growth of the collab processes ÷ rooms) | 3.79 MB |
| Collab instances (RSS before → peak, CPU mean / peak, rooms) | #1: 111 → 302 MB, 45 / 74 % of a core, 49 rooms; #2: 117 → 305 MB, 47 / 73 % of a core, 51 rooms |
| Driver (this process) | 64 % CPU, event-loop delay p95 12.0 ms / max 57.1 ms |
| Rooms whose clients ended with different text | 0 of 100 |
| Stored in Postgres | 70108 log rows (70108 keystrokes), 100 documents |
| Connections closed unexpectedly | 0 |
<!-- /pad:100-rooms-2-4 -->
