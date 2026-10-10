#!/usr/bin/env bash
# Saves everything needed to rebuild CodeArena later into ONE encrypted file on your laptop, before the Azure
# resources are deleted. Run from the repository in WSL. Nothing is deleted by this script.
#
#   scripts/teardown-export.sh export            make the archive (stops the API for a few minutes)
#   scripts/teardown-export.sh verify FILE.enc   decrypt, check the contents are complete and readable
#   scripts/teardown-export.sh extract FILE.enc DIR   decrypt into DIR (used by docs/runbooks/revive.md)
#
#   options for export:  --host IP     API server address (default: the GitHub variable API_HOST)
#                        --out DIR     where the archive goes (default: ~/codearena-archive)
#                        --yes         do not ask before stopping the API
#
# What is in the archive: a Postgres dump (all users, submissions, contests, ratings), the object-store volume
# (test data and hidden tests), the server's two secret files (prod.env, judge-worker.env), terraform.tfvars,
# problems-private/ (your contest problems, which are not in git), the relay secret file if you have one, and a
# manifest with row counts so a restore can be checked. The file is encrypted with a passphrase you type
# (AES-256). WITHOUT THE PASSPHRASE THE FILE IS USELESS: put it in a password manager.
#
# Secrets are copied as files and never printed. The API is restarted at the end, success or failure.
set -euo pipefail

KEY="${DEPLOY_KEY:-$HOME/.ssh/codearena_deploy}"
USER_NAME=codearena
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/codearena
RT="${TEARDOWN_REMOTE_TMP:-/tmp}" # where the server keeps its temporary copies (only a test changes it)
COMPOSE="cd $APP && API_IMAGE=\$(cat state/current) docker compose --env-file prod.env -f docker-compose.yml"

die() { echo "error: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

# ---------------------------------------------------------------------------------------------------------------
# Encryption helpers (openssl asks for the passphrase itself, hidden)
# ---------------------------------------------------------------------------------------------------------------
# TEARDOWN_PASSFILE exists only so the offline test can run without a keyboard.
passopt=(); [ -n "${TEARDOWN_PASSFILE:-}" ] && passopt=(-pass "file:$TEARDOWN_PASSFILE")
encrypt() { # $1 plain tar.gz, $2 output
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt "${passopt[@]}" -in "$1" -out "$2"
}
decrypt() { # $1 encrypted, $2 output
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 "${passopt[@]}" -in "$1" -out "$2" 2>/dev/null \
    || die "could not decrypt: wrong passphrase, or the file is damaged"
}

# Files that must be in a good archive. The pg dump and the object store are checked for being readable.
REQUIRED=(manifest.txt counts.txt postgres.dump s3data.tgz prod.env judge-worker.env)

check_dir() { # $1 = a directory holding the unpacked archive
  local d="$1" f ok=1
  for f in "${REQUIRED[@]}"; do
    if [ -s "$d/$f" ]; then say "  ok       $f ($(du -h "$d/$f" | cut -f1))"; else say "  MISSING  $f"; ok=0; fi
  done
  [ -d "$d/problems-private" ] && say "  ok       problems-private/ ($(find "$d/problems-private" -type f | wc -l) files)" \
    || say "  note     problems-private/ not included (it was not found on this machine)"
  [ -s "$d/terraform.tfvars" ] && say "  ok       terraform.tfvars" || say "  note     terraform.tfvars not included"
  if tar tzf "$d/s3data.tgz" >/dev/null 2>&1; then say "  ok       s3data.tgz reads back ($(tar tzf "$d/s3data.tgz" | wc -l) entries)"; else say "  BAD      s3data.tgz is not a readable archive"; ok=0; fi
  if command -v pg_restore >/dev/null 2>&1; then
    if pg_restore --list "$d/postgres.dump" 2>/dev/null | grep -q 'TABLE DATA'; then say "  ok       postgres.dump reads back and has table data"; else say "  BAD      postgres.dump is not readable"; ok=0; fi
  else
    say "  note     pg_restore is not installed here, so the dump was only checked on the server (sudo apt install postgresql-client to check it here too)"
  fi
  # The manifest records the checksums made on the server; compare them with what arrived.
  local name sum
  while read -r sum name; do
    [ -f "$d/$name" ] || continue
    [ "$(sha256sum "$d/$name" | cut -d' ' -f1)" = "$sum" ] && say "  ok       checksum of $name" || { say "  BAD      checksum of $name differs from the manifest"; ok=0; }
  done < <(sed -n 's/^sha256 \([0-9a-f]*\) \(.*\)$/\1 \2/p' "$d/manifest.txt")
  [ "$ok" = 1 ]
}

cmd="${1:-}"; shift || true

# Lets a test load the functions above without running anything.
[ "${TEARDOWN_SOURCE_ONLY:-0}" = 1 ] && return 0 2>/dev/null

case "$cmd" in
# ---------------------------------------------------------------------------------------------------------------
verify | extract)
  need openssl; need tar; need sha256sum
  file="${1:-}"; [ -f "$file" ] || die "usage: $0 $cmd FILE.enc$([ "$cmd" = extract ] && echo ' DIR')"
  if [ "$cmd" = extract ]; then
    dest="${2:-}"; [ -n "$dest" ] || die "usage: $0 extract FILE.enc DIR"
    [ ! -e "$dest" ] || [ -z "$(ls -A "$dest" 2>/dev/null)" ] || die "$dest is not empty"
    mkdir -p "$dest"; chmod 700 "$dest"
  else
    dest="$(mktemp -d)"; chmod 700 "$dest"; trap 'rm -rf "$dest"' EXIT
  fi
  tmp="$(mktemp)"; trap 'rm -f "$tmp"; [ "$cmd" = verify ] && rm -rf "$dest"' EXIT
  say "Type the passphrase you chose when the archive was made."
  decrypt "$file" "$tmp"
  tar xzf "$tmp" -C "$dest" || die "the decrypted file is not a valid archive"
  chmod 700 "$dest" # the archive's own "." entry would otherwise reset the folder's mode
  say "Checking the contents:"
  if check_dir "$dest"; then
    say ""; [ "$cmd" = extract ] && say "Unpacked into $dest (mode 700; it holds secrets, delete it when the rebuild is done)."
    say "ARCHIVE IS GOOD."
  else
    say ""; say "ARCHIVE IS NOT COMPLETE. Do not delete anything in Azure. Run the export again."; exit 1
  fi
  ;;

# ---------------------------------------------------------------------------------------------------------------
export)
  need ssh; need scp; need openssl; need tar; need sha256sum
  host="" out="$HOME/codearena-archive" yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --host) host="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --yes) yes=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -f "$KEY" ] || die "the deploy key $KEY does not exist (it is created by infra/prod/bootstrap.sh)"
  [ -n "$host" ] || host="$(gh variable get API_HOST 2>/dev/null || true)"
  [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not find the API address; pass --host 40.83.75.34"
  SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$USER_NAME@$host")
  SCP=(scp -q -i "$KEY" -o BatchMode=yes)
  "${SSH[@]}" true || die "cannot log in to $host (is the VM started? see docs/runbooks/hibernate.md)"

  stamp="$(date +%Y%m%d-%H%M)"
  umask 077
  mkdir -p "$out"; chmod 700 "$out"
  stage="$(mktemp -d "$out/.stage-$stamp.XXXX")"
  final="$out/codearena-archive-$stamp.tar.gz.enc"
  restarted=0
  restart_api() {
    [ "$restarted" = 1 ] && return 0
    restarted=1
    say "Starting the object store, the API and the pad servers again..."
    "${SSH[@]}" "$COMPOSE start s3 api collab1 collab2" >/dev/null 2>&1 || say "WARNING: could not restart the services; on the server run: cd /opt/codearena && docker compose --env-file prod.env start s3 api collab1 collab2"
  }
  cleanup() { restart_api; rm -rf "$stage"; "${SSH[@]}" "rm -f $RT/teardown.dump $RT/teardown-s3data.tgz" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  say "This will STOP the API and the pad servers on $host for a few minutes (so nothing changes while it is copied), copy the data to"
  say "$out, and start the API again. Nothing in Azure is deleted."
  if [ "$yes" != 1 ]; then read -r -p "Continue? type yes: " a; [ "$a" = yes ] || die "cancelled"; fi

  say "== 1/6 stopping the API and the pad servers (no writes while copying)"
  "${SSH[@]}" "$COMPOSE stop api collab1 collab2" >/dev/null

  say "== 2/6 database dump"
  "${SSH[@]}" "set -e; $COMPOSE ps -q postgres | head -1 | xargs -I{} docker exec {} pg_dump -U codearena -d codearena -Fc > $RT/teardown.dump; \
    PG=\$($COMPOSE ps -q postgres | head -1); docker exec -i \$PG pg_restore --list < $RT/teardown.dump | grep -c 'TABLE DATA' | xargs echo 'tables with data:'; \
    sha256sum $RT/teardown.dump | cut -d' ' -f1 > $RT/teardown.dump.sha"
  "${SCP[@]}" "$USER_NAME@$host:$RT/teardown.dump" "$stage/postgres.dump"
  want="$("${SSH[@]}" cat $RT/teardown.dump.sha)"
  [ "$(sha256sum "$stage/postgres.dump" | cut -d' ' -f1)" = "$want" ] || die "the dump changed on the way (checksum differs); run again"
  [ -s "$stage/postgres.dump" ] || die "the dump is empty"
  say "   dump copied and checksum matches ($(du -h "$stage/postgres.dump" | cut -f1))"

  say "== 3/6 row counts (used to prove the restore later)"
  "${SSH[@]}" "$COMPOSE ps -q postgres | head -1 | xargs -I{} docker exec {} psql -U codearena -d codearena -tA -F' ' -c \"select 'users', count(*) from users union all select 'problems', count(*) from problems union all select 'problem_versions', count(*) from problem_versions union all select 'contests', count(*) from contests union all select 'participants', count(*) from participants union all select 'submissions', count(*) from submissions union all select 'rooms', count(*) from rooms\"" > "$stage/counts.txt"
  cat "$stage/counts.txt"

  say "== 4/6 object store (test data and hidden tests)"
  "${SSH[@]}" "$COMPOSE stop s3" >/dev/null
  "${SSH[@]}" "set -e; df -h / | tail -1; docker run --rm -v codearena_s3data:/data:ro -v $RT:/out alpine sh -c 'tar czf /out/teardown-s3data.tgz -C /data . && chmod 644 /out/teardown-s3data.tgz'; \
    sha256sum $RT/teardown-s3data.tgz | cut -d' ' -f1 > $RT/teardown-s3data.sha"
  "${SCP[@]}" "$USER_NAME@$host:$RT/teardown-s3data.tgz" "$stage/s3data.tgz"
  want="$("${SSH[@]}" cat $RT/teardown-s3data.sha)"
  [ "$(sha256sum "$stage/s3data.tgz" | cut -d' ' -f1)" = "$want" ] || die "the object store copy changed on the way; run again"
  say "   copied and checksum matches ($(du -h "$stage/s3data.tgz" | cut -f1))"
  "${SSH[@]}" "rm -f $RT/teardown-s3data.sha $RT/teardown.dump.sha" >/dev/null 2>&1 || true
  restart_api

  say "== 5/6 secrets and settings (copied as files, not printed)"
  "${SCP[@]}" "$USER_NAME@$host:$APP/prod.env" "$stage/prod.env"
  "${SCP[@]}" "$USER_NAME@$host:$APP/judge-worker.env" "$stage/judge-worker.env"
  [ -f "$REPO/infra/terraform/terraform.tfvars" ] && cp "$REPO/infra/terraform/terraform.tfvars" "$stage/terraform.tfvars"
  [ -d "$REPO/problems-private" ] && cp -r "$REPO/problems-private" "$stage/problems-private"
  [ -f "$HOME/.codearena-relay-secret" ] && cp "$HOME/.codearena-relay-secret" "$stage/codearena-relay-secret"
  {
    echo "CodeArena archive $stamp"
    echo "api_host $host"
    echo "git_commit $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "azure_resource_group rg-codearena-prod"
    echo "github_variables (names and values; none is secret):"
    gh variable list 2>/dev/null | cut -f1,2 | sed 's/^/  /' || true
    echo "env_keys_in_prod_env (names only):"
    cut -d= -f1 "$stage/prod.env" | grep -E '^[A-Z_0-9]+$' | sort | sed 's/^/  /'
    for f in postgres.dump s3data.tgz; do echo "sha256 $(sha256sum "$stage/$f" | cut -d' ' -f1) $f"; done
  } > "$stage/manifest.txt"

  say "== 6/6 packing and encrypting"
  say "Choose a passphrase for the archive (typed twice, hidden). Put it in your password manager. Without it the file is useless."
  plain="$(mktemp "$out/.plain.XXXX")"
  tar czf "$plain" -C "$stage" .
  encrypt "$plain" "$final.part"; rm -f "$plain"
  mv "$final.part" "$final"
  say ""
  say "Archive: $final ($(du -h "$final" | cut -f1))"
  say "sha256:  $(sha256sum "$final" | cut -d' ' -f1)"
  say ""
  say "Now check it by decrypting it again (type the same passphrase):"
  say "  scripts/teardown-export.sh verify '$final'"
  say "Then copy the file to TWO other places (a USB stick, a cloud drive). Only after verify says ARCHIVE IS GOOD"
  say "and the copies exist, follow docs/runbooks/revive.md, part 2."
  ;;

*)
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
