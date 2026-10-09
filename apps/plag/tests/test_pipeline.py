"""PL-02: the pipeline on real solutions with the cheap embedder, and the sweep with a scripted one."""

import re
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from plag.combine import Combiner
from plag.embed import TokenBagEmbedder, Vectors, normalise_rows
from plag.pipeline import Params, run_problem
from plag.stage_a import Submission, Template

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"


def mains() -> dict[str, str]:
    return {p.parent.parent.name: p.read_text() for p in sorted(PROBLEMS.glob("*/solutions/main.cpp"))}


def disguise(src: str) -> str:
    out = src
    for old, new in {
        "dist": "steps",
        "grid": "board",
        "total": "acc",
        "best": "top",
        "ans": "res",
        "cnt": "num",
    }.items():
        out = re.sub(rf"\b{old}\b", new, out)
    return "// my solution\n" + out.replace(
        "int main() {", "int unusedHelper(int q) { return q + 1; }\nint main() {", 1
    )


def pool_with_copy() -> list[Submission]:
    pool = mains()
    subs = [Submission(slug, "cpp17", src, user=slug) for slug, src in pool.items()]
    subs.append(Submission("copy", "cpp17", disguise(pool["maze-runner"]), user="copier"))
    return subs


class Scripted:
    """Embeddings chosen by submission order; records the texts it was given."""

    name = "scripted"

    def __init__(self, groups: dict[int, int]) -> None:
        self.groups = groups
        self.seen: list[str] = []

    def embed(self, texts: Sequence[str]) -> Vectors:
        self.seen = list(texts)
        out = np.zeros((len(texts), 8), dtype=np.float32)
        for i in range(len(texts)):
            out[i, self.groups.get(i, i) % 8] = 1.0  # same group number = identical vector, otherwise orthogonal
        return normalise_rows(out)


def test_a_disguised_copy_among_independent_solutions_is_the_one_cluster():
    r = run_problem("p", pool_with_copy(), embedder=TokenBagEmbedder())
    assert [c.ids for c in r.clusters] == [("copy", "maze-runner")]
    top = r.pairs[0]
    assert {top.a, top.b} == {"copy", "maze-runner"}
    assert top.fp_score >= 0.9 and top.emb_score > 0.8 and top.combined >= 0.5
    assert r.metrics["submissions"] == 21
    assert r.metrics["model"] == "token-bag"
    assert r.metrics["clusters"] == 1


def test_independent_solutions_produce_no_clusters():
    pool = mains()
    subs = [Submission(slug, "cpp17", src, user=slug) for slug, src in pool.items()]
    r = run_problem("p", subs, embedder=TokenBagEmbedder())
    assert r.clusters == []
    assert all(p.combined < 0.5 for p in r.pairs)


def test_the_sweep_adds_a_pair_stage_a_missed_but_the_embedding_alone_does_not_convict():
    a = Submission("a", "cpp17", "int main(){ int x = read(); print(x * x); }", "ua")
    b = Submission("b", "cpp17", "int solve(int q){ return q * q; } int main(){ print(solve(read())); }", "ub")
    c = Submission("c", "cpp17", "int main(){ for(;;) {} }", "uc")
    embedder = Scripted({0: 0, 1: 0, 2: 5})  # a and b look identical to the model, c does not
    r = run_problem("p", [a, b, c], embedder=embedder)
    assert r.metrics["sweepPairs"] == 1
    assert r.metrics["stageAPairs"] == 0
    pair = r.pairs[0]
    assert {pair.a, pair.b} == {"a", "b"} and pair.fp_score == 0.0 and pair.emb_score > 0.99
    assert r.clusters == []  # reported for review, not clustered: a cosine alone is not evidence enough
    # a combiner that trusts the embedding (what a fit might learn) does cluster it
    trusting = Combiner((1.0, 20.0, 0.0, 0.0), -15.0, 0.5)
    assert [
        c.ids for c in run_problem("p", [a, b, c], embedder=Scripted({0: 0, 1: 0, 2: 5}), combiner=trusting).clusters
    ] == [("a", "b")]


def test_the_sweep_never_pairs_a_person_with_themselves_or_across_language_families():
    same_user = [Submission("a", "cpp17", "int a;", "u"), Submission("b", "cpp17", "int b;", "u")]
    assert run_problem("p", same_user, embedder=Scripted({0: 0, 1: 0})).pairs == []
    other_family = [Submission("a", "cpp17", "int a;", "u1"), Submission("b", "python3", "a = 1", "u2")]
    assert run_problem("p", other_family, embedder=Scripted({0: 0, 1: 0})).pairs == []


def test_what_gets_embedded_is_a_parameter():
    subs = [Submission("a", "cpp17", "int  main( ) { return 0 ; } // hi", "u1")]
    norm = Scripted({})
    run_problem("p", subs, embedder=norm)
    assert norm.seen == ["int main ( ) { return N ; }"]
    raw = Scripted({})
    run_problem("p", subs, embedder=raw, params=Params(embed_on="source"))
    assert raw.seen == ["int  main( ) { return 0 ; } // hi"]


def test_the_report_threshold_and_templates_are_honoured():
    subs = pool_with_copy()
    quiet = run_problem("p", subs, embedder=TokenBagEmbedder(), params=Params(report_threshold=0.99))
    assert quiet.pairs == [] or all(p.combined >= 0.99 for p in quiet.pairs)
    template = Template("cpp17", mains()["maze-runner"])
    with_template = run_problem("p", subs, embedder=TokenBagEmbedder(), templates=[template])
    # the original IS the template: its fingerprints are ignored, so the pair loses its Stage A evidence
    assert (
        all(p.fp_score == 0.0 for p in with_template.pairs if {p.a, p.b} == {"copy", "maze-runner"})
        or not with_template.pairs
    )


def test_unsupported_languages_are_counted_not_fatal():
    subs = [Submission("a", "cpp17", "int a;", "u1"), Submission("x", "brainfuck", "+++", "u2")]
    assert run_problem("p", subs, embedder=Scripted({})).metrics["skipped"] == 1
