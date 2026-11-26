from __future__ import annotations

import sys

import pandas as pd
import pyarrow.parquet as pq

from . import config, utils

CONTRACT = {"user_id": "int32", "item_id": "int32", "label": "int8",
            "hours": "float", "confidence": "float",
            "timestamp": "int64", "user_group": "string"}

ITEM_COLUMNS = {"item_id", "title", "description", "tags", "genres", "specs",
                "developer", "publisher", "price", "win", "mac", "linux",
                "release_date", "release_year"}

UCSD_COLUMNS = [("UCSD_PLAYTIME_PARQUET", {"user_id", "item_id", "hours", "confidence"}),
                ("UCSD_REVIEWS_PARQUET", {"user_id", "item_id", "label", "timestamp"}),
                ("BUNDLES_PARQUET", {"bundle_id", "item_ids", "n_items"})]

failures: list[str] = []
warnings: list[str] = []


def check(name: str, passed: bool, detail: str = "", hard: bool = True) -> None:
    print(f"  [{'PASS' if passed else 'FAIL' if hard else 'WARN'}] {name}"
          + (f" - {detail}" if detail else ""))
    if not passed:
        (failures if hard else warnings).append(name)


def verify_items() -> None:
    print("items.parquet")
    items = pd.read_parquet(config.ITEMS_PARQUET)
    for name, passed in (
        ("required columns present", ITEM_COLUMNS <= set(items.columns)),
        ("item_id unique", items["item_id"].is_unique),
        ("item_id is int32", items["item_id"].dtype == "int32"),
        ("list columns never null",
         all(items[c].map(lambda v: hasattr(v, "__len__")).all()
             for c in ("tags", "genres", "specs"))),
        ("platform columns are bool",
         all(items[c].dtype == bool for c in ("win", "mac", "linux"))),
    ):
        check(name, passed)


def verify_interactions() -> None:
    print("interactions.parquet")
    schema = pq.read_schema(config.INTERACTIONS_PARQUET)
    actual = dict(zip(schema.names, map(str, schema.types)))
    for column, expected in CONTRACT.items():
        check(f"column {column}:{expected}", actual.get(column) == expected,
              f"got {actual.get(column)}")

    con = utils.duckdb_connect()
    table = f"'{config.INTERACTIONS_PARQUET.as_posix()}'"
    try:
        rows, lo, hi, min_hours, min_conf = con.execute(
            f"SELECT COUNT(*), MIN(label), MAX(label), MIN(hours), MIN(confidence) "
            f"FROM {table}").fetchone()
        check("row count matches summary",
              rows == utils.load_summary()["interactions"]["core_interactions"],
              f"{rows:,}")
        check("label in {0,1}", lo >= 0 and hi <= 1, f"[{lo},{hi}]")
        check("hours >= 0", min_hours >= 0, f"min={min_hours}")
        check("confidence >= 1", min_conf >= 1 - 1e-6, f"min={min_conf:.4f}")

        groups = {row[0] for row in
                  con.execute(f"SELECT DISTINCT user_group FROM {table}").fetchall()}
        check("user_group vocabulary", groups <= set(config.USER_GROUP_LABELS),
              str(groups))

        for entity, minimum in (("user", config.MIN_USER_INTERACTIONS),
                                ("item", config.MIN_ITEM_INTERACTIONS)):
            smallest = con.execute(
                f"SELECT MIN(c) FROM (SELECT COUNT(*) c FROM {table} "
                f"GROUP BY {entity}_id)").fetchone()[0]
            check(f"k-core: every {entity} >= {minimum}", smallest >= minimum,
                  f"min={smallest}")

        duplicates = con.execute(
            f"SELECT COUNT(*) FROM (SELECT user_id, item_id, COUNT(*) c "
            f"FROM {table} GROUP BY 1, 2 HAVING c > 1)").fetchone()[0]
        check("no duplicate (user,item) pairs", duplicates == 0,
              f"{duplicates:,} duplicate pairs")

        orphans = con.execute(
            f"SELECT COUNT(DISTINCT item_id) FROM {table} WHERE item_id NOT IN "
            f"(SELECT item_id FROM '{config.ITEMS_PARQUET.as_posix()}')").fetchone()[0]
        check("every interaction item has metadata", orphans == 0,
              f"{orphans} items missing from items.parquet")
    finally:
        con.close()


def verify_users() -> None:
    print("users.parquet")
    users = pd.read_parquet(config.USERS_PARQUET)
    stats = utils.load_summary()["interactions"]
    check("user rows == core users", len(users) == stats["core_users"],
          f"{len(users):,}")
    check("group sizes match summary",
          users["user_group"].value_counts().to_dict()
          == {name: g["n_users"] for name, g in stats["user_groups"].items()})


def verify_ucsd() -> None:
    print("UCSD extras")
    for attribute, required in UCSD_COLUMNS:
        path = getattr(config, attribute)
        if not path.exists():
            check(f"{path.name} exists", False, "not built (step3 skipped?)", hard=False)
            continue
        rows = pq.read_metadata(path).num_rows
        check(f"{path.name}: columns + non-empty",
              required <= set(pq.read_schema(path).names) and rows > 0,
              f"rows={rows:,}")


def main() -> None:
    print("=" * 62, "PlayFinder Module-A - output verification", "=" * 62, sep="\n")
    verify_items()
    verify_interactions()
    verify_users()
    verify_ucsd()
    print("-" * 62)

    if failures:
        print(f"RESULT: {len(failures)} hard failure(s): {failures}")
        sys.exit(1)
    print("RESULT: all hard checks PASSED"
          + (f" ({len(warnings)} warning(s): {warnings})" if warnings else ""))


if __name__ == "__main__":
    main()
