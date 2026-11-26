# Collaborative Filtering Models

`models/cf.py` implements item-based collaborative filtering. `models/mf.py` contains implicit ALS and BPR implementations. `models/train_final_models.py` and `models/evaluate_final_models.py` contain the training and evaluation entry points.

The scripts require processed Parquet inputs and model artifacts which are not included in this portfolio snapshot. Existing aggregate results and parameter records are in `results/`; they should not be treated as freshly reproduced results.
