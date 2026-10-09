"""The result a plag run sends to the API (`POST /api/admin/plag/runs/{id}/results`, SRS §3.1.2).

The shape matches the `plag_pairs` and `plag_clusters` columns (SD-§6): per problem, the reported pairs with their
Stage A, Stage B and combined scores, and the clusters with their members and strongest score.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from typing import Any

from .combine import Combiner
from .pipeline import Params, ProblemResult, params_json


class PostError(RuntimeError):
    pass


def to_payload(
    run_id: str,
    results: Sequence[ProblemResult],
    params: Params,
    combiner: Combiner,
) -> dict[str, Any]:
    return {
        "runId": run_id,
        "params": params_json(params, combiner),
        "problems": [
            {
                "problemId": r.problem_id,
                "pairs": [
                    {
                        "subA": p.a,
                        "subB": p.b,
                        "fpScore": round(p.fp_score, 6),
                        "embScore": round(p.emb_score, 6),
                        "combined": round(p.combined, 6),
                    }
                    for p in r.pairs
                ],
                "clusters": [{"submissionIds": list(c.ids), "maxScore": round(c.max_score, 6)} for c in r.clusters],
                "metrics": r.metrics,
            }
            for r in results
        ],
    }


def post_results(
    base_url: str,
    run_id: str,
    token: str,
    payload: dict[str, Any],
    *,
    attempts: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """POSTs the payload with the service token in `X-Service-Token`; retries network errors and 5xx, never a 4xx."""
    url = f"{base_url.rstrip('/')}/api/admin/plag/runs/{run_id}/results"
    body = json.dumps(payload).encode()
    last = "no attempt"
    for attempt in range(attempts):
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "X-Service-Token": token},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (the API address is configuration)
                return int(resp.status)
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise PostError(f"the API refused the results: HTTP {e.code}") from e
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = str(e)
        if attempt + 1 < attempts:
            sleep(2.0**attempt)
    raise PostError(f"could not post the results after {attempts} attempts: {last}")
