# C — Model Export Reproducibility Appendix

This document consolidates the reproducibility metadata for C's ItemCF, ALS,
and BPR models. It records the frozen BPR model and Top-100 ranking used in the
formal user study, together with the final training configuration and runtime
environment. Large checkpoint binaries remain in the team's controlled
storage and are identified below by SHA-256.

The maintained implementation is under `models/c-cf-mf/models/`, `pipeline/`,
and `export/`. The post-study model files under `results/` must not be used to
overwrite the frozen ranking delivered for the formal study.

---

## 1. Deliverables

| File | Description | SHA-256 |
|---|---|---|
| `export/bpr_top100.csv` | 46 profiles × 100 delivered BPR ranking | `b18a0ee6672d08921d0ba44a6c84034a23f74dac4bcd3c68d94f3030fde0ded0` |
| `results/final_results.csv` | ItemCF / ALS / BPR formal offline metrics | Recorded in the repository |
| `export/export_bpr_top100.py` | Validated BPR Top-100 export script | Recorded in the repository |

The Top-100 file has the columns
`profile_id,model_user_id,item_id,rank,score`, with 4,600 data rows. Each of
the 46 profiles has ranks 1–100 and 100 unique candidate items.

## 2. Frozen model configuration

### ItemCF

| Parameter | Value |
|---|---:|
| neighbours | 600 |
| similarity | cosine |
| jobs | 1 |

### ALS

| Parameter | Value |
|---|---:|
| factors | 32 |
| regularization | 0.05 |
| alpha | 1.0 |
| iterations | 30 |
| random state | 42 |
| threads | 1 |
| backend | implicit 0.7.3 |

### BPR used for the formal study

| Parameter | Value |
|---|---:|
| factors | 96 |
| learning rate | 0.02 |
| regularization | 0.005 |
| iterations | 75 |
| negative sampling | uniform unobserved |
| verify negative samples | true |
| random state | 42 |
| threads | 1 |
| backend | implicit 0.7.3 |

## 3. Training record

- Created: `2026-07-26T15:26:03.715350+00:00`.
- Completed: `2026-07-26T15:46:08.241813+00:00`.
- Training ratio: 0.8.
- Cutoff timestamp: `1641340800` (`2022-01-05`).
- Test data used during training: no.
- Positive interactions only: yes.
- Single-threaded: yes.
- Random state: 42.
- Training users: 1,838,974.
- Candidate items: 20,435.
- Positive training interactions: 15,148,098.
- Matrix loading/build time: 4.132 seconds.
- ItemCF fit time: 8.586 seconds.
- ALS fit time: 250.773 seconds.
- BPR fit time: 562.051 seconds.
- Recorded total: 825.542 seconds.

The final model package consists of the shared user–item matrix, user and item
ID arrays, ItemCF similarity matrix, and ALS/BPR user and item factor arrays.

## 4. Data and split

- Data release: task-A `v1.0 frozen`.
- Training rows use `timestamp <= 1641340800`.
- Testing rows use `timestamp > 1641340800`.
- Item IDs are Steam appids; no additional ID mapping is used.
- Seen exclusion includes every training-period interaction for the user.
- Interactions represent reviewed or seen activity, not ownership.
- Missing genres remain missing; no metadata is inferred or invented.

| Source file | SHA-256 |
|---|---|
| `items.parquet` | `7880f48c0255cd887af3356344992f75f0cb5517984c694ce054a76eb3474ba2` |
| `interactions.parquet` | `7b0b5a2d4b0320c1f932bde8d66a3bd70ce709e1696a7ccabc329d56e85fe22f` |
| `users.parquet` | `8ac5e766d07a7c8f285e2bb046deb3595d1a13f57e61b71b9cbd09bbfbe33cc8` |
| `item_popularity.parquet` | `e2ae7b87d9719c28caa4fd3b0c0eabb98797cd51f725c61eb8e88c1b91aa7f18` |

## 5. Checkpoint identity

The frozen checkpoint was originally stored at
`C_result/results_1/final_training/run_001`.

| File | Size (bytes) | SHA-256 | Used directly for Top-100 |
|---|---:|---|---|
| `best_parameters.json` | 1,401 | `8e463f72f08b5785910c8e6d4c610e36fd34f00ff5ab391f988287b6c43d7ba1` | Parameter verification |
| `final_training_summary.json` | 2,063 | `c80250c4ac9e94fdbb8f880c8f00a0ac9b6bc399adc21cd84055e2a0a6ea025b` | Training verification |
| `user_ids.npy` | 7,356,024 | `daea740e6ecb25e007fd7492f953c5d5be529644f13d4220b25af0c931e11554` | Yes |
| `item_ids.npy` | 81,868 | `d3ac47956c4309a12222bbcc18a06f6104043ec22bbe3a58bb9a19cf064a559e` | Yes |
| `user_item_matrix.npz` | 65,145,020 | `a06bb85177799ae7a74a7476a730124e0beffff17c3c31124a4a5153d6901698` | No |
| `bpr_user_factors.npy` | 713,522,040 | `b9d135e347135cdc16def6758ec44ce62dadd5ea20e636416e76137aaad6dbfe` | Yes |
| `bpr_item_factors.npy` | 7,928,908 | `c68fd6270cb1a86c39a967dd6309bd31737f45c967aa2d4f218c4f73fcd4473a` | Yes |

## 6. Environment

| Package | Version |
|---|---:|
| NumPy | 2.5.1 |
| SciPy | 1.18.0 |
| implicit | 0.7.3 |
| PyArrow | 25.0.0 |
| scikit-learn | 1.9.0 |
| threadpoolctl | 3.6.0 |

## 7. Reproduction steps

From the repository root:

1. Place the frozen task-A parquet files under `data/`.
2. Place the separately stored checkpoint arrays in `models/c-cf-mf/results/`
   and verify their hashes against Section 5.
3. Run `models/c-cf-mf/pipeline/evaluate_final_models.py` to reproduce the
   offline metrics in `results/final_results.csv`.
4. Run `models/c-cf-mf/export/export_bpr_top100.py` with the frozen BPR factors
   and handoff inputs to reproduce `export/bpr_top100.csv`.
5. Confirm 46 profiles × 100 rows, contiguous ranks, unique candidate items,
   finite scores, and no training-period seen-item leakage.
6. Verify the reproduced Top-100 file against the SHA-256 in Section 1.

