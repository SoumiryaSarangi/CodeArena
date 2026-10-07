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
- **Add a judge:** `terraform apply -var judge_count=2` (see `infra/terraform/README.md`), run `bootstrap.sh` again with `--judges "10.20.2.4 10.20.2.5"`, update the `JUDGE_HOSTS` variable (bootstrap does it with `--set-github`), run the deploy workflow.
- **During a contest:** freeze deploys (`gh variable set DEPLOY_ENABLED --body false`) and switch the nightly attack run off the same way.

## Rules that keep this safe

- **Migrations must be additive** (add columns/tables, never drop or rename in the same release): a rollback keeps the new schema, so the previous release has to work on it. Do a destructive change in two releases.
- **The deploy key is an admin key** for both servers. It lives only in a GitHub secret and in `~/.ssh/codearena_deploy`. To rotate: delete the key file, run `bootstrap.sh --set-github` again, and remove the old line from `~/.ssh/authorized_keys` on each server.
- **Judges hold no database credentials.** `judge-worker.env` has only the Redis `judge` user and a read-only storage key (ADR-009); it is generated on the API VM and streamed to the judges, never stored in GitHub.
- **Judge VMs have no internet.** Everything they run is shipped to them through the API VM; nothing is downloaded there.

## Not done yet (on purpose)

- Importing the practice problems into production (`pnpm problem:import` is not in the API image yet): needs the admin upload (P-02/UI-04).
- The collaborative pad service (`/collab`) answers 503 until Day 12.
- Grafana Cloud wiring (O-01). Node exporter is installed on the judges and listens on the private address, ready for it.
