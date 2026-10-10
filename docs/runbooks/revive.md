# Tear down CodeArena on Azure, and bring it back later

For the owner, working alone. Written so that you can do everything yourself with this page open and nothing
else: no Claude, no memory of how it was built. Copy each command exactly. Wherever a command needs a value only you
know, it is written in CAPITALS and explained right above it.

**The idea.** The Azure credit is nearly gone, and a switched-off system still costs money (disks, address,
storage). So the Azure resources are **deleted**, which costs nothing. Everything needed to rebuild is first saved into
**one encrypted file** on your laptop. The website on Vercel, the code on GitHub, and your sign-in apps cost nothing
and stay where they are.

| Part | When      | What                                                   | Time                      |
| ---- | --------- | ------------------------------------------------------ | ------------------------- |
| 1    | **Now**   | Save everything, check the copy, then delete Azure     | about 1 hour              |
| 2    | **Later** | Rebuild everything and restore the data                | about 2 to 3 hours        |
| 3    | If needed | Things that can go wrong, and the fix                  |                           |
| 4    | If needed | Starting again without the archive                     |                           |

> This page is in the repository, which is public. It contains no secrets: the secrets live only in the encrypted
> archive, and the passphrase lives only in your password manager.

---

## What survives the teardown, and what does not

| Survives (free, untouched)                                                              | Deleted from Azure (saved in the archive first)                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The code and CI on GitHub, and the built images (ghcr.io)                               | The API server and its disk                                      |
| The website on Vercel (it will show errors until the server is back) and the AI relay   | The judge server                                                 |
| The Google and GitHub sign-in apps (they use the website address, not the server's)     | The database (saved as `postgres.dump`)                          |
| Your Groq and Gemini accounts, Grafana Cloud, UptimeRobot                               | The test data and hidden tests (saved as `s3data.tgz`)           |
| Your contest problems on this laptop (`problems-private/`, also copied into the archive)| The server's secret files (saved as `prod.env`, `judge-worker.env`) |
|                                                                                         | The public address `40.83.75.34`: **a new one is assigned later** |
|                                                                                         | Redis (queues, caches, live boards): nothing durable; boards are rebuilt from the database |

Because the address changes, the sslip.io name (`api.40-83-75-34.sslip.io`) changes too. Part 2 updates the three
places that contain it (the server's settings, Vercel, GitHub).

---

# Part 1. Now: save, check, delete

Open **WSL** (the Ubuntu terminal). All commands run in the repository:

```bash
cd ~/code/codearena
git status --short        # fine if it only lists AGENTS.md / .env.example files
```

### 1.1 Make sure the servers are running

The export copies data from the live server. If you hibernated it earlier, start it first:

```bash
az login
az vm start -g rg-codearena-prod -n vm-codearena-prod-api
az vm start -g rg-codearena-prod -n vm-codearena-prod-judge-0
```

Wait about 3 minutes, then check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.40-83-75-34.sslip.io/api/health/ready
```

It must print `200`. (If the site has been running all along, skip this step.)

### 1.2 Stop GitHub from deploying to servers that will not exist

```bash
gh variable set DEPLOY_ENABLED --body false
```

### 1.3 Optional but useful: install the Postgres tools

This lets the check in 1.5 also read the database dump on your laptop (the server already checked it).

```bash
sudo apt update && sudo apt install -y postgresql-client
```

### 1.4 Make the archive

```bash
scripts/teardown-export.sh export
```

- It asks you to type `yes`: it **stops the API and the pad servers for a few minutes** so nothing changes while the
  data is copied, and starts them again at the end. Nothing in Azure is deleted by it.
- It copies the database, the test data, the two secret files, `terraform.tfvars` and `problems-private/`, and
  prints the row counts it found (users, problems, contests, submissions, rooms).
- At the end it asks for a **passphrase, twice** (typing is hidden). Choose a long one and **save it in your password
  manager right now.** Without it the archive cannot be opened, and nobody can recover it.
- Result: `~/codearena-archive/codearena-archive-YYYYMMDD-HHMM.tar.gz.enc`. Expect a few hundred megabytes at most.

If it stops with an error, read the message; the API is restarted automatically even then. Fix and run again.

### 1.5 Check the archive

```bash
scripts/teardown-export.sh verify ~/codearena-archive/codearena-archive-YYYYMMDD-HHMM.tar.gz.enc
```

(Use the real file name; press Tab to complete it.) Type the passphrase. It must end with **ARCHIVE IS GOOD** and
every line must say `ok` (lines that say `note` are fine). If it says anything else, run 1.4 again. **Do not go on
until you see ARCHIVE IS GOOD.**

### 1.6 Copy the archive to two other places

Copy the one `.enc` file somewhere that survives your laptop dying: a USB stick, and a cloud drive (Google Drive is
fine: the file is encrypted). Then **compare**: the export printed a `sha256` line; run

```bash
sha256sum PATH-TO-THE-COPY
```

on each copy and check it matches. Also copy your **contest problems folder** `problems-private/` to a safe place on
its own (it is only on this laptop and is not in git; it is also inside the archive, but a second copy is cheap).

Also put these in your password manager, because the rebuild needs them:

- the archive **passphrase**;
- your **Azure** login (the account the credit belongs to) and the **subscription id**
  (`az account show --query id -o tsv`);
- the **Vercel** project name and the web address: `https://code-arena-eta-mauve.vercel.app`;
- your **GitHub** login, and the repository: `https://github.com/SoumiryaSarangi/CodeArena`.

### 1.7 Last look before deleting

Tick every line:

- [ ] `verify` said ARCHIVE IS GOOD.
- [ ] The archive exists in **two** other places and the checksums match.
- [ ] The passphrase is in your password manager and you tested it by running `verify` with it.
- [ ] `problems-private/` is copied somewhere safe.
- [ ] You looked at the **Credits** page in the Azure portal and know the date it expires.
- [ ] You are certain you do not need anything else from the server: this step cannot be undone.

### 1.8 Delete the Azure resources

```bash
cd ~/code/codearena/infra/terraform
terraform plan -destroy
```

Read it. It should say about **31 to destroy**. Then:

```bash
terraform destroy
```

Type `yes`. It takes about 5 to 10 minutes. Then check that nothing is left:

```bash
az group exists -n rg-codearena-prod        # must print: false
az resource list -o table                   # should list nothing (or only free items you did not create)
```

Move the old Terraform state aside so a later rebuild starts clean:

```bash
mkdir -p ~/codearena-tf-old && mv terraform.tfstate terraform.tfstate.backup ~/codearena-tf-old/ 2>/dev/null; ls
```

The next day, open **Cost analysis** in the Azure portal: the daily cost should be zero.

**What visitors see now:** the website on Vercel loads, but anything that needs the server shows an error. That is
expected. If you want to avoid a half-working demo link in your resume, leave it out until Part 2 is done.

Part 1 is finished. Nothing costs money any more.

---

# Part 2. Later: rebuild and restore (about 2 to 3 hours; do it 2 days before the showcase)

Everything is done from **WSL**. Keep the terminal open between steps; if you close it, run the "session variables"
block again (step 2.10 tells you which values to fill).

**Running cost once it is back:** about US$2 per day (my estimate; two small VMs). Delete it again with Part 1.8 after
the showcase. The rebuild is repeatable.

### 2.1 Tools

Check each one; install what is missing.

```bash
az version | head -3          # Azure CLI.      Install: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
terraform version             # Terraform 1.7 or newer.  Install: https://developer.hashicorp.com/terraform/install (Linux, apt)
gh --version                  # GitHub CLI.     Install: https://cli.github.com (Linux)
git --version; openssl version; ssh -V
```

Log in to the two services:

```bash
az login                      # a browser opens; use the Azure for Students account
gh auth login                 # choose GitHub.com, HTTPS, and log in with the browser
```

### 2.2 The code

```bash
# only if the folder is missing:
git clone https://github.com/SoumiryaSarangi/CodeArena.git ~/code/codearena
cd ~/code/codearena && git checkout main && git pull
```

### 2.3 Is the Azure subscription still alive?

```bash
az account show --query "{name:name, id:id, state:state}" -o table
```

`state` must say `Enabled`. If it says `Disabled` or `Warned`, or `az login` shows no subscription, go to Part 3,
"The subscription is disabled". Also open the Azure portal → **Credits** and check there is credit left and the expiry
date has not passed. A rebuild for one showcase week needs roughly US$15 to 20.

### 2.4 Which region and VM sizes does your subscription allow now?

Azure for Students changes its rules from time to time. Check:

```bash
az vm list-skus --location eastasia --resource-type virtualMachines --query "[?length(restrictions)==\`0\` && contains(['Standard_B2s_v2'], name)].name" -o tsv
for ns in Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.Consumption Microsoft.Authorization; do az provider register --namespace $ns; done
```

The first command must print `Standard_B2s_v2`. If it prints nothing, go to Part 3, "The size or region is not
available".

### 2.5 Unpack the archive

Copy the `.enc` file back to this laptop if needed, then:

```bash
cd ~/code/codearena
scripts/teardown-export.sh extract ~/codearena-archive/codearena-archive-YYYYMMDD-HHMM.tar.gz.enc ~/codearena-restore
```

Type the passphrase. It must end with **ARCHIVE IS GOOD**. The folder `~/codearena-restore` now holds the secrets in
plain text: delete it at the end of Part 2 (`rm -r ~/codearena-restore`).

### 2.6 Terraform settings

```bash
cp ~/codearena-restore/terraform.tfvars ~/code/codearena/infra/terraform/terraform.tfvars
grep -n "ssh_public_key\|backup_sas\|budget" ~/code/codearena/infra/terraform/terraform.tfvars
```

Two things to check in that file:

1. **`ssh_public_key`** must be the public half of a key you still have in `~/.ssh/`. Check: `ls ~/.ssh/*.pub` and
   `cat` the one that matches. If you no longer have the matching private key, make a new one
   (`ssh-keygen -t ed25519`; press Enter at the questions to accept the defaults) and put the contents of
   `~/.ssh/id_ed25519.pub` into `ssh_public_key = "..."` in that file.
2. **`backup_sas_expiry`** (the backup upload token's end date; the default is `2027-04-07T00:00:00Z`). If that date
   is already past, change it, and `backup_sas_start`, to dates from today to six months ahead, in the same format.
   Also `budget_start_date` / `budget_end_date` if they are in the past (or add `create_budget = false` on its own
   line to skip the budget).

### 2.7 Create the servers

```bash
cd ~/code/codearena/infra/terraform
terraform init
terraform plan -var judge_bootstrap=true
```

Read the plan: about **31 to add**, nothing to change or destroy. The `-var judge_bootstrap=true` is required: the
judge needs a temporary internet connection to install its sandbox (the repository's `judges.auto.tfvars` says
`false`, which is for a judge that is already set up; the command-line value wins).

```bash
terraform apply -var judge_bootstrap=true
```

Type `yes`. About 5 to 10 minutes. Then write down the addresses:

```bash
terraform output
NEWIP=$(terraform output -raw api_public_ip);       echo "API public IP: $NEWIP"
PRIV=$(terraform output -raw api_private_ip);       echo "API private IP: $PRIV"
JUDGE=$(terraform output -json judge_private_ips | tr -d '[]" ');   echo "Judge private IP: $JUDGE"
echo "API host: api.${NEWIP//./-}.sslip.io"
```

**Keep this terminal open**, or write those four values down: you need them in the next steps.

### 2.8 Wait for the servers to finish installing themselves

The first time you connect, SSH asks "Are you sure you want to continue connecting?": type `yes`.

```bash
ssh codearena@$NEWIP 'cloud-init status --wait'
ssh -J codearena@$NEWIP codearena@$JUDGE 'cloud-init status --wait'
```

Each must end with `status: done`. This takes 3 to 8 minutes; the command waits for you. If it says `status: error`,
go to Part 3, "A server did not finish installing".

### 2.9 Lock the judge's internet connection again

```bash
cd ~/code/codearena/infra/terraform
./lock-judges.sh
```

Type `yes` when asked. Then check:

```bash
ssh -J codearena@$NEWIP codearena@$JUDGE 'curl -m 5 -sI https://example.com >/dev/null 2>&1 && echo "INTERNET OPEN (bad)" || echo "no internet (good)"'
```

It must print `no internet (good)`.

### 2.10 Session variables (run this block again whenever you open a new terminal)

Fill in the three values from step 2.7.

```bash
export NEWIP=FILL-IN-THE-API-PUBLIC-IP
export PRIV=FILL-IN-THE-API-PRIVATE-IP          # normally 10.20.1.4
export JUDGE=FILL-IN-THE-JUDGE-PRIVATE-IP       # normally 10.20.2.4
export API_HOST=$NEWIP                          # the repository's scripts read this; without it they use the OLD address
export KEY=$HOME/.ssh/codearena_deploy
export WEB=https://code-arena-eta-mauve.vercel.app
export NEWHOST=api.${NEWIP//./-}.sslip.io
cd ~/code/codearena
```

### 2.11 Prepare the servers for the deploy pipeline

```bash
infra/prod/bootstrap.sh --api-ip $NEWIP --api-private-ip $PRIV --judges "$JUDGE" --web-url $WEB --set-github
```

It creates (or reuses) the pipeline's SSH key `~/.ssh/codearena_deploy`, authorises it on both servers, uploads the
files, generates **temporary** secrets on the server, and stores the new address and host keys in GitHub
(`DEPLOY_SSH_KEY`, `API_HOST`, `API_HOST_KEY`, `JUDGE_HOSTS`, `JUDGE_HOST_KEYS`). It ends with a line telling you to
set `DEPLOY_ENABLED`: **not yet**.

### 2.12 Put the real secrets back

The archive has the original `prod.env` and `judge-worker.env` (the passwords, sign-in keys, Google/GitHub sign-in
values, AI keys, Grafana values, relay secret). Replace the temporary ones and fix the address inside:

```bash
OLDIP=40.83.75.34
OLDPRIV=10.20.1.4
scp -i $KEY ~/codearena-restore/prod.env ~/codearena-restore/judge-worker.env codearena@$NEWIP:/opt/codearena/
ssh -i $KEY codearena@$NEWIP "cd /opt/codearena && chmod 600 prod.env judge-worker.env \
  && sed -i -e 's/${OLDIP//./\\.}/$NEWIP/g' -e 's/${OLDIP//./-}/${NEWIP//./-}/g' -e 's/${OLDPRIV//./\\.}/$PRIV/g' prod.env judge-worker.env \
  && grep -E '^(API_HOST|API_PRIVATE_IP|WEB_URL|WEB_ORIGIN|PUBLIC_API_URL|COLLAB_URL)=' prod.env"
```

The last line prints a few non-secret settings. Check that `API_HOST` is your new host (`api.…sslip.io` with the new
numbers), `API_PRIVATE_IP` is the new private IP, and `WEB_URL` is the Vercel address. Nothing there should still show
`40-83-75-34`. (Every secret in the file stays as it was, so the Google/GitHub sign-in settings, the AI keys and the
relay secret need no re-typing.)

Check the owner setting is there (it prints the line, which is an e-mail address, not a secret):

```bash
ssh -i $KEY codearena@$NEWIP "grep '^OWNER_EMAIL=' /opt/codearena/prod.env || echo 'OWNER_EMAIL is not set'"
```

If it says "not set", add it now:

```bash
ssh -i $KEY codearena@$NEWIP "echo 'OWNER_EMAIL=soumiryasarangi@gmail.com' >> /opt/codearena/prod.env"
```

### 2.13 Tell Vercel the new server address

The website's settings contain the old server address and must change. Print the three values to paste:

```bash
echo "API_PROXY_URL              = https://$NEWHOST"
echo "NEXT_PUBLIC_REALTIME_URL   = https://$NEWHOST"
echo "NEXT_PUBLIC_COLLAB_URL     = wss://$NEWHOST/collab"
```

Then in the browser: **vercel.com** → your CodeArena project → **Settings** → **Environment Variables**. For each of the
three names above, click the three dots → **Edit** → paste the new value → **Save** (keep "Production" ticked). Do not
change any other variable. Then **Deployments** → the newest one → three dots → **Redeploy** (untick "Use existing Build
Cache"). Wait until it says **Ready** (about 2 minutes). The addresses are baked in when the site is built, so the
redeploy is not optional.

### 2.14 Deploy

```bash
gh variable set DEPLOY_ENABLED --body true
gh workflow run deploy.yml
gh run watch
```

`gh run watch` may ask you to choose the run: pick the newest `deploy`. It takes about 10 to 15 minutes. **All jobs must
end green**: building the images, `deploy-api`, `deploy-judges`, `deploy-collab`, `deploy-plag`. (`COLLAB_ENABLED` and
`PLAG_ENABLED` are already `true` in GitHub; check with `gh variable list`.) This creates the empty database structure
and starts every service, with the judge worker installed through the API server.

Then check the server answers (the first certificate can take a minute; repeat the command if it fails):

```bash
curl -s https://$NEWHOST/api/health/ready
```

You should see `"status":"ok"`.

### 2.15 Restore the data

The system is running but **empty**. Put your data back.

**a) Upload the two data files to the server:**

```bash
scp -i $KEY ~/codearena-restore/postgres.dump ~/codearena-restore/s3data.tgz codearena@$NEWIP:/tmp/
```

**b) Log in to the server and restore.** Copy the whole block below and paste it in one go once you are logged in:

```bash
ssh -i $KEY codearena@$NEWIP
```

On the server (the prompt changes to `codearena@vm-codearena-prod-api`):

```bash
cd /opt/codearena
export API_IMAGE=$(cat state/current)
DC="docker compose --env-file prod.env -f docker-compose.yml"

# stop everything that writes
$DC stop api collab1 collab2

# 1. the database
PG=$($DC ps -q postgres)
docker exec "$PG" psql -U codearena -d postgres -c 'drop database codearena with (force)' -c 'create database codearena'
docker exec -i "$PG" pg_restore -U codearena -d codearena --no-owner --exit-on-error < /tmp/postgres.dump && echo DATABASE RESTORED

# 2. the test data and hidden tests
$DC stop s3
docker run --rm -v codearena_s3data:/data -v /tmp:/in alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /in/s3data.tgz -C /data' && echo TEST DATA RESTORED
$DC start s3
sleep 15

# start the services again
$DC start api collab1 collab2
rm -f /tmp/postgres.dump /tmp/s3data.tgz
exit
```

You must see `DATABASE RESTORED` and `TEST DATA RESTORED`. If `pg_restore` printed an error, go to Part 3, "The
database restore failed".

**c) Prove the numbers match** (back on your laptop):

```bash
diff <(ssh -i $KEY codearena@$NEWIP "cd /opt/codearena && API_IMAGE=\$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml ps -q postgres | head -1 | xargs -I{} docker exec {} psql -U codearena -d codearena -tA -F' ' -c \"select 'users', count(*) from users union all select 'problems', count(*) from problems union all select 'problem_versions', count(*) from problem_versions union all select 'contests', count(*) from contests union all select 'participants', count(*) from participants union all select 'submissions', count(*) from submissions union all select 'rooms', count(*) from rooms\"") ~/codearena-restore/counts.txt && echo SAME AS BEFORE
```

It must print `SAME AS BEFORE`. (If the lines differ by a little because the live site kept getting new rows
between the export and the teardown, that is not possible here: the API was stopped during the export.)

### 2.16 Backups on again

```bash
infra/prod/enable-backups.sh
```

It writes a new backup token on the server, installs the nightly timer, and takes a first backup and proves it can be
restored. It must end without an error.

### 2.17 Rebuild the contest boards

Redis started empty, so the live scoreboards are gone and are rebuilt from the database. In the website: sign in as the
owner → **Admin** → **Contests** → open each contest → **Operations** → **Rebuild board**. Then open the contest's
board and check it shows the results you expect.

### 2.18 Small things

- **UptimeRobot** (if you set it up): edit its monitors to use `https://NEWHOST/api/health/live` and
  `/api/health/ready` (print it with `echo $NEWHOST`).
- **Grafana Cloud:** nothing to do; the connection settings were restored. Dashboards are still there.
- **Google and GitHub sign-in apps:** nothing to do (they use the website address).
- Delete the plain secrets: `rm -r ~/codearena-restore`.

### 2.19 The systems are back when all of these are true

| Check                                                   | How                                                                                           | Expected                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| API ready                                               | `curl -s https://$NEWHOST/api/health/ready`                                                   | `"status":"ok"`                                  |
| Public status page                                      | open `$WEB/status`                                                                            | overall ok, **1 judge reporting**, pad **2 servers answering** |
| Website talks to the new server                         | open `$WEB` and `$WEB/practice`                                                               | problems are listed (20 public ones)             |
| Sign-in works                                           | sign in with Google                                                                           | you land signed in; **Admin** is in the menu      |
| The data is back                                        | step 2.15 c                                                                                   | `SAME AS BEFORE`                                 |
| Judging works, and the test data is back                | submit a correct C++ and a correct Python solution to a practice problem                      | AC in a few seconds                              |
| Hidden tests are back                                   | Admin → Problems → open a contest problem → **Validate**                                       | passes                                           |
| Interview pad works                                     | create a room, open it in two windows, type                                                    | both see the text                                |
| Backups work                                            | `ssh -i $KEY codearena@$NEWIP 'cat /opt/codearena/state/backup.prom'`                          | `codearena_backup_last_run_success 1`            |
| Deploys work                                            | `gh run list --workflow deploy.yml --limit 1`                                                  | `completed success`                              |

### Time you can expect

| Step                          | Roughly         |
| ----------------------------- | --------------- |
| 2.1 to 2.6 (tools, settings)  | 20 to 30 min    |
| 2.7 `terraform apply`         | 5 to 10 min     |
| 2.8 servers install themselves| 3 to 8 min      |
| 2.9 to 2.12                   | 15 min          |
| 2.13 Vercel                   | 10 min          |
| 2.14 deploy                   | 10 to 15 min    |
| 2.15 to 2.19 restore, checks  | 30 min          |

These are estimates, not measurements of a full rebuild (it has not been run end to end). Plan three hours and do
the whole thing two days before the showcase, so there is time to fix anything.

---

# Part 3. Things that can go wrong

| Problem | What to do |
| ------- | ---------- |
| **The subscription is disabled / expired / no credit** | The Azure for Students credit lasts 12 months and the subscription needs yearly student re-verification. In the Azure portal → _Subscriptions_ see the reason and follow the prompt to re-verify. If the credit is gone, create a **new** free account or use another Azure subscription and set its id in `terraform.tfvars` (`subscription_id`), then repeat 2.3. A pay-as-you-go subscription works too: about US$2 a day. |
| **The size or region is not available** (`SkuNotAvailable`, "not allowed in this region") | List what your subscription allows: `az policy assignment list --query "[].{name:displayName, regions:parameters.listOfAllowedLocations.value}" -o json`, then set `location = "..."` and, if needed, `api_vm_size` / `judge_vm_size` in `terraform.tfvars` (see `infra/terraform/README.md`, step 2). Rerun 2.4 and 2.7. |
| **`terraform apply` stops half way** | Fix the cause shown in the message, then run the same `terraform apply -var judge_bootstrap=true` again; Terraform continues where it stopped. Do not run `destroy` to "start over" unless told. |
| **A server did not finish installing** (`cloud-init status: error`) | Log in and read the log: `ssh codearena@$NEWIP 'sudo tail -50 /var/log/cloud-init-output.log'` (judge: add `-J codearena@$NEWIP` and use `$JUDGE`). A common cause is a temporary network failure: delete just that server and recreate it: `terraform apply -replace=azurerm_linux_virtual_machine.api -var judge_bootstrap=true` (use `...judge[0]` for the judge). |
| **`bootstrap.sh` says it cannot connect** | The server may still be starting; wait 2 minutes and rerun it (it is safe to rerun). If SSH complains the host key changed: `ssh-keygen -R $NEWIP` and rerun. |
| **Deploy job fails at "host key"** | `gh variable list` must show the new `API_HOST` and `JUDGE_HOSTS`; if not, rerun 2.11. |
| **Deploy job `deploy-judges` fails** | The judge could not be reached through the API server: check step 2.9 printed "no internet (good)" and `ssh -J codearena@$NEWIP codearena@$JUDGE true` works, then `gh workflow run deploy.yml` again. |
| **`/api/health/ready` never says ok** | `ssh -i $KEY codearena@$NEWIP 'cd /opt/codearena && docker compose --env-file prod.env ps'` then add `logs --tail 80 api` (after `API_IMAGE=$(cat state/current)` exported). Most common: a missing value in `prod.env` (compare step 2.12) or Postgres still starting (wait). |
| **No certificate / the browser shows a security warning on `$NEWHOST`** | Caddy asks Let's Encrypt for it and needs ports 80 and 443 open (Terraform opens them). Wait 2 minutes. Logs: `docker compose --env-file prod.env logs --tail 50 caddy` on the server. |
| **The website loads but shows errors** | Vercel still has the old address (redo 2.13 and **Redeploy**), or the API is not ready yet. |
| **Sign-in fails** | Check `$WEB/status` first. The sign-in apps use the website address and need no change. If the Google/GitHub values are wrong, re-enter them: `infra/prod/set-oauth.sh all` (needs `API_HOST` exported, step 2.10). |
| **The database restore failed** | Do not panic: the server still has an empty database and the archive is intact. Read the error. If it mentions "already exists", rerun the `drop database ... create database` line, then the `pg_restore` line. If it mentions a version problem, tell whoever helps you the first lines of the error. You can retry any number of times. |
| **Counts differ in 2.15 c** | Rerun the restore (2.15 b) once. If they still differ, the archive was made from a different moment: check the date in the file name. |
| **Lost the passphrase** | The archive cannot be opened. Go to Part 4. |
| **Lost the archive file and its copies** | Go to Part 4. |

---

# Part 4. Starting again without the archive

You lose the old users, submissions and contests, but the **code, the 20 public problems and your contest problems**
(from `problems-private/` or its copy) can be set up again.

1. Do Part 2 steps 2.1 to 2.11 (they do not need the archive, except `terraform.tfvars`: copy
   `infra/terraform/terraform.tfvars.example` to `terraform.tfvars` and fill in `subscription_id`
   (`az account show --query id -o tsv`) and `ssh_public_key`).
2. Skip 2.12. The server now has temporary secrets and the sign-in is not configured. Enter the values again, one at a
   time at hidden prompts:
   ```bash
   infra/prod/set-oauth.sh all      # Google and GitHub client IDs and secrets (create new secrets in their consoles)
   infra/prod/set-ai.sh all         # Groq and Gemini keys (create new keys in their consoles)
   infra/prod/set-ai-relay.sh       # creates the relay secret; follow what it prints (it must be set in Vercel too)
   infra/prod/set-grafana.sh        # optional: Grafana Cloud values
   ```
   And set the owner: `ssh -i $KEY codearena@$NEWIP "cd /opt/codearena && echo 'OWNER_EMAIL=soumiryasarangi@gmail.com' >> prod.env && docker compose --env-file prod.env up -d api"`
3. Do 2.13 (Vercel) and 2.14 (deploy).
4. Skip 2.15. Instead, sign in (you become the owner), then **Admin → Problems** and upload each problem folder from
   `problems/` (20 folders) and `problems-private/` (the contest problems): choose the folder, then **Validate**, then
   publish. Create the contests again.
5. Do 2.16 (backups) and the checks in 2.19 that apply.

---

## Quick reference

| What | Value |
| ---- | ----- |
| Resource group | `rg-codearena-prod` |
| VM names | `vm-codearena-prod-api`, `vm-codearena-prod-judge-0` |
| Region and size | `eastasia`, `Standard_B2s_v2` |
| Old public IP (before the teardown) | `40.83.75.34` (old host `api.40-83-75-34.sslip.io`) |
| Private IPs | API `10.20.1.4`, judge `10.20.2.4` |
| Web address | `https://code-arena-eta-mauve.vercel.app` |
| Pipeline SSH key | `~/.ssh/codearena_deploy` |
| Server folder | `/opt/codearena` |
| Docker volumes | `codearena_pgdata` (database), `codearena_s3data` (test data) |
| GitHub variables the pipeline needs | `DEPLOY_ENABLED`, `API_HOST`, `API_HOST_KEY`, `JUDGE_HOSTS`, `JUDGE_HOST_KEYS`, `COLLAB_ENABLED`, `PLAG_ENABLED`; secret `DEPLOY_SSH_KEY` |
| Vercel variables that contain the server address | `API_PROXY_URL`, `NEXT_PUBLIC_REALTIME_URL`, `NEXT_PUBLIC_COLLAB_URL` |

More detail on each piece: [infra/terraform/README.md](../../infra/terraform/README.md),
[infra/prod/README.md](../../infra/prod/README.md), [backup-restore.md](backup-restore.md),
[contest-day.md](contest-day.md), [deploy.md](deploy.md).
