"""PL-05: the job's loop against a stand-in API, and the payload against the API's own contract."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from plag.cli import main
from plag.embed import TokenBagEmbedder
from plag.payload import PostError, to_payload
from plag.pipeline import Params, run_problem
from plag.runner import Api, handle, params_from, serve
from plag.stage_a import Submission

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"
SCHEMAS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "generated" / "json-schema"

RUN = "11111111-1111-4111-8111-111111111111"
PROBLEM = "22222222-2222-4222-8222-222222222222"


def src(problem: str) -> str:
    return (PROBLEMS / problem / "solutions" / "main.cpp").read_text()


def ids(n: int) -> list[str]:
    return [f"00000000-0000-4000-8000-{i:012d}" for i in range(1, n + 1)]


def claim_body(params: dict[str, Any] | None = None) -> dict[str, Any]:
    a, b, c = ids(3)
    original = src("maze-runner")
    return {
        "runId": RUN,
        "params": params or {},
        "problems": [
            {
                "problemId": PROBLEM,
                "slug": "maze-runner",
                "templates": [],
                "submissions": [
                    {"id": a, "language": "cpp17", "source": original, "user": "u1"},
                    {
                        "id": b,
                        "language": "cpp17",
                        "source": "// copy\n" + original.replace("dist", "steps"),
                        "user": "u2",
                    },
                    {"id": c, "language": "cpp17", "source": src("stair-climb"), "user": "u3"},
                ],
            }
        ],
    }


class FakeApi:
    """Serves `claim` from a queue and records what the job posts."""

    def __init__(self, claims: list[dict[str, Any]], results_status: int = 200) -> None:
        self.claims = list(claims)
        self.results_status = results_status
        self.seen: list[dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                outer.seen.append(
                    {"path": self.path, "token": self.headers.get("X-Service-Token"), "auth": self.headers.get("Authorization"),
                     "body": json.loads(raw) if raw else None}
                )  # fmt: skip
                if self.path.endswith("/claim"):
                    if outer.claims:
                        body = json.dumps(outer.claims.pop(0)).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                    else:
                        self.send_response(204)
                        self.end_headers()
                    return
                code = outer.results_status if self.path.endswith("/results") else 204
                self.send_response(code)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def paths(self) -> list[str]:
        return [s["path"].replace("/api/admin/plag/runs/", "").replace(RUN, "{run}") for s in self.seen]


@pytest.fixture
def fake():
    made: list[FakeApi] = []

    def make(claims: list[dict[str, Any]], results_status: int = 200) -> FakeApi:
        f = FakeApi(claims, results_status)
        made.append(f)
        return f

    yield make
    for f in made:
        f.close()


def test_a_claimed_run_is_scored_and_the_results_are_posted_with_the_service_token(fake):
    api = fake([claim_body()])
    n = serve(Api(api.url, "tok"), TokenBagEmbedder(), once=True)
    assert n == 1
    assert api.paths() == ["claim", "{run}/results", "claim"]  # then it asks again and finds nothing
    # every request (claim, results) carries the service token and never an Authorization header
    assert all(s["token"] == "tok" and s["auth"] is None for s in api.seen)
    results = api.seen[1]
    problem = results["body"]["problems"][0]
    assert results["body"]["runId"] == RUN and problem["problemId"] == PROBLEM
    assert len(problem["clusters"]) == 1  # the disguised copy and its original
    assert set(problem["clusters"][0]["submissionIds"]) == set(ids(2))


def test_it_keeps_asking_while_there_is_work_and_waits_when_there_is_none(fake):
    second = claim_body() | {"runId": "33333333-3333-4333-8333-333333333333"}
    api = fake([claim_body(), second])
    waits: list[float] = []

    def stop_after_one_wait(seconds: float) -> None:
        waits.append(seconds)
        raise KeyboardInterrupt  # a real service is stopped from outside

    with pytest.raises(KeyboardInterrupt):
        serve(Api(api.url, "t"), TokenBagEmbedder(), interval=7.5, sleep=stop_after_one_wait)
    assert api.paths().count("claim") == 3  # two runs, then an empty poll
    assert [p for p in api.paths() if p.endswith("/results")] == [
        "{run}/results",
        "33333333-3333-4333-8333-333333333333/results",
    ]
    assert waits == [7.5]


def test_a_crash_while_scoring_is_reported_and_the_loop_goes_on(fake):
    bad = claim_body()
    bad["problems"][0]["submissions"][0]["language"] = "cpp17"

    class Exploding:
        name = "exploding"

        def embed(self, texts):  # noqa: ANN001, ANN201
            raise RuntimeError("the model would not load")

    api = fake([bad])
    n = serve(Api(api.url, "t"), Exploding(), once=True)  # type: ignore[arg-type]
    assert n == 1
    assert api.paths() == ["claim", "{run}/fail", "claim"]
    assert "RuntimeError: the model would not load" in api.seen[1]["body"]["error"]
    assert all(s["token"] == "t" and s["auth"] is None for s in api.seen)  # the failure report too


def test_a_refused_results_post_marks_the_run_failed_instead_of_leaving_it_running(fake):
    api = fake([claim_body()], results_status=400)
    assert handle(Api(api.url, "t"), claim_body(), TokenBagEmbedder()) is False
    assert [p for p in api.paths() if p.endswith("/fail")] == ["{run}/fail"]


def test_a_claim_that_cannot_reach_the_api_is_survivable():
    api = Api("http://127.0.0.1:9", "t")
    logs: list[str] = []
    assert serve(api, TokenBagEmbedder(), once=True, log=logs.append) == 0
    assert "claim failed" in logs[0]
    with pytest.raises(PostError):
        api.claim()


def test_the_run_parameters_an_admin_may_set_are_checked_and_the_rest_ignored():
    p = params_from({"sweep_cosine": 0.9, "neighbours": 5, "embed_on": "source", "stage_a_threshold": 1, "hack": "x"})
    assert (p.sweep_cosine, p.neighbours, p.embed_on, p.stage_a_threshold) == (0.9, 5, "source", 1.0)
    bad = params_from({"sweep_cosine": "high", "neighbours": 2.5, "embed_on": "rm -rf", "report_threshold": True})
    assert bad == Params()  # wrong types and values change nothing


def test_the_cli_serve_needs_the_token_and_handles_the_queue(fake, monkeypatch, capsys):
    api = fake([claim_body()])
    monkeypatch.delenv("PLAG_SERVICE_TOKEN", raising=False)
    assert main(["serve", "--api", api.url, "--once", "--model", "token-bag"]) == 2
    assert api.seen == []  # no token: it does not even ask
    monkeypatch.setenv("PLAG_SERVICE_TOKEN", "secret-tok-xyz")
    assert main(["serve", "--api", api.url, "--once", "--model", "token-bag"], embedder=TokenBagEmbedder()) == 0
    out = capsys.readouterr().out
    assert "1 run(s) handled" in out and "secret-tok-xyz" not in out


# ---- the payload against the API's own contract ---------------------------------------------------------


def conforms(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """A small JSON Schema check (objects, arrays, scalars, additionalProperties: false), enough for these contracts."""
    errors: list[str] = []
    t = schema.get("type")
    if t == "object":
        if not isinstance(value, dict):
            return [f"{path}: not an object"]
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in value:
                errors.append(f"{path}.{k}: missing")
        for k, v in value.items():
            if k in props:
                errors += conforms(v, props[k], f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{k}: not allowed")
    elif t == "array":
        if not isinstance(value, list):
            return [f"{path}: not an array"]
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: too short")
        for i, v in enumerate(value):
            errors += conforms(v, schema.get("items", {}), f"{path}[{i}]")
    elif t in ("number", "integer"):
        if not isinstance(value, (int, float)):
            return [f"{path}: not a number"]
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below the minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: above the maximum")
    elif t == "string" and not isinstance(value, str):
        errors.append(f"{path}: not a string")
    return errors


def test_the_payload_the_job_posts_is_what_the_apis_results_contract_accepts():
    schema = json.loads((SCHEMAS / "PlagResults.json").read_text())
    subs = [
        Submission(i, "cpp17", s, f"u{n}")
        for n, (i, s) in enumerate(
            zip(ids(3), [src("maze-runner"), "// c\n" + src("maze-runner"), src("stair-climb")], strict=True)
        )
    ]
    result = run_problem(PROBLEM, subs, embedder=TokenBagEmbedder())
    payload = to_payload(RUN, [result], Params(), __import__("plag.combine", fromlist=["DEFAULT"]).DEFAULT)
    assert payload["problems"][0]["pairs"] and payload["problems"][0]["clusters"]
    assert conforms(payload, schema) == []
    # and the checker really does reject a payload the API would
    bad = json.loads(json.dumps(payload))
    bad["problems"][0]["pairs"][0]["combined"] = 1.5
    bad["problems"][0]["pairs"][0]["surplus"] = 1
    del bad["runId"]
    errors = conforms(bad, schema)
    assert (
        any("combined" in e for e in errors)
        and any("surplus" in e for e in errors)
        and any("runId" in e for e in errors)
    )


def test_the_claim_the_api_sends_is_what_the_job_reads():
    schema = json.loads((SCHEMAS / "PlagClaim.json").read_text())
    assert conforms(claim_body({"k": 1}), schema) == []
    assert conforms({"runId": RUN, "params": {}}, schema) != []  # `problems` is required
