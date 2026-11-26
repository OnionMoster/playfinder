# Section 4.2 — System-level metrics

## Serving definition

For every condition, a request selects the assigned profile's Top-100, removes
training-period reviewed items and current-session Not Interested items,
applies budget/platform/explicit metadata filters, and then performs
deterministic MMR reranking. Model training and one-time data loading are
outside the measured serving request.

## Formal real-data benchmark

The benchmark used the formally validated package, all 46 profiles, all three
real ranking files, five filter passes, and 690 warm in-memory requests.

| Metric | Overall | Popularity | BPR | Hybrid |
|---|---:|---:|---:|---:|
| Runs | 690 | 230 | 230 | 230 |
| Mean latency | 81.45 ms | 31.02 ms | 106.85 ms | 106.48 ms |
| p50 latency | 18.88 ms | 12.21 ms | 27.12 ms | 30.28 ms |
| p95 latency | 273.04 ms | 69.97 ms | 288.11 ms | 278.30 ms |
| p99 latency | 300.68 ms | 75.04 ms | 304.65 ms | 297.53 ms |
| Maximum | 317.80 ms | 82.09 ms | 317.80 ms | 306.31 ms |

These values support a limited “near real-time serving” statement for local
in-memory post-processing: 95% of measured requests completed within 274 ms.
They do not measure browser rendering, network transfer, cold process startup,
or model training.

The post-filter list size ranged from 0 to 100 games. That range is not a
latency problem. Under the approved common policy, strict participant
constraints may produce an honest short list without fallback or filter
relaxation.

Source: `serving/results/benchmark-real-formal.json`, measured 2026-07-29 with
Node.js v24.10.0 on macOS 26.5.2 arm64.

## Final-report interpretation

The benchmark is a service-layer microbenchmark, not a complete page-load or
network measurement. The candidate identity is pinned by SHA-256
`01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed`.
If the final submitted source changes, rerun the benchmark and record the new
source commit or archive hash.
