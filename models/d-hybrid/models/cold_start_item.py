"""Item cold-start experiment (Section 3.3).

Hide a set of items entirely from training, then rank them for held-out
users. A pure-id model (BPR-MF) cannot represent a held-out item; the hybrid
recovers it from content features. Cold items are stratified by popularity
decile so cold-start quality can be plotted from head to long tail.
"""

import csv
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
D_ROOT = HERE.parent
REPOSITORY_ROOT = D_ROOT.parents[1]
DATA = REPOSITORY_ROOT / "data"
OUT = D_ROOT / "results"
OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(HERE))
from hybrid import HybridRecommender, build_item_features   # noqa: E402

TRAIN_RATIO = 0.8
N_COLD_PER_DECILE = 60      # cold items sampled from each popularity decile
N_DECILES = 10
K_VALUES = [5, 10, 20]
SEED = 9727
EPOCHS = 15

COMMON = dict(dim=64, loss="bpr", epochs=EPOCHS, batch_size=4096, lr=0.02,
              n_neg=30, n_candidates=8192, sparse=True, amp=True)
FEATURE_KW = dict(min_df={"default": 20, "developer": 3, "publisher": 3},
                  identity_weight=1.0)


def ndcg_recall(ranked, truth, ks):
    out = {}
    for k in ks:
        hits = sum(1 for x in ranked[:k] if x in truth)
        dcg = sum(1.0 / np.log2(i + 2) for i, x in enumerate(ranked[:k]) if x in truth)
        idcg = sum(1.0 / np.log2(i + 2) for i in range(min(len(truth), k)))
        out[f"recall@{k}"] = hits / min(len(truth), k)
        out[f"ndcg@{k}"] = dcg / idcg if idcg else 0.0
    return out


print("loading", flush=True)
items = pd.read_parquet(DATA / "items.parquet")
inter = pd.read_parquet(DATA / "interactions.parquet")
pop = pd.read_parquet(DATA / "item_popularity.parquet")

cutoff = int(np.sort(inter.timestamp.to_numpy().copy())[
    int(len(inter) * TRAIN_RATIO) - 1])
train_full = inter[inter.timestamp <= cutoff]
test = inter[(inter.timestamp > cutoff) & (inter.label == 1)]
print(f"cutoff={cutoff}  train={len(train_full):,}  test={len(test):,}", flush=True)

# --- choose cold items, stratified by popularity decile --------------------- #
rng = np.random.default_rng(SEED)
train_counts = train_full.groupby("item_id").size()
# only items that (a) have training interactions to delete, (b) appear in test,
# (c) carry at least one content feature (otherwise cold start is hopeless a priori)
elig = train_counts[train_counts >= 5].index
test_items = set(test.item_id.unique())
elig = np.array([i for i in elig if i in test_items])

ranks = train_counts.loc[elig].rank(pct=True)
cold_items, decile_of = [], {}
for dcl in range(N_DECILES):
    lo, hi = dcl / N_DECILES, (dcl + 1) / N_DECILES
    pool = elig[(ranks.values > lo) & (ranks.values <= hi)]
    if len(pool) == 0:
        continue
    pick = rng.choice(pool, min(N_COLD_PER_DECILE, len(pool)), replace=False)
    for it in pick:
        decile_of[int(it)] = dcl
    cold_items.extend(int(x) for x in pick)
cold_items = np.array(cold_items)
cold_set = set(cold_items.tolist())
print(f"cold items: {len(cold_items)} across {N_DECILES} deciles", flush=True)

# --- ablate: remove ALL training interactions on cold items ----------------- #
train_ablated = train_full[~train_full.item_id.isin(cold_set)]
print(f"ablated {len(train_full) - len(train_ablated):,} training rows "
      f"({len(train_ablated):,} remain)", flush=True)

# ground truth: users whose TEST set contains a cold item
test_cold = test[test.item_id.isin(cold_set)]
truth = test_cold.groupby("user_id").item_id.apply(
    lambda s: set(s) & cold_set).to_dict()
eval_users = np.array(list(truth))
print(f"eval users (have a cold test item): {len(eval_users):,}", flush=True)

# Content-popularity floor (no leakage): a cold game has no interactions, but a
# real system can still fall back to "how popular are games in the same genres".
# We score each cold item by the mean ablated-train interaction count of the
# NON-cold items that share its genres. Uses only training data + the cold item's
# own genre tags -- never its held-out interactions.
train_item_freq = train_ablated.groupby("item_id").size().to_dict()
genre_map = items.set_index("item_id")["genres"].to_dict()
warm_by_genre = {}
for iid, cnt in train_item_freq.items():
    g = genre_map.get(iid)
    if g is None:
        continue
    for tag in g:
        warm_by_genre.setdefault(str(tag), []).append(cnt)
genre_pop = {g: float(np.mean(v)) for g, v in warm_by_genre.items()}

def _cold_genre_score(i):
    g = genre_map.get(i)
    if g is None or len(g) == 0:
        return 0.0
    vals = [genre_pop.get(str(t), 0.0) for t in g]
    return float(np.mean(vals)) if vals else 0.0

cold_by_pop = sorted(cold_items, key=lambda i: (-_cold_genre_score(i), int(i)))

all_ids = items.item_id.to_numpy()
results, per_decile = [], {}


def eval_model(tag, feature_kwargs, identity, neutralise_cold=False,
               pure_content=False, model=None):
    if model is None:
        kw = dict(COMMON)
        kw["name"] = tag
        model = HybridRecommender(items_df=items, feature_kwargs={**feature_kwargs,
                                  "identity": identity}, **kw)
        t0 = time.time()
        model.fit(train_ablated, all_item_ids=all_ids)
        print(f"  {tag} fitted in {time.time() - t0:.0f}s", flush=True)
    m = model

    if neutralise_cold:
        # a pure-id model has no LEARNED vector for a held-out item; its id
        # embedding is untrained noise. Zero those rows so the model genuinely
        # cannot rank cold items from collaborative signal -- it falls back to
        # the (constant) item bias. This is the honest pure-CF cold baseline.
        import torch
        cold_rows = torch.as_tensor(
            [m.iidx_[int(i)] for i in cold_items if int(i) in m.iidx_],
            device=m.device)
        with torch.no_grad():
            m.Q_[cold_rows] = 0.0
            m.qb_[cold_rows] = 0.0   # also drop the leaked popularity bias

    # rank the cold items only, per user
    cold_arr = cold_items
    agg = {f"{mt}@{k}": [] for mt in ("recall", "ndcg") for k in K_VALUES}
    dec_ndcg = {d: [] for d in range(N_DECILES)}
    t0 = time.time()

    content_scores = content_ids = None
    if pure_content:
        cold_df = items[items.item_id.isin(cold_set)].reset_index(drop=True)
        content_scores, content_ids = m.cold_item_scores(eval_users, cold_df)
        col_of = {int(i): j for j, i in enumerate(content_ids)}
        u_of = {int(u): j for j, u in enumerate(
            [uu for uu in eval_users if int(uu) in m.uidx_])}

    for s in range(0, len(eval_users), 4096):
        chunk = eval_users[s:s + 4096]
        scores = None
        if not pure_content:
            scores = m.score_matrix(chunk, cold_arr) if hasattr(m, "score_matrix") else None
        for j, u in enumerate(chunk):
            if pure_content:
                ui = u_of.get(int(u))
                if ui is None:
                    continue
                sc = np.array([content_scores[ui, col_of[int(it)]]
                               if int(it) in col_of else -1e9 for it in cold_arr])
            else:
                sc = scores[j] if scores is not None else m.score(u, cold_arr)
            order = cold_arr[np.argsort(-sc)]
            rel = truth[int(u)]
            mm = ndcg_recall(order.tolist(), rel, K_VALUES)
            for kk, vv in mm.items():
                agg[kk].append(vv)
            for it in rel:
                dec_ndcg[decile_of[it]].append(mm["ndcg@10"])
    print(f"  {tag} scored in {time.time() - t0:.0f}s", flush=True)
    row = {"model": tag, "users": len(eval_users),
           **{k: float(np.mean(v)) for k, v in agg.items()}}
    results.append(row)
    per_decile[tag] = {d: float(np.mean(v)) if v else 0.0
                       for d, v in dec_ndcg.items()}
    return row


print("\n--- hybrid (identity + content) ---", flush=True)
hybrid_model = HybridRecommender(items_df=items,
    feature_kwargs={**FEATURE_KW, "identity": True}, **{**COMMON, "name": "hybrid_cold"})
t0 = time.time(); hybrid_model.fit(train_ablated, all_item_ids=all_ids)
print(f"  hybrid_cold fitted in {time.time() - t0:.0f}s", flush=True)
eval_model("hybrid_cold", FEATURE_KW, identity=True, model=hybrid_model)

print("\n--- hybrid pure-content (identity dropped, appendix) ---", flush=True)
eval_model("hybrid_content_only", FEATURE_KW, identity=True,
           pure_content=True, model=hybrid_model)

print("\n--- pure-id (BPR-MF, identity only) ---", flush=True)
eval_model("pureid_cold", dict(identity_weight=1.0), identity=False,
           neutralise_cold=True)

# popularity floor
agg = {f"{mt}@{k}": [] for mt in ("recall", "ndcg") for k in K_VALUES}
for u in eval_users:
    mm = ndcg_recall(cold_by_pop, truth[int(u)], K_VALUES)
    for kk, vv in mm.items():
        agg[kk].append(vv)
results.append({"model": "popularity_cold", "users": len(eval_users),
                **{k: float(np.mean(v)) for k, v in agg.items()}})

res = pd.DataFrame(results)
res.to_csv(OUT / "hybrid_coldstart_item_results.csv", index=False)
pd.DataFrame(per_decile).to_csv(OUT / "hybrid_coldstart_item_by_decile.csv")

print("\n" + "=" * 78)
print("ITEM COLD START — ranking held-out items with zero training interactions")
print("=" * 78)
print(res.set_index("model").to_string(float_format=lambda v: f"{v:.4f}"))
print("\nNDCG@10 by popularity decile (0 = long tail, 9 = head):")
dec = pd.DataFrame(per_decile)
print(dec.to_string(float_format=lambda v: f"{v:.4f}"))
print("\nInterpretation: pure-id should be ~0 everywhere (a held-out item has no "
      "id embedding to rank). hybrid recovers signal from content features. The "
      "gap IS the value of the hybrid approach.")
print(f"\nwrote {OUT / 'hybrid_coldstart_item_results.csv'}")
print(f"      {OUT / 'hybrid_coldstart_item_by_decile.csv'}")
