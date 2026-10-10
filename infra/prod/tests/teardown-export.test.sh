#!/usr/bin/env bash
# Offline test of scripts/teardown-export.sh verify / extract (no server, no Azure): a good archive passes, and a
# wrong passphrase, a missing file, a damaged object-store copy and a changed checksum each fail with a message.
set -uo pipefail
S="$(cd "$(dirname "$0")/../../.." && pwd)/scripts/teardown-export.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { # name expected-exit-code command...
  local name="$1" want="$2"; shift 2
  "$@" >"$T/out" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name (exit $got, wanted $want)"; sed 's/^/     /' "$T/out"; fi
}

# A stand-in pg_restore (the real one may or may not be installed): a dump is readable when it says so.
mkdir -p "$T/stubbin"
cat > "$T/stubbin/pg_restore" <<'SH'
#!/usr/bin/env bash
file="${@: -1}"
grep -q TOCDATA "$file" && echo "1; 0 0 TABLE DATA public users codearena" || exit 1
SH
chmod +x "$T/stubbin/pg_restore"
export PATH="$T/stubbin:$PATH"

make_stage() { # $1 dir
  mkdir -p "$1/d"; echo data > "$1/d/x"
  (cd "$1" && tar czf s3data.tgz d && rm -r d)
  { echo TOCDATA; head -c 2000 /dev/urandom; } > "$1/postgres.dump"
  printf 'A=1\nB=2\n' > "$1/prod.env"; printf 'C=3\n' > "$1/judge-worker.env"; echo "users 3" > "$1/counts.txt"
  { echo "manifest"; for f in postgres.dump s3data.tgz; do echo "sha256 $(sha256sum "$1/$f" | cut -d' ' -f1) $f"; done; } > "$1/manifest.txt"
}
pack() { # $1 stage $2 out
  tar czf "$T/plain" -C "$1" . && TEARDOWN_PASSFILE="$T/pass" TEARDOWN_SOURCE_ONLY=1 bash -c "source '$S'; encrypt '$T/plain' '$2'"
}

echo right > "$T/pass"
make_stage "$T/good"; pack "$T/good" "$T/good.enc"

export TEARDOWN_PASSFILE="$T/pass"
check "W-04: a good archive verifies" 0 bash "$S" verify "$T/good.enc"
check "W-04: extract unpacks a good archive" 0 bash "$S" extract "$T/good.enc" "$T/out-dir"
[ -s "$T/out-dir/prod.env" ] && ok "extracted prod.env is there" || bad "extracted prod.env missing"
[ "$(stat -c %a "$T/out-dir")" = 700 ] && ok "extract folder is mode 700" || bad "extract folder is not mode 700"
check "W-04: extract refuses a folder that is not empty" 1 bash "$S" extract "$T/good.enc" "$T/out-dir"

echo wrong > "$T/pass.wrong"
check "W-04: a wrong passphrase fails" 1 env TEARDOWN_PASSFILE="$T/pass.wrong" bash "$S" verify "$T/good.enc"

head -c 100 "$T/good.enc" > "$T/cut.enc"
check "W-04: a truncated archive fails" 1 bash "$S" verify "$T/cut.enc"

make_stage "$T/nodump"; rm "$T/nodump/postgres.dump"; pack "$T/nodump" "$T/nodump.enc"
check "W-04: an archive without the database dump fails" 1 bash "$S" verify "$T/nodump.enc"

make_stage "$T/baddump"; echo "not a dump" > "$T/baddump/postgres.dump"
{ echo manifest; for f in postgres.dump s3data.tgz; do echo "sha256 $(sha256sum "$T/baddump/$f" | cut -d' ' -f1) $f"; done; } > "$T/baddump/manifest.txt"
pack "$T/baddump" "$T/baddump.enc"
check "W-04: a dump that pg_restore cannot read fails" 1 bash "$S" verify "$T/baddump.enc"

make_stage "$T/badtar"; echo notatar > "$T/badtar/s3data.tgz"; pack "$T/badtar" "$T/badtar.enc"
check "W-04: a damaged object-store copy fails" 1 bash "$S" verify "$T/badtar.enc"

make_stage "$T/sum"; echo changed >> "$T/sum/postgres.dump"; pack "$T/sum" "$T/sum.enc"
check "W-04: a dump that differs from its manifest checksum fails" 1 bash "$S" verify "$T/sum.enc"

# ---- the export itself, against a fake server (stub ssh, scp and docker; nothing real is touched) ----
FAKE="$T/fake"; mkdir -p "$FAKE/bin" "$FAKE/rtmp" "$FAKE/opt/codearena/state"
echo img > "$FAKE/opt/codearena/state/current"; printf 'A=1\nOWNER_EMAIL=x@example.test\n' > "$FAKE/opt/codearena/prod.env"; printf 'C=3\n' > "$FAKE/opt/codearena/judge-worker.env"
cat > "$FAKE/bin/ssh" <<'SH'
#!/usr/bin/env bash
cmd="${*:8}" # ssh -i KEY -o A -o B user@host COMMAND...: ssh joins the command words
[ "$cmd" = true ] && exit 0
cmd="${cmd//\/opt\/codearena/$FAKE_ROOT/opt/codearena}"
echo "$cmd" >> "$FAKE_ROOT/ssh.log"
exec bash -c "$cmd"
SH
cat > "$FAKE/bin/scp" <<'SH'
#!/usr/bin/env bash
args=("$@"); src="${args[${#args[@]}-2]}"; dst="${args[${#args[@]}-1]}"
src="${src#*:}"; src="${src//\/opt\/codearena/$FAKE_ROOT/opt/codearena}"
cp "$src" "$dst"
SH
cat > "$FAKE/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_ROOT/docker.log"
case "$*" in
  *"ps -q postgres"*) echo fakepg ;;
  *"compose"*) : ;;
  "exec fakepg pg_dump"*) { echo TOCDATA; head -c 4000 /dev/urandom; } ;;
  "exec -i fakepg pg_restore --list"*) echo "1; 0 0 TABLE DATA public users codearena" ;;
  "exec fakepg psql"*) printf 'users 3\nproblems 20\n' ;;
  "run --rm"*) d="$(mktemp -d)"; echo tests > "$d/t"; tar czf "$FAKE_ROOT/rtmp/teardown-s3data.tgz" -C "$d" . ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
SH
chmod +x "$FAKE/bin/"*
cat > "$FAKE/bin/gh" <<'SH'
#!/usr/bin/env bash
[ "$1 $2" = "variable list" ] && printf 'API_HOST\t1.2.3.4\nDEPLOY_ENABLED\tfalse\n'; exit 0
SH
chmod +x "$FAKE/bin/gh"
mkdir -p "$T/home/.ssh"; echo k > "$T/home/.ssh/codearena_deploy"
export FAKE_ROOT="$FAKE"
echo "round trip" > /dev/null
check "W-04: export against a fake server makes an archive that verifies" 0 \
  bash -c "printf 'yes\n' | PATH='$FAKE/bin:$PATH' HOME='$T/home' DEPLOY_KEY='$T/home/.ssh/codearena_deploy' TEARDOWN_REMOTE_TMP='$FAKE/rtmp' TEARDOWN_PASSFILE='$T/pass' bash '$S' export --host 1.2.3.4 --out '$T/archives'"
arch="$(ls "$T"/archives/codearena-archive-*.enc 2>/dev/null | head -1)"
[ -n "$arch" ] && ok "export wrote an archive" || bad "export wrote no archive"
check "W-04: the exported archive verifies" 0 bash "$S" verify "$arch"
check "W-04: the exported archive contains the row counts and the manifest key names, not secret values" 0 bash -c "bash '$S' extract '$arch' '$T/ex' >/dev/null && grep -q 'users 3' '$T/ex/counts.txt' && grep -q 'OWNER_EMAIL' '$T/ex/manifest.txt' && ! grep -q 'x@example.test' '$T/ex/manifest.txt'"
grep -q 'compose.*stop api collab1 collab2' "$FAKE/ssh.log" && grep -q 'compose.*start s3 api collab1 collab2' "$FAKE/ssh.log" && ok "export stops the services, and starts them again" || bad "export did not stop and restart the services"
[ -z "$(ls -A "$FAKE/rtmp")" ] && ok "export cleaned its temporary files" || bad "temporary files left behind: $(ls "$FAKE/rtmp")"
ls -A "$T/archives" | grep -q '^\.stage' && bad "the staging folder was left behind" || ok "the staging folder was removed"

check "the script has no syntax errors" 0 bash -n "$S"
[ "$fails" = 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
