# Data Pipeline (Member A)

Source code that produces every Module-A artifact: the cleaned Parquet tables,
`data_summary.json`, and the EDA figures used in the report.

Raw datasets and Parquet outputs are **not** committed (course rule: do not
submit dataset(s)). This directory holds the code, the figures, and the summary
statistics needed to reproduce and cite the numbers.

---

## 1. Inputs

Two public datasets, joined on the Steam `appid`. Download them separately.

| Source | Files | Used for |
|---|---|---|
| Kaggle — *Game Recommendations on Steam* | `games.csv`, `games_metadata.json`, `recommendations.csv`, `users.csv` | Catalogue, descriptions/tags, 41M interactions |
| UCSD — *Steam* (McAuley et al.) | `steam_games.json`, `australian_users_items.json`, `australian_user_reviews.json`, `bundle_data.json` | Genres/specs/developer, playtime, bundles |

Expected layout (default `<repo>/raw/`, or point `PLAYFINDER_RAW_DIR` anywhere):

```text
raw/
├── archive/                       # Kaggle
│   ├── games.csv
│   ├── games_metadata.json
│   ├── recommendations.csv
│   └── users.csv
└── UCSD/
    ├── steam_games.json
    ├── australian_users_items.json
    ├── australian_user_reviews.json
    └── bundle_data.json
```

> The UCSD `.json` files are Python dict reprs (single quotes, `u'...'`,
> `True/False`), not valid JSON, so they are parsed with `ast.literal_eval`.

---

## 2. How to run

From the **repository root**:

```bash
pip install -r data/pipeline/requirements.txt

# if raw data is not in <repo>/raw
export PLAYFINDER_RAW_DIR=/path/to/raw          # Windows: set PLAYFINDER_RAW_DIR=...

python -m data.pipeline.run_all                 # build everything (resumable)
python -m data.pipeline.verify                  # QA the outputs
```

Useful flags:

```bash
python -m data.pipeline.run_all --force                       # rebuild all
python -m data.pipeline.run_all --confidence-alpha 40         # override alpha
python -m data.pipeline.run_all --only step1_items step4_eda  # run some steps
```

Every step skips itself if its output already exists, so an interrupted run
resumes. Runtime is roughly 3–5 minutes end to end; the one-off CSV→Parquet
conversion dominates.

### Configuration

All parameters live in `data/pipeline/config.py` and can be overridden without
editing the file:

| Parameter | Default | Override |
|---|---|---|
| `confidence_alpha` | 1.0 | `--confidence-alpha` or `PLAYFINDER_CONFIDENCE_ALPHA` |
| `min_user_interactions` | 5 | `PLAYFINDER_MIN_USER` |
| `min_item_interactions` | 20 | `PLAYFINDER_MIN_ITEM` |
| raw / output location | `<repo>/raw`, `<repo>/data` | `PLAYFINDER_RAW_DIR`, `PLAYFINDER_OUTPUT_DIR` |
| DuckDB memory / threads | 3GB / 4 | `PLAYFINDER_DUCKDB_MEMORY`, `PLAYFINDER_DUCKDB_THREADS` |

The effective values are written into `data_summary.json` under `parameters`,
so any result can be traced back to the configuration that produced it.

---

## 3. Outputs

Written to `data/` (Parquet gitignored; figures and summary committed).

| File | Rows | Committed | Purpose |
|---|---|---|---|
| `interactions.parquet` | 22,286,960 | no | Main modelling table (k-core) |
| `items.parquet` | 50,872 | no | Item catalogue (Kaggle × UCSD) |
| `users.parquet` | 1,905,447 | no | `user_id → n_interactions, user_group` |
| `item_popularity.parquet` | 37,610 | no | Full-data popularity (baseline + long tail) |
| `interactions_ucsd_playtime.parquet` | 5,153,209 | no | UCSD ownership + playtime (separate id space) |
| `ucsd_reviews.parquet` | 59,305 | no | UCSD recommend labels |
| `bundles.parquet` | 615 | no | Bundle → item list |
| `data_summary.json` | — | **yes** | All statistics quoted in the report |
| `figures/*.png` | 7 files | **yes** | EDA figures |
| `rec_compact.parquet` | — | no | Intermediate cache, safe to delete |

### `interactions.parquet` schema (the contract B/C/D code against)

| Column | Type | Meaning |
|---|---|---|
| `user_id` | int32 | Kaggle user id |
| `item_id` | int32 | Steam appid (no mapping table needed) |
| `label` | int8 | `is_recommended`: 1 = recommended, 0 = not |
| `hours` | float32 | Playtime at review (source caps at 1000) |
| `confidence` | float32 | `1 + alpha * ln(1 + hours)` |
| `timestamp` | int64 | Review date, Unix seconds (temporal split) |
| `user_group` | string | `cold` / `normal` / `heavy` |

Guarantees enforced by `verify.py`: every user has ≥5 and every item ≥20
interactions; `(user_id, item_id)` is unique; every `item_id` resolves in
`items.parquet`.

### `items.parquet`

`item_id`, `title`, `description`, `tags`, `genres`, `specs`, `developer`,
`publisher`, `price`, `price_original`, `discount`, `win`, `mac`, `linux`,
`steam_deck`, `early_access`, `rating`, `positive_ratio`, `user_reviews`,
`release_date`, `release_year`.

List columns are never null (missing → `[]`). `genres`/`specs`/`developer`/
`publisher` come from UCSD and are present for only ~29% of games — use `tags`
(97.6% coverage) as the fallback.

---

## 4. What the pipeline does

| Step | Module | Work |
|---|---|---|
| 1 | `step1_items` | Load Kaggle games + metadata, left-join UCSD knowledge fields on appid, normalise types → `items.parquet` |
| 2 | `step2_interactions` | Compact the 41M-row CSV (+ de-duplicate), compute full-data popularity, iterative k-core filter, tertile user grouping, confidence weight → `interactions.parquet`, `users.parquet`, `item_popularity.parquet` |
| 3 | `step3_ucsd_extras` | Parse UCSD playtime (parallel), reviews and bundles → three Parquet tables |
| 4 | `step4_eda` | Seven EDA figures + long-tail statistics |

Ordering is dictated by dependencies: `items` defines the legal item universe
and is used by step 2's integrity check; the UCSD extras block nobody, so they
come later; EDA is last because it visualises the finished artifacts.

Two ordering decisions inside step 2 matter:

- **Popularity is computed before filtering** — the baseline and the long-tail
  figure need the true global distribution, which k-core would distort.
- **Grouping happens after filtering** — `user_group` must describe the history
  the model actually sees, not interactions that were filtered away.

---

## 5. Key numbers (from `data_summary.json`)

- Raw: 41,154,773 interactions · 13.78M users · 37,610 items
- Core after k-core (≥5 user / ≥20 item, converges in 6 iterations):
  **22,286,960 interactions · 1,905,447 users · 22,676 items** (54.1% retained)
- Density: 7.9e-05 → 5.2e-04 (~6.5× denser)
- Positive rate: 84.8%
- Groups (tertiles, cutoffs q33=6, q67=10): cold 733,194 · normal 589,754 · heavy 582,499
- Long tail: top 1% of games = 56% of interactions; top 10% = 92%
- Cross-dataset match: only 14,931/50,872 (29.4%) Kaggle games exist in UCSD

### Documented limitations

1. **UCSD covers only 29.4% of the catalogue** — it is a 2019 snapshot against
   Kaggle's 2024 data, so ~70% of games have no `genres`/`developer`. Use `tags`.
2. **User id spaces are disjoint** — Kaggle uses small integers, UCSD uses Steam
   ids. Items join; users cannot. UCSD is therefore a separate comparison set.
3. **Interactions mean *reviewed*, not *owned*** — users average 258.8 owned
   games but only 11.7 reviews, so `exclude_seen` filtering is sound but
   necessarily incomplete (~10% of ownership is observable).
4. **`hours` is capped at 1000** in the source data.
5. **Grouping uses interaction tertiles**, not the `products`/`reviews` columns,
   because it reflects the history length visible to the model.

---

## 6. Notes

- No machine-specific absolute paths: everything resolves relative to the repo,
  and scratch space uses the OS temp directory (`tempfile.gettempdir()`).
- Reruns are deterministic — `popularity_rank` breaks ties on `item_id`, so
  repeated runs produce byte-identical files.
- `data_summary.json` is the single source of truth for report numbers; do not
  re-count by hand.

Notebook walkthrough: `notebooks/01_data_preparation_and_eda.ipynb`.
