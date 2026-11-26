# D — Model Export Reproducibility Appendix

For E / the final report. This document does not modify any delivered ranking;
it records everything needed to reproduce `hybrid_top100.csv`. Fill the two
`⟨…⟩` placeholder groups (locally-computed hashes and versions) for the complete
version.

---

## 1. Deliverables

| File | Description | SHA-256 |
|---|---|---|
| `hybrid_top100.csv` | 46 profiles × 100, delivered ranking | `a636217ad842a0634d6d1c2809c1b7286a86beb79e2886046b44f598bf0523c3` |
| `hybrid_bpr_delivery.pkl` | trained delivery-model checkpoint | `7c12445aa7e1477d79bf9eb4c8c1d0633bd92d3caf5baeb41779bedcf347747e` |
| `hybrid.py` | model implementation | `1b42de3bd144199172b085dc720eb008e3d06893a1234e20f8e240eee181ff30` |
| `export_hybrid_top100.py` | export script | `55f3e7d56add9d4d5d96e801f74d55700500e98b30175c3db91ef005458ace95` |

> Note: this project does not use git version control, so the SHA-256 of the
> files above serves as the equivalent of a code commit/SHA. The SHA-256 of
> `hybrid_top100.csv` was verified locally (see Section 6, self-checks). The
> source-file hashes below are a snapshot of the code state at export time; if
> the code is later re-formatted, recompute them (behaviour is unchanged as long
> as the `hybrid_top100.csv` hash still matches).

## 2. Model

- Type: hybrid factorization machine, a PyTorch reimplementation of a
  LightFM-style model (not the LightFM library itself; differences documented in
  the report's Method section: exact WARP rank, uniform violator sampling,
  SparseAdam).
- Delivery model: `hybrid_bpr` (user tower disabled, identity-only user
  embedding).
- The ranking uses **no** taste / genre / user_group / test-period data
  (consistent with the handoff constraints).

Hyperparameters (matching `hybrid_params.json`):

```
dim=64  loss=bpr  epochs=15  batch_size=4096  lr=0.02  n_neg=30
n_candidates=8192  margin=1.0  use_confidence=True  positive_label_only=True
sparse=True  amp=True
feature_kwargs = {'min_df': {'default': 20, 'developer': 3, 'publisher': 3},
                  'identity_weight': 1.0}
optimizer = SparseAdam(user) + Adam(item)
n_users=1,838,974  n_items=50,872  n_item_features=53,217
final_train_loss ≈ 0.0098
```

## 3. Randomness

- Random seed: **9727** (set for both `torch.manual_seed` and `np.random.seed`).

## 4. Data & Split

- Data version: task-A frozen output at `DataEngineering/output/`, frozen
  2026-07-24 (interactions / items / users / item_popularity.parquet).
- Split cutoff (timestamp): **1641340800** (2022-01-05), train_ratio = 0.8.
- Training rows: **17,838,174** (timestamp ≤ cutoff).
- Seen exclusion: each profile's full training-period interactions (from the
  handoff `profile_seen_items.csv`).
- Candidate set: 20,435 appids. SHA-256 (appids newline-joined, with trailing
  newline) = `01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed`
  ✓ verified.

## 5. Environment

- Device: NVIDIA GeForce RTX 4070 SUPER (12 GB), CUDA 12.4.
- OS / environment: Windows, Anaconda, conda env `pf2`.
- Key dependency versions:
  - torch: **2.6.0+cu124**
  - numpy: **1.26.4**
  - pandas: **2.3.3**
  - pyarrow: **25.0.0**

## 6. Run Command & Log

```
conda activate pf2
cd C:\Users\yueye\Desktop\COMP9727\Proj\PlayerFinder\models
python export_hybrid_top100.py > export_log.txt 2>&1
```

- Log: `export_log.txt`
- Self-checks (in-script asserts, all passed): 4600 rows; 46 profiles × 100;
  ranks 1–100 contiguous and unique; 100 unique candidate appids per profile; no
  seen leakage; scores finite and in the model's native BPR scale (range approx.
  [1.98, 20.33], not normalized).
- Training took ≈ 12 minutes (15 epochs, full data); scoring < 10 seconds.

## 7. Reproduction Steps (for a third party)

In the integrated repository, run from the repository root. Task-A parquet
files belong in `data/`, B's evaluator is in `eval/`, and the export handoff is
resolved from `study-data/staging/profile-policy-v2/a-v1.0-release/cd-handoff/`.

1. Train `hybrid_bpr` using the data version and cutoff in Section 4 (or load
   `hybrid_bpr_delivery.pkl` directly via `HybridRecommender.load(path)`).
2. Using the candidate set and seen table from Section 4, call
   `model.score(uid, candidates)` for each of the 46 requested model_user_ids,
   exclude seen items, and take the top 100.
3. Verify against the SHA-256 of `hybrid_top100.csv`.
