# Runbook: contest day

Draft from PLAN §10 (O-04). Rehearse it on the dry-run contest (U9.2) and fix anything that does not work as
written. Numbers marked _measured_ come from `docs/METRICS.md` once O-03 has run; until then the capacity
maths in SYSTEM_DESIGN §2.3 is the guide.

**Who watches what.** Screen 1: ops console (`/admin/contests/<id>/ops`). Screen 2: Grafana (contest-ops
dashboard). Screen 3: clarifications inbox. `/status` is what contestants see.

## Capacity in one table (measured, `docs/METRICS.md`)

| Judges | Burst of 500 in 2 min (4.2/s) | Use |
|---|---|---|
| 1 | queue wait p95 49 s, queue empty 58 s after the last submit; one judge sustains about 2.8 submissions/s on the test problems | quiet days; enough for Warm-up #1's expected load (about 0.17/s at the peak) |
| 2 | queue wait p95 0.5 s, time to verdict p95 2.1 s | **contest day**: headroom and a second judge if one dies |

**You cannot add more than 2 judges** on this Azure for Students subscription: 6 vCPUs per region in total (API 2 + 2 per judge) and no quota for the D2s_v5 family. `scale-judges.sh` checks this and refuses before it creates anything. The SLO is p95 time-to-verdict ≤ 15 s; the test problems judge in about half a second, the contest problems may be heavier.

## Scaling judges (`scripts/scale-judges.sh`)

```bash
scripts/scale-judges.sh status        # how many exist, how many report to the queue
scripts/scale-judges.sh up 1          # add 1 (at most 2 judges in total: Azure quota)
scripts/scale-judges.sh down 1        # remove 1 (drains it first)
scripts/scale-judges.sh to 1          # steady state: 1 judge, default size, locked down
```

- **`up` takes about 6-7 minutes and opens the judge firewall while it runs** (a new judge builds its sandbox
  from the internet; the firewall is one rule for all judges). It refuses while a contest is running and
  puts the locked-down fleet back by itself if anything fails. Do it at **T-5 h**, never during the contest.
  At most 2 new judges are added at a time (Azure allows 3 public IPs, the API VM uses one).
- During a contest only `down` is safe. If p95 > 10 s for 2 minutes and you have to add judges anyway,
  `--allow-running-contest` exists: you accept a few minutes with the judges' firewall open (they hold the
  Redis `judge` user and read-only storage key, never database credentials, ADR-009).
- An extra Standard_B2s_v2 costs about $0.12/h (about $85 a month if forgotten): **`to 1` once the contest is over**.
- It needs `az login`, `gh auth login`, Terraform state in `infra/terraform`, and your SSH key.

## T-5 h

- [ ] `scripts/scale-judges.sh up 1`; ops console shows 2 workers with fresh heartbeats.
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
| p95 > 10 s for 2 min | with 1 judge: `scripts/scale-judges.sh up 1 --allow-running-contest` (see the trade-off above); with 2 there is nothing more to add (quota): check the DLQ and a stuck judge first |
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
