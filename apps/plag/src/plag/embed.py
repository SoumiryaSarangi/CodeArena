"""Stage B embeddings (SD-§13.1 step 5): UniXcoder on CPU, long inputs chunked and mean-pooled.

`UniXcoderEmbedder` loads torch and the 125M-parameter model only when first used, so importing this package (and
running the tests that use `TokenBagEmbedder`) stays light. Vectors are L2-normalised, so cosine similarity is a dot
product.
"""

from __future__ import annotations

from collections.abc import Sequence
from hashlib import blake2b
from typing import Any, Protocol

import numpy as np
from numpy.typing import NDArray

Vectors = NDArray[np.float32]

MODEL_NAME = "microsoft/unixcoder-base"
MAX_LEN = 512


class Embedder(Protocol):
    #: Recorded with the results, so a score can be traced to the model that made it.
    name: str

    def embed(self, texts: Sequence[str]) -> Vectors: ...


def normalise_rows(m: NDArray[np.floating[Any]]) -> Vectors:
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    out: Vectors = (m / norms).astype(np.float32)
    return out


def cosine_matrix(vectors: Vectors) -> NDArray[np.float32]:
    """All pairwise cosines of L2-normalised rows (n <= 200 per problem: trivial)."""
    out: NDArray[np.float32] = (vectors @ vectors.T).astype(np.float32)
    return out


class UniXcoderEmbedder:
    """`microsoft/unixcoder-base`: encoder-only mode, mean over the tokens, chunks of up to 512 tokens averaged."""

    def __init__(self, model_name: str = MODEL_NAME, batch_size: int = 8) -> None:
        self.name = model_name
        self.batch_size = batch_size
        self._tok: Any = None
        self._model: Any = None

    def _load(self) -> None:
        if self._model is not None:
            return
        from transformers import AutoModel, AutoTokenizer  # heavy: only when really embedding

        self._tok = AutoTokenizer.from_pretrained(self.name)
        self._model = AutoModel.from_pretrained(self.name).eval()

    def _chunks(self, text: str) -> list[list[int]]:
        """Token-id chunks, each wrapped as `<s> <encoder-only> </s> ... </s>` and at most MAX_LEN long."""
        tok = self._tok
        pieces = tok.tokenize(text) or [tok.unk_token]
        head = [tok.cls_token, "<encoder-only>", tok.sep_token]
        body = MAX_LEN - len(head) - 1
        out = []
        for i in range(0, len(pieces), body):
            out.append(tok.convert_tokens_to_ids(head + pieces[i : i + body] + [tok.sep_token]))
        return out

    def embed(self, texts: Sequence[str]) -> Vectors:
        import torch

        self._load()
        pad = self._tok.pad_token_id
        flat: list[list[int]] = []
        owner: list[int] = []
        for i, text in enumerate(texts):
            for ids in self._chunks(text):
                flat.append(ids)
                owner.append(i)
        chunk_vecs: list[NDArray[np.float32]] = []
        with torch.no_grad():
            for start in range(0, len(flat), self.batch_size):
                batch = flat[start : start + self.batch_size]
                width = max(len(b) for b in batch)
                tensor = torch.tensor([b + [pad] * (width - len(b)) for b in batch])
                mask = (tensor != pad).unsqueeze(-1).float()
                hidden = self._model(tensor, attention_mask=(tensor != pad)).last_hidden_state
                pooled = (hidden * mask).sum(1) / mask.sum(1)
                chunk_vecs.extend(pooled.numpy())
        dim = chunk_vecs[0].shape[0] if chunk_vecs else 768
        out = np.zeros((len(texts), dim), dtype=np.float32)
        weight = np.zeros(len(texts), dtype=np.float32)
        for vec, who, ids in zip(chunk_vecs, owner, flat, strict=True):
            out[who] += vec * len(ids)  # a long file's chunks are averaged by their length
            weight[who] += len(ids)
        weight[weight == 0] = 1.0
        return normalise_rows(out / weight[:, None])


class TokenBagEmbedder:
    """A cheap, deterministic stand-in: hashed bag of token bigrams. Not a semantic model; for tests and dry runs."""

    name = "token-bag"

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim

    def embed(self, texts: Sequence[str]) -> Vectors:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            toks = text.split()
            for a, b in zip(toks, toks[1:], strict=False):
                h = int.from_bytes(blake2b(f"{a} {b}".encode(), digest_size=4).digest(), "big")
                out[i, h % self.dim] += 1.0
        return normalise_rows(out)
