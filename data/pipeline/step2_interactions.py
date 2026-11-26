from __future__ import annotations

from . import config, utils
from .utils import log, timer


def ensure_compact(con):
    if config.REC_COMPACT_PARQUET.exists():
        log(f"  reuse cached {config.REC_COMPACT_PARQUET.name}")
    else:
        utils.require_raw_inputs(config.RECS_CSV)
        with timer("convert recommendations.csv -> rec_compact.parquet"):
            con.execute(f"""
                COPY (
                    SELECT user_id, item_id,
                           arg_max(label, timestamp) AS label,
                           arg_max(hours, timestamp) AS hours,
                           MAX(timestamp)            AS timestamp
                    FROM (
                        SELECT
                            CAST(app_id  AS INTEGER) AS item_id,
                            CAST(user_id AS INTEGER) AS user_id,
                            CASE WHEN lower(CAST(is_recommended AS VARCHAR))
                                      IN ('true','1','t')
                                 THEN 1 ELSE 0 END::TINYINT     AS label,
                            CAST(hours AS FLOAT)                AS hours,
                            CAST(epoch(CAST(date AS DATE)) AS BIGINT) AS timestamp
                        FROM read_csv_auto('{config.RECS_CSV.as_posix()}',
                                           header=true, ignore_errors=true)
                    )
                    GROUP BY user_id, item_id
                ) TO '{config.REC_COMPACT_PARQUET.as_posix()}' (FORMAT PARQUET)
            """)

    con.execute("CREATE OR REPLACE VIEW rec_raw AS SELECT * FROM "
                f"'{config.REC_COMPACT_PARQUET.as_posix()}'")
    rows, users, items = con.execute(
        "SELECT COUNT(*), COUNT(DISTINCT user_id), COUNT(DISTINCT item_id) "
        "FROM rec_raw").fetchone()
    log(f"  raw: {rows:,} interactions | {users:,} users | {items:,} items")
    return rows, users, items


def build_popularity(con):
    with timer("popularity on full data"):
        con.execute(f"""
            COPY (
                SELECT
                    item_id,
                    COUNT(*)                AS n_interactions,
                    SUM(label)              AS n_positive,
                    COUNT(DISTINCT user_id) AS n_users,
                    ROUND(AVG(label), 4)    AS positive_rate,
                    ROUND(AVG(hours), 2)    AS avg_hours,
                    ROUND(MEDIAN(hours), 2) AS median_hours,
                    -- item_id breaks ties, else parallel runs rank equal counts
                    -- arbitrarily and the file stops being reproducible
                    ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, item_id)
                        AS popularity_rank
                FROM rec_raw
                GROUP BY item_id
            ) TO '{config.POPULARITY_PARQUET.as_posix()}' (FORMAT PARQUET)
        """)
    log(f"  wrote {config.POPULARITY_PARQUET.name}")


def kcore_filter(con, min_user: int, min_item: int):
    """Alternate user/item pruning until stable; only small id tables are kept."""
    con.execute("CREATE OR REPLACE TABLE valid_users AS "
                "SELECT DISTINCT user_id FROM rec_raw")
    previous, history = None, []

    for iteration in range(1, config.KCORE_MAX_ITERS + 1):
        con.execute(f"""
            CREATE OR REPLACE TABLE valid_items AS
            SELECT item_id FROM rec_raw JOIN valid_users USING (user_id)
            GROUP BY item_id HAVING COUNT(*) >= {min_item}
        """)
        con.execute(f"""
            CREATE OR REPLACE TABLE valid_users AS
            SELECT user_id FROM rec_raw JOIN valid_items USING (item_id)
            GROUP BY user_id HAVING COUNT(*) >= {min_user}
        """)
        n_users, n_items = (con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                            for t in ("valid_users", "valid_items"))
        history.append([n_users, n_items])
        log(f"    k-core iter {iteration}: {n_users:,} users | {n_items:,} items")
        if (n_users, n_items) == previous:
            break
        previous = (n_users, n_items)

    con.execute("""
        CREATE OR REPLACE VIEW core AS
        SELECT r.* FROM rec_raw r
        JOIN valid_users USING (user_id)
        JOIN valid_items USING (item_id)
    """)
    rows = con.execute("SELECT COUNT(*) FROM core").fetchone()[0]
    log(f"  core: {rows:,} interactions | {n_users:,} users | {n_items:,} items")
    return rows, n_users, n_items, history


def assign_user_groups(con):
    """Tertiles of interaction count; falls back to NTILE if too degenerate to split."""
    con.execute("CREATE OR REPLACE TABLE user_counts AS "
                "SELECT user_id, COUNT(*) AS n FROM core GROUP BY user_id")
    q33, q67 = con.execute("SELECT quantile_cont(n, 0.3333), "
                           "quantile_cont(n, 0.6667) FROM user_counts").fetchone()

    if q33 is not None and q33 < q67:
        method, cutoffs = "value_tertile", {"q33": float(q33), "q67": float(q67)}
        group = (f"CASE WHEN n <= {q33} THEN 'cold' "
                 f"WHEN n <= {q67} THEN 'normal' ELSE 'heavy' END")
    else:
        method, cutoffs = "ntile_fallback", {"q33": None, "q67": None}
        group = ("CASE NTILE(3) OVER (ORDER BY n, user_id) "
                 "WHEN 1 THEN 'cold' WHEN 2 THEN 'normal' ELSE 'heavy' END")

    con.execute(f"CREATE OR REPLACE TABLE user_group_tbl AS "
                f"SELECT user_id, n, {group} AS user_group FROM user_counts")
    groups = con.execute("""
        SELECT user_group, COUNT(*), MIN(n), MAX(n), ROUND(AVG(n), 1)
        FROM user_group_tbl GROUP BY user_group ORDER BY AVG(n)
    """).fetchall()
    log(f"  user grouping ({method}): "
        + " | ".join(f"{g[0]}={g[1]:,}[{g[2]}-{g[3]}]" for g in groups))
    return method, cutoffs, groups


def write_outputs(con):
    with timer("write interactions.parquet"):
        con.execute(f"""
            COPY (
                SELECT
                    CAST(c.user_id AS INTEGER) AS user_id,
                    CAST(c.item_id AS INTEGER) AS item_id,
                    CAST(c.label   AS TINYINT) AS label,
                    CAST(c.hours   AS FLOAT)   AS hours,
                    CAST(1 + {config.CONFIDENCE_ALPHA} * ln(1 + c.hours) AS FLOAT)
                        AS confidence,
                    CAST(c.timestamp AS BIGINT) AS timestamp,
                    g.user_group                AS user_group
                FROM core c JOIN user_group_tbl g USING (user_id)
            ) TO '{config.INTERACTIONS_PARQUET.as_posix()}' (FORMAT PARQUET)
        """)
    con.execute(f"""
        COPY (SELECT user_id, n AS n_interactions, user_group FROM user_group_tbl)
        TO '{config.USERS_PARQUET.as_posix()}' (FORMAT PARQUET)
    """)
    log(f"  wrote {config.INTERACTIONS_PARQUET.name} + {config.USERS_PARQUET.name}")


def main() -> None:
    utils.ensure_dirs()
    con = utils.duckdb_connect()
    try:
        with timer("STEP 2: interactions pipeline"):
            raw_rows, raw_users, raw_items = ensure_compact(con)
            build_popularity(con)
            rows, users, items, history = kcore_filter(
                con, config.MIN_USER_INTERACTIONS, config.MIN_ITEM_INTERACTIONS)
            method, cutoffs, groups = assign_user_groups(con)
            write_outputs(con)
            positive_rate = con.execute("SELECT AVG(label) FROM core").fetchone()[0]

        utils.update_summary("interactions", {
            "raw_interactions": raw_rows, "raw_users": raw_users,
            "raw_items": raw_items,
            "raw_sparsity": round(1 - raw_rows / (raw_users * raw_items), 8),
            "min_user_interactions": config.MIN_USER_INTERACTIONS,
            "min_item_interactions": config.MIN_ITEM_INTERACTIONS,
            "kcore_iter_sizes_users_items": history,
            "core_interactions": rows, "core_users": users, "core_items": items,
            "core_sparsity": round(1 - rows / (users * items), 8),
            "core_positive_rate": round(float(positive_rate), 4),
            "retained_interactions_pct": round(rows / raw_rows, 4),
            "confidence_alpha": config.CONFIDENCE_ALPHA,
            "user_group_method": method, "user_group_cutoffs": cutoffs,
            "user_groups": {name: {"n_users": n, "n_range": [lo, hi], "avg_n": avg}
                            for name, n, lo, hi, avg in groups},
        })
    finally:
        con.close()


if __name__ == "__main__":
    main()
