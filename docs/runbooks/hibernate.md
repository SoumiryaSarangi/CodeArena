# Hibernate and wake up (save the Azure credit)

For the owner. Use this when the project is finished but will not be shown for a while: **switch off what costs
money, keep what is free, and bring everything back in about ten minutes** when it is time to show it.
It contains no secrets. It is not linked from the README on purpose.

All commands run in WSL from the repository, after `az login` (and `gh auth login` for the GitHub steps).
Names come from Terraform: resource group `rg-codearena-prod`, VMs `vm-codearena-prod-api` and
`vm-codearena-prod-judge-0`, API address `40.83.75.34` (private `10.20.1.4`), judge private `10.20.2.4`,
deploy key `~/.ssh/codearena_deploy`.

> I have not run these commands against your subscription; I checked the names and behaviour against the Terraform,
> the deploy scripts and the runbooks. Do the first hibernate once while you are watching, and check the
> numbers in the Azure portal (see "How much it saves").

## 1. What to stop, what to keep

| Piece                                                   | Costs money?                                | Action                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API VM** (Postgres, Redis, object storage, API, collab, Caddy) | Yes, by the hour while it runs              | **Deallocate**                                                                                                                                               |
| **Judge VM** (the worker)                               | Yes, by the hour while it runs              | **Deallocate**                                                                                                                                               |
| Disks of both VMs (hold the database and test data)     | Yes, a few dollars a month, even when off   | **Keep.** Deleting them deletes your data.                                                                                                                   |
| Static public IP `40.83.75.34`                          | Yes, a few dollars a month                  | **Keep.** The API address, the Vercel settings and the OAuth setup are all built on it; releasing it breaks them.                                           |
| Backup storage account (Azure Blob)                     | Pennies                                     | **Keep.** It holds your database backups (30 days).                                                                                                          |
| Vercel (web and the AI relay)                           | Free plan                                   | **Keep running.** Nothing to do.                                                                                                                             |
| AI providers (Groq, Gemini), Grafana Cloud              | Free tiers                                  | **Keep.** Nothing to do.                                                                                                                                     |
| GitHub (repo, CI, container images), OAuth apps, sslip.io | Free                                      | **Keep.** But turn the deploy and nightly runs off (below), or they fail every day.                                                                          |

Never use "Stop" from inside the VM, `shutdown`, or the portal's older "Stop" without deallocation: the VM looks off
but **compute billing continues**. Only the state **Deallocated** (VM deallocated) stops it.

### How much it saves (my estimate, check it)

- Running: two `Standard_B2s_v2` VMs 24/7 are very roughly **US$60 to 75 a month** at list price. That alone
  empties a US$100 student credit in about six weeks.
- Hibernated: a 64 GB and a 32 GB disk, one static IP and the backup blobs are very roughly **US$12 to 15 a month**.
- Real numbers: Azure portal → _Cost Management + Billing_ → _Cost analysis_ (filter on the resource group), and
  _Credits_ for what is left and **the date the credit expires**. Check both now.

## 2. Hibernate (about 10 minutes)

**Do it when no contest is running and nobody is mid-interview.**

**Step 1. Stop GitHub from deploying and attacking a server that is off.**

```bash
gh variable set DEPLOY_ENABLED --body false
```

This switches off the deploy workflow and the nightly attack run (both check it). CI keeps working (it uses
GitHub's machines, not yours). If you skip this step, the next merge to `main` makes the deploy fail.

**Step 2. Take one last backup and make sure it worked.**

```bash
ssh -i ~/.ssh/codearena_deploy codearena@40.83.75.34 '/opt/codearena/backup.sh --label hibernate'
```

Expect the last lines to say the upload was verified and the command to exit with no error. Then:

```bash
ssh -i ~/.ssh/codearena_deploy codearena@40.83.75.34 'cat /opt/codearena/state/backup.prom | grep last_run_success'
```

It must print `codearena_backup_last_run_success 1`. If it prints `0`, do not hibernate yet: read
[backup-restore.md](backup-restore.md) (the usual cause is an expired backup token). Note the backup does **not**
include test data in object storage; that stays safe on the VM disk, which is why the disk is kept.

**Step 3. Deallocate both VMs (judge first, then the API).**

```bash
az vm deallocate -g rg-codearena-prod -n vm-codearena-prod-judge-0
az vm deallocate -g rg-codearena-prod -n vm-codearena-prod-api
```

Each takes one to two minutes.

**Step 4. Confirm they are really off.**

```bash
az vm list -d -g rg-codearena-prod --query "[].{name:name, power:powerState}" -o table
```

Both rows must say **VM deallocated**. Anything else (`VM stopped`, `VM running`) is still billing.

**Step 5. Next day, look at Cost analysis.** The daily cost should fall to the small hibernated figure. If it does
not, a VM or another resource is still running: list everything with
`az resource list -g rg-codearena-prod -o table`.

**What visitors see while it sleeps.** The website on Vercel still loads, but anything that needs the server
(sign-in, problems, contests) shows its error message, and `/status` reports the system as down. Nothing is lost and
nothing needs fixing. If you would rather not have a half-working site online, add a note to your README or the
profile that the demo is paused and takes ten minutes to wake.

## 3. Wake up for the showcase (plan 10 minutes; do it the day before, then again an hour before)

The order matters: the **API VM first**, because the judge reaches the queue on it.

**Step 1. Start the API VM and wait for it.**

```bash
az vm start -g rg-codearena-prod -n vm-codearena-prod-api
```

Takes about one to two minutes. The containers start by themselves (they are set to restart unless stopped), and
the API is ready a few seconds after its container starts. Then wait for the API to say it is ready:

```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' https://api.40-83-75-34.sslip.io/api/health/ready)" = 200 ]; do sleep 5; echo waiting; done; echo API ready
```

**Indicator: it prints "API ready".** If it takes more than five minutes, go to "If something does not come back".

**Step 2. Start the judge VM.**

```bash
az vm start -g rg-codearena-prod -n vm-codearena-prod-judge-0
```

The worker starts with the machine and reports to the queue by itself; in the failure drills a restarted judge
was reporting 26 seconds after the start command.

**Step 3. Check that the address did not change.** Azure keeps the public IP and the private addresses of
deallocated machines, but verify once:

```bash
az vm list-ip-addresses -g rg-codearena-prod -o table
```

Expect `40.83.75.34` public and `10.20.1.4` / `10.20.2.4` private. If any differs, stop and ask for help before
doing anything else (the Vercel settings, OAuth callbacks and judge configuration all use these).

**Step 4. Look at the whole system.** Open `https://<your web url>/status` (the public status page) or

```bash
curl -s https://api.40-83-75-34.sslip.io/api/status | head -c 600
```

**The systems are back when:** overall status is `ok`, the judges line says **1 judge reporting** (give it up to two
minutes after the judge VM starts), and the interview pad says **2 servers answering**. The ops console (Admin → a contest → Operations)
shows the same with more detail.

**Step 5. Prove a submission works.** Sign in, open any practice problem, and submit a correct solution in C++ and in
Python. Each should reach a verdict in a few seconds. This also warms the sandbox.

**Step 6. Turn the pipeline back on and check it.**

```bash
gh variable set DEPLOY_ENABLED --body true
gh workflow run deploy.yml
```

Watch it in the Actions tab; all jobs green means a deploy works again. (Skip the second command if you have
nothing new to deploy; the next merge will do it.)

**Step 7. The nightly backup catches up by itself.** The backup timer runs as soon as the VM is back if it missed
03:00. Check after a few minutes:

```bash
ssh -i ~/.ssh/codearena_deploy codearena@40.83.75.34 'cat /opt/codearena/state/backup.prom | grep last_run_success'
```

## 4. Before the showcase: things that expire

- **Azure credit and subscription.** Look at _Credits_ in the portal for the remaining amount **and the expiry
  date**. An Azure for Students subscription can be disabled when the credit ends or the year passes, and a disabled
  subscription cannot start VMs. Hibernating buys time, not forever; wake the system well before the date.
- **Backup token.** The backup access token expires on **7 April 2027** by default (`backup_sas_expiry`; check `infra/terraform/terraform.tfvars`). Renewal steps are in
  [backup-restore.md](backup-restore.md). A hibernated system does not need it, but a woken one will fail its nightly
  backup after that date.
- **Budget alerts.** Check in Cost Management that an alert goes to your e-mail (the Terraform default has an empty
  list, so alerts may not reach you).
- **OAuth apps.** Google and GitHub sign-in keep working while the VMs are off. If Google shows the app in testing
  mode, check that the consent screen has not expired.
- **Student verification.** Azure for Students asks you to re-verify student status once a year. Do it before the
  showcase, not during.

## 5. If something does not come back

| Symptom                                          | Check                                                                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API not ready after 5 minutes                    | `ssh -i ~/.ssh/codearena_deploy codearena@40.83.75.34 'cd /opt/codearena && docker compose --env-file prod.env ps'`: every service should be `running` or `healthy`. Logs: add `logs --tail 100 api`. |
| Containers exited                                | `docker compose --env-file prod.env up -d` in `/opt/codearena` starts them.                                                                                                 |
| Status shows no judge reporting                             | Wait two minutes, then `ssh -i ~/.ssh/codearena_deploy -J codearena@40.83.75.34 codearena@10.20.2.4 'sudo systemctl status codearena-worker'`; restart it with `sudo systemctl restart codearena-worker`. |
| Sign-in fails                                    | Check the status page first; sign-in needs the API. The OAuth settings did not change while the VMs slept.                                                                  |
| Deploy workflow skipped                          | `DEPLOY_ENABLED` is not `true`: `gh variable list`.                                                                                                                         |
| Admins page missing                              | `OWNER_EMAIL` line in `/opt/codearena/prod.env` (see [../../infra/prod/README.md](../../infra/prod/README.md), "Who is admin").                                              |

More on the servers: [deploy.md](deploy.md), [contest-day.md](contest-day.md), [failure-drills.md](failure-drills.md).

## 6. Do not do these

- **Do not** `terraform destroy` or delete the resource group to "save money": that deletes the database and the test
  data. The backups would survive, but rebuilding takes hours and needs a bootstrap again.
- **Do not** release or recreate the public IP: the address is baked into the web and OAuth setup.
- **Do not** leave the VMs "stopped" (not deallocated): they still bill.
- **Do not** run `scripts/scale-judges.sh` while hibernating; it assumes the system is up.
