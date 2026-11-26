# Study analysis

## Offline metrics

`extract_offline_ndcg.py` deterministically extracts the 138 required
profile-condition rows from B's unchanged `main_user_metric_values.csv`:

- scenario: `seen_users_only`
- scope: `overall`
- metric: `ndcg_at_k`
- k: `10`
- 46 profiles × Popularity/BPR/Hybrid

The resulting `offline-ndcg-selected.csv` is an audit-sized input for the user
study analysis.

The selected cohort is highly zero-inflated:

- Popularity: 3/46 users have NDCG@10 greater than zero;
- BPR: 2/46;
- Hybrid: 4/46.

This does not invalidate B's offline evaluation, but it makes a small-sample
user-level correlation unstable and dominated by tied zeros.

## Online analysis

The final analysis used 20 complete participants (60 participant-condition
rounds). De-identified source files are kept locally at:

- `study/data/logs/*.csv`
- `study/data/likert-responses.csv`
- `study/data/open-responses.csv`

Reproduce the aggregate outputs locally with:

```sh
python3 study/analysis/analyze_study.py
python3 study/analysis/run_within_subject_tests.py
python3 study/analysis/plot_study_results.py
```

Outputs are written to `study/results/`. The primary online comparison is Q10
overall satisfaction across A/B/C using a Friedman test. Wilcoxon signed-rank
pairwise comparisons are Holm-adjusted. Binary outcomes use Cochran's Q and
exact McNemar comparisons. The online/offline analysis reports Spearman and
Pearson coefficients, usable pair counts, offline zero rates, and
participant-cluster bootstrap intervals. Correlations are descriptive and must
not be described as causal.

## Final execution status

- 20 participants and 60 complete rounds were analysed.
- The primary satisfaction difference is not significant: Friedman
  χ²(2)=0.098, p=.952.
- No Holm-adjusted pairwise difference is significant.
- The pooled satisfaction–NDCG Spearman estimate is −0.082 with a
  participant-cluster bootstrap 95% CI [−0.194, 0.011].
- The matched offline NDCG zero rate is 96.7% (58/60), so the association is
  reported as uninformative rather than negative.

Committed outputs are aggregate CSV/JSON, figures, and the executed notebook.
`study/data/` and `study/results/participant-condition-analysis.csv` are
explicitly excluded from Git.
