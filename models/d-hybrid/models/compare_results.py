"""Merge D's results with B's baselines into one comparison table.

Reads results/*_results.csv (picks up C's files too) plus B's
baseline_results.csv; writes results/comparison_table.csv.
"""

from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
D_ROOT = HERE.parent
REPOSITORY_ROOT = D_ROOT.parents[1]
OUT = D_ROOT / "results"


B_DIR = REPOSITORY_ROOT / "eval"
BASELINE_RESULTS = B_DIR / "results" / "baseline_results.csv"
if not BASELINE_RESULTS.exists():
    raise SystemExit(f"missing integrated baseline results: {BASELINE_RESULTS}")


frames = []
for p in sorted(OUT.glob("*_results.csv")):        # picks up C's files too, once they land
    if p.name == "comparison_table.csv":
        continue
    frames.append(pd.read_csv(p))
frames.append(pd.read_csv(BASELINE_RESULTS))
df = pd.concat(frames, ignore_index=True).drop_duplicates(
    subset=["model", "scenario", "scope", "k"], keep="first")

ACC = ["ndcg_at_k", "recall_at_k", "precision_at_k", "map_at_k", "mrr_at_k"]
BEYOND = ["catalogue_coverage", "user_coverage", "novelty",
          "intra_list_diversity", "serendipity"]
DIAG = ["auc", "rmse", "mae"]


def show(title, sub, cols):
    print("\n" + "=" * 100)
    print(title)
    print("=" * 100)
    keep = [c for c in cols if c in sub.columns]
    t = sub.set_index("model")[["users"] + keep]
    print(t.to_string(float_format=lambda v: f"{v:.6f}"))


main = df[(df.scenario == "all_test_users") & (df.scope == "overall") & (df.k == 10)]
show("ACCURACY  @10, all test users, overall", main, ACC)
show("BEYOND-ACCURACY  @10, all test users, overall", main, BEYOND)
show("DIAGNOSTIC  @10, all test users, overall", main, DIAG)

print("\n" + "=" * 100)
print("NDCG@10 by scenario")
print("=" * 100)
piv = df[(df.scope == "overall") & (df.k == 10)].pivot_table(
    index="model", columns="scenario", values="ndcg_at_k")
print(piv.to_string(float_format=lambda v: f"{v:.6f}"))

print("\n" + "=" * 100)
print("NDCG@10 by user group  (all_test_users)")
print("=" * 100)
grp = df[(df.scenario == "all_test_users") & (df.k == 10)
         & (df.scope.isin(["cold", "normal", "heavy"]))].pivot_table(
    index="model", columns="scope", values="ndcg_at_k")
print(grp.reindex(columns=[c for c in ["cold", "normal", "heavy"] if c in grp.columns]
                  ).to_string(float_format=lambda v: f"{v:.6f}"))

out = OUT / "comparison_table.csv"
df.sort_values(["scenario", "scope", "k", "model"]).to_csv(out, index=False)
print(f"\nwrote {out}")
print(f"models present: {sorted(df.model.unique())}")
