"""Build every Module-A artifact. Steps skip themselves when their output exists.

    python -m data.pipeline.run_all [--force] [--confidence-alpha A] [--only STEP ...]
"""
from __future__ import annotations

import argparse
import importlib

from . import config
from .utils import log

STEPS = {
    "step1_items": lambda: config.ITEMS_PARQUET,
    "step2_interactions": lambda: config.INTERACTIONS_PARQUET,
    "step3_ucsd_extras": lambda: config.UCSD_PLAYTIME_PARQUET,
    "step4_eda": lambda: config.FIG_DIR / "fig1_longtail_popularity.png",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the PlayFinder data artifacts.")
    parser.add_argument("--force", action="store_true", help="rebuild every step")
    parser.add_argument("--confidence-alpha", type=float, metavar="ALPHA",
                        help="alpha in confidence = 1 + alpha*ln(1+hours) "
                             f"(default {config.CONFIDENCE_ALPHA})")
    parser.add_argument("--only", nargs="+", metavar="STEP", choices=list(STEPS),
                        help="run only the named step(s)")
    args = parser.parse_args()

    config.apply_overrides(confidence_alpha=args.confidence_alpha)
    log(f"confidence_alpha = {config.CONFIDENCE_ALPHA}")

    for name, output_of in STEPS.items():
        if args.only and name not in args.only:
            continue
        # A new alpha rewrites the confidence column, so everything downstream
        # of items must be rebuilt even though the cached CSV stays valid.
        stale = args.force or (args.confidence_alpha is not None
                               and name != "step1_items")
        output = output_of()
        if output.exists() and not stale:
            log(f"SKIP {name} (found {output.name})")
            continue
        log(f"RUN  {name}")
        importlib.import_module(f".{name}", __package__).main()

    log("pipeline complete - run `python -m data.pipeline.verify` to QA the outputs")


if __name__ == "__main__":
    main()
