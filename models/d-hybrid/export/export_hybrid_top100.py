"""Export hybrid Top-100 rankings for E's user study.

Fits the delivery model (hybrid_bpr, user tower off) on the handoff-pinned
split, scores each requested user against the shared candidate set, excludes
seen items, and takes the top 100. No taste/genre/test data touches the
ranking. Output validated against the handoff checklist.
"""

import hashlib
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
D_ROOT = HERE.parent
REPOSITORY_ROOT = D_ROOT.parents[1]
DATA = REPOSITORY_ROOT / "data"
HANDOFF = (
    REPOSITORY_ROOT
    / "study-data"
    / "staging"
    / "profile-policy-v2"
    / "a-v1.0-release"
    / "cd-handoff"
)
OUT = HERE
OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(D_ROOT / "models"))
from hybrid import HybridRecommender    # noqa: E402

CUTOFF = 1641340800
CAND_SHA = "01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed"
MODEL_KWARGS = dict(
    dim=64, loss="bpr", epochs=15, batch_size=4096, lr=0.02, n_neg=30,
    n_candidates=8192, sparse=True, amp=True, name="hybrid_bpr",
    user_features=False,      # DELIVERY model: identity user tower, no onboarding
    feature_kwargs=dict(min_df={"default": 20, "developer": 3, "publisher": 3},
                        identity_weight=1.0),
)


def die(msg):
    print(f"\n[STOP] {msg}")
    raise SystemExit(1)


# --- 1. load the handoff request ------------------------------------------- #
req = pd.read_csv(HANDOFF / "model-user-export-request.csv")
cand = pd.read_csv(HANDOFF / "candidate_items.csv")
seen = pd.read_csv(HANDOFF / "profile_seen_items.csv")
print(f"request: {len(req)} profiles | candidate: {len(cand)} | seen rows: {len(seen)}")

if len(req) != 46:
    die(f"expected 46 profiles, got {len(req)}")

# candidate integrity: hash the appid list, newline-joined with trailing newline
cand_ids = [str(int(x)) for x in cand["item_id"]]
h = hashlib.sha256(("\n".join(cand_ids) + "\n").encode()).hexdigest()
if h != CAND_SHA:
    die(f"candidate SHA mismatch: {h}")
print("candidate SHA-256 verified")
cand_set = set(int(x) for x in cand_ids)

seen_map = seen.groupby("model_user_id")["item_id"].apply(
    lambda s: set(int(x) for x in s)).to_dict()

# --- 2. fit the delivery model on the pinned training split ---------------- #
items = pd.read_parquet(DATA / "items.parquet")
inter = pd.read_parquet(DATA / "interactions.parquet")
train = inter[inter.timestamp <= CUTOFF]
print(f"train rows (timestamp <= {CUTOFF}): {len(train):,}")

model = HybridRecommender(items_df=items, **MODEL_KWARGS)
model.fit(train, all_item_ids=items.item_id.to_numpy())
model.save(OUT / "hybrid_bpr_delivery.pkl")
print(f"model saved -> {OUT / 'hybrid_bpr_delivery.pkl'}")

# --- 3. supported-user check (stop, don't substitute) ---------------------- #
requested_users = req["model_user_id"].astype(int).tolist()
unsupported = [(r.profile_id, int(r.model_user_id))
               for r in req.itertuples()
               if int(r.model_user_id) not in model.uidx_]
if unsupported:
    print("\nUNSUPPORTED model users (reporting, not substituting):")
    for pid, uid in unsupported:
        print(f"  {pid}  {uid}")
    die(f"{len(unsupported)} requested users are not in the model. "
        "Per handoff, stop and report these exact ids to E.")
print("all 46 requested users are supported by the model")

# --- 4. score candidates, exclude seen, take top 100 ----------------------- #
cand_arr = np.array(sorted(cand_set), dtype=np.int64)
rows = []
for r in req.itertuples():
    pid, uid = r.profile_id, int(r.model_user_id)
    sc = model.score(uid, cand_arr)                     # native BPR scores
    exclude = seen_map.get(uid, set())
    order = np.argsort(-sc)
    picked, out_scores = [], []
    for idx in order:
        it = int(cand_arr[idx])
        if it in exclude:
            continue
        picked.append(it)
        out_scores.append(float(sc[idx]))
        if len(picked) == 100:
            break
    if len(picked) < 100:
        die(f"{pid}/{uid}: only {len(picked)} candidates after seen exclusion")
    for rk, (it, s) in enumerate(zip(picked, out_scores), start=1):
        rows.append((pid, uid, it, rk, s))

export = pd.DataFrame(rows, columns=["profile_id", "model_user_id",
                                     "item_id", "rank", "score"])

# --- 5. self-validate against the checklist -------------------------------- #
assert len(export) == 4600, f"expected 4600 rows, got {len(export)}"
for pid, g in export.groupby("profile_id"):
    assert len(g) == 100, f"{pid}: {len(g)} rows"
    assert sorted(g["rank"]) == list(range(1, 101)), f"{pid}: ranks not 1-100"
    assert g["item_id"].nunique() == 100, f"{pid}: duplicate items"
    assert set(g["item_id"]) <= cand_set, f"{pid}: item off-candidate"
    uid = int(g["model_user_id"].iloc[0])
    assert not (set(g["item_id"]) & seen_map.get(uid, set())), f"{pid}: seen leak"
assert np.isfinite(export["score"]).all(), "non-finite score"
assert set(export["profile_id"]) == set(req["profile_id"]), "profile set mismatch"

path = OUT / "hybrid_top100.csv"
export.to_csv(path, index=False)
print(f"\nAll checklist assertions passed.")
print(f"wrote {path}  ({len(export)} rows, {export.profile_id.nunique()} profiles)")
print("\nscore range per model native scale: "
      f"[{export.score.min():.4f}, {export.score.max():.4f}]")
print("\nsample (profile-001, top 5):")
print(export[export.profile_id == "profile-001"].head().to_string(index=False))
