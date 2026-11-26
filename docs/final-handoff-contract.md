# Final model handoff

Place the final eight files in `study-data/incoming/final/`. Do not modify frontend or serving code when replacing fixtures.

- Member A owns the canonical catalogue, Steam `item_id` semantics, item metadata, and the source data snapshot.
- Member B owns the common candidate-set policy and hash, temporal split, per-user Popularity Top-100, and unified evaluation policy.
- Member E converts the confirmed A/B sources into `catalogue.json`, `candidate_items.csv`, `study_profiles.csv`, `profile_seen_items.csv`, `popularity_top100.csv`, and `manifest.json`.
- Member C exports `bpr_top100.csv` for exactly the `profile_id ↔ model_user_id` rows requested by E.
- Member D exports `hybrid_top100.csv` for exactly those same rows.

C and D must use B's shared candidate set, split, and training-period seen exclusion unchanged. They must not select replacement users or remap E's profile signatures.

Before handoff, run:

```sh
node build/validate-study-data.mjs --input study-data/incoming/final --mode formal
```

Formal mode requires all eight files. If any are absent, it reports file presence only and explicitly lists later sections as not executed; that result is not evidence that the remaining rules passed.

For a provisional staging directory that already has the five base/Popularity files, run the read-only partial scope instead:

```sh
node build/validate-study-data.mjs --input study-data/staging/real-base --mode partial --reports study-data/staging/real-base/partial-validation
```

Partial mode checks the available catalogue, candidate, profiles, coverage, seen items, and Popularity. It never sets `formal_ready=true` and does not waive the formal eight-file contract.

After validation passes, build transactionally:

```sh
node build/build-study.mjs --input study-data/incoming/final --mode formal
```

The second command validates, generates an embedded payload, builds to a temporary path, performs standalone sanity checks, benchmarks serving, and only then replaces both generated `PLAYFINDER.html` files. A failed validation or sanity check leaves the existing standalone files unchanged.

Errors include missing/schema-invalid files, non-formal manifests, checksum/provenance mismatch, invalid/duplicate profiles or users, incomplete approved supported-domain coverage, an invalid disabled-third mapping, cohort mismatch, missing/incomplete Top-100s, invalid ranks/scores/appids, unknown or non-candidate recommendations, seen leakage, missing title/price on an actually recommended item, mock/fallback code in a formal build, or a payload that was not embedded.

The frozen common platform policy treats missing platform metadata and fewer-than-six post-filter results as warnings. Missing compatibility is never guessed, and a strict filter may return an honest short list.

Catalogue- and candidate-level missing title, price, or platform counts are data-quality warnings. The same missing field on an item actually used by Popularity, BPR, or Hybrid is a formal error and identifies its condition, profile, and item. Finite-budget availability below six is also a warning because a strict budget may legitimately narrow the pool. All other contract failures are errors.
