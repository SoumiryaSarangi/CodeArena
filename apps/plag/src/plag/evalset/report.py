"""The METRICS.md block for the plagiarism eval."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Sequence

from ..combine import Combiner
from .build import PairRow
from .metrics import Prf, Summary

HEADING = "## Plagiarism eval (PL-03)"
OPEN = "<!-- plag-eval -->"
CLOSE = "<!-- /plag-eval -->"


def _pc(x: float | None) -> str:
    return "–" if x is None else f"{x * 100:.1f}%"


def _row(name: str, p: Prf) -> str:
    return f"| {name} | {_pc(p.precision)} | {_pc(p.recall)} | {_pc(p.f1)} | {p.tp} | {p.fp} | {p.fn} | {p.tn} |"


def render(s: Summary, rows: Sequence[PairRow], combiner: Combiner, model: str, date: str) -> str:
    kinds = Counter(r.kind for r in rows)
    problems = len({r.problem for r in rows})
    out = [
        OPEN,
        "",
        f"{date} · {len(rows)} labelled pairs ({s.positives} copies, {s.negatives} not) over {problems} problems in C++ and Python · embeddings: {model}",
        "",
    ]
    out += [
        "Pairs by kind: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())) + ".",
        "",
        'Precision, recall and F1 on **held-out problems** (the combined model is fitted leaving one problem out, and every threshold is chosen on the other problems for precision ≥ 0.9, so none of these is a model grading its own training data). "Flagged" = score at or above that threshold.',
        "",
        "| Detector | Precision | Recall | F1 | TP | FP | FN | TN |",
        "|---|---|---|---|---|---|---|---|",
        _row("Stage A at the design threshold (containment ≥ 0.35)", s.at_design_threshold),
        _row("Stage A alone (threshold for precision ≥ 0.9)", s.stage_a),
        _row("Stage B alone (embedding cosine, same rule)", s.stage_b),
        _row("**A + B combined** (logistic model, same rule)", s.stage_ab),
        "",
        "Average precision over all held-out pairs (1.0 = ranks every copy above every non-copy; chance = "
        + _pc(s.chance)
        + "): "
        + ", ".join(f"{k} {v:.3f}" for k, v in s.average_precision.items())
        + ".",
        "",
        "Recall by what the copier did (original against its disguised copy; Stage A at its threshold vs A + B at its):",
        "",
        "| Disguise | Pairs | Stage A | A + B |",
        "|---|---|---|---|",
    ]
    for k, v in s.recall_by_recipe.items():
        out.append(f"| {k} | {int(v['pairs'])} | {_pc(float(v['stage_a']))} | {_pc(float(v['stage_ab']))} |")
    h = s.hard_negatives
    out += [
        "",
        f"The hard negatives, {int(h['independent pairs'])} pairs of independent solutions to the same problem: fingerprint containment averages {h['fp mean']:.2f} (at most {h['fp max']:.2f}); embedding cosine averages {h['emb mean']:.2f} (at most {h['emb max']:.2f}).",
        "",
        f"Of the negative pairs, {s.converged['pairs']} are independent solutions that normalise to exactly the same program (they converged, as students do on a small problem); {s.converged['flagged_by_a_plus_b']} of them are flagged by A + B (and {s.converged['flagged_by_stage_a']} by Stage A), out of {s.converged['a_plus_b_false_positives']} false positives in all. No detector can tell such a pair from a copy, so they set a ceiling on precision.",
        "",
        f"The shipped combiner is fitted on all {len(rows)} pairs: weights fp {combiner.weights[0]:.2f}, emb {combiner.weights[1]:.2f}, length ratio {combiner.weights[2]:.2f}, same language {combiner.weights[3]:.2f}, bias {combiner.bias:.2f}, cluster threshold {combiner.threshold:.3f}.",
        "",
        f"<!--data {json.dumps({'pairs': len(rows), 'ap': s.average_precision, 'threshold': combiner.threshold})} -->",
        CLOSE,
    ]
    return "\n".join(out)


def upsert(md: str, block: str) -> str:
    a, b = md.find(OPEN), md.find(CLOSE)
    if a >= 0 and b > a:
        return md[:a] + block + md[b + len(CLOSE) :]
    out = md if md.endswith("\n") else md + "\n"
    if HEADING not in out:
        out += f"\n{HEADING}\n\nHow well the plagiarism pipeline separates obfuscated copies from independent work, measured by `python -m plag.evalset` (SYSTEM_DESIGN §13.2). The block is written by the script and replaced when it runs again.\n"
    return f"{out}\n{block}\n"
