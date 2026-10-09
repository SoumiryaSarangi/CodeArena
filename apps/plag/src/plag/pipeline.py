"""Stage A + Stage B for one problem: candidates, embeddings, combined score, clusters (SD-§13.1 steps 3-7)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass

from .cluster import Cluster, clusters
from .combine import DEFAULT, Combiner
from .embed import Embedder, cosine_matrix
from .languages import spec_for
from .normalise import normalise
from .stage_a import THRESHOLD, Submission, Template, stage_a
from .winnow import K, W


@dataclass(frozen=True)
class Params:
    k: int = K
    w: int = W
    #: Stage A: pairs at or above this containment are candidates (SD: 0.35).
    stage_a_threshold: float = THRESHOLD
    #: Stage B sweep: each submission's `neighbours` nearest by cosine join the candidates if at least this similar,
    #: even when Stage A found nothing (a copy that was rewritten enough to defeat the fingerprints).
    #: Measured with the real model on the 20 problems' solutions: a disguised copy scores 0.92 on average (0.76 at
    #: worst) against 0.56 on average and 0.918 at most for different problems, so a cosine alone convicts nobody; the
    #: sweep only adds pairs above the highest seen between different problems, and the combined score decides.
    sweep_cosine: float = 0.95
    neighbours: int = 3
    #: Pairs whose combined score is at least this are reported (the review page lists them); clusters use the
    #: combiner's own threshold.
    report_threshold: float = 0.30
    #: Embed the normalised token text (`normalised`: renames and noise cannot move the vector, and same-problem
    #: solutions score 0.92 against 0.86 on the raw source) or the original source (`source`).
    embed_on: str = "normalised"


@dataclass(frozen=True)
class ScoredPair:
    a: str
    b: str
    fp_score: float
    emb_score: float
    combined: float


@dataclass(frozen=True)
class ProblemResult:
    problem_id: str
    pairs: list[ScoredPair]
    clusters: list[Cluster]
    metrics: dict[str, float | int | str]


def _fp_score(sets: dict[str, dict[int, int]], a: str, b: str) -> float:
    sa, sb = sets[a], sets[b]
    smaller = min(len(sa), len(sb))
    if smaller == 0:
        return 0.0
    small, big = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
    return sum(1 for h in small if h in big) / smaller


def run_problem(
    problem_id: str,
    submissions: Sequence[Submission],
    *,
    embedder: Embedder,
    combiner: Combiner = DEFAULT,
    templates: Sequence[Template] = (),
    params: Params = Params(),  # noqa: B008 (frozen)
) -> ProblemResult:
    """Scores the pairs of one problem's final submissions and clusters the high-confidence ones."""
    a = stage_a(
        submissions,
        templates=templates,
        k=params.k,
        w=params.w,
        threshold=params.stage_a_threshold,
    )
    usable = [s for s in submissions if s.id in a.fingerprints]
    by_id = {s.id: s for s in usable}
    norm = {s.id: normalise(s.source, s.language) for s in usable}
    texts = [norm[s.id].text if params.embed_on == "normalised" else s.source for s in usable]
    vectors = embedder.embed(texts)
    index = {s.id: i for i, s in enumerate(usable)}
    cos = cosine_matrix(vectors) if usable else None

    def comparable(x: str, y: str) -> bool:
        if x == y or spec_for(by_id[x].language).family != spec_for(by_id[y].language).family:
            return False
        ux, uy = by_id[x].user, by_id[y].user
        return not (ux is not None and ux == uy)

    keys: dict[tuple[str, str], str] = {}  # candidate pair -> where it came from
    for p in a.pairs:
        keys[(p.a, p.b)] = "stage-a"
    if cos is not None and params.neighbours > 0:
        for s in usable:
            row = cos[index[s.id]]
            order = sorted(
                (j for j in range(len(usable)) if comparable(s.id, usable[j].id)),
                key=lambda j: -float(row[j]),
            )[: params.neighbours]
            for j in order:
                if float(row[j]) >= params.sweep_cosine:
                    x, y = sorted((s.id, usable[j].id))
                    keys.setdefault((x, y), "sweep")

    scored: list[ScoredPair] = []
    for x, y in keys:
        assert cos is not None
        emb = float(cos[index[x], index[y]])
        fp = _fp_score(a.fingerprints, x, y)
        nx_, ny_ = len(norm[x].tokens), len(norm[y].tokens)
        ratio = min(nx_, ny_) / max(nx_, ny_) if max(nx_, ny_) else 0.0
        combined = combiner.score(fp, emb, ratio, by_id[x].language == by_id[y].language)
        if combined >= params.report_threshold:
            scored.append(ScoredPair(x, y, fp, emb, combined))
    scored.sort(key=lambda p: (-p.combined, p.a, p.b))
    groups = clusters(((p.a, p.b, p.combined) for p in scored), combiner.threshold)
    return ProblemResult(
        problem_id,
        scored,
        groups,
        {
            "submissions": len(usable),
            "skipped": len(a.skipped),
            "boilerplateFingerprints": len(a.boilerplate),
            "stageAPairs": len(a.pairs),
            "sweepPairs": sum(1 for v in keys.values() if v == "sweep"),
            "reportedPairs": len(scored),
            "clusters": len(groups),
            "model": embedder.name,
        },
    )


def params_json(p: Params, combiner: Combiner) -> dict[str, object]:
    return {**asdict(p), "combiner": asdict(combiner)}
