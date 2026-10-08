#!/usr/bin/env bash
# Runs the load-test data commands on the API VM over SSH (they need the database).
#
#   tests/load/prod.sh seed 150 /tmp/load-seed.json     # fake users + a running lt-* contest
#   tests/load/prod.sh report lt-abc123 /tmp/report.json
#   tests/load/prod.sh verify SLUG                      # read-only: is every verdict stored exactly once, nothing stuck? (any contest)
#   tests/load/prod.sh cleanup                          # deletes only @loadtest.invalid users, lt-* contests and their submissions
#
# Uses the deploy key and the image that is currently running, so it needs no secrets typed here.
# The seed file holds refresh tokens of the fake users: it is written 0600; delete it afterwards.
set -euo pipefail
HOST="${API_SSH:-codearena@40.83.75.34}"
KEY="${API_SSH_KEY:-$HOME/.ssh/codearena_deploy}"
remote() { # args for load-cli
  ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" \
    "cd /opt/codearena && export API_IMAGE=\$(cat state/current) && docker compose --env-file prod.env -f docker-compose.yml --profile tools run --rm -T loadtest $*"
}
case "${1:-}" in
  seed)
    n="${2:?users}"; out="${3:?output file}"
    (umask 077; remote seed --users "$n" --out - >"$out")
    echo "seed written to $out ($(wc -c <"$out") bytes); contest: $(node -p "require('$out').contest.slug")" ;;
  report)
    slug="${2:?contest slug}"; out="${3:?output file}"
    remote report "$slug" >"$out"; echo "report written to $out" ;;
  verify)
    slug="${2:?contest slug}"
    remote verify "$slug" ;;
  cleanup) remote cleanup ;;
  *) echo "usage: prod.sh seed N FILE | report SLUG FILE | verify SLUG | cleanup" >&2; exit 2 ;;
esac
