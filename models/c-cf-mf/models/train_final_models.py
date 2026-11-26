import json
import time
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pyarrow.parquet as pq
from scipy import sparse
from cf import ItemCFRecommender
from mf import ALSRecommender, BPRRecommender
from run_experiments import build_user_item_matrix, load_training_arrays, write_json
root = Path(__file__).resolve().parents[3]
c_root = Path(__file__).resolve().parents[1]
interactions_file = root / "data" / "interactions.parquet"
results_dir = c_root / "results"
parameters_file = results_dir / "best_parameters.json"
ratio = 0.80
batch_size = 500_000
def final_training_cutoff():
    table = pq.read_table(interactions_file, columns=["timestamp"])
    timestamps = np.array(table.column(0).to_numpy(), copy=True)
    timestamps.sort()
    # same split as evaluation
    index = max(0, min(len(timestamps) - 1, int(len(timestamps) * ratio) - 1))
    return int(timestamps[index])

def load_json(path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)

def create_model(name, params):
    if name == "itemcf":
        return ItemCFRecommender(n_neighbors=int(params["n_neighbors"]), n_jobs=1)
    if name == "als":
        return ALSRecommender(
            factors=int(params["factors"]),
            regularization=float(params["regularization"]),
            alpha=float(params["alpha"]),
            iterations=int(params["iterations"]),
            num_threads=1,
            random_state=42,
            calculate_training_loss=bool(params["calculate_training_loss"]),
        )
    return BPRRecommender(
        factors=int(params["factors"]),
        learning_rate=float(params["learning_rate"]),
        regularization=float(params["regularization"]),
        iterations=int(params["iterations"]),
        verify_negative_samples=bool(params["verify_negative_samples"]),
        num_threads=1,
        random_state=42,
    )

def save_model(folder, name, model):
    if name == "itemcf":
        path = folder / "itemcf_similarity.npz"
        sparse.save_npz(path, model.item_similarity)
        return [path.name]
    user_file = folder / f"{name}_user_factors.npy"
    item_file = folder / f"{name}_item_factors.npy"
    np.save(user_file, model.model.user_factors)
    np.save(item_file, model.model.item_factors)
    return [user_file.name, item_file.name]

def main():
    print(1)
    start = time.perf_counter()
    folder = results_dir
    folder.mkdir(parents=True, exist_ok=True)
    settings = load_json(parameters_file)
    cutoff_time = final_training_cutoff()
    load_start = time.perf_counter()
    users, items, weights = load_training_arrays(interactions_file, cutoff_time, 0, batch_size)
    user_item_matrix, user_ids, item_ids = build_user_item_matrix(users, items, weights)
    load_seconds = time.perf_counter() - load_start
    sparse.save_npz(folder / "user_item_matrix.npz", user_item_matrix)
    np.save(folder / "user_ids.npy", user_ids)
    np.save(folder / "item_ids.npy", item_ids)
    summary = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "training_ratio": ratio,
        "cutoff_timestamp": cutoff_time,
        "test_data_used": False,
        "positive_only": True,
        "single_threaded": True,
        "random_state": 42,
        "best_parameters_path": str(parameters_file.resolve()),
        "train_users": int(user_item_matrix.shape[0]),
        "train_items": int(user_item_matrix.shape[1]),
        "train_interactions": int(user_item_matrix.nnz),
        "load_and_matrix_seconds": round(load_seconds, 3),
        "shared_files": ["user_item_matrix.npz", "user_ids.npy", "item_ids.npy", "best_parameters.json"],
        "models": [],
    }
    for name in ("itemcf", "als", "bpr"):
        params = settings[name]["params"]
        model = create_model(name, params)
        fit_start = time.perf_counter()
        model.fit(user_item_matrix, user_ids, item_ids)
        seconds = time.perf_counter() - fit_start
        files = save_model(folder, name, model)
        summary["models"].append({
            "name": name,
            "params": model.params,
            "fit_seconds": round(seconds, 3),
            "files": files,
        })
    summary["completed_at_utc"] = datetime.now(timezone.utc).isoformat()
    summary["last_run_seconds"] = round(time.perf_counter() - start, 3)
    model_seconds = sum(float(entry["fit_seconds"]) for entry in summary["models"])
    summary["recorded_seconds"] = round(float(summary["load_and_matrix_seconds"]) + model_seconds, 3)
    write_json(folder / "final_training_summary.json", summary)
if __name__ == "__main__":
    main()
