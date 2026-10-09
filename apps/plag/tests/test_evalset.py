"""PL-03: the labelled evaluation set: the obfuscations, the labels, the metrics, the report."""

import json
from pathlib import Path

import pytest

from plag.embed import TokenBagEmbedder
from plag.evalset import build, metrics, report, validate
from plag.evalset.cli import main as evalset_main
from plag.evalset.transforms import RECIPES, apply, dead_code, extract_helper, loop_rewrite, noise, rename, reorder
from plag.normalise import normalise
from plag.stage_a import fingerprint_set

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"

CPP = """#include <cstdio>
#include <vector>
int total;
int limit;
static int twice(int x) { return x * 2; }
int sum_to(int n) {
    int s = 0;
    for (int i = 0; i < n; i++) { s += twice(i); }
    return s;
}
int main() {
    int n, m;
    scanf("%d %d", &n, &m);
    printf("%d\\n", sum_to(n) + m);
    return 0;
}
"""

PY = """import sys
count = 0
limit = 10
def twice(x):
    return x * 2
def run(n):
    s = 0
    for i in range(n):
        s += twice(i)
    return s
n = int(input())
print(run(n))
"""


def toks(src: str, lang: str) -> tuple[str, ...]:
    return normalise(src, lang).tokens


class TestTransforms:
    def test_rename_changes_the_text_but_not_the_normalised_program(self):
        for src, lang in ((CPP, "cpp17"), (PY, "python3")):
            out = rename(src, lang, 3)
            assert out is not None and out != src
            assert "sum_to" not in out and "total" not in out and "twice" not in out
            assert toks(out, lang) == toks(src, lang)
        out = rename(CPP, "cpp17", 3)
        assert out is not None and "scanf" in out and "printf" in out and "main" in out  # the library and main stay

    def test_rename_is_consistent_and_seeded(self):
        a, b = rename(CPP, "cpp17", 1), rename(CPP, "cpp17", 1)
        assert a == b and a != rename(CPP, "cpp17", 2)

    def test_reorder_swaps_independent_neighbours_and_never_reads(self):
        out = reorder(CPP, "cpp17", 1)
        assert out is not None and out != CPP
        assert toks(out, "cpp17") == toks(
            CPP, "cpp17"
        )  # top-level definitions and declarations: canonical order anyway
        reads = "int main() { int a; int b; cin >> a; cin >> b; return a - b; }"
        swapped = reorder(reads, "cpp17", 1)
        assert swapped is None or swapped.index("cin >> a") < swapped.index("cin >> b")  # reads keep their order
        py = reorder("a = 1\nb = 2\nprint(a + b)\n", "python3", 1)
        assert py is not None and py.startswith("b = 2")
        assert reorder("a = 1\nb = a + 1\nprint(b)\n", "python3", 1) is None  # b depends on a

    def test_dead_code_adds_tokens_and_breaks_up_the_fingerprint_runs(self):
        for src, lang in ((CPP, "cpp17"), (PY, "python3")):
            out = dead_code(src, lang, 4)
            assert out is not None and "unused" in out
            assert len(toks(out, lang)) > len(toks(src, lang))
            a, b = fingerprint_set(src, lang), fingerprint_set(out, lang)
            # the attack bites: snippets inside the functions cut the shared runs, so Stage A sees far less of the original
            assert sum(1 for h in a if h in b) / len(a) < 0.9

    def test_loops_become_while_loops(self):
        out = loop_rewrite(CPP, "cpp17")
        assert out is not None and "for (" not in out and "while (i < n)" in out
        py = loop_rewrite(PY, "python3")
        assert py is not None and "for i in range" not in py and "while i < n:" in py and "i += 1" in py
        assert loop_rewrite("int main(){ return 0; }", "cpp17") is None
        # a loop with `continue` would change meaning when rewritten: left alone
        assert loop_rewrite("for i in range(n):\n    if i:\n        continue\n    print(i)\n", "python3") is None

    def test_helper_extraction(self):
        out = extract_helper(CPP, "cpp17")
        assert out is not None and "int solve_it()" in out and "return solve_it();" in out
        py = extract_helper(PY, "python3")
        assert py is not None and "def solve_it():" in py and py.rstrip().endswith("solve_it()")
        assert extract_helper("def f():\n    return 1\n", "python3") is None  # no script to wrap

    def test_noise_changes_the_text_only(self):
        for src, lang in ((CPP, "cpp17"), (PY, "python3")):
            out = noise(src, lang, 5)
            assert out is not None and out != src
            assert toks(out, lang) == toks(src, lang)

    def test_recipes_apply_what_they_can_and_say_what_they_did(self):
        out = apply(PY, "python3", ("rename", "helper", "noise"), 1)
        assert out is not None and out[1] == ("rename", "helper", "noise")
        partial = apply("print(1)\n", "python3", ("loop", "noise"), 1)
        assert partial is not None and partial[1] == ("noise",)  # no loop to rewrite: the rest still happens
        assert apply("print(1)\n", "python3", ("loop",), 1) is None
        assert apply(CPP, "cpp17", ("rename", "dead"), 9) == apply(CPP, "cpp17", ("rename", "dead"), 9)

    @pytest.mark.parametrize(("lang", "name"), [("cpp17", "main.cpp"), ("python3", "alt.py")])
    def test_the_core_obfuscations_apply_to_every_reference_solution(self, lang, name):
        sols = sorted(PROBLEMS.glob(f"*/solutions/{name}"))
        assert len(sols) >= 20
        for step, floor in (("rename", 1.0), ("dead", 1.0), ("helper", 1.0), ("noise", 1.0), ("reorder", 0.4)):
            applied = sum(apply(p.read_text(), lang, (step,), 1) is not None for p in sols)
            assert applied / len(sols) >= floor, (lang, step, applied)
        assert len(RECIPES) == 11


class TestLabelsAndPairs:
    def pool(self):
        original = (PROBLEMS / "maze-runner" / "solutions" / "main.cpp").read_text()
        independents = [
            (PROBLEMS / p / "solutions" / "main.cpp").read_text()
            for p in ("stair-climb", "rainfall-totals", "hop-distances", "room-booking")
        ]
        return build.build_pool("maze-runner", "cpp17", original, independents)

    def test_a_pool_has_the_original_its_copies_and_the_independents(self):
        docs = self.pool()
        kinds = [d.kind for d in docs]
        assert kinds[0] == "original" and kinds.count("independent") == 4 and kinds.count("variant") >= 8
        assert len({d.source for d in docs}) == len(docs)  # no duplicate programs
        assert all(d.recipe for d in docs if d.kind == "variant")

    def test_labels_copies_with_copies_and_everything_with_an_independent_as_not(self):
        docs = self.pool()
        rows = build.pair_rows(docs, TokenBagEmbedder())
        n = len(docs)
        assert len(rows) == n * (n - 1) // 2
        kinds = {r.kind for r in rows}
        assert kinds == {
            "original-variant", "variant-variant", "independent-original", "independent-variant", "independent-independent",
        }  # fmt: skip
        for r in rows:
            assert r.label == ("independent" not in r.kind)
        assert sum(r.label for r in rows) > 20 and sum(not r.label for r in rows) > 20

    def test_copies_score_far_above_independent_work_even_on_the_cheap_embedder(self):
        rows = build.pair_rows(self.pool(), TokenBagEmbedder())
        pos = [r.fp for r in rows if r.kind == "original-variant" and r.recipe in ("rename", "noise", "rename+noise")]
        neg = [r.fp for r in rows if r.kind == "independent-independent"]
        assert min(pos) > 0.9 and max(neg) < 0.35

    def test_the_json_round_trip_keeps_every_field(self):
        rows = build.pair_rows(self.pool()[:4], TokenBagEmbedder())
        assert build.from_json(json.loads(json.dumps(build.to_json(rows)))) == rows


def synthetic(problems: int = 6) -> list[build.PairRow]:
    """Separable pairs: copies have high fingerprint overlap and a close embedding, independent work does not."""
    rows = []
    for p in range(problems):
        for i in range(12):
            rows.append(
                build.PairRow(
                    f"p{p}",
                    "cpp17",
                    f"a{i}",
                    f"b{i}",
                    "original-variant",
                    "rename",
                    0.7 + 0.02 * i,
                    0.9 + 0.005 * i,
                    0.9,
                    True,
                )
            )
            rows.append(
                build.PairRow(
                    f"p{p}",
                    "cpp17",
                    f"c{i}",
                    f"d{i}",
                    "independent-independent",
                    "",
                    0.02 * i,
                    0.55 + 0.02 * i,
                    0.8,
                    False,
                )
            )
    return rows


class TestMetrics:
    def test_prf_and_average_precision(self):
        p = metrics.prf([True, True, False, False], [True, False, True, False])
        assert (p.tp, p.fp, p.fn, p.tn) == (1, 1, 1, 1) and p.precision == 0.5 and p.recall == 0.5 and p.f1 == 0.5
        assert metrics.prf([False], [False]).precision is None
        assert metrics.average_precision([0.9, 0.8, 0.1], [True, True, False]) == 1.0
        assert metrics.average_precision([0.1, 0.8, 0.9], [True, False, False]) == pytest.approx(1 / 3)
        assert metrics.average_precision([0.5], [False]) == 0.0

    def test_cross_validation_holds_each_problem_out(self):
        rows = synthetic()
        s = metrics.cross_validate(rows)
        assert s.pairs == len(rows) and s.positives == s.negatives == len(rows) // 2
        assert s.average_precision["A + B (combined)"] > 0.99
        assert (
            s.stage_ab.precision is not None
            and s.stage_ab.precision >= 0.9
            and s.stage_ab.recall is not None
            and s.stage_ab.recall > 0.9
        )
        assert s.chance == 0.5
        assert s.recall_by_recipe["rename"]["pairs"] == len(rows) // 2

    def test_a_signal_that_only_one_stage_has_shows_up_as_a_difference(self):
        # the fingerprints are blind to these copies (a rewrite) but the embedding is not
        rows = []
        for p in range(6):
            for i in range(10):
                rows.append(
                    build.PairRow(
                        f"p{p}",
                        "cpp17",
                        "a",
                        "b",
                        "original-variant",
                        "rename",
                        0.05 + 0.01 * i,
                        0.93 + 0.005 * i,
                        0.9,
                        True,
                    )
                )
                rows.append(
                    build.PairRow(
                        f"p{p}",
                        "cpp17",
                        "c",
                        "d",
                        "independent-independent",
                        "",
                        0.05 + 0.01 * i,
                        0.5 + 0.02 * i,
                        0.9,
                        False,
                    )
                )
        s = metrics.cross_validate(rows)
        assert s.average_precision["A + B (combined)"] > s.average_precision["Stage A (fingerprints)"] + 0.2
        assert s.at_design_threshold.recall == 0.0  # 0.35 finds nothing here

    def test_hard_negative_summary_and_the_shipped_fit(self):
        s = metrics.cross_validate(synthetic())
        assert s.hard_negatives["independent pairs"] == 72 and s.hard_negatives["fp max"] == pytest.approx(0.22)
        c = metrics.fit_all(synthetic())
        assert c.weights[0] > 0 and c.weights[1] > 0 and 0.0 < c.threshold <= 1.0
        assert c.score(0.9, 0.95, 0.9, True) >= c.threshold > c.score(0.05, 0.6, 0.8, True)


class TestReport:
    def test_block_has_the_tables_and_replaces_itself(self, tmp_path):
        rows = synthetic()
        s = metrics.cross_validate(rows)
        c = metrics.fit_all(rows)
        block = report.render(s, rows, c, "test-model", "2026-10-09")
        for needle in (
            "Stage A at the design threshold",
            "A + B combined",
            "Stage B alone",
            "Average precision",
            "Recall by what the copier did",
            "hard negatives",
        ):
            assert needle in block
        assert "held-out problems" in block
        md = "# Metrics\n\n## Load test (O-03)\n\nx\n"
        once = report.upsert(md, block)
        assert report.HEADING in once and "## Load test (O-03)\n\nx" in once
        assert report.upsert(once, block) == once  # idempotent
        newer = report.upsert(once, block.replace("test-model", "other-model"))
        assert "other-model" in newer and "test-model" not in newer and newer.count(report.OPEN) == 1


class TestValidateAndCli:
    def test_only_programs_that_solve_the_problem_pass(self):
        d = PROBLEMS / "sum-two-numbers"
        assert validate.check(d, "python3", (d / "solutions" / "alt.py").read_text()).ok
        assert validate.check(d, "cpp17", (d / "solutions" / "main.cpp").read_text()).ok
        assert "wrong answer" in validate.check(d, "python3", "print(0)").reason
        assert validate.check(d, "cpp17", "int main( {").reason == "does not compile"
        assert "crashes" in validate.check(d, "python3", "raise SystemExit(3)").reason
        assert "too slow" in validate.check(d, "python3", "while True: pass", timeout=1).reason
        assert not validate.check(d, "cpp17", (d / "solutions" / "wa-int32.cpp").read_text()).ok

    def test_filter_keeps_only_solutions_that_pass(self, tmp_path, capsys):
        d = PROBLEMS / "sum-two-numbers"
        raw = tmp_path / "raw.jsonl"
        good = (d / "solutions" / "main.cpp").read_text()
        raw.write_text(
            json.dumps({"slug": "sum-two-numbers", "language": "cpp17", "persona": 0, "source": good})
            + "\n"
            + json.dumps({"slug": "sum-two-numbers", "language": "cpp17", "persona": 1, "source": "int main( {"})
            + "\n"
        )
        out = tmp_path / "ind.json"
        assert evalset_main(["filter", "--raw", str(raw), "--out", str(out)]) == 0
        assert len(json.loads(out.read_text())) == 1 and "does not compile" in capsys.readouterr().out

    def test_build_and_report_end_to_end(self, tmp_path):
        # independent solutions for three problems (any programs will do to exercise the pipeline)
        ind = tmp_path / "ind.json"
        pool = [
            PROBLEMS / p / "solutions" / "main.cpp"
            for p in ("stair-climb", "rainfall-totals", "hop-distances", "room-booking")
        ]
        ind.write_text(
            json.dumps(
                [
                    {"slug": slug, "language": "cpp17", "persona": i, "source": src.read_text()}
                    for slug in ("maze-runner", "fractional-loot", "sum-two-numbers")
                    for i, src in enumerate(pool)
                ]
            )
        )
        pairs = tmp_path / "pairs.json"
        assert (
            evalset_main(
                ["build", "--independent", str(ind), "--out", str(pairs), "--model", "token-bag"],
                embedder=TokenBagEmbedder(),
            )
            == 0
        )
        rows = json.loads(pairs.read_text())
        assert any(r["label"] for r in rows) and any(not r["label"] for r in rows)
        md = tmp_path / "METRICS.md"
        assert evalset_main(["report", "--pairs", str(pairs), "--metrics", str(md), "--model", "token-bag"]) == 0
        text = md.read_text()
        assert report.HEADING in text and "A + B combined" in text
