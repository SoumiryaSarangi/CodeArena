# Runbook: contest day

Draft from PLAN §10 (O-04). Rehearse it on the dry-run contest (U9.2) and fix anything that does not work as
written. Numbers marked _measured_ come from `docs/METRICS.md` once O-03 has run; until then the capacity
maths in SYSTEM_DESIGN §2.3 is the guide.

**Who watches what.** Screen 1: ops console (`/admin/contests/<id>/ops`). Screen 2: Grafana (contest-ops
dashboard). Screen 3: clarifications inbox. `/status` is what contestants see.

## Capacity in one table

| Judges | Throughput | Use |
|---|---|---|
| 1 | ~0.5 submissions/s | quiet days, Warm-up #1 would be fine |
| 4 (steady + 3) | ~2/s | **contest day** (headroom and fault tolerance) |
| 6 | ~3/s | if p95 stays high |

The SLO is p95 time-to-verdict ≤ 15 s. Expect about 0.17 submissions/s at the peak of Warm-up #1.

## Scaling judges (`scripts/scale-judges.sh`)

```bash
scripts/scale-judges.sh status        # how many exist, how many report to the queue
scripts/scale-judges.sh up 3          # add 3 (D2s_v5: not burstable, so timings stay fair)
scripts/scale-judges.sh down 1        # remove 1 (drains it first)
scripts/scale-judges.sh to 1          # steady state: 1 judge, default size, locked down
```

- **`up` takes several minutes and opens the judge firewall while it runs** (a new judge builds its sandbox
  from the internet; the firewall is one rule for all judges). It refuses while a contest is running. Do it
  at **T-5 h**, never during the contest. The scale-out time is _measured_ in METRICS.md.
- During a contest only `down` is safe. If p95 > 10 s for 2 minutes and you have to add judges anyway,
  `--allow-running-contest` exists: you accept a few minutes with the judges' firewall open (they hold the
  Redis `judge` user and read-only storage key, never database credentials, ADR-009).
- Every extra D2s_v5 costs about $0.13/h. A forgotten one is about $95 a month: **`to 1` at the end of the day**.
- It needs `az login`, `gh auth login`, Terraform state in `infra/terraform`, and your SSH key.

## T-5 h

- [ ] `scripts/scale-judges.sh up 3`; ops console shows 4 workers with fresh heartbeats.
- [ ] Nightly attack suite green; `/api/health/ready` and `/status` green; Grafana alerts armed.
- [ ] Backup taken manually (`infra/prod/backup.sh`); last restore test passed (`scripts/restore-test.sh`).
- [ ] Validate all six problems again in production.
- [ ] One warm-up submission in each language on production.
- [ ] No leftover load-test data: `tests/load/prod.sh cleanup`.

## T-30 min

- [ ] Open the lobby, post the link, pin the rules.
- [ ] Ops console, Grafana and the clarifications inbox open.
- [ ] Hints are off for contest problems (try one).

## During

Watch lane depth, p95, DLQ, worker heartbeats.

| Symptom | Do |
|---|---|
| p95 > 10 s for 2 min | `scripts/scale-judges.sh up 2 --allow-running-contest` (see the trade-off above), or live with it if the queue is draining |
| DLQ entry | inspect it in the ops console, re-queue once; if it comes back, rejudge that submission after the contest |
| Wrong test data found | fix the package, rejudge that problem (ops console), announce it |
| A judge VM dies | its jobs are re-delivered by the lease reaper; confirm in the console, then `scale-judges.sh status` |
| Redis dies | restart it, run `rebuild-board`, announce "board refreshed" |
| Need more time | ops console → +5 min (announces itself) |
| Bad problem | ops console → hide the problem (removed from the board) |

## After

- [ ] 21:00 freeze stays on; 21:15 resolver ceremony (`/c/<slug>/board?present=1`).
- [ ] 21:45 Finalise the contest (ratings), AI reviews are queued.
- [ ] 22:00 `scripts/scale-judges.sh to 1`; export metrics; feedback form.
- [ ] 23:00 start the plagiarism run (review next day).

## Failure drills

Practised in O-06 (`tests/chaos/`, runbooks in this folder once written): kill a worker, kill the API,
restart Redis, stop a judge VM, poison submission.
