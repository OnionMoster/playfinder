import argparse
import csv
from pathlib import Path
import numpy as np
here = Path(__file__).resolve().parent
c_root = here.parent
root = c_root.parents[1]
default_handoff = root / "study-data" / "staging" / "profile-policy-v2" / "a-v1.0-release" / "cd-handoff"
default_model = c_root / "results"
default_output = here / "bpr_top100.csv"
top_k = 100
fields = ["profile_id", "model_user_id", "item_id", "rank", "score"]
def parse_args():
    parser = argparse.ArgumentParser(description="Export BPR Top-100 rankings.")
    parser.add_argument("--handoff-dir", type=Path, default=default_handoff)
    parser.add_argument("--model-dir", type=Path, default=default_model)
    parser.add_argument("--output", type=Path, default=default_output)
    return parser.parse_args()

def read_csv(path):
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))

def find_indices(values, wanted_ids):
    wanted = set(wanted_ids)
    return {int(value): index for index, value in enumerate(values) if int(value) in wanted}

def main():
    print(1)
    args = parse_args()
    handoff_dir = args.handoff_dir.resolve()
    model_dir = args.model_dir.resolve()
    output = args.output.resolve()
    requests = read_csv(handoff_dir / "model-user-export-request.csv")
    candidates = read_csv(handoff_dir / "candidate_items.csv")
    seen_rows = read_csv(handoff_dir / "profile_seen_items.csv")
    candidate_ids = [int(row["item_id"]) for row in candidates]
    seen_items = {}
    for row in seen_rows:
        profile_id = row["profile_id"].strip()
        if profile_id not in seen_items:
            seen_items[profile_id] = set()
        seen_items[profile_id].add(int(row["item_id"]))
    user_ids = np.load(model_dir / "user_ids.npy")
    item_ids = np.load(model_dir / "item_ids.npy")
    user_factors = np.load(model_dir / "bpr_user_factors.npy")
    item_factors = np.load(model_dir / "bpr_item_factors.npy")
    requested_users = [int(row["model_user_id"]) for row in requests]
    user_index = find_indices(user_ids, requested_users)
    item_index = find_indices(item_ids, candidate_ids)
    candidate_array = np.asarray(candidate_ids, dtype=np.int64)
    positions = np.asarray([item_index[item_id] for item_id in candidate_ids])
    factors = np.asarray(item_factors[positions])
    lookup = {item_id: position for position, item_id in enumerate(candidate_ids)}
    rows = []
    for request in requests:
        profile_id = request["profile_id"].strip()
        user_id = int(request["model_user_id"])
        scores = np.asarray(factors @ user_factors[user_index[user_id]], dtype=np.float32)
        # remove seen games
        for seen_item_id in seen_items.get(profile_id, set()):
            position = lookup.get(seen_item_id)
            if position is not None:
                scores[position] = -np.inf
        ranking = np.argsort(scores)[::-1][:top_k]
        for rank, position in enumerate(ranking, start=1):
            rows.append({
                "profile_id": profile_id,
                "model_user_id": user_id,
                "item_id": int(candidate_array[position]),
                "rank": rank,
                "score": format(float(scores[position]), ".9g"),
            })
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
if __name__ == "__main__":
    main()
