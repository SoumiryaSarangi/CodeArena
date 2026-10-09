"""PL-02: the combined score, its threshold, and clusters."""

import random

from plag.cluster import clusters
from plag.combine import DEFAULT, Combiner, choose_threshold, fit


class TestCombiner:
    def test_default_weights_make_each_signal_necessary_but_not_sufficient_alone(self):
        # shared fingerprints are strong evidence by themselves (even with an unremarkable embedding)
        assert DEFAULT.score(fp=1.0, emb=0.6, len_ratio=1.0, same_language=True) >= DEFAULT.threshold
        # a high cosine alone is not enough: the measured different-problem maximum is 0.918
        assert DEFAULT.score(fp=0.0, emb=0.92, len_ratio=1.0, same_language=True) < DEFAULT.threshold
        assert DEFAULT.score(fp=0.0, emb=0.99, len_ratio=1.0, same_language=True) < DEFAULT.threshold
        # a moderate overlap plus a close embedding is
        assert DEFAULT.score(fp=0.5, emb=0.9, len_ratio=1.0, same_language=True) >= DEFAULT.threshold
        assert DEFAULT.score(fp=0.0, emb=0.5, len_ratio=1.0, same_language=True) < 0.02

    def test_monotone_in_the_two_evidence_features(self):
        base = DEFAULT.score(0.3, 0.8, 1.0, True)
        assert DEFAULT.score(0.5, 0.8, 1.0, True) > base
        assert DEFAULT.score(0.3, 0.9, 1.0, True) > base

    def test_json_round_trip(self):
        c = Combiner((1.0, 2.0, 3.0, 4.0), -5.0, 0.7)
        assert Combiner.from_json(c.to_json()) == c


class TestThreshold:
    def test_lowest_threshold_that_keeps_the_precision_target(self):
        scores = [0.9, 0.8, 0.7, 0.6, 0.5]
        labels = [True, True, False, True, False]
        assert choose_threshold(scores, labels, 0.9) == 0.8
        assert choose_threshold(scores, labels, 0.7) == 0.6  # 3 of 4 = 0.75
        assert choose_threshold(scores, labels, 0.5) == 0.5

    def test_ties_are_taken_whole(self):
        # both 0.8s are in or out together: precision at 0.8 is 1 of 2, below the target
        assert choose_threshold([0.9, 0.8, 0.8], [True, True, False], 0.9) == 0.9

    def test_no_threshold_reaches_the_target(self):
        t = choose_threshold([0.9, 0.8], [False, False], 0.9)
        assert t > 0.9

    def test_fit_separates_a_clear_problem_and_meets_the_precision_target(self):
        rnd = random.Random(7)
        feats, labels = [], []
        for _ in range(150):  # copies: high fingerprint overlap, close embeddings
            feats.append((rnd.uniform(0.5, 1.0), rnd.uniform(0.8, 0.99), rnd.uniform(0.6, 1.0), True))
            labels.append(True)
        for _ in range(150):  # independent work: little overlap, embeddings 0.5-0.92
            feats.append((rnd.uniform(0.0, 0.25), rnd.uniform(0.5, 0.92), rnd.uniform(0.3, 1.0), True))
            labels.append(False)
        c = fit(feats, labels, min_precision=0.9)
        assert c.weights[0] > 0 and c.weights[1] > 0
        scores = [c.score(*f) for f in feats]
        flagged = [y for s, y in zip(scores, labels, strict=True) if s >= c.threshold]
        assert sum(flagged) / len(flagged) >= 0.9
        assert sum(flagged) >= 140  # and almost all copies are still found


class TestClusters:
    def test_connected_components_over_high_confidence_edges(self):
        edges = [("a", "b", 0.9), ("b", "c", 0.8), ("d", "e", 0.95), ("f", "g", 0.4)]
        out = clusters(edges, 0.5)
        assert [(c.ids, c.max_score) for c in out] == [(("d", "e"), 0.95), (("a", "b", "c"), 0.9)]

    def test_an_edge_below_the_threshold_does_not_join_two_groups(self):
        edges = [("a", "b", 0.9), ("c", "d", 0.9), ("b", "c", 0.3)]
        assert [c.ids for c in clusters(edges, 0.5)] == [("a", "b"), ("c", "d")]

    def test_a_chain_is_one_cluster_and_nothing_means_none(self):
        edges = [("a", "b", 0.6), ("b", "c", 0.7), ("c", "d", 0.6)]
        out = clusters(edges, 0.5)
        assert len(out) == 1 and out[0].ids == ("a", "b", "c", "d") and out[0].max_score == 0.7
        assert clusters([], 0.5) == []
        assert clusters([("a", "b", 0.2)], 0.5) == []

    def test_ordering_is_deterministic(self):
        edges = [("x", "y", 0.8), ("a", "b", 0.8)]
        assert [c.ids for c in clusters(edges, 0.5)] == [("a", "b"), ("x", "y")]
