#!/usr/bin/env bash
# Installs isolate (pinned) from source, enables isolate.service, checks the host and runs a
# smoke test in a sandbox box. Idempotent: re-running skips what is already done.
# Run with: sudo scripts/setup-isolate-wsl.sh
# Needs Ubuntu/Debian with systemd and cgroup v2 (WSL2: systemd=true in /etc/wsl.conf).
set -euo pipefail

ISOLATE_TAG="v2.7"
ISOLATE_COMMIT="8f185bb37f3f23e29b33b0c7727c91c13429abe3"
SMOKE_BOX=99 # high id so it never clashes with the worker's boxes

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$*"; }

step "Checking cgroup v2 and systemd"
if [[ "$(stat -fc %T /sys/fs/cgroup)" != "cgroup2fs" ]]; then
  echo "cgroup v2 is not mounted at /sys/fs/cgroup; isolate --cg needs it." >&2
  exit 1
fi
if [[ "$(ps -p 1 -o comm=)" != "systemd" ]]; then
  echo "systemd is not PID 1. On WSL2 add 'systemd=true' under [boot] in /etc/wsl.conf, then 'wsl --shutdown'." >&2
  exit 1
fi

step "Installing build dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libcap-dev libseccomp-dev libsystemd-dev git

installed_version() { isolate --version 2>/dev/null | head -n1 || true; }

if [[ "$(installed_version)" == *"${ISOLATE_TAG#v}"* ]]; then
  step "isolate ${ISOLATE_TAG} already installed, skipping build"
else
  step "Building isolate ${ISOLATE_TAG}"
  src="$(mktemp -d)"
  git clone -q --depth 1 --branch "$ISOLATE_TAG" https://github.com/ioi/isolate.git "$src/isolate"
  actual="$(git -C "$src/isolate" rev-parse HEAD)"
  if [[ "$actual" != "$ISOLATE_COMMIT" ]]; then
    echo "tag ${ISOLATE_TAG} resolved to ${actual}, expected ${ISOLATE_COMMIT}; refusing to build" >&2
    exit 1
  fi
  make -C "$src/isolate" -j"$(nproc)" isolate isolate-cg-keeper default.cf \
    systemd/isolate.service systemd/isolate.slice >/dev/null
  make -C "$src/isolate" install >/dev/null
  rm -rf "$src"
fi

step "Enabling isolate.service"
systemctl daemon-reload
systemctl enable --now isolate.service
systemctl is-active --quiet isolate.service

step "isolate --version"
isolate --version

step "isolate-check-environment (warnings about CPU frequency/ASLR/swap are expected on WSL2)"
isolate-check-environment || echo "(check-environment reported warnings; see above)"

step "Smoke test: /bin/echo in box ${SMOKE_BOX}"
meta="$(mktemp)"
cleanup() { isolate --box-id="$SMOKE_BOX" --cg --cleanup >/dev/null 2>&1 || true; rm -f "$meta"; }
trap cleanup EXIT
cleanup
isolate --box-id="$SMOKE_BOX" --cg --init >/dev/null
out="$(isolate --box-id="$SMOKE_BOX" --cg --run --meta="$meta" --time=2 --wall-time=5 \
  --cg-mem=65536 --processes=1 --env=PATH=/usr/bin:/bin -- /bin/echo hello-from-isolate 2>&1)"
echo "$out"
echo "--- meta ---"
cat "$meta"
if ! grep -q "hello-from-isolate" <<<"$out"; then
  echo "SMOKE TEST FAILED: expected output not seen" >&2
  exit 1
fi
if grep -q '^status:' "$meta"; then
  echo "SMOKE TEST FAILED: non-clean status in meta" >&2
  exit 1
fi
echo
echo "SMOKE TEST PASSED"
