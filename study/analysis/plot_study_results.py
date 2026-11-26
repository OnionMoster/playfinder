#!/usr/bin/env python3
"""Create publication-ready aggregate figures for the PlayFinder study."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


COLORS = {
    "A": "#7A7F87",
    "B": "#E07A3F",
    "C": "#1F7A8C",
}
LABELS = {
    "A": "Popularity",
    "B": "BPR",
    "C": "Hybrid",
}


def style() -> None:
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "axes.titlesize": 15,
        "axes.labelsize": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": False,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
    })


def save(fig: plt.Figure, output: Path) -> None:
    fig.savefig(output, dpi=220, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)


def plot_experience(intervals: pd.DataFrame, output_dir: Path) -> None:
    outcomes = [
        ("q10_satisfaction", "Satisfaction"),
        ("perceived_relevance", "Relevance"),
        ("discovery_quality", "Discovery"),
        ("constraint_fit", "Constraint fit"),
    ]
    fig, ax = plt.subplots(figsize=(11.2, 5.8))
    x = np.arange(len(outcomes), dtype=float)
    offsets = {"A": -0.22, "B": 0.0, "C": 0.22}
    for condition in ["A", "B", "C"]:
        subset = intervals[(intervals["condition"] == condition)].set_index("outcome")
        means = np.array([subset.loc[outcome, "mean"] for outcome, _ in outcomes])
        lows = np.array([subset.loc[outcome, "bootstrap_ci_low"] for outcome, _ in outcomes])
        highs = np.array([subset.loc[outcome, "bootstrap_ci_high"] for outcome, _ in outcomes])
        ax.errorbar(
            x + offsets[condition], means,
            yerr=np.vstack([means - lows, highs - means]),
            fmt="o", markersize=8, capsize=4, elinewidth=2,
            color=COLORS[condition], label=LABELS[condition], zorder=3,
        )
    ax.set_xticks(x, [label for _, label in outcomes])
    ax.set_ylim(1, 7)
    ax.set_yticks(range(1, 8))
    ax.set_ylabel("Mean Likert score (1–7)")
    fig.suptitle("BPR leads descriptively on subjective experience, but uncertainty overlaps",
                 fontsize=16, y=0.98)
    fig.text(0.09, 0.89,
             "Points are means; bars are participant-bootstrap 95% CIs (n=20 per condition).",
             color="#555B63")
    ax.axhline(4, color="#D5D7DA", linewidth=1, linestyle="--", zorder=1)
    ax.legend(frameon=False, ncol=3, loc="lower center", bbox_to_anchor=(0.5, -0.25))
    fig.subplots_adjust(bottom=0.24, top=0.82, left=0.09, right=0.98)
    save(fig, output_dir / "online-experience-means.png")


def plot_behaviour(intervals: pd.DataFrame, output_dir: Path) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(11.2, 5.2), gridspec_kw={"wspace": 0.34})
    conditions = ["A", "B", "C"]
    x = np.arange(3)

    dwell = intervals[intervals["outcome"] == "total_dwell_seconds"].set_index("condition")
    means = dwell.loc[conditions, "mean"].to_numpy()
    lows = dwell.loc[conditions, "bootstrap_ci_low"].to_numpy()
    highs = dwell.loc[conditions, "bootstrap_ci_high"].to_numpy()
    axes[0].bar(x, means, color=[COLORS[c] for c in conditions], width=0.64)
    axes[0].errorbar(x, means, yerr=np.vstack([means - lows, highs - means]),
                     fmt="none", ecolor="#20242A", capsize=4, linewidth=1.7)
    axes[0].set_xticks(x, [LABELS[c] for c in conditions])
    axes[0].set_ylim(0, max(highs) * 1.18)
    axes[0].set_ylabel("Mean detail dwell time (seconds)")
    axes[0].set_title("Hybrid kept users in details longest")
    for index, value in enumerate(means):
        axes[0].text(index, value + 0.35, f"{value:.1f}s", ha="center", va="bottom", weight="bold")

    width = 0.32
    accepted = intervals[intervals["outcome"] == "accepted_any"].set_index("condition")
    rejected = intervals[intervals["outcome"] == "rejected_any"].set_index("condition")
    accept_values = accepted.loc[conditions, "mean"].to_numpy()
    reject_values = rejected.loc[conditions, "mean"].to_numpy()
    axes[1].bar(x - width / 2, accept_values, width=width, color="#2A9D8F", label="Accepted ≥1")
    axes[1].bar(x + width / 2, reject_values, width=width, color="#C75C5C", label="Rejected ≥1")
    axes[1].set_xticks(x, [LABELS[c] for c in conditions])
    axes[1].set_ylim(0, 1.08)
    axes[1].set_yticks(np.linspace(0, 1, 6), [f"{value:.0%}" for value in np.linspace(0, 1, 6)])
    axes[1].set_ylabel("Participant rate")
    axes[1].set_title("Binary actions were near ceiling")
    axes[1].legend(frameon=False, loc="lower center", bbox_to_anchor=(0.5, -0.25), ncol=2)
    fig.suptitle("Behavior suggests engagement differences, not a decisive condition winner", fontsize=16, y=1.02)
    fig.text(0.5, 0.01, "Means and bootstrap 95% CIs shown for dwell; n=20 paired participants.",
             ha="center", color="#555B63")
    fig.subplots_adjust(bottom=0.24, top=0.84, left=0.08, right=0.98)
    save(fig, output_dir / "behavioral-outcomes.png")


def plot_correlation(analysis: pd.DataFrame, correlations: pd.DataFrame, output_dir: Path) -> None:
    primary = correlations[
        (correlations["scope"] == "pooled")
        & (correlations["outcome"] == "q10_satisfaction")
        & (correlations["method"] == "spearman")
    ].iloc[0]
    fig, ax = plt.subplots(figsize=(9.6, 5.8))
    random = np.random.default_rng(9727)
    for condition in ["A", "B", "C"]:
        subset = analysis[analysis["condition"] == condition]
        jitter = random.uniform(-0.055, 0.055, len(subset))
        ax.scatter(
            subset["offline_ndcg_at_10"],
            subset["q10_satisfaction"] + jitter,
            s=58, alpha=0.68, color=COLORS[condition], edgecolor="white", linewidth=0.6,
            label=LABELS[condition],
        )
    zero_count = int((analysis["offline_ndcg_at_10"] == 0).sum())
    ax.axvline(0, color="#30343B", linewidth=1.1, alpha=0.6)
    ax.set_xlim(-0.001, max(analysis["offline_ndcg_at_10"].max() * 1.15, 0.035))
    ax.set_ylim(0.7, 7.3)
    ax.set_yticks(range(1, 8))
    ax.set_xlabel("Offline NDCG@10 (seen-users-only, overall)")
    ax.set_ylabel("Q10 satisfaction (1–7; jittered vertically)")
    ax.set_title("The study cannot estimate an offline–online relationship")
    ax.text(
        0.98, 0.97,
        f"{zero_count}/60 offline scores are zero\n"
        f"Spearman ρ = {primary['correlation']:.3f}\n"
        f"cluster-bootstrap 95% CI\n[{primary['cluster_bootstrap_ci_low']:.3f}, {primary['cluster_bootstrap_ci_high']:.3f}]",
        transform=ax.transAxes, ha="right", va="top", fontsize=11,
        bbox={"boxstyle": "round,pad=0.5", "facecolor": "white", "edgecolor": "#D5D7DA"},
    )
    ax.legend(frameon=False, ncol=3, loc="lower right")
    fig.subplots_adjust(bottom=0.14, top=0.84, left=0.11, right=0.98)
    save(fig, output_dir / "offline-online-correlation.png")


def plot_cold_start(results: pd.DataFrame, deciles: pd.DataFrame, output_dir: Path) -> None:
    model_order = ["pureid_cold", "popularity_cold", "hybrid_cold", "hybrid_content_only"]
    labels = ["Pure-ID", "Popularity\n(leak-free)", "Hybrid", "Hybrid\ncontent-only"]
    colors = ["#A7ABB1", "#7A7F87", "#1F7A8C", "#E07A3F"]
    values = results.set_index("model").loc[model_order, "ndcg@10"].to_numpy()
    fig, ax = plt.subplots(figsize=(9.6, 5.5))
    x = np.arange(len(model_order))
    ax.bar(x, values, color=colors, width=0.67)
    ax.set_xticks(x, labels)
    ax.set_ylim(0, max(values) * 1.22)
    ax.set_ylabel("Cold-item NDCG@10")
    fig.suptitle("Content features carry the strongest cold-item signal", fontsize=16, y=0.98)
    for index, value in enumerate(values):
        ax.text(index, value + 0.0012, f"{value:.4f}", ha="center", va="bottom", weight="bold")
    fig.text(0.11, 0.89,
             "Popularity is recomputed from training-period data only; n=113,261 users.",
             color="#555B63")
    fig.subplots_adjust(bottom=0.17, top=0.82, left=0.11, right=0.98)
    save(fig, output_dir / "cold-start-ndcg.png")

    fig, ax = plt.subplots(figsize=(9.8, 5.5))
    decile = deciles.rename(columns={deciles.columns[0]: "decile"})
    series = [
        ("hybrid_cold", "Hybrid", "#1F7A8C"),
        ("hybrid_content_only", "Hybrid content-only", "#E07A3F"),
        ("pureid_cold", "Pure-ID", "#A7ABB1"),
    ]
    for column, label, color in series:
        ax.plot(decile["decile"], decile[column], marker="o", linewidth=2.2,
                markersize=5.5, color=color, label=label)
    ax.set_xticks(range(10))
    ax.set_xlabel("Item-popularity decile (0 = least popular)")
    ax.set_ylabel("NDCG@10")
    ax.set_ylim(0, max(decile[[item[0] for item in series]].max()) * 1.17)
    ax.set_title("Cold-start gains extend across the long tail")
    ax.legend(frameon=False, ncol=3, loc="lower center", bbox_to_anchor=(0.5, -0.26))
    fig.subplots_adjust(bottom=0.25, top=0.86, left=0.11, right=0.98)
    save(fig, output_dir / "cold-start-by-decile.png")


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-dir", type=Path, default=root / "study/results")
    parser.add_argument(
        "--cold-start-results",
        type=Path,
        default=root / "models/d-hybrid/results/hybrid_coldstart_item_results.csv",
    )
    parser.add_argument(
        "--cold-start-deciles",
        type=Path,
        default=root / "models/d-hybrid/results/hybrid_coldstart_item_by_decile.csv",
    )
    args = parser.parse_args()
    output_dir = args.results_dir / "figures"
    output_dir.mkdir(parents=True, exist_ok=True)
    style()
    intervals = pd.read_csv(args.results_dir / "condition-summary-with-ci.csv")
    analysis = pd.read_csv(args.results_dir / "participant-condition-analysis.csv")
    correlations = pd.read_csv(args.results_dir / "correlations.csv")
    cold_start = pd.read_csv(args.cold_start_results)
    deciles = pd.read_csv(args.cold_start_deciles)
    plot_experience(intervals, output_dir)
    plot_behaviour(intervals, output_dir)
    plot_correlation(analysis, correlations, output_dir)
    plot_cold_start(cold_start, deciles, output_dir)
    print(f"Wrote 5 figures to {output_dir}")


if __name__ == "__main__":
    main()
