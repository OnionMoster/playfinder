from __future__ import annotations

from collections import Counter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from . import config, utils
from .utils import log, timer

plt.rcParams.update({
    "figure.dpi": 120, "savefig.dpi": 120, "font.size": 11,
    "axes.grid": True, "grid.alpha": 0.3,
    "axes.spines.top": False, "axes.spines.right": False,
    "figure.autolayout": True,
})
BLUE, ORANGE, GREEN, GREY = "#2b6cb0", "#dd6b20", "#38a169", "#a0aec0"


def save(fig, name: str) -> None:
    fig.savefig(config.FIG_DIR / name, bbox_inches="tight")
    plt.close(fig)
    log(f"  wrote figures/{name}")


def note(ax, text: str, edge: str, face: str, xy=(0.97, 0.95), size=10) -> None:
    ax.annotate(text, xy=xy, xycoords="axes fraction", ha="right", va="top",
                fontsize=size, bbox=dict(boxstyle="round", fc=face, ec=edge))


def fig_longtail() -> dict:
    counts = pd.read_parquet(config.POPULARITY_PARQUET, columns=["n_interactions"]
                             )["n_interactions"].sort_values(ascending=False).to_numpy()
    share = np.cumsum(counts) / counts.sum()
    top1, top10 = (share[max(0, int(len(counts) * p) - 1)] for p in (0.01, 0.10))

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.loglog(np.arange(1, len(counts) + 1), counts, color=BLUE, lw=1.6)
    ax.set(xlabel="Game rank (most reviewed -> least)",
           ylabel="Number of interactions",
           title="Item popularity is heavily long-tailed")
    note(ax, f"Top 1% of games = {top1:.0%} of interactions\n"
             f"Top 10% of games = {top10:.0%} of interactions", ORANGE, "#fffaf0")
    save(fig, "fig1_longtail_popularity.png")
    return {"top_1pct_share": round(float(top1), 4),
            "top_10pct_share": round(float(top10), 4)}


def fig_playtime(con) -> None:
    edges = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 1e12]
    labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50-100",
              "100-200", "200-500", "500-1k", "1k+"]
    cases = " ".join(f"WHEN hours >= {edges[i]} AND hours < {edges[i + 1]} THEN {i}"
                     for i in range(len(labels)))
    counts = dict(con.execute(
        f"SELECT CASE {cases} END AS bucket, COUNT(*) "
        f"FROM '{config.INTERACTIONS_PARQUET.as_posix()}' "
        f"GROUP BY bucket ORDER BY bucket").fetchall())

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.bar(labels, [counts.get(i, 0) for i in range(len(labels))], color=BLUE)
    ax.set(yscale="log", xlabel="Playtime at review (hours)",
           ylabel="Number of interactions (log)",
           title="Most reviews come from low-to-moderate playtime")
    plt.setp(ax.get_xticklabels(), rotation=45, ha="right")
    save(fig, "fig2_playtime_distribution.png")


def fig_year(con) -> None:
    rows = con.execute(
        "SELECT CAST(EXTRACT(year FROM to_timestamp(timestamp)) AS INT) AS y, COUNT(*) "
        f"FROM '{config.INTERACTIONS_PARQUET.as_posix()}' GROUP BY y ORDER BY y"
    ).fetchall()

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.bar([y for y, _ in rows], [n for _, n in rows], color=GREEN)
    ax.set(xlabel="Year", ylabel="Number of interactions",
           title="Interaction volume by year (modelling core)")
    save(fig, "fig3_interactions_by_year.png")


def fig_list_column(column: str, title: str, colour: str, filename: str) -> None:
    counter = Counter()
    for values in pd.read_parquet(config.ITEMS_PARQUET, columns=[column])[column]:
        if values is not None:
            counter.update(values)
    top = counter.most_common(20)
    if not top:
        return

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.barh([name for name, _ in top][::-1], [n for _, n in top][::-1], color=colour)
    ax.set(xlabel="Number of games", title=title)
    save(fig, filename)


def fig_user_activity() -> None:
    users = pd.read_parquet(config.USERS_PARQUET)
    counts = users["n_interactions"].to_numpy()

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.hist(counts, color=BLUE, bins=np.logspace(
        np.log10(counts.min()), np.log10(counts.max()), 40))
    ax.set(xscale="log", yscale="log", xlabel="Interactions per user (log)",
           ylabel="Number of users (log)", title="User activity distribution")

    sizes = users["user_group"].value_counts()
    note(ax, "cold/normal/heavy users:\n" + "\n".join(
        f"  {g}: {sizes[g]:,}" for g in config.USER_GROUP_LABELS if g in sizes),
        GREEN, "#f0fff4")
    save(fig, "fig6_user_activity.png")


def fig_scale_sparsity() -> None:
    stats = utils.load_summary().get("interactions")
    if not stats:
        return
    fields = ["interactions", "users", "items"]
    raw = [stats[f"raw_{f}"] for f in fields]
    core = [stats[f"core_{f}"] for f in fields]
    x, width = np.arange(3), 0.38

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.bar(x - width / 2, raw, width, label="Raw (full)", color=GREY)
    ax.bar(x + width / 2, core, width, color=BLUE,
           label=f"Core (>={config.MIN_USER_INTERACTIONS} user "
                 f"/ >={config.MIN_ITEM_INTERACTIONS} item)")
    ax.set(yscale="log", ylabel="Count (log)", xticks=x,
           xticklabels=["Interactions", "Users", "Items"],
           title="Scale before vs. after k-core filtering")
    ax.legend()

    raw_density = 1 - stats["raw_sparsity"]
    core_density = 1 - stats["core_sparsity"]
    note(ax, f"Matrix density:\n  raw  = {raw_density:.2e}\n"
             f"  core = {core_density:.2e}  ({core_density / raw_density:.1f}x denser)\n"
             f"Retained {stats['retained_interactions_pct']:.0%} of interactions",
         ORANGE, "#fffaf0", xy=(0.97, 0.62), size=9)
    save(fig, "fig7_scale_sparsity.png")


def main() -> None:
    utils.ensure_dirs()
    con = utils.duckdb_connect()
    try:
        with timer("STEP 4: EDA figures"):
            longtail = fig_longtail()
            fig_playtime(con)
            fig_year(con)
            fig_list_column("tags", "Top 20 content tags (Kaggle metadata)",
                            BLUE, "fig4_tag_frequency.png")
            fig_list_column("genres", "Top genres (UCSD knowledge metadata)",
                            ORANGE, "fig5_genre_frequency.png")
            fig_user_activity()
            fig_scale_sparsity()
    finally:
        con.close()
    utils.update_summary("eda", {"longtail": longtail})


if __name__ == "__main__":
    main()
