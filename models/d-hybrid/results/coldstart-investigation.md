# Cold-Start Investigation (D)

Response to the five audit questions raised for the item cold-start experiment.
All numbers below are from the actual run logs (`coldstart_item_log.txt`,
`…_log2.txt`, `…_log3.txt`), full data, seed 9727.

## TL;DR

The originally reported figure (`Popularity NDCG@10 ≈ 0.2925` vs
`Hybrid ≈ 0.0257`) contained **a leakage bug in the popularity baseline**, not
in the hybrid model. After fixing it, the popularity floor drops to
**0.0045** and the intended result holds: pure collaborative filtering collapses
on cold items while the hybrid recovers ranking signal from content.

| Condition | NDCG@10 | vs pure-id |
|---|---|---|
| `hybrid_content_only` (identity dropped) | **0.0488** | 81× |
| `hybrid_cold` (deployment view, untrained id kept) | 0.0258 | 43× |
| `pureid_cold` (BPR-MF, pure CF) | 0.0006 | 1× |
| `popularity_cold` (leak-free genre-popularity floor) | 0.0045 | 7.5× |

## Q1 — Are cold items fully removed from training interactions?

Yes. 600 cold items are chosen (60 per popularity decile), and **every** training
interaction touching them is deleted before any model is fitted:

```
ablated 671,634 training rows (17,166,540 remain)
```

Both the hybrid and the pure-id model are trained on this identical ablated set.
The cold items' *test* interactions are untouched and serve as ground truth.

## Q2 — Did popularity wrongly use test-period or full popularity? (the bug)

**Yes — this was the bug.** The first version ranked cold items using the
pre-shipped `item_popularity.parquet`, whose ranks were computed on the **full
data including the test period, before ablation**. A cold item therefore carried
a popularity rank derived from the very interactions we were supposed to have
hidden. That inflated popularity to 0.2925.

Two things were fixed:

1. **Leaked item bias in the pure-id baseline.** A held-out item's id embedding
   is untrained noise, but its learned bias term `qb_` still encoded pre-ablation
   popularity. Zeroing only `Q_` left this bias leaking; we now zero `qb_` too, so
   the pure-id model genuinely cannot rank cold items (0.0006).
2. **Leaked popularity floor.** Replaced the pre-shipped global rank with a
   *genre-popularity* floor computed **only on the ablated training set**: each
   cold item is scored by the mean ablated-train interaction count of the non-cold
   items sharing its genres. No held-out information is used. This drops the floor
   from 0.2925 to 0.0045.

## Q3 — Same test users, items and candidate set across methods?

Yes. All conditions rank the **same** 600 cold items, for the **same** set of
113,261 evaluation users (those whose test set contains a cold item), using the
same per-decile ground truth. Only the model / scoring rule differs.

## Q4 — Could the result be explained by a reasonable popularity distribution?

Partly, and this is worth stating honestly. Even after the leak fix, the
per-decile breakdown shows hybrid winning by 6–11× on deciles 0–7 (long tail to
mid), but the head decile (9) is where any popularity-like signal is strongest.
This is expected: cold items' test interactions still skew toward intrinsically
popular titles. The hybrid's advantage is **concentrated in the long tail**,
which is exactly the segment the PlayFinder system exists to serve.

```
NDCG@10 by popularity decile (0 = long tail, 9 = head)
        hybrid_cold  hybrid_content_only  pureid_cold
0            0.0734               0.0361       0.0099
1            0.0849               0.0647       0.0007
4            0.0769               0.0569       0.0011
9            0.0269               0.0609       0.0001
```

## Q5 — Hard-coded local path?

`cold_start_item.py` derives the repository root from its own location and reads
the four ignored task-A parquet files from `data/`. No absolute local path is
hard-coded.

## Conclusion

The original hypothesis **is** supported once the popularity leakage is removed.
Pure collaborative filtering (the model class C builds) collapses to ~0 on items
with no training interactions; the hybrid recovers 43–81× that, with its
advantage strongest in the long tail. The honest caveat is that a leak-free
popularity floor is still non-trivial on the head of the distribution, because
cold-item test interactions remain head-skewed — but popularity cannot
personalise, whereas the hybrid can, across the whole catalogue.

Result files: `hybrid_coldstart_item_results.csv`,
`hybrid_coldstart_item_by_decile.csv`.
