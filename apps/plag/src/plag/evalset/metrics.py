"""The numbers of the plagiarism eval: Stage A alone against A + B, with honest cross-validation (SD-§13.2).

The combined model is fitted leaving one problem out at a time and scored on the problem it never saw, so the
reported precision and recall are not the model grading its own training data.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass

from ..combine import Combiner, choose_threshold, fit
from ..stage_a import THRESHOLD
from .build import PairRow


def features(r: PairRow) -> tuple[float, float, float, float]:
    return (r.fp, r.emb, r.len_ratio, 1.0)  # every pool is one language


@dataclass(frozen=True)
class Prf:
    precision: float | None
    recall: float | None
    f1: float | None
    tp: int
    fp: int
    fn: int
    tn: int


def prf(flagged: Sequence[bool], labels: Sequence[bool]) -> Prf:
    tp = sum(1 for f, y in zip(flagged, labels, strict=True) if f and y)
    fp = sum(1 for f, y in zip(flagged, labels, strict=True) if f and not y)
    fn = sum(1 for f, y in zip(flagged, labels, strict=True) if not f and y)
    tn = len(labels) - tp - fp - fn
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = 2 * p * r / (p + r) if p and r else (0.0 if p is not None and r is not None else None)
    return Prf(p, r, f1, tp, fp, fn, tn)


def average_precision(scores: Sequence[float], labels: Sequence[bool]) -> float:
    """Average precision: the area under the precision-recall curve (1.0 = perfect, chance = share of positives)."""
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    positives = sum(labels)
    if positives == 0:
        return 0.0
    tp = 0
    total = 0.0
    for rank, i in enumerate(order, start=1):
        if labels[i]:
            tp += 1
            total += tp / rank
    return total / positives


@dataclass(frozen=True)
class Summary:
    pairs: int
    positives: int
    negatives: int
    average_precision: dict[str, float]
    at_design_threshold: Prf  # Stage A alone at the design's 0.35
    stage_a: Prf  # Stage A alone, threshold for precision >= 0.9 chosen on the training problems
    stage_ab: Prf  # A + B, same rule
    stage_b: Prf  # embedding alone, same rule
    recall_by_recipe: dict[str, dict[str, float | int]]
    hard_negatives: dict[str, float]
    chance: float


def cross_validate(rows: Sequence[PairRow], min_precision: float = 0.9) -> Summary:
    problems = sorted({r.problem for r in rows})
    held: list[tuple[PairRow, float, bool, bool, bool]] = []  # row, combined, A flag, AB flag, B flag
    for p in problems:
        train = [r for r in rows if r.problem != p]
        test = [r for r in rows if r.problem == p]
        if not test or len({r.label for r in train}) < 2:
            continue  # a model cannot be fitted without both kinds of pair
        labels = [r.label for r in train]
        comb = fit([features(r) for r in train], labels, min_precision)
        ta = choose_threshold([r.fp for r in train], labels, min_precision)
        tb = choose_threshold([r.emb for r in train], labels, min_precision)
        for r in test:
            c = comb.score(*features(r)[:3], True)
            held.append((r, c, r.fp >= ta, c >= comb.threshold, r.emb >= tb))
    labels = [h[0].label for h in held]
    ap = {
        "Stage A (fingerprints)": average_precision([h[0].fp for h in held], labels),
        "Stage B (embedding)": average_precision([h[0].emb for h in held], labels),
        "A + B (combined)": average_precision([h[1] for h in held], labels),
    }
    by: dict[str, list[tuple[bool, bool]]] = defaultdict(list)
    for r, _, fa, fab, _ in held:
        if r.kind == "original-variant":
            by[r.recipe].append((fa, fab))
    recall = {
        k: {"pairs": len(v), "stage_a": sum(a for a, _ in v) / len(v), "stage_ab": sum(b for _, b in v) / len(v)}
        for k, v in sorted(by.items())
    }
    ind = [r for r in rows if r.kind == "independent-independent"]
    hard = {
        "independent pairs": float(len(ind)),
        "fp mean": sum(r.fp for r in ind) / len(ind) if ind else 0.0,
        "fp max": max((r.fp for r in ind), default=0.0),
        "emb mean": sum(r.emb for r in ind) / len(ind) if ind else 0.0,
        "emb max": max((r.emb for r in ind), default=0.0),
    }
    return Summary(
        pairs=len(held),
        positives=sum(labels),
        negatives=len(labels) - sum(labels),
        average_precision=ap,
        at_design_threshold=prf([h[0].fp >= THRESHOLD for h in held], labels),
        stage_a=prf([h[2] for h in held], labels),
        stage_ab=prf([h[3] for h in held], labels),
        stage_b=prf([h[4] for h in held], labels),
        recall_by_recipe=recall,
        hard_negatives=hard,
        chance=sum(labels) / len(labels) if labels else 0.0,
    )


def fit_all(rows: Sequence[PairRow], min_precision: float = 0.9) -> Combiner:
    """The shipped combiner: fitted on every labelled pair, threshold for the precision target."""
    return fit([features(r) for r in rows], [r.label for r in rows], min_precision)
