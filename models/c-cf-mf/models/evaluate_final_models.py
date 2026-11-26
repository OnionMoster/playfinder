import argparse
import json
import os
import sys
from pathlib import Path
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
import numpy as np
from scipy import sparse
root = Path(__file__).resolve().parents[3]
c_root = Path(__file__).resolve().parents[1]
eval_dir = root / "eval"
results_dir = c_root / "results"
interactions_file = root / "data" / "interactions.parquet"
items_file = root / "data" / "items.parquet"
users_file = root / "data" / "users.parquet"
popularity_file = root / "data" / "item_popularity.parquet"
ratio = 0.80
sample_size = 3_000
seed = 42
default_k = (5, 10)
aggregate_fields = [
    "model",
    "scenario",
    "scope",
    "k",
    "users",
    "precision_at_k",
    "recall_at_k",
    "ndcg_at_k",
    "map_at_k",
    "mrr_at_k",
    "auc",
    "rmse",
    "mae",
    "catalogue_coverage",
    "user_coverage",
    "novelty",
    "intra_list_diversity",
    "serendipity",
    "params",
]
sys.path.insert(0, str(eval_dir))
from baselines import PopularityRecommender
from evaluation_core import build_split, canonical_id, evaluate, write_csv
def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Evaluate C's final models")
    parser.add_argument(
        "--k-values",
        nargs="+",
        type=int,
        default=list(default_k),
        metavar="K",
        help="ranking cutoffs to evaluate",
    )
    return parser.parse_args(argv)

class FinalModelData:
    def __init__(self, folder):
        self.user_item_matrix = sparse.load_npz(folder / "user_item_matrix.npz").tocsr()
        users = np.load(folder / "user_ids.npy")
        items = np.load(folder / "item_ids.npy")
        self.user_ids = [canonical_id(user_id) for user_id in users]
        self.item_ids = [canonical_id(item_id) for item_id in items]
        self.user_map = {user_id: index for index, user_id in enumerate(self.user_ids)}
        self.item_map = {item_id: index for index, item_id in enumerate(self.item_ids)}

class LoadedItemCF:
    def __init__(self, data, folder, params):
        self.data = data
        self.similarity = sparse.load_npz(folder / "itemcf_similarity.npz").tocsr()
        self._params = params

    def recommend(self, user_id, seen_items, k):
        user_index = self.data.user_map.get(canonical_id(user_id))
        if user_index is None:
            return []
        scores = (self.data.user_item_matrix.getrow(user_index) @ self.similarity).toarray().ravel()
        # skip seen items
        for item_id in seen_items:
            item_index = self.data.item_map.get(canonical_id(item_id))
            if item_index is not None:
                scores[item_index] = -np.inf
        candidates = np.flatnonzero(np.isfinite(scores) & (scores > 0.0))
        ranked = sorted(candidates, key=lambda index: (-float(scores[index]), self.data.item_ids[index]))
        return [self.data.item_ids[index] for index in ranked[:k]]

    def score(self, user_id, item_ids):
        user_index = self.data.user_map.get(canonical_id(user_id))
        if user_index is None:
            return [0.0] * len(item_ids)
        scores = (self.data.user_item_matrix.getrow(user_index) @ self.similarity).toarray().ravel()
        result = []
        for item_id in item_ids:
            index = self.data.item_map.get(canonical_id(item_id))
            result.append(float(scores[index]) if index is not None else 0.0)
        return result

    @property
    def params(self):
        return self._params

class LoadedFactorModel:
    def __init__(self, data, folder, name, params):
        self.data = data
        self.user_factors = np.load(folder / f"{name}_user_factors.npy")
        self.item_factors = np.load(folder / f"{name}_item_factors.npy")
        self._params = params

    def recommend(self, user_id, seen_items, k):
        user_index = self.data.user_map.get(canonical_id(user_id))
        if user_index is None:
            return []
        scores = np.asarray(self.item_factors @ self.user_factors[user_index], dtype=np.float32)
        seen_indices = set(self.data.user_item_matrix.getrow(user_index).indices.tolist())
        for item_id in seen_items:
            index = self.data.item_map.get(canonical_id(item_id))
            if index is not None:
                seen_indices.add(index)
        if seen_indices:
            scores[np.fromiter(seen_indices, dtype=np.int32)] = -np.inf
        available = len(scores) - len(seen_indices)
        limit = min(k, available)
        if limit <= 0:
            return []
        candidates = np.argpartition(scores, -limit)[-limit:]
        ranked = sorted(candidates, key=lambda index: (-float(scores[index]), self.data.item_ids[index]))
        return [self.data.item_ids[index] for index in ranked if np.isfinite(scores[index])][:limit]

    def score(self, user_id, item_ids):
        user_index = self.data.user_map.get(canonical_id(user_id))
        if user_index is None:
            return [0.0] * len(item_ids)
        vector = self.user_factors[user_index]
        result = []
        for item_id in item_ids:
            index = self.data.item_map.get(canonical_id(item_id))
            result.append(float(np.dot(vector, self.item_factors[index])) if index is not None else 0.0)
        return result

    @property
    def params(self):
        return self._params

def load_json(path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)

def create_model(name, data, params):
    if name == "itemcf":
        return LoadedItemCF(data, results_dir, params)
    return LoadedFactorModel(data, results_dir, name, params)

def main(argv=None):
    print(1)
    args = parse_args(argv)
    k_values = sorted(set(args.k_values))
    results_dir.mkdir(parents=True, exist_ok=True)
    settings = load_json(results_dir / "best_parameters.json")
    data = FinalModelData(results_dir)
    split = build_split(interactions_file, items_file, users_file, popularity_file, sample_size, seed, ratio)
    popularity = PopularityRecommender(global_rank=split.global_popularity_rank)
    popularity.fit(split.train_item_popularity, split.item_ids)
    eval_users = sorted({user_id for users in split.scenarios.values() for user_id in users}, key=canonical_id)
    # popularity baseline
    baseline_recs = {
        user_id: popularity.recommend(user_id, split.seen_train.get(user_id, set()), max(k_values))
        for user_id in eval_users
    }
    results = []
    for name in ("itemcf", "als", "bpr"):
        model = create_model(name, data, settings[name]["params"])
        rows, _ = evaluate(model, split, k_values, baseline_recs)
        results.extend(rows)
    write_csv(results_dir / "final_results.csv", results, aggregate_fields)
if __name__ == "__main__":
    main()
