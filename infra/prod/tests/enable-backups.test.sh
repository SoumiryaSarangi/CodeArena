#!/usr/bin/env bash
# D-03: enable-backups.sh with fake terraform and ssh. The upload token must reach the server on stdin only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENABLE="$HERE/../enable-backups.sh"
pass=0 fail=0
SAS='?sv=2022-11-02&sr=c&sig=SECRETSIGNATURE%2Bvalue&sp=racwl'
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/in"
cat > "$T/bin/terraform" <<F
#!/usr/bin/env bash
case "\$*" in
  *backup_storage_account*) printf 'codearenabk' ;;
  *backup_container_sas*) [ "\${FAKE_TF_FAIL:-}" = 1 ] && exit 1; printf '%s' '$SAS' ;;
  *backup_container*) printf 'backups' ;;
esac
F
cat > "$T/bin/ssh" <<'F'
#!/usr/bin/env bash
n=$(ls "$FAKE_IN" | wc -l)
echo "ssh $*" >> "$FAKE_ARGV"
cat > "$FAKE_IN/stdin.$n"
exit 0
F
chmod +x "$T/bin/terraform" "$T/bin/ssh"
export PATH="$T/bin:$PATH" FAKE_IN="$T/in" FAKE_ARGV="$T/argv" DEPLOY_KEY="$T/key" API_HOST=203.0.113.9
: > "$DEPLOY_KEY"; : > "$T/argv"

echo "D-03: enable-backups.sh"
out="$("$ENABLE" 2>&1)"; rc=$?
check "exits 0" "$([ $rc = 0 ] && echo 0 || echo 1)"
env_file="$(grep -l '^BACKUP_URL=' "$T"/in/stdin.* | head -1)"
check "backup.env gets the container URL" "$(grep -qx 'BACKUP_URL=https://codearenabk.blob.core.windows.net/backups' "$env_file" && echo 0 || echo 1)"
check "backup.env gets the token without its leading '?'" "$(grep -qx 'BACKUP_SAS=sv=2022-11-02&sr=c&sig=SECRETSIGNATURE%2Bvalue&sp=racwl' "$env_file" && echo 0 || echo 1)"
check "the token is not on any command line" "$(! grep -q 'SECRETSIGNATURE' "$T/argv" && echo 0 || echo 1)"
check "the token is not printed" "$(! grep -q 'SECRETSIGNATURE' <<< "$out" && echo 0 || echo 1)"
check "the file is written with umask 077 and replaced atomically" "$(grep -q 'umask 077; cat > /opt/codearena/backup.env.new && mv' "$T/argv" && echo 0 || echo 1)"
check "both timers are enabled" "$(grep -q 'enable --now codearena-backup.timer codearena-restore-test.timer' "$T/argv" && echo 0 || echo 1)"
check "the first backup and restore test run" "$(grep -q 'backup.sh --label first && .*restore-test.sh --latest' "$T/argv" && echo 0 || echo 1)"
listing="$(for f in "$T"/in/stdin.*; do tar -tzf "$f" 2>/dev/null; done | sort | tr "\n" " ")"
check "the uploaded archive has backup.sh, the units and restore-test.sh" "$([[ "$listing" == *backup.sh* && "$listing" == *restore-test.sh* && "$listing" == *codearena-backup.timer* && "$listing" == *codearena-restore-test.service* ]] && echo 0 || echo 1)"

: > "$T/argv"; rm -f "$T"/in/*
FAKE_TF_FAIL=1 "$ENABLE" >/dev/null 2>&1; rc=$?
check "a terraform failure stops before anything is sent to the server" "$([ $rc = 1 ] && [ ! -s "$T/argv" ] && echo 0 || echo 1)"
"$ENABLE" --no-first-run >/dev/null 2>&1
check "--no-first-run skips the first backup" "$(! grep -q 'backup.sh --label first' "$T/argv" && echo 0 || echo 1)"

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
