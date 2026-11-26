from __future__ import annotations

import json
from pathlib import Path

from baselines import PopularityRecommender, RandomRecommender
from evaluation_core import (
    build_train_tie_break_rank,
    build_split,
    build_split_summary,
    evaluate,
    write_csv,
    write_result_template,
    write_significance_tests,
)


B_DIR = Path(__file__).resolve().parent
GAME_DIR = B_DIR.parent
A_OUTPUT_DIR = GAME_DIR / "A" / "output-20260723T080524Z-1-001" / "output"

INTERACTIONS_PATH = A_OUTPUT_DIR / "interactions.parquet"
ITEMS_PATH = A_OUTPUT_DIR / "items.parquet"
USERS_PATH = A_OUTPUT_DIR / "users.parquet"
ITEM_POPULARITY_PATH = A_OUTPUT_DIR / "item_popularity.parquet"

RESULTS_DIR = B_DIR / "results"
RESULTS_CSV = RESULTS_DIR / "baseline_results.csv"
SPLIT_JSON = RESULTS_DIR / "split_summary.json"
COHORT_CSV = RESULTS_DIR / "evaluation_users.csv"
USER_METRICS_CSV = RESULTS_DIR / "user_metric_values.csv"
SIGNIFICANCE_CSV = RESULTS_DIR / "significance_tests.csv"
TEMPLATE_CSV = RESULTS_DIR / "model_results_template.csv"

K_VALUES = [5, 10, 20, 30, 40]
SAMPLE_PER_GROUP = 3000
SEED = 42


def main() -> None:
    split = build_split(
        interactions_path=INTERACTIONS_PATH,
        items_path=ITEMS_PATH,
        users_path=USERS_PATH,
        item_popularity_path=ITEM_POPULARITY_PATH,
        sample_per_group=SAMPLE_PER_GROUP,
        seed=SEED,
        train_ratio=0.8,
    )

    train_signal_for_fit = split.train_item_popularity
    train_tie_break_rank = build_train_tie_break_rank(
        split.train_item_popularity,
        split.train_item_interactions,
    )

    popularity_model = PopularityRecommender(tie_break_rank=train_tie_break_rank)
    popularity_model.fit(train_signal_for_fit, split.item_ids)
    reference_recommendations = {
        user_id: popularity_model.recommend(user_id, split.seen_train.get(user_id, set()), max(K_VALUES))
        for users in split.scenarios.values()
        for user_id in users
    }

    models = [
        PopularityRecommender(tie_break_rank=train_tie_break_rank),
        RandomRecommender(seed=SEED),
    ]

    aggregate_rows: list[dict[str, object]] = []
    user_metric_rows: list[dict[str, object]] = []
    for model in models:
        model.fit(train_signal_for_fit, split.item_ids)
        rows, user_rows = evaluate(
            model=model,
            split=split,
            k_values=K_VALUES,
            reference_recommendations=reference_recommendations,
        )
        aggregate_rows.extend(rows)
        user_metric_rows.extend(user_rows)

    write_csv(
        RESULTS_CSV,
        aggregate_rows,
        [
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
        ],
    )
    write_csv(
        COHORT_CSV,
        [
            {
                "user_id": user_id,
                "user_group": split.sampled_groups.get(user_id, ""),
                "n_interactions": split.n_interactions.get(user_id, ""),
            }
            for user_id in sorted(split.sampled_users, key=str)
        ],
        ["user_id", "user_group", "n_interactions"],
    )
    write_csv(
        USER_METRICS_CSV,
        user_metric_rows,
        ["model", "scenario", "scope", "user_id", "metric", "k", "value"],
    )
    write_significance_tests(SIGNIFICANCE_CSV, user_metric_rows)
    write_result_template(TEMPLATE_CSV, K_VALUES)

    split_summary = build_split_summary(split, K_VALUES)
    with SPLIT_JSON.open("w", encoding="utf-8") as handle:
        json.dump(split_summary, handle, indent=2, ensure_ascii=False)

    print("Saved:", RESULTS_CSV)
    print("Saved:", SPLIT_JSON)
    print("Saved:", COHORT_CSV)
    print("Saved:", USER_METRICS_CSV)
    print("Saved:", SIGNIFICANCE_CSV)
    print("Saved:", TEMPLATE_CSV)


if __name__ == "__main__":
    main()

