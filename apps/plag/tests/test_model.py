"""PL-02: the real UniXcoder model. Skipped unless PLAG_MODEL=1 (it downloads about 500 MB the first time)."""

import os
import re
from pathlib import Path

import pytest

from plag.embed import UniXcoderEmbedder, cosine_matrix
from plag.pipeline import run_problem
from plag.stage_a import Submission

pytestmark = pytest.mark.skipif(not os.environ.get("PLAG_MODEL"), reason="set PLAG_MODEL=1 to run with the real model")

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"


def mains() -> dict[str, str]:
    return {p.parent.parent.name: p.read_text() for p in sorted(PROBLEMS.glob("*/solutions/main.cpp"))}


def test_vectors_are_768_dimensional_unit_length_and_deterministic():
    e = UniXcoderEmbedder()
    v = e.embed(["int main() { return 0; }", "def f(x):\n    return x + 1\n"])
    assert v.shape == (2, 768)
    assert abs(float((v[0] * v[0]).sum()) - 1.0) < 1e-4
    assert (e.embed(["int main() { return 0; }"])[0] == v[0]).all() or abs(
        float(e.embed(["int main() { return 0; }"])[0] @ v[0]) - 1
    ) < 1e-5


def test_a_long_file_is_chunked_and_still_one_normalised_vector():
    e = UniXcoderEmbedder()
    long_src = "int main() {\n" + "".join(f"    total += value{i} * {i};\n" for i in range(600)) + "}\n"
    e.embed(["warm"])  # loads the tokenizer
    assert len(e._chunks(long_src)) >= 2
    assert all(len(c) <= 512 for c in e._chunks(long_src))
    v = e.embed([long_src, long_src[:200]])
    assert v.shape == (2, 768)
    assert abs(float((v[0] * v[0]).sum()) - 1.0) < 1e-4


def test_a_disguised_copy_is_nearer_than_unrelated_solutions_and_the_pipeline_clusters_it():
    pool = mains()
    original = pool["maze-runner"]
    copy = re.sub(r"\bdist\b", "steps", original).replace(
        "int main() {", "int helper(int q) { return q + 1; }\nint main() {", 1
    )
    e = UniXcoderEmbedder()
    names = list(pool)
    v = e.embed([pool[n] for n in names] + [copy])
    cos = cosine_matrix(v)
    i = names.index("maze-runner")
    unrelated = [float(cos[i, j]) for j in range(len(names)) if j != i]
    assert float(cos[i, len(names)]) > sum(unrelated) / len(unrelated)
    subs = [Submission(n, "cpp17", pool[n], n) for n in names] + [Submission("copy", "cpp17", copy, "copier")]
    r = run_problem("p", subs, embedder=e)
    assert [c.ids for c in r.clusters] == [("copy", "maze-runner")]
    assert r.metrics["model"] == "microsoft/unixcoder-base"
