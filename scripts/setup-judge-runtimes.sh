#!/usr/bin/env bash
# Installs the language runtimes the judge sandbox needs under /usr (gcc, g++, python3,
# JDK 21, Node.js) and checks every path in apps/worker/internal/languages/languages.yaml.
# Idempotent. Run with: sudo scripts/setup-judge-runtimes.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

apt-get update -qq
apt-get install -y --no-install-recommends build-essential python3 openjdk-21-jdk-headless nodejs

yaml="$(dirname "$0")/../apps/worker/internal/languages/languages.yaml"
missing=0
# Every absolute tool path named in the registry must exist and be executable.
for p in $(grep -oE '(^|[\[ ,])/(usr|bin)/[A-Za-z0-9_./+-]+' "$yaml" | tr -d '[ ,' | sort -u); do
  if [[ -x "$p" ]]; then echo "ok       $p"; else echo "MISSING  $p"; missing=1; fi
done
[[ -d /etc/java-21-openjdk ]] && echo "ok       /etc/java-21-openjdk" || { echo "MISSING  /etc/java-21-openjdk"; missing=1; }
exit "$missing"
