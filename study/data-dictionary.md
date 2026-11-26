# 研究数据字典

## 关联字段

| 字段 | 含义 |
| --- | --- |
| `participant_id` | 去标识参与者编号，如 `P01` |
| `sequence` | `ABC`、`ACB`、`BAC`、`BCA`、`CAB`、`CBA` 之一 |
| `round` | 参与者看到的第 1–3 轮 |
| `condition` | 研究者可见的 A/B/C 条件 |
| `profile_id` | 分配的研究画像 |
| `model_user_id` | 与画像关联的离线评测用户 |

## 原始行为

保留原始事件数量与时间戳：`game_card_clicked`、`game_detail_opened`、`dwell_started`、`dwell_time`、`impression`、`like`、`dislike`、`wishlist_added`、`wishlist_removed`、`not_interested`、`show_more_clicked`、`filter_changed`、`round_started`、`round_completed`。曝光按参与者、条件、轮次、游戏和批次去重，不用派生的二元指标替代原始事件。

## 页面内问卷事件

- `round_survey_opened`：点击回答十题；`round_survey_dismissed`：未提交返回浏览。
- `round_survey_submitted`：记录 `q1_relevance` 至 `q10_satisfaction` 和 `surveySubmittedAt`，时间为提交时、该轮 `round_completed` 之前。
- `open_responses_opened`、`open_responses_submitted`：第三轮后的开放题。
- `likert_csv_exported`、`open_responses_csv_exported`：问卷导出；`json_exported` 和 `csv_exported`：事件导出。

## 派生在线指标

| 指标 | 定义 |
| --- | --- |
| `accepted_any` | 本轮至少一次喜欢或加入愿望单 |
| `rejected_any` | 本轮至少一次不喜欢或不感兴趣 |
| `unique_games_opened` | 打开详情的不同游戏数 |
| `total_dwell_seconds` | 有效停留毫秒数之和除以 1000 |
| `wishlist_count` | 最终仍在愿望单中的不同游戏数 |
| `satisfaction` | Q10 |
| `perceived_relevance` | Q1、Q2 均有值时取均值 |
| `discovery_quality` | Q3、Q4 均有值时取均值 |
| `constraint_fit` | Q6、Q7 均有值时取均值 |

## 离线指标与缺失数据

主要离线指标为 `scenario=seen_users_only`、`scope=overall`、`k=10` 的用户级 `ndcg_at_k`，通过 `model_user_id + model/condition` 关联。离线 NDCG 来自留出的交互，与主观满意度衡量的概念不同；相关性仅为描述，15–20 名参与者时统计不确定性较大。

未答问题保留为缺失而不是零；具体相关性分析仅在相应在线值或离线 NDCG 缺失时排除该参与者—条件对。报告每项相关性的可用对数，不得静默替换不完整事件导出。
