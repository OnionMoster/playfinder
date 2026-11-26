# 协同过滤模型

`models/cf.py` 实现基于物品的协同过滤；`models/mf.py` 实现隐式反馈 ALS 和 BPR；`models/train_final_models.py` 与 `models/evaluate_final_models.py` 分别提供训练和评测入口。

脚本需要处理后的 Parquet 输入和模型文件，这些文件未包含在本作品集中。已有汇总结果和参数记录位于 `results/`；它们不是本次重新运行产生的结果。
