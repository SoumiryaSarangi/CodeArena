#!/usr/bin/env bash
# Uploads the dashboards and alert rules in this directory to your Grafana Cloud stack (O-01).
#   infra/grafana/push.sh https://<your-stack>.grafana.net
# You are asked for a service-account token ONCE at a hidden prompt (Administration > Users and access >
# Service accounts > role Editor > Add token). It is never printed, logged or put on a command line.
# Safe to run again: dashboards and rules are replaced by their fixed ids.
set -euo pipefail
url="${1:-}"
[[ "$url" =~ ^https://[A-Za-z0-9.-]+\.grafana\.net/?$ ]] || { echo "usage: push.sh https://<your-stack>.grafana.net" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
read -r -s -p "Grafana service-account token (hidden): " GRAFANA_PUSH_TOKEN; echo
[ -n "$GRAFANA_PUSH_TOKEN" ] || { echo "nothing entered" >&2; exit 1; }
export GRAFANA_PUSH_TOKEN GRAFANA_PUSH_URL="${url%/}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HERE="$here"
exec python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error, glob

base, token, here = os.environ["GRAFANA_PUSH_URL"], os.environ["GRAFANA_PUSH_TOKEN"], os.environ["HERE"]

def call(method, path, body=None, ok=(200, 201, 202)):
    req = urllib.request.Request(base + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, (json.loads(e.read() or b"null") if e.headers.get_content_type() == "application/json" else None)

# The metrics data source of the stack (Grafana Cloud calls it grafanacloud-<stack>-prom).
st, sources = call("GET", "/api/datasources")
if st != 200:
    sys.exit(f"could not list data sources (HTTP {st}); is the token valid and the role Editor or Admin?")
prom = next((s for s in sources if s["type"] == "prometheus" and s["name"].endswith("-prom")), None) or \
       next((s for s in sources if s["type"] == "prometheus"), None)
if not prom:
    sys.exit("no Prometheus data source found in this stack")
print("metrics data source:", prom["name"])

st, folders = call("GET", "/api/folders")
folder = next((f for f in folders or [] if f["title"] == "CodeArena"), None)
if not folder:
    st, folder = call("POST", "/api/folders", {"title": "CodeArena"})
    if st not in (200, 201):
        sys.exit(f"could not create the folder (HTTP {st})")
print("folder:", folder["uid"])

for path in sorted(glob.glob(os.path.join(here, "dashboards", "*.json"))):
    d = json.load(open(path))
    st, out = call("POST", "/api/dashboards/db", {"dashboard": d, "folderUid": folder["uid"], "overwrite": True})
    print(f"dashboard {d['title']}: HTTP {st}")
    if st != 200:
        sys.exit(json.dumps(out))

# Alert rule group: one interval for all, replaced rule by rule.
for rule in json.load(open(os.path.join(here, "alerts.json"))):
    rule = json.loads(json.dumps(rule).replace("__PROM__", prom["uid"]).replace("__FOLDER__", folder["uid"]))
    rule["orgID"] = 1
    st, _ = call("GET", "/api/v1/provisioning/alert-rules/" + rule["uid"])
    st, out = call("PUT" if st == 200 else "POST", "/api/v1/provisioning/alert-rules" + ("/" + rule["uid"] if st == 200 else ""), rule)
    print(f"alert {rule['title']}: HTTP {st}")
    if st not in (200, 201):
        sys.exit(json.dumps(out))
print("done: open Dashboards > CodeArena and Alerting > Alert rules.")
PY
