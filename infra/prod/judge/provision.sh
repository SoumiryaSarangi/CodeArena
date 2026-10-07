#!/usr/bin/env bash
# Installs (or updates) the judge worker on a judge VM, and rolls back if the new one does not start.
# Runs ON the judge as root, called by the pipeline over SSH (deploy-judges.sh). Idempotent.
#
# Inputs, all in $INCOMING (default /tmp/codearena-incoming), put there by the pipeline:
#   worker                    the new binary
#   worker.env                judge-only settings (Redis `judge` user, read-only storage key)
#   codearena-worker.service  the systemd unit
#   node_exporter + node-exporter.service   (optional) host metrics
#
# A judge VM has no internet by design, so everything arrives from the pipeline; nothing is downloaded.
set -euo pipefail

INCOMING="${INCOMING:-/tmp/codearena-incoming}"
BIN_DIR="${BIN_DIR:-/opt/codearena/bin}"
ETC_DIR="${ETC_DIR:-/etc/codearena}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
START_TIMEOUT="${START_TIMEOUT:-30}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
JOURNALCTL="${JOURNALCTL:-journalctl}"

log() { echo "[judge $(hostname) $(date -u +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" = 0 ] || [ -n "${PROVISION_TEST:-}" ] || die "run as root"
for f in worker worker.env codearena-worker.service; do [ -f "$INCOMING/$f" ] || die "missing $INCOMING/$f"; done
id codearena-judge >/dev/null 2>&1 || [ -n "${PROVISION_TEST:-}" ] || die "user codearena-judge is missing (cloud-init creates it)"

install -d -m 0755 "$BIN_DIR"
install -d -m 0750 "$ETC_DIR"
install -d -m 0750 /var/cache/codearena 2>/dev/null || true

# The settings are readable by the service user only (they hold the Redis password).
install -m 0640 "$INCOMING/worker.env" "$ETC_DIR/worker.env.new"
[ -n "${PROVISION_TEST:-}" ] || chown root:codearena-judge "$ETC_DIR/worker.env.new"
mv "$ETC_DIR/worker.env.new" "$ETC_DIR/worker.env"

# Keep the previous binary so a bad release can be undone without the pipeline.
had_previous=0
if [ -x "$BIN_DIR/worker" ]; then cp -p "$BIN_DIR/worker" "$BIN_DIR/worker.prev"; had_previous=1; fi
install -m 0755 "$INCOMING/worker" "$BIN_DIR/worker.new"
mv "$BIN_DIR/worker.new" "$BIN_DIR/worker"

install -m 0644 "$INCOMING/codearena-worker.service" "$UNIT_DIR/codearena-worker.service"

if [ -f "$INCOMING/node_exporter" ] && [ -f "$INCOMING/node-exporter.service" ]; then
  ip="$(hostname -I | awk '{print $1}')"
  install -m 0755 "$INCOMING/node_exporter" /usr/local/bin/node_exporter
  install -m 0644 "$INCOMING/node-exporter.service" "$UNIT_DIR/node-exporter.service"
  printf 'NODE_EXPORTER_LISTEN=%s:9100\n' "${ip:-127.0.0.1}" > /etc/default/node-exporter
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL enable node-exporter >/dev/null 2>&1 || true
  $SYSTEMCTL restart node-exporter || log "warning: node exporter did not start (metrics only; the judge is unaffected)"
fi

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable codearena-worker >/dev/null 2>&1 || true
since="$(date '+%Y-%m-%d %H:%M:%S')"
$SYSTEMCTL restart codearena-worker || true

started() {
  local waited=0
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    if $SYSTEMCTL is-active --quiet codearena-worker \
       && $JOURNALCTL -u codearena-worker --since "$since" --no-pager 2>/dev/null | grep -q '"msg":"worker started"'; then
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

if started; then
  log "worker is running"
  rm -f "$INCOMING"/worker.env "$INCOMING"/worker   # the settings hold secrets: do not leave them in /tmp
  exit 0
fi

log "the new worker did not start; recent log:"
$JOURNALCTL -u codearena-worker --since "$since" --no-pager 2>/dev/null | tail -15 || true
if [ "$had_previous" = 1 ]; then
  log "rolling back to the previous binary"
  mv "$BIN_DIR/worker.prev" "$BIN_DIR/worker"
  $SYSTEMCTL restart codearena-worker || true
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  if started; then log "rolled back: the previous worker is running again"; else log "the previous worker is not running either"; fi
else
  log "no previous binary to go back to"
fi
rm -f "$INCOMING"/worker.env
exit 1
