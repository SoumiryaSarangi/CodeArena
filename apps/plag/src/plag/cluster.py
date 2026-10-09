"""Clusters (SD-§13.1 step 7): connected components of the graph of high-confidence pairs."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import networkx as nx


@dataclass(frozen=True)
class Cluster:
    ids: tuple[str, ...]
    max_score: float


def clusters(edges: Iterable[tuple[str, str, float]], threshold: float) -> list[Cluster]:
    """Components over the edges scoring at or above `threshold`, strongest first (ties by first id)."""
    g: nx.Graph = nx.Graph()
    for a, b, score in edges:
        if score >= threshold:
            g.add_edge(a, b, score=score)
    out = [
        Cluster(
            tuple(sorted(component)),
            max(d["score"] for _, _, d in g.subgraph(component).edges(data=True)),
        )
        for component in nx.connected_components(g)
    ]
    out.sort(key=lambda c: (-c.max_score, c.ids[0]))
    return out
