"""PL-01: winnowing keeps its guarantee (SD-§13.1 step 4)."""

import random

from plag.winnow import K, W, fingerprints, kgram_hashes, winnow


def test_defaults_are_the_design_values():
    assert (K, W) == (12, 8)


def test_rolling_hash_equals_hashing_each_window_from_scratch():
    rnd = random.Random(1)
    tokens = [f"t{rnd.randrange(40)}" for _ in range(200)]
    rolling = kgram_hashes(tokens, 12)
    assert len(rolling) == 200 - 12 + 1
    # the same window always has the same hash, wherever it sits
    again = kgram_hashes(["pad", *tokens], 12)
    assert again[1:] == rolling
    assert len(set(rolling)) > 150  # and different windows rarely collide


def test_short_inputs():
    assert kgram_hashes(["a"] * 11, 12) == []
    assert winnow([], 8) == []
    assert fingerprints(["a"] * 11) == []
    assert len(fingerprints([f"t{i}" for i in range(12)])) == 1  # one k-gram: one fingerprint
    five = winnow([9, 4, 7, 5, 8], 8)  # fewer hashes than a window: still the minimum
    assert [(f.hash, f.pos) for f in five] == [(4, 1)]


def test_rightmost_minimum_wins_a_tie_and_positions_only_grow():
    assert [(f.hash, f.pos) for f in winnow([5, 5, 5], 3)] == [(5, 2)]
    fps = winnow([3, 1, 4, 1, 5, 9, 2, 6, 5, 3], 4)
    assert [f.pos for f in fps] == sorted(set(f.pos for f in fps))
    assert [(f.hash, f.pos) for f in fps] == [(1, 3), (2, 6)]


def test_every_window_contains_a_selected_fingerprint():
    rnd = random.Random(2)
    hashes = [rnd.randrange(1 << 40) for _ in range(500)]
    chosen = {f.pos for f in winnow(hashes, W)}
    for start in range(len(hashes) - W + 1):
        assert chosen & set(range(start, start + W)), start


def test_a_shared_run_of_w_plus_k_minus_1_tokens_always_shares_a_fingerprint():
    """The guarantee: 8 + 12 - 1 = 19 shared tokens, wherever they sit and whatever surrounds them."""
    rnd = random.Random(3)
    alphabet = [f"t{i}" for i in range(60)]
    run_len = W + K - 1
    for _ in range(400):
        shared = [rnd.choice(alphabet) for _ in range(run_len)]
        a = (
            [rnd.choice(alphabet) for _ in range(rnd.randrange(0, 80))]
            + shared
            + [rnd.choice(alphabet) for _ in range(rnd.randrange(0, 80))]
        )
        b = (
            [rnd.choice(alphabet) for _ in range(rnd.randrange(0, 80))]
            + shared
            + [rnd.choice(alphabet) for _ in range(rnd.randrange(0, 80))]
        )
        fa = {f.hash for f in fingerprints(a)}
        fb = {f.hash for f in fingerprints(b)}
        assert fa & fb, (a, b)


def test_unrelated_documents_share_almost_nothing_and_the_density_is_about_two_over_w_plus_1():
    rnd = random.Random(4)
    alphabet = [f"t{i}" for i in range(200)]
    a = [rnd.choice(alphabet) for _ in range(3000)]
    b = [rnd.choice(alphabet) for _ in range(3000)]
    fa = fingerprints(a)
    density = len(fa) / len(a)
    assert 2 / (W + 1) * 0.8 < density < 2 / (W + 1) * 1.2
    assert not ({f.hash for f in fa} & {f.hash for f in fingerprints(b)})
