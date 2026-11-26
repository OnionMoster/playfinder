from __future__ import annotations

import csv
import importlib.util
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from baselines import PopularityRecommender, canonical_id
from evaluation_core import (
    build_split,
    build_split_summary,
    build_train_tie_break_rank,
    evaluate,
    write_csv,
    write_significance_tests,
)


B_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = B_DIR.parent
A_OUTPUT_DIR = REPOSITORY_ROOT / "data"
C_RESULTS_DIR = REPOSITORY_ROOT / "models" / "c-cf-mf" / "results"
D_MODELS_DIR = REPOSITORY_ROOT / "models" / "d-hybrid" / "models"
D_RESULTS_DIR = REPOSITORY_ROOT / "models" / "d-hybrid" / "results"
FINAL_DIR = B_DIR / "final_eval"

INTERACTIONS_PATH = A_OUTPUT_DIR / "interactions.parquet"
ITEMS_PATH = A_OUTPUT_DIR / "items.parquet"
USERS_PATH = A_OUTPUT_DIR / "users.parquet"
ITEM_POPULARITY_PATH = A_OUTPUT_DIR / "item_popularity.parquet"

K_VALUES = [5, 10]
SAMPLE_PER_GROUP = 3000
SEED = 42
TRAIN_RATIO = 0.8

AGGREGATE_FIELDS = [
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
USER_METRIC_FIELDS = ["model", "scenario", "scope", "user_id", "metric", "k", "value"]


@dataclass
class ModelAlias:
    name: str
    model: object

    def recommend(self, user_id: object, seen_items: set[object], k: int) -> list[object]:
        return self.model.recommend(user_id, seen_items, k)

    def score(self, user_id: object, item_ids: list[object]) -> list[float]:
        return self.model.score(user_id, item_ids)

    @property
    def params(self) -> dict[str, object]:
        params = dict(getattr(self.model, "params", {}))
        params["name"] = self.name
        return params


def load_hybrid_class():
    module_path = D_MODELS_DIR / "hybrid.py"
    spec = importlib.util.spec_from_file_location("d_hybrid_module", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 D 的 hybrid 模块: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["d_hybrid_module"] = module
    spec.loader.exec_module(module)
    return module.HybridRecommender


def to_int_item_ids(item_ids: list[object]) -> list[int]:
    return [int(item_id.item()) if hasattr(item_id, "item") else int(item_id) for item_id in item_ids]


def normalize_model_name(row: dict[str, object]) -> dict[str, object]:
    updated = dict(row)
    model_name = str(updated["model"])
    if model_name == "hybrid_bpr_shared":
        updated["model"] = "hybrid"
    return updated


def filter_rows_by_model(rows: list[dict[str, object]], allowed: set[str]) -> list[dict[str, object]]:
    return [dict(row) for row in rows if str(row["model"]) in allowed]


def export_popularity_top100(
    path: Path,
    model: PopularityRecommender,
    split,
    user_ids: list[object],
) -> None:
    rows: list[dict[str, object]] = []
    for user_id in user_ids:
        recommendations = model.recommend(user_id, split.seen_train.get(user_id, set()), 100)
        for rank, item_id in enumerate(recommendations, start=1):
            item_key = canonical_id(item_id)
            rows.append(
                {
                    "profile_id": canonical_id(user_id),
                    "user_id": canonical_id(user_id),
                    "item_id": int(item_key),
                    "rank": rank,
                    "score": float(model.popularity_scores.get(item_key, 0.0)),
                }
            )
    write_csv(path, rows, ["profile_id", "user_id", "item_id", "rank", "score"])


def load_csv_rows(path: Path) -> list[dict[str, object]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> None:
    FINAL_DIR.mkdir(parents=True, exist_ok=True)

    split = build_split(
        interactions_path=INTERACTIONS_PATH,
        items_path=ITEMS_PATH,
        users_path=USERS_PATH,
        item_popularity_path=ITEM_POPULARITY_PATH,
        sample_per_group=SAMPLE_PER_GROUP,
        seed=SEED,
        train_ratio=TRAIN_RATIO,
    )
    split_summary = build_split_summary(split, K_VALUES)

    train_tie_break_rank = build_train_tie_break_rank(
        split.train_item_popularity,
        split.train_item_interactions,
    )
    shared_candidate_item_ids = [
        item_id for item_id in split.item_ids if canonical_id(item_id) in split.train_item_popularity
    ]
    shared_candidate_item_ids_int = to_int_item_ids(shared_candidate_item_ids)

    popularity_model = PopularityRecommender(tie_break_rank=train_tie_break_rank)
    popularity_model.fit(split.train_item_popularity, shared_candidate_item_ids)

    evaluation_users = sorted(split.scenarios["all_test_users"], key=canonical_id)
    reference_recommendations = {
        user_id: popularity_model.recommend(user_id, split.seen_train.get(user_id, set()), max(K_VALUES))
        for user_id in evaluation_users
    }

    export_popularity_top100(
        FINAL_DIR / "popularity_top100.csv",
        popularity_model,
        split,
        evaluation_users,
    )

    popularity_rows, popularity_user_rows = evaluate(
        model=popularity_model,
        split=split,
        k_values=K_VALUES,
        reference_recommendations=reference_recommendations,
    )
    write_csv(FINAL_DIR / "popularity_shared_results.csv", popularity_rows, AGGREGATE_FIELDS)
    write_csv(FINAL_DIR / "popularity_shared_user_metric_values.csv", popularity_user_rows, USER_METRIC_FIELDS)

    HybridRecommender = load_hybrid_class()
    items = pd.read_parquet(ITEMS_PATH)
    interactions = pd.read_parquet(INTERACTIONS_PATH)
    train = interactions[interactions["timestamp"] <= split.cutoff_timestamp]

    hybrid_model = HybridRecommender(
        dim=64,
        loss="bpr",
        epochs=15,
        batch_size=4096,
        lr=0.02,
        n_neg=30,
        n_candidates=8192,
        sparse=True,
        amp=True,
        name="hybrid_bpr_shared",
        feature_kwargs={
            "min_df": {"default": 20, "developer": 3, "publisher": 3},
            "identity_weight": 1.0,
        },
    )
    hybrid_model.fit(train, all_item_ids=np.asarray(shared_candidate_item_ids_int, dtype=np.int64), item_df=items)
    hybrid_alias = ModelAlias("hybrid_bpr_shared", hybrid_model)

    hybrid_rows, hybrid_user_rows = evaluate(
        model=hybrid_alias,
        split=split,
        k_values=K_VALUES,
        reference_recommendations=reference_recommendations,
    )
    hybrid_rows = [normalize_model_name(row) for row in hybrid_rows]
    hybrid_user_rows = [normalize_model_name(row) for row in hybrid_user_rows]
    write_csv(FINAL_DIR / "hybrid_shared_results.csv", hybrid_rows, AGGREGATE_FIELDS)
    write_csv(FINAL_DIR / "hybrid_shared_user_metric_values.csv", hybrid_user_rows, USER_METRIC_FIELDS)

    c_results = load_csv_rows(C_RESULTS_DIR / "final_results.csv")
    c_user_rows = load_csv_rows(C_RESULTS_DIR / "final_user_metric_values.csv")
    c_bpr_rows = filter_rows_by_model(c_results, {"bpr"})
    c_bpr_user_rows = filter_rows_by_model(c_user_rows, {"bpr"})

    merged_rows = [dict(row) for row in popularity_rows] + c_bpr_rows + hybrid_rows
    merged_user_rows = [dict(row) for row in popularity_user_rows] + c_bpr_user_rows + hybrid_user_rows
    merged_rows = sorted(
        merged_rows,
        key=lambda row: (str(row["model"]), str(row["scenario"]), str(row["scope"]), str(row["k"])),
    )
    merged_user_rows = sorted(
        merged_user_rows,
        key=lambda row: (
            str(row["model"]),
            str(row["scenario"]),
            str(row["scope"]),
            str(row["user_id"]),
            str(row["metric"]),
            str(row["k"]),
        ),
    )

    write_csv(FINAL_DIR / "main_results.csv", merged_rows, AGGREGATE_FIELDS)
    write_csv(FINAL_DIR / "main_user_metric_values.csv", merged_user_rows, USER_METRIC_FIELDS)
    write_significance_tests(FINAL_DIR / "main_significance_tests.csv", merged_user_rows)

    version_info = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "split": {
            "train_ratio": TRAIN_RATIO,
            "sample_per_group": SAMPLE_PER_GROUP,
            "seed": SEED,
            "cutoff_timestamp": split.cutoff_timestamp,
            "cutoff_date": split_summary["cutoff_date"],
            "train_rows": split.train_rows,
            "test_rows": split.test_rows,
            "train_users": split.train_users,
            "test_users": split.test_users,
            "scenario_sizes": split_summary["scenario_sizes"],
        },
        "id_semantics": {
            "item_id_is_steam_appid": True,
            "evidence": {
                "items_sample": [13500, 22364, 113020],
                "item_popularity_sample": [440, 252490, 1091500],
            },
        },
        "condition_a": {
            "type": "per_profile_popularity",
            "profile_id_equals_user_id": True,
            "is_global_list": False,
            "seen_exclusion_policy": "exclude training-period seen items for the same profile",
            "same_profile_and_exclusion_policy_as_bpr_and_hybrid": True,
        },
        "candidate_policy": {
            "main_experiment_name": "shared_train_positive_catalogue",
            "catalogue_size": len(shared_candidate_item_ids_int),
            "catalogue_construction": "unique item_id with label=1 and timestamp<=cutoff",
            "ranking_candidate_policy": "popularity and hybrid recommend only from the shared 20,435-item train-positive catalogue; C BPR already uses this catalogue",
            "diagnostic_score_policy": "score() is still computed on B's held-out test rows; out-of-catalogue items receive 0.0 for popularity/hybrid, matching C's BPR behaviour",
            "tie_break_policy": "sort by training positive count desc, training interaction count desc, item_id asc",
            "removed_temporal_leakage": True,
            "previous_leakage_source": "A item_popularity.parquet popularity_rank used future/global data as tie-break",
        },
        "source_files": {
            "a_output_dir": str(A_OUTPUT_DIR),
            "c_results": str(C_RESULTS_DIR / "final_results.csv"),
            "c_user_metrics": str(C_RESULTS_DIR / "final_user_metric_values.csv"),
            "d_delivered_results": str(D_RESULTS_DIR / "hybrid_results.csv"),
            "d_delivered_user_metrics": str(D_RESULTS_DIR / "hybrid_user_metric_values.csv"),
            "d_code_used_for_shared_rerun": str(D_MODELS_DIR / "hybrid.py"),
        },
        "outputs": [
            "popularity_top100.csv",
            "popularity_shared_results.csv",
            "popularity_shared_user_metric_values.csv",
            "hybrid_shared_results.csv",
            "hybrid_shared_user_metric_values.csv",
            "main_results.csv",
            "main_user_metric_values.csv",
            "main_significance_tests.csv",
        ],
    }
    with (FINAL_DIR / "version_info.json").open("w", encoding="utf-8") as handle:
        json.dump(version_info, handle, indent=2, ensure_ascii=False)

    print(f"Saved outputs to {FINAL_DIR}")


if __name__ == "__main__":
    main()
