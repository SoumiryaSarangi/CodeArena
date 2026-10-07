# Runbook: deploy, rollback, and what to do when it breaks

Setup and everyday commands: `infra/prod/README.md`. This page is for the moment something is wrong.

## How a release goes out
1. `main` passes CI → `deploy.yml` builds the API image, pushes it to GHCR, and gets its **digest**.
2. `deploy-api`: files uploaded to `/opt/codearena`, then `deploy.sh <image@digest>` on the API VM:
   pull → postgres/redis/storage up → **migrate with the new image** → switch the API → health check
   (`/api/health/ready`, up to 90 s) → on failure **switch back to the previous digest**.
3. `deploy-judges`: the worker binary goes to each judge in turn; `provision.sh` restarts the worker,
   waits for `worker started` in the log, and restores the previous binary if it does not appear. The
   first failing judge stops the rollout so the others keep the old release.

## Reading a failed deploy
| Log says | Meaning | Do |
|---|---|---|
| `migration failed; the running API was not touched` | the new migration is wrong | fix forward; nothing changed in production |
| `the new release is NOT healthy` … `rolled back: … is live again` | automatic rollback worked (exit 1) | read `docker compose logs api` on the server, fix, merge again |
| `no previous release to go back to` | first deploy failed | read the API log; fix; rerun |
| `ROLLBACK IS NOT HEALTHY EITHER` (exit 2) | both releases are down | see "Both down" below |
| `judge … failed to start the new worker (it rolled itself back)` | a judge refused the new worker | `journalctl -u codearena-worker` on it; the others are untouched |
| `another deploy is running` | two deploys overlapped | wait; it will not corrupt anything |

## Both down
```bash
ssh codearena@<api>
cd /opt/codearena
docker compose --env-file prod.env ps
docker compose --env-file prod.env logs --tail 200 api
cat state/current state/previous        # the two digests we know
```
Common causes: a bad value in `prod.env` (`./init-env.sh show-keys`), Postgres or Redis not healthy
(`ps`), disk full (`df -h`). Bring back the last good release with
`./deploy.sh <digest from state/previous>`.

## A migration went out that the old release cannot read
This is why migrations must be additive. If it happens: deploy a fix forward (a release that works on
the new schema). Do not edit the database by hand during a contest.

## Secrets
- Rotate the **deploy key**: see `infra/prod/README.md`.
- Rotate **everything on the server** (`init-env.sh init --force`) only with a plan: it changes the
  database, Redis and storage passwords and invalidates all sessions (new JWT keys). Judges need the new
  `judge-worker.env`, which the next deploy ships.
- GitHub shows a secret was used (*Actions → the run*); it never shows the value.

## Contest day
- Freeze: `gh variable set DEPLOY_ENABLED --body false` (stops deploys and the nightly attack run).
- Before: take a manual backup (D-03), run the deploy workflow once to confirm the pipeline is healthy,
  and switch the judges to `Standard_D2s_v5` (`infra/terraform/README.md`).
- After: set it back to `true`.
