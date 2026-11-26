# PlayFinder — Game Recommendation System

PlayFinder is a game discovery and recommendation project that combines offline recommender experiments, a browser-based interface, and a shared ranking and evaluation pipeline.

## Demo

Open `PLAYFINDER-fixture.html` in a browser. It lets you select preferences, explore game cards, filter by price and platform, and provide feedback. The demo uses a **fictional catalogue and synthetic rankings**; it does not run the trained recommendation models or display the formal study rankings.

To rebuild the demo with Node.js:

```bash
node build/build-fixture-demo.mjs
```

## Recommendation and evaluation

- Popularity and Random baselines: `eval/baselines.py`.
- Item-based collaborative filtering, implicit ALS, and BPR: `models/c-cf-mf/models/`.
- Hybrid factorization model and cold-start experiments: `models/d-hybrid/models/`.
- Shared ranking metrics and evaluation: `eval/metrics.py` and `eval/evaluate.py`.
- Filtering and diversification: `serving/index.mjs` and `build/study-core.mjs`.
- Data processing and exploration: `data/pipeline/`.

## Selected offline results

The saved five-model comparison uses the `seen_users_only` scenario, overall scope, K=10, and 5,119 users. These are existing experimental results, not measurements from the fixture demo.

| Model | NDCG@10 | Recall@10 | Catalogue coverage |
| --- | ---: | ---: | ---: |
| Popularity | 0.017678 | 0.026179 | 0.000413 |
| ItemCF | 0.038518 | 0.053138 | 0.069095 |
| ALS | 0.034983 | 0.051038 | 0.006841 |
| BPR | 0.023148 | 0.032966 | 0.161720 |
| Hybrid | 0.028842 | 0.041397 | 0.112557 |

See `eval/results/five-model-comparison.csv` and `eval/docs/final-model-decision.md` for the comparison context and trade-offs. The results are specific to this evaluation protocol; they do not establish that one model is best for every scenario.

## Setup and limitations

The demo requires only a modern browser. The JavaScript checks use Node.js:

```bash
node --test tests/*.test.mjs
```

Python dependencies are listed in `requirements.txt`. The raw datasets, processed Parquet files, model checkpoints, formal ranking payload, and participant-level study records are not included. Consequently, training and full formal evaluation cannot be reproduced from this repository alone. `data/README.md` documents the expected data sources and layout. Some historical scripts and documentation refer to removed handoff files; use the fixture demo for a self-contained walkthrough.
