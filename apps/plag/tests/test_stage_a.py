"""PL-01: stage A on the real reference solutions: copies are found, independent solutions are not."""

import re
from pathlib import Path

from plag.stage_a import (
    Submission,
    Template,
    boilerplate_hashes,
    fingerprint_set,
    stage_a,
)

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"


def solution(problem: str, name: str) -> str:
    return (PROBLEMS / problem / "solutions" / name).read_text()


def all_main_cpp() -> dict[str, str]:
    return {p.parent.parent.name: p.read_text() for p in sorted(PROBLEMS.glob("*/solutions/main.cpp"))}


def pair_score(result, a: str, b: str) -> float:
    for p in result.pairs:
        if {p.a, p.b} == {a, b}:
            return p.score
    return 0.0


def disguise(src: str) -> str:
    """What a copier does: rename every variable, add noise, reformat, add dead code."""
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
    out = "// my solution\n" + out.replace("int main() {", "int unusedHelper(int q) { return q + 1; }\nint main() {", 1)
    return re.sub(r"\n\s*\n", "\n", out) + "\n/* end */\n"


def test_a_disguised_copy_is_a_candidate_with_high_containment():
    pool = all_main_cpp()
    subs = [Submission(slug, "cpp17", src, user=slug) for slug, src in pool.items()]
    subs.append(Submission("copy-of-maze", "cpp17", disguise(pool["maze-runner"]), user="copier"))
    result = stage_a(subs)
    assert pair_score(result, "maze-runner", "copy-of-maze") >= 0.9
    # and it is the top pair
    assert {result.pairs[0].a, result.pairs[0].b} == {"maze-runner", "copy-of-maze"}


def test_independent_solutions_to_different_problems_are_not_candidates():
    pool = all_main_cpp()
    subs = [Submission(slug, "cpp17", src, user=slug) for slug, src in pool.items()]
    result = stage_a(subs)
    assert len(pool) >= 15
    assert [p for p in result.pairs if p.score >= 0.35] == [] or all(p.score < 0.6 for p in result.pairs)
    # at most one pair of genuinely similar problems (sort-and-sweep) may reach the threshold
    assert len(result.pairs) <= 2


def test_boilerplate_common_to_more_than_30_percent_is_ignored():
    shared = 'int main() { int n; scanf("%d", &n); ' + "for (int i = 0; i < n; i++) { s += i * i; } " * 3
    bodies = [f"{shared} while (n > 0) {{ n /= {k + 2}; t += n; }} x = y + {k}; return 0; }}" for k in range(6)]
    subs = [Submission(f"s{k}", "cpp17", b, user=f"u{k}") for k, b in enumerate(bodies)]
    with_removal = stage_a(subs)
    without = stage_a(subs, boilerplate_ratio=2.0)  # nothing can exceed 200 %: no removal
    assert with_removal.boilerplate  # the shared block was found
    assert max((p.score for p in with_removal.pairs), default=0) < max(p.score for p in without.pairs)
    assert without.pairs  # without the removal everyone looks alike


def test_boilerplate_needs_enough_submissions_and_more_than_30_percent():
    one = {1: 0, 2: 1}
    # fewer than 5 submissions: three identical ones could just be a copy, not boilerplate
    assert boilerplate_hashes([one, one, one]) == frozenset()
    # five identical: everything is common
    assert boilerplate_hashes([one] * 5) == frozenset({1, 2})
    # 2 of 7 = 28.6 %: not more than 30 %
    two_of_seven = [{1: 0}, {1: 0}, {2: 0}, {3: 0}, {4: 0}, {5: 0}, {6: 0}]
    assert boilerplate_hashes(two_of_seven) == frozenset()
    # 3 of 7 = 42.9 %: boilerplate
    three_of_seven = [{1: 0}, {1: 0}, {1: 0}, {2: 0}, {3: 0}, {4: 0}, {5: 0}]
    assert boilerplate_hashes(three_of_seven) == frozenset({1})


def test_the_setters_template_is_never_evidence():
    template = '#include <cstdio>\nint main() { int n, m; scanf("%d %d", &n, &m); for (int i = 0; i < n; i++) { for (int j = 0; j < m; j++) { grid[i][j] = 0; } } return 0; }'
    a = template + "\nint solveA() { long long t = 0; for (int i = 0; i < 99; i++) t += i * 3; return (int) t; }"
    b = template + "\nint solveB() { while (x > 1) { x = x % 2 ? 3 * x + 1 : x / 2; steps++; } return steps; }"
    plain = stage_a([Submission("a", "cpp17", a, "ua"), Submission("b", "cpp17", b, "ub")])
    with_template = stage_a(
        [Submission("a", "cpp17", a, "ua"), Submission("b", "cpp17", b, "ub")],
        templates=[Template("cpp17", template)],
    )
    assert pair_score(plain, "a", "b") > pair_score(with_template, "a", "b")
    assert pair_score(with_template, "a", "b") < 0.35


def test_one_person_is_not_compared_with_themselves_and_languages_are_not_mixed():
    src = solution("stair-climb", "main.cpp")
    result = stage_a(
        [
            Submission("1", "cpp17", src, user="same"),
            Submission("2", "cpp17", disguise(src), user="same"),
            Submission("3", "python3", solution("stair-climb", "alt.py"), user="other"),
            Submission("4", "cpp20", src, user="third"),  # cpp17 and cpp20 are one family
        ]
    )
    pairs = {frozenset((p.a, p.b)) for p in result.pairs}
    assert frozenset(("1", "2")) not in pairs
    assert frozenset(("1", "4")) in pairs and frozenset(("2", "4")) in pairs
    assert not any("3" in p for p in pairs)


def test_unsupported_languages_are_reported_not_fatal_and_pairs_are_sorted_by_score():
    src = solution("rainfall-totals", "main.cpp")
    result = stage_a(
        [
            Submission("a", "cpp17", src, "ua"),
            Submission("b", "cpp17", disguise(src), "ub"),
            Submission("c", "cpp17", src.replace("+=", "+= 0 +"), "uc"),
            Submission("weird", "brainfuck", "+++[>+<-]", "uw"),
        ]
    )
    assert "weird" in result.skipped
    scores = [p.score for p in result.pairs]
    assert scores == sorted(scores, reverse=True)
    assert len(scores) >= 2


def test_fingerprint_sets_are_stable():
    src = solution("maze-runner", "main.cpp")
    assert fingerprint_set(src, "cpp17") == fingerprint_set(src, "cpp17")
    assert len(fingerprint_set(src, "cpp17")) > 10
