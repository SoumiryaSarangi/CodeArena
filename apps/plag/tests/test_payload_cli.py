"""PL-02: the payload the API takes, posting it with the service token, and the command line."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from plag.cli import main
from plag.combine import DEFAULT
from plag.embed import TokenBagEmbedder
from plag.payload import PostError, post_results, to_payload
from plag.pipeline import Params, run_problem
from plag.stage_a import Submission

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"


class Api:
    """A local stand-in for the API: records requests, answers with scripted statuses."""

    def __init__(self, statuses: list[int]) -> None:
        self.statuses = statuses
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["Content-Length"]))
                outer.requests.append(
                    {"path": self.path, "auth": self.headers.get("Authorization"), "body": json.loads(body)}
                )
                code = outer.statuses[min(len(outer.requests) - 1, len(outer.statuses) - 1)]
                self.send_response(code)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self) -> "Api":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()


def two_copies() -> list[Submission]:
    src = (PROBLEMS / "stair-climb" / "solutions" / "main.cpp").read_text()
    other = (PROBLEMS / "maze-runner" / "solutions" / "main.cpp").read_text()
    return [
        Submission("11111111-1111-4111-8111-111111111111", "cpp17", src, "u1"),
        Submission("22222222-2222-4222-8222-222222222222", "cpp17", "// copy\n" + src, "u2"),
        Submission("33333333-3333-4333-8333-333333333333", "cpp17", other, "u3"),
    ]


def test_payload_matches_the_api_columns():
    r = run_problem("prob-1", two_copies(), embedder=TokenBagEmbedder())
    p = to_payload("run-1", [r], Params(), DEFAULT)
    assert p["runId"] == "run-1"
    prob = p["problems"][0]
    assert prob["problemId"] == "prob-1"
    assert set(prob["pairs"][0]) == {"subA", "subB", "fpScore", "embScore", "combined"}
    assert set(prob["clusters"][0]) == {"submissionIds", "maxScore"}
    assert prob["clusters"][0]["submissionIds"] == [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    ]
    assert p["params"]["combiner"]["threshold"] == DEFAULT.threshold and p["params"]["embed_on"] == "normalised"
    json.dumps(p)  # serialisable as it is


class TestPost:
    payload = {"runId": "r", "problems": []}

    def test_sends_json_with_the_bearer_token_to_the_run_results_path(self):
        with Api([200]) as api:
            assert post_results(api.url + "/", "r", "secret-token", self.payload) == 200
        req = api.requests[0]
        assert req["path"] == "/api/admin/plag/runs/r/results"
        assert req["auth"] == "Bearer secret-token"
        assert req["body"] == self.payload

    def test_a_server_error_is_retried_a_refusal_is_not(self):
        waits: list[float] = []
        with Api([503, 502, 200]) as api:
            assert post_results(api.url, "r", "t", self.payload, sleep=waits.append) == 200
        assert len(api.requests) == 3 and waits == [1.0, 2.0]
        with Api([403]) as api, pytest.raises(PostError, match="HTTP 403"):
            post_results(api.url, "r", "t", self.payload, sleep=waits.append)
        assert len(api.requests) == 1  # never retried

    def test_it_gives_up_after_the_attempts_and_says_why(self):
        with Api([500]) as api, pytest.raises(PostError, match="after 3 attempts: HTTP 500"):
            post_results(api.url, "r", "t", self.payload, sleep=lambda _: None)
        assert len(api.requests) == 3
        with pytest.raises(PostError, match="after 2 attempts"):  # nothing listens there
            post_results("http://127.0.0.1:9", "r", "t", self.payload, attempts=2, sleep=lambda _: None)


class TestCli:
    def write_input(self, tmp_path: Path) -> Path:
        data = {
            "runId": "run-9",
            "problems": [
                {
                    "problemId": "prob-1",
                    "submissions": [
                        {"id": s.id, "language": s.language, "source": s.source, "user": s.user} for s in two_copies()
                    ],
                }
            ],
        }
        f = tmp_path / "in.json"
        f.write_text(json.dumps(data))
        return f

    def test_run_writes_the_payload_and_summarises(self, tmp_path, capsys):
        out = tmp_path / "out.json"
        code = main(
            ["run", "--input", str(self.write_input(tmp_path)), "--out", str(out), "--model", "token-bag"],
            embedder=TokenBagEmbedder(),
        )
        assert code == 0
        result = json.loads(out.read_text())
        assert result["runId"] == "run-9" and len(result["problems"][0]["clusters"]) == 1
        assert "prob-1: 3 submissions" in capsys.readouterr().out

    def test_post_uses_the_token_from_the_environment_only(self, tmp_path, monkeypatch, capsys):
        args = ["run", "--input", str(self.write_input(tmp_path)), "--model", "token-bag"]
        monkeypatch.delenv("PLAG_SERVICE_TOKEN", raising=False)
        with Api([200]) as api:
            assert (
                main([*args, "--post", api.url], embedder=TokenBagEmbedder()) == 2
            )  # no token: refuses, sends nothing
            assert api.requests == []
            monkeypatch.setenv("PLAG_SERVICE_TOKEN", "tok-123")
            assert main([*args, "--post", api.url], embedder=TokenBagEmbedder()) == 0
        assert api.requests[0]["auth"] == "Bearer tok-123"
        assert api.requests[0]["path"] == "/api/admin/plag/runs/run-9/results"
        assert "tok-123" not in capsys.readouterr().out

    def test_a_refused_post_is_a_failure_exit(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PLAG_SERVICE_TOKEN", "t")
        with Api([401]) as api:
            code = main(
                ["run", "--input", str(self.write_input(tmp_path)), "--post", api.url],
                embedder=TokenBagEmbedder(),
            )
        assert code == 1
