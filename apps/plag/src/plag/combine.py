"""Combining Stage A and Stage B into one score (SD-§13.1 step 6).

A logistic model over four features. Until the labelled set (PL-03) has fitted one, `DEFAULT` holds weights chosen by
hand so the pipeline works: a high embedding cosine alone is suspicious but not enough, shared fingerprints alone
are strong, both together are decisive. `fit` trains on labelled pairs and `choose_threshold` picks the decision
threshold for a precision target (0.9 in the design).
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass

import numpy as np

FEATURES = ("fp", "emb", "len_ratio", "same_language")


@dataclass(frozen=True)
class Combiner:
    #: One weight per feature, in `FEATURES` order.
    weights: tuple[float, float, float, float]
    bias: float
    #: Pairs at or above this combined score are "high confidence": they form clusters.
    threshold: float

    def score(self, fp: float, emb: float, len_ratio: float, same_language: bool) -> float:
        x = (fp, emb, len_ratio, 1.0 if same_language else 0.0)
        z = self.bias + sum(w * v for w, v in zip(self.weights, x, strict=True))
        return 1.0 / (1.0 + math.exp(-z))

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @staticmethod
    def from_json(text: str) -> Combiner:
        d = json.loads(text)
        w = d["weights"]
        return Combiner((w[0], w[1], w[2], w[3]), float(d["bias"]), float(d["threshold"]))


#: Hand-set until PL-03 fits it on labelled data (see the module docstring).
DEFAULT = Combiner(weights=(4.0, 8.0, 0.0, 0.0), bias=-8.5, threshold=0.5)


def choose_threshold(scores: Sequence[float], labels: Sequence[bool], min_precision: float = 0.9) -> float:
    """The lowest threshold (so the highest recall) whose precision on the labelled pairs is at least the target.

    Falls back to just above the highest score when no threshold reaches the target.
    """
    pairs = sorted(zip(scores, labels, strict=True), reverse=True)
    best = None
    tp = 0
    for i, (s, y) in enumerate(pairs, start=1):
        tp += 1 if y else 0
        # a threshold at score s takes in every pair with score >= s: only evaluate at the end of ties
        if i < len(pairs) and pairs[i][0] == s:
            continue
        if tp / i >= min_precision:
            best = s
    if best is None:
        return min(1.0, (pairs[0][0] if pairs else 0.0) + 1e-6)
    return best


def fit(
    features: Sequence[tuple[float, float, float, float]],
    labels: Sequence[bool],
    min_precision: float = 0.9,
) -> Combiner:
    """Fits the logistic model and sets the threshold for the precision target (on the training pairs)."""
    from sklearn.linear_model import LogisticRegression

    x = np.array(features, dtype=np.float64)
    y = np.array(labels, dtype=int)
    model = LogisticRegression(C=10.0, max_iter=1000).fit(x, y)
    w = model.coef_[0]
    base = Combiner((float(w[0]), float(w[1]), float(w[2]), float(w[3])), float(model.intercept_[0]), 0.5)
    scores = [base.score(f[0], f[1], f[2], f[3] > 0.5) for f in features]
    return Combiner(base.weights, base.bias, choose_threshold(scores, [bool(v) for v in labels], min_precision))
