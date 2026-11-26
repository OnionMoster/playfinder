"""User cold-start experiment (Section 3.3).

Simulate onboarding without leaking the test set: derive 3-5 content picks
from a user's training items, drop their identity/history, and rank from
those picks alone. Runs through B's evaluate() so every metric is comparable
with the popularity baseline and the full-history hybrid.
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
DATA = REPOSITORY_ROOT / "data"
OUT = D_ROOT / "results"
OUT.mkdir(exist_ok=True)


B_DIR = REPOSITORY_ROOT / "eval"
if not (B_DIR / "evaluation_core.py").exists():
    raise SystemExit(f"missing integrated evaluation framework: {B_DIR}")
sys.path.insert(0, str(B_DIR))
from baselines import PopularityRecommender              # noqa: E402
from evaluation_core import build_split, evaluate        # noqa: E402

from hybrid import HybridRecommender, OnboardingView     # noqa: E402

K_VALUES = [5, 10]
SAMPLE_PER_GROUP, SEED, TRAIN_RATIO = 3000, 42, 0.8
USER_TOP_K = 5          # how many genres/tags the simulated signup collects

MODEL_KWARGS = dict(
    dim=64, loss="bpr", epochs=15, batch_size=4096, lr=0.02, n_neg=30,
    n_candidates=8192, sparse=True, amp=True, name="hybrid_bpr_uf",
    user_features=True, user_top_k=USER_TOP_K,
    feature_kwargs=dict(min_df={"default": 20, "developer": 3, "publisher": 3},
                        identity_weight=1.0),
)

FIELDS = ["model", "scenario", "scope", "k", "users", "precision_at_k", "recall_at_k",
          "ndcg_at_k", "map_at_k", "mrr_at_k", "auc", "rmse", "mae",
          "catalogue_coverage", "user_coverage", "novelty", "intra_list_diversity",
          "serendipity", "params"]
USER_FIELDS = ["model", "scenario", "scope", "user_id", "metric", "k", "value"]


print(f"eval: {B_DIR}", flush=True)
t0 = time.time()
split = build_split(interactions_path=DATA / "interactions.parquet",
                    items_path=DATA / "items.parquet",
                    users_path=DATA / "users.parquet",
                    item_popularity_path=DATA / "item_popularity.parquet",
                    sample_per_group=SAMPLE_PER_GROUP, seed=SEED,
                    train_ratio=TRAIN_RATIO)
print(f"split in {time.time() - t0:.0f}s | cutoff={split.cutoff_timestamp} | "
      f"train_rows={split.train_rows:,}", flush=True)

items = pd.read_parquet(DATA / "items.parquet")
inter = pd.read_parquet(DATA / "interactions.parquet")
train = inter[inter.timestamp <= split.cutoff_timestamp]
assert len(train) == split.train_rows, "train rows disagree with B's split"

model = HybridRecommender(items_df=items, **MODEL_KWARGS)
t0 = time.time()
model.fit(train, all_item_ids=items.item_id.to_numpy())
print(f"fitted in {time.time() - t0:.0f}s", flush=True)

pop = PopularityRecommender(global_rank=split.global_popularity_rank)
pop.fit(split.train_item_popularity, split.item_ids)
reference = {u: pop.recommend(u, split.seen_train.get(u, set()), max(K_VALUES))
             for users in split.scenarios.values() for u in users}

rows, user_rows = [], []
for m in (model, OnboardingView(model, name="hybrid_onboarding")):
    print(f"\nevaluating {m.params['name']}", flush=True)
    t0 = time.time()
    r, ur = evaluate(model=m, split=split, k_values=K_VALUES,
                     reference_recommendations=reference)
    rows += r
    user_rows += ur
    print(f"  {time.time() - t0:.0f}s", flush=True)

with (OUT / "hybrid_coldstart_user_results.csv").open("w", encoding="utf-8",
                                                      newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=FIELDS)
    w.writeheader()
    w.writerows(rows)
with (OUT / "hybrid_coldstart_user_metric_values.csv").open("w", encoding="utf-8",
                                                            newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=USER_FIELDS)
    w.writeheader()
    w.writerows(user_rows)

res = pd.DataFrame(rows)
base = B_DIR / "results" / "baseline_results.csv"
if base.exists():
    res = pd.concat([res, pd.read_csv(base)], ignore_index=True)

print("\n" + "=" * 84)
print("USER COLD START — NDCG@10, overall")
print("=" * 84)
piv = res[(res.scope == "overall") & (res.k == 10)].pivot_table(
    index="model", columns="scenario", values="ndcg_at_k")
print(piv.to_string(float_format=lambda v: f"{v:.6f}"))

try:
    full = piv.loc["hybrid_bpr_uf", "seen_users_only"]
    onb = piv.loc["hybrid_onboarding", "seen_users_only"]
    print(f"\nonboarding retains {onb / full:.1%} of full-history NDCG@10 "
          f"using only {USER_TOP_K} genre/tag picks")
except KeyError:
    pass
print(f"\nwrote {OUT / 'hybrid_coldstart_user_results.csv'}")
