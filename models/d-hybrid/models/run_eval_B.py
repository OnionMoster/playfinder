"""Evaluate the hybrid through B's official framework.

B's evaluate() only scores a fitted model (recommend/score/params), never
fit(). So we fit on the real training rows using B's cutoff, then hand the
fitted model to evaluate() for the same split, cohort and metrics as the
published baselines.
"""

import csv
import json
import sys
import time
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
D_ROOT = HERE.parent
REPOSITORY_ROOT = D_ROOT.parents[1]


B_DIR = REPOSITORY_ROOT / "eval"
if not (B_DIR / "evaluation_core.py").exists():
    raise SystemExit(f"missing integrated evaluation framework: {B_DIR}")
DATA = REPOSITORY_ROOT / "data"
OUT = D_ROOT / "results"
OUT.mkdir(exist_ok=True)
print(f"eval    : {B_DIR}")
print(f"data    : {DATA}")
print(f"results : {OUT}")

BASELINE_CSV = B_DIR / "results" / "baseline_results.csv"
if not BASELINE_CSV.exists():
    print("\n[warn] B's results/baseline_results.csv is missing — the final "
          "comparison table will be skipped. Ask B to re-export it, or copy the "
          "one from his earlier zip (the split is identical).\n")

sys.path.insert(0, str(B_DIR))
from baselines import PopularityRecommender          # noqa: E402
from evaluation_core import build_split, evaluate     # noqa: E402


from hybrid import HybridRecommender                  # noqa: E402

K_VALUES = [5, 10]
SAMPLE_PER_GROUP = 3000      # must match B's evaluate.py
SEED = 42                    # must match B's evaluate.py
TRAIN_RATIO = 0.8            # must match B's evaluate.py

MODEL_KWARGS = dict(
    dim=64, loss="bpr", epochs=15, batch_size=4096, lr=0.02,
    n_neg=30, n_candidates=8192, sparse=True, amp=True, name="hybrid_bpr",
    feature_kwargs=dict(min_df={"default": 20, "developer": 3, "publisher": 3},
                        identity_weight=1.0),
)

print("building B's split (this iterates 22M rows in Python — expect several minutes)",
      flush=True)
t0 = time.time()
split = build_split(
    interactions_path=DATA / "interactions.parquet",
    items_path=DATA / "items.parquet",
    users_path=DATA / "users.parquet",
    item_popularity_path=DATA / "item_popularity.parquet",
    sample_per_group=SAMPLE_PER_GROUP,
    seed=SEED,
    train_ratio=TRAIN_RATIO,
)
print(f"  split built in {time.time() - t0:.0f}s | cutoff={split.cutoff_timestamp} "
      f"| train_rows={split.train_rows:,} | scenarios="
      f"{ {k: len(v) for k, v in split.scenarios.items()} }", flush=True)

# --- sanity: our cutoff must equal the one in B's committed split_summary.json
ref = B_DIR / "results" / "split_summary.json"
if ref.exists():
    with ref.open(encoding="utf-8") as fh:
        published = json.load(fh)
    if int(published["cutoff_timestamp"]) != int(split.cutoff_timestamp):
        raise SystemExit(
            f"CUTOFF MISMATCH: B published {published['cutoff_timestamp']}, "
            f"we computed {split.cutoff_timestamp}. The underlying data differs — "
            f"stop and resolve with B before running anything.")
    print("  cutoff matches B's published split_summary.json", flush=True)

# --- train on the REAL rows, using B's cutoff -------------------------------- #
print("\nloading training interactions", flush=True)
items = pd.read_parquet(DATA / "items.parquet")
inter = pd.read_parquet(DATA / "interactions.parquet")
train = inter[inter.timestamp <= split.cutoff_timestamp]
print(f"  train {len(train):,} rows "
      f"(B counted {split.train_rows:,} — these must agree)", flush=True)
assert len(train) == split.train_rows, "train row count disagrees with B's split"

model = HybridRecommender(items_df=items, **MODEL_KWARGS)
t0 = time.time()
model.fit(train, all_item_ids=items.item_id.to_numpy())
print(f"\nfitted in {time.time() - t0:.0f}s", flush=True)

# --- serendipity reference: popularity model, exactly as B builds it --------- #
pop = PopularityRecommender(global_rank=split.global_popularity_rank)
pop.fit(split.train_item_popularity, split.item_ids)
reference = {u: pop.recommend(u, split.seen_train.get(u, set()), max(K_VALUES))
             for users in split.scenarios.values() for u in users}

# --- evaluate through B's code ---------------------------------------------- #
print("\nevaluating through B's evaluate()", flush=True)
t0 = time.time()
rows, user_rows = evaluate(model=model, split=split, k_values=K_VALUES,
                           reference_recommendations=reference)
print(f"  done in {time.time() - t0:.0f}s", flush=True)

FIELDS = ["model", "scenario", "scope", "k", "users", "precision_at_k", "recall_at_k",
          "ndcg_at_k", "map_at_k", "mrr_at_k", "auc", "rmse", "mae",
          "catalogue_coverage", "user_coverage", "novelty", "intra_list_diversity",
          "serendipity", "params"]
agg_path = OUT / "hybrid_results.csv"
with agg_path.open("w", encoding="utf-8", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=FIELDS)
    w.writeheader()
    w.writerows(rows)
usr_path = OUT / "hybrid_user_metric_values.csv"
with usr_path.open("w", encoding="utf-8", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=["model", "scenario", "scope", "user_id",
                                       "metric", "k", "value"])
    w.writeheader()
    w.writerows(user_rows)
(OUT / "hybrid_params.json").write_text(
    json.dumps({k: str(v) for k, v in model.params.items()}, indent=2), encoding="utf-8")

# --- headline comparison against B's popularity baseline -------------------- #
res = pd.DataFrame(rows)
print("\n" + "=" * 78)
print("HYBRID vs B's popularity baseline   (NDCG@10, overall)")
print("=" * 78)
base = pd.read_csv(BASELINE_CSV) if BASELINE_CSV.exists() else None
for scen in ["all_test_users", "seen_users_only", "new_users_only"]:
    try:
        h = res[(res.scenario == scen) & (res.scope == "overall") & (res.k == 10)].ndcg_at_k.iloc[0]
    except IndexError:
        print(f"  {scen:<18} (no hybrid rows)")
        continue
    if base is None:
        print(f"  {scen:<18} hybrid {h:.6f}   (no baseline file to compare)")
        continue
    try:
        b = base[(base.model == "popularity") & (base.scenario == scen)
                 & (base.scope == "overall") & (base.k == 10)].ndcg_at_k.iloc[0]
        print(f"  {scen:<18} hybrid {h:.6f}   popularity {b:.6f}   "
              f"{'WIN' if h > b else 'LOSS'}")
    except IndexError:
        print(f"  {scen:<18} hybrid {h:.6f}   (baseline row missing)")
print(f"\nwrote {agg_path}\n      {usr_path}")
print("\nreminder: `new_users_only` will be ~0 — the user tower is identity-only, so a "
      "user with no training history has no embedding. That is the honest result and "
      "it is exactly what the onboarding cold-start work is meant to fix.")
