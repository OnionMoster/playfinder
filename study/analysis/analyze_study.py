#!/usr/bin/env python3
"""Create PlayFinder user-study summaries and offline/online correlations."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np
import pandas as pd


LIKERT_COLUMNS = [f"q{index}_{name}" for index, name in [
    (1, "relevance"),
    (2, "consider_playing"),
    (3, "variety"),
    (4, "discovery"),
    (5, "confidence"),
    (6, "budget_fit"),
    (7, "platform_fit"),
    (8, "ease"),
    (9, "transparency"),
    (10, "satisfaction"),
]]


def parse_profile(snapshot: object) -> str | None:
    if snapshot is None or (isinstance(snapshot, float) and np.isnan(snapshot)):
        return None
    try:
        value = json.loads(str(snapshot))
    except (TypeError, json.JSONDecodeError):
        return None
    profile_id = value.get("assignedProfileId") if isinstance(value, dict) else None
    return str(profile_id) if profile_id else None


def correlation(left: pd.Series, right: pd.Series, method: str) -> float:
    frame = pd.DataFrame({"left": left, "right": right}).dropna()
    if len(frame) < 3 or frame["left"].nunique() < 2 or frame["right"].nunique() < 2:
        return float("nan")
    if method == "spearman":
        frame = frame.rank(method="average")
    return float(np.corrcoef(frame["left"], frame["right"])[0, 1])


def cluster_bootstrap_ci(
    frame: pd.DataFrame,
    outcome: str,
    method: str,
    iterations: int = 2000,
    seed: int = 9727,
) -> tuple[float, float]:
    usable = frame[["participant_id", outcome, "offline_ndcg_at_10"]].dropna()
    participants = usable["participant_id"].unique()
    if len(participants) < 5:
        return float("nan"), float("nan")
    random = np.random.default_rng(seed)
    estimates: list[float] = []
    grouped = {participant: usable[usable["participant_id"] == participant] for participant in participants}
    for _ in range(iterations):
        sampled = random.choice(participants, size=len(participants), replace=True)
        pieces = []
        for sample_index, participant in enumerate(sampled):
            piece = grouped[participant].copy()
            piece["participant_id"] = f"bootstrap-{sample_index}"
            pieces.append(piece)
        replicate = pd.concat(pieces, ignore_index=True)
        value = correlation(replicate[outcome], replicate["offline_ndcg_at_10"], method)
        if np.isfinite(value):
            estimates.append(value)
    if len(estimates) < max(100, iterations // 4):
        return float("nan"), float("nan")
    return float(np.quantile(estimates, 0.025)), float(np.quantile(estimates, 0.975))


def load_logs(logs_dir: Path) -> pd.DataFrame:
    files = sorted(logs_dir.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"no participant CSV logs found in {logs_dir}")
    frames = [pd.read_csv(path) for path in files]
    logs = pd.concat(frames, ignore_index=True)
    required = {"participantId", "round", "condition", "eventType", "gameId", "dwellTimeMs"}
    missing = required - set(logs.columns)
    if missing:
        raise ValueError(f"participant logs missing columns: {sorted(missing)}")
    # Every export begins with pre-enrolment onboarding events whose participantId,
    # round and condition are empty. They must be dropped before the string coercion
    # below, otherwise astype(str) turns the blanks into the literal "NAN" and they
    # are analysed as an extra participant in an extra condition, inflating
    # `participants` and adding a spurious row to condition-summary.csv.
    enrolled = logs["participantId"].notna() & logs["participantId"].astype(str).str.strip().ne("")
    dropped = int((~enrolled).sum())
    logs = logs.loc[enrolled].copy()
    if logs.empty:
        raise ValueError(
            f"participant logs contain no enrolled events; {dropped} pre-enrolment rows were dropped"
        )
    logs.attrs["pre_enrolment_rows_dropped"] = dropped
    logs = logs.rename(columns={
        "participantId": "participant_id",
        "eventType": "event_type",
        "gameId": "game_id",
        "dwellTimeMs": "dwell_time_ms",
    })
    logs["participant_id"] = logs["participant_id"].astype(str).str.upper()
    logs["condition"] = logs["condition"].astype(str).str.upper()
    logs["round"] = pd.to_numeric(logs["round"], errors="coerce")
    logs["dwell_time_ms"] = pd.to_numeric(logs["dwell_time_ms"], errors="coerce")
    logs["profile_id"] = logs.get("preferencesSnapshot", pd.Series(index=logs.index, dtype=object)).map(parse_profile)
    logs["profile_id"] = logs.groupby("participant_id")["profile_id"].transform(
        lambda values: values.dropna().iloc[-1] if values.notna().any() else None
    )
    return logs


def summarize_logs(logs: pd.DataFrame) -> pd.DataFrame:
    keys = ["participant_id", "condition", "round", "profile_id"]
    base = logs[keys].drop_duplicates()
    summaries = []
    for key, rows in logs.groupby(keys, dropna=False):
        events = rows["event_type"].astype(str)
        summaries.append({
            **dict(zip(keys, key)),
            "event_count": len(rows),
            "unique_games_opened": rows.loc[events.eq("game_detail_opened"), "game_id"].dropna().nunique(),
            "total_dwell_seconds": rows.loc[events.eq("dwell_time"), "dwell_time_ms"].fillna(0).sum() / 1000,
            "like_events": int(events.eq("like").sum()),
            "dislike_events": int(events.eq("dislike").sum()),
            "wishlist_added_events": int(events.eq("wishlist_added").sum()),
            "not_interested_events": int(events.eq("not_interested").sum()),
            "accepted_any": int(events.isin(["like", "wishlist_added"]).any()),
            "rejected_any": int(events.isin(["dislike", "not_interested"]).any()),
            "round_completed": int(events.eq("round_completed").any()),
        })
    summary = pd.DataFrame(summaries)
    return base.merge(summary, on=keys, how="left")


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--logs-dir", type=Path, default=root / "study/data/logs")
    parser.add_argument("--likert", type=Path, default=root / "study/data/likert-responses.csv")
    parser.add_argument(
        "--profiles",
        type=Path,
        default=root / "study-data/staging/three-model-provisional/study_profiles.csv",
    )
    parser.add_argument(
        "--offline",
        type=Path,
        default=root / "study/analysis/offline-ndcg-selected.csv",
    )
    parser.add_argument("--output-dir", type=Path, default=root / "study/results")
    args = parser.parse_args()

    logs = load_logs(args.logs_dir)
    behaviour = summarize_logs(logs)
    likert = pd.read_csv(args.likert)
    likert["participant_id"] = likert["participant_id"].astype(str).str.upper()
    likert["condition"] = likert["condition"].astype(str).str.upper()
    likert["round"] = pd.to_numeric(likert["round"], errors="coerce")
    for column in LIKERT_COLUMNS:
        likert[column] = pd.to_numeric(likert[column], errors="coerce")
        invalid = likert[column].notna() & ~likert[column].between(1, 7)
        if invalid.any():
            raise ValueError(f"{column} contains values outside 1–7")
    if likert.duplicated(["participant_id", "condition"]).any():
        raise ValueError("Likert data contains duplicate participant-condition rows")

    likert["perceived_relevance"] = likert[["q1_relevance", "q2_consider_playing"]].mean(axis=1)
    likert["discovery_quality"] = likert[["q3_variety", "q4_discovery"]].mean(axis=1)
    likert["constraint_fit"] = likert[["q6_budget_fit", "q7_platform_fit"]].mean(axis=1)
    profiles = pd.read_csv(args.profiles, dtype={"model_user_id": str})[
        ["profile_id", "model_user_id"]
    ]
    offline = pd.read_csv(args.offline, dtype={"model_user_id": str}).rename(
        columns={"value": "offline_ndcg_at_10"}
    )
    offline["offline_ndcg_at_10"] = pd.to_numeric(offline["offline_ndcg_at_10"], errors="coerce")

    analysis = behaviour.merge(
        likert,
        on=["participant_id", "condition", "round"],
        how="outer",
        validate="one_to_one",
    )
    analysis = analysis.merge(profiles, on="profile_id", how="left", validate="many_to_one")
    analysis = analysis.merge(
        offline[["profile_id", "model_user_id", "condition", "model", "offline_ndcg_at_10"]],
        on=["profile_id", "model_user_id", "condition"],
        how="left",
        validate="many_to_one",
    )

    outcomes = [
        "q10_satisfaction",
        "perceived_relevance",
        "discovery_quality",
        "constraint_fit",
        "accepted_any",
        "total_dwell_seconds",
    ]
    correlation_rows = []
    for scope, subset in [("pooled", analysis), *[
        (f"condition_{condition}", analysis[analysis["condition"] == condition])
        for condition in ["A", "B", "C"]
    ]]:
        for outcome in outcomes:
            usable = subset[[outcome, "offline_ndcg_at_10"]].dropna()
            for method in ["spearman", "pearson"]:
                estimate = correlation(usable[outcome], usable["offline_ndcg_at_10"], method)
                low, high = cluster_bootstrap_ci(subset, outcome, method)
                correlation_rows.append({
                    "scope": scope,
                    "outcome": outcome,
                    "method": method,
                    "usable_pairs": len(usable),
                    "offline_zero_rate": float((usable["offline_ndcg_at_10"] == 0).mean()) if len(usable) else np.nan,
                    "correlation": estimate,
                    "cluster_bootstrap_ci_low": low,
                    "cluster_bootstrap_ci_high": high,
                })
    correlations = pd.DataFrame(correlation_rows)
    condition_summary = analysis.groupby("condition", dropna=False).agg(
        participant_conditions=("participant_id", "count"),
        completed_rounds=("round_completed", "sum"),
        satisfaction_mean=("q10_satisfaction", "mean"),
        perceived_relevance_mean=("perceived_relevance", "mean"),
        discovery_quality_mean=("discovery_quality", "mean"),
        constraint_fit_mean=("constraint_fit", "mean"),
        acceptance_rate=("accepted_any", "mean"),
        rejection_rate=("rejected_any", "mean"),
        dwell_seconds_mean=("total_dwell_seconds", "mean"),
        offline_ndcg_at_10_mean=("offline_ndcg_at_10", "mean"),
    ).reset_index()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    analysis.to_csv(args.output_dir / "participant-condition-analysis.csv", index=False)
    condition_summary.to_csv(args.output_dir / "condition-summary.csv", index=False)
    correlations.to_csv(args.output_dir / "correlations.csv", index=False)
    summary = {
        "status": "observed-study-results",
        "participants": int(analysis["participant_id"].nunique()),
        "participant_condition_rows": int(len(analysis)),
        "complete_three_round_participants": int(
            (analysis.groupby("participant_id")["round_completed"].sum() == 3).sum()
        ),
        "offline_ndcg_zero_rate": float((analysis["offline_ndcg_at_10"] == 0).mean()),
        "primary_outcome": "q10_satisfaction",
        "primary_offline_metric": "seen_users_only overall NDCG@10",
        "correlation_interpretation": "descriptive; within-subject rows are not independent and offline NDCG is zero-inflated",
    }
    (args.output_dir / "analysis-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
