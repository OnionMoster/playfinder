from __future__ import annotations

import argparse
import csv
from pathlib import Path

from evaluation_core import write_csv, write_significance_tests


EXPECTED_FIELDS = ["model", "scenario", "scope", "user_id", "metric", "k", "value"]

B_DIR = Path(__file__).resolve().parent
RESULTS_DIR = B_DIR / "results"
BASELINE_USER_METRICS = RESULTS_DIR / "user_metric_values.csv"
ALL_USER_METRICS = RESULTS_DIR / "all_user_metric_values.csv"
ALL_SIGNIFICANCE = RESULTS_DIR / "all_significance_tests.csv"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge multiple user_metric_values CSV files and rerun significance tests."
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        help="Extra user_metric_values CSV files or directories that contain them.",
    )
    return parser.parse_args()


def normalize_fieldnames(fieldnames: list[str] | None) -> list[str]:
    return [str(name).strip() for name in (fieldnames or [])]


def load_rows(path: Path) -> list[dict[str, object]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = normalize_fieldnames(reader.fieldnames)
        if fieldnames != EXPECTED_FIELDS:
            raise ValueError(
                f"{path} 的表头不是 {EXPECTED_FIELDS}，当前读到的是 {fieldnames}"
            )
        rows: list[dict[str, object]] = []
        for row in reader:
            cleaned = {field: row.get(field, "") for field in EXPECTED_FIELDS}
            if any(str(cleaned[field]).strip() for field in EXPECTED_FIELDS):
                rows.append(cleaned)
        return rows


def expand_inputs(inputs: list[str]) -> list[Path]:
    paths: list[Path] = []
    for raw in inputs:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"找不到输入文件或目录: {path}")
        if path.is_dir():
            paths.extend(sorted(candidate for candidate in path.glob("*.csv") if candidate.is_file()))
        else:
            paths.append(path)
    return paths


def unique_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    seen = set()
    deduped: list[dict[str, object]] = []
    for row in rows:
        key = tuple(str(row[field]) for field in EXPECTED_FIELDS)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def sort_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    return sorted(
        rows,
        key=lambda row: (
            str(row["model"]),
            str(row["scenario"]),
            str(row["scope"]),
            str(row["user_id"]),
            str(row["metric"]),
            str(row["k"]),
        ),
    )


def main() -> None:
    if not BASELINE_USER_METRICS.exists():
        raise FileNotFoundError(f"找不到 baseline 用户级指标文件: {BASELINE_USER_METRICS}")

    input_paths = expand_inputs(parse_args().inputs)
    filtered_inputs: list[Path] = []
    for path in input_paths:
        resolved = path.resolve()
        if resolved in {
            BASELINE_USER_METRICS.resolve(),
            ALL_USER_METRICS.resolve(),
            ALL_SIGNIFICANCE.resolve(),
        }:
            continue
        filtered_inputs.append(resolved)

    merged_rows = load_rows(BASELINE_USER_METRICS)
    for path in filtered_inputs:
        merged_rows.extend(load_rows(path))

    merged_rows = sort_rows(unique_rows(merged_rows))

    write_csv(ALL_USER_METRICS, merged_rows, EXPECTED_FIELDS)
    write_significance_tests(ALL_SIGNIFICANCE, merged_rows)

    print(f"Saved: {ALL_USER_METRICS}")
    print(f"Saved: {ALL_SIGNIFICANCE}")
    print(f"Baseline rows: {len(load_rows(BASELINE_USER_METRICS))}")
    print(f"Extra files: {len(filtered_inputs)}")
    print(f"Merged rows: {len(merged_rows)}")


if __name__ == "__main__":
    main()
