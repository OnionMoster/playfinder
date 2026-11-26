from __future__ import annotations

import math
from itertools import combinations


def precision_at_k(recommended: list[str], relevant: set[str], k: int) -> float:
    if k <= 0:
        return 0.0
    top_k = recommended[:k]
    if not top_k:
        return 0.0
    hits = sum(1 for item_id in top_k if item_id in relevant)
    return hits / k


def recall_at_k(recommended: list[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return 0.0
    top_k = recommended[:k]
    hits = sum(1 for item_id in top_k if item_id in relevant)
    return hits / len(relevant)


def ndcg_at_k(recommended: list[str], relevant: set[str], k: int) -> float:
    if not relevant or k <= 0:
        return 0.0
    dcg = 0.0
    for rank, item_id in enumerate(recommended[:k], start=1):
        if item_id in relevant:
            dcg += 1.0 / math.log2(rank + 1)
    ideal_hits = min(len(relevant), k)
    if ideal_hits == 0:
        return 0.0
    idcg = sum(1.0 / math.log2(rank + 1) for rank in range(1, ideal_hits + 1))
    return dcg / idcg if idcg else 0.0


def average_precision_at_k(recommended: list[str], relevant: set[str], k: int) -> float:
    if not relevant or k <= 0:
        return 0.0
    score = 0.0
    hits = 0
    for rank, item_id in enumerate(recommended[:k], start=1):
        if item_id in relevant:
            hits += 1
            score += hits / rank
    denom = min(len(relevant), k)
    return score / denom if denom else 0.0


def reciprocal_rank_at_k(recommended: list[str], relevant: set[str], k: int) -> float:
    if not relevant or k <= 0:
        return 0.0
    for rank, item_id in enumerate(recommended[:k], start=1):
        if item_id in relevant:
            return 1.0 / rank
    return 0.0


def serendipity_at_k(
    recommended: list[str],
    relevant: set[str],
    baseline_recommended: list[str],
    k: int,
) -> float:
    if k <= 0:
        return 0.0
    top_k = recommended[:k]
    if not top_k:
        return 0.0
    baseline_set = set(baseline_recommended[:k])
    surprising_hits = sum(
        1
        for item_id in top_k
        if item_id in relevant and item_id not in baseline_set
    )
    return surprising_hits / k


def novelty_at_k(
    recommended: list[str],
    k: int,
    item_popularity: dict[str, int],
    num_train_users: int,
) -> float:
    if k <= 0 or num_train_users <= 0:
        return 0.0
    top_k = recommended[:k]
    if not top_k:
        return 0.0
    total = 0.0
    for item_id in top_k:
        popularity = item_popularity.get(item_id, 0)
        probability = popularity / num_train_users if popularity else 1.0 / (num_train_users + 1)
        total += -math.log2(probability)
    return total / len(top_k)


def intra_list_diversity_at_k(
    recommended: list[str],
    k: int,
    item_features: dict[str, set[str]],
) -> float:
    top_k = recommended[:k]
    if len(top_k) < 2:
        return 0.0
    distances: list[float] = []
    for left, right in combinations(top_k, 2):
        left_features = item_features.get(left, set())
        right_features = item_features.get(right, set())
        if not left_features and not right_features:
            continue
        union = left_features | right_features
        if not union:
            continue
        overlap = left_features & right_features
        distances.append(1.0 - (len(overlap) / len(union)))
    return sum(distances) / len(distances) if distances else 0.0


def normalize_scores(scores: list[float]) -> list[float]:
    if not scores:
        return []
    finite_scores = [score for score in scores if math.isfinite(score)]
    if not finite_scores:
        return [0.5 for _ in scores]
    floor = min(finite_scores) - 1.0
    cleaned_scores = [score if math.isfinite(score) else floor for score in scores]
    min_score = min(cleaned_scores)
    max_score = max(cleaned_scores)
    if math.isclose(min_score, max_score):
        return [0.5 for _ in cleaned_scores]
    span = max_score - min_score
    return [(score - min_score) / span for score in cleaned_scores]
