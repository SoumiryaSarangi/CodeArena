"""Builds the labelled pairs: for every problem and language, one reference solution, its obfuscated copies, and
independent solutions, then the features of every pair inside that pool (SD-§13.2).

Labels: two documents are a positive pair when both descend from the same original (original-copy and copy-copy:
two people disguising the same source differently); everything involving an independent solution is a negative.
The pool is one problem's submissions in one language, which is what the detector sees in a contest.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from ..embed import Embedder, cosine_matrix
from ..normalise import normalise
from ..stage_a import boilerplate_hashes, fingerprint_set
from .transforms import RECIPES, apply

ORIGINALS = {"cpp17": "main.cpp", "python3": "alt.py"}
#: Boilerplate is judged on the independent work plus the original: a contest's copies are a small share of its
#: submissions, whereas a pool made mostly of copies of one program would turn that program into "boilerplate".
MIN_BACKGROUND = 4


@dataclass(frozen=True)
class Doc:
    id: str
    problem: str
    language: str
    kind: str  # original | variant | independent
    recipe: tuple[str, ...]
    source: str


@dataclass(frozen=True)
class PairRow:
    problem: str
    language: str
    a: str
    b: str
    kind: (
        str  # original-variant | variant-variant | original-independent | variant-independent | independent-independent
    )
    recipe: str  # the copier's steps for original-variant pairs, "" otherwise
    fp: float
    emb: float
    len_ratio: float
    label: bool


def build_pool(
    problem: str,
    language: str,
    original: str,
    independents: Sequence[str],
    seed: int = 1,
    recipes: Sequence[tuple[str, ...]] = RECIPES,
) -> list[Doc]:
    docs = [Doc(f"{problem}:{language}:orig", problem, language, "original", (), original)]
    seen: set[str] = {original}
    for i, recipe in enumerate(recipes):
        out = apply(original, language, recipe, seed + i * 7)
        if out is None or out[0] in seen:
            continue
        seen.add(out[0])
        label = "+".join(out[1])
        docs.append(Doc(f"{problem}:{language}:v{i}:{label}", problem, language, "variant", out[1], out[0]))
    for j, src in enumerate(independents):
        docs.append(Doc(f"{problem}:{language}:ind{j}", problem, language, "independent", (), src))
    return docs


def _kind(a: Doc, b: Doc) -> tuple[str, bool]:
    kinds = sorted((a.kind, b.kind))
    label = "independent" not in kinds
    return "-".join(kinds), label


def pair_rows(docs: Sequence[Doc], embedder: Embedder) -> list[PairRow]:
    """Every pair in the pool, with its Stage A containment, embedding cosine and length ratio."""
    sets = {d.id: fingerprint_set(d.source, d.language) for d in docs}
    background = [sets[d.id] for d in docs if d.kind != "variant"]
    ignore = boilerplate_hashes(background, minimum=MIN_BACKGROUND)
    kept = {k: {h: p for h, p in s.items() if h not in ignore} for k, s in sets.items()}
    norm = {d.id: normalise(d.source, d.language) for d in docs}
    vectors = embedder.embed([norm[d.id].text for d in docs])
    cos = cosine_matrix(vectors)
    rows: list[PairRow] = []
    for i, a in enumerate(docs):
        for j in range(i + 1, len(docs)):
            b = docs[j]
            sa, sb = kept[a.id], kept[b.id]
            smaller = min(len(sa), len(sb))
            fp = (sum(1 for h in sa if h in sb) / smaller) if smaller else 0.0
            la, lb = len(norm[a.id].tokens), len(norm[b.id].tokens)
            kind, label = _kind(a, b)
            recipe = "+".join(b.recipe if a.kind == "original" else a.recipe) if kind == "original-variant" else ""
            rows.append(
                PairRow(
                    a.problem,
                    a.language,
                    a.id,
                    b.id,
                    kind,
                    recipe,
                    fp,
                    float(cos[i, j]),
                    min(la, lb) / max(la, lb) if max(la, lb) else 0.0,
                    label,
                )
            )
    return rows


def build_rows(
    problems_root: Path,
    independents: Sequence[dict[str, str]],
    embedder: Embedder,
    seed: int = 1,
) -> list[PairRow]:
    rows: list[PairRow] = []
    for lang, filename in ORIGINALS.items():
        for sol in sorted(problems_root.glob(f"*/solutions/{filename}")):
            slug = sol.parent.parent.name
            ind = [i["source"] for i in independents if i["slug"] == slug and i["language"] == lang]
            rows.extend(pair_rows(build_pool(slug, lang, sol.read_text(), ind, seed), embedder))
    return rows


def to_json(rows: Sequence[PairRow]) -> list[dict[str, object]]:
    return [asdict(r) for r in rows]


def from_json(data: Sequence[dict[str, object]]) -> list[PairRow]:
    return [PairRow(**d) for d in data]  # type: ignore[arg-type]
