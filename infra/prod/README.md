# Production deployment (D-02)

How CodeArena gets onto the Azure servers and stays updated. Terraform (`infra/terraform`) made the
two servers; this directory is what runs **on** them and the pipeline that updates them.

```
git push main ──▶ ci.yml passes ──▶ deploy.yml
                                      ├─ build API image ─▶ ghcr.io (by digest)
                                      ├─ deploy-api:    upload files, deploy.sh on the API VM
                                      │                 (migrate, switch, health check, ROLLBACK if unhealthy)
                                      └─ deploy-judges: worker binary ─▶ each judge, one at a time (rolls itself back)
nightly (03:00 IST) ─▶ nightly-attack.yml ─▶ attack suite on a judge VM
```

Browser ──▶ **Vercel** (web) ──`/api/*` rewrite──▶ **Caddy** on the API VM ──▶ API · Postgres · Redis · object storage.
The realtime stream skips Vercel and goes straight to `api.<ip>.sslip.io` (Caddy adds the CORS header).

## What is where

|                                                   |                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`, `Caddyfile`, `s3.json.tmpl` | the production stack (uploaded to `/opt/codearena` on every deploy)                                |
| `init-env.sh`                                     | creates the server's secrets **on the server** (nothing secret passes through git, GitHub or chat) |
| `deploy.sh`                                       | runs on the API VM: pull, migrate, switch, health check, automatic rollback                        |
| `judge/`                                          | worker unit, node-exporter unit, `provision.sh` (runs on a judge)                                  |
| `ci/`                                             | what the pipeline runs: `ssh-config.sh`, `deploy-api.sh`, `deploy-judges.sh`, `run-attack.sh`      |
| `bootstrap.sh`                                    | one-time setup, run from your laptop                                                               |
| `tests/`                                          | offline tests for all of the above                                                                 |

## One-time setup (you)

**1. Web on Vercel (U5.2).** Import the GitHub repo, set the _Root Directory_ to `apps/web`, and add
two environment variables (use your API host from `terraform output api_host_sslip`):

```
API_PROXY_URL=https://api.40-83-75-34.sslip.io
NEXT_PUBLIC_REALTIME_URL=https://api.40-83-75-34.sslip.io
```

Deploy once; Vercel gives you a URL like `https://codearena-xxxx.vercel.app`. That is your **web URL**.

**2. OAuth apps (U5.2).** The API refuses to start without a Google and a GitHub app, and sign-in only
works if the redirect address matches exactly. Use your **web URL** (not the API host):

- Google Cloud Console → _APIs & Services → Credentials → OAuth client ID (Web)_, authorized redirect URI:
  `https://<your-web-url>/api/auth/callback/google`
- GitHub → _Settings → Developer settings → OAuth Apps → New_, callback URL:
  `https://<your-web-url>/api/auth/callback/github`

Keep the client id and secret of each: you will type them on the server in step 4 (never into chat).

**3. Prepare the servers.** From the repository, in WSL:

```bash
infra/prod/bootstrap.sh --api-ip 40.83.75.34 --api-private-ip 10.20.1.4 \
  --judges "10.20.2.4" --web-url https://<your-web-url> --set-github
```

It creates a separate SSH key for the pipeline (`~/.ssh/codearena_deploy`), authorizes it on the
servers, uploads the files, generates every secret on the API VM, and sets the GitHub secret and
variables (needs `gh auth login` once). It prints the servers' host key fingerprints: compare them
with the ones you accepted when you first logged in (API `SHA256:li4V…`, judge `SHA256:iBke…`).

**4. Sign-in values (hidden prompts, one value at a time).** From your own machine:

```bash
infra/prod/set-oauth.sh all      # or: google | github
```

It logs in with the deploy key, asks for each value in turn (paste **only the value**, once, never a
command), saves it to the server's `prod.env`, and restarts the API. A Google client ID that is not exactly
one `<digits>-<letters>.apps.googleusercontent.com` is refused. `./init-env.sh show-keys` on the server
shows which values are set, never the values.

Until these are set the site comes up but sign-in does not work (the placeholders say `not-configured`).

**5. Turn the pipeline on and deploy.**

```bash
gh variable set DEPLOY_ENABLED --body true
gh workflow run deploy.yml
gh run watch
```

Then open `https://api.40-83-75-34.sslip.io/api/health/ready`: it should answer `{"status":"ok",…}`.
(The first certificate takes up to a minute.)

**6. Protect the secret.** In GitHub: _Settings → Environments → production → Deployment branches →
Selected branches → `main`_. This repository is public: this makes sure only code on `main` can use the
deploy key.

## Prove the rollback works (needed once, D-02 acceptance)

```bash
gh workflow run deploy.yml -f rollback_drill=true -f skip_judges=true
gh run watch
```

The run is **expected to fail**. Open its log and find `the new release is NOT healthy` →
`rolling back to …` → `rolled back: … is live again`. Then confirm the site is still up on the
previous release (`/api/health/ready`). (On the very first deploy there is no previous release to go
back to; do the drill after a second deploy.)

## Everyday

- **Logs:** `ssh codearena@<api> 'cd /opt/codearena && docker compose --env-file prod.env logs --tail 100 api'`; judges: `ssh -J codearena@<api> codearena@<judge> 'sudo journalctl -u codearena-worker -n 100'`.
- **Roll back by hand:** `ssh codearena@<api> "/opt/codearena/deploy.sh $(cat /opt/codearena/state/previous)"`.
- **Add or remove judges:** `scripts/scale-judges.sh up 1` / `down 1` / `to 1` (at most 2 judges: Azure for Students allows 6 vCPUs per region) (runbook: `docs/runbooks/contest-day.md`). It runs Terraform, waits for the new VMs, locks them down, authorises the deploy key, updates `JUDGE_HOSTS` / `JUDGE_HOST_KEYS` and installs the worker. Do it hours before a contest: while it runs the judge firewall is open.
- **During a contest:** freeze deploys (`gh variable set DEPLOY_ENABLED --body false`) and switch the nightly attack run off the same way.

## Who is admin

The owner is the account whose verified sign-in address equals `OWNER_EMAIL`; it is always admin and alone sees **Admin → Admins**, where it lists the addresses that become admin when they sign in (FR-AUTH-12 to FR-AUTH-14). Set it once, then deploy (or just restart the API):

```
ssh codearena@<api> "cd /opt/codearena && echo 'OWNER_EMAIL=soumiryasarangi@gmail.com' >> prod.env && docker compose --env-file prod.env up -d api"
```

Unset, nobody is owner and the page answers 403. The address is not a secret. The deploy applies the `admin_grants` migration before it switches the API over. Until the owner has set this, the only way to make an admin is `UPDATE users SET role='admin' WHERE email='…'` on the database.

## Rules that keep this safe

- **Migrations must be additive** (add columns/tables, never drop or rename in the same release): a rollback keeps the new schema, so the previous release has to work on it. Do a destructive change in two releases.
- **The deploy key is an admin key** for both servers. It lives only in a GitHub secret and in `~/.ssh/codearena_deploy`. To rotate: delete the key file, run `bootstrap.sh --set-github` again, and remove the old line from `~/.ssh/authorized_keys` on each server.
- **Judges hold no database credentials.** `judge-worker.env` has only the Redis `judge` user and a read-only storage key (ADR-009); it is generated on the API VM and streamed to the judges, never stored in GitHub.
- **Judge VMs have no internet.** Everything they run is shipped to them through the API VM; nothing is downloaded there.

## Not done yet (on purpose)

- Importing the practice problems into production (`pnpm problem:import` is not in the API image yet): needs the admin upload (P-02/UI-04).
- The collaborative pad service (`/collab`) answers 503 until Day 12.
- Alerting on `backup.prom` (a stale or failed backup), and host metrics of the judges (node exporter listens on the private address; scraping it needs another firewall rule, deliberately not opened in O-01).
- Logs in Grafana (Loki): logs stay structured JSON in `docker compose logs` for now.

## Observability (O-01)

Traces and metrics: API and judges send OTLP/HTTP to the OpenTelemetry Collector on the API VM (`otelcol` in `docker-compose.yml`, profile `observability`, config `otelcol.yaml`), which forwards to Grafana Cloud. It starts only after the Grafana settings exist.

1. Apply the firewall change (new port 4318 from the judge subnet, ADR-009 addendum): `terraform apply` in `infra/terraform`.
2. `infra/prod/set-grafana.sh`: hidden prompts for the OTLP endpoint, instance ID and token of your Grafana Cloud stack; it stores them in `prod.env`, adds `OTEL_EXPORTER_OTLP_ENDPOINT` for the API (`http://otelcol:4318`) and for the judges (`judge-worker.env`, the collector's private address), starts the collector and restarts the API. Later deploys keep the collector in step with `otelcol.yaml`.
3. Re-run the deploy workflow so the judges receive the new `worker.env` and restart.
4. `infra/grafana/push.sh https://<stack>.grafana.net` uploads the dashboards and alert rules (see `infra/grafana/README.md`).
5. Sentry (optional): `./init-env.sh ensure prod SENTRY_DSN not-configured && ./init-env.sh set SENTRY_DSN` on the server, then recreate the API. For the web app set `NEXT_PUBLIC_SENTRY_DSN` in the Vercel project settings.

**UptimeRobot** (free, 5-minute interval; 1-minute on paid plans): create three HTTP(s) monitors and send alerts to your e-mail/phone:

| Monitor                                  | URL                                   | Expect |
| ---------------------------------------- | ------------------------------------- | ------ |
| API liveness                             | `https://<api host>/api/health/live`  | 200    |
| API readiness (database, Redis, storage) | `https://<api host>/api/health/ready` | 200    |
| Web                                      | `https://<web url>/`                  | 200    |
| Status page (after O-02)                 | `https://<web url>/status`            | 200    |

## Backups (D-03)

Postgres is the source of truth, so it is backed up every night to the private `backups` container in Azure Blob.

**Turn it on (once, from your machine, after the first deploy):**

```bash
infra/prod/enable-backups.sh
```

It reads the storage account, container and upload token from your local Terraform state (the token is never
printed), writes them to `/opt/codearena/backup.env` on the API VM (mode 600), installs two systemd timers,
then takes a first backup and restores it into a throwaway database to prove it works.

| What                                                                                                                       | When                   | Where it runs                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `backup.sh`: `pg_dump` → check readable → upload → verify size and SHA-256                                                 | every night 03:00 IST  | API VM, timer `codearena-backup.timer`                               |
| `restore-test.sh --latest`: restore the newest dump into a temporary Postgres, check every table and that `users` has rows | every Sunday 04:00 IST | API VM, timer `codearena-restore-test.timer`                         |
| `backup.sh --label pre-contest`: a manual backup (before and after each contest)                                           | when you run it        | `ssh codearena@<api> '/opt/codearena/backup.sh --label pre-contest'` |

Look at them: `systemctl list-timers 'codearena-*'`, `journalctl -u codearena-backup -n 30`,
`cat /opt/codearena/state/backup.prom` (last result, last good time and size, metrics for Grafana later).
Backups are kept 30 days (Azure lifecycle rule; the upload token cannot delete). The upload token expires
on `backup_sas_expiry`: before then change that date in `terraform.tfvars`, `terraform apply`, and run
`infra/prod/enable-backups.sh --no-first-run` again. Restoring for real: `docs/runbooks/backup-restore.md`.
