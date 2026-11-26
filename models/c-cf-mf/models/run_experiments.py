import argparse
import json
import time
from pathlib import Path
import numpy as np
import pyarrow.parquet as pq
from scipy import sparse
from cf import ItemCFRecommender
from mf import ALSRecommender, BPRRecommender
root = Path(__file__).resolve().parents[3]
c_root = Path(__file__).resolve().parents[1]
interactions_file = root / "data" / "interactions.parquet"
results_dir = c_root / "results" / "base"
cutoff = 1641340800
batch_size = 500_000
top_k = 10
sample_users = 5
n_jobs = 1
num_threads = 1
random_state = 42
def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", default=("itemcf",))
    parser.add_argument("--neighbors", type=int, default=50)
    parser.add_argument("--max-users", type=int, default=0)
    parser.add_argument("--factors", type=int, default=64)
    parser.add_argument("--regularization", type=float, default=0.01)
    parser.add_argument("--als-alpha", type=float, default=1.0)
    parser.add_argument("--als-iterations", type=int, default=15)
    parser.add_argument("--bpr-learning-rate", type=float, default=0.01)
    parser.add_argument("--bpr-iterations", type=int, default=100)
    return parser.parse_args()

def load_training_arrays(path, cutoff_time, max_users, size, selected_users=None,):
    data = pq.ParquetFile(path)
    user_parts = []
    item_parts = []
    weight_parts = []
    chosen_users = set(selected_users) if selected_users is not None else None
    limited_users = set() if max_users and chosen_users is None else None
    for batch in data.iter_batches(columns=["user_id", "item_id", "label", "confidence", "timestamp"], batch_size=size):
        users = batch.column(0).to_numpy(zero_copy_only=False)
        items = batch.column(1).to_numpy(zero_copy_only=False)
        labels = batch.column(2).to_numpy(zero_copy_only=False)
        confidence = batch.column(3).to_numpy(zero_copy_only=False)
        timestamps = batch.column(4).to_numpy(zero_copy_only=False)
        # keep positive train rows
        keep = (timestamps <= cutoff_time) & (labels == 1)
        if chosen_users is not None:
            chosen = np.asarray(list(chosen_users), dtype=users.dtype)
            keep &= np.isin(users, chosen)
        elif limited_users is not None:
            eligible_users = users[keep]
            if len(limited_users) < max_users:
                for user_id in eligible_users:
                    limited_users.add(user_id.item() if hasattr(user_id, "item") else user_id)
                    if len(limited_users) == max_users:
                        break
            chosen = np.fromiter(limited_users, dtype=users.dtype, count=len(limited_users))
            keep &= np.isin(users, chosen)
        weights = np.asarray(confidence[keep], dtype=np.float32)
        positive = weights > 0.0
        user_parts.append(np.asarray(users[keep][positive]))
        item_parts.append(np.asarray(items[keep][positive]))
        weight_parts.append(weights[positive])
    return np.concatenate(user_parts), np.concatenate(item_parts), np.concatenate(weight_parts)

def build_user_item_matrix(users, items, weights,):
    user_ids, rows = np.unique(users, return_inverse=True)
    item_ids, columns = np.unique(items, return_inverse=True)
    matrix = sparse.coo_matrix(
        (weights.astype(np.float32, copy=False), (rows, columns)),
        shape=(len(user_ids), len(item_ids)),
        dtype=np.float32,
    ).tocsr()
    matrix.sum_duplicates()
    matrix.eliminate_zeros()
    return matrix, user_ids, item_ids

def sample_recommendations(model, count, k):
    activity = np.diff(model.user_item_matrix.indptr)
    chosen = np.argsort(activity)[-count:][::-1]
    examples = []
    for user_index in chosen:
        user_id = model.user_ids[int(user_index)]
        seen_indices = model.user_item_matrix.getrow(int(user_index)).indices
        seen_items = {model.item_ids[index] for index in seen_indices}
        recommendations = model.recommend(user_id, seen_items, k)
        row = {
            "user_id": user_id,
            "seen_items": len(seen_items),
            "recommendations": recommendations,
        }
        explain = getattr(model, "explain", None)
        if callable(explain):
            row["explanations"] = {
                item_id: explain(user_id, item_id, n=3)
                for item_id in recommendations
            }
        examples.append(row)
    return examples

def create_model(name, args):
    if name == "itemcf":
        return ItemCFRecommender(n_neighbors=args.neighbors, n_jobs=n_jobs)
    if name == "als":
        return ALSRecommender(
            factors=args.factors,
            regularization=args.regularization,
            alpha=args.als_alpha,
            iterations=args.als_iterations,
            num_threads=num_threads,
            random_state=random_state,
        )
    return BPRRecommender(
        factors=args.factors,
        regularization=args.regularization,
        learning_rate=args.bpr_learning_rate,
        iterations=args.bpr_iterations,
        num_threads=num_threads,
        random_state=random_state,
    )

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)

def main():
    print(1)
    args = parse_args()
    users, items, weights = load_training_arrays(
        interactions_file,
        cutoff,
        args.max_users,
        batch_size,
    )
    user_item_matrix, user_ids, item_ids = build_user_item_matrix(users, items, weights)
    del users, items, weights
    density = user_item_matrix.nnz / (user_item_matrix.shape[0] * user_item_matrix.shape[1])
    results_dir.mkdir(parents=True, exist_ok=True)
    models = []
    for name in args.models:
        model = create_model(name, args)
        start = time.perf_counter()
        model.fit(user_item_matrix, user_ids, item_ids)
        seconds = time.perf_counter() - start
        examples = sample_recommendations(model, sample_users, top_k)
        sample_path = results_dir / f"{name}_sample_recommendations.json"
        write_json(sample_path, examples)
        models.append({
            "model": name,
            "params": model.params,
            "fit_seconds": round(seconds, 3),
            "sample_recommendations_path": str(sample_path.resolve()),
        })
        del model
    summary = {
        "interactions_path": str(interactions_file.resolve()),
        "cutoff_timestamp": cutoff,
        "positive_only": True,
        "max_users": args.max_users,
        "train_rows": int(user_item_matrix.nnz),
        "train_users": int(user_item_matrix.shape[0]),
        "train_items": int(user_item_matrix.shape[1]),
        "matrix_density": density,
        "models": models,
    }
    write_json(results_dir / "model_comparison_summary.json", summary)
if __name__ == "__main__":
    main()
