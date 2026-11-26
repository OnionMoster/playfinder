# 用户研究分析

## 离线指标

`extract_offline_ndcg.py` 从用户级离线指标中提取 46 个画像、三种条件共 138 条 NDCG@10 记录，使用 `seen_users_only`、`overall` 范围。Popularity、BPR、Hybrid 分别只有 3/46、2/46、4/46 个画像的 NDCG@10 大于零，因此小样本用户级相关性易受大量零值和并列影响。

用户级输入及 `offline-ndcg-selected.csv` 未包含在本仓库中。

## 在线分析

最终分析包含 20 名完整参与者和 60 轮参与者—条件记录。原始去标识记录不包含在本仓库中。具备这些输入时，可运行：

```bash
python3 study/analysis/analyze_study.py
python3 study/analysis/run_within_subject_tests.py
python3 study/analysis/plot_study_results.py
```

汇总输出位于 `study/results/`。主要结果是 Q10 总体满意度：采用 Friedman 检验比较三种条件，配对 Wilcoxon 检验使用 Holm 校正；二元指标使用 Cochran's Q 和精确 McNemar 检验。在线与离线相关性使用 Spearman、Pearson 和以参与者为单位的 bootstrap 区间；相关性仅作描述，不表示因果关系。

## 结果与限制

- 主要满意度差异不显著：Friedman χ²(2)=0.098，p=.952；Holm 校正后两两比较均不显著。
- 满意度与 NDCG 的汇总 Spearman 系数为 −0.082，参与者聚类 bootstrap 95% 区间为 [−0.194, 0.011]。
- 60 条匹配记录中 58 条离线 NDCG 为零（96.7%），因此无法据此可靠判断在线与离线指标之间的关系。
