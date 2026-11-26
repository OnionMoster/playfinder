from __future__ import annotations

import ast
import json
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

from . import config

LITERAL = ast.literal_eval  # UCSD dumps are Python reprs, not JSON
JSON = json.loads


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


@contextmanager
def timer(name: str):
    log(f"START  {name}")
    started = time.time()
    try:
        yield
    finally:
        log(f"DONE   {name}  ({time.time() - started:,.1f}s)")


def iter_records(path: Path, parse: Callable = JSON) -> Iterator[dict]:
    """One record per line. Unparseable lines are skipped and reported."""
    skipped = total = 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            total += 1
            try:
                yield parse(line)
            except (ValueError, SyntaxError):
                skipped += 1
    if skipped:
        log(f"  warn: skipped {skipped:,}/{total:,} bad lines in {path.name}")


def load_summary() -> dict:
    if not config.SUMMARY_JSON.exists():
        return {}
    return json.loads(config.SUMMARY_JSON.read_text(encoding="utf-8"))


def update_summary(section: str, payload: dict) -> None:
    summary = load_summary() | {section: payload, "parameters": config.as_dict()}
    ensure_dirs()
    config.SUMMARY_JSON.write_text(
        json.dumps(summary, indent=2, default=str), encoding="utf-8")
    log(f"  summary['{section}'] written")


def ensure_dirs() -> None:
    for directory in (config.OUTPUT_DIR, config.FIG_DIR,
                      config.DUCKDB_TEMP_DIR, config.UCSD_PARTS_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def require_raw_inputs(*paths: Path) -> None:
    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        raise FileNotFoundError(
            "Missing raw input file(s):\n  " + "\n  ".join(missing) +
            f"\nDownload the Kaggle and UCSD datasets (see data/README.md), then "
            f"place them under '{config.RAW_DIR}' or set PLAYFINDER_RAW_DIR.")


def duckdb_connect():
    import duckdb

    ensure_dirs()
    con = duckdb.connect()
    for setting in (f"memory_limit='{config.DUCKDB_MEMORY_LIMIT}'",
                    f"threads={config.DUCKDB_THREADS}",
                    f"temp_directory='{config.DUCKDB_TEMP_DIR.as_posix()}'",
                    "preserve_insertion_order=false"):
        con.execute(f"SET {setting}")
    return con
