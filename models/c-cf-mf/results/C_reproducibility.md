# 协同过滤模型导出复现记录

本文记录 ItemCF、ALS、BPR 的参数、环境及正式研究使用的冻结 BPR 排序。大型权重文件不在本仓库中；研究后更新的模型不能用于覆盖参与者实际看到的冻结排序。

## 交付物

| 文件 | 说明 | SHA-256 |
| --- | --- | --- |
| `export/bpr_top100.csv` | 46 个画像各 100 条的 BPR 排序，本仓库不包含该用户级文件 | `b18a0ee6672d08921d0ba44a6c84034a23f74dac4bcd3c68d94f3030fde0ded0` |
| `results/final_results.csv` | ItemCF、ALS、BPR 离线汇总指标 | 仓库内记录 |
| `export/export_bpr_top100.py` | BPR Top-100 导出脚本 | 仓库内记录 |

排序原有字段 `profile_id,model_user_id,item_id,rank,score`，共 4,600 行；每个画像的排名为 1–100，候选物品互不重复。

## 冻结参数

| 模型 | 参数 |
| --- | --- |
| ItemCF | 邻居数 600；余弦相似度；单线程 |
| ALS | 因子 32；正则化 0.05；alpha 1.0；迭代 30；随机种子 42；单线程；implicit 0.7.3 |
| 正式研究 BPR | 因子 96；学习率 0.02；正则化 0.005；迭代 75；未观测物品均匀负采样；验证负样本；随机种子 42；单线程；implicit 0.7.3 |

## 训练与数据

训练记录：2026-07-26 15:26:03.715350 至 15:46:08.241813 UTC；训练比例 0.8；截止时间戳 `1641340800`（2022-01-05）；训练未使用测试数据，仅使用正交互。训练用户 1,838,974，候选物品 20,435，正训练交互 15,148,098。矩阵加载／构建 4.132 秒，ItemCF 训练 8.586 秒，ALS 250.773 秒，BPR 562.051 秒，记录总计 825.542 秒。

训练行 `timestamp <= 1641340800`，测试行 `timestamp > 1641340800`。物品 ID 为 Steam appid；排除用户训练期所有交互。交互表示评价或已见行为，不等于拥有；缺失类型不作虚构。

| 数据文件 | SHA-256 |
| --- | --- |
| `items.parquet` | `7880f48c0255cd887af3356344992f75f0cb5517984c694ce054a76eb3474ba2` |
| `interactions.parquet` | `7b0b5a2d4b0320c1f932bde8d66a3bd70ce709e1696a7ccabc329d56e85fe22f` |
| `users.parquet` | `8ac5e766d07a7c8f285e2bb046deb3595d1a13f57e61b71b9cbd09bbfbe33cc8` |
| `item_popularity.parquet` | `e2ae7b87d9719c28caa4fd3b0c0eabb98797cd51f725c61eb8e88c1b91aa7f18` |

## 权重身份

冻结权重原保存在 `C_result/results_1/final_training/run_001`。完整模型包含用户物品矩阵、ID 数组、ItemCF 相似度矩阵和 ALS／BPR 因子。

| 文件 | 字节数 | SHA-256 | 直接用于 Top-100 |
| --- | ---: | --- | --- |
| `best_parameters.json` | 1,401 | `8e463f72f08b5785910c8e6d4c610e36fd34f00ff5ab391f988287b6c43d7ba1` | 用于校验参数 |
| `final_training_summary.json` | 2,063 | `c80250c4ac9e94fdbb8f880c8f00a0ac9b6bc399adc21cd84055e2a0a6ea025b` | 用于校验训练 |
| `user_ids.npy` | 7,356,024 | `daea740e6ecb25e007fd7492f953c5d5be529644f13d4220b25af0c931e11554` | 是 |
| `item_ids.npy` | 81,868 | `d3ac47956c4309a12222bbcc18a06f6104043ec22bbe3a58bb9a19cf064a559e` | 是 |
| `user_item_matrix.npz` | 65,145,020 | `a06bb85177799ae7a74a7476a730124e0beffff17c3c31124a4a5153d6901698` | 否 |
| `bpr_user_factors.npy` | 713,522,040 | `b9d135e347135cdc16def6758ec44ce62dadd5ea20e636416e76137aaad6dbfe` | 是 |
| `bpr_item_factors.npy` | 7,928,908 | `c68fd6270cb1a86c39a967dd6309bd31737f45c967aa2d4f218c4f73fcd4473a` | 是 |

## 环境与复现条件

记录环境为 NumPy 2.5.1、SciPy 1.18.0、implicit 0.7.3、PyArrow 25.0.0、scikit-learn 1.9.0、threadpoolctl 3.6.0。完整复现需要恢复冻结 Parquet、权重和用户画像相关输入并校验哈希，再运行评测及导出脚本，检查 46×100 行、排名连续、物品唯一、分数有限和训练期已见物品未泄漏。本仓库不包含这些完整输入；实际评测脚本位置为 `models/c-cf-mf/models/evaluate_final_models.py`。
