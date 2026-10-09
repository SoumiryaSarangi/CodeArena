"""`python -m plag.evalset`: filter, build and report.

filter  --raw solutions.jsonl --out eval/independent.json     keep only the solutions that pass the problem's tests
build   --independent eval/independent.json --out eval/pairs.json [--model unixcoder|token-bag]
report  --pairs eval/pairs.json [--metrics docs/METRICS.md] [--write-combiner]
"""

from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path

from ..combine import Combiner
from ..embed import Embedder, TokenBagEmbedder, UniXcoderEmbedder
from . import build, metrics, report, validate

HERE = Path(__file__).resolve()
ROOT = HERE.parents[5]  # the repository
EVAL = HERE.parents[3] / "eval"
FITTED = HERE.parents[1] / "fitted_combiner.json"


def main(argv: list[str] | None = None, embedder: Embedder | None = None) -> int:
    ap = argparse.ArgumentParser(prog="plag.evalset")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("filter")
    f.add_argument("--raw", required=True, type=Path)
    f.add_argument("--out", type=Path, default=EVAL / "independent.json")
    f.add_argument("--problems", type=Path, default=ROOT / "problems")
    b = sub.add_parser("build")
    b.add_argument("--independent", type=Path, default=EVAL / "independent.json")
    b.add_argument("--out", type=Path, default=EVAL / "pairs.json")
    b.add_argument("--problems", type=Path, default=ROOT / "problems")
    b.add_argument("--model", choices=["unixcoder", "token-bag"], default="unixcoder")
    r = sub.add_parser("report")
    r.add_argument("--pairs", type=Path, default=EVAL / "pairs.json")
    r.add_argument("--metrics", type=Path, default=ROOT / "docs" / "METRICS.md")
    r.add_argument("--model", default="microsoft/unixcoder-base")
    r.add_argument("--write-combiner", action="store_true")
    r.add_argument("--date", default=datetime.date.today().isoformat())
    args = ap.parse_args(argv)

    if args.cmd == "filter":
        kept: list[dict[str, str]] = []
        dropped: dict[str, int] = {}
        for line in args.raw.read_text().splitlines():
            if not line.strip():
                continue
            s = json.loads(line)
            v = validate.check(args.problems / s["slug"], s["language"], s["source"])
            if v.ok:
                kept.append(s)
            else:
                dropped[v.reason] = dropped.get(v.reason, 0) + 1
        args.out.write_text(json.dumps(kept, indent=1))
        print(f"kept {len(kept)}; dropped {sum(dropped.values())}: {dropped}")
        return 0
    if args.cmd == "build":
        independents = json.loads(args.independent.read_text())
        model: Embedder = embedder or (UniXcoderEmbedder() if args.model == "unixcoder" else TokenBagEmbedder())
        rows = build.build_rows(args.problems, independents, model)
        args.out.write_text(json.dumps(build.to_json(rows), indent=None))
        print(f"{len(rows)} pairs, {sum(r.label for r in rows)} positive")
        return 0
    rows = build.from_json(json.loads(args.pairs.read_text()))
    summary = metrics.cross_validate(rows)
    combiner = metrics.fit_all(rows)
    block = report.render(summary, rows, combiner, args.model, args.date)
    md = args.metrics.read_text() if args.metrics.exists() else "# Metrics\n"
    args.metrics.write_text(report.upsert(md, block))
    if args.write_combiner:
        FITTED.write_text(combiner.to_json() + "\n")
        print(f"wrote {FITTED}")
    print(f"updated {args.metrics}")
    return 0


def load_fitted() -> Combiner | None:
    return Combiner.from_json(FITTED.read_text()) if FITTED.exists() else None
