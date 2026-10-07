#!/usr/bin/env bash
# D-03 (NFR-REL-04): scripts/restore-test.sh against a REAL throwaway Postgres (needs docker). It builds a source
# database, dumps it the way backup.sh does, and checks the restore test passes on a good dump and fails on an
# empty database, a damaged dump, and a missing file, and that it never leaves a container behind.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RESTORE="$HERE/../../../scripts/restore-test.sh"
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ok   $1"; else fail=$((fail + 1)); echo "  FAIL $1"; [ -f "${T:-/x}/out" ] && sed "s/^/       /" "$T/out" | tail -6; fi; }

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "docker is not available: skipping"; exit 0; }

T="$(mktemp -d)"
src=""
cleanup() { [ -n "$src" ] && docker rm -f "$src" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT

echo "D-03: restore-test.sh (real Postgres)"
before="$(docker ps -aq | sort)"

src="$(docker run -d -e POSTGRES_PASSWORD=x -e POSTGRES_DB=codearena -e POSTGRES_USER=codearena postgres:16)"
for _ in $(seq 1 60); do docker exec "$src" pg_isready -U codearena -d codearena -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
sql() { docker exec -i "$src" psql -U codearena -d codearena -h 127.0.0.1 -v ON_ERROR_STOP=1 -q "$@"; }

# An empty database first (a backup of nothing must not pass).
docker exec "$src" pg_dump -U codearena -d codearena -Fc > "$T/empty.dump"
sql -c "create table users (id serial primary key, handle text)" -c "create table submissions (id serial primary key, user_id int references users(id), code text)"
docker exec "$src" pg_dump -U codearena -d codearena -Fc > "$T/no-rows.dump"
REQUIRE_ROWS_IN=users "$RESTORE" --file "$T/no-rows.dump" >"$T/out" 2>&1; rc=$?
check "a restore of an empty users table is a FAIL" "$([ $rc = 1 ] && grep -q 'empty after restore' "$T/out" && echo 0 || echo 1)"

sql -c "insert into users(handle) values ('ayush'),('mira')" -c "insert into submissions(user_id, code) values (1, 'int main(){}')"
docker exec "$src" pg_dump -U codearena -d codearena -Fc > "$T/good.dump"
"$RESTORE" --file "$T/good.dump" >"$T/out" 2>&1; rc=$?
check "a good dump restores and passes" "$([ $rc = 0 ] && grep -q 'PASS: 2 tables restored, 3 rows' "$T/out" && echo 0 || echo 1)"
check "it prints per-table row counts" "$(grep -q 'public.users *2 rows' "$T/out" && echo 0 || echo 1)"

head -c 3000 "$T/good.dump" > "$T/cut.dump"
"$RESTORE" --file "$T/cut.dump" >"$T/out" 2>&1; rc=$?
check "a truncated dump is a FAIL" "$([ $rc = 1 ] && grep -q 'FAIL' "$T/out" && echo 0 || echo 1)"

"$RESTORE" --file "$T/missing.dump" >"$T/out" 2>&1; rc=$?
check "a missing file is a FAIL" "$([ $rc = 1 ] && echo 0 || echo 1)"
"$RESTORE" >/dev/null 2>&1; rc=$?
check "no arguments prints usage and exits 2" "$([ $rc = 2 ] && echo 0 || echo 1)"

docker rm -f "$src" >/dev/null 2>&1; src=""
after="$(docker ps -aq | sort)"
check "no container is left behind" "$([ "$before" = "$after" ] && echo 0 || echo 1)"

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
