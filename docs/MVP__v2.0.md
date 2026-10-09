# 赛事预言家 MVP 核心机器可执行规范 v2.0

> 状态：**FROZEN / 唯一业务基线**——自本版起，本文件是后端与前端共同依赖的唯一业务基线；`MVP__v1.0.md` 归档为只读历史版本，不再作为编码依据。
>
> 基线构成：`MVP__v1.0.md`（结构与未受影响条款的底稿）+《成长体系阈值 v3 完整建议（v1.0）》（等级/排行榜/群机制建议稿，其中「需确认」10 条已由产品全部确认并按推荐方案落地为正式条款，「假设」10 条按文档设计一并生效）。
>
> 项目**未上线**：无存量用户、无线上数据、无迁移与兼容包袱；本版不含任何迁移、灰度、回滚、双算、cutover 类内容。
>
> 目标：在暂不开发前端 UI 的前提下，冻结 MVP 核心后端的产品边界、领域规则、数据库 Schema、索引、状态机、时间、幂等、异常、赛果修正、等级与排行榜、API Contract、数据源适配、运维与验收测试。本规范不含实现建议、文件路径或代码片段；「机器可执行」指规则、数值、公式、枚举、状态机、Schema、API 合同、验收用例、不变量均明确到可直接照做。
>
> 技术基线：微信小程序 + 微信云开发（云函数、云数据库、定时触发器）+ API-Football。
>
> MVP 联赛：英超、西甲、意甲、德甲、法甲、中超（六联赛，见第 1.4 节）；等级赛季与排行榜采用独立于联赛赛季的平台口径（见第 6 节、第 17 节）。

---

# 0. 规范效力与编码 Agent 强制规则

## 0.1 规范优先级

发生冲突时，严格按以下优先级执行：

1. 本文档《赛事预言家 MVP 核心机器可执行规范 v2.0》
2. PRD v2.2 中与本文档不冲突的产品描述（`MVP__v1.0.md` 已归档，不再具有独立效力，仅作历史参考）
3. 代码中的既有接口定义与测试
4. 代码注释
5. 编码 Agent 的默认经验、框架惯例、个人判断

低优先级内容不得覆盖高优先级规则。

## 0.2 禁止自行扩展需求

编码 Agent **MUST NOT**：

- 自行增加本文档未定义的业务功能。
- 自行增加新的积分来源、扣分规则、奖励规则、预测玩法或排行榜类型。
- 自行增加新的业务状态或修改现有状态语义。
- 自行改变 API 字段名、字段语义、错误码或 HTTP Status。
- 自行改变数据库字段类型、nullable、默认值、唯一约束或事实来源。
- 自行增加“为了体验更好”的自动容错业务行为。
- 遇到未知 Provider 状态时自行猜测其含义。
- 遇到异常数据时使用“最接近”“大概率正确”的值继续结算。
- 为实现方便而绕过账本、幂等、审计、状态机或服务端校验。
- 直接对聚合字段做无法追溯的人工修正。
- 实现本文档标记为 `OUT_OF_SCOPE` 的功能。

## 0.3 未定义行为

任何输入、状态或数据组合未被本文档明确允许时，默认策略为：

> **Fail Closed：拒绝写入、停止业务推进、记录错误或异常，不猜测业务结果。**

读取接口可以在不破坏语义的前提下返回已有数据，但不得制造缺失业务事实。

## 0.4 单一实现来源

以下领域逻辑必须各自只有一个可复用的实现入口，其他模块只能调用，不得复制公式：

- `derive_result(home_score, away_score)`
- `calculate_match_score(prediction, result, scoring_rule_version)`
- `build_level_inputs(user, scope, as_of)`（构造某 scope 在某评估截面的窗口 n/S、B 值等定级输入截面，第 17 节）
- `evaluate_level(state, inputs, rule_version, as_of)`（纯函数，唯一定级算法入口，第 17.6 节）
- `replay_level(user, scope)`（按事件序列纯函数回放等级轨迹，第 17.9 节）
- `calculate_period_key(period_type, period_anchor_at)`
- `compare_ranking_entry(board, a, b)`（按 `board` 分别实现 `week`/`career`/`season` 比较器与 `strength` 比较器，两者不得共用同一比较逻辑，第 19.5 节）
- `can_submit_prediction(user, match, existing_prediction, server_now)`
- `normalize_provider_fixture(provider_payload)`
- `validate_match_transition(from, to)`
- `validate_settlement_transition(from, to)`

以上每个函数只允许一个实现；`level`、`ranking` 相关的任何判定（含 API 展示值计算）必须调用以上入口，不得在别处重复实现或复制公式。

## 0.5 事实与缓存

任何时候必须区分：

### Source of Truth / 事实数据

- `matches`
- `match_results`
- `predictions`
- `settlements`
- `settlement_items`

### 可重建聚合/缓存

- `users.career_*`
- `user_season_stats`
- `rankings`
- 当前等级字段（`career_level` / `career_best_level` / `career_level_state`、`user_season_stats.level` / `best_level` / `level_state`）——这些字段是可通过 `replay_level`（第 17.9 节）以账本、评估时刻表、规则版本表为输入纯函数重建的缓存，而不是独立事实；等级的路径依赖性（一次一级、连续两周降级、保护期）不改变其「可重建缓存」的地位。
- `board_snapshots`（生涯榜、实力榜、赛季榜快照，第 21.20 节）
- `groups.member_count`（可由 `group_members` 统计重建）
- `predictions` 上的当前结算结果字段

发现缓存与事实不一致时，以事实数据重建；不得反过来修改账本以迁就缓存。

## 0.6 禁止物理删除核心业务数据

除允许清理的运行日志外，以下数据不得物理删除：

- 比赛
- 比赛正式结果版本
- 预测
- 结算
- 结算明细
- 周聚合历史（`rankings`）
- 生涯榜/实力榜快照（`board_snapshots`，按第 37 节保留策略保留最近版本，但当次生效版本不得在到期前删除）
- 等级变化历史（`level_history`）
- 解锁记录
- 群与群成员关系（`groups` / `group_members`，解散/退出为软删除，见第 19.4 节）
- 管理员审计记录

---

# 1. MVP 产品边界

## 1.1 产品定位

免费、纯娱乐、无博彩元素的足球比分预测小程序。

永久禁止：

- 充值
- 投注
- 赔率
- 盘口
- 奖池
- 提现
- 可兑换现金或实物的积分
- 用户之间转移积分
- 付费预测推荐
- AI 自动替用户提交比分
- 以 AI 自动推荐比分作为核心功能

统一业务术语：

- 预测
- 赛果
- 命中
- 胜平负准确率（内部统计口径，不对外展示、不参与任何排序或定级，见第 17.5 节）
- 预测分
- 生涯积分
- 收缩场均分（内部定级指标 `s`，对外展示名「预言指数」，仅用于实力榜，见第 17 节）
- 排行榜（本周榜 / 生涯榜 / 实力榜 / 赛季榜，全站 / 我的群，见第 19 节；赛季榜仅对参与 ≥2 个等级赛季的用户可见，第 19.9 节）
- 等级（生涯等级 / 本赛季等级，1..6 六级，见第 17 节）
- 等级赛季（平台统一的赛季口径，与各联赛自身赛季解耦，见第 6.4 节）
- 群（平台自建的预测排行小群，见第 19.4 节）
- 装扮解锁

## 1.2 MVP 必须实现

1. 微信身份识别。
2. 内部稳定 `user_id`。
3. 游客查看赛程、比赛详情、公开用户战绩。**排行榜需登录**：游客进入榜单页只看到模糊的灰色占位与「请登录查看榜单」（第 19.10.9 节）。
4. 六联赛（英超、西甲、意甲、德甲、法甲、中超）球队与赛程同步。
5. 用户提交准确比分。
6. 服务端推导胜/平/负。
7. 预测截止规则。
8. 提交后不可修改、不可删除。
9. API-Football 比赛状态与正式比分同步。
10. 比赛状态机。
11. 结算状态机。
12. 0 / 3 / 12 单场计分。
13. 计分规则版本。
14. 正式赛果版本。
15. 幂等结算账本。
16. 部分失败安全恢复。
17. 赛果修正与自动重结算。
18. 生涯积分。
19. 本赛季等级。
20. 职业生涯等级。
21. 等级评级门槛与收缩校准（收缩场均分 s 与累计积分 B 值双门槛、周评估、一次一级、滞后降级）。
22. 周周期聚合。
23. 周榜。
24. 历史周榜。
25. 生涯榜。
26. 实力榜。
26a. 赛季榜（当前等级赛季；仅对参与过 ≥2 个等级赛季的用户可见，第 19.9 节）。
26b. 赛季终榜（已结束等级赛季的最终榜，随赛季最终评估冻结并永久保留，第 19.11 节）。
26c. 低流量与冷启动展示（第 19.10 节）。
27. 群创建、加入、退出、解散。
28. 群榜（全站数据按群成员过滤）。
29. 主队选择。
30. 默认分享卡所需后端数据。
31. 30 / 100 / 200 三档 MVP 解锁。
32. 历史预测。
33. 管理员赛果修正。
34. 管理员审计。
35. Provider 同步异常检测。
36. 数据重建能力（含账本聚合重建与等级轨迹回放重建）。
37. 每日一致性校验。

## 1.3 OUT_OF_SCOPE

> 本期不做与未来计划的汇总见第 48 节。

MVP 不实现：

- 六联赛以外的其它联赛、杯赛、友谊赛（`LEVEL_ELIGIBLE_LEAGUES` 与 `SUPPORTED_LEAGUES` 之外的任何赛事）。
- 月榜（周期聚合与月度排行榜；排行榜只保留本周榜 / 生涯榜 / 实力榜 / 赛季榜，见第 19 节）。
- 半赛季榜。
- 联赛赛季维度的整赛季榜（按各联赛自身 `season_id` 划分的榜单）。欧冠等杯赛的后续规划见第 19.12 节。注意：按**等级赛季**口径的「赛季榜」（`board=season`）在 MVP 范围内，见第 19.9 节；本赛季**等级**本身仍不是排行榜，见第 17 节。
- 评论、社区、资讯聚合。
- 微信订阅提醒。
- 广告、会员。
- 动态头像框。
- 大规模主题皮肤。
- 独立成就/头衔系统（等级称号是本产品唯一的「称号」机制，见第 17.2 节）。
- 「前顶级球星」等衍生称号的独立存储字段（可由 `career_best_level == 6 AND career_level < 6` 派生，不新增字段，见第 17.11 节）。
- 预言指数（`strength_index`）用于定级判定或在等级页/资料页展示；预言指数仅作为实力榜的只读展示值。
- 按分数差距的升级/入榜进度文案（如「差 0.05 分」「再拿 X 分升级」）；只允许基于确定场次门槛的进度文案（见第 19.8 节）。
- 单独总进球数预测。
- 开赛前修改预测。
- 预测删除。
- 用户自行编辑积分、等级、排名。
- 任何赔率、投注或博彩市场数据；等级/排行榜相关的强弱监控指标（第 17.13 节）只使用平台自算的已结算赛果 Elo，不引入任何赔率源。
- 群内自由文本群名、群聊天、群内私信。
- 前端 UI 设计与具体视觉实现。
- 自动数据纠错推断。
- 已完成比赛的自动作废/取消重算功能；若未来需要，必须升级规范版本。

## 1.4 MVP 支持联赛与当前赛季

`provider = "api_football"`（全部六联赛统一使用该 Provider）。

`SUPPORTED_LEAGUES`（= `LEVEL_ELIGIBLE_LEAGUES`，等级白名单与联赛支持范围同源，见第 17.4 节）为封闭枚举，编码不得自动扩展枚举外的联赛或赛季：

| `league_id` | 名称 | `api_football_league_id` | `api_football_season`（当前） | `season_id`（当前，平台口径） | 赛季周期 | `round_id` 上限 |
|---|---|---|---|---|---|---|
| `premier_league` | 英超 | `39` | `2026` | `2026_2027` | 8 月–次年 5 月 | `38`（`"01".."38"`） |
| `la_liga` | 西甲 | `140` | `2026` | `2026_2027` | 8 月–次年 5 月 | `38`（`"01".."38"`） |
| `serie_a` | 意甲 | `135` | `2026` | `2026_2027` | 8 月–次年 5 月 | `38`（`"01".."38"`） |
| `bundesliga` | 德甲 | `78` | `2026` | `2026_2027` | 8 月–次年 5 月 | `34`（`"01".."34"`） |
| `ligue_1` | 法甲 | `61` | `2026` | `2026_2027` | 8 月–次年 5 月 | `34`（`"01".."34"`） |
| `chinese_super_league` | 中超 | `169` | `2026` | `2026` | 自然年 3–11 月 | `30`（`"01".."30"`） |

规则：

- `league_id` 为封闭枚举，取值即上表六项；`matches.league_id` 只能是上表之一。
- `season_id` 格式按联赛类型固定：五大联赛（跨年赛季）为 `"YYYY_YYYY+1"`；中超（自然年赛季）为 `"YYYY"`。两种格式不得混用、不得互相推断。
- 每个联赛的「当前赛季」为该联赛唯一允许创建新 `matches` 的 `season_id`；跨赛季扩展（切换到下一赛季）需要更新本表并保持向后兼容读取（历史赛季比赛与统计永久保留，不删除、不迁移）。
- `api_football_season` 是 Provider 请求参数，不直接等于 `season_id`；两者的映射关系由本表显式登记，不得由服务端动态猜测。
- 本表六联赛之间相互独立：赛程同步、状态机、结算、等级窗口白名单、分享卡等均按 `league_id` 隔离或显式聚合，禁止跨联赛拼接 `round_id` 语义。
- 「等级赛季」（用于等级评级，第 17.4 节）是独立于本表 `season_id` 的平台统一口径，不与本表联赛赛季混淆。

---

# 2. 全局技术约定

## 2.1 命名

数据库字段、API JSON 字段统一：

```text
snake_case
```

TypeScript 内部可使用 `camelCase`，但必须通过显式 mapper 转换；不得直接让 ORM/SDK 随机决定 API 字段命名。

## 2.2 ID

以下内部 ID 使用 UUID v4，小写 canonical 36 字符字符串：

- `user_id`
- `team_id`
- `match_id`
- `prediction_id`
- `settlement_id`
- `unlock_id`
- `level_history_id`
- `admin_id`
- `audit_id`
- `snapshot_id`
- `sync_job_id`
- `anomaly_id`
- `group_id`

`league_id`、`season_id`、`round_id`、`level_season_id`、`level_rule_version` 为稳定业务字符串，不使用 UUID。`invite_code` 为 8 位业务邀请码（字符集见第 19.4 节），不使用 UUID。

## 2.3 时间

数据库：

- 使用数据库原生 Date / UTC instant。
- 禁止以北京时间字符串作为事实时间。
- `created_at`、`updated_at`、`submitted_at` 等均由服务端生成。

API：

- 所有时间输出为 ISO 8601 UTC，例如 `2026-08-08T06:00:00Z`。

用户展示：

- 由前端转换为 `Asia/Shanghai`。

所有业务判断：

- 只允许使用可信服务端时间 `server_now`。
- 禁止使用客户端时间做授权、锁定、周期或结算判断。

## 2.4 Nullable

- 字段有语义但当前无值：返回/存储 `null`。
- 空列表：`[]`。
- 禁止使用空字符串代替 `null`。
- API 不得根据心情省略已定义字段；稳定响应对象中的字段必须存在，除非 Contract 明确标记为 optional。

## 2.5 Schema Version

每个核心业务文档必须包含：

```text
schema_version: 1
```

未来字段语义发生不兼容变化时：

- 必须写 migration。
- 不得在运行时“猜测旧数据结构”。

---

# 3. 固定配置 v1

以下为 MVP 默认且冻结的业务配置：

```text
PREDICTION_LOCK_MINUTES = 10
PREDICTION_SCORE_MIN = 0
PREDICTION_SCORE_MAX = 20

FINAL_SCORE_MIN = 0
FINAL_SCORE_MAX = 99

SETTLEMENT_WAIT_MINUTES = 10

SCORING_RULE_VERSION = "scoring_v1"
WDL_HIT_SCORE = 3
EXACT_HIT_SCORE = 12

API_DEFAULT_LIMIT = 20
API_MAX_LIMIT = 100

CROWD_MIN_PREDICTIONS = 20
CROWD_GRANULARITY_PERCENT = 5

SYNC_FUTURE_DAYS = 30
SYNC_NORMAL_INTERVAL_HOURS = 6
SYNC_NEAR_24H_TO_2H_INTERVAL_MINUTES = 30
SYNC_NEAR_2H_TO_FINISH_INTERVAL_MINUTES = 3

SYNC_RETRY_DELAYS_MINUTES = [1, 2, 5, 10, 30]
SYNC_MAX_RETRIES = 5
SYNC_RETRY_JITTER_PERCENT = 20

LIVE_SYNC_FAILURE_ALERT_MINUTES = 10
LIVE_TOO_LONG_AFTER_KICKOFF_MINUTES = 150
FINISHED_NO_SCORE_ALERT_MINUTES = 20

JOB_LEASE_MINUTES = 10
SYNC_LOG_RETENTION_DAYS = 30
```

以下为等级（`level_v3.0`）、排行榜与群的冻结配置，登记规则同上；带 `LEVEL_` 前缀的判定参数属于「影响历史结果的配置」，任何数值变化必须新建 `level_v3.x` 子版本并带生效 `as_of`，只追加不改写，不回溯重算已产生的评估结果（详见第 17 节）：

```text
LEVEL_RULE_VERSION               = "level_v3.0"
LEVEL_MIN                        = 1
LEVEL_MAX                        = 6
LEVEL_RATED_MIN_VALID            = 20
LEVEL_PRIOR_WEIGHT_K             = 40
LEVEL_PRIOR_MEAN_X100            = 170          # 伪分 P0 = 68
LEVEL_WINDOW_MAX_N               = 300
LEVEL_WINDOW_MAX_DAYS            = 730
LEVEL_PROMOTE_X100               = {3: 180, 4: 195, 5: 215, 6: 235}
LEVEL_HOLD_X100                  = {3: 170, 4: 185, 5: 205, 6: 225}
LEVEL_B_POINTS                   = {3: 80, 4: 170, 5: 380, 6: 630}
LEVEL_DEMOTE_CONSECUTIVE         = 2
LEVEL_MAX_STEP_PER_WEEK          = 1
LEVEL_EVAL_SCHEDULE              = 每周一 10:00 Asia/Shanghai
LEVEL_EVAL_START_DELAY_MINUTES   = 10           # 运维配置，不改语义
LEVEL_FIRST_EVAL_AS_OF           = 上线后首个周一 10:00 Asia/Shanghai（由上线日期决定，只追加登记，不回溯）
LEVEL_PROTECTION_EVALS           = 13
LEVEL_SEASON_BOUNDARY            = 07-01 00:00 Asia/Shanghai
LEVEL_ELIGIBLE_LEAGUES           = 同 SUPPORTED_LEAGUES（第 1.4 节）

RANKING_BOARDS                   = [week, career, strength, season]
WEEK_BOARD_MIN_VALID             = 1
SEASON_BOARD_MIN_VALID           = 1            # 当前等级赛季有效预测 ≥1 场入榜
SEASON_BOARD_MIN_SEASONS         = 2            # 参与过的等级赛季数 ≥2 才对用户可见（第 19.9 节）
SEASON_BOARD_SNAPSHOT_MINUTES    = 60           # 运维配置
STRENGTH_BOARD_MIN_WINDOW_N      = 50
RANKING_TOP_LIMIT                = 20
RANKING_PAGE_SIZE                = 10
RANKING_ABSOLUTE_RANK_MAX        = 20
RANKING_TOP_PERCENT_CLAMP        = [1, 99]
CAREER_BOARD_SNAPSHOT_MINUTES    = 60           # 运维配置
GROUP_MAX_MEMBERS                = 500
USER_MAX_GROUPS_JOINED           = 20
USER_MAX_GROUPS_OWNED            = 5
GROUP_INVITE_CODE_LENGTH         = 8
GROUP_INVITE_CODE_ALPHABET       = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # 去除 O/I/0/1
```

业务配置若需要改变：

- 计分、等级等会影响历史结果的配置必须新建版本。
- 单纯运行频率、日志保留等运维配置可通过配置中心改变，但不得改变业务语义。

---

# 4. 用户与身份规范

## 4.1 身份来源

MVP 用户身份：

```text
openid
```

`unionid`：

- 仅预留。
- 可保存。
- 第一版不得参与登录判断、账号合并、排行榜、预测或任何业务关联。

所有业务关系使用：

```text
user_id
```

禁止使用 openid 作为预测、排行榜、结算等业务表外键。

## 4.2 用户创建

可信微信运行环境提供 `openid` 后：

1. 按 `openid` 查询 active 用户。
2. 存在则返回已有 `user_id`。
3. 不存在则尝试创建新用户。
4. 数据库 `openid` 唯一约束负责处理并发创建。
5. 唯一冲突时重新读取并返回已创建用户。

不得使用“先查再插”作为唯一并发保护。

## 4.3 昵称

active 用户：

- `nickname` 必须为 1～32 个 Unicode grapheme。
- 不得只包含空白。
- 服务端 trim 首尾空白。
- 昵称只用于展示，不参与任何排名、身份或业务判断。

## 4.4 主队

`favorite_team_id`：

- nullable。
- 只能指向 `teams.status = active` 的球队（第 1.4 节六联赛任一球队）。
- 用户可以后续修改。
- 修改只影响当前视觉相关数据。
- 不影响积分、等级、历史预测、历史排行榜或已解锁资格。

## 4.5 注销

用户注销时：

```text
status = "deleted"
deleted_at = server_now
openid = "deleted:" + user_id
unionid = null
nickname = null
favorite_team_id = null
```

说明：

- `deleted:<user_id>` 不是微信身份，只是为满足数据库唯一索引而保存的不可登录墓碑值。
- 原 `openid` 必须从该用户记录移除。
- `user_id` 永久保留。
- 历史预测、结算、排名、等级历史保留。
- 公开历史展示由 API 根据 `status=deleted` 返回固定展示名 `已注销用户`。
- 已注销用户不能提交预测或访问个人私有接口。
- 同一微信 openid 未来重新注册时，创建新的 `user_id`；不得自动关联旧账号。

## 4.5.1 注销身份映射（D-P1 方案 B，已确认）

### 目的

第 4.5 节要求注销后 users 主记录移除原微信 `openid`（改写为墓碑值
`deleted:<user_id>`），同时系统仍须在可信运行时持有原 openid 时识别
「该微信身份对应一名已注销用户」，以便：

- 私有读接口返回 409 `USER_DELETED`；
- 公开读接口返回 `can_predict_reason=USER_DELETED`；
- `POST /v1/predictions` 在旧 `user_id` 上执行第 8.6 节幂等重放。

为此增加**专用注销身份映射**，与 users 主记录分离。

### 存储

新增集合 `deleted_openid_mappings`：

- `original_openid`：注销前的微信 openid；**UNIQUE**。
- `deleted_user_id`：对应已注销用户的 `user_id`。
- `deleted_at` / `created_at` / `updated_at` / `schema_version`。

### 与第 4.5 节的关系（不冲突声明）

- users 主记录在注销后**必须**移除原 openid，并写入墓碑
`openid = "deleted:" + user_id`。
- `deleted_openid_mappings.original_openid` **不是** users 主记录的事实身份字段，
也不是可登录凭证；它只供服务端在已持有**可信 runtime openid** 时做 deleted 判定。
- 二者并存不违反「原 openid 必须从该用户记录移除」。

### 禁止语义

注销身份映射：

- 不得用于恢复账号、重新激活 `status=deleted` 用户；
- 不得作为客户端可提交的身份输入（body/query/header 均不可）；
- 不得使旧账号“直接登录”或默认暴露私有历史 UI 以外的越权数据；
- 私有历史的服务端定位仅用于：409 语义、幂等重放、以及公开场上的
`USER_DELETED` 原因码；不得把旧用户的私有列表在 deleted 会话中完整返回。

### 可信身份解析顺序（固定）

在网关/application 边界，对请求的可信 openid 解析严格按以下顺序，命中即停：

1. 无可信 openid → `anonymous`；
2. `users` 中存在 `openid = 可信 openid` 且 `status=active` → `active`
 （**永远优先于**任何注销映射）；
3. 否则，若 `deleted_openid_mappings` 存在 `original_openid = 可信 openid`
 → `deleted`（携带 `deleted_user_id`）；
4. 否则 → `unregistered`。

### 重注册隔离

- 同一微信 openid 在仅有注销映射、无 active 用户时，`POST /v1/session/init`
**创建全新** `user_id` 的 active 用户（HTTP 201），不得复用
`deleted_user_id`。
- 新用户不得继承或默认暴露旧用户的预测、结算、等级、排名与其它私有数据。
- 解析时 active 优先，保证新用户存续期间不会被 mapping 误判为 deleted。
- 新用户再次注销：按 4.5 墓碑化新用户，并将映射 upsert 为
`original_openid → 新 deleted_user_id`。

### 唯一性

- `original_openid` 全局唯一；同一 openid 仅保留一条当前映射。
- 多次注销（不同世代用户）通过 upsert 更新 `deleted_user_id`。

### 保留期

- 映射行永久保留，不设定期物理删除策略，与第 0.6 节「禁止物理删除核心业务数据」的精神一致（映射是判定 `deleted` 身份与定位历史幂等重放的必要事实）。
- 若未来需要物理清理，必须先定义清理对幂等重放与 409 语义的影响，并另版冻结；MVP 版本不实现任何清理任务。

### HTTP 行为（与 49.1 / 49.2 / 8.6 对齐）

| 身份 | 接口类型 | 行为 |
|---|---|---|
| deleted | 私有读（profile/me、predictions/me、unlocks/me、levels/me、rankings 等） | 409 `USER_DELETED` |
| deleted | 公开读（matches 列表/详情等） | 200；`can_predict=false`；`can_predict_reason=USER_DELETED`；`my_prediction=null` |
| deleted | POST predictions 同 key+同 payload | 200 首次结果 |
| deleted | POST predictions 同 key+不同 payload | 409 `IDEMPOTENCY_KEY_REUSED` |
| deleted | POST predictions 新 key | 409 `USER_DELETED` |
| active（含重注册后） | 正常 49.1/49.2 | 与旧用户数据隔离 |

### 鉴权边界（不变）

- 不修改 H4 / OpenAPI security scheme。
- 不引入 JWT、Bearer、Cookie 或服务端 session token 作为登录凭证。
- 身份只来自网关/运行时注入的可信 openid；禁止信任客户端传 openid。

## 4.6 鉴权与会话

### 身份来源

- 网关/运行环境注入**可信** `openid`（或等价字段）。
- 后端**不**自行签发 JWT / Cookie / session token 作为登录凭证。
- 后端**不**信任客户端 body/query 中的 `openid` / `user_id` 作为鉴权依据。
- 已注销身份的解析顺序、重注册隔离与 HTTP 行为见第 4.5.1 节。

### 请求身份绑定

| 接口类型 | 身份要求 |
|---|---|
| `POST /v1/session/init` | 必须有可信 `openid`；body 可含 `nickname`，不得含可冒充他人的 `user_id` |
| Auth required 写/读接口 | 必须有可信 `openid` → 解析为 active `user_id` |
| 公开读接口 | 可不登录；若带可信身份，可返回「当前用户相关」可选字段 |

### 失败语义

| 条件 | HTTP | code |
|---|---|---|
| 缺少可信身份 | 401 | `UNAUTHORIZED` |
| 可信 openid 对应用户已注销 | 409 | `USER_DELETED` |
| 客户端试图用 body/query 伪造他人 `user_id` | 403 或 404 | 按接口既有「不得冒充」规则；不得静默切到伪造用户 |

### session/init 幂等

- 同 active openid 再次 init：返回 **200** 与既有用户；**忽略** body 中的新 `nickname`（不覆盖）。
- openid 不存在：创建用户，返回 **201**。
- 若可信 openid 经第 4.5.1 节解析为 `deleted`（无 active 用户）：
  - 非 `session/init` 的 Auth 私有读/写：409 `USER_DELETED`；
  - `POST /v1/session/init`：**创建新 active 用户**（201），不得复活旧 `user_id`；
  - 预测幂等重放仍绑定旧 `deleted_user_id`（仅当请求在未重注册、resolver 仍为 deleted 时）。
- 若已重注册为 active，则 init 走 active 200 语义。

### 认证方式的 OpenAPI 表达

- OpenAPI 不声明 `BearerAuth`、`bearerFormat: JWT` 或任何 Bearer/Cookie/客户端可填写的身份 Header security scheme。
- 文档根级固定 `x-trusted-runtime-openid`：身份字段为 `openid`，由 `gateway_or_runtime` 注入，`client_supply_forbidden: true`。
- 所有 Auth required operation（含 `POST /v1/session/init`）固定 `x-requires-trusted-openid: true`；公开读接口不写该标记。该标记只表达可信运行时依赖，不是客户端请求参数。
- 401 只表示缺少可信身份并使用 `UNAUTHORIZED`；已注销用户保持 409 `USER_DELETED`；非 active 管理员保持 403 `FORBIDDEN`。

---

# 5. 联赛、球队、比赛与 Provider 身份

## 5.1 内部 ID 独立

第三方 Provider ID 禁止作为：

- `team_id`
- `match_id`

第三方映射必须存入独立 Collection：

- `team_provider_mappings`
- `match_provider_mappings`

## 5.2 Provider 映射

同一 Provider 外部 ID 全局唯一：

```text
UNIQUE(provider, provider_team_id)
UNIQUE(provider, provider_match_id)
```

增加第二数据源时：

- 禁止通过球队名、开赛时间、比分等模糊条件自动绑定旧 `match_id`。
- 必须通过明确 mapping 导入流程创建映射。
- MVP 只实现 `api_football`，覆盖第 1.4 节全部六联赛。

## 5.3 round_id

`round_id` 的取值域按 `matches.league_id` 决定，上限见第 1.4 节联赛表：

```text
premier_league / la_liga / serie_a           => round_id = "01" .. "38"
bundesliga / ligue_1                         => round_id = "01" .. "34"
chinese_super_league                         => round_id = "01" .. "30"
```

规则：

- 创建比赛时由 Provider round 解析，按 `league_id` 校验落在对应上限内；超出上限视为 `PROVIDER_DATA_INVALID`。
- 创建后 `round_id` immutable。
- 延期不修改原 `round_id`。
- Provider 后续 round 与内部值冲突时记录异常，不自动覆盖。
- 不同 `league_id` 的 `round_id` 互相独立，不得跨联赛比较或合并统计（分享卡等聚合必须同时按 `league_id` 限定，见第 20 节）。

---

# 6. 比赛时间、截止与周期锚点

## 6.1 核心字段

每场比赛必须包含：

```text
kickoff_at
kickoff_confirmed
prediction_deadline_at
prediction_closed_at
period_anchor_at
```

## 6.2 prediction_deadline_at

当 `kickoff_confirmed = true`：

```text
prediction_deadline_at = kickoff_at - 10 minutes
```

当 `kickoff_confirmed = false`：

```text
prediction_deadline_at = null
```

## 6.3 预测截止边界

允许提交：

```text
server_now < prediction_deadline_at
```

拒绝提交：

```text
server_now >= prediction_deadline_at
```

刚好到截止时间即视为关闭。

## 6.4 prediction_closed_at

业务含义：

> 本场预测入口已经永久关闭的事实时间。

规则：

1. 初始为 `null`。
2. 一旦非 null，永远不得恢复为 null。
3. 一旦非 null，永远不得因延期重新开放。
4. 正常到截止时间时写：
   ```text
   prediction_closed_at = prediction_deadline_at
   ```
5. 如果 Provider 提前报告比赛已 `live` 而截止时间尚未来到，立即写：
   ```text
   prediction_closed_at = server_now
   ```
6. 如果首次发现比赛已经 `finished` 且仍未关闭，立即写 `server_now`。
7. `prediction_closed_at` 写入后 immutable。

## 6.5 延期

### 截止前发现延期

若：

```text
prediction_closed_at == null
AND server_now < old_prediction_deadline_at
```

则：

- `match_status -> postponed`
- 已有预测保留，且不可修改。
- 暂停新预测。
- 获得新的明确 kickoff 后：
  - `match_status -> scheduled`
  - 更新 `kickoff_at`
  - `kickoff_confirmed = true`
  - 重算 `prediction_deadline_at`
  - 未提交用户可继续预测。

### 截止后才发现延期

处理 Provider 新 kickoff **之前**必须先判断旧 deadline：

若：

```text
server_now >= old_prediction_deadline_at
AND prediction_closed_at == null
```

先执行：

```text
prediction_closed_at = old_prediction_deadline_at
```

之后可以更新 `kickoff_at` 用于赛程展示，但：

- `prediction_deadline_at` 保留原已关闭 deadline。
- 不重新开放。

### 到点关闭触发条件

仅当同时满足时，才因「墙钟到达 deadline」写入/保持关闭：

```text
match_status == scheduled
AND prediction_deadline_at != null
AND server_now >= prediction_deadline_at
```

此时：

```text
prediction_closed_at = prediction_deadline_at   # 若仍为 null 则写入
```

### postponed 期间

- **不得**仅因「墙钟越过旧 prediction_deadline_at」而写入 `prediction_closed_at`。
- 截止前发现延期（`prediction_closed_at == null` 且 `server_now < 旧 deadline`）：可更新 kickoff / 重算新 deadline；恢复为 scheduled 且新 deadline 未到前，未提交用户可继续预测。
- 截止后才发现延期（已关闭或 `server_now >= 旧 deadline`）：先按旧 deadline 永久关闭（`prediction_closed_at` 非 null）；之后永不因延期重新开放。

### 真值摘要

| match_status | closed_at | server_now vs deadline | 预测入口 |
|---|---|---|---|
| scheduled | null | now < deadline | 可预测（其他条件满足时） |
| scheduled | null | now >= deadline | 关闭并写 closed_at |
| scheduled | 非 null | 任意 | 不可预测 |
| postponed | null | 任意 | 不可预测（NOT_SCHEDULED）；且不因旧 deadline 自动写 closed_at |
| postponed | 非 null | 任意 | 不可预测；永不重开 |
| 其他非 scheduled | 任意 | 任意 | 不可预测 |

## 6.6 kickoff_at 可修改性

允许 Provider 自动修改 `kickoff_at` 的条件：

```text
period_anchor_at == null
AND match_status in ["scheduled", "postponed"]
```

一旦 `period_anchor_at != null`：

- `kickoff_at` 不允许 Provider 自动修改。
- 新值只记录为 Provider 冲突快照/异常。

## 6.7 period_anchor_at

用于：

- 周期归属。
- 月周期归属。
- 排行榜 `last_scoring_match_at`。

冻结规则：

- 首次进入 `live` 时，若为空：
  ```text
  period_anchor_at = kickoff_at
  ```
- 如果轮询错过 live，比赛直接进入 `finished`，若为空：
  ```text
  period_anchor_at = kickoff_at
  ```
- 一旦写入 immutable。

延期前未开赛：

- anchor 为空，因此最终按延期后的实际 kickoff 归属。

已经开赛后腰斩再恢复：

- anchor 不改变，仍属于首次实际开赛所在周期。

---

# 7. 周期规范

## 7.1 周

时区：

```text
Asia/Shanghai
```

周期：

```text
北京时间周一 00:00:00 inclusive
到下一周周一 00:00:00 exclusive
```

`period_key` 使用 ISO week-year，基于 `period_anchor_at` 转为北京时间后的日期计算：

```text
2026-W32
```

必须正确处理：

- 12 月末 / 1 月初。
- ISO week-year 与自然年不同的情况。

## 7.2 周期归属

只使用：

```text
period_anchor_at
```

禁止使用：

- 结算时间
- 原计划 round 日期
- settlement 创建时间
- 用户预测时间

---

# 8. 预测领域规范

## 8.1 输入

用户只能提交：

```json
{
  "idempotency_key": "uuid",
  "match_id": "uuid",
  "home_score": 2,
  "away_score": 1
}
```

不得接受用户提交：

- `user_id`
- `derived_result`
- `match_score`
- `wdl_hit`
- `exact_hit`
- `submitted_at`
- `scoring_rule_version`

## 8.2 比分校验

`home_score`、`away_score`：

- 必须为 JSON integer。
- 范围 `0..20`。
- 字符串 `"2"`、非整数 `2.5`、负数、null 均拒绝。
- JSON 数值 `2.0` 解析后若满足 `Number.isInteger(value)`，按整数 2 接受；不得依赖原始 JSON 文本格式区分 `2` 与 `2.0`。
- 超过 20 拒绝，返回 `VALIDATION_ERROR`。

Provider/管理员正式赛果范围为 `0..99`，与预测输入上限不同。

## 8.3 derived_result

唯一算法：

```text
home_score > away_score  => HOME
home_score == away_score => DRAW
home_score < away_score  => AWAY
```

枚举固定：

```text
HOME
DRAW
AWAY
```

## 8.4 can_submit_prediction

必须同时满足：

```text
user.status == active
match.match_status == scheduled
match.kickoff_confirmed == true
match.prediction_closed_at == null
match.prediction_deadline_at != null
server_now < match.prediction_deadline_at
existing_prediction == null
```

任一不满足即拒绝。

列表/详情的 `can_predict_reason`（第 25.1 节）与 `POST /v1/predictions` 错误码（第 26.1 节）必须同源，判定顺序固定如下（命中即停）：

| 优先级 | 条件 | `can_predict_reason` | POST HTTP | POST code |
|---|---|---|---|---|
| 1 | 无可信登录用户 | `AUTH_REQUIRED` | 401 | `UNAUTHORIZED` |
| 2 | 用户已注销 | `USER_DELETED` | 409 | `USER_DELETED` |
| 3 | 同 user+match 已有预测 | `ALREADY_SUBMITTED` | 409 | `PREDICTION_ALREADY_SUBMITTED` |
| 4 | `match_status != scheduled`（含 live/finished/postponed/cancelled/abandoned） | `NOT_SCHEDULED` | 409 | `MATCH_NOT_PREDICTABLE` |
| 5 | `kickoff_confirmed != true` 或 `prediction_deadline_at == null` | `KICKOFF_UNCONFIRMED` | 409 | `MATCH_NOT_PREDICTABLE` |
| 6 | `prediction_closed_at != null` 或 `server_now >= prediction_deadline_at` | `CLOSED` | 409 | `PREDICTION_LOCKED` |
| — | 以上皆否 | `null`（可预测） | 201/200 | 成功路径 |

说明：

- `CLOSED` 覆盖「已落表关闭」和「墙钟已过 deadline 但尚未写 closed_at」两种情况。
- `postponed` 一律 `NOT_SCHEDULED`，不得在 postponed 状态接受预测。
- 幂等重放（同 idempotency_key + 同 payload）仍按第 8.6 节返回首次结果，不走本表失败分支。

## 8.5 不可修改

成功创建后：

- 无 PATCH。
- 无 PUT。
- 无 DELETE。
- 即使仍在截止前也不能覆盖。
- 延期后也不能修改。

## 8.6 两层幂等

数据库唯一：

```text
UNIQUE(user_id, match_id)
UNIQUE(user_id, idempotency_key)
```

同 `idempotency_key` + 完全相同 payload：

- 返回第一次创建的 prediction。
- HTTP 200。
- 不产生第二条记录。

同 `idempotency_key` + payload 不同：

- HTTP 409。
- `IDEMPOTENCY_KEY_REUSED`。

不同 `idempotency_key` + 同 `user_id + match_id`：

- HTTP 409。
- `PREDICTION_ALREADY_SUBMITTED`。

两个并发请求：

- 数据库唯一索引为最终裁决。
- 最多一条成功创建。

## 8.7 scoring_rule_version

创建 match 时冻结：

```text
matches.scoring_rule_version = "scoring_v1"
```

创建 prediction 时复制：

```text
predictions.scoring_rule_version = matches.scoring_rule_version
```

同一场比赛不得存在不同计分版本的预测。

---

# 9. 最终比分与单场计分

## 9.1 最终比分口径

MVP 使用：

> 90 分钟常规比赛时间 + 上下半场伤停补时。

不包括：

- 加时
- 点球大战。

结算只读取：

```text
regular_home_score
regular_away_score
```

不得读取 live `goals` 字段作为最终比分。

## 9.2 单场计分 scoring_v1

```text
exact_score_correct => 12
else wdl_correct     => 3
else                 => 0
```

精确比分命中是总计 12 分，不是 3 + 12。

## 9.3 命中 invariant

始终必须满足：

```text
exact_hit == true => wdl_hit == true

match_score in [0, 3, 12]
```

## 9.4 取消比赛

`match_status = cancelled`：

- 不正式计分。
- 不计有效预测次数。
- 不计准确率。
- 不计排行榜。
- 已有 prediction 保留。
- prediction 当前结算字段保持 null。
- `settlement_status = voided`。

## 9.5 腰斩

`match_status = abandoned`：

- 不结算。
- `settlement_status` 保持 `pending`。
- 等待官方后续变为 `finished` 或 `cancelled`。
- 无正式有效赛果前不计任何统计。

---

# 10. 比赛状态机

## 10.1 match_status 枚举

```text
scheduled
live
finished
postponed
cancelled
abandoned
```

## 10.2 Provider 自动允许转移

```text
scheduled -> live
scheduled -> finished
scheduled -> postponed
scheduled -> cancelled
scheduled -> abandoned

postponed -> scheduled
postponed -> live
postponed -> finished
postponed -> cancelled
postponed -> abandoned

live -> finished
live -> abandoned

abandoned -> finished
abandoned -> cancelled
```

说明：

- `scheduled -> finished` 等跳转用于轮询期间错过中间状态的情况。
- 所有跳转仍必须满足 Provider 数据合法性。

## 10.3 Provider 禁止自动转移

包括但不限于：

```text
finished -> live
finished -> scheduled
finished -> postponed

cancelled -> scheduled
cancelled -> live
cancelled -> finished
```

遇到禁止转移：

1. 不覆盖内部状态。
2. 创建/更新 blocking anomaly。
3. 保存 Provider 快照。
4. 等待管理员处理。

## 10.4 Provider 状态相同

同状态重复同步为幂等 update：

- 不制造状态历史事件。
- 只有允许更新的 metadata 发生实际变化时才写 `updated_at`。

---

# 11. 结算状态机

## 11.1 match.settlement_status

固定枚举：

```text
pending
waiting
settling
settled
correcting
failed
voided
```

含义：

- `pending`：尚未达到正式结算条件。
- `waiting`：已确认 finished，处于保护时间或等待合法数据。
- `settling`：首次正式结算执行中。
- `settled`：最新已要求处理的赛果版本结算完成。
- `correcting`：已结算后正在应用新赛果版本。
- `failed`：结算执行失败，需要重试。
- `voided`：比赛无效，不结算。

## 11.2 合法转移

```text
pending -> waiting
pending -> voided

waiting -> settling
waiting -> voided

settling -> settled
settling -> failed
settling -> correcting

failed -> settling
failed -> correcting

settled -> correcting

correcting -> settled
correcting -> failed
```

禁止其他自动转移。状态机实现、编排层、管理员 retry 必须使用同一套合法转移表。

`settling -> correcting`：当某 settlement version `v` 完成 items 与必要聚合、写入 `matches.settled_result_version = v` 后，重新读取 `matches.result_version`：若 `result_version > v`，允许由 `settling` 直接进入 `correcting`（或已处于 correcting 则保持），随后按最小未处理 `result_version` 启动下一 correction settlement（与第 15.9 节对齐）。不得为了「绕开状态机」先把 match 标成 settled 再立刻 correcting，也不得省略 `settled_result_version = v` 的写入。

## 11.3 cancelled

比赛首次进入 cancelled 且尚未 settled：

```text
settlement_status -> voided
```

已经 `settled` 的比赛自动变为 cancelled 不属于 MVP 正常业务；必须形成 blocking anomaly，禁止自动作废历史积分。

---

# 12. result_version 与正式赛果历史

## 12.1 初始值

创建 match：

```text
result_version = 0
regular_home_score = null
regular_away_score = null
result_source = null
```

## 12.2 首次正式赛果

合法 `finished` + 合法 regular score：

```text
result_version = 1
```

同时创建 immutable `match_results` v1。

## 12.3 新版本

只有正式 regular score 真正变化时增加：

```text
old 2:1
new 1:1
=> result_version + 1
```

以下不增加：

- 重复拉到相同比分。
- 单纯 Provider 状态文本变化。
- 重复 finished。
- metadata 更新。

## 12.4 match_results 不可覆盖

每个版本必须永久保存：

```text
UNIQUE(match_id, result_version)
```

管理员连续修改：

```text
2:1 -> 1:1 -> 1:0
```

必须存在 v1、v2、v3 三条结果历史；禁止覆盖旧版本。

## 12.5 result_source

枚举：

```text
provider
admin
```

如果当前最新正式结果来自 `admin`：

- Provider 后续不同比分禁止覆盖。
- 不创建新正式 result_version。
- 保存冲突快照。
- 创建 `ADMIN_PROVIDER_RESULT_CONFLICT` anomaly。

管理员后续仍可再次修正，并产生新 result_version。

---

# 13. 首次 finished 与保护时间

## 13.1 finish_detected_at

首次合法检测：

```text
match_status -> finished
```

时写：

```text
finish_detected_at = server_now
```

一旦写入 immutable。

## 13.2 等待

首次 finished：

```text
settlement_status = waiting
```

正常首次结算最早开始：

```text
server_now >= finish_detected_at + 10 minutes
```

## 13.3 结算必要条件

必须同时满足：

```text
match_status == finished
settlement_status in [waiting, failed, settled]  // 视首次或修正而定
result_version >= 1
regular_home_score is integer in 0..99
regular_away_score is integer in 0..99
finish_detected_at != null
没有 open blocking anomaly
```

首次结算还必须满足 10 分钟保护时间。

赛果修正已经发生在 settled 之后时，无需再次等待完整 10 分钟；修正进入队列后可立即按顺序处理。

---

# 14. 结算账本

## 14.1 原则

禁止直接执行无账本的：

```text
career_points += X
```

所有积分与命中变化必须有：

```text
settlements
settlement_items
```

## 14.2 settlements

每个需要实际应用的 result_version 建立一个 settlement。

唯一：

```text
UNIQUE(match_id, result_version, rule_version)
```

状态：

```text
pending
running
settled
failed
```

phase：

```text
prepare
apply_items
rebuild_ranks
finalize
done
```

## 14.3 settlement_items

每个预测对应一个 item。

唯一：

```text
UNIQUE(settlement_id, prediction_id)
```

状态：

```text
pending
applied
failed
```

必须记录旧值、新值、delta。

## 14.4 首次结算

prediction 从未结算：

```text
old_score = 0
old_wdl_hit = false
old_exact_hit = false
valid_prediction_delta = +1
```

## 14.5 修正

prediction 已结算：

```text
old_* = prediction 当前已应用结果
new_* = 新 result_version 对应计算结果
score_delta = new_score - old_score
valid_prediction_delta = 0
```

例如：

```text
12 -> 3 => -9
3 -> 0 => -3
```

## 14.6 old 值来源

修正永远以 prediction 当前成功 applied 的结果为旧值。

不得每次都从 v1 重新计算 delta。

## 14.7 无预测比赛

即使 prediction 数量为 0：

- 仍创建 settlement。
- `settlement_items = 0`。
- 正常完成 `settled`。
- match 不得永久停在 waiting。

---

# 15. 结算并发、版本队列与部分失败恢复

## 15.1 同一 match

同一 match 同时最多运行一个 settlement。

锁 key：

```text
settlement:match:{match_id}
```

使用 lease，默认 10 分钟，可续租。

## 15.2 result_version 在 waiting 时变化

如果首次 settlement 尚未启动，保护时间内出现：

```text
v1 -> v2 -> v3
```

允许不为 v1/v2 创建业务 settlement。

保护期结束时：

- 首次 settlement 直接使用最新 v3。
- match_results v1/v2/v3 仍永久保存。
- prediction old 值仍视为 0。

## 15.3 settlement 已启动后出现新 version

如果 v1 已进入 `running`，此时产生 v2/v3：

1. v1 按自己的 immutable match_result 完成。
2. v2、v3 按 result_version 升序排队。
3. 不得并发应用。
4. 不得直接从 v1 跳到 v3。
5. v2 完成后才能执行 v3。

## 15.4 部分失败

例如 1000 条 settlement_items：

- 前 487 条 applied。
- 第 488 条失败。
- settlement -> failed。
- 已 applied 的 487 条不得回滚成“未发生”。
- 重试时只处理 `pending/failed` item。
- `applied` item 永不重复应用。

## 15.5 item 级原子性

应用单个 item 时，涉及该用户的以下变化必须位于同一数据库事务或等价原子工作单元：

- prediction 当前结算结果。
- users career 聚合增量。
- user_season_stats 聚合增量。
- week ranking 用户聚合增量。
- level 当前值变化（等级写入仅发生于周评估 / 修正重评流程，见第 17.7、17.9 节；普通 item 应用不写等级）。
- 必要的 level_history（同上）。
- unlock 创建尝试。
- settlement_item -> applied。

事务失败：

- 以上变化不得部分提交。
- item 保持未 applied。
- 记录 `last_error`。

## 15.6 聚合并发

数值聚合使用事务中的当前值 + delta，不允许读旧快照后无条件覆盖。

正常首次结算：

```text
valid_predictions += 1
wdl_hits += new_wdl_hit ? 1 : 0
exact_hits += new_exact_hit ? 1 : 0
points += new_score
```

修正：

```text
valid_predictions += 0
wdl_hits += new_wdl_hit - old_wdl_hit
exact_hits += new_exact_hit - old_exact_hit
points += score_delta
```

## 15.7 last_scoring_match_at 修正

正常 settlement 新得分 > 0：

```text
last_scoring_match_at = max(existing, match.period_anchor_at)
```

修正时若：

- 被修正 match 原本是当前 `last_scoring_match_at`
- 且新得分变为 0

则必须查询该用户该周期所有已结算、当前 `match_score > 0` 的 predictions，重新计算最大 `period_anchor_at`；没有则 null。

不得保留失真的旧时间。

## 15.8 global rank 重算锁

全局 rank 按周期重算时使用：

```text
ranking:{period_type}:{period_key}
```

锁。

任何 settlement 完成全部 item 后：

- 重算受影响 week rank。
- 重算完成后才能进入 finalize。


## 15.9 settlement finalize

某 settlement version `v` 完成 items 与排行榜重算后：

```text
matches.settled_result_version = v
matches.settled_at = server_now
```

然后重新读取 `matches.result_version`：

### 若 `result_version == v`

```text
matches.settlement_status = settled
settlement.status = settled
settlement.phase = done
```

### 若 `result_version > v`

说明结算期间已经出现后续正式赛果：

```text
settlement.status = settled
settlement.phase = done
matches.settlement_status = correcting
```

随后按最小未处理 `result_version` 启动下一 correction settlement。

不得先把 match 标为 settled 再遗漏后续版本。

---

# 16. 生涯统计与赛季统计

## 16.1 career

`users` 保存当前 career cache：

- `career_points`
- `career_valid_predictions`
- `career_wdl_hits`（内部统计，第 16.3 节）
- `career_exact_hits`
- `career_last_scoring_match_at`（生涯榜并列键，语义同第 15.7 节，按生涯全量重新定义：取当前有效预测中 `match_score > 0` 的 `period_anchor_at` 最大值）
- `career_level` / `career_best_level` / `career_level_state`（等级缓存，第 17 节；取值域 1..6）

不得保存 career 浮点准确率或浮点收缩场均分 `s` 作为判断真相；`career_level_state` 内部快照字段（`last_eval_n` / `last_eval_score_sum` 等）均为整数，见第 21.1 节。

## 16.2 本赛季统计（等级赛季口径）

使用独立集合：

```text
user_season_stats
```

唯一：

```text
UNIQUE(user_id, level_season_id)
```

`level_season_id` 是平台统一的「等级赛季」口径（第 17.4 节），**不是**任一联赛自身的 `season_id`；预测跨越第 1.4 节六个联赛，只要 `matches.period_anchor_at` 落在同一等级赛季区间内，就归入同一条 `user_season_stats`，不按 `league_id` 拆分统计文档。

新等级赛季：

- 用户在该等级赛季第 1 场有效预测正式结算时创建新 `user_season_stats`，`points/valid_predictions/wdl_hits/exact_hits = 0`，`level = best_level = 1`。
- 不清空旧等级赛季 stats；`career_*` 永久累计，不受等级赛季边界影响。

历史等级赛季发生赛果修正：

- 更新该比赛所属等级赛季（按 `period_anchor_at` 判定）的 `user_season_stats`。
- 同时更新 career stats。
- 若该等级赛季已按第 17.8 节冻结：只更新 `points/valid_predictions/wdl_hits/exact_hits`，不改变该赛季的 `level/best_level`。

## 16.3 准确率（内部统计，不对外定级/排序）

事实：

```text
wdl_hits / valid_predictions
```

若 `valid_predictions = 0`：

```text
accuracy = null
```

准确率（career 与 season 两个维度）继续计算与保存，供运营分析使用，成本极低；**不得**用于等级判定、不得用于任何排行榜排序或入榜门槛、**不得**出现在任何对外 API 字段中（第 24、27、28、29 节）。等级判定改用收缩场均分 `s`（第 17 节）。

任何仍需比较准确率的内部/运营用途，比较必须使用整数交叉乘法，不得先四舍五入：

```text
A.wdl_hits * B.valid_predictions  vs  B.wdl_hits * A.valid_predictions
```

---

# 17. 等级规则

等级规则版本 `level_v3.0`。等级是可通过第 17.9 节 `replay_level` 以账本、评估时刻表、规则版本表为输入重建的缓存，不是独立事实；当前等级字段随时可被重建覆盖。

## 17.1 术语

| 术语 | 定义 |
|---|---|
| 有效预测 | 存在 `status=applied` 且 `valid_prediction_delta=1` 的 settlement_item 的 prediction（即已首次正式结算；取消/腰斩未结算的比赛不算，第 9.4/9.5 节） |
| 预测分 | 单场 `match_score ∈ {0,3,12}`（第 9.2 节，不变） |
| 生涯积分 | `career_points` = 当前有效预测分之和（第 18.1 节，不变） |
| 赛季积分 | 某等级赛季内有效预测的预测分之和（第 17.8 节） |
| 评估窗口 | 用于计算 `s` 的有效预测集合（第 17.5 节） |
| S / n | 窗口内预测分之和 / 窗口内有效预测数 |
| B 值 | 参与线比较值：career scope 取 `career_points`，season scope 取该等级赛季积分 |
| 预言指数 | `s` 的对外展示名，仅用于实力榜（第 19.3 节） |
| 周评估 | 每周一固定时刻 `as_of` 的等级评估 |
| 修正重评 | 赛果修正结算完成后对受影响用户的即时重评（第 17.7 节） |
| 等级赛季 | 平台统一的赛季口径，与各联赛自身赛季解耦（第 17.8 节） |

## 17.2 等级枚举与称号

| Lv | 称号 | 状态 |
|---|---|---|
| 1 | 青训新人 | 未评级（有效预测 < 20） |
| 2 | 潜力新星 | 已评级，地板级 |
| 3 | 崭露头角 | |
| 4 | 坐稳主力 | |
| 5 | 球队核心 | |
| 6 | 顶级球星 | 最高级 |

- 取值域：`int 1..6`（`LEVEL_MIN=1`，`LEVEL_MAX=6`）。所有等级字段（career / season / history）统一 1..6；不存在 7/8 历史值，不需要任何 1..8 → 1..6 映射。
- 称号是固定枚举，API 只返回 `level` 整数，称号由客户端按本表映射；规则版本变更称号即新规则版本。
- 「初出茅庐」「足坛巨星」「稳定主力」「中场核心」四个曾用名不再使用。
- 等级称号是本产品唯一的「称号」机制；第 1.3 节「独立成就/头衔系统」仍为 OUT_OF_SCOPE。

## 17.3 阈值表

数值以 ×100 整数存储：

| Lv | 升级线 `PROMOTE_X100` | 保级线 `HOLD_X100` | B 线 `B_POINTS` | 其它条件 |
|---|---|---|---|---|
| 1 | — | — | — | 有效预测 < 20 |
| 2 | — | 不降级 | — | 有效预测 ≥ 20 |
| 3 | 180 | 170 | 80 | |
| 4 | 195 | 185 | 170 | |
| 5 | 215 | 205 | 380 | |
| 6 | 235 | 225 | 630 | |

说明：

- 「参考场次」（50 / 90–100 / 170–200 / 270–300）仅供直觉参考，**不进入判定**，不写入配置。
- Lv2 的「有效预测 ≥ 20」：career scope 用 `career_valid_predictions`，season scope 用该赛季 `valid_predictions`（均为累计，不是窗口 `n`；因 Lv2 不降级，两者对结果等价，取累计更直观）。

### 数值合理性核验（设计说明，非判定条款）

期望意义下，真实场均 `μ` 的用户在窗口 `n` 时 `E[s] = (nμ + 68)/(n + 40)`。反解「期望刚好达线所需 μ」：

| 线 | n=50 | n=100 | n=200 | n=300（窗口满） |
|---|---|---|---|---|
| Lv3 升 1.80 | 1.88 | 1.84 | 1.82 | 1.813 |
| Lv4 升 1.95 | 2.15 | 2.05 | 2.00 | 1.983 |
| Lv5 升 2.15 | — | 2.33 | 2.24 | 2.210 |
| Lv6 升 2.35 | — | — | 2.48 | 2.437 |
| Lv3 保 1.70 | | | | 1.700 |
| Lv4 保 1.85 | | | | 1.870 |
| Lv5 保 2.05 | | | | 2.097 |
| Lv6 保 2.25 | | | | 2.323 |

结论（设计说明，不改变判定条款）：窗口上限 300 使先验权重永远 ≥ 40/340 ≈ 11.8%，先验不会被完全冲掉，因此 Lv6 期望意义下需要 `μ ≥ 2.437`——这与「Lv6 只属于很强/顶尖」的设计意图一致，予以保留。Lv3 保级线 1.70 恰等于先验：窗口清空（长期不活跃）时 `s=1.70`，Lv3 用户不会因不活跃掉回 Lv2，Lv4+ 会逐步衰减到 Lv3；此行为符合预期，予以接受。

## 17.4 有效预测、白名单与等级赛季前置

- 等级只统计「有效预测」（第 17.1 节）。开赛前锁定由第 8.4 节天然保证，无需再判。
- `LEVEL_ELIGIBLE_LEAGUES` = 产品支持的全部联赛（第 1.4 节六联赛，无友谊赛/杯赛）；配置与 `SUPPORTED_LEAGUES` 同源。
- 因白名单 = 全集且无友谊赛，**B 值直接取 `career_points`**（第 17.6.4 节）。未来若引入不计等级的赛事（杯赛、友谊赛），必须新规则版本并新增独立的等级积分口径。

## 17.5 评估窗口与收缩公式

### 17.5.1 评估窗口

对某 scope、某评估时刻 `as_of`：

1. 候选集 = 该用户满足以下全部条件的 prediction：
   - 存在 `valid_prediction_delta=1` 且 `applied_at < as_of` 的 applied item；
   - 对应 match 的 `league_id ∈ LEVEL_ELIGIBLE_LEAGUES`；
   - `match.period_anchor_at > as_of − 730 天`（24 个月定义为 730 天）；
   - season scope 另加：`level_season_of(match.period_anchor_at) == 该等级赛季`（第 17.8 节）。
2. 按 `period_anchor_at DESC, match_id ASC` 排序，取前 `min(300, 候选数)` 条为窗口。排序键用 `period_anchor_at`（与第 7.2 节「周期归属只用 anchor」一致），不用结算时间、不用提交时间。
3. 每条的得分 = 该 prediction 在 `applied_at < as_of` 的 applied item 中，`source_result_version` 最大者的 `new_score`（即截至 `as_of` 已生效的结果）。
4. `n` = 窗口条数；`S` = 窗口得分之和（整数，`0 ≤ S ≤ 12n`）。

### 17.5.2 收缩公式与整数判定

```text
s = (S + K·μ0) / (n + K)，K = 40，μ0 = 1.70  ⇒  s = (S + 68) / (n + 40)
```

配置以整数存储：`PRIOR_WEIGHT_K = 40`，`PRIOR_MEAN_X100 = 170`（伪分 `P0 = 68`）。

判定「`s ≥ T`」（`T` 为 ×100 整数阈值）：

```text
100 × (S + P0) >= T × (n + K)
```

- `n=0` 时 `s = 1.70`，公式无除零问题。
- 禁止先计算浮点 `s` 或显示值再比较；禁止持久化浮点 `s` 作为判断真相。
- 展示值（仅实力榜，第 19.3 节）：`s_display_x100 = floor(100 × (S + P0) / (n + K))`，输出字符串 `"x.yy"`。**向下取整**，保证「显示过线 ⇒ 真实过线」。

### 17.5.3 B 值

| scope | B 值 |
|---|---|
| career | `career_points`（`as_of` 时刻的账本值：`SUM(score_delta) where applied_at < as_of`） |
| season | 该等级赛季积分（同上，按第 17.8 节归属过滤） |

- **不设只增不减的独立计数器**。理由：B 永不导致降级，只挡升级；赛果修正使积分下降后，B 值如实下降只会让「下一次升级」晚一点，这是正确结果；另设 max 计数器会让用户凭「已被修正掉的分」升级，且多一个可漂移的缓存。
- B 值与装扮解锁读同一个 `career_points`，但两者判定独立：解锁永不回收（第 18.3 节），B 值随修正变动。

## 17.6 评估机制（状态机）

### 17.6.1 每个 scope 的等级状态

```text
level_state = {
  level          int 1..6
  best_level     int 1..6，只增不减
  below_count    int 0..1     # 连续低于保级线的周评估次数
  week_base      { level, below_count, as_of }   # 本周周评估「之前」的状态，供修正重评改判
  last_inputs    { as_of, n, S, b_points, rule_version }   # 最近一次评估输入快照
}
```

career scope 挂在 `users` 上（`career_level` / `career_best_level` / `career_level_state`）；season scope 挂在 `user_season_stats` 上（第 21.2 节）。

### 17.6.2 周评估时刻

- `as_of` = **每周一 10:00:00（Asia/Shanghai）** = 周一 02:00:00 UTC。
  - 理由：北京时间 10:00 留出约 3.5 小时供欧洲周日晚场（最晚约北京时间 04:00 开球）的完场与结算延迟、Provider 重试。
  - 周一晚的欧洲比赛（北京周二凌晨）自然落入下一周评估，无需特判。
- 评估任务最早在 `as_of + 10 分钟` 启动（`LEVEL_EVAL_START_DELAY_MINUTES = 10`），给 `as_of` 前已开始但未提交的 item 事务留出提交时间。
- 数据截止**只看** `settlement_items.applied_at < as_of`，与任务实际运行时间无关，因此任务延迟、重跑、中断续跑的结果都相同；**不需要**跳过 `settling/correcting` 用户（对单个用户，每场比赛只有一个 item，要么在截止前 applied，要么不在）。
- 任务使用 job lock `sync:weekly_level_eval`（第 32.7 节 lease 机制）；同一 `as_of` 对同一用户同一 scope 幂等：已存在该 `as_of` 的评估结果则跳过。

### 17.6.3 评估对象

- career：`status=active` 且 `career_valid_predictions ≥ 1` 的用户（Lv1 用户也要评估，以便达到 20 场时升 Lv2）。
- season：当前等级赛季存在 `user_season_stats` 且用户 active。
- 已注销用户（`status=deleted`）：不再评估，等级冻结在注销时刻（第 4.5 节保留历史）。
- 实现可跳过「输入与上次完全相同且 `below_count=0` 且无 24 个月过期条目」的用户，前提是结果与完整评估一致。

### 17.6.4 单次评估算法（`evaluate_level`，纯函数）

```text
evaluate_level(state, inputs, rule_version, as_of) -> new_state
  L  = state.level
  bc = state.below_count
  protected = as_of < cfg.PROTECTION_END_AS_OF

  # 1) 未评级
  if L == 1:
      if valid_total >= 20: return level=2, below_count=0
      else:                 return 不变

  # 2) 升级判定（一次最多一级）
  if L < 6
     and 100*(S+P0) >= PROMOTE_X100[L+1] * (n+K)
     and B >= B_POINTS[L+1]:
      return level=L+1, below_count=0

  # 3) 保级判定（Lv2 无保级线）
  if L >= 3 and 100*(S+P0) < HOLD_X100[L] * (n+K):
      if protected:           return level=L, below_count=0      # 保护期不累计
      if bc + 1 >= 2:         return level=L-1, below_count=0    # 连续第 2 次 ⇒ 降一级
      else:                   return level=L,   below_count=1
  else:
      return level=L, below_count=0                               # 回到保级线以上即清零

  # 4) 总是：best_level = max(best_level, new level)
```

规则要点：

1. 一次评估最多升一级，最多降一级；升级优先判定（升级线必高于保级线，二者不会同时成立）。
2. 升级需 A（`s` 过 L+1 升级线）与 B（B 值过 L+1 的 B 线）**同时**满足；只满足其一则不升，且只要 `s ≥ 当前保级线` 就清零降级计数。
3. 降级只看 A：连续 **2** 个周评估 `s` 低于**当前等级**保级线 ⇒ 降一级并清零。降级后下一周按新等级的保级线重新计数（可能继续下降，但每周最多一级）。
4. B 值下降永不导致降级。
5. Lv1、Lv2 不降级；Lv2 是已评级用户的地板（除管理员 rebuild 回放纠错外，已评级用户永不回到 Lv1）。
6. 保护期：`PROTECTION_END_AS_OF` = 首次周评估 `as_of` 起第 **13** 个周评估之后（即前 13 次周评估不降级、不累计降级计数）。全局一个时间点，不按用户分别计算（目的是给产品留调阈值的窗口，不是新手保护）。
7. 修正重评（第 17.7 节）使用同一纯函数。

## 17.7 赛果修正：「改判本周结论」（supersede）

赛果修正结算完成后，若视为一次额外评估，会破坏「每周只升一级」和「连续 2 个周期」语义。因此采用**改判模型**：

1. 触发：某 correction settlement 进入 `phase=done` 后，对其中 `score_delta ≠ 0` 的 applied item 所属用户，生成修正重评任务，`as_of = settlements.settled_at`。
   - career scope：必重评。
   - season scope：仅当该比赛所属等级赛季 = 当前等级赛季时重评；已冻结赛季的赛季等级冻结（第 17.8 节）。
2. 计算：以 `week_base`（本周周评估之前的状态）为起点，用 `as_of` 时刻的最新输入重跑 `evaluate_level`，结果**替换**本周周评估的结论。`week_base` 不变。
3. 效果：
   - 周一因错误赛果升了级、周三修正后不再满足 ⇒ 撤回到 `week_base.level`（这不是「降级」，是纠错）；
   - 修正后满足升级条件 ⇒ 立即升一级（相对 `week_base`，本周仍最多 +1）；
   - 降级计数同理按改判结果重算，不会因修正额外 +1。
4. 保护期内：改判结果不得低于 `week_base.level`（保护期 `evaluate_level` 本身不产生降级，故天然满足）。
5. 若本周该用户尚无周评估（例如本周一时仍 < 20 场），则以当前状态为 `week_base` 执行。
6. 并发：同一用户同一 scope 的周评估与修正重评按 `as_of` 顺序串行；周评估任务未完成前产生的修正重评任务延后到周评估完成后执行。
7. 仅首次结算（非修正）**不**触发即时评估，等下周一。

## 17.8 等级赛季与冻结

### 17.8.1 等级赛季定义

多联赛后，五大联赛为跨年赛季（8 月–次年 5 月），中超为自然年赛季（约 3–11 月），无法共用一个联赛 `season_id` 作为「本赛季」，因此定义独立于联赛赛季的**等级赛季**：

- `level_season_id`，形如 `"2026_2027"`，区间为**北京时间 7 月 1 日 00:00:00（含）至次年 7 月 1 日 00:00:00（不含）**。
- 比赛归属：`level_season_of(match.period_anchor_at)`（北京时间日期判定）；**不看**联赛自身的 `season_id`。
- 例：中超某赛季 3–6 月的比赛归上一等级赛季，7–11 月的比赛归下一等级赛季。
- `user_season_stats.level_season_id` 是等级赛季标识，不是任一联赛的 `season_id`（第 16.2 节）。
- 首个等级赛季：`2026_2027`（平台上线即落入该赛季）。

### 17.8.2 生涯等级（career）

- 窗口：第 17.5.1 节，不限赛季，300 场 / 730 天。
- B 值：`career_points`，永久累计。
- 这是「对外主等级」：资料页、公开主页、榜单行内等级徽标均用生涯等级。

### 17.8.3 本赛季等级（season）

- 算法与生涯**完全相同**，仅数据范围限定为当前等级赛季：窗口 = 本赛季内最近 ≤300 场有效预测（730 天约束在单赛季内不起作用）；B 值 = 本赛季积分；Lv2 条件 = 本赛季有效预测 ≥ 20。
- 新赛季：用户在新赛季第 1 场有效预测正式结算时创建 `user_season_stats`，`level = best_level = 1`；**不写** `level_history`（`from == to`）。
- 用途：分享卡「本赛季等级」、等级页「本赛季」块。

### 17.8.4 赛季收官与冻结

- 赛季结束后的第一次周评估（`as_of` 在赛季结束之后）是该赛季的**最终评估**：窗口仅含归属该赛季且 `applied_at < as_of` 的预测。此后该赛季等级冻结（`is_level_frozen = true`），不再周评估、不再修正重评。
- 冻结后发生的历史赛果修正：照常更新该赛季的积分/命中统计，**不改**该赛季的 `level/best_level`。理由：赛季已结束，不存在「本周结论」可改判；与排行榜「`is_final` 后仍可改 rank」不同，等级是阶段性称号，冻结更符合用户预期。
- career 等级不受赛季边界影响。

### 17.8.5 先验 μ0 的赛季口径

- 先验每赛季固定一次：`μ0` 属于规则版本配置，只允许在等级赛季边界随新规则子版本变更（`level_v3.x`），生效于新版本的首次周评估；career 与 season scope 同时使用评估时生效版本的 `μ0`。
- `level_v3.0`：`μ0 = 1.70`，`K = 40`（先冻结，不等回测）。

## 17.9 确定性、重建与审计

### 17.9.1 为什么必须处理

评估算法是**路径依赖**的（一次一级、连续两周、保护期），当前等级不再是「当前账本的纯函数」。若不处理，「等级是可重建缓存」（第 0.5 节）与第 35 节 rebuild、第 34 节 daily consistency 全部失效。

### 17.9.2 回放定义（`replay_level`）

等级轨迹是以下输入的纯函数：

```text
replay_level(user, scope) = fold(evaluate_level, 初始状态 level=1,
        按 as_of 升序的事件序列：
          - 所有周评估时刻（首次周评估起的每个周一 10:00）
          - 所有影响该用户的 correction settlement 的 settled_at（修正重评）
        每个事件的输入 = 账本在该 as_of 的截面（applied_at < as_of）
        每个事件的规则 = 该 as_of 时生效的 level_rule_version 配置)
```

依赖的事实全部不可变：`settlement_items.applied_at`、`settlements.settled_at`、`matches.period_anchor_at`、规则版本生效表（配置，带生效 `as_of`，只追加）。因此当前等级字段是可通过 `replay_level` 重建的缓存（第 0.5 节）。

### 17.9.3 rebuild 中的等级部分（与第 35.1 节共同构成 `rebuild_user_stats`）

1. 积分/命中统计按第 35.1 节从 applied ledger 重建（不变）。
2. career 与各未冻结赛季的等级状态按第 17.9.2 节回放；已冻结赛季同样回放到其最终评估为止。
3. 回放结果与缓存不同 ⇒ 覆盖缓存，并写一条 `level_history(reason=rebuild)`（允许跨多级，这是纠错）。
4. `best_level = max(现有 best_level, level_history.to_level 历史最大值, 回放轨迹最大值)`，普通 rebuild 不下降。
5. 管理员审计摘要（第 21.14/30.5 节 `rebuild_user_stats`）字段保持 `career_level`、`career_best_level`（取值域 1..6），新增 `level_state_changed: bool`。

### 17.9.4 daily consistency 中的等级部分（第 34 节）

每日校验：

1. `last_inputs`（n、S、B）与账本在 `last_inputs.as_of` 截面的重算值一致；
2. `level/below_count` 与 `evaluate_level(week_base 或上一状态, last_inputs)` 一致；
3. `best_level ≥ level`，且 `best_level ≥ level_history.to_level 最大值`；
4. 可选每周一次对抽样用户做完整 `replay_level` 比对。

发现差异只报警，不自动修复。周中「缓存等级 ≠ 按当前账本即时计算的结果」**不是**差异。

### 17.9.5 level_history

- 仅当 `from_level ≠ to_level` 时写；`below_count` 变化不写 history（它可由回放得出）。
- `reason` 封闭枚举：`weekly_eval` | `correction_reeval` | `rebuild`。不新增「规则版本切换」类 reason。
- 修正重评撤回本周升级时，写一条 `correction_reeval`（`from=改判前、to=改判后`），**不删除、不改写**原 `weekly_eval` 行（第 0.6 节）。
- 字段见第 21.13 节。

## 17.10 边界与异常情形

| 情形 | 结果 |
|---|---|
| 有效预测 15 场全中 | Lv1（未评级） |
| 第 20 场有效预测在周一 10:05 applied | 本周不计入，下周一升 Lv2 |
| 一周内 20→60 场且 s 很高 | 本周最多 Lv1→Lv2，之后每周最多 +1 |
| s 在保级线与升级线之间 | 等级不变，降级计数清零 |
| s 低于保级线 1 次后回升 | 计数清零 |
| 连续 2 周低于保级线，第 2 周恰为保护期最后一周 | 保护期内不累计，保护期后需再连续 2 周 |
| 用户长期不预测 | 每周仍评估；24 个月过期导致窗口缩小，s 向 1.70 回归；Lv4+ 逐周衰减至 Lv3 为止 |
| 比赛取消 / 腰斩未结算 | 不进窗口、不计 B（无 applied item） |
| 腰斩后恢复并完场 | 按正常首次结算进入，anchor 仍为首次开赛（第 6.7 节） |
| 修正使 B 值跌破当前级 B 线 | 不降级；只影响下次升级 |
| 周评估任务失败/中断 | 重跑；同 `as_of` 幂等；结果与首次一致 |
| 规则版本在两次评估之间切换 | 下一次评估起按新版本；已产生的结论不回溯 |
| 用户注销 | 停止评估，等级冻结，不出现在当前榜单（第 19.7 节） |

## 17.11 与既有机制的关系

| 机制 | 关系与结论 |
|---|---|
| 计分 `scoring_v1`（0/3/12） | 不变。`s` 的「场均分 = 3w + 9e」基于此。 |
| 生涯积分 `career_points` | 不变。同时作为 career B 值与解锁依据。 |
| 装扮解锁 30/100/200 | 不变（第 18 节）。与等级无任何耦合；不因降级、B 值下降而回收。 |
| 称号 | 仅等级称号（第 17.2 节）。「前顶级球星」本期不做独立字段，实现为**派生值** `is_former_top = (career_best_level == 6 AND career_level < 6)`，仅 `GET /v1/profile/me`、`GET /v1/levels/me` 返回，公开接口永不返回；无需存储，rebuild 天然保留（`best` 只增），注销后私有接口不可访问即自然不可见。 |
| 准确率 | `career_wdl_hits` / `wdl_hits` 继续维护（第 40 节 invariant 保留，成本极低，供运营分析）；**所有 API 删除** `*_wdl_accuracy_percent`；定级、排序均不使用。 |
| 精确命中数 | 继续维护；作为榜单第 2 排序键对外展示（第 19.5 节）。 |
| 分享卡 | `season_level` = 当前等级赛季的 `user_season_stats.level`（读缓存，**禁止现场计算**）；多联赛后 round 统计需增加 `league_id` 参数（第 20 节）。 |
| 周期聚合（rankings） | 只保留 `week`；另加生涯/实力快照（第 19 节）。 |

## 17.12 强弱与挑场监控（不入判定）

以下监控指标只供运营分析与后续人工评审，**不参与**任何等级判定、不出现在任何用户可见字段中：

- **挑联赛监控**：按周计算各联赛平均场均分（`avg(3w+9e)`，基于该周全部已结算预测）。若任两联赛平均场均分差 ≥ `0.20` 且持续 `8` 周，触发人工「分联赛先验评估」评审；评审结论若需要调整，只能以新规则子版本（`level_v3.x`）生效，不自动改变当前判定。
- **强弱监控**：比赛强弱一律使用平台自算的球队 Elo（初值 `1500`，`K=20`，只用 `match_results` 已结算 regular score 计算增量），**不得**引入任何赔率/盘口数据源（第 1.1 节永久禁止）。按用户统计「所选比赛赛前 Elo 差绝对值均值」与「当周覆盖率 = 预测场数 / 可预测场数」分布，供识别挑场行为；不构成阻断规则，不写入 `anomalies`。

## 17.13 上线前验证与发布门禁

先验 `μ0 = 1.70` 先冻结生效（不等待回测），但设置发布门禁：上线前，须用近 3 个赛季六个联赛历史赛果，对「永远主队 1-0」「永远 1-1」「永远热门比分 2-1」三种固定模板策略做逐周滚动回测（每周按该周之前全部历史结果滚动评估，不是单点计算）。

若任一模板在窗口满（`n=300`）时的 `s` **达到或超过 Lv5 保级线 `2.05`**：

1. 计算 `Δ = ceil05(模板最高 s − 2.05) + 0.05`（`ceil05` = 向上取整到 0.05 的整数倍）；
2. 全部升级线与保级线（第 17.3 节表）整体上调 `Δ`；
3. 同时按回测中「模板中位策略」的场均重估 `μ0`；
4. 以上调整作为 `level_v3.1`，在首次周评估前生效（结构不变，仅数值随门禁结果调整）。

若三种模板回测均低于 `2.05`，`level_v3.0` 数值原样生效，无需 `level_v3.1`。该回测结果与是否触发 `level_v3.1` 必须在上线前有明确记录，验收见第 44 节 L-24。

---

# 18. 生涯积分与装扮解锁

## 18.1 生涯积分

```text
career_points = 所有当前有效 prediction.match_score 之和
```

规则：

- 不消费。
- 不转移。
- 不兑换。
- 不主动扣除。
- 仅赛果修正可以造成负 delta。

## 18.2 MVP 解锁

> MVP v1 前端不展示装扮：解锁记录仍按本节与第 18.3 节在后端创建、保存和保留，但前端第一版不渲染任何装扮内容。
>
> - 后端行为不变：本节 30 / 100 / 200 三档 unlock 仍按第 18.3 节在 `career_points >= threshold` 时创建并持久化；已解锁不因赛果修正回收；`unlock_v1` 配置版本不变。
> - MVP v1 前端不展示任何装扮内容：不出现装扮清单、解锁进度、下一解锁提示、装扮预览图、装扮入口，以及「查看全部装扮」类跳转。
> - `GET /v1/unlocks/me` 合同不变（第 28.2 节）：接口继续按原样返回 `default_resources` 与 `unlocked`；v1 前端不消费该接口，不改变其字段、错误码或 `SPEC_GAP` 边界。
> - 理由：装扮的展示名称、图标、资源 URL 等 UI 元数据未由本规范冻结（第 28.2 节 `SPEC_GAP`）。MVP v1 不引入未冻结的展示层内容，编码 Agent 不得自行命名装扮或选用装扮图片。
> - 不改变的部分：第 18.1 节生涯积分仍计算并保存；第 47 节「解锁：30 / 100 / 200，已解锁不回收」不变；第 40 节 invariant（已解锁不因积分下降删除）与第 44 节 76、126 两项验收（correction 后已解锁装扮不回收；unlock 不因普通 rebuild 删除）不变。
> - 第 1.2 节第 31 项「30 / 100 / 200 三档 MVP 解锁」仍要求后端解锁能力实现并通过验收，不表示 MVP v1 前端必须展示装扮。
> - 装扮的前端展示延后到后续版本；恢复展示前，必须先冻结对应的展示名称、图标与资源来源，并升级本规范版本。

默认资源不写 unlock 记录：

```text
0 => 默认头像框、资料卡、分享卡
```

实际 unlock：

```text
30  => profile_card_style_1
100 => favorite_team_name_accent
200 => favorite_team_avatar_frame_1
```

## 18.3 解锁规则

首次满足：

```text
career_points >= threshold
```

创建 unlock。

唯一：

```text
UNIQUE(user_id, unlock_code)
```

已解锁：

- 永不因赛果修正回收。
- 重复结算不得重复创建。

## 18.4 配置阈值变化

未来：

- 阈值降低：可批量补发新符合用户。
- 阈值提高：已解锁用户保留；未解锁用户按新阈值。
- 配置必须带版本。
- MVP 使用 `unlock_v1`。

---

# 19. 排行榜规范

## 19.1 榜单总表

| 榜 | `board` | 排序主键 | 入榜门槛 | 周期 | 更新方式 | 默认 |
|---|---|---|---|---|---|---|
| 本周榜 | `week` | 本周预测分 | 本周 ≥ 1 场有效预测（`WEEK_BOARD_MIN_VALID=1`） | ISO 周（北京时间，第 7.1 节，按 anchor 归属） | 每场结算后增量重排（第 34 节） | ✅ |
| 生涯榜 | `career` | `career_points` | `career_valid_predictions ≥ 1` | 无 | 快照，每 `CAREER_BOARD_SNAPSHOT_MINUTES=60` 分钟一次 | |
| 实力榜 | `strength` | `s`（预言指数） | 窗口 `n ≥ STRENGTH_BOARD_MIN_WINDOW_N=50` | 无 | 快照，每次周评估任务完成后 + 每日 1 次（吸收修正重评） | |
| 赛季榜 | `season` | 当前等级赛季 `user_season_stats.points` | 当前等级赛季 `valid_predictions ≥ 1`（`SEASON_BOARD_MIN_VALID=1`）；**可见资格**另见第 19.9 节 | 当前等级赛季（第 17.8 节） | 快照，每 `SEASON_BOARD_SNAPSHOT_MINUTES=60` 分钟一次 | |

- `board` 封闭枚举 `week` / `career` / `strength` / `season`；**取消月榜**（原 `period_type=month`），非法 `board` 或 `period_type` 返回 `422 VALIDATION_ERROR`。
- 历史周榜保留：`week` 支持 `period_key` 查询历史周，历史周 `is_final` 与修正规则见第 19.6 节。
- 本周榜门槛由 3 场降为 1 场：排序主键是**总分**而非比率，不存在小样本虚高问题。
- 准确率在所有榜单中**退出排序与展示**（第 16.3 节）。

## 19.2 数据来源与聚合创建门槛

- `week` 榜：用户第 1 场有效 prediction 正式结算后即创建 `rankings` 文档（`period_type` 固定为 `week`）；`valid_predictions = 1` 时仍保存统计，`global_rank` 按第 19.5 节排序结果给出（不再要求 ≥3 场才有 rank）。
- `career` 榜：数据源为 `users` 表当前 `career_points` / `career_exact_hits` / `career_valid_predictions` / `career_last_scoring_match_at`；按 `CAREER_BOARD_SNAPSHOT_MINUTES` 周期生成快照写入 `board_snapshots`（第 21.20 节）。
- `strength` 榜：数据源为等级评估缓存 `last_eval_n` / `last_eval_score_sum`（第 17.6.1 节 `last_inputs`）；快照预聚合满足第 42.1 节性能要求，不得实时全量扫描 predictions。
- `season` 榜：数据源为当前等级赛季的 `user_season_stats`（`points` / `exact_hits` / `valid_predictions` / `last_scoring_match_at`，第 21.2 节）；按 `SEASON_BOARD_SNAPSHOT_MINUTES` 周期生成快照写入 `board_snapshots`（第 21.20 节），规则见第 19.9 节。

## 19.3 展示口径

- 列表：只提供前 **20** 名（`RANKING_TOP_LIMIT=20`）；分页每次 **10** 条（`RANKING_PAGE_SIZE=10`，第 1 页 1–10，第 2 页 11–20，无第 3 页）。
- 行字段：名次、`user_id`、展示名、`favorite_team_id`、生涯等级、主排序值；本周/生涯/赛季榜另给有效预测数（只展示）、`exact_hits`；实力榜给 `strength_index`（`"x.yy"`，第 17.5.2 节向下取整）与窗口 `n`。
- 「我的名次」（固定底部，MVP 提供全局排名，不再是「不提供」）：

| 状态 `me.status` | 条件 | 展示字段 |
|---|---|---|
| `ranked` | 已入榜 | 名次 `r ≤ 20` ⇒ `rank=r`；`r > 20` ⇒ `rank=null`，`top_percent = clamp(ceil(100·r/N), 1, 99)`，`N` = 该榜（该范围）入榜总人数 |
| `not_participated` | 本周/生涯/当前赛季无有效预测 | 无 |
| `below_threshold` | 仅实力榜，窗口 `n < 50` | `remaining_valid_predictions = 50 − n` |
| `not_eligible` | 仅赛季榜，请求者参与的等级赛季数 `< SEASON_BOARD_MIN_SEASONS=2`（第 19.9 节） | `seasons_participated` |

`top_percent` 用整数：`(100·r + N − 1) div N`，再 `clamp` 到 `[1, 99]`（`RANKING_TOP_PERCENT_CLAMP`）；永不显示绝对末位、永不出现「垫底」。绝对名次展示上限为 20（`RANKING_ABSOLUTE_RANK_MAX`）。

- 顶部「更新时间」`updated_at`：本周榜 = 该周期最近一次重排完成时刻；生涯榜/实力榜/赛季榜 = 快照时刻。
- 未开赛（未结算）的预测不影响任何榜（天然成立：榜单只读 applied 账本）；公开主页不得返回他人**未过截止时间**比赛的预测内容（防抄作业）。
- 点击行进入对方公开主页，字段见第 24.5 节。

## 19.4 范围与群机制

### 19.4.1 全站 / 我的群

- `scope=global`：全体 active 用户。
- `scope=group&group_id=…`：仅该群成员，排序规则与全站相同，名次在群内独立计算；群榜不单独持久化，基于全站榜数据按成员过滤后排序。

### 19.4.2 群规则

- 群是**平台自建群**，不依赖微信好友关系链；由用户创建，产生 8 位邀请码（字符集 `GROUP_INVITE_CODE_ALPHABET` = `A–Z` 与 `2–9`，去除 `O/I/0/1`），可通过「分享到群」携带邀请码加入。
- 每群成员上限 `GROUP_MAX_MEMBERS=500`；每用户最多加入 `USER_MAX_GROUPS_JOINED=20` 个群、最多创建 `USER_MAX_GROUPS_OWNED=5` 个群。
- 群名不开放自由文本（避免内容安全审核面），显示为「{群主昵称}的预言群」；群主注销后群名显示「已注销用户的预言群」，群继续存在。
- 成员可随时退出；群主不可退出，只可解散（软删除，`status=dissolved`，第 0.6 节精神）。
- 加入/退出立即影响群榜；群榜不单独持久化，基于全站榜数据按成员过滤后排序。
- 邀请码生成必须原子校验唯一（`UNIQUE(invite_code)`），冲突时重新生成，不得使用「先查再插」作为唯一并发保护（同第 4.2 节精神）。
- 集合：`groups`、`group_members`（第 21.21/21.22 节）。
- 群管理 API 见第 27.2 节。

## 19.5 排序与并列（`compare_ranking_entry`）

本周榜 / 生涯榜 / 赛季榜（同一比较器，字段取对应周期/生涯/当前等级赛季值）：

1. 分数 DESC
2. `exact_hits` DESC
3. 有效预测数 **ASC**（同分同精确时，用更少场次拿到同样分数者优先，奖励效率、抑制刷量）
4. `last_scoring_match_at ASC`（非 null 优先于 null）
5. `user_id ASC`

实力榜：

1. `s` DESC（交叉乘法：`(S_a+P0)(n_b+K)` vs `(S_b+P0)(n_a+K)`，禁止比较浮点缓存）
2. 窗口 `n` DESC（样本更多者优先）
3. `user_id ASC`

说明：

- 「先达到该分的时间」定义为 `last_scoring_match_at`（最后一次得分比赛的 `period_anchor_at`），即累计分达到当前值的时刻；修正时重算规则沿用第 15.7 节。生涯榜使用 `users.career_last_scoring_match_at`（第 21.1 节），赛季榜使用 `user_season_stats.last_scoring_match_at`（第 21.2 节）。
- 若用户本周期/生涯 `分数 = 0`，则 `last_scoring_match_at = null`；排序时非 null 优先于 null，两者都 null 时继续 `user_id ASC`。
- 符合最低场次的用户按完整排序得到 `1, 2, 3, ...`；由于最后有 `user_id` 稳定裁决，不存在相同 rank。不符合最低场次：`global_rank = null`（仅 `week` 榜适用此字段；`career`/`strength`/`season` 榜的名次来自快照排序，不落库 `global_rank` 字段本身，行为等价）。

## 19.6 is_final（仅 `week` 榜）

周期边界结束后：

```text
is_final = true
```

语义：该周期已结束，不再接收新的正常比赛归属。但历史赛果修正仍允许修改历史聚合、重算历史 `global_rank`，`is_final` 保持 `true`。`career` / `strength` / `season` 榜是滚动快照，没有 `is_final` 概念。

## 19.7 其它

- 已注销用户：不进入本周榜/生涯榜/实力榜/赛季榜的当前排序（重排与快照时过滤）；已 `is_final` 的历史周榜保持原样、显示「已注销用户」（第 4.5 节 / 第 44 节 M 组）。
- 性能：生涯榜、实力榜、赛季榜 Top20 与「我的名次」必须来自快照或索引计数，不得实时全量扫描 predictions（第 42.1 节）。

## 19.8 空状态与进度文案

- 允许显示「再完成 X 场有效预测即可进入实力榜」，`X = max(0, 50 − 窗口 n)`。
- 等级页 Lv1 允许显示「再完成 X 场有效预测获得评级」，`X = max(0, 20 − 有效预测数)`。
- **禁止**任何基于分数差的进度（「差 0.05 分」「再拿 X 分升级」「距离下一级 X%」）。
- 理由：场次门槛是确定的整数条件，不暴露 `s`；分差进度会诱导刷分、暴露噪声，一律禁止。

## 19.9 赛季榜（`board=season`）

**定位**：当前**等级赛季**（平台统一口径，`LEVEL_SEASON_BOUNDARY=07-01 00:00 Asia/Shanghai`，第 17.8 节）内的累计积分榜。首个等级赛季内，赛季榜与生涯榜的数据完全相同，没有独立信息量，因此只对「参与过多个等级赛季」的用户开放。

- **榜单口径**：排序主键为当前等级赛季 `user_season_stats.points`；入榜门槛为当前等级赛季 `valid_predictions ≥ SEASON_BOARD_MIN_VALID(=1)`；比较器同本周榜/生涯榜（第 19.5 节），`last_scoring_match_at` 取 `user_season_stats.last_scoring_match_at`。
- **榜单收录所有人**：榜单本身收录**全体**满足入榜门槛的用户，**不**因其可见资格过滤；名次与 `top_percent` 的总人数 `N` 为该榜（该范围）全部入榜人数。
- **可见资格**：`seasons_participated(user) = count(user_season_stats where user_id = U and valid_predictions ≥ 1)`（含当前等级赛季）。`seasons_participated ≥ SEASON_BOARD_MIN_SEASONS(=2)` 才对该用户可见（客户端展示「赛季榜」入口与「我的名次」）；首个等级赛季的用户（`< 2`）不展示入口、不返回名次。
- 跨赛季边界：新等级赛季开始后，用户在新赛季**首场有效预测结算**前不在赛季榜中；仅在上一赛季参与过的用户，`seasons_participated` 在其新赛季第 1 场有效预测结算后才从 1 变为 2。
- 本节所述的赛季榜只展示**当前**等级赛季；已结束赛季的最终榜见第 19.11 节（赛季终榜）。当前赛季快照的保留策略同第 37 节。
- **API 行为**（第 27.1 节）：`board=season` 的列表本身不因请求者资格返回 403；是否展示入口由响应的 `available_boards` 决定（第 19.10.8 节）；资格不足者的 `me.status = not_eligible`。排行榜接口需登录（第 19.10.9 节），不存在游客。
- 群范围：沿用第 19.4 节，按成员过滤全站赛季榜后在群内独立排名；群内「是否展示」同样取决于请求者自己的可见资格。
- 快照：`board_snapshots(board=season, level_season_id)`，job `board_snapshot_season`（第 32.13 节）；重建见第 35.4 节。

## 19.10 低流量与冷启动展示

适用于用户很少、新周开始、休赛期、国际比赛日等场景。**展示由数据决定，不由星期几决定；不虚构用户（不放机器人、官方账号、假头像）。**

常量：

```text
RANKING_THIN_BOARD_THRESHOLD     = 20           # 入榜人数 < 20 视为少人榜
RANKING_WEEK_WINDOW              = 4            # 周榜可选 / 可回溯的周数（含本周）
RANKING_FIRST_PERIOD_KEY         = 上线所在周的 period_key   # 上线时登记，只追加；更早的周不可选
```

### 19.10.1 入榜人数分档

`entry_count`：该 board、该范围（全站或群）的全部入榜人数，与列表过滤口径一致（已注销用户已排除）。

| `entry_count` | 展示 |
|---|---|
| 0 | 空状态：「第一场预测结算后，你就是第一名」+「去预测」入口；不显示领奖台 |
| 1–2 | 不显示领奖台；第 1 名放大展示，其余按列表；标题「全部 N 位预言家」 |
| 3–19 | 显示领奖台；标题「全部 N 位预言家」（不写「前 20」） |
| ≥ 20 | 现有展示（「前 20」、`top_percent` 规则不变） |

- `scope=global` 且 `entry_count < 20`，或 `scope=group` 且 `entry_count ≤ 1` 时，榜单提供「邀请好友建群 / 邀请好友加入」入口。
- 概览卡的入榜人数使用真实 `entry_count`。

### 19.10.2 无群用户

无任何 active 群（含所有群已解散）的用户：范围入口里「我的群」显示为未解锁（「创建或加入群后解锁」），点击进入创建/加入引导，**不展示群选择、不发出 `scope=group` 请求**。判断依据为 `GET /v1/groups/me` 返回空。群内只有自己时可进入群榜，按 `entry_count=1` 展示。

### 19.10.3 周榜可选范围与默认显示哪一周

**可选范围**：`board=week` 只开放最近 `RANKING_WEEK_WINDOW=4` 周（本周 + 前 3 周），且不早于上线周 `RANKING_FIRST_PERIOD_KEY`。窗口之外或上线之前的 `period_key` 返回 `422 VALIDATION_ERROR`；界面的周选择器只列窗口内的周，**不让用户手动选到上线前的周**。更早的历史周榜数据仍保留在库中（第 19.6 节），只是不对外开放。

**默认周**（请求未带 `period_key` 时，服务端决定返回哪一周）：

1. 候选周：北京时间**周一** → 上一周；**周二至周日** → 本周。
2. 候选周在**所选范围**（全站或群）内 `entry_count = 0` → 在可选窗口内向前取最近一个有人入榜的周；窗口内仍无 → 返回候选周空榜。
3. 带显式 `period_key` 时不应用上述规则。

响应的 `period_key` 为实际返回的周；另返回 `current_period_key`（本周）。界面不显示「已封榜 / 结算中」措辞（`is_final` 与「全部结算完」不同步，第 19.6 节）。

### 19.10.4 更新时间

所有榜单显示「更新于」相对时间（用 `updated_at` 与服务端 `server_now` 做差，不使用客户端时钟）：`< 1 分钟` → 刚刚更新；`< 60 分钟` → N 分钟前更新；`< 24 小时` → N 小时前更新；否则 N 天前更新。

### 19.10.5 比赛页默认联赛

默认联赛为英超；**仅在英超休赛期默认中超**。休赛期定义（用比赛数据判定，国际比赛日**不**算休赛期）：英超在「过去 7 天」与「未来 21 天」内均无比赛。仅影响默认选中标签，用户可手动切换。

### 19.10.6 「我的 · 最近预测」回看范围

用户可在「我的」的最近预测中向前翻阅至少最近 **8 周**的预测与结果。数据来自第 26.2 节 `GET /v1/predictions/me`（该接口按 `submitted_at DESC` 分页，无时间上限）；产品不设 8 周硬上限，8 周是客户端必须保证可达的最低范围。

### 19.10.7 赛季个人回顾与首赛季提示

- 个人回顾卡：「上赛季你拿了 X 分，最高到 Lv N」，数据取该用户最近一个已结束且 `valid_predictions ≥ 1` 的等级赛季（`previous_season`，资料接口返回，无则 `null`）。
- 首赛季提示：登录用户 `seasons_participated < 2` 时，生涯榜顶部提示「你正在第一个赛季，生涯榜与赛季榜内容相同」。
- 赛季初提示：赛季榜在赛季开始后 4 周内提示「赛季刚开始，名次变化会比较大」。

### 19.10.8 榜单标签显隐（`available_boards`）

所有榜单响应都返回 `available_boards`（该请求者在所选范围下可见的榜单，固定顺序 `week, career, strength, season`）。**每个标签按各自的数据判断，没有可展示内容就不显示**：

| 榜 | 显示条件 |
|---|---|
| `week` | 始终显示（人数为 0 时走第 19.10.1 节空状态） |
| `career` | 所选范围内 `entry_count > 0` |
| `strength` | 请求者自己窗口 `n ≥ STRENGTH_BOARD_MIN_WINDOW_N`（满 50 场的人自己就在榜上，所以不会是空榜） |
| `season` | 请求者 `seasons_participated ≥ SEASON_BOARD_MIN_SEASONS`，**且**（当前赛季在所选范围内 `entry_count > 0`，**或** 范围为全站且存在可展示的上赛季榜，见第 19.10.10 节）。群范围没有终榜，所以群里当前赛季无人入榜时不显示 |

切换范围后，若当前所在标签不在新范围的 `available_boards` 中，客户端回到 `week`。

### 19.10.9 游客：排行榜需要登录

排行榜接口（第 27.1 节）为 **Auth required**。游客（未登录）进入榜单页：页面内容整体模糊成灰色条纹占位，居中一行「请登录查看榜单」；占位使用通用灰色条，**不出现任何用户名、头像或分数**（不虚构用户）；不请求榜单数据。登录后正常显示。已注销用户按第 49 节私有读规则返回 `409 USER_DELETED`。

### 19.10.10 新赛季交接：默认显示上赛季榜

新等级赛季开始后，赛季榜的默认赛季为：当前赛季在全站范围已有入榜者 → 当前赛季；否则 → **上赛季榜**，直到当前赛季的第一版快照中出现入榜者为止。

首个运营赛季且不存在任何上赛季数据时，未带 `level_season_id` 的请求仍返回 200 和当前赛季空列表，`entry_count = 0`、`is_provisional = false`，且 `available_boards` 不含 `season`。只有显式请求一个从无数据的赛季时才返回 404。

- 上赛季终榜已生成（第 19.11 节）→ 显示终榜。
- 终榜尚未生成（赛季结束后的第一个周一最终评估之前，最长约一周）→ 显示上赛季**最后一版常规快照**，响应带 `is_provisional = true`，界面标注「等待最终确认」；终榜生成后自动替换，名次与积分可能因赛季末晚结算而与临时榜略有差异。
- 仅限全站范围；群范围没有上赛季榜。
- 当前赛季出现入榜者后，默认赛季切换为当前赛季；用户仍可通过赛季选择查看上赛季。

## 19.11 赛季终榜

- **定位**：已结束的等级赛季的最终排行榜，用于回看往期赛季。不是新榜种：仍是 `board=season`，通过 `level_season_id` 指定赛季。
- **冻结**：与该赛季的**最终评估一起冻结**（第 17.8.4 节：赛季结束后的第一次周评估完成时）。冻结时从该赛季 `user_season_stats` 全量生成终榜快照，写入 `board_snapshots(board=season, level_season_id, is_final=true)`；`snapshot_at`（因此接口 `updated_at`）取该赛季的最终评估时刻 `seasonFinalEvalAsOf`，不取任务实际运行时刻。
- **唯一键冲突**：保留 `UNIQUE(board, snapshot_at, user_id)`。终榜以 `findFinalBySeason(level_season_id)` 判断幂等；若终榜写入与同一 `snapshot_at` 的常规快照撞唯一键，返回内部错误，不覆盖已有快照。
- **不可变**：终榜冻结后，历史赛果修正**不改终榜**；终榜不参与榜单重建与每日一致性对账。赛季统计（积分等）仍照常随修正更新，因此终榜与其后的 `user_season_stats` 可能不同，属预期。
- **保留**：**全部赛季永久保留**，不适用第 37 节「只保留最近 N 版」策略。
- **展示**：只展示名次与赛季积分、精确命中、有效预测数；**不做冠军标识**（第 1.3 节已排除独立成就/头衔系统）。已注销用户显示「已注销用户」并保留其名次。
- **入榜与资格**：入榜门槛同当前赛季榜（该赛季 `valid_predictions ≥ 1`）；榜单收录全体入榜用户，可见资格同第 19.9 节（`seasons_participated ≥ 2`）。
- **范围**：仅全站；`scope=group` 请求历史赛季返回 `422 VALIDATION_ERROR`（群成员会变动，群内终榜口径不明）。
- **入口**：赛季榜内增加赛季选择，默认赛季见第 19.10.10 节；可选项由响应的 `available_level_seasons` 给出（当前赛季 + 上赛季 + 已冻结的历史赛季，至少有 1 名入榜者的才列出）。
- **冻结之前**：赛季刚结束、终评尚未完成的最长约一周内，上赛季榜以最后一版常规快照临时展示（`is_provisional=true`，界面标注「等待最终确认」），终榜生成后替换（第 19.10.10 节）。请求从未有过数据的赛季返回 `404 NOT_FOUND`。

## 19.12 欧冠（后续规划，MVP 不实现）

- 欧冠及其他杯赛仍为 OUT_OF_SCOPE（第 1.3 节）。本节只记录规划边界，**不引入任何实现要求**。
- 排行榜展示规则（第 19.10 节）按「入榜人数」与比赛数据驱动，与赛事来源无关；将来纳入欧冠（周中比赛）后，默认周、少人分档、更新时间规则**无需调整**。
- 欧冠其余功能留待后续版本，开工前需先决定：①是否计分、计入等级/生涯（第 17.4 节：须新规则版本并新增独立积分口径）；②范围（仅欧冠 / 含欧联）；③比分口径（90 分钟，不含加时点球）；④非六联赛球队的主数据与 `league_id` 枚举扩展；⑤Provider 接入与配额；⑥比赛页联赛标签与休赛期默认联赛规则；⑦验收矩阵（第 44 节）新增杯赛组。

---

# 20. 分享卡后端数据

前端渲染不属于本规范，但后端必须提供稳定数据。

分享卡所需：

- 用户展示名。
- `favorite_team_id`。
- 本赛季等级（`season_level` = 当前等级赛季的 `user_season_stats.level`，**读缓存，禁止现场计算**；第 17.8.3 节）。
- 指定 `league_id` + `round_id` 的预测场次。
- 该 round 胜平负命中数。
- 该 round 精确比分命中数。
- 该 round 预测分。
- 生涯积分。

round 统计：

- 不建立额外持久化聚合 Collection。
- API 查询时从该用户该联赛 `predictions` + `matches.league_id/round_id` + 当前已结算结果计算，按 `user_id + league_id` 通过索引筛选，禁止全库扫描（第 42.1 节）。
- 取消/未结算/无效比赛不计。
- 延期比赛仍属于原 `round_id`。
- 不同联赛的 `round_id` 互不可比、不得合并统计（第 5.3 节）。

前端必须显式传 `league_id` 与 `round_id`，后端不猜「当前联赛/当前轮」。

---

# 21. 数据库 Schema

以下类型为规范类型：

- `string`
- `int`
- `bool`
- `date`
- `object`
- `array`
- `null`

所有核心文档 `schema_version = 1`。

## 21.1 users

```text
user_id                     string UUID, immutable, required
openid                      string, required, unique
unionid                     string|null
nickname                    string|null
favorite_team_id            string UUID|null

status                      enum(active, deleted)

career_points                  int >=0, default 0
career_valid_predictions       int >=0, default 0
career_wdl_hits                int >=0, default 0          # 内部统计，第 16.3 节
career_exact_hits              int >=0, default 0
career_last_scoring_match_at   date|null                   # 生涯榜并列键，第 19.5 节
career_level                   int 1..6, default 1
career_best_level              int 1..6, default 1
career_level_state             object:
  below_count                  int 0..1, default 0
  week_base_level               int 1..6|null
  week_base_below_count         int 0..1|null
  week_base_as_of               date|null
  last_eval_as_of                date|null
  last_eval_n                   int >=0, default 0          # 窗口 n
  last_eval_score_sum           int >=0, default 0          # 窗口 S
  last_eval_b_points            int >=0, default 0
  last_eval_rule_version        string|null

deleted_at                  date|null

created_at                  date, immutable
updated_at                  date
schema_version              int, fixed 1
```

Invariant：

```text
career_exact_hits <= career_wdl_hits <= career_valid_predictions
career_best_level >= career_level 必须始终成立，且只增不减。
career_level >= 2 => career_valid_predictions >= 20
0 <= career_level_state.last_eval_score_sum <= 12 * career_level_state.last_eval_n
career_level_state.last_eval_n <= 300
```

## 21.2 user_season_stats

```text
user_id                     string UUID
level_season_id             string                  # 等级赛季口径，第 17.8.1 节；UNIQUE(user_id, level_season_id)

points                      int >=0, default 0
valid_predictions           int >=0, default 0
wdl_hits                    int >=0, default 0
exact_hits                  int >=0, default 0
last_scoring_match_at       date|null               # 赛季榜并列键，第 19.5 节：本赛季有效预测中 match_score > 0 的 period_anchor_at 最大值

level                       int 1..6, default 1
best_level                  int 1..6, default 1
level_state                 object（结构同 users.career_level_state）
is_level_frozen             bool, default false      # 第 17.8.4 节最终评估后置 true

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

Invariant：同 `users` 对应项；另加 `is_level_frozen = true` 的赛季 `level`/`best_level` 不再变化。

## 21.3 teams

```text
team_id                     string UUID, immutable
league_id                   enum(第 1.4 节六联赛), required   # 球队当前所属联赛
name                        string, required
short_name                  string|null
primary_color               string|null
secondary_color             string|null
status                      enum(active, inactive)

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

颜色格式若非 null：

```text
#RRGGBB
```

## 21.4 team_provider_mappings

```text
team_id                     string UUID
provider                    enum(api_football)
provider_team_id            string
created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

## 21.5 matches

```text
match_id                    string UUID, immutable

league_id                   enum(第 1.4 节六联赛), immutable
season_id                   string, 必须等于 league_id 在第 1.4 节表中当前登记的 season_id, immutable
round_id                    string, 取值域按 league_id 决定（第 5.3 节：01..38 / 01..34 / 01..30）, immutable

home_team_id                string UUID
away_team_id                string UUID

kickoff_at                  date
kickoff_confirmed           bool

prediction_deadline_at      date|null
prediction_closed_at        date|null, once set immutable

period_anchor_at            date|null, once set immutable

match_status                enum(
                              scheduled,
                              live,
                              finished,
                              postponed,
                              cancelled,
                              abandoned
                            )

settlement_status           enum(
                              pending,
                              waiting,
                              settling,
                              settled,
                              correcting,
                              failed,
                              voided
                            )

regular_home_score          int 0..99|null
regular_away_score          int 0..99|null

extra_home_score            int 0..99|null
extra_away_score            int 0..99|null
penalty_home_score          int 0..99|null
penalty_away_score          int 0..99|null

result_version              int >=0, default 0
settled_result_version      int >=0, default 0
result_source               enum(provider, admin)|null

scoring_rule_version        string, fixed scoring_v1

finish_detected_at          date|null, once set immutable
settled_at                  date|null

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

MVP 六联赛：

- `extra_*`、`penalty_*` 仅保留兼容字段。
- 正常值必须为 null。
- 自动结算不得使用它们。

Match invariant：

```text
0 <= settled_result_version <= result_version
settlement_status == settled => settled_result_version == result_version
```

## 21.6 match_provider_mappings

```text
match_id                    string UUID
provider                    enum(api_football)
provider_match_id           string
created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

## 21.7 match_results

immutable。

```text
match_id                    string UUID
result_version              int >=1

regular_home_score          int 0..99
regular_away_score          int 0..99

source                      enum(provider, admin)
provider_status             string|null

admin_id                    string UUID|null
reason                      string|null

created_at                  date, immutable
schema_version              int, fixed 1
```

规则：

- provider result：`admin_id=null`, `reason=null`。
- admin result：`admin_id` required, `reason` 1..500 required。

## 21.8 predictions

```text
prediction_id               string UUID, immutable

user_id                     string UUID, immutable
match_id                    string UUID, immutable
idempotency_key             string UUID, immutable

pred_home_score             int 0..20, immutable
pred_away_score             int 0..20, immutable
derived_result              enum(HOME, DRAW, AWAY), immutable

submitted_at                date, immutable
scoring_rule_version        string, immutable

match_score                 int enum(0,3,12)|null
wdl_hit                     bool|null
exact_hit                   bool|null
applied_result_version      int >=0, default 0

created_at                  date, immutable
updated_at                  date
schema_version              int, fixed 1
```

未正式结算：

```text
match_score = null
wdl_hit = null
exact_hit = null
applied_result_version = 0
```

取消比赛保持上述 null 状态。

## 21.9 rankings

`rankings` 集合只承载 `week` 榜（`board=week`）；`career`/`strength`/`season` 榜使用第 21.20 节 `board_snapshots`。

```text
period_type                 enum(week)                  # 月榜已取消，枚举收敛为单值
period_key                  string
user_id                     string UUID

period_score                int >=0
valid_predictions           int >=1
wdl_hits                    int >=0
exact_hits                  int >=0

last_scoring_match_at       date|null
global_rank                 int >=1|null

is_final                    bool, default false

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

不持久化浮点准确率或浮点 `s` 作为排序依据。

## 21.10 settlements

```text
settlement_id               string UUID, immutable

match_id                    string UUID
result_version              int >=1
rule_version                string

status                      enum(pending, running, settled, failed)
phase                       enum(
                              prepare,
                              apply_items,
                              rebuild_ranks,
                              finalize,
                              done
                            )

is_correction               bool

started_at                  date|null
settled_at                  date|null

attempt_count               int >=0, default 0
last_error_code             string|null
last_error_message          string|null

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

## 21.11 settlement_items

```text
settlement_id               string UUID
prediction_id               string UUID
user_id                     string UUID

old_score                   int enum(0,3,12)
new_score                   int enum(0,3,12)
score_delta                 int

old_wdl_hit                 bool
new_wdl_hit                 bool

old_exact_hit               bool
new_exact_hit               bool

valid_prediction_delta      int enum(0,1)

source_result_version       int >=1

status                      enum(pending, applied, failed)
applied_at                  date|null

attempt_count               int >=0, default 0
last_error_code             string|null
last_error_message          string|null

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

Invariant：

```text
score_delta = new_score - old_score
source_result_version = settlements.result_version
```

## 21.12 unlocks

```text
unlock_id                   string UUID
user_id                     string UUID
unlock_code                 string
threshold_points            int >=0
source_version              string
unlocked_at                 date
schema_version              int, fixed 1
```

## 21.13 level_history

```text
level_history_id            string UUID
user_id                     string UUID

scope                       enum(season, career)
level_season_id             string|null            # scope=season 必填，career 必须 null

from_level                  int 1..6
to_level                    int 1..6

reason                      enum(
                              weekly_eval,
                              correction_reeval,
                              rebuild
                            )

eval_as_of                  date                    # 评估截面时刻
window_n                    int >=0
window_score_sum            int >=0
b_points                    int >=0
level_rule_version          string                  # "level_v3.0"
settlement_id                string UUID|null        # reason=correction_reeval 时必填

changed_at                  date
schema_version              int, fixed 1
```

`scope=season` 时 `level_season_id` required；`scope=career` 时必须 null。仅当 `from_level != to_level` 时写入本表；`below_count` 变化不写 history（可由回放得出）。删除 v1.0 中的 `wdl_hits` / `valid_predictions` 快照字段（它们不是 v3 的定级输入），改为记录 `window_n` / `window_score_sum` / `b_points` 等 v3 定级输入截面。

## 21.14 admin_audit_logs

immutable。

```text
audit_id                    string UUID
admin_id                    string UUID

action                      enum(
                              result_correction,
                              retry_settlement,
                              rebuild_user_stats,
                              rebuild_rankings
                            )
entity_type                 enum(match, settlement, user, ranking_period)
entity_id                   string

old_value                   object|null
new_value                   object|null

reason                      string 1..500

created_at                  date
schema_version              int, fixed 1
```

`action` → `entity_type` → `entity_id` 映射：

| action | entity_type | entity_id |
|---|---|---|
| `result_correction` | `match` | `match_id` |
| `retry_settlement` | `settlement` | `settlement_id` |
| `rebuild_user_stats` | `user` | `user_id` |
| `rebuild_rankings` | `ranking_period` | `board` + "-" + (`period_key` 或 `"snapshot"`)；`board=week` 时为 `"week-2026-W32"` 形式，`board=career/strength/season` 时为 `"career-snapshot"` / `"strength-snapshot"` / `"season-snapshot"` |

`reason` 来源见第 30.1 节；四个管理端写操作产生业务变化时都必须写入本表，不得遗漏（第 30.1 节、第 36.3 节）。

禁止把完整数据库文档或完整排行榜数组写入审计日志；每个 `action` 的 `old_value`/`new_value` 前后快照只包含以下字段：

| action | 快照字段 |
|---|---|
| `result_correction` | `result_version`、`regular_home_score`、`regular_away_score`、`result_source`、`settlement_status` |
| `retry_settlement` | `settlement_status`、`phase`、`attempt_count`、`failed_item_count`、`pending_item_count`、`applied_item_count`（retry 再次失败时 `new_value` 如实记录失败后状态） |
| `rebuild_user_stats` | `career_points`、`career_valid_predictions`、`career_wdl_hits`、`career_exact_hits`、`career_level`、`career_best_level`、`season_stats_changed_count`、`level_state_changed` |
| `rebuild_rankings` | `entry_count`、`ranked_entry_count`、`total_period_score`（`board=week` 时）或 `total_career_points`/`total_window_score_sum`/`total_season_points`（`board=career`/`strength`/`season` 时）、`max_rank`、`is_final`（`board=week` 时） |

## 21.15 admins

```text
admin_id                    string UUID
openid                      string, unique
status                      enum(active, disabled)
role                        enum(admin)

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

管理员身份只能由服务端可信微信上下文映射，不接受客户端传 `admin_id`。

MVP 不提供创建/删除管理员的业务 API；管理员由云控制台/部署配置显式 provision。

## 21.16 provider_snapshots

```text
snapshot_id                 string UUID
provider                    enum(api_football)

entity_type                 enum(match, team)
entity_id                   string UUID|null
provider_entity_id          string

event_type                  enum(
                              discovered,
                              kickoff_changed,
                              status_changed,
                              result_observed,
                              result_changed,
                              provider_error,
                              provider_conflict,
                              admin_conflict
                            )

payload                     object
created_at                  date
schema_version              int, fixed 1
```

MVP 不自动清理关键 provider_snapshots。

## 21.17 sync_logs

```text
sync_job_id                 string UUID
job_type                    enum(
                              future_schedule,
                              full_schedule_verify,
                              near_match,
                              live_match,
                              post_finish_verify,
                              period_finalize,
                              daily_consistency,
                              weekly_level_eval,
                              level_correction_reeval,
                              board_snapshot_career,
                              board_snapshot_strength,
                              board_snapshot_season,
                              board_snapshot_season_final
                            )

status                      enum(running, success, failed)
started_at                  date
finished_at                 date|null

attempt_count               int >=0
items_read                  int >=0
items_changed               int >=0
items_failed                int >=0

last_error_code             string|null
last_error_message          string|null

created_at                  date
schema_version              int, fixed 1
```

普通 sync_logs 保留 30 天。

## 21.18 anomalies

```text
anomaly_id                  string UUID
anomaly_key                 string, unique
match_id                    string UUID

type                        enum(
                              LIVE_SYNC_STALE,
                              LIVE_TOO_LONG,
                              FINISHED_NO_SCORE,
                              INVALID_FINAL_SCORE,
                              PROVIDER_STATE_CONFLICT,
                              PROVIDER_DATA_INVALID,
                              UNEXPECTED_PROVIDER_STATUS,
                              TEAM_CHANGE_AFTER_PREDICTION,
                              KICKOFF_CHANGE_AFTER_ANCHOR,
                              ADMIN_PROVIDER_RESULT_CONFLICT
                            )

blocking                    bool
status                      enum(open, resolved)

first_seen_at               date
last_seen_at                date
occurrence_count            int >=1

details                     object
resolved_at                 date|null
resolution                  string|null

schema_version              int, fixed 1
```

同一 match + anomaly type 使用：

```text
anomaly_key = match_id + ":" + type
```

重复出现更新同一记录。

## 21.19 job_locks

```text
lock_key                    string, unique
owner_id                    string
lease_until                 date
updated_at                  date
schema_version              int, fixed 1
```

获取锁必须使用原子 compare-and-set；过期 lease 可被新 owner 接管。

## 21.20 board_snapshots

生涯榜、实力榜、赛季榜的快照存储；只追加最近一版 + 保留最近 N 版供对账（N 为运维配置，第 37 节）。

```text
snapshot_id                 string UUID
board                       enum(career, strength, season)
level_season_id             string|null       # 仅 board=season 必填，其它 board 为 null
is_final                    bool, default false  # 仅 board=season：true 表示赛季终榜（第 19.11 节），冻结后不可变、永久保留
snapshot_at                 date
user_id                     string UUID
rank                        int >=1

# board=career 时：
career_points                int >=0|null
career_exact_hits            int >=0|null
career_valid_predictions     int >=0|null
career_last_scoring_match_at date|null

# board=season 时：
season_points                int >=0|null
season_exact_hits            int >=0|null
season_valid_predictions     int >=0|null
season_last_scoring_match_at date|null

# board=strength 时：
window_score_sum            int >=0|null      # S
window_n                    int >=0|null      # n

created_at                  date
schema_version              int, fixed 1
```

排序键使用原始整数（`career_points`/`exact_hits`/`valid_predictions`/`last_scoring_match_at`，赛季榜取对应 `season_*` 字段，或 `window_score_sum`/`window_n`），不持久化浮点排序键。

## 21.21 groups

```text
group_id                    string UUID, immutable
owner_user_id                string UUID
invite_code                  string, UNIQUE
status                       enum(active, dissolved)
member_count                 int >=0, default 1

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

`invite_code` 长度固定 `GROUP_INVITE_CODE_LENGTH=8`，字符集 `GROUP_INVITE_CODE_ALPHABET`（第 3 节）。`member_count` 是可由 `group_members` 统计重建的缓存。

## 21.22 group_members

```text
group_id                    string UUID
user_id                     string UUID
status                       enum(active, left)
joined_at                    date
left_at                       date|null

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

`UNIQUE(group_id, user_id)`。群主在 `group_members` 中同样有一条 `status=active` 记录，但只能通过解散群（第 19.4.2 节）离开，不允许对群主执行普通退出。

---

# 22. 数据库索引规范

## 22.1 唯一索引

必须创建：

```text
users:
  UNIQUE(openid)

user_season_stats:
  UNIQUE(user_id, level_season_id)

team_provider_mappings:
  UNIQUE(provider, provider_team_id)

match_provider_mappings:
  UNIQUE(provider, provider_match_id)

match_results:
  UNIQUE(match_id, result_version)

predictions:
  UNIQUE(user_id, match_id)
  UNIQUE(user_id, idempotency_key)

rankings:
  UNIQUE(period_type, period_key, user_id)

board_snapshots:
  UNIQUE(board, snapshot_at, user_id)

settlements:
  UNIQUE(match_id, result_version, rule_version)

settlement_items:
  UNIQUE(settlement_id, prediction_id)

unlocks:
  UNIQUE(user_id, unlock_code)

admins:
  UNIQUE(openid)

anomalies:
  UNIQUE(anomaly_key)

job_locks:
  UNIQUE(lock_key)

groups:
  UNIQUE(invite_code)

group_members:
  UNIQUE(group_id, user_id)
```

## 22.2 普通查询索引

至少创建：

```text
matches:
  INDEX(league_id, season_id, kickoff_at)
  INDEX(match_status, kickoff_at)
  INDEX(settlement_status, finish_detected_at)

predictions:
  INDEX(user_id, submitted_at DESC)
  INDEX(match_id)
  INDEX(user_id, match_id)

rankings:
  INDEX(period_type, period_key, global_rank)
  INDEX(period_type, period_key, period_score DESC)

settlements:
  INDEX(match_id, result_version)
  INDEX(status, updated_at)

settlement_items:
  INDEX(settlement_id, status)
  INDEX(user_id, created_at)

level_history:
  INDEX(user_id, changed_at DESC)
  INDEX(user_id, scope, level_season_id, changed_at DESC)

user_season_stats:
  INDEX(level_season_id, level DESC)

board_snapshots:
  INDEX(board, snapshot_at DESC, rank)
  INDEX(board, user_id, snapshot_at DESC)

groups:
  INDEX(owner_user_id, status)

group_members:
  INDEX(user_id, status)
  INDEX(group_id, status)

provider_snapshots:
  INDEX(entity_type, entity_id, created_at DESC)

sync_logs:
  INDEX(job_type, started_at DESC)

admin_audit_logs:
  INDEX(entity_type, entity_id, created_at DESC)

anomalies:
  INDEX(status, blocking, last_seen_at DESC)
  INDEX(match_id, status)
```

---

# 23. API 通用 Contract

## 23.1 Base

```text
/v1
```

不兼容修改必须：

```text
/v2
```

同一 `/v1` 字段语义不得静默改变。

## 23.2 成功 Envelope

非分页：

```json
{
  "data": {},
  "request_id": "trace-request-id"
}
```

分页：

```json
{
  "data": {
    "items": [],
    "page": {
      "next_cursor": null,
      "has_more": false
    }
  },
  "request_id": "trace-request-id"
}
```

## 23.3 request_id

`request_id` 是请求链路 trace ID：

- 可由可信 API gateway/server 生成。
- 客户端若提供 `X-Request-Id`，仅当格式合法时可采用。
- 不承担预测业务幂等。

预测业务幂等字段固定叫：

```text
idempotency_key
```

不得混淆。

## 23.4 JSON 校验

请求 body：

- 未定义字段：422 `VALIDATION_ERROR`。
- 错误类型：422。
- 缺必填：422。
- 未定义 query 参数：422。
- enum 大小写必须完全匹配。

## 23.5 HTTP Status

```text
200 GET 成功 / 幂等重放成功
201 新资源创建成功
204 删除/注销成功且无 body

401 UNAUTHORIZED
403 FORBIDDEN
404 *_NOT_FOUND
409 业务冲突 / 并发版本冲突
422 VALIDATION_ERROR
429 RATE_LIMITED
500 INTERNAL_ERROR
503 PROVIDER_UNAVAILABLE
```

`UNAUTHORIZED` 是「缺少可信身份」这一条件唯一的 HTTP 错误 `code`（第 4.6 节）；`AUTH_REQUIRED` 只用于 `can_predict_reason` 展示字段（第 25.1 节），两者不是同一命名空间，不得混用。

## 23.6 错误 Envelope

```json
{
  "code": "PREDICTION_LOCKED",
  "message": "比赛已停止预测",
  "request_id": "trace-request-id",
  "details": null
}
```

`message` 仅用于人类展示；程序判断必须使用 `code`。

## 23.7 核心错误码

```text
VALIDATION_ERROR
UNAUTHORIZED
FORBIDDEN

USER_NOT_FOUND
USER_DELETED

TEAM_NOT_FOUND

MATCH_NOT_FOUND
MATCH_NOT_PREDICTABLE
MATCH_STATE_CONFLICT

PREDICTION_NOT_FOUND
PREDICTION_LOCKED
PREDICTION_ALREADY_SUBMITTED
IDEMPOTENCY_KEY_REUSED

SETTLEMENT_NOT_READY
SETTLEMENT_ALREADY_RUNNING
SETTLEMENT_FAILED

RESULT_UNCHANGED
RESULT_VERSION_CONFLICT

PROVIDER_UNAVAILABLE
PROVIDER_DATA_INVALID
PROVIDER_STATE_CONFLICT

GROUP_NOT_FOUND
GROUP_DISSOLVED
GROUP_ALREADY_MEMBER
GROUP_NOT_MEMBER
GROUP_MEMBER_LIMIT_REACHED
GROUP_JOIN_LIMIT_REACHED
GROUP_OWNED_LIMIT_REACHED
GROUP_OWNER_CANNOT_LEAVE

RATE_LIMITED
INTERNAL_ERROR
```

`can_predict_reason`（第 25.1 节展示字段，非 HTTP 错误码）另有独立枚举：`AUTH_REQUIRED` / `USER_DELETED` / `ALREADY_SUBMITTED` / `KICKOFF_UNCONFIRMED` / `NOT_SCHEDULED` / `CLOSED`。

## 23.8 Cursor Pagination

cursor：

- 服务端 opaque token。
- 客户端不得解析或自行构造。
- 使用 base64url + HMAC 签名的稳定排序游标。
- 无有效签名返回 422。
- MVP cursor 不过期。

cursor 必须同时绑定首次请求已经解析完成的筛选条件：

- matches：解析后的 `from/to/status/league_id`。
- rankings：解析后的 `board/period_key/scope/group_id`。
- predictions：解析后的 `league_id/season_id`（第 26.2 节）。

后续带 cursor 请求若显式参数与 cursor 内筛选条件冲突：

```text
422 VALIDATION_ERROR
```

这样默认 `server_now` 或周期边界变化不得改变同一次分页的数据窗口。

`limit`：

```text
default = 20
min = 1
max = 100
```

稳定排序：

```text
matches:
  kickoff_at ASC, match_id ASC

predictions:
  submitted_at DESC, prediction_id DESC

rankings:
  global_rank ASC, user_id ASC
```

## 23.9 认证声明

OpenAPI 的认证 security scheme 表达按第 4.6 节「认证方式的 OpenAPI 表达」执行：不声明 Bearer/Cookie/客户端可填写的身份 Header；使用 `x-trusted-runtime-openid` 与 `x-requires-trusted-openid` 标记表达可信运行时注入模型。

---

# 24. 身份与用户 API

## 24.1 POST /v1/session/init

权限：

- 需要可信微信运行环境。
- openid 必须从服务端微信上下文获取。
- body 禁止传 openid。

Request：

```json
{
  "nickname": "Sky"
}
```

`nickname` required，1～32 grapheme。

行为：

- active openid 已存在：返回 200。
- 不存在：创建用户，返回 201。
- 并发创建由 unique(openid) 兜底。

Response data：

```json
{
  "user_id": "uuid",
  "nickname": "Sky",
  "favorite_team_id": null,
  "status": "active",
  "career_points": 0,
  "career_level": 1
}
```

`career_level` 取值域 `1..6`（第 17.2 节），新用户初始为 `1`。

## 24.2 GET /v1/profile/me

Auth required。

Response：

```json
{
  "user_id": "uuid",
  "nickname": "Sky",
  "favorite_team_id": null,
  "career_points": 428,
  "career_valid_predictions": 132,
  "career_exact_hits": 8,
  "career_level": 3,
  "career_best_level": 4,
  "season_level": 2
}
```

- `career_wdl_hits`、`career_wdl_accuracy_percent` 已从本接口删除（第 16.3 节：准确率仅内部统计，不对外输出）。
- `season_level`：当前等级赛季的 `user_season_stats.level`（第 17.8.3 节，读缓存，禁止现场计算），用户当前等级赛季无记录时为 `1`。
- 本例与第 28.1 节 `GET /v1/levels/me` 示例保持同一账户口径自洽。

## 24.3 PATCH /v1/profile/me

Auth required。

允许字段：

```json
{
  "nickname": "Sky",
  "favorite_team_id": "uuid-or-null"
}
```

至少一个字段。

禁止修改其他字段。

## 24.4 DELETE /v1/profile/me

Auth required。

行为按第 4.5 节注销。

成功：

```text
204
```

## 24.5 GET /v1/profiles/:user_id

公开。

active：

```json
{
  "user_id": "uuid",
  "display_name": "Sky",
  "favorite_team_id": "uuid",
  "career_points": 428,
  "career_valid_predictions": 132,
  "career_exact_hits": 8,
  "career_level": 3,
  "career_best_level": 4,
  "season_level": 2
}
```

deleted：

```json
{
  "user_id": "uuid",
  "display_name": "已注销用户",
  "favorite_team_id": null,
  "career_points": 428,
  "career_valid_predictions": 132,
  "career_exact_hits": 8,
  "career_level": 3,
  "career_best_level": 4,
  "season_level": 2
}
```

`career_wdl_accuracy_percent` 已从本接口删除（第 16.3 节）；`season_level` 语义同第 24.2 节。

---

# 25. 比赛 API

## 25.1 GET /v1/matches

公开，可带可选登录上下文。

Query：

```text
from        ISO8601 UTC optional
to          ISO8601 UTC optional
status      scheduled|live|finished|postponed|cancelled|abandoned optional
league_id   第 1.4 节六联赛枚举 optional；缺省返回全部联赛
limit       1..100 optional
cursor      opaque optional
```

默认：

```text
from = server_now - 24h
to   = server_now + 30d
limit = 20
```

最大查询区间：

```text
90 days
```

排序：

```text
kickoff_at ASC, match_id ASC
```

每项：

```json
{
  "match_id": "uuid",
  "league_id": "premier_league",
  "season_id": "2026_2027",
  "round_id": "01",
  "home_team": {
    "team_id": "uuid",
    "name": "Arsenal"
  },
  "away_team": {
    "team_id": "uuid",
    "name": "Chelsea"
  },
  "kickoff_at": "2026-08-08T14:00:00Z",
  "prediction_deadline_at": "2026-08-08T13:50:00Z",
  "prediction_closed_at": null,
  "match_status": "scheduled",
  "regular_home_score": null,
  "regular_away_score": null,
  "can_predict": false,
  "can_predict_reason": "AUTH_REQUIRED"
}
```

`can_predict_reason`：

```text
null
AUTH_REQUIRED
USER_DELETED
ALREADY_SUBMITTED
KICKOFF_UNCONFIRMED
NOT_SCHEDULED
CLOSED
```

## 25.2 can_predict

如果没有登录：

```text
false / AUTH_REQUIRED
```

已登录时按领域规则实时计算。

该字段只用于 UI 辅助。

`POST /predictions` 必须再次执行全部校验，不信任此前查询结果。

## 25.3 GET /v1/matches/:match_id

公开，可带可选登录上下文。

除比赛字段外：

```json
{
  "my_prediction": null
}
```

已登录且存在 prediction 时返回：

```json
{
  "my_prediction": {
    "prediction_id": "uuid",
    "pred_home_score": 2,
    "pred_away_score": 1,
    "derived_result": "HOME",
    "submitted_at": "2026-08-08T12:00:00Z",
    "match_score": null,
    "wdl_hit": null,
    "exact_hit": null
  }
}
```

## 25.4 GET /v1/matches/:match_id/crowd

Auth required；仅在预测截止后返回「大家怎么选」分布。游客返回 `401 UNAUTHORIZED`，已注销用户返回 `409 USER_DELETED`。`match_id` 必须是 UUID v4；比赛不存在返回 `404 MATCH_NOT_FOUND`。本接口不接受 query 参数，未知字段返回 `422 VALIDATION_ERROR`，使用 `authenticated_reads` 限流，超额返回 `429 RATE_LIMITED`。

成功响应始终包含 `granularity` 与 `min_predictions`，取值分别为固定配置 `CROWD_GRANULARITY_PERCENT=5` 与 `CROWD_MIN_PREDICTIONS=20`：

```json
{
  "data": {
    "match_id": "uuid",
    "status": "available",
    "distribution": { "home": 45, "draw": 25, "away": 30 },
    "granularity": 5,
    "min_predictions": 20
  },
  "request_id": "trace-request-id"
}
```

`status` 与 `distribution`：

| status | 语义 | distribution |
|---|---|---|
| `not_closed` | 预测未截止；开球时间未确认也属于此状态 | `null` |
| `insufficient` | 已截止，但预测数少于 20 | `null` |
| `available` | 已截止且预测数不少于 20 | 主胜、平局、客胜百分比；每项为 5 的倍数且合计为 100 |
| `unavailable` | 比赛延期、取消或中止 | `null` |

分布按 prediction 的 `derived_result` 统计。百分比换算为 20 格：各项先向下取整，剩余格按小数部分从大到小分配；相同时固定按 `home > draw > away`。任何状态均不返回预测人数、热门比分、用户标识或 `my_choice`。注销用户的历史预测保留并计入统计。

---

# 26. 预测 API

## 26.1 POST /v1/predictions

Auth required。

Request：

```json
{
  "idempotency_key": "uuid-v4",
  "match_id": "uuid",
  "home_score": 2,
  "away_score": 1
}
```

首次成功：

```text
201
```

Response：

```json
{
  "data": {
    "prediction_id": "uuid",
    "match_id": "uuid",
    "pred_home_score": 2,
    "pred_away_score": 1,
    "derived_result": "HOME",
    "submitted_at": "2026-08-08T12:00:00Z",
    "scoring_rule_version": "scoring_v1"
  },
  "request_id": "trace"
}
```

同幂等请求成功重放：

```text
200
```

## 26.2 GET /v1/predictions/me

Auth required。

### 成功 Envelope

成功返回 `200`，严格使用第 23.2 节分页 Envelope：

```json
{
  "data": {
    "items": [],
    "page": {
      "next_cursor": null,
      "has_more": false
    }
  },
  "request_id": "trace-request-id"
}
```

`data.items` 为空时必须是 `[]`；`page.next_cursor` 无下一页时必须是 `null`。`request_id` 为字符串。

### item 字段

每个 item 是扁平对象，必须包含下列字段，不得省略，也不得添加本合同未定义的公开字段：

| 字段 | 类型 | nullable | 语义 |
|---|---|---|---|
| `prediction_id` | UUID v4 string | 否 | 预测 ID |
| `match_id` | UUID v4 string | 否 | 比赛 ID |
| `league_id` | 第 1.4 节六联赛枚举 | 否 | 比赛联赛 |
| `season_id` | string | 否 | 比赛所属该联赛的赛季（第 1.4 节） |
| `round_id` | string | 否 | 比赛轮次（取值域按 `league_id`，第 5.3 节） |
| `home_team_id` | UUID v4 string | 否 | 主队 ID |
| `away_team_id` | UUID v4 string | 否 | 客队 ID |
| `kickoff_at` | ISO 8601 UTC date-time string | 否 | 比赛开球时间 |
| `pred_home_score` | integer `0..20` | 否 | 用户预测主队比分 |
| `pred_away_score` | integer `0..20` | 否 | 用户预测客队比分 |
| `derived_result` | enum `HOME\|DRAW\|AWAY` | 否 | 由预测比分推导的胜平负 |
| `submitted_at` | ISO 8601 UTC date-time string | 否 | 提交时间 |
| `scoring_rule_version` | string，固定 `scoring_v1` | 否 | 计分规则版本 |
| `match_status` | enum `scheduled\|live\|finished\|postponed\|cancelled\|abandoned` | 否 | 当前比赛状态 |
| `regular_home_score` | integer `0..99` | 是 | 当前正式常规时间主队比分 |
| `regular_away_score` | integer `0..99` | 是 | 当前正式常规时间客队比分 |
| `match_score` | enum `0\|3\|12` | 是 | 当前预测得分 |
| `wdl_hit` | boolean | 是 | 当前胜平负命中状态 |
| `exact_hit` | boolean | 是 | 当前准确比分命中状态 |

正式比分只使用 90 分钟常规时间比分（第 9.1 节）。正式比分缺失时，`regular_home_score`、`regular_away_score`、`match_score`、`wdl_hit`、`exact_hit` 均返回 `null`；不得用空字符串、`0` 或省略字段表达缺失。取消比赛也保持预测结算字段为 `null`（第 9.4/21.8 节）。

本合同冻结的 match 基础信息仅为上述 `match_id`、`league_id`/`season_id`/`round_id`、主客队 ID 和 `kickoff_at`。球队名称或 `home_team`/`away_team` 嵌套对象的公开形状不由本节唯一规定，属于 `SPEC_GAP`（前端展示层，第 1.3 节范围外），本节不增加字段。

### 排序与 cursor

结果严格按以下稳定 keyset 顺序：

```text
submitted_at DESC, prediction_id DESC
```

`prediction_id` 是同一 `submitted_at` 下的唯一 tie-breaker。`next_cursor` 仅在 `has_more=true` 时返回；它指向当前页最后一项的位置。cursor 是服务端生成的 opaque `base64url + HMAC` 游标，绑定当前解析后的 `league_id`、`season_id`、最后一项的 `submitted_at` 和 `prediction_id`；客户端不得解析或构造，签名无效返回 `422 VALIDATION_ERROR`。MVP cursor 不过期。

带 cursor 的请求必须继续使用 cursor 绑定的 `league_id`/`season_id`；显式参数与其冲突返回 `422 VALIDATION_ERROR`。`limit` 不属于筛选条件，可以在后续页改变。`has_more=false` 时 `next_cursor=null`。

### 输入与失败映射

查询参数：

```text
league_id  optional；第 1.4 节六联赛枚举；缺省返回全部联赛的预测
season_id  optional；仅当同时提供 league_id 时生效，取值必须等于该 league_id 在第 1.4 节表中当前登记的 season_id
limit      optional; default 20; integer 1..100
cursor     optional; opaque string
```

提供 `season_id` 但缺少 `league_id`，或 `season_id` 与该 `league_id` 当前登记值不符：`422 VALIDATION_ERROR`。未知参数、类型错误由 handler 返回 `422 VALIDATION_ERROR`。cursor 的签名、内容和绑定条件由 application query 校验；无效 cursor 同样返回 `422 VALIDATION_ERROR`，不返回历史数据。

失败映射：

| 条件 | HTTP | code |
|---|---:|---|
| 缺少可信身份 | 401 | `UNAUTHORIZED` |
| 可信身份对应用户已注销 | 409 | `USER_DELETED` |
| 可信身份无法解析为现有用户 | 404 | `USER_NOT_FOUND` |
| 查询参数或 cursor 校验失败 | 422 | `VALIDATION_ERROR` |
| 已认证读取限流命中 | 429 | `RATE_LIMITED` |
| 预测或比赛事实数据不一致 | 500 | `INTERNAL_ERROR` |

所有失败均使用第 23.6 节错误 Envelope。

## 26.3 GET /v1/predictions/me/:prediction_id

Auth required。

只能读取自己的 prediction。

其他用户 prediction_id：

- 返回 404，不暴露资源是否存在。

## 26.4 禁止接口

MVP 不得存在：

```text
PATCH /v1/predictions/*
PUT /v1/predictions/*
DELETE /v1/predictions/*
```

---

# 27. 排行榜 API

## 27.1 GET /v1/rankings

**Auth required**（第 19.10.9 节：游客不能访问，返回 `401 UNAUTHORIZED`；已注销用户返回 `409 USER_DELETED`）。

Query：

```text
board       week|career|strength|season   required
period_key                          optional；仅 board=week 有效
level_season_id                     optional；仅 board=season 有效；缺省 = 当前等级赛季；历史赛季见第 19.11 节
scope       global|group            optional；default global
group_id                             scope=group 时 required；否则禁止携带
limit                                optional; default 20; integer 1..100
cursor                               optional
```

- `board` 非法值：`422 VALIDATION_ERROR`（含旧 `period_type=month`，月榜已取消）。
- `board != week` 时携带 `period_key`：`422 VALIDATION_ERROR`。
- `period_key` 缺省（`board=week`）：服务端按第 19.10.3 节「默认周」规则选择返回哪一周；`period_key` 不在可选窗口（最近 `RANKING_WEEK_WINDOW=4` 周）或早于上线周：`422 VALIDATION_ERROR`；非法 `period_key`：`422`。
- `board != season` 时携带 `level_season_id`：`422 VALIDATION_ERROR`；`level_season_id` 为已冻结的历史赛季时返回其终榜（第 19.11 节）；`scope=group` 请求历史赛季：`422`；该赛季从未有数据：`404 NOT_FOUND`；上赛季终榜生成前请求上赛季：返回最后一版常规快照并带 `is_provisional=true`（第 19.10.10 节）。
- `scope=group` 但请求者不是该群 active 成员：`403 FORBIDDEN`。
- `scope=global` 时携带 `group_id`：`422 VALIDATION_ERROR`。

只返回符合入榜门槛（第 19.1 节）的用户；`week` 榜要求 `global_rank != null`，`career`/`strength`/`season` 榜按快照排序结果分页，语义等价。

Response：

```json
{
  "data": {
    "board": "week",
    "scope": "global",
    "period_key": "2026-W32",
    "updated_at": "2026-08-11T00:05:00Z",
    "items": [
      {
        "rank": 1,
        "user_id": "uuid",
        "display_name": "Sky",
        "favorite_team_id": "uuid-or-null",
        "career_level": 3,
        "period_score": 33,
        "valid_predictions": 8,
        "exact_hits": 1,
        "last_scoring_match_at": "2026-08-08T14:00:00Z"
      }
    ],
    "page": { "next_cursor": null, "has_more": false },
    "me": {
      "status": "ranked",
      "rank": 5,
      "top_percent": null
    }
  },
  "request_id": "trace-request-id"
}
```

字段说明：

- `board=career` 时 item 主排序字段为 `career_points`（不返回 `period_score`/`last_scoring_match_at` 之外的周期字段，改为 `career_points`、`career_valid_predictions`、`exact_hits`、`last_scoring_match_at`）。
- 所有 board 的响应 `data` 均含 `entry_count`（第 19.10.1 节）与 `seasons_participated`（请求者参与的等级赛季数，整数）；`board=week` 另含 `current_period_key`（本周 key，`period_key` 为实际返回周）；`board=season` 另含 `available_level_seasons`（当前赛季、上赛季与已冻结历史赛季中至少有 1 名入榜者的 `level_season_id` 列表，倒序）与 `is_provisional`（boolean，第 19.10.10 节）。
- `board=season` 时 item 主排序字段为 `season_points`，另给 `season_valid_predictions`、`exact_hits`、`last_scoring_match_at`；响应另含 `level_season_id`。
- 所有 board 的响应 `data` 均含 `available_boards`（string 数组，第 19.10.8 节）：客户端据此决定展示哪些榜单标签。`board=season` 且请求者资格不足时，列表照常返回，`me.status = not_eligible` 并带 `seasons_participated`。
- `board=strength` 时 item 额外包含 `strength_index`（`"x.yy"`，第 17.5.2 节向下取整两位）与窗口 `window_n`；不返回 `period_score`/`career_points`。
- 任何 board 的响应中都**不得**出现准确率字段（第 16.3 节）。
- `me` 块状态机与字段见第 19.3 节；因接口需登录，响应总是包含 `me`。
- `updated_at`：本周榜 = 该周期最近一次重排完成时刻；生涯榜/实力榜/赛季榜 = 快照时刻（第 19.3 节）。
- 分页：每页 `RANKING_PAGE_SIZE=10` 条，最多 `RANKING_TOP_LIMIT=20` 名；第 3 页请求返回空列表且 `next_cursor=null`。

失败映射：

| 条件 | HTTP | code |
|---|---:|---|
| 缺少可信身份（游客） | 401 | `UNAUTHORIZED` |
| 可信身份对应用户已注销 | 409 | `USER_DELETED` |
| `board`/`scope`/`period_key`/`group_id` 组合非法 | 422 | `VALIDATION_ERROR` |
| `scope=group` 且请求者非该群成员 | 403 | `FORBIDDEN` |
| `group_id` 不存在或已解散 | 404 | `GROUP_NOT_FOUND` |
| 已认证读取限流命中 | 429 | `RATE_LIMITED` |
| 事实/快照数据不一致 | 500 | `INTERNAL_ERROR` |

## 27.2 群管理 API

以下接口均 Auth required，均对 `groups`/`group_members` 做受控写入，客户端不得直接写这两个集合（第 36.1 节）。

### POST /v1/groups

创建一个群，当前用户成为群主。

请求体为空对象 `{}`（群名不接受自由文本，第 19.4.2 节）。

前置校验：当前用户已拥有的群数 `< USER_MAX_GROUPS_OWNED(5)`，否则 `409 GROUP_OWNED_LIMIT_REACHED`。

成功 `201`：

```json
{
  "data": {
    "group_id": "uuid",
    "invite_code": "AB23CD45",
    "owner_user_id": "uuid",
    "status": "active",
    "member_count": 1,
    "created_at": "2026-08-08T12:00:00Z"
  },
  "request_id": "trace-request-id"
}
```

`invite_code` 生成必须原子校验唯一；冲突时服务端重新生成，不得返回冲突错误给客户端。

### POST /v1/groups/join

请求体：

```json
{ "invite_code": "AB23CD45" }
```

判定顺序（命中即停）：

| 优先级 | 条件 | HTTP | code |
|---|---|---|---|
| 1 | `invite_code` 格式非法 | 422 | `VALIDATION_ERROR` |
| 2 | 邀请码不存在 | 404 | `GROUP_NOT_FOUND` |
| 3 | 群 `status=dissolved` | 409 | `GROUP_DISSOLVED` |
| 4 | 已是该群 active 成员 | 409 | `GROUP_ALREADY_MEMBER` |
| 5 | 该群 `member_count >= GROUP_MAX_MEMBERS(500)` | 409 | `GROUP_MEMBER_LIMIT_REACHED` |
| 6 | 当前用户已加入群数 `>= USER_MAX_GROUPS_JOINED(20)` | 409 | `GROUP_JOIN_LIMIT_REACHED` |
| — | 以上皆否 | 200 | 成功 |

成功 `200`：

```json
{
  "data": { "group_id": "uuid", "member_count": 42, "joined_at": "2026-08-08T12:00:00Z" },
  "request_id": "trace-request-id"
}
```

### POST /v1/groups/:group_id/leave

- 群主调用：`409 GROUP_OWNER_CANNOT_LEAVE`（群主只能解散，见下）。
- 非成员调用：`409 GROUP_NOT_MEMBER`。
- 成功：`204`，`group_members.status -> left`，`left_at = server_now`，`groups.member_count -= 1`。

### DELETE /v1/groups/:group_id

解散群（软删除）。仅群主可调用，非群主：`403 FORBIDDEN`。

成功：`204`，`groups.status -> dissolved`；群继续存在于历史数据中，不物理删除；群榜自此对该 `group_id` 返回 `404 GROUP_NOT_FOUND`。

### GET /v1/groups/me

Auth required，分页。返回当前用户 active 加入的全部群：

```json
{
  "data": {
    "items": [
      {
        "group_id": "uuid",
        "display_name": "Sky的预言群",
        "owner_user_id": "uuid",
        "role": "owner",
        "member_count": 42,
        "status": "active",
        "joined_at": "2026-08-08T12:00:00Z"
      }
    ],
    "page": { "next_cursor": null, "has_more": false }
  },
  "request_id": "trace-request-id"
}
```

`display_name` 按第 19.4.2 节规则由服务端拼接（群主已注销时显示「已注销用户的预言群」），不接受客户端自定义。

### GET /v1/groups/:group_id

Auth required；仅该群 active 成员可访问，否则 `403 FORBIDDEN`（群不存在或已解散：`404 GROUP_NOT_FOUND`）。返回单群基本信息，字段同 `GET /v1/groups/me` 的 item，并额外返回 `invite_code`；仅详情接口返回该字段，`GET /v1/groups/me` 列表不返回。

---

# 28. 等级与解锁 API

## 28.1 GET /v1/levels/me

Auth required。

Response：

```json
{
  "data": {
    "career": {
      "level": 3,
      "best_level": 4,
      "is_rated": true,
      "valid_predictions": 132,
      "remaining_to_rated": 0,
      "last_evaluated_at": "2026-10-05T02:00:00Z",
      "next_evaluation_at": "2026-10-12T02:00:00Z"
    },
    "season": {
      "level_season_id": "2026_2027",
      "level": 2,
      "best_level": 3,
      "is_rated": true,
      "valid_predictions": 58,
      "remaining_to_rated": 0,
      "is_frozen": false
    },
    "rule_version": "level_v3.0"
  },
  "request_id": "trace-request-id"
}
```

字段规则：

- 不返回 `s`、`S`、`n`、`B` 值、阈值、降级计数、保护期状态（避免暴露「差 0.05 分」类进度，第 19.8 节）。
- `is_rated = (valid_predictions >= LEVEL_RATED_MIN_VALID)`（即 `level >= 2`）。
- `remaining_to_rated = max(0, 20 − valid_predictions)`（第 19.8 节）。
- `next_evaluation_at` = 下一个周一 10:00 北京时间（以 UTC 表示）。
- `season.is_frozen` 对应 `user_season_stats.is_level_frozen`（第 17.8.4 节）；用户当前等级赛季无记录时，`season` 块按 `level=best_level=1, valid_predictions=0, is_rated=false, remaining_to_rated=20, is_frozen=false` 返回。
- 所有等级字段 `minimum: 1, maximum: 6`。
- 已注销用户访问本接口：409 `USER_DELETED`（第 4.5.1 节）。
- 「前顶级球星」标记按第 17.11 节以 `career_best_level==6 AND career_level<6` 派生，若前端需要该标记，由本接口另附 `career.is_former_top: boolean` 字段（派生值，不落库）。

## 28.2 GET /v1/unlocks/me

Auth required。只使用第 18.2 节和当前 unlock 记录已有的资源代码、记录字段与历史保留规则。不冻结未由现有规范唯一确定的资源展示名称、图标、URL 或其他 UI 元数据，保留 `SPEC_GAP`（第 1.3 节范围外）。

### 成功 Envelope 与资源清单

成功返回 `200`，严格使用第 23.2 节非分页成功 Envelope：

```json
{
  "data": {
    "default_resources": ["avatar_frame", "profile_card", "share_card"],
    "unlocked": []
  },
  "request_id": "trace-request-id"
}
```

`data` 必须包含 `default_resources` 和 `unlocked`；`request_id` 为字符串。`default_resources` 固定为以下三个资源代码，顺序固定，不得增加资源或附带前端展示字段：

```text
[avatar_frame, profile_card, share_card]
```

没有历史 unlock 时，`unlocked` 必须是空数组 `[]`。

### unlocked item

每个 item 必须只包含以下五个字段，均必填且不 nullable：

| 字段 | 类型 | 语义 |
|---|---|---|
| `unlock_id` | UUID v4 string | 解锁记录 ID |
| `unlock_code` | enum `profile_card_style_1\|favorite_team_name_accent\|favorite_team_avatar_frame_1` | 第 18.2 节实际 unlock 代码 |
| `threshold_points` | integer enum `30\|100\|200` | 首次满足条件时的生涯积分阈值 |
| `source_version` | string，固定 `unlock_v1` | 解锁配置版本 |
| `unlocked_at` | ISO 8601 UTC date-time string | 解锁时间，输出 UTC |

`unlocked` 返回该用户的全部历史 unlock，不因当前 `career_points` 下降而隐藏，也不因赛果修正回收。稳定排序：

```text
threshold_points ASC, unlock_id ASC
```

除上述字段外，`unlock` item 不公开名称、图标、资源 URL、描述、展示分类或其他 UI 内容；这些字段的公开形状是 `SPEC_GAP`，本节停止在未定义部分。

### 参数与失败映射

该接口无 query、path 或 request body 参数；未定义参数按第 23.4 节返回 `422 VALIDATION_ERROR`。失败映射：

| 条件 | HTTP | code |
|---|---:|---|
| 缺少认证用户 | 401 | `UNAUTHORIZED` |
| 认证用户不存在 | 404 | `USER_NOT_FOUND` |
| 认证用户已注销 | 409 | `USER_DELETED` |
| 认证用户 ID 非法 | 422 | `VALIDATION_ERROR` |
| authenticated reads 限流命中 | 429 | `RATE_LIMITED` |
| 用户或 unlock 事实读取失败 | 500 | `INTERNAL_ERROR` |

所有失败均使用第 23.6 节错误 Envelope。

---

# 29. 分享卡数据 API

## 29.1 GET /v1/share-card/me

Auth required。

Query：

```text
league_id required；第 1.4 节六联赛枚举
season_id required；必须等于 league_id 在第 1.4 节表中当前登记的 season_id
round_id  required；取值域按 league_id 决定（第 5.3 节）
```

`league_id`/`season_id`/`round_id` 组合非法（如 `round_id` 超出该 `league_id` 上限，或 `season_id` 与当前登记值不符）：`422 VALIDATION_ERROR`。

Response：

```json
{
  "user_id": "uuid",
  "display_name": "Sky",
  "favorite_team_id": "uuid-or-null",
  "season_level": 2,
  "league_id": "premier_league",
  "round_id": "01",
  "round_predictions": 10,
  "round_wdl_hits": 7,
  "round_exact_hits": 2,
  "round_score": 33,
  "career_points": 428
}
```

`season_level`（第 17.8.3 节，读缓存，禁止现场计算）与 round 统计按 `league_id` 隔离，不跨联赛合并（第 20 节）。统计只基于有效正式结算 prediction。

---

# 30. 管理员 API

## 30.1 权限

所有 `/v1/admin/*`：

- 必须可信微信身份。
- 服务端查 `admins.openid`。
- `status=active` 才允许。
- 客户端传入的 admin_id 一律忽略/拒绝。

本节四个写操作（result-corrections、retry-settlement、rebuild/users、rebuild/rankings）成功执行时都必须在同一业务变化中追加一条 `admin_audit_logs`，不得遗漏；审计 `reason` 不得为空。四个写操作的 reason 来源固定：

| 写操作 | 审计 reason 来源 | HTTP body 是否包含 reason |
|---|---|---|
| `POST /v1/admin/matches/:match_id/result-corrections` | 管理员 HTTP body 的必填 `reason`，原样写入 `admin_audit_logs.reason` | 是，必填，1..500 |
| `POST /v1/admin/rebuild/rankings` | 管理员 HTTP body 的必填 `reason`，原样写入 `admin_audit_logs.reason` | 是，必填，1..500 |
| `POST /v1/admin/matches/:match_id/retry-settlement` | 固定系统 reason：`管理员重试结算` | 否；不得添加 body/request reason 字段 |
| `POST /v1/admin/rebuild/users/:user_id` | 固定系统 reason：`管理员用户统计重建` | 否；不得添加 body/request reason 字段 |

成功响应统一使用第 23.2 节成功 Envelope，`data` 只返回目标标识、执行结果摘要与 `audit_id`；不得返回 `admin_id`、完整 `audit_log`、完整内部数据库对象或完整排行榜数组。

## 30.2 GET /v1/admin/anomalies

### 成功 Envelope

成功返回 `200`，严格使用第 23.2 节分页成功 Envelope：

```json
{
  "data": {
    "items": [],
    "page": { "next_cursor": null, "has_more": false }
  },
  "request_id": "trace-request-id"
}
```

### anomaly item 字段

| 字段 | 类型 | nullable | 语义 |
|---|---|---|---|
| `anomaly_id` | UUID v4 string | 否 | 异常记录 ID |
| `anomaly_key` | string，固定为 `match_id:type` | 否 | 第 21.18 节唯一异常键 |
| `match_id` | UUID v4 string | 否 | 关联比赛 ID |
| `type` | 第 21.18 节十项 anomaly type enum | 否 | 异常类型 |
| `blocking` | boolean | 否 | 是否阻塞业务 |
| `status` | enum `open\|resolved` | 否 | 当前异常状态 |
| `first_seen_at` | ISO 8601 UTC date-time string | 否 | 首次发现时间 |
| `last_seen_at` | ISO 8601 UTC date-time string | 否 | 最近一次发现时间 |
| `occurrence_count` | integer `>=1` | 否 | 同一记录累计出现次数 |
| `details` | object，公开值固定为 `{}` | 否 | 受控公开投影，见下文 |
| `resolved_at` | ISO 8601 UTC date-time string | 是 | resolve 时间 |
| `resolution` | string | 是 | 自动或管理员 resolve 原因 |

`details` 的内部字段形状无法从第 21.18 节或其他冻结规范唯一推出，是 `SPEC_GAP`（第 1.3 节范围外）；API 采用最小受控投影，公开值始终为空 JSON 对象 `{}`，不透传内部原始 Provider payload、密钥或运维字段；未来若需要公开诊断字段，必须另行冻结字段白名单和脱敏边界。

### 查询参数

```text
status=open|resolved optional; default no filter
blocking=true|false optional; default no filter
limit optional; default 20; integer 1..100
cursor optional; opaque string
```

未知参数、缺失值以外的 `null`、错误类型、非法 enum、非法 boolean 或不在 `1..100` 的整数均返回 `422 VALIDATION_ERROR`。

### 排序与 cursor

稳定 keyset 顺序：

```text
last_seen_at DESC, anomaly_id DESC
```

cursor 是服务端生成的 `base64url + HMAC` opaque token，客户端不得解析或构造；MVP cursor 不过期。cursor 绑定首次请求解析后的 `status`、`blocking` 筛选值，以及当前页最后一项的 `last_seen_at`、`anomaly_id`。后续请求省略 `status`/`blocking` 表示继承 cursor 绑定值；显式值与其不一致返回 `422 VALIDATION_ERROR`。`limit` 不属于筛选条件，可在后续页改变。keyset 条件：

```text
last_seen_at < cursor.last_seen_at
OR (
  last_seen_at == cursor.last_seen_at
  AND anomaly_id < cursor.anomaly_id
)
```

### resolved 记录

未传 `status` 时，open 与 resolved 记录均按同一排序返回；`status=resolved` 只返回 resolved 记录。resolved item 仍保留全部冻结字段，`status="resolved"`，`resolved_at` 必须为 UTC 时间字符串，`resolution` 必须为非空字符串；open item 的 `resolved_at`、`resolution` 均为 `null`。

### 鉴权、限流与失败映射

| 条件 | HTTP | code |
|---|---:|---|
| 缺少可信 `openid` | 401 | `UNAUTHORIZED` |
| 可信 `openid` 无对应管理员、管理员非 active 或 role 不是 `admin` | 403 | `FORBIDDEN` |
| 未知 query、参数值/类型非法、cursor 签名或内容无效、cursor 筛选冲突 | 422 | `VALIDATION_ERROR` |
| `admin_apis` 限流命中，默认 60 requests/min/admin | 429 | `RATE_LIMITED` |
| anomaly 事实记录或分页事实不一致 | 500 | `INTERNAL_ERROR` |

事实不一致包括返回记录不符合第 21.18 节 schema、`anomaly_key != match_id:type`、时间无效、计数非法、`details` 不是 object，或 open/resolved 与 `resolved_at`/`resolution` 的 nullable 组合不一致。此类失败不得把原始事实或内部诊断放入公开错误 `details`。

## 30.3 POST /v1/admin/matches/:match_id/result-corrections

Request：

```json
{
  "expected_result_version": 1,
  "regular_home_score": 1,
  "regular_away_score": 1,
  "reason": "Provider 正式比分更正"
}
```

校验：

- match 必须存在。
- `match_status == finished`。
- score 0..99 integer。
- reason 1..500（必填，见第 30.1 节 reason 来源表）。
- `expected_result_version == matches.result_version`。

不匹配：`409 RESULT_VERSION_CONFLICT`。新比分与当前相同：`409 RESULT_UNCHANGED`。

成功：

1. `result_version += 1`。
2. 创建 immutable match_results。
3. `result_source = admin`。
4. 更新 matches 当前 regular score。
5. 若 `settled_result_version > 0`：`settlement_status -> correcting`，排入修正结算（第 11.2 节）。
6. 若 `settled_result_version == 0`：保持/进入 `waiting`；达到首次结算时间条件后按首次 settlement 执行。
7. 写 `admin_audit_logs`。

成功响应 `201`：

```json
{
  "data": {
    "match_id": "uuid",
    "result_version": 2,
    "regular_home_score": 1,
    "regular_away_score": 1,
    "result_source": "admin",
    "settlement_status": "correcting",
    "audit_id": "uuid"
  },
  "request_id": "trace-request-id"
}
```

## 30.4 POST /v1/admin/matches/:match_id/retry-settlement

本节冻结决策顺序、目标复用、错误映射与成功响应。前置拒绝优先于目标选择；任何前置拒绝都不得新建 settlement、settlement_items 或积分。

### 决策表

| 状态/条件 | 目标 | HTTP + code |
|---|---|---|
| 未提供可信管理员身份，或身份不是 active admin | 无 | `401 UNAUTHORIZED` 或 `403 FORBIDDEN` |
| `match_id` 非法 UUID | 无 | `422 VALIDATION_ERROR`；不调用 application |
| 管理员写接口限流命中 | 无 | `429 RATE_LIMITED`；不调用 application |
| match 不存在 | 无 | `404 MATCH_NOT_FOUND` |
| match 为 `settling` 或 `correcting`，或同一 match 存在任意 `status=running` 的 settlement | 无；优先于 failed target 选择 | `409 SETTLEMENT_ALREADY_RUNNING` |
| match 为 `failed`，存在结构合法的 failed target，`is_correction=false` | 选择 `result_version > settled_result_version` 的最小未处理 failed settlement；复用原 settlement 与 items；match `failed -> settling` | `200` |
| match 为 `failed`，存在结构合法的 failed target，`is_correction=true` | 同上；复用原 correction settlement 与 items，使用其 immutable `result_version`；match `failed -> correcting` | `200`；不得跳到当前最新 result_version |
| match=`waiting` 且存在结构合法的 failed target | 按同一最小未处理版本选择并复用 target；普通 target 按既有状态机进入 `settling` | `200`；不新增 settlement 或积分规则 |
| 没有 failed settlement，且 `match.settlement_status != failed` | 无 | `409 SETTLEMENT_NOT_READY` |
| `match.settlement_status=failed`，但找不到对应 failed settlement | 无 | `500 INTERNAL_ERROR`；不得新建 settlement 或积分 |
| failed target、settlement 版本序列、`rule_version`、`is_correction` 或其他目标数据冲突 | 无；Fail Closed，不猜测目标 | `500 INTERNAL_ERROR`；不得新建 settlement 或积分 |
| match=`settled` 且 failed target 已处于 settled 版本范围，或 settled 快照与当前版本不一致 | 无；Fail Closed，不回退已结算版本 | `500 INTERNAL_ERROR`；不得新建 settlement 或积分 |
| 存在 failed target，但 match 状态无法按既有状态机转移（例如当前已是 `pending`） | 无 | `409 MATCH_STATE_CONFLICT`；不处理 items |

「结构合法」至少要求：不存在中间版本缺失、同版本重复和数据互相冲突；failed target 必须属于该 match，且 `result_version > settled_result_version`。普通与 correction retry 均只处理 pending/failed items，已 applied item 只计入 `skipped_applied_count`。

correction retry 必须：复用原 settlement 与 settlement_items；保留已 applied item，只处理 pending/failed item；使用该 settlement 自己的 immutable `result_version`；成功后若仍有更高未处理 `result_version`，match 保持 `correcting`，否则 `settled`。

成功响应 `200`：

```json
{
  "data": {
    "match_id": "uuid",
    "settlement_id": "uuid",
    "result_version": 2,
    "outcome": "settled",
    "processed_count": 10,
    "skipped_applied_count": 487,
    "audit_id": "uuid"
  },
  "request_id": "trace-request-id"
}
```

`outcome` 枚举：`settled` / `failed`。正常处理完成或处理后失败都返回本节 `200` 成功 Envelope；错误响应继续使用统一错误 Envelope。

## 30.5 POST /v1/admin/rebuild/users/:user_id

从事实数据重建（第 35.1 节 + 第 17.9.3 节）：

- career stats。
- 所有 season stats（含等级赛季 `user_season_stats`）。
- career 与各未冻结赛季的等级状态（`replay_level`，第 17.9.2 节）。
- 不删除历史 unlock。
- 必须写 `admin_audit_logs`（固定系统 reason，第 30.1 节）。

成功响应 `200`：

```json
{
  "data": {
    "user_id": "uuid",
    "rebuilt_season_count": 1,
    "level_state_changed": false,
    "audit_id": "uuid"
  },
  "request_id": "trace-request-id"
}
```

## 30.6 POST /v1/admin/rebuild/rankings

Request：

```json
{
  "board": "week",
  "period_key": "2026-W32",
  "reason": "一致性修复"
}
```

- `board=week`：`period_key` required，按第 35.2 节从事实数据全量重建该周期 `rankings`。
- `board=career`、`board=strength` 或 `board=season`：禁止携带 `period_key`（携带则 `422 VALIDATION_ERROR`），按第 35.4 节全量重建对应 `board_snapshots` 最新版本。
- `reason` 必填 1..500（第 30.1 节）。

成功响应 `200`：

```json
{
  "data": {
    "board": "week",
    "period_key": "2026-W32",
    "rebuilt_entry_count": 123,
    "audit_id": "uuid"
  },
  "request_id": "trace-request-id"
}
```

`board != week` 时响应 `period_key` 为 `null`。

---

# 31. API-Football Adapter

## 31.1 只允许读取

MVP 只使用：

- 赛程。
- kickoff。
- status。
- 球队。
- round。
- 正式比分。

覆盖第 1.4 节全部六联赛：每个 Provider 请求按 `api_football_league_id` + `api_football_season`（第 1.4 节表）分别发起，返回结果按映射写回对应 `league_id`；不得跨联赛复用同一响应。

禁止调用：

- Odds。
- Bookmaker。
- Bet。
- 任何博彩市场接口。

## 31.2 Fixture 时间

优先使用 Provider 的 UTC timestamp/明确时间字段转为 UTC Date。

请求 Provider 时尽量显式使用 UTC timezone。

若 `fixture.timestamp` 与 `fixture.date` 解析结果偏差超过 60 秒：

- `PROVIDER_DATA_INVALID` anomaly。
- 不自动更新 kickoff。

## 31.3 Provider status 映射

API-Football short status 映射：

```text
TBD  -> scheduled, kickoff_confirmed=false
NS   -> scheduled, kickoff_confirmed=true

1H   -> live
HT   -> live
2H   -> live
SUSP -> live
INT  -> live
LIVE -> live

PST  -> postponed

CANC -> cancelled
AWD  -> cancelled
WO   -> cancelled

ABD  -> abandoned

FT   -> finished
```

MVP 六联赛不应出现：

```text
ET
BT
P
AET
PEN
```

出现时：

- 保存原 Provider 状态。
- 创建 `UNEXPECTED_PROVIDER_STATUS` blocking anomaly。
- 不自动进行正式结算。
- 不根据加时/点球比分猜 regular score。
- 等管理员处理。

## 31.4 正式比分抽取

只有 Provider status `FT`：

- `regular_home_score = score.fulltime.home`
- `regular_away_score = score.fulltime.away`

必须均为 integer 0..99。

不得使用：

- `goals.home/away`
- 当前 live score
- halftime score
- extratime score
- penalty score

作为 MVP 正式结算比分。

## 31.5 Provider 数据缺失

任何关键字段缺失：

- 不清空数据库已有可信值。
- 保存错误快照。
- 记录 anomaly（若影响业务）。
- 本轮同步该实体视为失败。

## 31.6 Provider stale response

不得让可信业务状态回退。

例如内部 finished，Provider 返回 live：

- 不覆盖。
- `PROVIDER_STATE_CONFLICT`。
- blocking anomaly。
- 保存快照。

## 31.7 home/away/team 变化

如果 Provider 对同 provider_match_id 修改主客队：

### 尚无任何 prediction，且 scheduled

允许更新 team_id 映射后的 home/away。

### 已存在 prediction 或已开赛

禁止自动覆盖。

创建：

```text
TEAM_CHANGE_AFTER_PREDICTION
```

blocking anomaly。

## 31.8 Provider result correction

当前 `result_source = provider` 且 Provider 后续 FT regular score 与当前不同：

1. 创建下一 `match_results` version。
2. `result_version += 1`。
3. 更新 current regular score。
4. 若此前已 settled，进入 correcting 队列。
5. 若仍 waiting 且首次 settlement 未开始，保护期结束时可直接结算最新 version。

当前 `result_source = admin`：

- 禁止 Provider 覆盖。
- 只记录冲突。

## 31.9 业务时钟契约

Provider 同步入口（单 fixture 应用及其直接调用边界）的业务时钟语义：

- 同步入口的 `server_now` 必须是可信服务端传入的有效时间点（值有效、非 `NaN`），并作为本次同步调用的唯一业务时钟。入口及其直接下游在同一次调用中必须使用同一个 `server_now`；不得重新读取本地墙钟。已组装的 Provider job runner 也必须把收到的 `server_now` 原样传给 fixture loader 和单 fixture 应用逻辑。
- Provider payload 中的 kickoff/status/score 时间或事实仍按第 31.2–31.8 节解析；它们是 Provider 数据，不得被 `server_now` 替换，也不得反过来作为服务端业务时钟。
- 以下判断和事实时间必须由注入的 `server_now` 决定：
  - scheduled 到达 `prediction_deadline_at` 的关闭判断，以及 live/finished 触发的立即关闭（第 6.5 节）；
  - 成功同步后对 `LIVE_SYNC_STALE`、`LIVE_TOO_LONG`、`FINISHED_NO_SCORE` 等已定义时间谓词的评估（第 33 节）；
  - 本次 Provider 观察产生或更新的 `matches`、`match_results`、`provider_snapshots`、`anomalies` 及相关事实时间字段，包括 `created_at`、`updated_at`、`prediction_closed_at`、`finish_detected_at`、`resolved_at`；
  - 若按同步窗口筛选 fixture，窗口起点、终点和本轮筛选也必须从传入的 `server_now` 计算。
- `server_now` 无效时，入口必须 Fail Closed，返回 `422 VALIDATION_ERROR`（`field=server_now`），并在事实写入、锁获取、Provider IO 或其他业务推进前停止。
- 遇到规范没有定义的时间组合时，不得猜测时间、继续写入或改变 Provider 结果；应 Fail Closed 并记录为待处理异常。
- 状态映射、Provider 数据合法性、状态回退、球队/开球变更保护和正式比分来源继续遵守第 31.1–31.8 节及既有状态机；本节不新增状态或 Provider 特殊处理。

---

# 32. 数据同步任务

以下 `future_schedule` / `full_schedule_verify` / `near_match` / `live_match` / `post_finish_verify` 五类任务均针对 `SUPPORTED_LEAGUES`（第 1.4 节）中每个联赛分别执行（可实现为单任务遍历六联赛，也可按联赛并行），互不影响彼此的 lease 与 `sync_logs`；job_type 枚举不按联赛拆分。

## 32.1 future_schedule

未来 30 天六联赛赛程：

```text
每 6 小时
```

## 32.2 full_schedule_verify

六联赛当前 active season 完整赛程：

```text
每天至少 1 次
```

## 32.3 near_match

```text
T-24h ～ T-2h：
每 30 分钟
```

## 32.4 live_match

```text
T-2h ～ finished：
每 3 分钟
```

## 32.5 post_finish_verify

首次发现 finished 后：

- 保持高频确认直到首次 settlement 开始。
- settled 后仍由 daily full verify 捕捉后续正式比分修正。

## 32.6 period_finalize

每小时执行一次。

对已经满足：

```text
period_end <= server_now
```

的 `week` rankings 文档（月榜已取消，不再有 month 周期需要 finalize）：

```text
is_final = true
```

历史 correction 不得将其改回 false。

## 32.7 job lock：获取、续租与接管

每个 `job_type` 只使用同类任务锁 key：

```text
sync:{job_type}
```

### 获取与跳过

1. `server_now` 必须先通过既有有效时间校验；无效时在获取锁、写日志、loader 和 fixture 写入前 Fail Closed（第 31.9 节）。
2. 每次成功尝试使用新的 `owner_id`，初次 `lease_until = server_now + JOB_LEASE_MINUTES`（当前固定配置 `JOB_LEASE_MINUTES=10`）；该初次 lease 时间是本次任务 lease 的合同输入，不使用进程墙钟。
3. 锁获取必须保持原子 compare-and-set。获取失败表示已有未过期 owner：本次 job 返回 `skipped(lock_held)`，不调用 loader、不写 `sync_logs`，也不创建第二套业务写入。

### 续租与事实时间

- 成功获取锁后，job 在每个 lease 时长的一半到达时尝试续租（当前固定配置下为获取后 5 分钟）；续租使用 `lease_until = 续租时刻 wall-clock now + 10 分钟`。该 wall-clock 只用于定时触发和计算锁的操作性到期边界；`load(server_now)`、fixture 应用、`sync_logs.started_at/finished_at` 等业务事实时间仍全部使用同一次注入的 `server_now`，不得由续租墙钟替代。
- 续租只允许当前 owner 且 lease 尚未到期时成功；返回失败或抛异常均视为续租失败。首次观察到续租失败后立即停止后续定时续租尝试。

### 续租失败后的停止边界

续租健康状态在以下边界检查：每次 loader 调用开始前；每个 fixture 应用调用开始前；成功 `sync_log` 更新开始前。续租失败或异常被观察后，job 在下一个检查点记录 `INTERNAL_ERROR`，不再开始新的 loader、fixture 应用或 success log 写入；已开始且正在等待的异步调用不被强行取消；job 进入 failed log 路径，记录 `finished_at=server_now` 和最终错误，并释放自身 owner 的锁。

### 释放与接管

- 只有成功获取锁的本次 job 才释放自身锁；release 对非 owner 为空操作，一个 job 不得释放其他 owner 的 lease。
- 同一 `lock_key` 在 `lease_until` 未到期时拒绝其他 owner；到期后新 owner 可通过同一原子 acquire 接管。续租失败的旧 owner 不得恢复或覆盖已被新 owner 接管的 lease。

## 32.8 loader 重试、jitter 与 sync_logs

### 错误分类

| loader 错误 | 是否 retry | 规则 |
|---|---:|---|
| `ProviderHttpError` 且 `status=408` | 是 | 暂时 HTTP 错误 |
| `ProviderHttpError` 且 `status>=500` | 是 | 暂时 Provider HTTP 错误 |
| 普通 `Error`，不属于 `DomainError`/`ProviderError` | 是 | 普通网络/暂时错误 |
| `ProviderQuotaExceededError`（含 HTTP 429） | 否 | 停止本次高频自动 retry |
| `ProviderDataError` | 否 | Provider 数据错误 Fail Closed |
| 其他 `ProviderError` | 否 | 未声明为暂时错误 |
| `DomainError` | 否 | 应用/校验错误 Fail Closed |
| 其他 `ProviderHttpError` status | 否 | 只有 408 和 `status>=500` 属于本合同 retry 集合 |

单 fixture 应用阶段的失败不进入 loader retry。

### 尝试次数与等待

一次 job 先立即执行第 1 次 loader 调用。可 retry 错误最多安排 5 次 retry，因此最多发生 6 次 loader 调用；每次 retry 在下一次 loader 调用前按以下基准序列等待：

```text
retry 1: 1m
retry 2: 2m
retry 3: 5m
retry 4: 10m
retry 5: 30m
```

第 6 次调用仍失败时不再等待，直接记录为最终失败。不可 retry 错误不等待，直接结束本次 job。`attempt_count` 统计实际 loader 调用次数，不统计等待次数；该 retry 规则不扩大到 scheduler 或其他任务的 lease。

### Jitter

每次等待先将分钟数转换为毫秒 `base_ms`，再计算：

```text
Math.round(base_ms * (1 + 0.20 * (2 * random() - 1)))
```

边界按 `random=0/0.5/1` 固定为 `0.8/1.0/1.2 * base_ms`，结果取整数毫秒；随机源每次实际等待调用一次。

### `sync_logs` 最小可观察语义

成功取得 job lock 后、首次 loader 调用前插入一条 `status=running` 日志：`attempt_count=1`、`finished_at=null`、`items_read/items_changed/items_failed=0`、错误字段为 `null`。loader retry 发生时，在等待前更新同一日志为 `running`，写入当前失败后的 `attempt_count`、`last_error_code`、`last_error_message`，不写 `finished_at` 或虚构 item 统计。

loader 成功后更新为 `success`，`attempt_count` 为实际总尝试次数，`finished_at=server_now`，写入本批次 item 统计并清空错误字段。不可 retry 或 retry 耗尽后更新为 `failed`，`attempt_count` 为实际总尝试次数，`finished_at=server_now`、`items_failed=1`，并保留最终错误 code/message。Quota 错误因此只产生一次 loader 尝试和最终失败日志；锁未取得时仍跳过且不创建 sync log。

Quota exceeded：停止本次高频自动重试；等 Provider 明确 reset 时间，若无明确信息，等待下一正常 scheduled run；不用密集请求撞 quota。

## 32.9 weekly_level_eval

每周一 10:10（Asia/Shanghai，即 `LEVEL_EVAL_SCHEDULE + LEVEL_EVAL_START_DELAY_MINUTES`）触发一次，对第 17.6.3 节评估对象执行 `evaluate_level`（career 与各未冻结等级赛季 season 分别评估）。使用 job lock `sync:weekly_level_eval`；同一 `as_of` 对同一用户同一 scope 幂等。

## 32.10 level_correction_reeval

由 correction settlement 进入 `phase=done` 触发（第 17.7 节），对受影响用户执行修正重评。使用 job lock `sync:level_correction_reeval`；同一用户同一 scope 的周评估与修正重评按 `as_of` 顺序串行，周评估任务未完成前产生的修正重评任务延后到周评估完成后执行。

## 32.11 board_snapshot_career

每 `CAREER_BOARD_SNAPSHOT_MINUTES=60` 分钟执行一次，从 `users` 当前 `career_points`/`career_exact_hits`/`career_valid_predictions`/`career_last_scoring_match_at` 全量生成生涯榜快照，写入 `board_snapshots(board=career)`。使用 job lock `sync:board_snapshot_career`。

## 32.12 board_snapshot_strength

每次 `weekly_level_eval` 完成后触发一次，另每日固定执行 1 次（吸收修正重评的影响），从等级评估缓存 `last_eval_n`/`last_eval_score_sum` 全量生成实力榜快照，写入 `board_snapshots(board=strength)`。使用 job lock `sync:board_snapshot_strength`。

## 32.13 board_snapshot_season

每 `SEASON_BOARD_SNAPSHOT_MINUTES=60` 分钟执行一次，从当前等级赛季各用户 `user_season_stats` 的 `points`/`exact_hits`/`valid_predictions`/`last_scoring_match_at` 全量生成赛季榜快照（仅 `valid_predictions ≥ SEASON_BOARD_MIN_VALID`），写入 `board_snapshots(board=season, level_season_id=当前)`。使用 job lock `sync:board_snapshot_season`。等级赛季边界（`LEVEL_SEASON_BOUNDARY`）之后的首次执行切换到新的 `level_season_id`。

## 32.14 board_snapshot_season_final

某等级赛季完成**最终评估**（第 17.8.4 节：赛季结束后的第一次周评估，`is_level_frozen` 置位）后触发一次，从该赛季 `user_season_stats` 全量生成赛季终榜，写入 `board_snapshots(board=season, level_season_id=该赛季, is_final=true)`。终榜 `snapshot_at` 与接口 `updated_at` 均取该赛季的 `seasonFinalEvalAsOf`，任务运行时刻只用于锁租约。使用 job lock `sync:board_snapshot_season_final`；先以 `findFinalBySeason(level_season_id)` 判断幂等，已存在则直接返回；若写入撞上保留的 `UNIQUE(board, snapshot_at, user_id)`，返回内部错误且不覆盖。终榜生成后不可变，不参与榜单重建与每日一致性对账（第 19.11 节）。

---

# 33. 同步异常规则

## 33.1 LIVE_SYNC_STALE

正在 live 的 match 连续 10 分钟无法成功同步：

- open anomaly。
- `blocking=false`（尚未进入结算）。
- 恢复成功后可自动 resolve。

## 33.2 LIVE_TOO_LONG

```text
server_now >= period_anchor_at + 150min
AND match_status == live
```

open anomaly。

## 33.3 FINISHED_NO_SCORE

首次 finished 后 20 分钟仍无合法 regular score：

- blocking=true。
- 不结算。

## 33.4 INVALID_FINAL_SCORE

FT 但 fulltime score：

- null。
- 非整数。
- <0。
- >99。

blocking=true。

## 33.5 状态冲突

禁止状态回退：

- blocking=true。
- 不覆盖现有状态。

## 33.6 anomaly resolve

只有触发条件已经消失或管理员明确处理后才 resolve。

自动 resolve 必须由对应 anomaly type 的确定性规则实现；不得“一段时间没报错就默认恢复”。

---

# 34. 排行榜与等级增量更新与全量校验

## 34.1 settlement item 应用（week 榜）

每个首次有效 prediction：

- 更新对应 `week` rankings doc（月榜已取消，不再更新 month）。

没有文档则创建。

## 34.2 correction（week 榜）

使用 delta 更新：

```text
period_score
wdl_hits
exact_hits
```

`valid_predictions` 不变。必要时重算 `last_scoring_match_at`（第 15.7 节）。

## 34.3 global rank（week 榜）

某场 settlement 所有 item applied 后：

- 受影响 `week` 全量重新排序并写 `global_rank`（比较器见第 19.5 节）。

不满足 `WEEK_BOARD_MIN_VALID(1)` 场的：

```text
global_rank=null
```

## 34.4 career / strength / season 快照更新

- `career` 榜：不做逐场增量更新，由第 32.11 节 `board_snapshot_career` 定期全量生成快照。
- `strength` 榜：不做逐场增量更新，由第 32.12 节 `board_snapshot_strength` 在每次 `weekly_level_eval` 完成后与每日定时生成快照。
- `season` 榜：不做逐场增量更新，由第 32.13 节 `board_snapshot_season` 定期全量生成快照。
- 三者的排序与入榜门槛见第 19.1/19.5/19.9 节；快照生成不得实时全量扫描 `predictions`（第 42.1 节），只读 `users`/`user_season_stats` 当前缓存字段或等级评估缓存 `last_inputs`。

## 34.5 每日全量校验

每天至少一次，从事实数据重算并比较：

- `users` career cache（含 `career_level`/`career_best_level`/`career_level_state`，第 17.9.4 节）。
- `user_season_stats`（含等级状态）。
- `week` rankings。
- `board_snapshots`（`career`/`strength`/`season`，抽样比对）。
- `last_scoring_match_at`（career 与 week）。
- `global_rank`。

MVP 策略：

> **发现不一致只报警，不自动静默修复。**

一致性校验不得对正在 `settling/correcting` 的 match 及其受影响用户/周期做最终一致性判断；必须跳过并记录 `skipped_active_settlement`，下一轮再校验。

等级部分的校验规则见第 17.9.4 节；周中「缓存等级 ≠ 按当前账本即时计算的结果」不是差异。管理员确认后使用明确 rebuild（第 35 节）。

---

# 35. Rebuild 规范

## 35.1 rebuild_user_stats(user_id)

Source：

- `status=applied` 的 settlement_items 是积分/命中变化账本。
- prediction 的原始预测比分是事实；prediction 上 `match_score/wdl_hit/exact_hit` 属于当前状态缓存。
- match_results 是正式赛果版本事实。
- matches 用于 season / period 归属与状态校验。

精确重建公式：

```text
career_points =
  SUM(applied settlement_items.score_delta)

career_valid_predictions =
  SUM(applied settlement_items.valid_prediction_delta)

career_wdl_hits =
  SUM(
    int(new_wdl_hit) - int(old_wdl_hit)
  )

career_exact_hits =
  SUM(
    int(new_exact_hit) - int(old_exact_hit)
  )
```

`user_season_stats` 使用同一账本公式，但按 `prediction.match_id -> matches.period_anchor_at -> level_season_of(...)`（第 17.8.1 节）分组，不按联赛自身 `season_id` 分组。

`rebuild_user_stats` / `rebuild_period_rankings`（第 35.2 节）/ daily consistency（第 34.5 节）的**期望值**必须以「`status=applied` 的 `settlement_items` + `match.period_anchor_at` 归属规则 + 既有 `unlock`/`level_history` 只增不减规则」为唯一事实源；**不得**以 raw `predictions` 文档上的缓存命中字段作为 rebuild 唯一输入（可用 `predictions` 做辅助对账，冲突时以 item 为准，daily consistency 只报警不自动改账本）。

重建：

- career points、career valid predictions、career hits、career exact。
- 全部 `user_season_stats`（按等级赛季分组，含 `points/valid_predictions/wdl_hits/exact_hits`）。
- career 与各未冻结等级赛季的等级状态按 `replay_level`（第 17.9.2/17.9.3 节）回放；已冻结赛季同样回放到其最终评估为止。回放结果与缓存不同 ⇒ 覆盖缓存，并写一条 `level_history(reason=rebuild)`（允许跨多级，这是纠错）。
- `career_best_level = max(现有 career_best_level, level_history.to_level 历史最大值, 回放轨迹最大值)`，普通 rebuild 不允许下降；`user_season_stats.best_level` 同理。
- unlock 不删除。

## 35.2 rebuild_period_rankings(board, period_key)

本节只适用于 `board=week`；`career`/`strength`/`season` 快照重建见第 35.4 节。

事实计算来源：

1. 根据 `match.period_anchor_at` 选出属于该 ISO 周的比赛。
2. 对这些比赛的 `status=applied` settlement_items 求 delta 累积。
3. `valid_predictions` 使用 `valid_prediction_delta` 之和。
4. `period_score` 使用 `score_delta` 之和。
5. `wdl_hits/exact_hits` 使用 old/new bool delta 之和。
6. `last_scoring_match_at` 对每个 prediction 取最高 `source_result_version` 的 applied item；其 `new_score > 0` 时，对对应 `match.period_anchor_at` 取最大值。

不得以 `rankings` 旧值作为 rebuild 输入。全量计算 `period_score`、`valid_predictions`、`wdl_hits`、`exact_hits`、`last_scoring_match_at`、`global_rank`（比较器见第 19.5 节）。`rebuild_period_rankings` 后必须与「`applied settlement_items` + period 归属规则」完全一致（不是与未结算 `prediction` 缓存值一致）。

## 35.3 rebuild 并发前提

管理员执行普通 rebuild 前必须满足：

- 目标用户/目标周期不存在相关 `settling/correcting` match。
- 否则返回 `409 SETTLEMENT_ALREADY_RUNNING`。
- rebuild 使用对应 maintenance lock，避免两个 rebuild 并发覆盖。

## 35.4 rebuild_board_snapshot(board)

适用于 `board ∈ {career, strength, season}`（第 30.6 节）：

- `career`：从 `users` 当前 `career_points`/`career_exact_hits`/`career_valid_predictions`/`career_last_scoring_match_at` 全量重算排序（第 19.5 节比较器）并覆盖 `board_snapshots(board=career)` 最新版本。
- `strength`：从等级评估缓存 `last_eval_n`/`last_eval_score_sum` 全量重算排序并覆盖 `board_snapshots(board=strength)` 最新版本。
- `season`：从当前等级赛季 `user_season_stats` 全量重算排序（第 19.5 节比较器）并覆盖 `board_snapshots(board=season, level_season_id=当前)` 最新版本。
- 不保留被覆盖前的错误版本作为「当前版本」，但历史版本按第 37 节保留策略继续保留供对账。

## 35.5 rebuild_match_settlement

不得简单再次执行增量 `+=`。

普通 retry：

- 恢复已有 settlement 的未 applied item。

若事实数据严重损坏需要重新构建 settlement：

- 属于管理员数据修复流程。
- 必须有独立审计。
- 不在普通自动任务中执行。

---

# 36. 权限与防作弊

## 36.1 客户端禁止写核心数据库

前端不得直接写：

- users career fields（含等级字段）。
- matches。
- match_results。
- predictions。
- rankings。
- board_snapshots。
- groups / group_members（第 27.2 节 API 以外的直接写入一律禁止）。
- settlements。
- settlement_items。
- levels（`career_level_state` / `user_season_stats.level_state` / `level_history`）。
- unlocks。
- admin logs。

所有核心写入通过云函数 / API。

## 36.2 用户只能代表自己

用户 API 身份必须：

```text
trusted 微信上下文 -> openid -> user_id
```

禁止客户端传 `user_id` 作为“本人身份”。

## 36.3 管理员禁止直接改聚合

管理员不得：

- 直接修改 career_points。
- 直接修改 period_score。
- 直接修改 global_rank。
- 直接修改 level。
- 直接 INSERT settlement_item。
- 直接给用户加 unlock。

管理员只能通过：

- 赛果修正。
- retry。
- rebuild。

产生可审计的业务变化。

## 36.4 Rate Limit 默认值

服务端 middleware 默认：

```text
POST /predictions         10 requests/min/user
PATCH /profile/me         20 requests/min/user
POST /groups*             10 requests/min/user   # 创建/加入/退出/解散群
authenticated reads       120 requests/min/user
admin APIs                 60 requests/min/admin
public reads               120 requests/min/source
```

public source 可使用网关短期请求来源标识；禁止为了限流建立长期 IP 画像。

---

# 37. 数据生命周期

长期/永久保存：

- users 墓碑与业务统计。
- teams。
- matches。
- match_results。
- predictions。
- rankings（`week`）。
- settlements。
- settlement_items。
- unlocks。
- level_history。
- groups / group_members（解散/退出为软删除，不物理删除，第 19.4.2 节）。
- admin_audit_logs。
- 关键 provider_snapshots。
- anomalies。

赛季终榜（`board_snapshots` 中 `is_final=true`）永久保留，不适用本条清理。赛季榜另须保证：每个等级赛季的最后一版常规快照，在该赛季终榜生成之前不得清理（否则新赛季一周的小时快照可能挤掉它，上赛季临时榜无法展示，第 19.10.10 节）。生涯榜/实力榜/赛季榜（非终榜）快照（`board_snapshots`）：只保留最近一版 + 最近 N 版（N 为运维配置，用于对账），超出 N 版的历史快照可清理；当前生效的最新一版任何时候不得清理。

可清理：

```text
sync_logs: 30 days
board_snapshots: 保留最近一版 + 最近 N 版（运维配置）
普通 API request logs: 按运维配置
临时 trace logs: 按运维配置
```

不得清理会导致无法对账或无法重建积分、等级、排行榜的数据。

---

# 38. 环境隔离

必须有：

```text
dev
test
prod
```

完全隔离：

- 云数据库。
- 云环境 ID。
- Provider API key。
- 配置。
- admins。
- 定时任务。
- job locks。
- 日志。

禁止：

- test 调用 prod DB。
- dev settlement prod match。
- 不同环境共用业务 Collection。

---

# 39. 模块边界与依赖方向

推荐且冻结的逻辑边界：

```text
domain/
  ids
  time
  scoring
  levels
  ranking
  groups
  match-state-machine
  settlement-state-machine
  prediction-policy
  invariants

application/
  session
  matches
  predictions
  settlement
  correction
  ranking
  groups
  rebuild
  admin

providers/
  api-football/
    client
    mapper
    sync-service

infrastructure/
  db
  locks
  config
  logging
  transactions

api/v1/
  controllers
  validators
  error-mapper
```

依赖方向：

```text
api -> application -> domain
providers -> application/domain contracts
infrastructure implements application ports
domain 不依赖微信 SDK、CloudBase SDK、HTTP、API-Football
```

业务公式不得写在 controller 或 Provider mapper 中。

---

# 40. 核心 Invariants

以下任何一条违反都属于 bug / 数据损坏：

```text
career_points >= 0
career_valid_predictions >= 0

career_exact_hits <= career_wdl_hits
career_wdl_hits <= career_valid_predictions

user_season_stats.exact_hits <= wdl_hits
wdl_hits <= valid_predictions

rankings.exact_hits <= wdl_hits
wdl_hits <= valid_predictions

rankings.period_score >= 0

prediction.match_score is null OR in {0,3,12}

prediction.exact_hit == true => prediction.wdl_hit == true

每 user_id + match_id 最多 1 prediction

每 user_id + idempotency_key 最多 1 prediction

每 match_id + result_version 最多 1 match_result

每 match_id + result_version + rule_version 最多 1 settlement

每 settlement_id + prediction_id 最多 1 settlement_item

settlement_item.status=applied 的业务 delta 不得再次应用

prediction.applied_result_version 不得回退

matches.result_version 不得回退
matches.settled_result_version 不得回退
matches.settled_result_version <= matches.result_version

prediction_closed_at 一旦非 null 不得回到 null

period_anchor_at 一旦非 null 不得修改

finish_detected_at 一旦非 null 不得修改

已存在 unlock 不得因积分下降删除

# 等级（第 17 节）
1 <= level <= 6；best_level >= level；best_level 只增不减（career 与每个等级赛季）
level >= 2 => 对应 scope 有效预测累计 >= 20
非 rebuild 的相邻两次状态：|to_level - from_level| <= 1
同一 scope 同一评估周内：level <= week_base_level + 1
保护期内：level >= week_base_level
below_count ∈ {0,1}
level_history 仅在 from != to 时存在；reason ∈ {weekly_eval, correction_reeval, rebuild}
last_eval_n <= 300；0 <= last_eval_score_sum <= 12 × last_eval_n
is_level_frozen = true 的赛季：level/best_level 不再变化
任何等级阈值比较不得使用浮点或显示值

# 排行榜与群（第 19 节）
rankings（board=week）.valid_predictions >= 1 时才存在文档
board_snapshots 排序键使用原始整数，不持久化浮点排序键
groups.member_count == COUNT(group_members WHERE status=active)（允许短暂不一致，daily consistency 校验）
每 group_id + user_id 最多 1 条 group_members 记录
群主的 group_members 记录不得进入 status=left（只能通过解散群变为 groups.status=dissolved）
```

系统在事务前后应进行必要 invariant assertion。

---

# 41. Provider 与人工修改优先级

优先级：

```text
管理员正式结果 > Provider 后续不同结果
```

管理员修正后：

- Provider 仍继续同步状态/元数据。
- 不允许 Provider 覆盖 regular score。
- 不允许 Provider 创建新的正式 result_version。
- 差异只进入 anomaly + snapshot。

这条优先级不得由编码 Agent改变。

---

# 42. 非功能需求

## 42.1 性能

用户常用读取 API：

- 正常条件下目标 p95 服务端处理时间 <= 500ms（不含微信客户端网络）。
- 排行榜 Top20（本周榜、生涯榜、实力榜）必须走索引/预聚合或快照，不允许每次从所有 predictions 实时全量扫描（第 19.2/19.7 节）。
- 群榜（`scope=group`）基于全站榜数据按 `group_members` 过滤，过滤本身必须走索引，不得对全体用户做无索引扫描。

分享卡 round 统计允许实时查询，但必须按 `user_id + league_id/round_id` 通过索引筛选，禁止全库扫描。

## 42.2 结算

正常数据情况下：

- finished 后 10 分钟开始。
- 目标 finished 后 15 分钟内完成。
- 该目标不能以牺牲幂等、账本或错误检查为代价。

## 42.3 安全

- Provider API key 仅服务端环境变量。
- 微信身份只从可信上下文。
- 日志不得记录 access token、session key 等敏感凭据。
- 不建立无业务必要的设备指纹或长期 IP 画像。

## 42.4 等级评估

正常数据情况下：

- `weekly_level_eval` 目标在 `as_of + LEVEL_EVAL_START_DELAY_MINUTES` 后尽快开始，覆盖全部评估对象（第 17.6.3 节）。
- 单用户单 scope 的 `evaluate_level` 计算必须是窗口有界操作（`n <= 300`），不得随生涯预测总数线性增长导致超时。
- 该目标不能以牺牲幂等、账本或第 17.9 节确定性回放为代价。

---

# 43. 编码交付物

后端核心代码阶段必须同时交付：

1. TypeScript domain types。
2. 数据库 Collection schema 定义。
3. 数据库 index 创建脚本/说明。
4. 状态机实现与测试。
5. time/period 工具与测试。
6. prediction policy 与测试。
7. scoring_v1 与测试。
8. level 计算（`evaluate_level` / `build_level_inputs` / `replay_level`）与测试。
9. ranking comparator（week/career/season、strength 两套）与测试。
10. Provider adapter 与 mapper 测试（覆盖六联赛）。
11. settlement orchestration。
12. settlement item 幂等 transaction。
13. correction orchestration（含第 17.7 节修正重评）。
14. rebuild services（含等级回放重建、board_snapshots 重建）。
15. group service（创建/加入/退出/解散）与测试。
16. API validators。
17. API error mapper。
18. OpenAPI v1 文件。
19. 定时任务配置（含 weekly_level_eval / level_correction_reeval / board_snapshot_career / board_snapshot_strength / board_snapshot_season）。
20. anomaly service。
21. admin audit service。
22. 数据 migration/version 基础设施。
23. 全套验收测试。

不得只提交“能跑”的业务代码而没有测试、索引与 schema。

---

# 44. 验收测试矩阵

以下为最低测试集合；全部通过才可认为核心业务完成。

## A. 预测与比分

1. 预测 2:1，实际 2:1 => 12。
2. 预测 2:1，实际 3:1 => 3。
3. 预测 2:1，实际 1:1 => 0。
4. 预测 0:0，实际 0:0 => 12。
5. exact_hit=true 时 wdl_hit 必须 true。
6. 预测 -1 拒绝。
7. 预测 21 拒绝。
8. 字符串 `"2"` 拒绝。
9. `2.5` 等非整数拒绝；JSON `2.0` 解析为整数值 2 时允许。
10. 用户提交 derived_result 字段拒绝。

## B. 截止时间

11. deadline 前 1ms 可提交。
12. 恰好 deadline 拒绝。
13. deadline 后拒绝。
14. 修改客户端手机时间不能绕过。
15. live 提前出现时立即永久关闭。
16. finished 首次发现时若仍未关闭，立即关闭。

## C. 延期

17. 截止前延期，未提交用户在重新 scheduled 后可预测。
18. 截止前延期，已有用户预测保留且不可改。
19. 截止后才发现延期，先按旧 deadline 永久关闭。
20. 截止后延期到未来一个月也不得重新开放。
21. 延期跨周，未开赛 anchor 为空，最终归延期后新周。
22. 延期跨等级赛季边界（6 月 30 日 → 7 月 1 日北京时间），最终按延期后 anchor 归属新等级赛季（不影响 `round_id`，第 17.8.1 节）。
23. 延期仍保留原 round_id。

## D. 并发与幂等

24. 两个并发首次预测只有一条成功创建。
25. 相同 idempotency_key + 相同 payload 返回第一次结果，不重复。
26. 相同 idempotency_key + 不同比分 => 409。
27. 不同 idempotency_key + 同 match => 409。
28. session 并发创建同 openid 只有一个 active user。

## E. 状态机

29. scheduled -> live 合法。
30. scheduled -> finished 合法（错过中间轮询）。
31. live -> finished 合法。
32. scheduled -> postponed 合法。
33. postponed -> scheduled 合法。
34. live -> abandoned 合法。
35. abandoned -> finished 合法。
36. finished -> live Provider 自动回退禁止并报警。
37. cancelled -> scheduled Provider 自动回退禁止并报警。

## F. 无效比赛

38. cancelled 不计分、不计有效场次。
39. cancelled settlement_status=voided。
40. abandoned 不结算。
41. abandoned 后 finished 可进入正常结算。
42. AWD/WO 被业务视为 cancelled，不计统计。

## G. Provider 数据

43. FT + fulltime 合法比分可以创建 result v1。
44. FT 无 fulltime => blocking anomaly，不结算。
45. FT fulltime 负数/非整数 => blocking anomaly。
46. live goals 不得被当正式比分。
47. Provider 返回未知状态 => anomaly，不猜状态。
48. 某联赛返回 AET/PEN => blocking anomaly，不自动结算。
49. finished 后 Provider 返回 live => 不回退。
50. admin result 后 Provider 不同比分 => 不覆盖。
51. 有 prediction 后 Provider 改主客队 => blocking anomaly。
52. 无 prediction 且 scheduled 时 Provider 改主客队可更新。

## H. result_version

53. 初始 result_version=0。
54. 首次正式比分 => 1。
55. 重复相同比分不增加 version。
56. 2:1 -> 1:1 => version +1。
57. v1/v2/v3 match_results 均永久存在。
58. waiting 内 v1->v2->v3，首次 settlement 可直接结算 v3。
59. v1 settlement 已开始后 v2/v3 必须顺序处理。

## I. 结算幂等

60. 同 settlement 执行两次积分只变化一次。
61. 同 settlement_item applied 后再次处理无业务变化。
62. 1000 人结算第 488 条失败，前 487 条不重复。
63. retry 从 failed/pending item 继续。
64. 无预测比赛也能最终 settled。
65. settlement running 时第二个同 match worker 无法取得锁。

## J. 修正

66. 12 -> 3 => -9。
67. 3 -> 0 => -3。
68. 0 -> 12 => +12。
69. correction 不改变 valid_predictions。
70. correction 后 career stats 正确。
71. correction 后 season stats（等级赛季口径）正确。
72. correction 后 week stats 正确。
73. correction 后触发第 17.7 节修正重评，等级改判结果正确（不额外产生第二次升级）。
74. correction 后 current level 可以下降（改判，非当周额外降级）。
75. correction 后 career_best_level 不下降。
76. correction 后已解锁装扮不回收。
77. 被修正 match 原是 last_scoring，变 0 后正确找到新的 last_scoring 或 null。

## K. 排行榜（第 19 节）

78. 本周 1 场有效预测 => 进入本周榜（`WEEK_BOARD_MIN_VALID=1`）。
79. 本周榜同分 → `exact_hits` 多者优先 → 有效预测数少者优先 → `last_scoring_match_at` 早者优先 → `user_id` 顺序正确。
80. 实力榜窗口 `n=49` => 不上榜，`remaining_valid_predictions=1`。
81. 实力榜 `s` 相同（交叉乘法相等）=> 窗口 `n` 多者优先。
82. 「我的名次」`r=21`，`N=1000` => `rank=null`，`top_percent=3`。
83. 「我的名次」`r=N=25` => `top_percent=99`（clamp）。
84. 群榜：仅成员参与排序；名次群内独立计算；退群后立即从群榜消失。
85. 请求 `board=month` 或非法 `board` => `422 VALIDATION_ERROR`。
86. 排行榜响应中出现任何准确率字段 => 视为失败。
87. 第 3 页请求 => 返回空列表且 `next_cursor=null`。
88. 历史周榜 `is_final=true` 后 correction 仍可改变历史 rank；北京时间周日/周一边界与 ISO week-year 跨年正确。

## L. 等级（第 17 节）

89. `n=0` => `s` 精确等于 `170/100`；判定式无除零。
90. 有效预测 15 场全中（`S=180`）=> Lv1（未评级）。
91. 第 20 场于周一 10:05 applied => 当周评估仍 Lv1；下周一 Lv2。
92. Lv1、一周内 60 场、`s=2.5`、`B=150` => 当周只到 Lv2；下周 Lv3；Lv4 需 `B>=170`。
93. `S+68` 与 `(n+40)` 使 `s=1.7999…` => 不升 Lv3（交叉乘法），展示 `"1.79"`。
94. 400 场、场均 1.5（窗口 300，`S=450`）=> `s≈1.524`，永远 Lv2。
95. 60 场、场均 2.6（`S=156`）=> `s=2.24`；`B=156<170` => 最高 Lv3。
96. 只过 A（`s` 达标）不过 B（积分不达标）=> 不升；降级计数清零。
97. 只过 B 不过 A => 停在当前级。
98. Lv4，`s` 低于 1.85 一次后回升 => 不降，计数清零。
99. Lv4，连续 2 周低于 1.85（保护期外）=> 第 2 周降为 Lv3，计数清零。
100. 同上但在保护期内 => 不降，计数不累加。
101. Lv2，`s=1.0` 持续 10 周 => 仍 Lv2。
102. 周一升 Lv4，周三修正使条件不再满足 => 改判回 Lv3，写 `correction_reeval`，原 `weekly_eval` 行保留；`best_level` 仍为 4。
103. 周一未升，周三修正后满足升级 => 立即升一级；本周不得再升。
104. 修正使 B 跌破当前级 B 线 => 不降级。
105. 同一 `as_of` 周评估执行两次 / 中断续跑 => 结果与 history 不重复、不变化。
106. 任务在 `as_of` 后 3 小时才运行 => 结果与准时运行完全相同。
107. 全量回放（`replay_level`）vs 线上缓存 => 完全一致。
108. 窗口：310 场中最早 10 场被剔除；anchor 早于 730 天者被剔除 => `n`、`S` 正确。
109. 等级赛季边界：6/30 23:59 北京时间 anchor 的比赛 => 归属旧等级赛季。
110. 已冻结等级赛季内比赛发生修正 => 赛季积分更新；赛季等级不变；career 重评。
111. 新等级赛季首场结算 => 新 `user_season_stats` `level=1`，不写 history。
112. 模板策略回测（1-0 主胜 / 1-1 / 热门 2-1）=> 任一模板逐周滚动回测中不得在 Lv5 保级线之上稳定停留（第 17.13 节发布门禁）。
113. 取消/腰斩未完场比赛 => 不进窗口、不计 B。
114. 用户注销 => 停止评估，等级冻结；私有接口 409。

## M. 注销与权限

115. 注销后原 openid 从用户事实身份中移除。
116. 注销历史 prediction 保留。
117. 注销历史排行榜保留。
118. 公开显示名为 已注销用户。
119. 同 openid 再注册创建新 user_id。
120. 客户端传 user_id 不能冒充其他用户。
121. 非管理员调用 admin API => 403。
122. 管理员不能通过 API 直接编辑积分。

## N. Rebuild 与一致性

123. rebuild_user_stats 后与 applied ledger 完全一致（含等级回放，不以未结算 prediction 缓存值为准）。
124. rebuild_period_rankings 后与 applied settlement_items + period 归属规则完全一致（不是与未结算 prediction 猜测值一致）。
125. daily consistency 发现差异只报警，不自动修改。
126. unlock 不因普通 rebuild 删除。
127. sync 网络失败不得改变比赛状态。
128. Provider 不完整响应不得把已有可信字段清为 null。

---

# 45. Definition of Done

核心逻辑只有在以下全部满足后才算完成：

- 所有 Collection schema 已落实。
- 所有唯一索引、查询索引已落实。
- 所有状态转移均有自动测试。
- 所有时间边界均有自动测试。
- 所有预测幂等测试通过。
- 所有 settlement 幂等与部分失败测试通过。
- 所有 correction 测试通过。
- 排行榜 tie-breaker 测试通过。
- API OpenAPI 与实际实现一致。
- Provider mapper 有 fixture sample 测试。
- 管理员修正有 version conflict 测试。
- daily consistency 可运行。
- rebuild 可运行。
- 不存在前端直接写核心业务 Collection 的权限。
- 不存在未审计的管理员积分修改入口。
- 第 44 节最低验收测试全部通过。

---

# 46. 编码 Agent 最终指令

编码 Agent 接到本文档后：

1. 先实现 schema、enums、config、domain pure functions 与测试。
2. 再实现 repository/transaction/locks。
3. 再实现 prediction API。
4. 再实现 Provider adapter 与同步。
5. 再实现 settlement/correction。
6. 再实现 stats/levels/rankings。
7. 再实现 admin/rebuild/anomaly。
8. 最后实现 OpenAPI 对齐与全套验收测试。
9. 每完成一阶段必须运行对应测试。
10. 若实现中发现本文档未定义的业务问题：
    - 不自行决定。
    - 标记 `SPEC_GAP`。
    - 停止该分支业务实现。
    - 其他不受影响的已定义模块可以继续。
11. 禁止以“行业惯例”“用户体验更好”“框架默认行为”为理由偏离本文档。
12. 本规范未授权的业务能力一律不实现。

---

# 47. 冻结结论

MVP 核心规则冻结为：

```text
联赛：英超 / 西甲 / 意甲 / 德甲 / 法甲 / 中超（六联赛，第 1.4 节）
赛季：按联赛登记，五大联赛 2026_2027（跨年）；中超 2026（自然年）

预测：准确比分
胜平负：服务端推导
提交：一次，之后不可修改、不可删除
截止：正式 kickoff 前 10 分钟
延期：截止前可更新 deadline；一旦关闭永不重新开放

时间事实：UTC
展示周期：Asia/Shanghai
周期：week（月周期已取消）

正式比分：90分钟 + 伤停补时
计分：0 / 3 / 12
规则版本：scoring_v1

结算：finish_detected 后等待 10 分钟
账本：settlements + settlement_items
幂等：数据库唯一约束 + item applied 状态 + match lock
修正：result_version + immutable match_results + delta settlement

等级：收缩场均分 s ∧ 累计积分 B，周评估（每周一 10:00 Asia/Shanghai），一次一级，连续 2 周滞后降级，13 次周评估保护期，修正即时改判本周结论；规则版本 level_v3.0；等级枚举 1..6
等级赛季：北京时间 7/1 00:00 切换，与联赛赛季解耦
生涯：永久累计
解锁：30 / 100 / 200，已解锁不回收，与等级无耦合
准确率：仅内部统计，全部对外 API 与排序中移除

排行榜：本周榜 / 生涯榜 / 实力榜 / 赛季榜（月榜已取消），全站 / 我的群；赛季榜仅对参与 ≥2 个等级赛季的用户可见
本周榜最低有效场次：1；实力榜最低窗口场次：50
周期聚合：本周榜第 1 场有效预测即保存；生涯榜/实力榜/赛季榜为定期快照
排序：
  本周榜/生涯榜/赛季榜：分数 DESC, exact_hits DESC, 有效预测数 ASC, last_scoring_match_at ASC, user_id ASC
  实力榜：s DESC（交叉乘法）, 窗口 n DESC, user_id ASC
群：平台自建，8 位邀请码，成员上限 500，每用户最多加入 20 个/创建 5 个

Provider：API-Football
Provider ID：只做 mapping，不做内部主键
管理员结果优先于 Provider 后续冲突
异常数据：Fail Closed，不猜测
缓存可重建（含等级：可通过 replay_level 以账本 + 评估时刻表 + 规则版本表重建），账本是事实来源
```

> 从本版本开始，编码阶段不得再自行设计核心业务规则。本版本（v2.0）是唯一业务基线，`MVP__v1.0.md` 归档为只读历史版本，不再作为编码依据。

---

# 48. 暂不实现与未来计划

> 本章只做汇总，**不新增任何实现要求**。各项以其规范位置的原文为准；本章与对应章节冲突时，以对应章节为准。
> 「本期不做」不等于「将来一定做」：下表的「状态」列区分「已明确后续再做」「本期不做、未承诺」「讨论过、需先改产品定位」。

## 48.1 已明确「后续版本」再做

| 项 | 状态 | 规范位置 | 开工前的前置条件 |
|---|---|---|---|
| 欧冠及其他杯赛 | 后续版本；本期只保证排行榜展示规则与赛事来源无关 | 第 1.3、19.12 节 | 先决定：是否计分及是否计入等级/生涯（须新规则版本并新增独立积分口径，第 17.4 节）、范围、比分口径、非六联赛球队主数据与 `league_id` 枚举扩展、Provider 接入、比赛页标签、验收矩阵 |
| 解锁装扮的前端展示 | 后端照常创建解锁记录；前端展示延后 | 第 18.2 节 | 先冻结装扮的展示名称、图标与资源来源，并升级规范版本；`GET /v1/unlocks/me` 的 `SPEC_GAP`（第 28.2 节）需先补齐 |
| `unionid` 参与业务 | 仅预留、可保存；第一版不得参与登录、账号合并、排行榜、预测或任何业务关联 | 第 4.1 节 | 单独定义账号关联规则并升级规范版本 |
| 已完成比赛的自动作废 / 取消重算 | 本期不做；若未来需要必须升级规范版本 | 第 1.3 节 | 定义对账本、等级、排行榜的重算与回放影响 |
| 幂等记录等数据的物理清理 | 本期不做任何清理任务 | 第 4.5.1 节「保留期」 | 先定义清理对幂等重放与 409 语义的影响，另版冻结 |
| 若引入不计等级的赛事（杯赛、友谊赛） | 本期无 | 第 17.4 节 | 新规则版本，并新增独立的等级积分口径 |
| 「大家怎么选」赛前档（截止前，已提交预测的用户可看赛前的胜平负分布）；截止后档已实现 | 后续版本；本期只做截止后档 | 本章 | 先观察截止后档：同场比赛预测分布的集中度是否升高（是否出现跟风）；赛前只给胜平负大类比例；沿用「单场至少 20 个预测」门槛与 5% 粒度；需登录 |

## 48.2 本期不做（OUT_OF_SCOPE，未承诺未来）

均来自第 1.3 节，按类归并：

| 类别 | 内容 |
|---|---|
| 赛事范围 | 六联赛以外的其它联赛、杯赛、友谊赛 |
| 榜单形态 | 月榜、半赛季榜、按各联赛自身赛季划分的整赛季榜（等级赛季口径的赛季榜与赛季终榜**在范围内**，第 19.9、19.11 节） |
| 社交与内容 | 评论、社区、资讯聚合；群内自由文本群名、群聊天、群内私信 |
| 运营与商业 | 微信订阅提醒；广告、会员 |
| 视觉与装扮 | 动态头像框；大规模主题皮肤；前端 UI 设计与具体视觉实现（本规范只冻结后端；视觉另有设计稿） |
| 称号与成就 | 独立成就/头衔系统；「前顶级球星」等衍生称号的独立存储字段（可由 `career_best_level == 6 AND career_level < 6` 派生） |
| 预测形态 | 单独总进球数预测；开赛前修改预测；预测删除 |
| 数据与统计 | 自动数据纠错推断；用户自行编辑积分、等级、排名 |
| 展示口径 | 预言指数用于定级判定或在等级页/资料页展示（只作为实力榜的只读展示值）；按分数差距的升级/入榜进度文案 |
| 博彩数据 | 任何赔率、投注或博彩市场数据（强弱监控只用平台自算的已结算赛果 Elo，第 17.13 节） |

## 48.3 MVP 不提供的实现层能力与已登记的 SPEC_GAP

| 项 | 说明 | 规范位置 |
|---|---|---|
| 管理员创建/删除的业务 API | 管理员由云控制台/部署配置显式 provision | 第 21.15 节 |
| 关键 `provider_snapshots` 的自动清理 | MVP 不自动清理 | 第 21.16 节 |
| 球队名称、`home_team`/`away_team` 嵌套对象的公开形状 | `SPEC_GAP`（前端展示层），预测列表只冻结 ID 与 `kickoff_at` | 第 26.2 节 |
| 装扮的展示名称、图标、资源 URL | `SPEC_GAP`，MVP v1 前端不引入未冻结的展示层内容 | 第 18.2、28.2 节 |
| 异常项 `details` 的内部字段形状 | `SPEC_GAP`，API 采用最小受控投影 | 第 30.2 节 |

## 48.4 讨论过、但即使将来要做也需要先修改产品性质定义的方向

> 当前规范（第 1.1 节）把产品定位为「**免费、纯娱乐、无博彩元素的足球比分预测小程序**」，并**永久禁止**：充值、投注、赔率、盘口、奖池、提现、可兑换现金或实物的积分、用户之间转移积分、付费预测推荐、AI 自动替用户提交比分、以 AI 自动推荐比分作为核心功能。
> 下列方向若要推进，意味着修改第 1.1 节对小程序性质的定义，**不是普通的增量功能**，须作为产品定位变更单独评审；在评审通过并升级规范版本之前，一律不实现。

| 方向 | 与当前规范的冲突点 | 前置条件 | 状态 |
|---|---|---|---|
| 积分玩法（把积分变成可消耗的货币，如积分消费、积分商城） | 积分是排名、等级与解锁的成绩（第 17、18、19 节），账本重建按结算记录重新累加，消耗会破坏口径；第 1.1 节禁止充值与可兑换现金/实物的积分、禁止转移积分 | 另设与排名积分完全分离的虚拟币：只能通过活跃获得、不可充值、不可兑换现金或实物、不可转移；定义对账与重建规则 | 暂不做 |
| 花积分购买赛前猜测比例（赛前解锁比赛的实时预测分布） | 第 19.3 节「不得返回他人未过截止时间比赛的预测内容（防抄作业）」；第 1.1 节「付费预测推荐」永久禁止（是否构成需评审）；积分被消耗会改变排名口径；赛前看到分布后「跟随多数」成为最优策略，削弱预测的意义 | 同上（独立虚拟币）+ 重新定义防抄作业规则 + 小样本下的隐私门槛 | 暂不做 |
| 为彩票提供辅助（让小程序成为购买彩票的参考） | 第 1.1 节「无博彩元素」「永久禁止投注/赔率/盘口/奖池/提现」；第 1.3 节禁止引入任何赔率、投注或博彩市场数据；UI 设计规范不使用博彩词汇与赌场式配色 | 需要先完成合规评估（微信小程序平台对博彩、彩票相关内容的限制，以及个人主体的账号限制，均需按最新运营规范核实），并重写第 1.1 节产品性质 | 暂不做，且不建议；如重新讨论，须先完成合规评估 |

## 48.5 本轮讨论中已决定不做 / 暂缓的内容

| 项 | 决定 | 原因 |
|---|---|---|
| 「首批预言家」永久徽章 | 不做 | 产品决定 |
| 聊球板块（按联赛分类的自由发帖） | 不做 | 第 1.3 节「评论、社区、资讯聚合」不在范围；个人主体做社区/论坛类功能在平台类目与资质上受限（需按最新规则核实）；用户量小时冷清 |
| 群内预设短语 / 表情聊天 | 不做 | 价值低、体验单调 |
| 赛季终榜的冠军标识 | 不做 | 第 1.3 节已排除独立成就/头衔系统 |
| 按周筛选的最近预测接口（`period_key` 过滤） | 暂缓 | 保持现状：沿用提交时间排序，界面按比赛所在周显示分组标题 |
