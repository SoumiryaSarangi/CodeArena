#!/usr/bin/env bash
# Failure drills on PRODUCTION (O-06). They kill a judge worker, the API, Redis, and stop a judge VM, on fake
# `lt-*` contests only. Run them only when no real contest is on (the driver checks) and with 2 judges up:
#
#   scripts/scale-judges.sh up 1                         # 2 judges; costs about $0.12/h while it runs
#   tests/chaos/prod.sh --yes [scenario ...] [--out FILE]
#   scripts/scale-judges.sh to 1                         # when you are done
#
# Without --yes it only prints what it would do. Whatever a drill breaks is put back before the next one.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${1:-}" != "--yes" ]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Scenarios: $(node -e "import('./tests/chaos/scenarios.mjs').then(m=>console.log(Object.keys(m.SCENARIOS).join(', ')))")"
  echo "Add --yes to run them."
  exit 0
fi
shift
exec node tests/chaos/drill.mjs prod "$@"
