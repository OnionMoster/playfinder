# C（BPR）Top-100 公开脱敏可复现性说明

## 1. 说明

本材料记录成员 C 的 BPR 模型和 Top-100 导出过程。它是公开脱敏版本：

- 删除电脑名、Python 绝对路径和项目绝对路径；
- 不包含逐用户请求、已见交互或推荐结果；
- 保留代码、参数、依赖、设备规格、数据版本、候选集、运行命令、验证结论和所有
  必要 SHA-256；
- 不修改已有排名。

内部逐用户文件仍由团队受控保存。成员 D 的 Hybrid 模型需要单独提供对应材料。

公开归档：`C_reproducibility_public_bundle.zip`

归档 SHA-256：

`edec033f264de30e1ceae4f8907aea5378779096b38b3f82ff06a6051d7cfe53`

## 2. 输出身份

- 内部输出：`bpr_top100.csv`
- 字段：`profile_id,model_user_id,item_id,rank,score`
- 规模：46 个 profile，每个 100 行，共 4,600 行
- 输出 SHA-256：
  `b18a0ee6672d08921d0ba44a6c84034a23f74dac4bcd3c68d94f3030fde0ded0`
- 独立 checklist 验证：通过

公开归档只包含 `output/OUTPUT_MANIFEST.md`，不包含逐用户输出行。

## 3. 复现命令

在项目根目录运行：

```powershell
python -m C_model.pipeline.export_cd_handoff_bpr_top100
```

该命令加载最终 checkpoint，只执行推理和排序，不重新训练。运行日志的路径统一以
`<PROJECT_ROOT>` 表示。

## 4. 正式模型

Trial：`bpr_f96_lr0.02_r0.005_i75`

| 参数 | 数值 |
|---|---:|
| factors | 96 |
| learning_rate | 0.02 |
| regularization | 0.005 |
| iterations | 75 |
| verify_negative_samples | true |
| negative_sampling | uniform_unobserved |
| random_state | 42 |
| num_threads | 1 |
| backend | implicit 0.7.3 |

调参和最终训练的随机种子均为 `42`。导出不进行随机抽样；相同分数以 Steam appid
升序稳定排序。

## 5. 代码版本

当前工作区没有可引用的 Git commit，因此使用逐文件 SHA-256。完整 `C_model`
Python 源代码保存在 `code/C_model/`，校验值见：

`hashes/CODE_SHA256SUMS`

Top-100 导出脚本：

`code/C_model/pipeline/export_cd_handoff_bpr_top100.py`

其 SHA-256 为：

`2d646e9b30b7ed3aa0366c382dd424d075cf4901f2922ace6805d530a17c505b`

## 6. Python、依赖和设备

- Python 3.12.13，CPython，64-bit
- NumPy 2.5.1
- SciPy 1.18.0
- implicit 0.7.3
- PyArrow 25.0.0
- scikit-learn 1.9.0
- threadpoolctl 3.6.0
- Windows 11，build 26200，AMD64
- Intel Core i5-13600KF，14 核/20 逻辑线程
- 内存 34,163,961,856 bytes（约 31.8 GiB）
- CPU 执行，固定单线程
- GPU 未使用

设备规格保留用于复现，但不包含电脑名或账户信息。

## 7. 数据、split 和 candidate

- A 数据版本：`v1.0 frozen`
- split cutoff：`1641340800`（2022-01-05 00:00:00 UTC）
- 训练规则：`timestamp <= cutoff`
- 测试规则：`timestamp > cutoff`
- seen 排除：同一 model user 的全部训练期交互，不区分 label
- candidate 数量：20,435
- ID：Steam appid
- handoff manifest 声明的 candidate SHA：
  `01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed`
- `candidate_items.csv` 原始文件 SHA-256：
  `0cf7cec4058912f1b17a1be7ff43f940474ce0dab6adb0f232dc04e24021c59d`

A v1.0 权威文件 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `items.parquet` | `7880f48c0255cd887af3356344992f75f0cb5517984c694ce054a76eb3474ba2` |
| `interactions.parquet` | `7b0b5a2d4b0320c1f932bde8d66a3bd70ce709e1696a7ccabc329d56e85fe22f` |
| `users.parquet` | `8ac5e766d07a7c8f285e2bb046deb3595d1a13f57e61b71b9cbd09bbfbe33cc8` |
| `item_popularity.parquet` | `e2ae7b87d9719c28caa4fd3b0c0eabb98797cd51f725c61eb8e88c1b91aa7f18` |

## 8. Checkpoint

- 名称：`C_result/results_1/final_training/run_001`
- BPR trial：`bpr_f96_lr0.02_r0.005_i75`
- 训练用户：1,838,974
- 候选物品：20,435
- 正反馈交互：15,148,098

大型 checkpoint 不在公开 ZIP 中重复分发。每个组成文件的名称、大小和 SHA-256
保存在：

- `checkpoint/CHECKPOINT_MANIFEST.md`
- `hashes/CHECKPOINT_SHA256SUMS`

在独立机器复现时，需要通过受控渠道取得 checkpoint，并在运行前核对 SHA。

## 9. 隐私处理

公开 ZIP 不包含：

- `model-user-export-request.csv`
- `profile_seen_items.csv`
- `bpr_top100.csv`
- `study_profiles.csv`
- 电脑名
- 本机绝对路径
- Windows 用户名、邮箱、IP、密码、token 或密钥

相关受控文件只保留 SHA、行数、字段和验证结果，以便团队内部核对。
