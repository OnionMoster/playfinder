# 混合模型导出复现记录

本记录描述 `hybrid_top100.csv` 的生成，不改变既有排序。排序、训练权重和部分正式输入未包含在本作品集中。

## 交付物与哈希

| 文件 | 说明 | SHA-256 |
| --- | --- | --- |
| `hybrid_top100.csv` | 46 个画像各 100 条 | `a636217ad842a0634d6d1c2809c1b7286a86beb79e2886046b44f598bf0523c3` |
| `hybrid_bpr_delivery.pkl` | 训练后的交付模型权重 | `7c12445aa7e1477d79bf9eb4c8c1d0633bd92d3caf5baeb41779bedcf347747e` |
| `hybrid.py` | 导出时的模型代码快照 | `1b42de3bd144199172b085dc720eb008e3d06893a1234e20f8e240eee181ff30` |
| `export_hybrid_top100.py` | 导出时的脚本快照 | `55f3e7d56add9d4d5d96e801f74d55700500e98b30175c3db91ef005458ace95` |

源代码格式变化后哈希会变化；以上值用于识别导出时的文件快照。

## 模型与参数

模型为 PyTorch 重实现的 LightFM 风格混合分解模型，而非 LightFM 库本身；其 WARP 排名、采样和 SparseAdam 等细节有差异。交付模型 `hybrid_bpr` 关闭用户特征塔，用户侧仅使用身份嵌入。排序不使用口味、类型、用户组或测试期数据。

```text
dim=64  loss=bpr  epochs=15  batch_size=4096  lr=0.02  n_neg=30
n_candidates=8192  margin=1.0  use_confidence=True  positive_label_only=True
sparse=True  amp=True
feature_kwargs = {'min_df': {'default': 20, 'developer': 3, 'publisher': 3},
                  'identity_weight': 1.0}
optimizer = SparseAdam(user) + Adam(item)
n_users=1,838,974  n_items=50,872  n_item_features=53,217
final_train_loss ≈ 0.0098
```

PyTorch 和 NumPy 随机种子均为 9727。

## 数据与环境

使用 2026-07-24 冻结的 interactions、items、users 和 item_popularity Parquet。切分截止时间戳为 `1641340800`（2022-01-05），训练比例 0.8，训练期有 17,838,174 行。排除每个画像的全部训练期交互。候选集为 20,435 个 appid，按换行连接并带末尾换行的 SHA-256 为 `01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed`。

记录环境：Windows、Anaconda、NVIDIA GeForce RTX 4070 SUPER 12GB、CUDA 12.4；torch 2.6.0+cu124、NumPy 1.26.4、pandas 2.3.3、PyArrow 25.0.0。

## 校验和复现条件

导出自检通过：4,600 行，46 个画像各 100 行，每个画像排名连续且物品唯一，无训练期已见物品泄漏，分数有限且保持模型原始 BPR 尺度，约为 [1.98, 20.33]。记录的 15 轮训练约 12 分钟，评分少于 10 秒。

复现需要恢复处理后的 Parquet、冻结模型权重、候选集和画像已见记录；使用 `model.score(uid, candidates)` 对各画像评分并排除已见物品，取前 100 条，然后核对文件哈希。这些完整输入未包含在本仓库中。
