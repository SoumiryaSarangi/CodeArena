"""The plagiarism job's loop: claim a run from the API, score it, post the result (or the failure).

PL-05. The API never starts a process: this loop polls `POST /api/admin/plag/runs/claim` with the service token and,
when a run is waiting, receives the contest's final submissions per problem (SD-§13.1 step 1), runs Stage A and B on
each problem, and posts the pairs and clusters. A crash while scoring is reported with `/fail` and the loop goes on;
a run whose job vanished is taken over by the API after its stale time.
"""

from __future__ import annotations

import dataclasses
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from .combine import DEFAULT, Combiner
from .embed import Embedder
from .payload import PostError, post_results, to_payload
from .pipeline import Params, ProblemResult, run_problem
from .stage_a import Submission, Template

#: The run parameters an admin may set from the API; anything else is ignored (the API passes them on unread).
TUNABLE: dict[str, type] = {
    "stage_a_threshold": float,
    "sweep_cosine": float,
    "report_threshold": float,
    "neighbours": int,
    "embed_on": str,
}


def params_from(raw: dict[str, Any]) -> Params:
    """Params with the admin's overrides applied, checking each one's type and ignoring unknown keys."""
    chosen: dict[str, Any] = {}
    for key, kind in TUNABLE.items():
        if key not in raw:
            continue
        v = raw[key]
        if kind is float and isinstance(v, (int, float)) and not isinstance(v, bool):
            chosen[key] = float(v)
        elif kind is int and isinstance(v, int) and not isinstance(v, bool):
            chosen[key] = v
        elif kind is str and v in ("source", "normalised"):
            chosen[key] = v
    return dataclasses.replace(Params(), **chosen)


class Api:
    """The job's side of the API: claim work, report failure (results go through `post_results`)."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base = base_url.rstrip("/")
        self.token = token

    def _post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        req = urllib.request.Request(
            f"{self.base}/api{path}",
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Service-Token": self.token},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 (the API address is configuration)
                raw = resp.read()
                return int(resp.status), (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raise PostError(f"the API answered HTTP {e.code} to {path}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise PostError(f"could not reach the API for {path}: {e}") from e

    def claim(self) -> dict[str, Any] | None:
        status, body = self._post("/admin/plag/runs/claim", {})
        return None if status == 204 else body

    def fail(self, run_id: str, error: str) -> None:
        self._post(f"/admin/plag/runs/{run_id}/fail", {"error": error[:900] or "unknown error"})


def score(claim: dict[str, Any], embedder: Embedder, combiner: Combiner) -> tuple[list[ProblemResult], Params]:
    params = params_from(claim.get("params") or {})
    results = []
    for p in claim["problems"]:
        subs = [Submission(s["id"], s["language"], s["source"], s.get("user")) for s in p["submissions"]]
        tpls = [Template(t["language"], t["source"]) for t in p.get("templates", [])]
        results.append(
            run_problem(p["problemId"], subs, embedder=embedder, combiner=combiner, templates=tpls, params=params)
        )
    return results, params


def handle(api: Api, claim: dict[str, Any], embedder: Embedder, combiner: Combiner = DEFAULT) -> bool:
    """Scores one claimed run and posts the outcome. True if the results were accepted."""
    run_id = str(claim["runId"])
    try:
        results, params = score(claim, embedder, combiner)
        post_results(api.base, run_id, api.token, to_payload(run_id, results, params, combiner))
        return True
    except Exception as e:  # noqa: BLE001 (whatever went wrong, the run must not stay "running" silently)
        try:
            api.fail(run_id, f"{type(e).__name__}: {e}")
        except PostError:
            pass  # the API will take the run over after its stale time
        return False


def serve(
    api: Api,
    embedder: Embedder,
    combiner: Combiner = DEFAULT,
    *,
    interval: float = 15.0,
    once: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = lambda _m: None,
) -> int:
    """Polls for work until stopped (or, with `once`, until one poll came back empty). Returns the runs handled."""
    handled = 0
    while True:
        try:
            claim = api.claim()
        except PostError as e:
            log(f"claim failed: {e}")
            claim = None
            if once:
                return handled
        if claim is not None:
            ok = handle(api, claim, embedder, combiner)
            handled += 1
            log(f"run {claim['runId']}: {'done' if ok else 'failed'}")
            continue  # there may be more waiting
        if once:
            return handled
        sleep(interval)
