#!/usr/bin/env bash
# Chaos test for FR-QUEUE-07 (Q-02): kill -9 a worker in the middle of judging and check that
# the job still ends with exactly one verdict, published by the surviving worker.
#
#   tests/chaos/kill-worker.sh            # 20 rounds (the acceptance bar)
#   ROUNDS=5 tests/chaos/kill-worker.sh
#
# Uses a throwaway redis:7 container (never the dev Redis) and two real worker binaries with
# short lease timings. Jobs are custom runs of a program that sleeps about 3 s, so no testset or
# object store is needed. Needs docker, isolate (with the box /dev from setup-isolate-wsl.sh),
# gcc and go.
#
# Until the verdict consumer exists (Q-03) "exactly one verdict" is checked on the `results`
# stream; Q-03 extends this script to check Postgres as well.
set -euo pipefail

ROUNDS="${ROUNDS:-20}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
REDIS_ID=""
declare -A PID

cleanup() {
  for w in "${!PID[@]}"; do kill -9 "${PID[$w]}" 2>/dev/null || true; done
  [[ -n "$REDIS_ID" ]] && docker rm -f "$REDIS_ID" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
rc() { docker exec "$REDIS_ID" redis-cli "$@"; }

say "building the worker"
(cd "$ROOT/apps/worker" && go build -o "$TMP/worker" .)

REDIS_ID="$(docker run -d --rm -p 127.0.0.1::6379 redis:7)"
PORT="$(docker port "$REDIS_ID" 6379/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 50); do rc ping >/dev/null 2>&1 && break; sleep 0.1; done

start_worker() { # name box_base core
  local name="$1"
  env -i PATH="$PATH" HOME="$HOME" \
    REDIS_URL="redis://127.0.0.1:$PORT" \
    S3_ENDPOINT=http://localhost:8333 S3_BUCKET=codearena S3_ACCESS_KEY=unused S3_SECRET_KEY=unused \
    WORKER_ID="$name" WORKER_LANES=practice WORKER_CACHE_DIR="$TMP/cache-$name" \
    WORKER_BOX_BASE="$2" WORKER_CORES="$3" \
    WORKER_LEASE_MS=300 WORKER_RECLAIM_IDLE_MS=1500 \
    "$TMP/worker" >>"$TMP/$name.log" 2>&1 &
  PID[$name]=$!
  disown "$!" # no "Killed" job-control noise when the round kills it
}

start_worker chaos-a 700 0
start_worker chaos-b 720 1
sleep 1

job_json() { # submission id
  python3 - "$1" <<'PY'
import json, sys
src = '#include <unistd.h>\n#include <stdio.h>\nint main(void){ sleep(3); puts("slept"); return 0; }\n'
print(json.dumps({
  "jobId": "chaos-" + sys.argv[1], "submissionId": sys.argv[1], "runVersion": 1, "lane": "practice",
  "language": "c", "source": src, "mode": "run", "customInput": "",
  "problem": {"versionId": "pv-chaos", "testsetHash": "0" * 64,
              "testsetUri": "s3://codearena/testsets/unused.tar",
              "checker": {"kind": "tokens"}, "limits": {"timeMs": 10000, "memMb": 256, "outputKb": 64}},
  "stopOnFirstFailure": True, "traceparent": "00-" + "1" * 32 + "-" + "2" * 16 + "-01",
  "enqueuedAt": 1, "seq": 1}))
PY
}

count_results() { # submission id -> "count workerIds"
  rc --raw XRANGE results - + | python3 -c '
import json, sys
sid = sys.argv[1]
ws = []
for line in sys.stdin:
    line = line.strip()
    if line.startswith("{"):
        r = json.loads(line)
        if r["submissionId"] == sid:
            ws.append(r["workerId"])
print(len(ws), " ".join(ws))' "$1"
}

owner_of_pending() {
  rc --raw XPENDING jobs:practice judges - + 1 | sed -n '2p'
}

fail=0
for round in $(seq "$ROUNDS"); do
  sid="chaos-sub-$round"
  rc XADD jobs:practice '*' job "$(job_json "$sid")" >/dev/null

  owner=""
  for _ in $(seq 200); do owner="$(owner_of_pending)"; [[ -n "$owner" ]] && break; sleep 0.05; done
  if [[ -z "$owner" ]]; then say "round $round: FAIL no worker claimed the job"; fail=1; break; fi

  sleep "0.$((RANDOM % 15))"           # land somewhere in compile or run
  kill -9 "${PID[$owner]}"
  survivor=chaos-a; [[ "$owner" == chaos-a ]] && survivor=chaos-b

  got="0"
  for _ in $(seq 400); do
    got="$(count_results "$sid")"
    [[ "${got%% *}" -ge 1 ]] && break
    sleep 0.05
  done
  sleep 2                                # a duplicate would show up by now
  got="$(count_results "$sid")"
  n="${got%% *}"; by="${got#* }"
  pend="$(rc XPENDING jobs:practice judges | head -1)"
  dlq="$(rc XLEN jobs:dlq)"
  if [[ "$n" == 1 && "$by" == "$survivor" && "$pend" == 0 && "$dlq" == 0 ]]; then
    say "round $round: ok   killed $owner, verdict once by $survivor"
  else
    say "round $round: FAIL killed $owner; results=$n by=[$by] pending=$pend dlq=$dlq"
    fail=1
  fi

  case "$owner" in
    chaos-a) start_worker chaos-a 700 0 ;;
    chaos-b) start_worker chaos-b 720 1 ;;
  esac
  sleep 1
done

if [[ "$fail" == 0 ]]; then
  say "PASS: $ROUNDS/$ROUNDS rounds ended with exactly one verdict"
else
  say "FAIL (worker logs: chaos-a.log, chaos-b.log in $TMP, removed on exit)"
  tail -20 "$TMP/chaos-a.log" "$TMP/chaos-b.log" || true
  exit 1
fi
