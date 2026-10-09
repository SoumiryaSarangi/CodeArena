"""`python -m plag run --input submissions.json`: score the final submissions of one or more problems.

The input is what the API's fetch endpoint will give the job (SD-§13.1 step 1):

    {"runId": "...",
     "problems": [{"problemId": "...",
                   "templates": [{"language": "cpp17", "source": "..."}],
                   "submissions": [{"id": "...", "language": "cpp17", "source": "...", "user": "..."}]}]}

The output is the payload the API takes (see `payload.py`); `--post` sends it with the service token read from the
environment variable named by `--token-env`, never from the command line.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .combine import DEFAULT, Combiner
from .embed import Embedder, TokenBagEmbedder, UniXcoderEmbedder
from .payload import PostError, post_results, to_payload
from .pipeline import Params, run_problem
from .runner import Api, serve
from .stage_a import Submission, Template


def load_problems(data: dict[str, object]) -> list[tuple[str, list[Submission], list[Template]]]:
    out = []
    problems = data["problems"]
    assert isinstance(problems, list)
    for p in problems:
        subs = [Submission(s["id"], s["language"], s["source"], s.get("user")) for s in p["submissions"]]
        tpls = [Template(t["language"], t["source"]) for t in p.get("templates", [])]
        out.append((p["problemId"], subs, tpls))
    return out


def main(argv: list[str] | None = None, embedder: Embedder | None = None) -> int:
    ap = argparse.ArgumentParser(prog="plag")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="score the final submissions of a contest's problems")
    run.add_argument("--input", required=True, type=Path)
    run.add_argument("--out", type=Path)
    run.add_argument("--model", choices=["unixcoder", "token-bag"], default="unixcoder")
    run.add_argument("--combiner", type=Path, help="weights from the labelled-set fit (JSON); default: hand-set")
    run.add_argument("--post", metavar="API_URL", help="send the result to the API")
    run.add_argument("--token-env", default="PLAG_SERVICE_TOKEN", help="environment variable holding the token")
    serve_p = sub.add_parser("serve", help="poll the API for plagiarism runs and score them")
    serve_p.add_argument("--api", required=True, metavar="API_URL")
    serve_p.add_argument("--interval", type=float, default=15.0)
    serve_p.add_argument("--once", action="store_true", help="stop after the first empty poll")
    serve_p.add_argument("--model", choices=["unixcoder", "token-bag"], default="unixcoder")
    serve_p.add_argument("--combiner", type=Path)
    serve_p.add_argument("--token-env", default="PLAG_SERVICE_TOKEN")
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        token = os.environ.get(args.token_env)
        if not token:
            print(f"set {args.token_env} to the service token", file=sys.stderr)
            return 2
        comb = Combiner.from_json(args.combiner.read_text()) if args.combiner else DEFAULT
        mdl: Embedder = embedder or (UniXcoderEmbedder() if args.model == "unixcoder" else TokenBagEmbedder())
        n = serve(
            Api(args.api, token), mdl, comb, interval=args.interval, once=args.once, log=lambda m: print(m, flush=True)
        )
        print(f"{n} run(s) handled")
        return 0

    data = json.loads(args.input.read_text())
    run_id = str(data.get("runId", "local"))
    combiner = Combiner.from_json(args.combiner.read_text()) if args.combiner else DEFAULT
    model: Embedder = embedder or (UniXcoderEmbedder() if args.model == "unixcoder" else TokenBagEmbedder())
    params = Params()
    results = [
        run_problem(pid, subs, embedder=model, combiner=combiner, templates=tpls, params=params)
        for pid, subs, tpls in load_problems(data)
    ]
    payload = to_payload(run_id, results, params, combiner)
    if args.out:
        args.out.write_text(json.dumps(payload, indent=2))
    if args.post:
        token = os.environ.get(args.token_env)
        if not token:
            print(f"set {args.token_env} to the service token", file=sys.stderr)
            return 2
        try:
            post_results(args.post, run_id, token, payload)
        except PostError as e:
            print(str(e), file=sys.stderr)
            return 1
    for r in results:
        m = r.metrics
        print(f"{r.problem_id}: {m['submissions']} submissions, {m['reportedPairs']} pairs, {m['clusters']} clusters")
    return 0
