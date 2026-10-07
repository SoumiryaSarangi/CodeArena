# Backups and restore (D-03)

Scope: **Postgres only** (users, problems metadata, submissions, contests, ratings). Redis holds queues and
caches that rebuild themselves (the reconciler requeues stuck submissions). Test packages and hidden tests live
in the object store (SeaweedFS volume on the API VM) and are **not** in this backup; their source of truth is
the problem packages (`problems/`, and `problems-private/` on the owner's machine), which can be re-imported.

Targets (NFR-REL-04): RPO 24 h (take a manual backup before and after every contest), RTO 1 h.

## Every day

Nothing. `codearena-backup.timer` runs at 03:00 IST; `codearena-restore-test.timer` proves a restore works every
Sunday. Check: `systemctl list-timers 'codearena-*'`, `journalctl -u codearena-backup -n 30`,
`cat /opt/codearena/state/backup.prom` (`codearena_backup_last_run_success 1` and a recent
`..._last_success_timestamp_seconds`), and `cat /opt/codearena/state/restore-test.prom`.

## Manual backup (before and after each contest)

`ssh codearena@<api> '/opt/codearena/backup.sh --label pre-c1'`

## Restore for real (the database is lost or corrupt)

1. If the database still answers, take one more backup first: `./backup.sh --label before-restore`.
2. Pick the dump: list `pg/` in the container (`restore-test.sh` shows the newest name when it runs), then download it
   to `/tmp/restore.dump` on the VM with the token from `/opt/codearena/backup.env` (read it with `sed`, never print it):
   `curl -fsS -o /tmp/restore.dump "<BACKUP_URL>/<blob name>?<BACKUP_SAS>"`.
3. Prove it first: `/opt/codearena/restore-test.sh --file /tmp/restore.dump` must print PASS.
4. Stop the API so nothing writes: `cd /opt/codearena && API_IMAGE=$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml stop api`.
5. Replace the database:
   ```bash
   PG=$(API_IMAGE=$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml ps -q postgres)
   docker exec "$PG" psql -U codearena -d postgres -c 'drop database codearena with (force)' -c 'create database codearena'
   docker exec -i "$PG" pg_restore -U codearena -d codearena --no-owner --exit-on-error < /tmp/restore.dump
   ```
6. Start the API again: re-run the deploy workflow (`gh workflow run deploy.yml`) or
   `API_IMAGE=$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml up -d api`,
   then `curl https://<web>/api/health/ready`. Delete `/tmp/restore.dump`.

## Upload token expiry

The token in `backup.env` expires on `backup_sas_expiry` (Terraform). Before then: change the date in
`infra/terraform/terraform.tfvars`, `terraform apply`, then `infra/prod/enable-backups.sh --no-first-run`.
An expired token shows up as `codearena_backup_last_run_success 0` and a failed `codearena-backup.service`.
