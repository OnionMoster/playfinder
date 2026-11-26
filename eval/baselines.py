from __future__ import annotations

import hashlib
import random
from collections import Counter


def canonical_id(value: object) -> str:
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except Exception:
            pass
    return str(value)


class PopularityRecommender:
    def __init__(
        self,
        global_rank: dict[str, int] | None = None,
        tie_break_rank: dict[str, int] | None = None,
    ) -> None:
        self.global_rank = global_rank or {}
        self.tie_break_rank = tie_break_rank or global_rank or {}
        self.ranked_items: list[object] = []
        self.popularity_scores: dict[str, float] = {}

    def fit(self, train_rows: list[dict[str, object]] | dict[object, int], all_item_ids: list[object]) -> None:
        popularity = Counter()
        if isinstance(train_rows, dict):
            for item_id, count in train_rows.items():
                popularity[canonical_id(item_id)] += int(count)
        else:
            for row in train_rows:
                if int(row["label"]) == 1:
                    popularity[canonical_id(row["item_id"])] += 1

        def sort_key(item_id: object) -> tuple[float, int, str]:
            item_key = canonical_id(item_id)
            return (
                -float(popularity.get(item_key, 0)),
                int(self.tie_break_rank.get(item_key, 10**9)),
                item_key,
            )

        self.ranked_items = sorted(set(all_item_ids), key=sort_key)
        self.popularity_scores = {item_key: float(score) for item_key, score in popularity.items()}

    def recommend(self, user_id: object, seen_items: set[object], k: int) -> list[object]:
        return [item_id for item_id in self.ranked_items if item_id not in seen_items][:k]

    def score(self, user_id: object, item_ids: list[object]) -> list[float]:
        scores = []
        for item_id in item_ids:
            item_key = canonical_id(item_id)
            if item_key in self.popularity_scores:
                scores.append(self.popularity_scores[item_key])
            else:
                rank = self.tie_break_rank.get(item_key, 10**9)
                scores.append(1.0 / rank if rank > 0 else 0.0)
        return scores

    @property
    def params(self) -> dict[str, object]:
        return {"name": "popularity", "signal": "train_positive_count_with_train_tiebreak"}


class RandomRecommender:
    def __init__(self, seed: int = 42) -> None:
        self.seed = seed
        self.all_item_ids: list[object] = []

    def fit(self, train_rows: list[dict[str, object]], all_item_ids: list[object]) -> None:
        self.all_item_ids = list(all_item_ids)

    def recommend(self, user_id: object, seen_items: set[object], k: int) -> list[object]:
        rng = random.Random(f"{self.seed}:{user_id}")
        candidates = [item_id for item_id in self.all_item_ids if item_id not in seen_items]
        rng.shuffle(candidates)
        return candidates[:k]

    def score(self, user_id: object, item_ids: list[object]) -> list[float]:
        scores: list[float] = []
        for item_id in item_ids:
            digest = hashlib.sha256(f"{self.seed}:{user_id}:{item_id}".encode("utf-8")).hexdigest()
            scores.append(int(digest[:12], 16) / float(16**12 - 1))
        return scores

    @property
    def params(self) -> dict[str, object]:
        return {"name": "random", "seed": self.seed}
