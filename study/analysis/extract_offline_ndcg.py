#!/usr/bin/env python3
"""Extract the exact user-level NDCG@10 rows needed by E's study analysis."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


CONDITIONS = {"popularity": "A", "bpr": "B", "hybrid": "C"}


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--metrics",
        type=Path,
        default=root / "eval/final_eval/main_user_metric_values.csv",
    )
    parser.add_argument(
        "--profiles",
        type=Path,
        default=root / "study-data/staging/three-model-provisional/study_profiles.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / "study/analysis/offline-ndcg-selected.csv",
    )
    args = parser.parse_args()

    profiles: dict[str, str] = {}
    with args.profiles.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            profiles[str(row["model_user_id"])] = row["profile_id"]

    selected: list[dict[str, str]] = []
    with args.metrics.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            user_id = str(row["user_id"])
            if user_id not in profiles:
                continue
            if row["model"] not in CONDITIONS:
                continue
            if row["scenario"] != "seen_users_only" or row["scope"] != "overall":
                continue
            if row["metric"] != "ndcg_at_k" or row["k"] != "10":
                continue
            selected.append(
                {
                    "profile_id": profiles[user_id],
                    "model_user_id": user_id,
                    "condition": CONDITIONS[row["model"]],
                    "model": row["model"],
                    "scenario": row["scenario"],
                    "scope": row["scope"],
                    "metric": row["metric"],
                    "k": row["k"],
                    "value": row["value"],
                }
            )

    selected.sort(key=lambda row: (row["profile_id"], row["condition"]))
    expected = len(profiles) * len(CONDITIONS)
    keys = {(row["profile_id"], row["condition"]) for row in selected}
    if len(selected) != expected or len(keys) != expected:
        raise SystemExit(
            f"expected {expected} unique profile-condition rows, "
            f"found {len(selected)} rows and {len(keys)} unique keys"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "profile_id",
        "model_user_id",
        "condition",
        "model",
        "scenario",
        "scope",
        "metric",
        "k",
        "value",
    ]
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(selected)
    print(f"wrote {len(selected)} rows to {args.output}")


if __name__ == "__main__":
    main()
