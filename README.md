# PlayFinder 游戏推荐系统

PlayFinder 是一个游戏发现与推荐项目，包含推荐模型的离线实验、网页演示，以及统一的推荐排序和评测流程。

## 前端演示

在浏览器中打开 `PLAYFINDER-fixture.html`，即可选择偏好、浏览游戏、按价格和平台筛选，并提供反馈。演示使用**虚构游戏和模拟排序**，不会实时运行训练好的推荐模型，也不是正式用户研究时使用的排序结果。前端及研究问卷保留英文。

使用 Node.js 重新生成演示：

```bash
node build/build-fixture-demo.mjs
```

## 推荐与评测

- 热度和随机基线：`eval/baselines.py`。
- 物品协同过滤、隐式 ALS、BPR：`models/c-cf-mf/models/`。
- 混合分解模型和冷启动实验：`models/d-hybrid/models/`。
- 统一排序指标和评测：`eval/metrics.py`、`eval/evaluate.py`。
- 过滤与多样化：`serving/index.mjs`、`build/study-core.mjs`。
- 数据处理与探索：`data/pipeline/`。

## 离线实验结果

下表来自已保存的五模型对比，评测范围为已见用户（`seen_users_only`）、整体分组（`overall`）、K=10，共 5,119 名用户。这些结果来自已有离线实验，并非演示页面的实时计算结果。

| 模型 | NDCG@10 | Recall@10 | 物品目录覆盖率 |
| --- | ---: | ---: | ---: |
| Popularity | 0.017678 | 0.026179 | 0.000413 |
| ItemCF | 0.038518 | 0.053138 | 0.069095 |
| ALS | 0.034983 | 0.051038 | 0.006841 |
| BPR | 0.023148 | 0.032966 | 0.161720 |
| Hybrid | 0.028842 | 0.041397 | 0.112557 |

对比条件和各模型权衡见 `eval/results/five-model-comparison.csv` 与 `eval/docs/final-model-decision.md`。结论仅适用于该评测设置，不能说明某个模型在所有场景中都最好。

## 环境与限制

演示只需要现代浏览器。使用 Node.js 运行 JavaScript 检查：

```bash
node --test tests/*.test.mjs
```

Python 依赖见 `requirements.txt`。本仓库不包含原始数据集、处理后的 Parquet 文件、模型权重、正式排序数据和参与者级研究记录，因此无法仅凭仓库完整重训或复现正式评测。数据来源与目录要求见 `data/README.md`。部分历史脚本依赖未包含的输入文件；独立体验请使用模拟演示。
