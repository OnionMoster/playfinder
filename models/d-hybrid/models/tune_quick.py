"""Quick loss/lr tuning on a user subsample before full-data runs.

The Recall/NDCG printed here are an internal tuning signal only, not report
numbers; official figures come from B's evaluate() on B's split.
"""

import time
from pathlib import Path

import numpy as np
import pandas as pd

from hybrid import HybridRecommender

HERE = Path(__file__).resolve().parent
D_ROOT = HERE.parent
REPOSITORY_ROOT = D_ROOT.parents[1]
DATA = REPOSITORY_ROOT / "data"
N_USERS = 150_000          # subsample for speed
TEST_QUANTILE = 0.80       # matches B's train_ratio=0.8
N_EVAL_USERS = 3_000
K = 10
EPOCHS = 15

GRID = [
    dict(loss="bpr",  lr=0.02, n_neg=30),
    dict(loss="warp", lr=0.02, warp_negative="sample"),
]
BASE = dict(dim=64, batch_size=4096, n_candidates=8192, sparse=True, amp=True,
            feature_kwargs=dict(min_df={"default": 20, "developer": 3,
                                        "publisher": 3},
                                identity_weight=1.0))


def ndcg_at_k(ranked, relevant, k):
    dcg = sum(1.0 / np.log2(r + 2) for r, it in enumerate(ranked[:k]) if it in relevant)
    idcg = sum(1.0 / np.log2(r + 2) for r in range(min(len(relevant), k)))
    return dcg / idcg if idcg > 0 else 0.0


print("loading ...")
items = pd.read_parquet(DATA / "items.parquet")
inter = pd.read_parquet(DATA / "interactions.parquet")

rng = np.random.default_rng(9727)
keep = rng.choice(inter.user_id.unique(),
                  size=min(N_USERS, inter.user_id.nunique()), replace=False)
inter = inter[inter.user_id.isin(keep)]

cut = inter.timestamp.quantile(TEST_QUANTILE)
train = inter[inter.timestamp <= cut]
test = inter[(inter.timestamp > cut) & (inter.label == 1)]
test = test[test.user_id.isin(train.user_id.unique())]
print(f"train {len(train):,} rows / {train.user_id.nunique():,} users | "
      f"test {len(test):,} rows / {test.user_id.nunique():,} users | cut={cut}")

# ground truth + what to exclude
truth = test.groupby("user_id").item_id.apply(set).to_dict()
eval_users = list(truth)
if len(eval_users) > N_EVAL_USERS:
    eval_users = list(rng.choice(eval_users, N_EVAL_USERS, replace=False))
seen_map = (train[train.user_id.isin(eval_users)]
            .groupby("user_id").item_id.apply(list).to_dict())
print(f"evaluating on {len(eval_users):,} users\n")

all_items = items.item_id.to_numpy()
rows = []

for cfg in GRID:
    tag = "_".join(f"{k}{v}" for k, v in cfg.items())
    print("=" * 70)
    print(tag)
    print("=" * 70)
    m = HybridRecommender(items_df=items, epochs=EPOCHS, verbose=True,
                          **BASE, **cfg)
    t0 = time.time()
    m.fit(train, all_item_ids=all_items)
    fit_s = time.time() - t0

    recs = m.recommend_batch(eval_users, k=K, seen_map=seen_map)
    rec_all, ndcg_all = [], []
    for u, r in zip(eval_users, recs):
        rel = truth[u]
        hits = len(set(r) & rel)
        rec_all.append(hits / min(len(rel), K))
        ndcg_all.append(ndcg_at_k(list(r), rel, K))
    rec, ndcg = float(np.mean(rec_all)), float(np.mean(ndcg_all))
    cov = len(np.unique(recs)) / len(all_items)

    print(f"\n  loss  {m.history_[0]:.4f} -> {m.history_[-1]:.4f}"
          f"   ({'DROPPING' if m.history_[-1] < m.history_[0] * 0.97 else 'FLAT - check lr'})")
    print(f"  Recall@{K} {rec:.4f}   NDCG@{K} {ndcg:.4f}   "
          f"catalogue coverage {cov:.3f}   fit {fit_s:.0f}s\n")
    rows.append(dict(config=tag, **cfg, mean_rank=getattr(m, "_last_rank", None),
                     first_loss=m.history_[0],
                     last_loss=m.history_[-1], recall=rec, ndcg=ndcg,
                     coverage=cov, fit_seconds=round(fit_s)))

res = pd.DataFrame(rows).sort_values("ndcg", ascending=False)
print("=" * 70)
print("SUMMARY  (internal tuning signal, NOT report numbers)")
print("=" * 70)
print(res.to_string(index=False))
best = res.iloc[0]
print(f"\nbest: {best.config}")
print("next: rerun the winner on the FULL user set with more epochs.")
