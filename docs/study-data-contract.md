# PlayFinder study-data contract

The serving pipeline accepts one directory containing exactly the eight named inputs below. Formal data uses Steam appids serialized as positive-integer strings. The frontend never reads these files at runtime; the validated payload is embedded during the offline build.

| File | Required content |
|---|---|
| `manifest.json` | `schema_version`, `mode`, `id_namespace`, common provenance, condition mapping and SHA-256 values |
| `catalogue.json` | Array of item metadata with `item_id` plus source-backed `title`, `price`, `platforms`, `genres`, and `tags`; missing source metadata remains null/empty and is never invented |
| `candidate_items.csv` | `item_id` |
| `study_profiles.csv` | `profile_id,model_user_id,taste_1,taste_2,taste_3,train_positive_count` |
| `profile_seen_items.csv` | `profile_id,model_user_id,item_id` |
| `popularity_top100.csv` | `profile_id,model_user_id,item_id,rank,score` |
| `bpr_top100.csv` | Same ranking schema |
| `hybrid_top100.csv` | Same ranking schema |

Condition mapping is fixed: A = popularity, B = BPR, C = hybrid. Each condition must declare the same `data_snapshot`, `split_id`, and `candidate_hash`. `candidate_hash` is SHA-256 over numerically sorted, normalized candidate appids, one per line with a final newline. `manifest.files` contains SHA-256 for every file except the manifest itself.

Every profile has exactly three distinct tastes from the 16-value UI vocabulary. Formal profile policy `top-5-enumerated-v2` uses an approved supported domain: 558 of the 560 possible three-taste selections must have a best Jaccard similarity of at least 0.5. The two unsupported triples and all six corresponding disabled-third mappings must be declared in `manifest.profile_policy`. Every two-taste prefix must retain at least one legal third-taste completion. Ties resolve to the lexicographically smallest `profile_id`.

Each profile-condition ranking has exactly 100 unique items and unique ranks 1–100. Scores must be finite but are provenance only: serving relevance is derived from rank, never compared across models.

Missing title, price, or platform metadata is counted across the full catalogue and again within the shared candidate. A recommended item with missing title or price is a formal error. A recommended item with missing platform is an auditable warning identifying `condition`, `profile_id`, and `item_id`; it is treated as having unknown compatibility and is excluded whenever a platform filter is active. Platform metadata is never invented.

Serving order is: assigned profile Top-100 only; remove that profile's seen items; remove current-condition Not Interested items; apply price, platform, genre, and tag hard filters; then deterministic MMR. Platform filtering is any-match against explicit source platforms. A finite budget rejects missing prices. If strict filters leave fewer than six games, the interface displays the honest short list; it never appends fallback items or silently relaxes a participant's filters.

`study-data/fixtures` is synthetic and must retain the exact notice `FIXTURE / NOT FOR FORMAL STUDY` in its manifest and UI.

## Ownership

- A owns catalogue metadata, canonical Steam appids, and the data snapshot.
- B owns the shared candidate set, temporal split, Popularity ranking, and unified evaluation policy.
- E owns deterministic conversion to the frontend contract, training-only profile derivation, seen-item export, and manifest assembly.
- C and D only export BPR and Hybrid Top-100 rankings for E's exact requested `model_user_id` list, using B's candidate hash, split, and seen exclusion.
