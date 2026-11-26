from __future__ import annotations

import pandas as pd

from . import config, utils
from .utils import log, timer

COLUMNS = ["item_id", "title", "description", "tags", "genres", "specs",
           "developer", "publisher", "price", "price_original", "discount",
           "win", "mac", "linux", "steam_deck", "early_access",
           "rating", "positive_ratio", "user_reviews", "release_date", "release_year"]

DTYPES = {"item_id": "int32", "positive_ratio": "int32", "user_reviews": "int32",
          "price": "float32", "price_original": "float32", "discount": "float32"}


def cast(value, to=int):
    try:
        return to(str(value).strip() if to is int else value)
    except (ValueError, TypeError):
        return None


def load_games() -> pd.DataFrame:
    games = pd.read_csv(config.GAMES_CSV).rename(columns={"app_id": "item_id"})
    log(f"  games.csv: {len(games):,} rows")
    for column in ("win", "mac", "linux", "steam_deck"):  # arrive as "true"/"false"
        games[column] = games[column].astype(str).str.lower().eq("true")
    games["item_id"] = games["item_id"].astype("int32")
    return games


def load_metadata() -> pd.DataFrame:
    records = [(cast(r.get("app_id")), (r.get("description") or "").strip(),
                list(r.get("tags") or []))
               for r in utils.iter_records(config.GAMES_META_JSON)]
    meta = (pd.DataFrame(records, columns=["item_id", "description", "tags"])
            .dropna(subset=["item_id"]).drop_duplicates("item_id"))
    meta["item_id"] = meta["item_id"].astype("int32")
    log(f"  games_metadata.json: {len(meta):,} rows")
    return meta


def load_ucsd() -> pd.DataFrame:
    records = [{"item_id": cast(r.get("id")),
                "genres": list(r.get("genres") or []),
                "specs": list(r.get("specs") or []),
                "developer": r.get("developer"),
                "publisher": r.get("publisher"),
                "ucsd_price": cast(r.get("price"), float),
                "early_access": bool(r.get("early_access", False))}
               for r in utils.iter_records(config.UCSD_STEAM_GAMES, utils.LITERAL)
               if cast(r.get("id")) is not None]
    ucsd = pd.DataFrame(records).drop_duplicates("item_id")
    ucsd["item_id"] = ucsd["item_id"].astype("int32")
    log(f"  steam_games.json (UCSD): {len(ucsd):,} rows")
    return ucsd


def build() -> pd.DataFrame:
    utils.require_raw_inputs(config.GAMES_CSV, config.GAMES_META_JSON,
                             config.UCSD_STEAM_GAMES)
    games = load_games()
    items = games.merge(load_metadata(), on="item_id", how="left") \
                 .merge(load_ucsd(), on="item_id", how="left")

    total = len(items)
    matched = int(items["developer"].notna().sum())
    log(f"  UCSD knowledge fields matched: {matched:,}/{total:,} ({matched / total:.1%})")

    for column in ("tags", "genres", "specs"):  # never null: callers iterate them
        items[column] = items[column].apply(lambda v: v if isinstance(v, list) else [])
    items["description"] = items["description"].fillna("").astype(str)
    items["early_access"] = items["early_access"].eq(True)  # NaN -> False

    items["price"] = items["price_final"].astype("float32")
    fallback = items["price"].isna() & items["ucsd_price"].notna()
    items.loc[fallback, "price"] = items.loc[fallback, "ucsd_price"]

    items["release_date"] = items["date_release"].astype(str)
    items["release_year"] = pd.to_datetime(
        items["date_release"], errors="coerce").dt.year.astype("Int32")

    items = items[COLUMNS].astype(DTYPES)
    utils.update_summary("items", {
        "n_items": total,
        "kaggle_games": len(games),
        "ucsd_metadata_matched": matched,
        "ucsd_match_rate": round(matched / total, 4),
        "description_present": int((items["description"].str.len() > 0).sum()),
        "with_tags": int((items["tags"].apply(len) > 0).sum()),
        "with_genres": int((items["genres"].apply(len) > 0).sum()),
    })
    return items


def main() -> None:
    utils.ensure_dirs()
    with timer("step1: build items.parquet"):
        items = build()
        items.to_parquet(config.ITEMS_PARQUET, engine="pyarrow", index=False)
        log(f"  wrote {config.ITEMS_PARQUET.name}: {len(items):,} rows "
            f"x {items.shape[1]} cols")


if __name__ == "__main__":
    main()
