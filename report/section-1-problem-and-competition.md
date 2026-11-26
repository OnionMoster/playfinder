# 问题定义与竞品分析

## 问题定义

PC 游戏发现不仅是排序问题。即使预测相关性高，列表也可能包含用户已经评价过的游戏、超出预算、不支持所选平台，或重复相似的类型与标签。PlayFinder 将模型排序与统一服务层分开：模型基于同一候选集提供 Top-100，服务层统一排除训练期评价过的物品、应用硬过滤并使用确定性 MMR 重排。

研究关注：在相同界面及规则下，Popularity、BPR、Hybrid 在离线排序指标和用户感知的发现质量上是否存在有意义的差异；不能在用户研究前断言某一模型更优。

## 竞品

### Steam Discovery Queue

Steam 将新品、畅销和与已玩内容相似的产品组成个性化队列，支持愿望单、关注、购买和忽略，并过滤已购买或标记为不感兴趣的物品。它适合低操作成本的逐项探索；但公开体验混合多种信号，无法获得可复现的候选集、切分、模型身份和统一后处理规则。

来源：[Steam Discovery Update](https://store.steampowered.com/about/newstore?l=english)、[Discovery Update 2.0](https://store.steampowered.com/about/newstore2016/)。

### Steam Interactive Recommender

该系统利用大量用户的游戏时长学习，允许调整热门与小众、新作与经典以及标签过滤；Steam 表示无人玩过的新作暂无法推荐。它接近交互式个性化推荐，但不公开学习表示、候选生成和评测切分。PlayFinder 另外将预算和平台作为模型无关的硬约束，并在统一服务规则下对比三种固定模型。

来源：[Steam Labs](https://store.steampowered.com/labs)、[Interactive Recommender 介绍](https://store.steampowered.com/news/posts/?enddate=1584723646&feed=steam_blog)。

### SteamDB

SteamDB 是独立 Steam 产品数据库，提供在线玩家数、价格历史、地区信息和更新历史，适合信息查询和市场观察。它声明数据按现状提供且与 Valve 无关；其主要用途是目录信息查询，用户需要自行把图表、价格和筛选结果转化为发现决策。

来源：[SteamDB](https://steamdb.info/)、[常见问题](https://steamdb.info/faq/)。

### Steam 250

Steam 250 主要根据评论票数和好评率形成公开、开源的全球排名；其算法刻意不依据票数与好评率之外的游戏内容。它有助于寻找广受好评或不易发现的游戏，但排名不针对个人训练历史、平台、预算或当前口味。

来源：[Steam 250 介绍](https://steam250.com/about)。

### Epic Games Store

所检查的商店页面提供搜索、类型与类别浏览、发售及折扣发现和平台分类，首页还有编辑推荐与活动轮播。这适合已有类型或购物目标的用户；所检查页面未公开可复现的用户级排序模型，也未提供统一三模型实验。PlayFinder 的重点是受约束且可审查的推荐比较。

来源：[Epic Games Store 浏览](https://store.epicgames.com/browse?lang=en-US)、[商店首页](https://store.epicgames.com/?lang=en-US)。

### itch.io

itch.io 支持基于标签、平台、价格、类型、输入方式、游玩时长、热度、评分和时间浏览独立游戏，也记录了基于账户活动及标签的推荐算法和 Fresh games 模块。它依赖开发者提供的异质元数据以及发现索引的收录条件。PlayFinder 范围更窄，在 Steam 场景中校验目录身份、候选集、训练截止时间、用户映射和排序规则。

来源：[推荐功能更新](https://itch.io/blog/109774/itchio-changelog-library-recommendations-enhancements-improved-jam-browsing-more)、[浏览筛选](https://itch.io/games/tag-indie-games)、[发现索引](https://itch.io/docs/creators/getting-indexed.amp)。

## 项目特点

1. 共用 20,435 个候选物品和同一时间切分。
2. 使用真实已见用户画像和固定的模型用户映射。
3. 不同模型应用相同的已评价物品排除、预算、平台和元数据规则。
4. 使用确定性 MMR 重排，不无限制地从目录追加兜底结果。
5. 使用包含六种条件顺序的盲法被试内研究。
6. 探索用户级留出集 NDCG@10 与实际满意度之间的关系。

这些特点说明系统和评测设计，不能证明该项目已经优于商业商店；用户研究结果需要结合样本和不确定性解释。
