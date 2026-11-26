from __future__ import annotations

import ast
import re
from datetime import datetime
from itertools import islice
from multiprocessing import get_context

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from . import config, utils
from .utils import log, timer

INT32_MAX = 2 ** 31 - 1
_POSTED = re.compile(r"Posted\s+(\w+)\s+(\d+),?\s*(\d{4})?")
_MONTHS = {name: n for n, name in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], 1)}


def to_int(value):
    try:
        return int(str(value).strip())
    except (ValueError, TypeError):
        return None


def in_int32(value) -> bool:
    return value is not None and 0 <= value <= INT32_MAX


def _worker(args) -> int:
    start, stop, part = args
    users, items, minutes = [], [], []

    with open(config.UCSD_USER_ITEMS, encoding="utf-8") as handle:
        for line in islice(handle, start, stop):
            try:
                record = ast.literal_eval(line.strip())
            except (ValueError, SyntaxError):
                continue
            # steam_id is numeric; user_id is often a vanity handle. Kept as a
            # string - no arithmetic needed, and some ids exceed int64.
            steam_id = record.get("steam_id") or record.get("user_id")
            if steam_id is None:
                continue
            for item in (record.get("items") or []):
                item_id = to_int(item.get("item_id"))
                if not in_int32(item_id):
                    continue
                played = to_int(item.get("playtime_forever")) or 0
                users.append(str(steam_id))
                items.append(item_id)
                minutes.append(played if in_int32(played) else 0)

    if users:
        pq.write_table(pa.table({
            "user_id": pa.array(users, pa.string()),
            "item_id": pa.array(items, pa.int32()),
            "playtime_min": pa.array(minutes, pa.int32()),
        }), part)
    return len(users)


def build_playtime() -> dict:
    utils.require_raw_inputs(config.UCSD_USER_ITEMS)
    config.UCSD_PARTS_DIR.mkdir(parents=True, exist_ok=True)
    for stale in config.UCSD_PARTS_DIR.glob("part-*.parquet"):
        stale.unlink()

    with open(config.UCSD_USER_ITEMS, "rb") as handle:
        n_lines = sum(1 for _ in handle)
    workers = config.DUCKDB_THREADS
    chunk = -(-n_lines // workers)
    jobs = [(i * chunk, min((i + 1) * chunk, n_lines),
             str(config.UCSD_PARTS_DIR / f"part-{i}.parquet")) for i in range(workers)]

    with timer("UCSD playtime (parallel parse -> parquet)"):
        with get_context("spawn").Pool(workers) as pool:
            rows = sum(pool.map(_worker, jobs))

        con = utils.duckdb_connect()
        try:  # playtime_forever is in minutes; convert to hours like Kaggle's column
            con.execute(f"""
                COPY (
                    SELECT user_id, item_id, playtime_min,
                           CAST(playtime_min / 60.0 AS FLOAT) AS hours,
                           CAST(1 + {config.CONFIDENCE_ALPHA}
                                * ln(1 + playtime_min / 60.0) AS FLOAT) AS confidence
                    FROM read_parquet(
                        '{(config.UCSD_PARTS_DIR / "part-*.parquet").as_posix()}')
                ) TO '{config.UCSD_PLAYTIME_PARQUET.as_posix()}' (FORMAT PARQUET)
            """)
            users, items = con.execute(
                "SELECT COUNT(DISTINCT user_id), COUNT(DISTINCT item_id) FROM "
                f"'{config.UCSD_PLAYTIME_PARQUET.as_posix()}'").fetchone()
        finally:
            con.close()

    log(f"  playtime: {rows:,} rows | {users:,} users | {items:,} items")
    return {"n_rows": rows, "n_users": users, "n_items": items}


def parse_posted(text):
    match = _POSTED.search(text) if text else None
    if not match or match.group(3) is None or match.group(1) not in _MONTHS:
        return None
    try:
        return int(datetime(int(match.group(3)), _MONTHS[match.group(1)],
                            int(match.group(2))).timestamp())
    except ValueError:
        return None


def build_reviews() -> dict:
    utils.require_raw_inputs(config.UCSD_USER_REVIEWS)
    with timer("UCSD reviews -> parquet"):
        rows = [(str(record["user_id"]), to_int(review.get("item_id")),
                 1 if review.get("recommend") else 0,
                 parse_posted(review.get("posted")))
                for record in utils.iter_records(config.UCSD_USER_REVIEWS,
                                                 utils.LITERAL)
                if record.get("user_id") is not None
                for review in (record.get("reviews") or [])
                if in_int32(to_int(review.get("item_id")))]

        reviews = pd.DataFrame(rows, columns=["user_id", "item_id", "label",
                                              "timestamp"]).astype(
            {"user_id": "string", "item_id": "int32", "label": "int8",
             "timestamp": "Int64"})
        reviews.to_parquet(config.UCSD_REVIEWS_PARQUET, engine="pyarrow", index=False)

    log(f"  reviews: {len(reviews):,} rows | {reviews['user_id'].nunique():,} users")
    return {"n_rows": len(reviews), "n_users": int(reviews["user_id"].nunique()),
            "positive_rate": round(float(reviews["label"].mean()), 4)}


def parse_price(text):
    try:
        return float(str(text).replace("$", "").replace(",", "").strip())
    except (ValueError, AttributeError):
        return None


def _bundle(record: dict) -> dict:
    item_ids = [i for i in (to_int(item.get("item_id"))
                            for item in (record.get("items") or [])) if i is not None]
    return {"bundle_id": to_int(record.get("bundle_id")),
            "bundle_name": record.get("bundle_name"),
            "price": parse_price(record.get("bundle_price")),
            "final_price": parse_price(record.get("bundle_final_price")),
            "n_items": len(item_ids), "item_ids": item_ids}


def build_bundles() -> dict:
    utils.require_raw_inputs(config.UCSD_BUNDLES)
    with timer("UCSD bundles -> parquet"):
        bundles = pd.DataFrame(
            [_bundle(r) for r in
             utils.iter_records(config.UCSD_BUNDLES, utils.LITERAL)])
        bundles.to_parquet(config.BUNDLES_PARQUET, engine="pyarrow", index=False)

    log(f"  bundles: {len(bundles):,} bundles")
    return {"n_bundles": len(bundles)}


def main() -> None:
    utils.ensure_dirs()
    with timer("STEP 3: UCSD extras"):
        summary = {"playtime": build_playtime(), "reviews": build_reviews(),
                   "bundles": build_bundles()}
    utils.update_summary("ucsd_extras", summary | {
        "note": "UCSD user_id is a Steam id (stored as string), a separate id "
                "space from Kaggle user_id; only items share the Steam appid."})


if __name__ == "__main__":
    main()
