from __future__ import annotations

import os
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _path(var: str, default: Path) -> Path:
    value = os.environ.get(var)
    return Path(value).expanduser().resolve() if value else default


# Raw data is never committed; point PLAYFINDER_RAW_DIR at archive/ + UCSD/.
RAW_DIR = _path("PLAYFINDER_RAW_DIR", REPO_ROOT / "raw")
GAMES_CSV = RAW_DIR / "archive/games.csv"
USERS_CSV = RAW_DIR / "archive/users.csv"
RECS_CSV = RAW_DIR / "archive/recommendations.csv"
GAMES_META_JSON = RAW_DIR / "archive/games_metadata.json"
UCSD_STEAM_GAMES = RAW_DIR / "UCSD/steam_games.json"
UCSD_USER_ITEMS = RAW_DIR / "UCSD/australian_users_items.json"
UCSD_USER_REVIEWS = RAW_DIR / "UCSD/australian_user_reviews.json"
UCSD_BUNDLES = RAW_DIR / "UCSD/bundle_data.json"

OUTPUT_DIR = _path("PLAYFINDER_OUTPUT_DIR", REPO_ROOT / "data")
FIG_DIR = OUTPUT_DIR / "figures"
ITEMS_PARQUET = OUTPUT_DIR / "items.parquet"
INTERACTIONS_PARQUET = OUTPUT_DIR / "interactions.parquet"
USERS_PARQUET = OUTPUT_DIR / "users.parquet"
POPULARITY_PARQUET = OUTPUT_DIR / "item_popularity.parquet"
UCSD_PLAYTIME_PARQUET = OUTPUT_DIR / "interactions_ucsd_playtime.parquet"
UCSD_REVIEWS_PARQUET = OUTPUT_DIR / "ucsd_reviews.parquet"
BUNDLES_PARQUET = OUTPUT_DIR / "bundles.parquet"
SUMMARY_JSON = OUTPUT_DIR / "data_summary.json"
REC_COMPACT_PARQUET = OUTPUT_DIR / "rec_compact.parquet"  # cache, safe to delete

MIN_USER_INTERACTIONS = int(os.environ.get("PLAYFINDER_MIN_USER", 5))
MIN_ITEM_INTERACTIONS = int(os.environ.get("PLAYFINDER_MIN_ITEM", 20))
KCORE_MAX_ITERS = 10
CONFIDENCE_ALPHA = float(os.environ.get("PLAYFINDER_CONFIDENCE_ALPHA", 1.0))
USER_GROUP_METHOD = "interaction_tertile"
USER_GROUP_LABELS = ["cold", "normal", "heavy"]
RANDOM_SEED = 42

DUCKDB_MEMORY_LIMIT = os.environ.get("PLAYFINDER_DUCKDB_MEMORY", "3GB")
DUCKDB_THREADS = int(os.environ.get("PLAYFINDER_DUCKDB_THREADS", 4))
_SCRATCH = Path(tempfile.gettempdir()) / "playfinder_scratch"
DUCKDB_TEMP_DIR = _SCRATCH / "duckdb"
UCSD_PARTS_DIR = _SCRATCH / "ucsd_parts"

_REPORTED = ("MIN_USER_INTERACTIONS", "MIN_ITEM_INTERACTIONS", "KCORE_MAX_ITERS",
             "CONFIDENCE_ALPHA", "USER_GROUP_METHOD", "USER_GROUP_LABELS",
             "RANDOM_SEED")


def apply_overrides(confidence_alpha: float | None = None) -> None:
    global CONFIDENCE_ALPHA
    if confidence_alpha is not None:
        CONFIDENCE_ALPHA = float(confidence_alpha)


def as_dict() -> dict:
    return {name.lower(): globals()[name] for name in _REPORTED}
