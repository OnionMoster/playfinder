from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

import numpy as np
import pyarrow.parquet as pq
from scipy.stats import ttest_rel, wilcoxon
from sklearn.metrics import mean_absolute_error, mean_squared_error, roc_auc_score

from metrics import (
    average_precision_at_k,
    intra_list_diversity_at_k,
    ndcg_at_k,
    normalize_scores,
    novelty_at_k,
    precision_at_k,
    recall_at_k,
    reciprocal_rank_at_k,
    serendipity_at_k,
)


@dataclass
class EvaluationSplit:
    item_ids: list[object]
    item_features: dict[str, set[str]]
    global_popularity_rank: dict[str, int]
    sampled_users: set[object]
    sampled_groups: dict[object, str]
    n_interactions: dict[object, int]
    seen_train: dict[object, set[object]]
    positive_test: dict[object, set[object]]
    test_labels: dict[object, dict[object, int]]
    train_item_popularity: dict[str, int]
    train_item_interactions: dict[str, int]
    scenarios: dict[str, list[object]]
    train_rows: int
    test_rows: int
    train_users: int
    test_users: int
    cutoff_timestamp: int
    seed: int
    sample_per_group: int


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def canonical_id(value: object) -> str:
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except Exception:
            pass
    return str(value)


def write_csv(path: Path, rows: list[dict[str, object]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def load_item_features(items_path: Path) -> tuple[list[object], dict[str, set[str]]]:
    table = pq.read_table(items_path, columns=["item_id", "genres", "tags"])
    data = table.to_pydict()
    item_ids: list[object] = []
    item_features: dict[str, set[str]] = {}
    for item_id, genres, tags in zip(data["item_id"], data["genres"], data["tags"]):
        if item_id is None:
            continue
        item_ids.append(item_id)
        key = canonical_id(item_id)
        features = set()
        if genres:
            features.update(str(value).strip() for value in genres if str(value).strip())
        if tags:
            features.update(str(value).strip() for value in tags if str(value).strip())
        item_features[key] = features
    return item_ids, item_features


def load_global_popularity_rank(item_popularity_path: Path) -> dict[str, int]:
    table = pq.read_table(item_popularity_path, columns=["item_id", "popularity_rank"])
    data = table.to_pydict()
    return {
        canonical_id(item_id): int(rank)
        for item_id, rank in zip(data["item_id"], data["popularity_rank"])
        if item_id is not None and rank is not None
    }


def load_user_sample(
    users_path: Path,
    sample_per_group: int,
    seed: int,
) -> tuple[set[object], dict[object, str], dict[object, int]]:
    table = pq.read_table(users_path, columns=["user_id", "user_group", "n_interactions"])
    data = table.to_pydict()
    grouped: dict[str, list[object]] = defaultdict(list)
    interaction_counts: dict[object, int] = {}
    for user_id, user_group, n_interactions in zip(
        data["user_id"], data["user_group"], data["n_interactions"]
    ):
        if user_id is None or user_group is None:
            continue
        grouped[str(user_group)].append(user_id)
        interaction_counts[user_id] = int(n_interactions)

    import random

    rng = random.Random(seed)
    sampled_users: set[object] = set()
    sampled_groups: dict[object, str] = {}
    for group_name, users in grouped.items():
        sample_size = min(sample_per_group, len(users))
        chosen = rng.sample(users, sample_size)
        for user_id in chosen:
            sampled_users.add(user_id)
            sampled_groups[user_id] = group_name
    return sampled_users, sampled_groups, interaction_counts


def compute_cutoff_timestamp(interactions_path: Path, train_ratio: float = 0.8) -> int:
    timestamps = np.array(
        pq.read_table(interactions_path, columns=["timestamp"]).column(0).to_numpy(),
        copy=True,
    )
    timestamps.sort()
    cutoff_index = max(0, min(len(timestamps) - 1, int(len(timestamps) * train_ratio) - 1))
    return int(timestamps[cutoff_index])


def build_split(
    interactions_path: Path,
    items_path: Path,
    users_path: Path,
    item_popularity_path: Path,
    sample_per_group: int,
    seed: int,
    train_ratio: float = 0.8,
) -> EvaluationSplit:
    item_ids, item_features = load_item_features(items_path)
    global_popularity_rank = load_global_popularity_rank(item_popularity_path)
    sampled_users, sampled_groups, n_interactions = load_user_sample(users_path, sample_per_group, seed)
    cutoff_timestamp = compute_cutoff_timestamp(interactions_path, train_ratio=train_ratio)

    seen_train: dict[object, set[object]] = defaultdict(set)
    positive_test: dict[object, set[object]] = defaultdict(set)
    test_labels: dict[object, dict[object, int]] = defaultdict(dict)
    train_item_popularity = Counter()
    train_item_interactions = Counter()
    train_rows = 0
    test_rows = 0
    train_users = set()
    test_users = set()

    parquet_file = pq.ParquetFile(interactions_path)
    for batch in parquet_file.iter_batches(
        columns=["user_id", "item_id", "label", "timestamp"],
        batch_size=250_000,
    ):
        data = batch.to_pydict()
        for user_id, item_id, label, timestamp in zip(
            data["user_id"], data["item_id"], data["label"], data["timestamp"]
        ):
            if user_id is None or item_id is None or timestamp is None:
                continue
            label_value = int(label)
            if int(timestamp) <= cutoff_timestamp:
                train_rows += 1
                train_users.add(user_id)
                train_item_interactions[canonical_id(item_id)] += 1
                if label_value == 1:
                    train_item_popularity[canonical_id(item_id)] += 1
                if user_id in sampled_users:
                    seen_train[user_id].add(item_id)
            else:
                test_rows += 1
                test_users.add(user_id)
                if user_id in sampled_users:
                    test_labels[user_id][item_id] = label_value
                    if label_value == 1:
                        positive_test[user_id].add(item_id)

    sampled_test_users = sorted(sampled_users, key=canonical_id)
    sampled_test_users = [user_id for user_id in sampled_test_users if positive_test.get(user_id)]
    seen_users_only = [user_id for user_id in sampled_test_users if seen_train.get(user_id)]
    new_users_only = [user_id for user_id in sampled_test_users if not seen_train.get(user_id)]
    scenarios = {
        "all_test_users": sampled_test_users,
        "seen_users_only": seen_users_only,
        "new_users_only": new_users_only,
    }

    return EvaluationSplit(
        item_ids=sorted(item_ids, key=canonical_id),
        item_features=item_features,
        global_popularity_rank=global_popularity_rank,
        sampled_users=sampled_users,
        sampled_groups=sampled_groups,
        n_interactions=n_interactions,
        seen_train=seen_train,
        positive_test=positive_test,
        test_labels=test_labels,
        train_item_popularity=dict(train_item_popularity),
        train_item_interactions=dict(train_item_interactions),
        scenarios=scenarios,
        train_rows=train_rows,
        test_rows=test_rows,
        train_users=len(train_users),
        test_users=len(test_users),
        cutoff_timestamp=cutoff_timestamp,
        seed=seed,
        sample_per_group=sample_per_group,
    )


def build_train_tie_break_rank(
    train_item_popularity: dict[str, int],
    train_item_interactions: dict[str, int],
) -> dict[str, int]:
    item_keys = set(train_item_popularity) | set(train_item_interactions)
    ranked = sorted(
        item_keys,
        key=lambda item_key: (
            -int(train_item_popularity.get(item_key, 0)),
            -int(train_item_interactions.get(item_key, 0)),
            item_key,
        ),
    )
    return {item_key: rank for rank, item_key in enumerate(ranked, start=1)}


def _score_items(model, user_id: object, item_ids: list[object]) -> list[float]:
    if hasattr(model, "score"):
        return [float(value) for value in model.score(user_id, item_ids)]
    return [0.0 for _ in item_ids]


def _group_users(users: list[object], sampled_groups: dict[object, str]) -> dict[str, list[object]]:
    return {
        "overall": users,
        "cold": [user_id for user_id in users if sampled_groups.get(user_id) == "cold"],
        "normal": [user_id for user_id in users if sampled_groups.get(user_id) == "normal"],
        "heavy": [user_id for user_id in users if sampled_groups.get(user_id) == "heavy"],
    }


def evaluate(
    model,
    split: EvaluationSplit,
    k_values: list[int],
    reference_recommendations: dict[object, list[str]] | None = None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    reference_recommendations = {
        user_id: [canonical_id(item_id) for item_id in recs]
        for user_id, recs in (reference_recommendations or {}).items()
    }
    all_users = sorted({user_id for users in split.scenarios.values() for user_id in users}, key=canonical_id)
    max_k = max(k_values)
    cached_recommendations = {
        user_id: [canonical_id(item_id) for item_id in model.recommend(user_id, split.seen_train.get(user_id, set()), max_k)]
        for user_id in all_users
    }

    aggregate_rows: list[dict[str, object]] = []
    user_metric_rows: list[dict[str, object]] = []

    for scenario_name, scenario_users in split.scenarios.items():
        scopes = _group_users(scenario_users, split.sampled_groups)
        for scope_name, users in scopes.items():
            if not users:
                continue

            diagnostic_values = {"auc": [], "rmse": [], "mae": []}
            for user_id in users:
                label_map = split.test_labels.get(user_id, {})
                if not label_map:
                    continue
                candidate_items = list(label_map.keys())
                y_true = [int(label_map[item_id]) for item_id in candidate_items]
                raw_scores = _score_items(model, user_id, candidate_items)
                y_score = normalize_scores(raw_scores)

                auc_value = None
                if len(set(y_true)) > 1:
                    auc_value = float(roc_auc_score(y_true, y_score))
                    diagnostic_values["auc"].append(auc_value)
                rmse_value = float(mean_squared_error(y_true, y_score) ** 0.5)
                mae_value = float(mean_absolute_error(y_true, y_score))
                diagnostic_values["rmse"].append(rmse_value)
                diagnostic_values["mae"].append(mae_value)

                user_metric_rows.extend(
                    [
                        {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "auc", "k": "", "value": auc_value},
                        {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "rmse", "k": "", "value": rmse_value},
                        {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "mae", "k": "", "value": mae_value},
                    ]
                )

            auc_mean = mean(diagnostic_values["auc"])
            rmse_mean = mean(diagnostic_values["rmse"])
            mae_mean = mean(diagnostic_values["mae"])

            for k in k_values:
                precision_scores = []
                recall_scores = []
                ndcg_scores = []
                map_scores = []
                mrr_scores = []
                novelty_scores = []
                diversity_scores = []
                serendipity_scores = []
                covered_items = set()
                users_with_recs = 0

                for user_id in users:
                    recs = cached_recommendations[user_id][:k]
                    relevant = {canonical_id(item_id) for item_id in split.positive_test.get(user_id, set())}
                    if recs:
                        users_with_recs += 1
                        covered_items.update(recs)

                    precision_value = precision_at_k(recs, relevant, k)
                    recall_value = recall_at_k(recs, relevant, k)
                    ndcg_value = ndcg_at_k(recs, relevant, k)
                    map_value = average_precision_at_k(recs, relevant, k)
                    mrr_value = reciprocal_rank_at_k(recs, relevant, k)
                    novelty_value = novelty_at_k(recs, k, split.train_item_popularity, split.train_users)
                    diversity_value = intra_list_diversity_at_k(recs, k, split.item_features)
                    serendipity_value = serendipity_at_k(recs, relevant, reference_recommendations.get(user_id, []), k)

                    precision_scores.append(precision_value)
                    recall_scores.append(recall_value)
                    ndcg_scores.append(ndcg_value)
                    map_scores.append(map_value)
                    mrr_scores.append(mrr_value)
                    novelty_scores.append(novelty_value)
                    diversity_scores.append(diversity_value)
                    serendipity_scores.append(serendipity_value)

                    user_metric_rows.extend(
                        [
                            {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "precision_at_k", "k": k, "value": precision_value},
                            {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "recall_at_k", "k": k, "value": recall_value},
                            {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "ndcg_at_k", "k": k, "value": ndcg_value},
                            {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "map_at_k", "k": k, "value": map_value},
                            {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "mrr_at_k", "k": k, "value": mrr_value},
                            {"model": model.params["name"], "scenario": scenario_name, "scope": scope_name, "user_id": canonical_id(user_id), "metric": "serendipity_at_k", "k": k, "value": serendipity_value},
                        ]
                    )

                aggregate_rows.append(
                    {
                        "model": model.params["name"],
                        "scenario": scenario_name,
                        "scope": scope_name,
                        "k": k,
                        "users": len(users),
                        "precision_at_k": round(mean(precision_scores), 6),
                        "recall_at_k": round(mean(recall_scores), 6),
                        "ndcg_at_k": round(mean(ndcg_scores), 6),
                        "map_at_k": round(mean(map_scores), 6),
                        "mrr_at_k": round(mean(mrr_scores), 6),
                        "auc": round(auc_mean, 6) if diagnostic_values["auc"] else "",
                        "rmse": round(rmse_mean, 6) if diagnostic_values["rmse"] else "",
                        "mae": round(mae_mean, 6) if diagnostic_values["mae"] else "",
                        "catalogue_coverage": round(len(covered_items) / len(split.item_features), 6) if split.item_features else 0.0,
                        "user_coverage": round(users_with_recs / len(users), 6),
                        "novelty": round(mean(novelty_scores), 6),
                        "intra_list_diversity": round(mean(diversity_scores), 6),
                        "serendipity": round(mean(serendipity_scores), 6),
                        "params": json.dumps(model.params, ensure_ascii=True, sort_keys=True),
                    }
                )

    return aggregate_rows, user_metric_rows


def write_significance_tests(path: Path, user_metric_rows: list[dict[str, object]]) -> None:
    grouped: dict[tuple[str, str, str, str], dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(dict))
    for row in user_metric_rows:
        if row["value"] in [None, ""]:
            continue
        key = (str(row["scenario"]), str(row["scope"]), str(row["metric"]), str(row["k"]))
        grouped[key][str(row["model"])][str(row["user_id"])] = float(row["value"])

    result_rows: list[dict[str, object]] = []
    for (scenario, scope, metric, k), model_values in grouped.items():
        models = sorted(model_values.keys())
        for idx, left_model in enumerate(models):
            for right_model in models[idx + 1 :]:
                common_users = sorted(set(model_values[left_model]) & set(model_values[right_model]))
                if len(common_users) < 2:
                    continue
                left_scores = [model_values[left_model][user_id] for user_id in common_users]
                right_scores = [model_values[right_model][user_id] for user_id in common_users]
                if all(abs(left - right) < 1e-12 for left, right in zip(left_scores, right_scores)):
                    ttest_stat = 0.0
                    ttest_p = 1.0
                    wilcoxon_stat = 0.0
                    wilcoxon_p = 1.0
                else:
                    ttest = ttest_rel(left_scores, right_scores, nan_policy="omit")
                    ttest_stat = float(ttest.statistic) if ttest.statistic is not None else float("nan")
                    ttest_p = float(ttest.pvalue) if ttest.pvalue is not None else float("nan")
                    wilcoxon_test = wilcoxon(left_scores, right_scores, zero_method="wilcox")
                    wilcoxon_stat = float(wilcoxon_test.statistic)
                    wilcoxon_p = float(wilcoxon_test.pvalue)
                result_rows.append(
                    {
                        "scenario": scenario,
                        "scope": scope,
                        "metric": metric,
                        "k": k,
                        "left_model": left_model,
                        "right_model": right_model,
                        "n_users": len(common_users),
                        "mean_left": round(sum(left_scores) / len(left_scores), 6),
                        "mean_right": round(sum(right_scores) / len(right_scores), 6),
                        "ttest_statistic": round(ttest_stat, 6),
                        "ttest_pvalue": round(ttest_p, 6),
                        "wilcoxon_statistic": round(wilcoxon_stat, 6),
                        "wilcoxon_pvalue": round(wilcoxon_p, 6),
                    }
                )

    write_csv(
        path,
        result_rows,
        [
            "scenario",
            "scope",
            "metric",
            "k",
            "left_model",
            "right_model",
            "n_users",
            "mean_left",
            "mean_right",
            "ttest_statistic",
            "ttest_pvalue",
            "wilcoxon_statistic",
            "wilcoxon_pvalue",
        ],
    )


def write_result_template(path: Path, k_values: Iterable[int]) -> None:
    scenarios = ["all_test_users", "seen_users_only", "new_users_only"]
    scopes = ["overall", "cold", "normal", "heavy"]
    rows = []
    for model_name in ["itemcf", "als", "bpr", "hybrid"]:
        for scenario in scenarios:
            for scope in scopes:
                for k in k_values:
                    rows.append(
                        {
                            "model": model_name,
                            "scenario": scenario,
                            "scope": scope,
                            "k": k,
                            "users": "",
                            "precision_at_k": "",
                            "recall_at_k": "",
                            "ndcg_at_k": "",
                            "map_at_k": "",
                            "mrr_at_k": "",
                            "auc": "",
                            "rmse": "",
                            "mae": "",
                            "catalogue_coverage": "",
                            "user_coverage": "",
                            "novelty": "",
                            "intra_list_diversity": "",
                            "serendipity": "",
                            "params": "",
                        }
                    )
    write_csv(
        path,
        rows,
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


def build_split_summary(split: EvaluationSplit, k_values: list[int]) -> dict[str, object]:
    return {
        "dataset": "A official output",
        "sample_per_group_requested": split.sample_per_group,
        "sample_seed": split.seed,
        "sampled_users_total": len(split.sampled_users),
        "scenario_sizes": {name: len(users) for name, users in split.scenarios.items()},
        "train_rows": split.train_rows,
        "test_rows": split.test_rows,
        "train_users": split.train_users,
        "test_users": split.test_users,
        "cutoff_timestamp": split.cutoff_timestamp,
        "cutoff_date": date.fromtimestamp(split.cutoff_timestamp).isoformat(),
        "k_values": k_values,
        "notes": [
            "所有评测均基于 A 任务交付的正式 parquet 输出。",
            "场景包括 all_test_users、seen_users_only 和 new_users_only。",
            "AUC、RMSE、MAE 作为诊断指标，在 sampled cohort 的测试交互上计算。",
            "serendipity 以 popularity baseline 在相同 K 下的推荐列表作为参照。",
            "popularity baseline 使用训练集正反馈统计，并用 A 提供的 item_popularity.parquet 做全局流行度 tie-break。",
            "评测阶段会统一将 recommend() 返回的 item_id 转成字符串做匹配，避免 numpy/int/string 类型不一致造成静默错误。",
            "B 任务的 evaluate 只负责评测，不负责替外部模型做训练。",
        ],
    }
