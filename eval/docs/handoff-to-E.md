# 给 E 的交接说明

这份说明只解决一件事：

> E 在整合 notebook、presentation 和最终系统说明时，B 的结果应该引用哪一版，以及哪些结果不能混用。

---

## 1. 最终引用入口

E 做最终整合时，**优先只看 `final_eval/`**。

这一版已经统一了：

- 时间切分；
- 评测用户；
- seen item 排除规则；
- 主实验候选集；
- Popularity / BPR / Hybrid 三模型的统一比较；
- 跨模型显著性检验。

E 最常用的文件只有这几个：

1. `final_eval/main_results.csv`
   - 最终主实验总表
   - 用于 notebook 正文、slides 主结果页、报告主表

2. `final_eval/main_significance_tests.csv`
   - 最终跨模型显著性检验
   - 用于“是否显著优于”这一节

3. `final_eval/version_info.json`
   - 最终 split / candidate / catalogue / condition 版本说明
   - 用于写实验设置和系统约束

4. `final_eval/popularity_top100.csv`
   - Condition A 使用的 Popularity Top-100 导出
   - 用于前端条件解释和 profile-level 检查

5. `final_eval/main_user_metric_values.csv`
   - 逐用户指标
   - 只有在要做补充分析、箱线图、用户级显著性时再用

---

## 2. 主实验现在的统一设置

最终主实验统一采用以下设置：

- 时间切分：按时间做 train/test split
- cutoff date：`2022-01-05`
- sampled users：与 B 评测框架固定的一致
- 场景：
  - `all_test_users`
  - `seen_users_only`
  - `new_users_only`
- 用户分组：
  - `overall`
  - `cold`
  - `normal`
  - `heavy`
- 主实验共同 candidate policy：
  - 共享 `20,435` 个训练期正反馈物品
- 统一 exclusion policy：
  - 同一 profile 下排除训练期已经见过的 items

E 在最终整合时，**主实验默认使用这套设置，不再另写一套口径**。

---

## 3. Condition A 的解释

Condition A **不是全局固定榜单**。

Condition A 的定义是：

- 对同一个 profile / user；
- 先排除该用户训练期已经见过的 items；
- 再按 Popularity 排序取列表。

因此：

- `profile_id = user_id`
- 不是“所有人看到同一个全局 Top-100”
- 而是“同一个 profile 下、应用 seen-item 排除后的 popularity 列表”

E 在前端或用户研究说明里，应该按这个口径写。

---

## 4. Popularity 的时序问题已经修正

旧版 Popularity 在并列时曾使用 A 的全数据 popularity rank 做 tie-break，这会引入 cutoff 之后的信息。

最终主实验里，这个问题已经修正。

现在使用的 tie-break 规则是：

1. 训练期正反馈数量降序；
2. 训练期交互数量降序；
3. `item_id` 升序。

因此最终版 Popularity **不再使用未来信息做排序**。

---

## 5. 哪些结果不要混用

E 在整合时，不要把下面几类结果直接并排写成同一主实验结论：

1. 不要把 `results/` 下旧版 baseline 和 `final_eval/` 下主实验结果混写成一张最终表。
   - `results/` 主要保留给 B 框架自检和 baseline 记录。
   - 最终报告/展示应以 `final_eval/` 为主。

2. 不要直接把 C 单独跑出的全部结果、D 单独跑出的全部结果，与主实验总表随意拼接。
   - C 和 D 自己目录里的结果可以作为方法细节、补充实验、冷启动分析使用。
   - 但最终横向主比较请以 B 整合后的 `main_results.csv` 为准。

3. 不要把 cold-start 结果和 seen-user 主实验混成一句结论。
   - 主实验与冷启动实验应分开讨论。

4. 不要把旧的 50,872 catalogue 的 hybrid 结果直接当作主实验结果。
   - 最终主实验中的 hybrid 使用的是共享 `20,435` candidate catalogue 的统一版本。

---

## 6. notebook / slides / 报告里怎么用

推荐用法：

- 主结果页：
  - 引用 `main_results.csv`
- 显著性检验页：
  - 引用 `main_significance_tests.csv`
- 实验设置页：
  - 引用 `version_info.json`
- Condition A / profile policy 说明：
  - 引用 `popularity_top100.csv` 和 `version_info.json`
- 用户级补充分析：
  - 需要时引用 `main_user_metric_values.csv`

如果只做一张最重要的总表，建议默认取：

- `scenario = seen_users_only`
- `scope = overall`
- `k = 10`

因为这是一致性最好、最适合做主结论的设置。

---

## 7. B 对最终结论的建议边界

从 B 的角度，最终可以稳定支持的说法是：

- 主实验结果以统一 split、统一 candidate、统一 exclusion policy 为准；
- 主实验中可以公平比较 `Popularity / BPR / Hybrid`；
- 冷启动实验应单独讨论；
- 最终部署结论应是“多指标权衡 + 服务层过滤/MMR”，而不是只看单个离线指标。

不建议写成：

- “某一个模型在所有场景绝对最好”
- “冷启动结论和主实验结论完全一致”
- “旧版 hybrid 与新版 shared-catalogue hybrid 可以直接视为同一实验”

---

## 8. 一句话版本

如果 E 只想记一句话：

> 最终整合只看 `final_eval/`，主实验统一引用 `main_results.csv`、`main_significance_tests.csv`、`version_info.json`，不要混用旧版 `results/` 和 C/D 各自单跑的非统一结果。
