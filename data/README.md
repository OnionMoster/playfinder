# 数据处理流程

本目录包含生成清洗后的 Parquet 数据、`data_summary.json` 和探索性分析图表的代码。原始数据与生成的 Parquet 文件未包含在仓库中；保留的图表和汇总统计可用于查看数据特征。

## 输入数据

两份公开数据集通过 Steam `appid` 关联：

| 数据来源 | 所需文件 | 用途 |
| --- | --- | --- |
| Kaggle：Game Recommendations on Steam | `games.csv`、`games_metadata.json`、`recommendations.csv`、`users.csv` | 游戏目录、描述、标签和交互记录 |
| UCSD：Steam（McAuley 等） | `steam_games.json`、`australian_users_items.json`、`australian_user_reviews.json`、`bundle_data.json` | 类型、规格、开发商、游戏时长和捆绑包 |

默认输入结构如下，也可以使用 `PLAYFINDER_RAW_DIR` 指定其他位置：

```text
raw/
├── archive/
│   ├── games.csv
│   ├── games_metadata.json
│   ├── recommendations.csv
│   └── users.csv
└── UCSD/
    ├── steam_games.json
    ├── australian_users_items.json
    ├── australian_user_reviews.json
    └── bundle_data.json
```

UCSD 的 `.json` 文件实际使用 Python 字典表示形式，代码使用 `ast.literal_eval` 解析。

## 运行

在仓库根目录安装依赖并运行：

```bash
pip install -r data/pipeline/requirements.txt
python -m data.pipeline.run_all
python -m data.pipeline.verify
```

默认读取 `raw/`；若数据在其他位置，可设置 `PLAYFINDER_RAW_DIR`。处理过程支持续跑，也可使用以下选项：

```bash
python -m data.pipeline.run_all --force
python -m data.pipeline.run_all --confidence-alpha 40
python -m data.pipeline.run_all --only step1_items step4_eda
```

参数在 `data/pipeline/config.py` 中定义：置信度系数默认 1.0，用户最少交互数为 5，物品最少交互数为 20，DuckDB 默认使用 3GB 内存及 4 个线程。可分别通过 `PLAYFINDER_CONFIDENCE_ALPHA`、`PLAYFINDER_MIN_USER`、`PLAYFINDER_MIN_ITEM`、`PLAYFINDER_DUCKDB_MEMORY` 和 `PLAYFINDER_DUCKDB_THREADS` 覆盖；`PLAYFINDER_OUTPUT_DIR` 控制输出位置。实际参数记录在 `data_summary.json`。

## 输出与处理

| 输出 | 记录数 | 内容 |
| --- | ---: | --- |
| `interactions.parquet` | 22,286,960 | k-core 过滤后的主要建模交互 |
| `items.parquet` | 50,872 | 两份数据关联后的游戏目录 |
| `users.parquet` | 1,905,447 | 用户交互数量和分组 |
| `item_popularity.parquet` | 37,610 | 全数据集热度，主要供数据探索使用 |
| `interactions_ucsd_playtime.parquet` | 5,153,209 | UCSD 独立用户 ID 空间的拥有和时长记录 |
| `ucsd_reviews.parquet` | 59,305 | UCSD 推荐标签 |
| `bundles.parquet` | 615 | 捆绑包与物品对应关系 |
| `data_summary.json`、`figures/*.png` | — | 汇总统计与七张探索图 |

上述 Parquet 文件未提交；`rec_compact.parquet` 是中间缓存。流水线依次清洗物品、去重和 k-core 过滤交互、解析 UCSD 附加数据、生成探索结果。全数据热度在过滤前计算；用户分组在过滤后计算。模型主评测中的热度基线另按训练期数据计算，不能把探索用全数据热度直接当作无泄漏基线。

`interactions.parquet` 的字段包括 `user_id`、`item_id`、`label`、`hours`、`confidence`、`timestamp`、`user_group`。`verify.py` 检查用户与物品的最小交互数、用户物品对唯一性和物品引用完整性。`items.parquet` 还保存标题、描述、标签、类型、平台、价格和发行信息等字段。

## 记录的数据特征与限制

- 原始交互 41,154,773 条；经过用户至少 5 条、物品至少 20 条交互的 k-core 过滤后，保留 22,286,960 条。
- 前 1% 的游戏占交互的 56%，前 10% 占 92%，体现长尾分布。
- 只有 14,931 / 50,872 个 Kaggle 游戏可与 UCSD 匹配；缺失类型不能凭标签虚构。
- 两个数据源的用户 ID 空间不同，可以关联物品但不能直接关联用户。
- 主要交互代表评论或已见行为，不等于完整拥有记录；源数据的 `hours` 上限为 1,000。
- 随机和排序规则等配置以已有记录为准；`data_summary.json` 是这些汇总数字的来源。
