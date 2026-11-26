# PlayFinder serving layer

This directory is E's model-independent serving boundary. Model owners provide
ranked Steam appids; E applies the same deterministic post-processing to
Popularity, BPR, and Hybrid.

## Request order

1. Select the ranking for the assigned `profile_id` and active condition.
2. Remove every training-period reviewed/interacted item for that model user.
3. Remove games marked **Not Interested** during the current study.
4. Apply budget and platform as hard filters.
5. Apply genre only to explicit source genres. Tags may be filtered as tags,
   but are never converted into fabricated genres.
6. Apply deterministic MMR to improve list diversity.

The source of truth is `serving/index.mjs`, which exposes the tested
implementation in `build/study-core.mjs`.

## Important semantic limitation

A confirmed that interactions mean reviewed/seen activity, not ownership.
PlayFinder therefore cannot truthfully claim to remove every owned game.
Participant-facing and report language must say **training-period
reviewed/interacted games**.

## Latency benchmark

`serving/benchmark-real.mjs` measures a warm in-memory request from
profile/condition lookup through exclusion, filtering, and MMR. It excludes
one-time file loading and browser/network latency and reports overall plus
per-condition mean, p50, p95, p99, and maximum latency.

Run:

```sh
node serving/benchmark-real.mjs \
  --input study-data/incoming/final \
  --output serving/results/benchmark-real-formal.json
```

The formal benchmark may support the system engineering discussion when its
definition and limitations are kept alongside the result. It measures warm
local in-memory post-processing, not browser rendering, network transfer,
process startup, model training, or file loading.
