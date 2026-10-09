"""Stage A of the pipeline: fingerprints per submission, boilerplate removed, candidate pairs by containment.

SD-§13.1 steps 3-4. Fingerprints that appear in more than 30 % of a problem's submissions, or in the setter's
template, are ignored (like MOSS's base file). A pair's score is the larger of the two containments
`|A ∩ B| / min(|A|, |B|)` taken as the share of the smaller document's fingerprints found in the other, and pairs
at or above 0.35 are candidates for Stage B.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from .languages import UnsupportedLanguage, spec_for
from .normalise import normalise
from .winnow import K, W, fingerprints

THRESHOLD = 0.35
BOILERPLATE_RATIO = 0.30
#: With fewer submissions than this a "common" fingerprint is just two people having the same one.
MIN_FOR_BOILERPLATE = 5


@dataclass(frozen=True)
class Submission:
    id: str
    language: str
    source: str
    user: str | None = None


@dataclass(frozen=True)
class Template:
    """Setter-provided starting code (and the sample solutions): shared by everyone, so never evidence."""

    language: str
    source: str


@dataclass(frozen=True)
class PairScore:
    a: str
    b: str
    score: float
    shared: int
    size_a: int
    size_b: int


@dataclass
class StageAResult:
    pairs: list[PairScore]
    #: Fingerprint hash → position of its first occurrence, per submission id (after boilerplate removal).
    fingerprints: dict[str, dict[int, int]]
    boilerplate: frozenset[int]
    #: Submissions that could not be fingerprinted (language without a grammar), with the reason.
    skipped: dict[str, str] = field(default_factory=dict)


def fingerprint_set(source: str, language: str, k: int = K, w: int = W) -> dict[int, int]:
    """Hash → first position, for one program."""
    out: dict[int, int] = {}
    for fp in fingerprints(normalise(source, language).tokens, k, w):
        out.setdefault(fp.hash, fp.pos)
    return out


def boilerplate_hashes(
    sets: Iterable[dict[int, int]],
    *,
    ratio: float = BOILERPLATE_RATIO,
    minimum: int = MIN_FOR_BOILERPLATE,
) -> frozenset[int]:
    """Fingerprints present in more than `ratio` of the submissions (needs at least `minimum` of them)."""
    all_sets = list(sets)
    n = len(all_sets)
    if n < minimum:
        return frozenset()
    count: dict[int, int] = defaultdict(int)
    for s in all_sets:
        for h in s:
            count[h] += 1
    return frozenset(h for h, c in count.items() if c / n > ratio)


def candidate_pairs(
    sets: dict[str, dict[int, int]],
    families: dict[str, str],
    users: dict[str, str | None],
    threshold: float = THRESHOLD,
) -> list[PairScore]:
    """All pairs (same language family, different people) whose containment reaches the threshold."""
    index: dict[int, list[str]] = defaultdict(list)
    for sid, s in sets.items():
        for h in s:
            index[h].append(sid)
    shared: dict[tuple[str, str], int] = defaultdict(int)
    for ids in index.values():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = sorted((ids[i], ids[j]))
                shared[(a, b)] += 1
    pairs: list[PairScore] = []
    for (a, b), n_shared in shared.items():
        if families[a] != families[b]:
            continue
        if users.get(a) is not None and users.get(a) == users.get(b):
            continue
        smaller = min(len(sets[a]), len(sets[b]))
        if smaller == 0:
            continue
        score = n_shared / smaller
        if score >= threshold:
            pairs.append(PairScore(a, b, score, n_shared, len(sets[a]), len(sets[b])))
    pairs.sort(key=lambda p: (-p.score, p.a, p.b))
    return pairs


def stage_a(
    submissions: Sequence[Submission],
    *,
    templates: Sequence[Template] = (),
    k: int = K,
    w: int = W,
    threshold: float = THRESHOLD,
    boilerplate_ratio: float = BOILERPLATE_RATIO,
) -> StageAResult:
    """Fingerprint, drop boilerplate and template fingerprints, and score every pair."""
    raw: dict[str, dict[int, int]] = {}
    families: dict[str, str] = {}
    skipped: dict[str, str] = {}
    for sub in submissions:
        try:
            families[sub.id] = spec_for(sub.language).family
            raw[sub.id] = fingerprint_set(sub.source, sub.language, k, w)
        except UnsupportedLanguage as e:
            skipped[sub.id] = str(e)
    ignore = set(boilerplate_hashes(raw.values(), ratio=boilerplate_ratio))
    for t in templates:
        try:
            ignore.update(fingerprint_set(t.source, t.language, k, w))
        except UnsupportedLanguage:
            continue
    kept = {sid: {h: p for h, p in s.items() if h not in ignore} for sid, s in raw.items()}
    users = {s.id: s.user for s in submissions}
    return StageAResult(
        pairs=candidate_pairs(kept, families, users, threshold),
        fingerprints=kept,
        boilerplate=frozenset(ignore),
        skipped=skipped,
    )
