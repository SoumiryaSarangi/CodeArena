"""Winnowing (Schleimer, Wilkerson, Aiken: "Winnowing: Local Algorithms for Document Fingerprinting").

SD-§13.1 step 4. Hash every k-gram of tokens and, in each window of w consecutive hashes, keep the smallest
(the rightmost on a tie). Any run of at least w + k - 1 tokens shared by two documents then contributes at
least one fingerprint to both, whatever surrounds it; with k = 12 and w = 8 that is 19 tokens.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from hashlib import blake2b

K = 12
W = 8

_MOD = (1 << 61) - 1
_BASE = 1_000_003


@lru_cache(maxsize=65_536)
def _token_id(token: str) -> int:
    return int.from_bytes(blake2b(token.encode("utf-8"), digest_size=8).digest(), "big") % _MOD


@dataclass(frozen=True)
class Fingerprint:
    hash: int
    #: Index of the k-gram's first token in the normalised stream.
    pos: int


def kgram_hashes(tokens: Sequence[str], k: int = K) -> list[int]:
    """Rolling polynomial hash of every window of k tokens (stable across runs and processes)."""
    if k < 1:
        raise ValueError("k must be at least 1")
    n = len(tokens)
    if n < k:
        return []
    ids = [_token_id(t) for t in tokens]
    top = pow(_BASE, k - 1, _MOD)
    h = 0
    for i in range(k):
        h = (h * _BASE + ids[i]) % _MOD
    out = [h]
    for i in range(k, n):
        h = ((h - ids[i - k] * top) * _BASE + ids[i]) % _MOD
        out.append(h)
    return out


def winnow(hashes: Sequence[int], w: int = W) -> list[Fingerprint]:
    """The winnowed fingerprints of a hash sequence: the minimum of each window, rightmost on ties."""
    if w < 1:
        raise ValueError("w must be at least 1")
    n = len(hashes)
    if n == 0:
        return []
    width = min(w, n)  # a document shorter than a window still gets one fingerprint
    out: list[Fingerprint] = []
    last = -1
    for start in range(n - width + 1):
        best = start
        for j in range(start, start + width):
            if hashes[j] <= hashes[best]:
                best = j
        if best != last:
            out.append(Fingerprint(hashes[best], best))
            last = best
    return out


def fingerprints(tokens: Sequence[str], k: int = K, w: int = W) -> list[Fingerprint]:
    return winnow(kgram_hashes(tokens, k), w)
