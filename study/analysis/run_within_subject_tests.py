#!/usr/bin/env python3
"""Run paired three-condition tests for the PlayFinder user study.

The input is the local participant-condition analysis table produced by
``analyze_study.py``. Only aggregate outputs are written for submission.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats


CONDITIONS = ["A", "B", "C"]
CONDITION_LABELS = {
    "A": "Popularity",
    "B": "BPR",
    "C": "Hybrid",
}
CONTINUOUS_OUTCOMES = {
    "q10_satisfaction": ("Overall satisfaction (Q10)", "primary"),
    "perceived_relevance": ("Perceived relevance", "secondary"),
    "discovery_quality": ("Discovery quality", "secondary"),
    "constraint_fit": ("Budget/platform fit", "secondary"),
    "total_dwell_seconds": ("Detail dwell time (seconds)", "secondary"),
    "unique_games_opened": ("Unique games opened", "secondary"),
}
BINARY_OUTCOMES = {
    "accepted_any": ("Accepted at least one game", "secondary"),
    "rejected_any": ("Rejected at least one game", "secondary"),
}


def holm_adjust(values: list[float]) -> list[float]:
    """Return Holm-adjusted p-values while preserving input order."""
    array = np.asarray(values, dtype=float)
    adjusted = np.full(len(array), np.nan)
    valid = np.flatnonzero(np.isfinite(array))
    if not len(valid):
        return adjusted.tolist()
    order = valid[np.argsort(array[valid])]
    running = 0.0
    total = len(order)
    for rank, index in enumerate(order):
        candidate = min(1.0, (total - rank) * array[index])
        running = max(running, candidate)
        adjusted[index] = running
    return adjusted.tolist()


def complete_wide(frame: pd.DataFrame, outcome: str) -> pd.DataFrame:
    wide = frame.pivot(index="participant_id", columns="condition", values=outcome)
    return wide.reindex(columns=CONDITIONS).dropna()


def cochran_q(values: np.ndarray) -> tuple[float, float]:
    """Cochran's Q for matched binary measurements (participants × conditions)."""
    values = np.asarray(values, dtype=float)
    n, k = values.shape
    column_totals = values.sum(axis=0)
    row_totals = values.sum(axis=1)
    denominator = k * row_totals.sum() - np.square(row_totals).sum()
    if n == 0 or denominator <= 0:
        return 0.0, 1.0
    numerator = (k - 1) * (k * np.square(column_totals).sum() - column_totals.sum() ** 2)
    statistic = float(numerator / denominator)
    return statistic, float(stats.chi2.sf(statistic, k - 1))


def rank_biserial(left: np.ndarray, right: np.ndarray) -> float:
    differences = np.asarray(right, dtype=float) - np.asarray(left, dtype=float)
    differences = differences[differences != 0]
    if not len(differences):
        return 0.0
    ranks = stats.rankdata(np.abs(differences))
    positive = ranks[differences > 0].sum()
    negative = ranks[differences < 0].sum()
    return float((positive - negative) / (positive + negative))


def exact_mcnemar(left: np.ndarray, right: np.ndarray) -> tuple[int, int, float]:
    left = np.asarray(left, dtype=int)
    right = np.asarray(right, dtype=int)
    left_only = int(((left == 1) & (right == 0)).sum())
    right_only = int(((left == 0) & (right == 1)).sum())
    discordant = left_only + right_only
    if discordant == 0:
        return left_only, right_only, 1.0
    p_value = float(stats.binomtest(min(left_only, right_only), discordant, 0.5).pvalue)
    return left_only, right_only, p_value


def bootstrap_condition_intervals(
    frame: pd.DataFrame,
    iterations: int,
    seed: int,
) -> pd.DataFrame:
    random = np.random.default_rng(seed)
    rows: list[dict[str, object]] = []
    all_outcomes = {**CONTINUOUS_OUTCOMES, **BINARY_OUTCOMES}
    for outcome, (label, family) in all_outcomes.items():
        for condition in CONDITIONS:
            values = frame.loc[frame["condition"] == condition, outcome].dropna().to_numpy(dtype=float)
            estimates = np.empty(iterations, dtype=float)
            for index in range(iterations):
                estimates[index] = random.choice(values, size=len(values), replace=True).mean()
            rows.append({
                "outcome": outcome,
                "outcome_label": label,
                "outcome_family": family,
                "condition": condition,
                "model": CONDITION_LABELS[condition],
                "n": len(values),
                "mean": float(values.mean()),
                "median": float(np.median(values)),
                "sd": float(values.std(ddof=1)),
                "bootstrap_ci_low": float(np.quantile(estimates, 0.025)),
                "bootstrap_ci_high": float(np.quantile(estimates, 0.975)),
            })
    return pd.DataFrame(rows)


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        type=Path,
        default=root / "study/results/participant-condition-analysis.csv",
    )
    parser.add_argument("--output-dir", type=Path, default=root / "study/results")
    parser.add_argument("--bootstrap-iterations", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=9727)
    args = parser.parse_args()

    frame = pd.read_csv(args.input)
    required = {"participant_id", "condition", *CONTINUOUS_OUTCOMES, *BINARY_OUTCOMES}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"analysis input missing columns: {sorted(missing)}")
    if frame.duplicated(["participant_id", "condition"]).any():
        raise ValueError("analysis input contains duplicate participant-condition rows")
    observed_conditions = sorted(frame["condition"].dropna().unique())
    if observed_conditions != CONDITIONS:
        raise ValueError(f"expected conditions {CONDITIONS}, found {observed_conditions}")

    omnibus_rows: list[dict[str, object]] = []
    pairwise_rows: list[dict[str, object]] = []
    pairs = [("A", "B"), ("A", "C"), ("B", "C")]

    for outcome, (label, family) in CONTINUOUS_OUTCOMES.items():
        wide = complete_wide(frame, outcome)
        statistic, p_value = stats.friedmanchisquare(*(wide[c].to_numpy() for c in CONDITIONS))
        omnibus_rows.append({
            "outcome": outcome,
            "outcome_label": label,
            "outcome_family": family,
            "test": "Friedman chi-square",
            "n_complete": len(wide),
            "statistic": float(statistic),
            "degrees_of_freedom": 2,
            "p_value": float(p_value),
            "mean_A": float(wide["A"].mean()),
            "mean_B": float(wide["B"].mean()),
            "mean_C": float(wide["C"].mean()),
        })
        local_rows = []
        for left, right in pairs:
            result = stats.wilcoxon(
                wide[left],
                wide[right],
                alternative="two-sided",
                zero_method="wilcox",
                method="auto",
            )
            difference = wide[right].to_numpy() - wide[left].to_numpy()
            local_rows.append({
                "outcome": outcome,
                "outcome_label": label,
                "outcome_family": family,
                "comparison": f"{left} vs {right}",
                "left_model": CONDITION_LABELS[left],
                "right_model": CONDITION_LABELS[right],
                "test": "Wilcoxon signed-rank",
                "n_complete": len(wide),
                "statistic": float(result.statistic),
                "p_value": float(result.pvalue),
                "mean_difference_right_minus_left": float(difference.mean()),
                "median_difference_right_minus_left": float(np.median(difference)),
                "rank_biserial_right_minus_left": rank_biserial(wide[left], wide[right]),
            })
        adjusted = holm_adjust([row["p_value"] for row in local_rows])
        for row, corrected in zip(local_rows, adjusted):
            row["p_holm_within_outcome"] = corrected
            row["significant_holm_0_05"] = bool(corrected < 0.05)
            pairwise_rows.append(row)

    for outcome, (label, family) in BINARY_OUTCOMES.items():
        wide = complete_wide(frame, outcome)
        statistic, p_value = cochran_q(wide.to_numpy())
        omnibus_rows.append({
            "outcome": outcome,
            "outcome_label": label,
            "outcome_family": family,
            "test": "Cochran's Q",
            "n_complete": len(wide),
            "statistic": statistic,
            "degrees_of_freedom": 2,
            "p_value": p_value,
            "mean_A": float(wide["A"].mean()),
            "mean_B": float(wide["B"].mean()),
            "mean_C": float(wide["C"].mean()),
        })
        local_rows = []
        for left, right in pairs:
            left_only, right_only, pair_p = exact_mcnemar(wide[left], wide[right])
            difference = wide[right].to_numpy(dtype=float) - wide[left].to_numpy(dtype=float)
            local_rows.append({
                "outcome": outcome,
                "outcome_label": label,
                "outcome_family": family,
                "comparison": f"{left} vs {right}",
                "left_model": CONDITION_LABELS[left],
                "right_model": CONDITION_LABELS[right],
                "test": "Exact McNemar",
                "n_complete": len(wide),
                "statistic": float(min(left_only, right_only)),
                "p_value": pair_p,
                "mean_difference_right_minus_left": float(difference.mean()),
                "median_difference_right_minus_left": float(np.median(difference)),
                "rank_biserial_right_minus_left": np.nan,
                "discordant_left_only": left_only,
                "discordant_right_only": right_only,
            })
        adjusted = holm_adjust([row["p_value"] for row in local_rows])
        for row, corrected in zip(local_rows, adjusted):
            row["p_holm_within_outcome"] = corrected
            row["significant_holm_0_05"] = bool(corrected < 0.05)
            pairwise_rows.append(row)

    omnibus = pd.DataFrame(omnibus_rows)
    omnibus["p_holm_across_outcomes"] = holm_adjust(omnibus["p_value"].tolist())
    omnibus["significant_raw_0_05"] = omnibus["p_value"] < 0.05
    omnibus["significant_holm_0_05"] = omnibus["p_holm_across_outcomes"] < 0.05
    pairwise = pd.DataFrame(pairwise_rows)
    intervals = bootstrap_condition_intervals(
        frame,
        iterations=args.bootstrap_iterations,
        seed=args.seed,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    omnibus.to_csv(args.output_dir / "within-subject-omnibus.csv", index=False)
    pairwise.to_csv(args.output_dir / "within-subject-pairwise.csv", index=False)
    intervals.to_csv(args.output_dir / "condition-summary-with-ci.csv", index=False)

    primary = omnibus.loc[omnibus["outcome"] == "q10_satisfaction"].iloc[0]
    summary = {
        "status": "within-subject-analysis-complete",
        "participants": int(frame["participant_id"].nunique()),
        "complete_cases_per_outcome": int(primary["n_complete"]),
        "primary_outcome": "q10_satisfaction",
        "primary_test": primary["test"],
        "primary_statistic": float(primary["statistic"]),
        "primary_p_value": float(primary["p_value"]),
        "primary_significant_0_05": bool(primary["p_value"] < 0.05),
        "multiplicity": "Holm adjustment across outcomes and within each outcome's three pairwise comparisons",
        "interpretation_rule": "Pairwise differences are interpreted only after the omnibus result and with Holm-adjusted p-values.",
        "bootstrap_iterations": args.bootstrap_iterations,
        "random_seed": args.seed,
    }
    (args.output_dir / "within-subject-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
