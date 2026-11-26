# 最终模型选择说明

## 1. 适用范围

这份说明用于最终 notebook、team presentation 和结果说明文件。

当前结论只针对 **主实验**，默认比较设置为：

- `scenario = seen_users_only`
- `scope = overall`
- `k = 10`

冷启动结果单独讨论，不和主实验混写成一个总结论。

---

## 2. 使用的统一结果

主实验比较使用以下统一结果来源：

- `eval/final_eval/main_results.csv`
- `eval/final_eval/main_significance_tests.csv`
- `eval/final_eval/version_info.json`
- `eval/results/five-model-comparison.csv`

五模型统一表包含：

- Popularity
- ItemCF
- ALS
- BPR
- Hybrid

Random 只保留为 sanity-check baseline，不进入主结果表。

---

## 3. 原 best-model 规则为什么不能继续用

原规则要求：

1. `coverage >= ItemCF`
2. `intra-list diversity >= Popularity`
3. 在满足以上条件后最大化 `NDCG@10`

这个规则当前不再适用，原因很直接：

- Popularity 的 `ILD` 最高；
- 当前没有个性化模型同时达到 Popularity 的 `ILD`；
- 因此没有模型满足全部硬约束；
- 如果继续沿用旧规则，最终会得到“没有可选模型”的结论，这对提交物没有帮助。

所以最终选择规则改为 **多指标权衡**，而不是单一硬门槛筛选。

---

## 4. 当前离线结果的直接结论

以 `seen_users_only / overall / k=10` 为主：

### 4.1 离线准确率最佳

`ItemCF` 是当前离线准确率最好的模型。

理由：

- 五模型里 `NDCG@10` 最高；
- `Recall@10` 最高；
- `Precision@10` 最高；
- `MAP@10` 和 `MRR@10` 也领先。

因此，如果只看主实验中的已见用户排名准确率，`ItemCF` 是当前最强单模型。

### 4.2 覆盖率与新颖性最强

`BPR` 在 coverage 和 novelty 上最强。

理由：

- `catalogue_coverage` 最高；
- `novelty` 最高；
- 说明它更愿意把结果分散到更多物品上，而不是集中在少数热门物品上。

代价：

- 准确率明显低于 `ItemCF`；
- 因此它不适合作为“单一默认主模型”直接替代 `ItemCF`。

### 4.3 综合表现最均衡的个性化模型

`Hybrid` 是当前最均衡的个性化模型。

理由：

- 准确率明显优于 Popularity 和 BPR；
- coverage 和 novelty 明显优于 Popularity；
- `AUC` 和 `RMSE` 在五模型里也处于较强位置。

限制：

- 它的 `NDCG@10` 仍低于 `ItemCF`；
- 因此不能把它写成“离线最优模型”。

### 4.4 Popularity 的角色

`Popularity` 继续作为非个性化基线保留。

它的价值主要在于：

- 提供最简单稳定的参考下界；
- 提供较高的 list diversity；
- 作为 Condition A 和系统解释中的非个性化条件。

但它不是最终个性化系统的默认主排序器。

---

## 5. 最终系统的建议写法

最终提交物里，不建议写成“全项目只有一个绝对最佳模型”。

建议写成三层结论：

1. **离线准确率最佳模型：** `ItemCF`
2. **覆盖率 / 新颖性优势模型：** `BPR`
3. **最终部署策略：** 根据用户场景选择排序器，并统一经过服务层的硬过滤和 MMR 重排

这样写的理由：

- 能真实反映五模型的 trade-off；
- 不会把单一指标的局部优势误写成全局最优；
- 和系统部署逻辑一致，因为最终展示的结果本来就要经过过滤和重排。

---

## 6. 对 notebook 和 presentation 的落地建议

主结果页建议直接使用 `results/five-model-comparison.csv`。

文字解释建议按下面顺序写：

1. 先说明公平比较设置：
   - same split
   - same users
   - same exclusion policy
   - same main candidate policy
2. 再给五模型统一表
3. 再说明：
   - `ItemCF` 准确率最好
   - `BPR` 覆盖率和新颖性最好
   - `Hybrid` 是最均衡的个性化模型
4. 最后补一句：
   - 冷启动实验单独讨论
   - 最终部署经过服务层过滤和 MMR

---

## 7. 当前不应写出的结论

以下说法不建议出现在最终提交物里：

- “Hybrid 是所有场景下最好的模型”
- “BPR 是最终默认模型”
- “Popularity 可以代表最终系统质量”
- “冷启动结果与主实验结果一致”
- “旧版 50,872 catalogue 的 Hybrid 结果可以直接当作主实验结果”

这些结论都缺少当前统一结果的支持。

---

## 8. 当前版本状态

这份说明基于当前已经冻结的离线结果。

如果正式用户研究结果进入最终 notebook 和 presentation，需要由 E 在系统层结论部分再补一句：

- 离线最优模型未必等于最终用户体验最优模型；
- 最终系统选择仍需结合用户研究与服务层约束一起解释。
