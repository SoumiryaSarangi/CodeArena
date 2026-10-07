#!/usr/bin/env bash
# D-03: turn on nightly Postgres backups to Azure Blob. Run once from your machine after the first deploy
# (and again after renewing the upload token, see infra/terraform/README.md):
#
#   infra/prod/enable-backups.sh              set up, then take a first backup and restore it as a test
#   infra/prod/enable-backups.sh --no-first-run
#
# It reads the storage account, container and upload token (a SAS limited to the backups container, no delete)
# from your local Terraform state and writes them to /opt/codearena/backup.env on the API VM (mode 600). The
# token goes over SSH on stdin: it is never printed and never on a command line. Then it installs the nightly
# backup timer (03:00 IST) and the weekly restore-test timer, and runs both once so you see them work.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tf="${TF_DIR:-$repo/infra/terraform}"
host="${API_HOST:-40.83.75.34}" user=codearena key="${DEPLOY_KEY:-$HOME/.ssh/codearena_deploy}"
first_run=1
[ "${1:-}" = "--no-first-run" ] && first_run=0

die() { echo "enable-backups: $*" >&2; exit 1; }
command -v terraform >/dev/null || die "terraform is not installed here"
[ -f "$key" ] || die "deploy key $key not found (run infra/prod/bootstrap.sh first)"
ssh_api() { ssh -i "$key" -o BatchMode=yes "$user@$host" "$@"; }

echo "== 1/4 backup settings from Terraform (the token is not shown)"
acct="$(terraform -chdir="$tf" output -raw backup_storage_account)" || die "terraform output failed (is infra/terraform applied on this machine?)"
cont="$(terraform -chdir="$tf" output -raw backup_container)" || die "terraform output failed"
sas="$(terraform -chdir="$tf" output -raw backup_container_sas)" || die "terraform output failed"
sas="${sas#\?}"
[[ "$acct" =~ ^[a-z0-9]{3,24}$ ]] || die "unexpected storage account name"
[[ "$cont" =~ ^[a-z0-9-]+$ ]] || die "unexpected container name"
[[ "$sas" =~ ^[A-Za-z0-9%\&=:._~+/-]+$ ]] || die "the upload token has unexpected characters"
printf 'BACKUP_URL=https://%s.blob.core.windows.net/%s\nBACKUP_SAS=%s\n' "$acct" "$cont" "$sas" \
  | ssh_api 'umask 077; cat > /opt/codearena/backup.env.new && mv /opt/codearena/backup.env.new /opt/codearena/backup.env'
unset sas

echo "== 2/4 scripts and timer files"
tar -cz --transform 's,^scripts/,,' -C "$here" backup.sh systemd -C "$repo" scripts/restore-test.sh \
  | ssh_api 'tar -xz -C /opt/codearena && chmod +x /opt/codearena/backup.sh /opt/codearena/restore-test.sh'

echo "== 3/4 timers"
ssh_api 'sudo install -m 644 /opt/codearena/systemd/codearena-backup.service /opt/codearena/systemd/codearena-backup.timer /opt/codearena/systemd/codearena-restore-test.service /opt/codearena/systemd/codearena-restore-test.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now codearena-backup.timer codearena-restore-test.timer && systemctl list-timers "codearena-*" --no-pager'

if [ "$first_run" = 1 ]; then
  echo "== 4/4 first backup, then restore it into a throwaway database"
  ssh_api 'cd /opt/codearena && ./backup.sh --label first && METRIC_FILE=/opt/codearena/state/restore-test.prom ./restore-test.sh --latest'
else
  echo "== 4/4 skipped (--no-first-run)"
fi
echo "Backups are on. Manual backup any time (e.g. before a contest): ssh codearena@$host '/opt/codearena/backup.sh --label pre-contest'"
