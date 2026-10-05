#!/usr/bin/env bash
# Generates the ES256 (P-256) key pair for access tokens (FR-AUTH-04) and prints two lines to
# paste into apps/api/.env. Nothing is written to disk. Run: scripts/gen-keys.sh
set -euo pipefail

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

private="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)"
public="$(printf '%s\n' "$private" | openssl pkey -pubout 2>/dev/null)"

# One line each, newlines as literal \n (the API config turns them back into PEM).
oneline() { printf '%s' "$1" | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }

echo "JWT_PRIVATE_KEY=\"$(oneline "$private")\""
echo "JWT_PUBLIC_KEY=\"$(oneline "$public")\""
