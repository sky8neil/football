# 赛事预言家 MVP 核心机器可执行规范 v1.0

> 状态：**FROZEN / 可直接作为编码 Agent 的唯一业务规范**
>
> 基线：赛事预言家 PRD v2.2 + 后续已确认修改。
>
> 目标：在暂不开发前端 UI 的前提下，冻结 MVP 核心后端的产品边界、领域规则、数据库 Schema、索引、状态机、时间、幂等、异常、赛果修正、API Contract、数据源适配、运维与验收测试。
>
> 技术基线：微信小程序 + 微信云开发（云函数、云数据库、定时触发器）+ API-Football。
>
> MVP 联赛：英超；MVP 赛季：`2026_2027`。

---

# 0. 规范效力与编码 Agent 强制规则

## 0.1 规范优先级

发生冲突时，严格按以下优先级执行：

1. 本文档《赛事预言家 MVP 核心机器可执行规范 v1.0》
2. PRD v2.2 中与本文档不冲突的产品描述
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
- `calculate_level(scope, valid_predictions, wdl_hits)`
- `calculate_period_key(period_type, period_anchor_at)`
- `compare_ranking_entry(a, b)`
- `can_submit_prediction(user, match, existing_prediction, server_now)`
- `normalize_provider_fixture(provider_payload)`
- `validate_match_transition(from, to)`
- `validate_settlement_transition(from, to)`

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
- 当前等级字段
- `predictions` 上的当前结算结果字段

发现缓存与事实不一致时，以事实数据重建；不得反过来修改账本以迁就缓存。

## 0.6 禁止物理删除核心业务数据

除允许清理的运行日志外，以下数据不得物理删除：

- 比赛
- 比赛正式结果版本
- 预测
- 结算
- 结算明细
- 周/月聚合历史
- 等级变化历史
- 解锁记录
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
- 胜平负准确率
- 预测分
- 生涯积分
- 排行榜
- 等级
- 装扮解锁

## 1.2 MVP 必须实现

1. 微信身份识别。
2. 内部稳定 `user_id`。
3. 游客查看赛程、比赛详情、公开周榜、公开月榜、公开用户战绩。
4. 英超球队与赛程同步。
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
19. 胜平负准确率。
20. 本赛季等级。
21. 职业生涯等级。
22. 等级样本保护。
23. 周周期聚合。
24. 月周期聚合。
25. 周榜。
26. 月榜。
27. 历史周榜。
28. 历史月榜。
29. 主队选择。
30. 默认分享卡所需后端数据。
31. 30 / 100 / 200 三档 MVP 解锁。
32. 历史预测。
33. 管理员赛果修正。
34. 管理员审计。
35. Provider 同步异常检测。
36. 数据重建能力。
37. 每日一致性校验。

## 1.3 OUT_OF_SCOPE

MVP 不实现：

- 多联赛。
- 半赛季榜。
- 整赛季榜。
- 评论、社区、资讯聚合。
- 微信订阅提醒。
- 广告、会员。
- 动态头像框。
- 大规模主题皮肤。
- 独立成就/头衔系统。
- 单独总进球数预测。
- 开赛前修改预测。
- 预测删除。
- 用户自行编辑积分、等级、排名。
- 任何赔率、投注或博彩市场数据。
- 前端 UI 设计与具体视觉实现。
- 自动数据纠错推断。
- 已完成比赛的自动作废/取消重算功能；若未来需要，必须升级规范版本。

## 1.4 MVP 固定联赛与赛季

```text
league_id = "premier_league"
season_id = "2026_2027"
provider = "api_football"
api_football_league_id = "39"
api_football_season = "2026"
```

编码不得自动扩展其他联赛或赛季。

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

`league_id`、`season_id`、`round_id` 为稳定业务字符串，不使用 UUID。

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

GLOBAL_WEEK_MIN_PREDICTIONS = 3
GLOBAL_MONTH_MIN_PREDICTIONS = 3

RANKING_UI_LIMIT = 20
API_DEFAULT_LIMIT = 20
API_MAX_LIMIT = 100

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
- 只能指向 `teams.status = active` 的英超球队。
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
- MVP 只实现 `api_football`。

## 5.3 round_id

MVP 英超：

```text
round_id = "01" ... "38"
```

规则：

- 创建比赛时由 Provider round 解析。
- 创建后 `round_id` immutable。
- 延期不修改原 `round_id`。
- Provider 后续 round 与内部值冲突时记录异常，不自动覆盖。

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

# 7. 周/月周期规范

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

## 7.2 月

北京时间自然月：

```text
YYYY-MM
```

例如：

```text
2026-08
```

## 7.3 周期归属

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

failed -> settling
failed -> correcting

settled -> correcting

correcting -> settled
correcting -> failed
```

禁止其他自动转移。

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
- month ranking 用户聚合增量。
- level 当前值变化。
- 必要的 level_history。
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
- 重算受影响 month rank。
- 两者完成后才能进入 finalize。


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
- `career_wdl_hits`
- `career_exact_hits`
- `career_level`
- `career_best_level`

不得保存 career 浮点准确率作为判断真相。

## 16.2 season

使用独立：

```text
user_season_stats
```

唯一：

```text
UNIQUE(user_id, season_id)
```

新赛季：

- 创建新 season stats。
- 不清空旧 season stats。
- career 永久累计。

历史赛季发生赛果修正：

- 更新对应旧 season_id 的 stats。
- 同时更新 career stats。

## 16.3 准确率

事实：

```text
wdl_hits / valid_predictions
```

若 `valid_predictions = 0`：

```text
accuracy = null
```

等级、排名比较均不得先四舍五入。

展示 API 可输出一位小数百分比，但该值仅用于显示。

---

# 17. 等级规则

## 17.1 等级枚举

```text
1 青训新人
2 初出茅庐
3 潜力新星
4 崭露头角
5 坐稳主力
6 球队核心
7 顶级球星
8 足坛巨星
```

## 17.2 准确率理论等级

按真实比例比较：

```text
< 45%  => 2
>=45% and <50% => 3
>=50% and <55% => 4
>=55% and <60% => 5
>=60% and <65% => 6
>=65% and <70% => 7
>=70% => 8
```

样本为 0 时理论结果不重要，最终由样本上限限制为 1。

比较必须使用整数交叉乘法，例如判断 >=60%：

```text
wdl_hits * 100 >= valid_predictions * 60
```

禁止以已四舍五入的显示准确率判断。

## 17.3 本赛季样本量上限

```text
<10   => 1
10-14 => 2
15-19 => 3
20-29 => 4
30-39 => 5
40-49 => 6
50-69 => 7
>=70  => 8
```

## 17.4 生涯样本量上限

```text
<20     => 1
20-39   => 2
40-59   => 3
60-99   => 4
100-149 => 5
150-249 => 6
250-399 => 7
>=400   => 8
```

## 17.5 最终等级

```text
final_level = min(accuracy_level, sample_size_level)
```

## 17.6 升降级

每场首次结算、赛果修正、人工 rebuild 后重算。

当前等级：

- 可以升。
- 可以降。

`career_best_level`：

- 只增不减。
- 表示历史曾达到最高等级。

`user_season_stats.best_level`：

- 只增不减。
- 表示该赛季历史曾达到最高等级。

## 17.7 level_history

只有：

```text
from_level != to_level
```

才写。

reason 固定枚举：

```text
settlement
correction
rebuild
season_start
```

自由文本不得作为 reason 枚举。

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

## 19.1 period_type

MVP 只允许：

```text
week
month
```

其他值返回 `VALIDATION_ERROR`。

## 19.2 周期聚合创建门槛

用户第 1 场有效 prediction 正式结算后即创建 rankings 文档。

因此：

```text
valid_predictions = 1 or 2
```

时仍保存统计，只是：

```text
global_rank = null
```

## 19.3 入榜最低场次

周榜：

```text
valid_predictions >= 3
```

月榜：

```text
valid_predictions >= 3
```

## 19.4 排序

严格按：

1. `period_score DESC`
2. 胜平负准确率 DESC
3. `exact_hits DESC`
4. `last_scoring_match_at ASC`
5. `user_id ASC`

准确率比较必须用交叉乘法：

```text
A.wdl_hits * B.valid_predictions
vs
B.wdl_hits * A.valid_predictions
```

不得比较浮点缓存。

## 19.5 last_scoring_match_at null

如果用户本周期：

```text
period_score = 0
```

则：

```text
last_scoring_match_at = null
```

排序规则：

- 非 null 优先于 null。
- 两者都 null 时继续 `user_id ASC`。

## 19.6 global_rank

符合最低场次的用户按完整排序得到：

```text
1, 2, 3, ...
```

由于最后有 `user_id` 稳定裁决，不存在相同 rank。

不符合最低场次：

```text
global_rank = null
```

## 19.7 is_final

周期边界结束后：

```text
is_final = true
```

语义：

> 该周期已结束，不再接收新的正常比赛归属。

但历史赛果修正仍允许：

- 修改历史聚合。
- 重算历史 global_rank。
- `is_final` 保持 true。

## 19.8 展示

MVP UI 目标：

```text
Top20
```

底层数据库仍为所有满足/未满足门槛用户保存聚合。

MVP 不额外提供：

- 我的全局排名。
- 附近排名。

---

# 20. 分享卡后端数据

前端渲染不属于本规范，但后端必须提供稳定数据。

分享卡所需：

- 用户展示名。
- favorite_team_id。
- 本赛季等级。
- 指定 `round_id` 的预测场次。
- 该 round 胜平负命中数。
- 该 round 精确比分命中数。
- 该 round 预测分。
- 生涯积分。

round 统计：

- 不建立额外持久化聚合 Collection。
- API 查询时从该用户本赛季 predictions + matches.round_id + 当前已结算结果计算。
- 取消/未结算/无效比赛不计。
- 延期比赛仍属于原 round_id。

前端必须显式传 `season_id` 与 `round_id`，后端不猜“当前轮”。

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

career_points               int >=0, default 0
career_valid_predictions    int >=0, default 0
career_wdl_hits             int >=0, default 0
career_exact_hits           int >=0, default 0
career_level                int 1..8, default 1
career_best_level           int 1..8, default 1

deleted_at                  date|null

created_at                  date, immutable
updated_at                  date
schema_version              int, fixed 1
```

Invariant：

```text
career_exact_hits <= career_wdl_hits <= career_valid_predictions
career_best_level >= career_level 必须始终成立。
```

## 21.2 user_season_stats

```text
user_id                     string UUID
season_id                   string

points                      int >=0, default 0
valid_predictions           int >=0, default 0
wdl_hits                    int >=0, default 0
exact_hits                  int >=0, default 0

level                       int 1..8, default 1
best_level                  int 1..8, default 1

created_at                  date
updated_at                  date
schema_version              int, fixed 1
```

## 21.3 teams

```text
team_id                     string UUID, immutable
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

league_id                   string, fixed premier_league
season_id                   string, fixed 2026_2027
round_id                    string 01..38, immutable

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

MVP 英超：

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

```text
period_type                 enum(week, month)
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

不持久化浮点准确率作为排序依据。

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
season_id                   string|null

from_level                  int 1..8
to_level                    int 1..8

wdl_hits                    int >=0
valid_predictions           int >=0

reason                      enum(
                              settlement,
                              correction,
                              rebuild,
                              season_start
                            )

changed_at                  date
schema_version              int, fixed 1
```

`scope=season` 时 `season_id` required；`scope=career` 时必须 null。

## 21.14 admin_audit_logs

immutable。

```text
audit_id                    string UUID
admin_id                    string UUID

action                      string enum
entity_type                 string enum
entity_id                   string

old_value                   object|null
new_value                   object|null

reason                      string 1..500

created_at                  date
schema_version              int, fixed 1
```

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
                              daily_consistency
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

---

# 22. 数据库索引规范

## 22.1 唯一索引

必须创建：

```text
users:
  UNIQUE(openid)

user_season_stats:
  UNIQUE(user_id, season_id)

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

401 AUTH_REQUIRED
403 FORBIDDEN
404 *_NOT_FOUND
409 业务冲突 / 并发版本冲突
422 VALIDATION_ERROR
429 RATE_LIMITED
500 INTERNAL_ERROR
503 PROVIDER_UNAVAILABLE
```

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
AUTH_REQUIRED
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

RATE_LIMITED
INTERNAL_ERROR
```

## 23.8 Cursor Pagination

cursor：

- 服务端 opaque token。
- 客户端不得解析或自行构造。
- 使用 base64url + HMAC 签名的稳定排序游标。
- 无有效签名返回 422。
- MVP cursor 不过期。

cursor 必须同时绑定首次请求已经解析完成的筛选条件：

- matches：解析后的 `from/to/status`。
- rankings：解析后的 `period_type/period_key`。
- predictions：解析后的 `season_id`。

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

## 24.2 GET /v1/profile/me

Auth required。

Response：

```json
{
  "user_id": "uuid",
  "nickname": "Sky",
  "favorite_team_id": null,
  "career_points": 428,
  "career_valid_predictions": 76,
  "career_wdl_hits": 46,
  "career_exact_hits": 8,
  "career_wdl_accuracy_percent": "60.5",
  "career_level": 6,
  "career_best_level": 6
}
```

显示百分比：

- 字符串。
- 四舍五入到 1 位小数。
- 不用于业务判断。

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
  "career_valid_predictions": 76,
  "career_wdl_accuracy_percent": "60.5",
  "career_level": 6,
  "career_best_level": 6
}
```

deleted：

```json
{
  "user_id": "uuid",
  "display_name": "已注销用户",
  "favorite_team_id": null,
  "career_points": 428,
  "career_valid_predictions": 76,
  "career_wdl_accuracy_percent": "60.5",
  "career_level": 6,
  "career_best_level": 6
}
```

---

# 25. 比赛 API

## 25.1 GET /v1/matches

公开，可带可选登录上下文。

Query：

```text
from        ISO8601 UTC optional
to          ISO8601 UTC optional
status      scheduled|live|finished|postponed|cancelled|abandoned optional
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

Query：

```text
season_id optional; default 2026_2027
limit optional
cursor optional
```

排序：

```text
submitted_at DESC, prediction_id DESC
```

每项必须包含：

- prediction。
- match 基础信息。
- 当前 match_status。
- 当前正式赛果（若有）。
- match_score / wdl_hit / exact_hit。

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

公开。

Query：

```text
period_type=week|month   required
period_key               optional
limit                    optional
cursor                   optional
```

`period_key` 缺省：

- 服务端按当前 `server_now` 转北京时间计算当前周期。

非法 key：

- 422。

只返回符合最低场次且 `global_rank != null` 的用户。

Response item：

```json
{
  "global_rank": 1,
  "user_id": "uuid",
  "display_name": "Sky",
  "favorite_team_id": "uuid-or-null",
  "period_score": 33,
  "valid_predictions": 8,
  "wdl_hits": 5,
  "exact_hits": 1,
  "wdl_accuracy_percent": "62.5",
  "last_scoring_match_at": "2026-08-08T14:00:00Z"
}
```

MVP 前端默认只请求 20。

---

# 28. 等级与解锁 API

## 28.1 GET /v1/levels/me

Auth required。

Response：

```json
{
  "season": {
    "season_id": "2026_2027",
    "valid_predictions": 76,
    "wdl_hits": 46,
    "wdl_accuracy_percent": "60.5",
    "level": 6,
    "best_level": 6
  },
  "career": {
    "valid_predictions": 428,
    "wdl_hits": 250,
    "wdl_accuracy_percent": "58.4",
    "level": 5,
    "best_level": 6
  }
}
```

## 28.2 GET /v1/unlocks/me

Auth required。

返回：

- 默认资源。
- 已解锁记录。

不得根据当前积分重新隐藏历史 unlock。

---

# 29. 分享卡数据 API

## 29.1 GET /v1/share-card/me

Auth required。

Query：

```text
season_id required
round_id required
```

Response：

```json
{
  "user_id": "uuid",
  "display_name": "Sky",
  "favorite_team_id": "uuid-or-null",
  "season_level": 6,
  "round_id": "01",
  "round_predictions": 10,
  "round_wdl_hits": 7,
  "round_exact_hits": 2,
  "round_score": 33,
  "career_points": 428
}
```

统计只基于有效正式结算 prediction。

---

# 30. 管理员 API

## 30.1 权限

所有 `/v1/admin/*`：

- 必须可信微信身份。
- 服务端查 `admins.openid`。
- `status=active` 才允许。
- 客户端传入的 admin_id 一律忽略/拒绝。

## 30.2 GET /v1/admin/anomalies

Query：

```text
status=open|resolved optional
blocking=true|false optional
limit
cursor
```

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
- reason 1..500。
- `expected_result_version == matches.result_version`。

不匹配：

```text
409 RESULT_VERSION_CONFLICT
```

新比分与当前相同：

```text
409 RESULT_UNCHANGED
```

成功：

1. `result_version += 1`。
2. 创建 immutable match_results。
3. `result_source = admin`。
4. 更新 matches 当前 regular score。
5. 若 `settled_result_version > 0`：`settlement_status -> correcting`，排入修正结算。
6. 若 `settled_result_version == 0`：保持/进入 `waiting`；达到首次结算时间条件后按首次 settlement 执行。
7. 写 admin_audit_logs。

## 30.4 POST /v1/admin/matches/:match_id/retry-settlement

只允许：

```text
settlement_status == failed
```

或存在 failed settlement。

不得新造积分。

## 30.5 POST /v1/admin/rebuild/users/:user_id

从事实数据重建：

- career stats。
- 所有 season stats。
- levels。
- 不删除历史 unlock。
- 必须写 admin audit。

## 30.6 POST /v1/admin/rebuild/rankings

Request：

```json
{
  "period_type": "week",
  "period_key": "2026-W32",
  "reason": "一致性修复"
}
```

从事实数据全量重建该周期 rankings。

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

MVP 英超不应出现：

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

---

# 32. 数据同步任务

## 32.1 future_schedule

未来 30 天英超赛程：

```text
每 6 小时
```

## 32.2 full_schedule_verify

当前 active season 完整赛程：

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

的 week/month rankings 文档：

```text
is_final = true
```

历史 correction 不得将其改回 false。

## 32.7 同类任务并发

每个 job_type 使用 lock：

```text
sync:{job_type}
```

上一个 lease 未过期：

- 下一任务不并发执行。
- 记录 skipped/已有 owner，不制造第二套写入。

lease 超时可接管。

## 32.8 重试

普通网络/Provider 暂时错误：

```text
1m
2m
5m
10m
30m
```

每次加入 ±20% jitter。

最多 5 次。

Quota exceeded：

- 停止高频自动重试。
- 等 Provider 明确 reset 时间；若无明确信息，等待下一正常 scheduled run。
- 不用密集请求撞 quota。

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

# 34. 排行榜增量更新与全量校验

## 34.1 settlement item 应用

每个首次有效 prediction：

- 更新对应 week rankings doc。
- 更新对应 month rankings doc。

没有文档则创建。

## 34.2 correction

使用 delta 更新：

```text
period_score
wdl_hits
exact_hits
```

`valid_predictions` 不变。

必要时重算：

```text
last_scoring_match_at
```

## 34.3 global rank

某场 settlement 所有 item applied 后：

- 受影响 week 全量重新排序并写 global_rank。
- 受影响 month 全量重新排序并写 global_rank。

不满足 3 场的：

```text
global_rank=null
```

## 34.4 每日全量校验

每天至少一次，从事实数据重算并比较：

- users career cache。
- user_season_stats。
- week rankings。
- month rankings。
- levels。
- last_scoring_match_at。
- global_rank。

MVP 策略：

> **发现不一致只报警，不自动静默修复。**

一致性校验不得对正在 `settling/correcting` 的 match 及其受影响用户/周期做最终一致性判断；必须跳过并记录 `skipped_active_settlement`，下一轮再校验。

管理员确认后使用明确 rebuild。

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

season stats 使用同一账本公式，但按 prediction.match_id -> matches.season_id 分组。

重建：

- career points。
- career valid predictions。
- career hits。
- career exact。
- career current level。
- 全部 user_season_stats。
- season current/best 规则按历史 level_history 与事实计算。
- career_best_level = max(现有 career_best_level, level_history.to_level 历史最大值, 重建后的当前 career_level)，普通 rebuild 不允许下降。
- unlock 不删除。

## 35.2 rebuild_period_rankings(type, key)

事实计算来源：

1. 根据 match.period_anchor_at 选出属于该 period 的比赛。
2. 对这些比赛的 `status=applied` settlement_items 求 delta 累积。
3. `valid_predictions` 使用 `valid_prediction_delta` 之和。
4. `period_score` 使用 `score_delta` 之和。
5. `wdl_hits/exact_hits` 使用 old/new bool delta 之和。
6. `last_scoring_match_at` 对每个 prediction 取最高 `source_result_version` 的 applied item；其 `new_score > 0` 时，对对应 match.period_anchor_at 取最大值。

不得以 rankings 旧值作为 rebuild 输入。

全量计算：

- period_score。
- valid_predictions。
- wdl_hits。
- exact_hits。
- last_scoring_match_at。
- global_rank。

## 35.3 rebuild 并发前提

管理员执行普通 rebuild 前必须满足：

- 目标用户/目标周期不存在相关 `settling/correcting` match。
- 否则返回 `409 SETTLEMENT_ALREADY_RUNNING`。
- rebuild 使用对应 maintenance lock，避免两个 rebuild 并发覆盖。

## 35.4 rebuild_match_settlement

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

- users career fields。
- matches。
- match_results。
- predictions。
- rankings。
- settlements。
- settlement_items。
- levels。
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
- rankings。
- settlements。
- settlement_items。
- unlocks。
- level_history。
- admin_audit_logs。
- 关键 provider_snapshots。
- anomalies。

可清理：

```text
sync_logs: 30 days
普通 API request logs: 按运维配置
临时 trace logs: 按运维配置
```

不得清理会导致无法对账或无法重建积分的数据。

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
- 排行榜 Top20 必须走索引/预聚合，不允许每次从所有 predictions 实时全量扫描。

分享卡 round 统计允许实时查询，但必须按 `user_id + season_id/round` 通过索引筛选，禁止全库扫描。

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
8. level 计算与测试。
9. ranking comparator 与测试。
10. Provider adapter 与 mapper 测试。
11. settlement orchestration。
12. settlement item 幂等 transaction。
13. correction orchestration。
14. rebuild services。
15. API validators。
16. API error mapper。
17. OpenAPI v1 文件。
18. 定时任务配置。
19. anomaly service。
20. admin audit service。
21. 数据 migration/version 基础设施。
22. 全套验收测试。

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
22. 延期跨月，最终归延期后新月。
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
48. EPL 返回 AET/PEN => blocking anomaly，不自动结算。
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
71. correction 后 season stats 正确。
72. correction 后 week stats 正确。
73. correction 后 month stats 正确。
74. correction 后 current level 可以下降。
75. correction 后 career_best_level 不下降。
76. correction 后已解锁装扮不回收。
77. 被修正 match 原是 last_scoring，变 0 后正确找到新的 last_scoring 或 null。

## K. 排行榜

78. 1 场有 rankings 文档但 global_rank=null。
79. 2 场 global_rank=null。
80. 3 场开始进入全局榜。
81. period_score 高者优先。
82. 同分准确率高者优先。
83. 准确率用精确分数比较，不受显示四舍五入影响。
84. 再同 exact_hits 高者优先。
85. 再同 last_scoring_match_at 早者优先。
86. 0 分用户 last_scoring=null 并按规则排序。
87. 完全一致 user_id ASC。
88. 历史周期 is_final=true 后 correction 仍可改变历史 rank。
89. 北京时间周日/周一边界正确。
90. ISO week-year 跨年正确。
91. 月末/月初边界正确。

## L. 等级

92. season <10 场永远最高 level1。
93. season 10～14 样本上限 level2。
94. career <20 最高 level1。
95. 60% 真实准确率正确进入理论 level6。
96. 59.96% 显示可为 60.0%，但业务仍按 <60%。
97. current level correction 后可下降。
98. best_level 只增不减。
99. level 不变化时不写 level_history。

## M. 注销与权限

100. 注销后原 openid 从用户事实身份中移除。
101. 注销历史 prediction 保留。
102. 注销历史排行榜保留。
103. 公开显示名为 已注销用户。
104. 同 openid 再注册创建新 user_id。
105. 客户端传 user_id 不能冒充其他用户。
106. 非管理员调用 admin API => 403。
107. 管理员不能通过 API 直接编辑积分。

## N. Rebuild 与一致性

108. rebuild_user_stats 后与 applied ledger 完全一致。
109. rebuild_period_rankings 后与事实 predictions 完全一致。
110. daily consistency 发现差异只报警，不自动修改。
111. unlock 不因普通 rebuild 删除。
112. sync 网络失败不得改变比赛状态。
113. Provider 不完整响应不得把已有可信字段清为 null。

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
联赛：英超
赛季：2026_2027

预测：准确比分
胜平负：服务端推导
提交：一次，之后不可修改、不可删除
截止：正式 kickoff 前 10 分钟
延期：截止前可更新 deadline；一旦关闭永不重新开放

时间事实：UTC
展示周期：Asia/Shanghai
周期：week / month

正式比分：90分钟 + 伤停补时
计分：0 / 3 / 12
规则版本：scoring_v1

结算：finish_detected 后等待 10 分钟
账本：settlements + settlement_items
幂等：数据库唯一约束 + item applied 状态 + match lock
修正：result_version + immutable match_results + delta settlement

等级：胜平负真实准确率 + 样本量上限
生涯：永久累计
解锁：30 / 100 / 200，已解锁不回收

排行榜：周榜 / 月榜
最低有效场次：3
周期聚合：第1场有效预测即保存
排序：
  period_score DESC
  accuracy DESC
  exact_hits DESC
  last_scoring_match_at ASC
  user_id ASC

Provider：API-Football
Provider ID：只做 mapping，不做内部主键
管理员结果优先于 Provider 后续冲突
异常数据：Fail Closed，不猜测
缓存可重建，账本是事实来源
```

> 从本版本开始，编码阶段不得再自行设计核心业务规则。

---

# 48. 补充冻结决策 v1.1（2026-08-09 产品确认）

以下决策由产品确认后冻结，与正文同优先级；与正文冲突时以更具体的小节为准。

## 48.1 GET /v1/admin/anomalies 排序与 Cursor

- 稳定排序：
  ```text
  last_seen_at DESC, anomaly_id DESC
  ```
- cursor 必须绑定解析后的筛选条件：
  ```text
  status
  blocking
  ```
  未传时绑定为 null（无筛选）。
- 后续带 cursor 请求若显式参数与 cursor 内筛选条件冲突：
  ```text
  422 VALIDATION_ERROR
  ```
- keyset 翻页条件：
  ```text
  last_seen_at < cursor.last_seen_at
  OR (
    last_seen_at == cursor.last_seen_at
    AND anomaly_id < cursor.anomaly_id
  )
  ```

## 48.2 管理员接口成功响应

统一使用第 23.2 节成功 Envelope，`data` 只返回目标标识、执行结果摘要与 `audit_id`；不得返回 `admin_id`、完整 `audit_log`、完整内部数据库对象或完整排行榜数组。

### POST /v1/admin/matches/:match_id/result-corrections

HTTP Status：

```text
201
```

data：

```json
{
  "match_id": "uuid",
  "result_version": 2,
  "regular_home_score": 1,
  "regular_away_score": 1,
  "result_source": "admin",
  "settlement_status": "correcting",
  "audit_id": "uuid"
}
```

### POST /v1/admin/matches/:match_id/retry-settlement

HTTP Status：

```text
200
```

data：

```json
{
  "match_id": "uuid",
  "settlement_id": "uuid",
  "result_version": 2,
  "outcome": "settled",
  "processed_count": 10,
  "skipped_applied_count": 487,
  "audit_id": "uuid"
}
```

`outcome` 枚举：

```text
settled
failed
```

### POST /v1/admin/rebuild/users/:user_id

HTTP Status：

```text
200
```

data：

```json
{
  "user_id": "uuid",
  "rebuilt_season_count": 1,
  "audit_id": "uuid"
}
```

### POST /v1/admin/rebuild/rankings

HTTP Status：

```text
200
```

data：

```json
{
  "period_type": "week",
  "period_key": "2026-W32",
  "rebuilt_entry_count": 123,
  "audit_id": "uuid"
}
```

## 48.3 admin_audit_logs 枚举

`action`：

```text
result_correction
retry_settlement
rebuild_user_stats
rebuild_rankings
```

`entity_type`：

```text
match
settlement
user
ranking_period
```

映射：

| action | entity_type | entity_id |
|---|---|---|
| result_correction | match | match_id |
| retry_settlement | settlement | settlement_id |
| rebuild_user_stats | user | user_id |
| rebuild_rankings | ranking_period | period_type + ":" + period_key |

## 48.4 审计 old_value / new_value（方案 C：有限关键摘要）

禁止把完整数据库文档或完整排行榜数组写入审计日志。每个 action 的前后快照只包含以下字段：

### result_correction

```text
result_version
regular_home_score
regular_away_score
result_source
settlement_status
```

### retry_settlement

```text
settlement_status
phase
attempt_count
failed_item_count
pending_item_count
applied_item_count
```

retry 再次失败时 new_value 如实记录失败后状态。

### rebuild_user_stats

```text
career_points
career_valid_predictions
career_wdl_hits
career_exact_hits
career_level
career_best_level
season_stats_changed_count
```

### rebuild_rankings

```text
entry_count
ranked_entry_count
total_period_score
max_global_rank
is_final
```

## 48.5 retry-settlement 目标选择

- 同一 match 存在多个 failed settlement 时，选择：
  ```text
  result_version > settled_result_version 的最小 result_version
  ```
- 中间缺版本、同版本多条记录或数据互相冲突：Fail Closed，记录数据一致性异常，不猜测目标。
- 无 failed settlement 且 `match.settlement_status != failed`：
  ```text
  409 SETTLEMENT_NOT_READY
  ```
- `match.settlement_status == failed` 但找不到对应 failed settlement：数据不一致：
  ```text
  500 INTERNAL_ERROR
  ```
  不得新建 settlement，不得新造积分。

## 48.6 correction settlement retry

管理员 retry 允许处理 failed correction settlement：

- `is_correction = false`：match `failed -> settling`，普通 retry 逻辑。
- `is_correction = true`：match `failed -> correcting`，correction retry 逻辑。

correction retry 必须：

- 复用原 settlement 与 settlement_items。
- 保留已 applied item，只处理 pending/failed item。
- 使用该 settlement 自己的 immutable result_version。
- 成功后若仍有更高未处理 result_version，match 保持 `correcting`；否则 `settled`。
- 不得跳到当前最新 result_version。

## 48.7 retry / rebuild 必须写 admin_audit_logs

管理员通过赛果修正、retry、rebuild 产生的任何业务变化都必须写入 `admin_audit_logs`，不得遗漏。

---

# 49. 补充冻结决策 v1.2（2026-08-11 产品确认）

以下决策由产品确认后冻结，与正文同优先级；与正文冲突时以本节约定为准。
来源：`REVERSE_REVIEW__v1.0.md` 中 F1/F2/F3/H1/H2 的产品裁决。

## 49.1 鉴权与会话（F1）

### 身份来源

- 网关/运行环境注入**可信** `openid`（或等价字段）。
- 后端**不**自行签发 JWT/Cookie/session token 作为登录凭证。
- 后端**不**信任客户端 body/query 中的 `openid` / `user_id` 作为鉴权依据。

### 请求身份绑定

| 接口类型 | 身份要求 |
|---|---|
| `POST /v1/session/init` | 必须有可信 `openid`；body 可含 `nickname`，不得含可冒充他人的 `user_id` |
| Auth required 写/读接口 | 必须有可信 `openid` → 解析为 active `user_id` |
| 公开读接口 | 可不登录；若带可信身份，可返回“当前用户相关”可选字段 |

### 失败语义

| 条件 | HTTP | code |
|---|---|---|
| 缺少可信身份 | 401 | `UNAUTHORIZED` |
| 可信 openid 对应用户已注销 | 409 | `USER_DELETED` |
| 客户端试图用 body/query 伪造他人 `user_id` | 403 或 404 | 按接口既有“不得冒充”规则；不得静默切到伪造用户 |

### session/init 幂等

- 同 active openid 再次 init：返回 **200** 与既有用户；**忽略** body 中的新 `nickname`（不覆盖）。
- openid 不存在：创建用户，返回 **201**。
- openid 已注销：返回 **409 `USER_DELETED`**，不得复用该 openid 创建新用户以外的“复活”语义（新注册规则仍按第 4 节）。

## 49.2 预测拒绝映射表（F2）

列表/详情的 `can_predict_reason` 与 `POST /v1/predictions` 错误码必须同源。
判定顺序固定如下（命中即停）：

| 优先级 | 条件 | can_predict_reason | POST HTTP | POST code |
|---|---|---|---|---|
| 1 | 无可信登录用户 | `AUTH_REQUIRED` | 401 | `UNAUTHORIZED` |
| 2 | 用户已注销 | `USER_DELETED` | 409 | `USER_DELETED` |
| 3 | 同 user+match 已有预测 | `ALREADY_SUBMITTED` | 409 | `PREDICTION_ALREADY_SUBMITTED` |
| 4 | `match_status != scheduled`（含 live/finished/postponed/cancelled/abandoned） | `NOT_SCHEDULED` | 409 | `MATCH_NOT_PREDICTABLE` |
| 5 | `kickoff_confirmed != true` 或 `prediction_deadline_at == null` | `KICKOFF_UNCONFIRMED` | 409 | `MATCH_NOT_PREDICTABLE` |
| 6 | `prediction_closed_at != null` 或 `server_now >= prediction_deadline_at` | `CLOSED` | 409 | `PREDICTION_LOCKED` |
| — | 以上皆否 | `null`（可预测） | 201/200 | 成功路径 |

说明：

- `CLOSED` 覆盖“已落表关闭”和“墙钟已过 deadline 但尚未写 closed_at”两种情况。
- `postponed` 一律 `NOT_SCHEDULED`，不得在 postponed 状态接受预测。
- 幂等重放（同 idempotency_key + 同 payload）仍按第 8.6 节返回首次结果，不走本表失败分支。

## 49.3 结算状态机：允许 settling → correcting（F3）

### 新增合法转移

在第 11.2 节合法转移中增加：

```text
settling -> correcting
```

### 与 15.9 对齐

当某 settlement version `v` 完成 items 与必要聚合后：

1. 写入 `matches.settled_result_version = v`、`matches.settled_at = server_now`。
2. 重新读取 `matches.result_version`：
   - 若 `result_version == v`：`matches.settlement_status = settled`。
   - 若 `result_version > v`：允许 **`settling -> correcting`**（或已处于 correcting 则保持），然后按最小未处理 `result_version` 启动下一 correction settlement。

### 禁止

- 不得为了“绕开状态机”先把 match 标成 settled 再立刻 correcting，却省略 `settled_result_version = v` 的写入。
- 状态机实现、编排层、管理员 retry 必须使用同一套合法转移表。

## 49.4 延期与预测关闭（H1）

### 到点关闭触发条件

仅当同时满足时，才因“墙钟到达 deadline”写入/保持关闭：

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

- **不得**仅因“墙钟越过旧 prediction_deadline_at”而写入 `prediction_closed_at`。
- 截止前发现延期（`prediction_closed_at == null` 且 `server_now < 旧 deadline`）：
  - 可更新 kickoff / 重算新 deadline；
  - 恢复为 scheduled 且新 deadline 未到前，未提交用户可继续预测。
- 截止后才发现延期（已关闭或 `server_now >= 旧 deadline`）：
  - 先按旧 deadline 永久关闭（`prediction_closed_at` 非 null）；
  - 之后永不因延期重新开放。

### 真值摘要

| match_status | closed_at | server_now vs deadline | 预测入口 |
|---|---|---|---|
| scheduled | null | now < deadline | 可预测（其他条件满足时） |
| scheduled | null | now >= deadline | 关闭并写 closed_at |
| scheduled | 非 null | 任意 | 不可预测 |
| postponed | null | 任意 | 不可预测（NOT_SCHEDULED）；且不因旧 deadline 自动写 closed_at |
| postponed | 非 null | 任意 | 不可预测；永不重开 |
| 其他非 scheduled | 任意 | 任意 | 不可预测 |

## 49.5 rebuild 事实源（H2）

### 唯一事实源

- `rebuild_user_stats` / `rebuild_period_rankings` / daily consistency 的**期望值**必须以：
  ```text
  status = applied 的 settlement_items
  + match.period_anchor_at 归属规则
  + 既有 unlock / level_history 只增不减规则
  ```
  为准。
- **不得**以 raw `predictions` 文档上的缓存命中字段作为 rebuild 唯一输入。

### 验收矩阵修订

第 44 节第 109 条解释为：

```text
rebuild_period_rankings 后与 applied settlement_items + period 归属规则完全一致
```

第 108 条同理：与 applied ledger 完全一致，而非与未结算 prediction 猜测值一致。

### 允许的交叉校验

可用 predictions 做辅助对账，但当 prediction 缓存与 applied item 冲突时：

- rebuild 以 item 为准；
- daily consistency 只报警，不自动改账本。

## 49.6 本版未纳入但已记录

以下问题见 `REVERSE_REVIEW__v1.0.md`，本版不冻结，后续可继续补充：

- H4 第 48 节与 0.1 冲突裁决机械化
- H5 其余 API 响应 schema 补全（已冻结切片见 49.9、49.10、49.11）
- 尚未由 49.14 冻结的 U 类（调度频率、SLO 非门禁等）

## 49.7 阶段 A1：管理端写操作 reason 来源与审计规则

以下规则冻结为管理端四个写操作的最小契约：

| 写操作 | 审计 reason 来源 | HTTP body 是否包含 reason |
|---|---|---|
| `POST /v1/admin/matches/:match_id/result-corrections` | 管理员 HTTP body 的必填 `reason`，原样写入 `admin_audit_logs.reason` | 是，必填，1..500 |
| `POST /v1/admin/rebuild/rankings` | 管理员 HTTP body 的必填 `reason`，原样写入 `admin_audit_logs.reason` | 是，必填，1..500 |
| `POST /v1/admin/matches/:match_id/retry-settlement` | 固定系统 reason：`管理员重试结算` | 否；不得添加 body/request reason 字段 |
| `POST /v1/admin/rebuild/users/:user_id` | 固定系统 reason：`管理员用户统计重建` | 否；不得添加 body/request reason 字段 |

四个写操作成功执行时都必须在同一业务变化中追加一条 `admin_audit_logs`。审计 `reason` 不得为空；成功响应继续只返回既有有限 `data` 摘要与 `audit_id`，不得返回完整审计记录或内部对象。

本小节只冻结 reason 来源与审计规则，不扩展 retry 的其他前置条件、目标选择或错误码决策。

## 49.8 阶段 A1.2：管理员 retry-settlement 决策表

本小节冻结 `POST /v1/admin/matches/:match_id/retry-settlement` 的决策顺序、目标复用、错误映射与成功响应。前置拒绝优先于目标选择；任何前置拒绝都不得新建 settlement、settlement_items 或积分。

### 决策表

| 状态/条件 | 目标 | HTTP + code | 响应 |
|---|---|---|---|
| 未提供可信管理员身份，或身份不是 active admin | 无 | `401 UNAUTHORIZED` 或 `403 FORBIDDEN` | 既有错误 Envelope |
| `match_id` 非法 UUID | 无 | `422 VALIDATION_ERROR` | 既有错误 Envelope；不调用 application |
| 管理员写接口限流命中 | 无 | `429 RATE_LIMITED` | 既有错误 Envelope；不调用 application |
| match 不存在 | 无 | `404 MATCH_NOT_FOUND` | 既有错误 Envelope |
| match 为 `settling` 或 `correcting`，或同一 match 存在任意 `status=running` 的 settlement | 无；优先于 failed target 选择 | `409 SETTLEMENT_ALREADY_RUNNING` | 既有错误 Envelope |
| match 为 `failed`，且存在结构合法的 failed target，`is_correction=false` | 选择 `result_version > settled_result_version` 的最小未处理 failed settlement；复用原 settlement 与 items；match `failed -> settling` | `200` | 既有成功 Envelope；`outcome` 为 `settled` 或 `failed`，`processed_count` / `skipped_applied_count` 为本次 retry 计数，`audit_id` 必有 |
| match 为 `failed`，且存在结构合法的 failed target，`is_correction=true` | 同上；复用原 correction settlement 与 items，使用其 immutable `result_version`；match `failed -> correcting` | `200` | 同上；不得跳到当前最新 result_version |
| match=`waiting` 且存在结构合法的 failed target | 按同一最小未处理版本选择并复用 target；普通 target 按既有状态机进入 `settling` | `200` | 同上；该兼容路径来自第 30.4 节“或存在 failed settlement”，不新增 settlement 或积分规则 |
| 没有 failed settlement，且 `match.settlement_status != failed` | 无 | `409 SETTLEMENT_NOT_READY` | 既有错误 Envelope |
| `match.settlement_status=failed`，但找不到对应 failed settlement | 无 | `500 INTERNAL_ERROR` | 既有错误 Envelope；不得新建 settlement 或积分 |
| failed target、settlement 版本序列、`rule_version`、`is_correction` 或其他目标数据冲突 | 无；Fail Closed，不猜测目标 | `500 INTERNAL_ERROR` | 既有错误 Envelope；不得新建 settlement 或积分 |
| match=`settled` 且 failed target 已处于 settled 版本范围，或 settled 快照与当前版本不一致 | 无；Fail Closed，不回退已结算版本 | `500 INTERNAL_ERROR` | 既有错误 Envelope；不得新建 settlement 或积分 |
| 存在 failed target，但 match 状态无法按既有状态机转移（例如当前已测 `pending`） | 无 | `409 MATCH_STATE_CONFLICT` | 既有错误 Envelope；不处理 items |

其中“结构合法”至少包括第 48.5 节规定的中间版本缺失、同版本重复和数据互相冲突均不存在；failed target 必须属于该 match，且 `result_version > settled_result_version`。普通与 correction retry 均只处理 pending/failed items，已 applied item 只计入 `skipped_applied_count`。

正常处理完成或处理后失败都返回第 48.2 节既有 `200` 成功 Envelope：`data.outcome` 仅为 `settled|failed`，并包含 `match_id`、被复用的 `settlement_id`、target `result_version`、本次 retry 的 `processed_count`、`skipped_applied_count` 与必填 `audit_id`。错误响应继续使用统一错误 Envelope；本表不扩展其他管理员写操作能力。

## 49.9 阶段 A2.1：GET /v1/predictions/me 响应合同

本小节只冻结 `GET /v1/predictions/me`；不改变 49.1 的身份来源或 OpenAPI 中现有的认证表达。

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

每个 item 是当前实现已提供的扁平对象，必须包含下列字段，不得省略，也不得添加本合同未定义的公开字段：

| 字段 | 类型 | nullable | 语义 |
|---|---|---|---|
| `prediction_id` | UUID v4 string | 否 | 预测 ID |
| `match_id` | UUID v4 string | 否 | 比赛 ID |
| `league_id` | string，固定 `premier_league` | 否 | 比赛联赛 |
| `season_id` | string，固定 `2026_2027` | 否 | 比赛赛季 |
| `round_id` | string | 否 | 比赛轮次 |
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

正式比分只使用 90 分钟常规时间比分（9.1）。正式比分缺失时，`regular_home_score`、`regular_away_score`、`match_score`、`wdl_hit`、`exact_hit` 均返回 `null`；不得用空字符串、`0` 或省略字段表达缺失。取消比赛也保持预测结算字段为 `null`，遵循 9.4/21.8。

本合同冻结的 match 基础信息仅为上述 `match_id`、联赛/赛季/轮次、主客队 ID 和 `kickoff_at`。`§26.2` 没有唯一规定球队名称或 `home_team`/`away_team` 嵌套对象的公开形状；该部分标记为 `SPEC_GAP`，本切片不增加字段、不规定前端展示名来源。

### 排序与 cursor

结果严格按以下稳定 keyset 顺序：

```text
submitted_at DESC, prediction_id DESC
```

`prediction_id` 是同一 `submitted_at` 下的唯一 tie-breaker。`next_cursor` 仅在 `has_more=true` 时返回；它指向当前页最后一项的位置。cursor 是服务端生成的 opaque `base64url + HMAC` 游标，绑定当前解析后的 `season_id`、最后一项的 `submitted_at` 和 `prediction_id`；客户端不得解析或构造，签名无效返回 `422 VALIDATION_ERROR`。MVP cursor 不过期。

带 cursor 的请求必须继续使用 cursor 绑定的 `season_id`；显式 `season_id` 与其冲突返回 `422 VALIDATION_ERROR`。`limit` 不属于筛选条件，可以在后续页改变。`has_more=false` 时 `next_cursor=null`。

### 输入与失败映射

查询参数只有：

```text
season_id optional; default 2026_2027; only 2026_2027
limit optional; default 20; integer 1..100
cursor optional; opaque string
```

HTTP query 中 `season_id`、`limit`、`cursor` 分别按字符串、十进制整数字符串、字符串解析；未知参数、类型错误、非法赛季或非法 limit 由 handler 返回 `422 VALIDATION_ERROR`。cursor 的签名、内容和绑定条件由 application query 校验；无效 cursor 同样返回 `422 VALIDATION_ERROR`，不返回历史数据。

失败映射：

| 条件 | HTTP | code |
|---|---:|---|
| 缺少可信身份 | 401 | `UNAUTHORIZED` |
| 可信身份对应用户已注销 | 409 | `USER_DELETED` |
| 可信身份无法解析为现有用户 | 404 | `USER_NOT_FOUND` |
| 查询参数或 cursor 校验失败 | 422 | `VALIDATION_ERROR` |
| 已认证读取限流命中 | 429 | `RATE_LIMITED` |
| 预测或比赛事实数据不一致 | 500 | `INTERNAL_ERROR` |

所有失败均使用第 23.6 节错误 Envelope。上述合同不冻结其他预测接口、认证 scheme、A2.2 的其他响应 schema，也不启动 A3/A4。

## 49.10 阶段 A2.2：GET /v1/unlocks/me 响应合同

本小节冻结 `GET /v1/unlocks/me` 的前端公开响应；只使用第 18.2 节和当前 unlock query 实现已有的资源代码、记录字段与历史保留规则。不冻结未由现有规范和实现唯一确定的资源展示名称、图标、URL 或其他 UI 元数据，并保留 `SPEC_GAP`。

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

`unlocked` 返回该用户的全部历史 unlock，不因当前 `career_points` 下降而隐藏，也不因赛果修正回收。当前实现已有稳定排序，冻结为：

```text
threshold_points ASC, unlock_id ASC
```

除上述字段外，`unlock` item 不公开名称、图标、资源 URL、描述、展示分类或其他 UI 内容；这些字段的公开形状是 `SPEC_GAP`，本切片停止在未定义部分。

### 参数与失败映射

该接口无 query、path 或 request body 参数；未定义参数按第 23.4 节返回 `422 VALIDATION_ERROR`。当前实现的失败映射固定为：

| 条件 | HTTP | code |
|---|---:|---|
| 缺少认证用户 | 401 | `UNAUTHORIZED` |
| 认证用户不存在 | 404 | `USER_NOT_FOUND` |
| 认证用户已注销 | 409 | `USER_DELETED` |
| 认证用户 ID 非法 | 422 | `VALIDATION_ERROR` |
| authenticated reads 限流命中 | 429 | `RATE_LIMITED` |
| 用户或 unlock 事实读取失败 | 500 | `INTERNAL_ERROR` |

所有失败均使用第 23.6 节错误 Envelope。认证 OpenAPI security scheme 不在本切片修改范围内；其现有表达与第 49.1 节可信 openid 注入模型之间的 `SPEC_GAP/H4` 保持记录。本小节不冻结其他 A2/A3/A4 接口；`admin-anomalies` 见 49.11。

## 49.11 阶段 A2.3：GET /v1/admin/anomalies 响应合同

本小节冻结 `GET /v1/admin/anomalies` 的前端公开响应、查询参数、稳定分页和失败映射。不改变第 49.1 节可信 `openid` 来源，也不修改 OpenAPI 现有认证 security scheme；该表达与可信上下文模型的差异继续保留为 `SPEC_GAP/H4`。

### 成功 Envelope

成功返回 `200`，严格使用第 23.2 节分页成功 Envelope：

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

`data.items` 必须是数组；没有记录时为 `[]`。`page.next_cursor` 只有在 `has_more=true` 时返回游标，否则必须为 `null`。`request_id` 为字符串。

### anomaly item 字段

每个 item 只包含以下字段，不得添加内部数据库对象或其他未冻结字段：

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

`details` 的内部字段形状无法从第 21.18、30.2 或其他现有冻结规范唯一推出；这是 `SPEC_GAP/H5`。本切片不冻结 arbitrary JSON schema，也不透传内部原始 Provider payload、Provider/API 密钥或运维字段。由于 item 仍必须保留第 21.18 节定义的 `details object` 字段，API 采用最小受控投影：公开值始终为空 JSON 对象 `{}`；未来若需要公开诊断字段，必须另行冻结字段白名单和脱敏边界。

### 查询参数

HTTP query 参数只有：

```text
status=open|resolved optional; default no filter
blocking=true|false optional; default no filter
limit optional; default 20; integer 1..100
cursor optional; opaque string
```

HTTP query 中 `status`、`blocking`、`limit`、`cursor` 按字符串解析。未知参数、缺失值以外的 `null`、错误类型、非法 enum、非法 boolean 或不在 `1..100` 的整数均返回 `422 VALIDATION_ERROR`。

### 排序与 cursor

结果严格按以下稳定 keyset 顺序：

```text
last_seen_at DESC, anomaly_id DESC
```

同一 `last_seen_at` 使用 `anomaly_id` 作为唯一 tie-breaker。`cursor` 是服务端生成的 `base64url + HMAC` opaque token，客户端不得解析或构造；MVP cursor 不过期。游标绑定首次请求解析后的 `status`、`blocking` 筛选值，以及当前页最后一项的 `last_seen_at`、`anomaly_id`。

后续请求带 cursor 时，省略 `status` 或 `blocking` 表示继承 cursor 中的筛选值；显式值与 cursor 绑定值不一致返回 `422 VALIDATION_ERROR`。`limit` 不属于筛选条件，可以在后续页改变。keyset 条件为：

```text
last_seen_at < cursor.last_seen_at
OR (
  last_seen_at == cursor.last_seen_at
  AND anomaly_id < cursor.anomaly_id
)
```

### resolved 记录

未传 `status` 时，open 与 resolved 记录均按同一排序返回；`status=resolved` 只返回 resolved 记录。resolved item 仍保留全部冻结字段，`status="resolved"`，`resolved_at` 必须为 UTC 时间字符串，`resolution` 必须为非空字符串；不会因为已 resolved 而省略记录、`details`、`occurrence_count` 或历史时间。open item 的 `resolved_at` 和 `resolution` 均为 `null`。

### 鉴权、限流与失败映射

所有失败均使用第 23.6 节错误 Envelope；`message` 仅供展示，程序判断使用 `code`。

| 条件 | HTTP | code |
|---|---:|---|
| 缺少可信 `openid` | 401 | `UNAUTHORIZED` |
| 可信 `openid` 无对应管理员、管理员非 active 或 role 不是 `admin` | 403 | `FORBIDDEN` |
| 未知 query、参数值/类型非法、cursor 签名或内容无效、cursor 筛选冲突 | 422 | `VALIDATION_ERROR` |
| `admin_apis` 限流命中，默认 60 requests/min/admin | 429 | `RATE_LIMITED` |
| anomaly 事实记录或分页事实不一致 | 500 | `INTERNAL_ERROR` |

事实不一致包括返回记录不符合第 21.18 节 schema、`anomaly_key != match_id:type`、时间无效、计数非法、`details` 不是 object，或 open/resolved 与 `resolved_at`/`resolution` 的 nullable 组合不一致。此类失败不得把原始事实或内部诊断放入公开错误 `details`。

## 49.12 阶段 A3.1：provider-fixture-sync 业务时钟契约

本小节只冻结 `provider-fixture-sync` 单 fixture application 入口及其直接调用边界的业务时钟语义；不启动 A3 后续 retry/jitter/lease，也不改变 Provider 行为或调度器行为。

### `server_now` 输入与传递

`ProviderFixtureSyncService.applyFixture(raw_fixture, payload, server_now)` 的 `server_now` 必须是可信服务端传入的有效 `Date`，并作为本次同步调用的唯一业务时钟。有效性至少要求：值为 `Date` 实例且 `getTime()` 不是 `NaN`。

入口及其直接下游在同一次调用中必须使用同一个 `server_now` 时间点；不得通过无参 `new Date()`、`Date.now()` 或其他本地墙钟重新取得业务时间。已组装的 Provider job runner 也必须把收到的 `server_now` 原样传给 fixture loader 和 `applyFixture`。

Provider payload 中的 kickoff/status/score 时间或事实仍按第 31 节解析；它们是 Provider 数据，不得被 `server_now` 替换，也不得反过来作为服务端业务时钟。

### 必须由 `server_now` 决定的同步语义

在本入口及直接下游中，以下判断和事实时间必须由注入的 `server_now` 决定：

- scheduled 到达 `prediction_deadline_at` 的关闭判断，以及 live/finished 触发的立即关闭；具体按 49.4，postponed 不因旧 deadline 自动关闭。
- 成功同步后对 `LIVE_SYNC_STALE`、`LIVE_TOO_LONG`、`FINISHED_NO_SCORE` 等已定义时间谓词的评估；阈值公式仍以第 33 节为准。
- 本次 Provider 观察产生或更新的 `matches`、`match_results`、`provider_snapshots`、`anomalies` 及相关事实时间字段，包括 `created_at`、`updated_at`、`prediction_closed_at`、`finish_detected_at`、`resolved_at`；不得使用当前进程墙钟替代。
- 直接 loader 若按同步窗口筛选 fixture，其窗口起点、终点和本轮筛选也必须从传入的 `server_now` 计算。该项只冻结输入一致性，不冻结窗口之外的调度频率。

状态映射、Provider 数据合法性、状态回退、球队/开球变更保护和正式比分来源分别继续遵守第 31 节及既有状态机；本小节不新增状态或 Provider 特殊处理。

### 无效时间与未定义语义

- `server_now` 无效时，入口必须 Fail Closed，返回既有 `VALIDATION_ERROR`（`field=server_now`），并在事实写入、锁获取、Provider IO 或其他业务推进前停止。
- 本入口或直接下游遇到规范没有定义的时间组合时，不得猜测时间、继续写入或改变 Provider 结果；应 Fail Closed，并记录为 `SPEC_GAP` 供后续冻结。
- 当前切片已用固定服务端时间合同测试验证：即使进程墙钟不同，业务判断和 Provider 事实时间仍使用注入值。

### 不在本切片冻结的内容

以下内容仍不属于 A3.1：

- `future_schedule`、`full_schedule_verify`、`near_match`、`live_match`、`post_finish_verify` 的触发频率、调度器实现和生产运行时限。
- Provider HTTP client、凭证、网络 IO、quota 行为以及 Provider 返回内容之外的新业务行为。
- retry 次数/等待序列、jitter 随机源、lease 获取/续租/接管/失败停止点及其墙钟实现。

这些未冻结项继续是 A3 后续的 `SPEC_GAP`；本切片不以它们的实现状态推导或扩展 `provider-fixture-sync` 业务语义。`provider-sync-job` 中的 lease 续租墙钟不属于本入口业务事实时间契约，留待后续 A3 冻结。

## 49.13 阶段 A3.2：provider-sync-job loader 重试契约

本小节只冻结 `provider-sync-job` 的 loader 阶段重试、jitter、等待注入和 `sync_logs` 最小可观察语义；不启动 lease 获取/续租/接管规则、调度器频率或真实 Provider client 行为。OpenAPI 认证 security scheme 不在本切片修改范围内，`SPEC_GAP/H4` 保持不变。

### 错误分类

按现有 Provider error 类型和 `provider-sync-job` 实现，loader 错误分类固定如下：

| loader 错误 | 是否 retry | 规则 |
|---|---:|---|
| `ProviderHttpError` 且 `status=408` | 是 | 视为暂时 HTTP 错误 |
| `ProviderHttpError` 且 `status>=500` | 是 | 视为暂时 Provider HTTP 错误 |
| 普通 `Error`，且不属于 `DomainError` 或 `ProviderError` | 是 | 视为普通网络/暂时错误 |
| `ProviderQuotaExceededError` | 否 | 停止本次高频自动 retry |
| `ProviderDataError` | 否 | Provider 数据错误 Fail Closed |
| 其他 `ProviderError` | 否 | 未声明为暂时错误 |
| `DomainError` | 否 | 应用/校验错误 Fail Closed |
| 其他 `ProviderHttpError` status | 否 | 只有 408 和 `status>=500` 属于本合同 retry 集合 |

Provider client 将 HTTP 429 转换为 `ProviderQuotaExceededError`；即使 loader 直接抛出未转换的 `ProviderHttpError(429)`，也不属于本合同 retry 集合。单 fixture 应用阶段的失败不进入 loader retry。

### 尝试次数与等待

一次 job 先立即执行第 1 次 loader 调用。可 retry 错误最多安排 5 次 retry，因此最多发生 6 次 loader 调用；每次 retry 在下一次 loader 调用前等待，等待基准序列固定为：

```text
retry 1: 1m
retry 2: 2m
retry 3: 5m
retry 4: 10m
retry 5: 30m
```

第 5 次 retry 的等待后发生第 6 次 loader 调用；该第 6 次调用仍失败时，不再 sleep，直接记录为最终失败。不可 retry 错误不 sleep，直接结束本次 job。`attempt_count` 统计实际 loader 调用次数，不统计 sleep 次数；该 retry 规则不扩大到 scheduler 或 lease。

### Jitter 与测试注入

每次等待先将分钟数转换为毫秒 `base_ms`，再按现有实现计算：

```text
Math.round(base_ms * (1 + 0.20 * (2 * random() - 1)))
```

`random` 是 `ProviderFixtureSyncRetryOptions.random?: () => number` 注入的随机源；job 未注入时使用既有默认 `Math.random`，测试使用固定返回值即可确定性复现。合同边界按 `random=0/0.5/1` 固定为 `0.8/1.0/1.2 * base_ms`，结果取整数毫秒；随机源每次实际 sleep 调用一次。测试通过 `sleep?: (delay_ms: number) => Promise<void>` 注入已完成 Promise，不等待真实 1/2/5/10/30 分钟，只断言等待参数和调用次数。

### `sync_logs` 最小可观察语义

成功取得 job lock 后、首次 loader 调用前插入一条 `status=running` 日志：`attempt_count=1`、`finished_at=null`、`items_read/items_changed/items_failed=0`、错误字段为 `null`。loader retry 发生时，在 sleep 前更新同一日志为 `running`，写入当前失败后的 `attempt_count`、`last_error_code` 和 `last_error_message`，不写 `finished_at` 或虚构 item 统计。

loader 成功后更新为 `success`，`attempt_count` 为实际总尝试次数，`finished_at=server_now`，写入本批次 item 统计并清空错误字段。不可 retry 或 retry 耗尽后更新为 `failed`，`attempt_count` 为实际总尝试次数，`finished_at=server_now`、`items_failed=1`，并保留最终错误 code/message。Quota 错误因此只产生一次 loader 尝试和最终失败日志；锁未取得时仍跳过且不创建 sync log。

### SPEC_GAP

- 32.8 没有定义除本小节既有 Provider 类型、HTTP 状态和普通 `Error` 之外的新错误类型/状态如何分类；本合同不扩展 retry 集合。未来新增 Provider error type 或特殊 HTTP status 必须另行冻结。
- 32.8 提到 Provider 明确 reset 时间，但现有 `provider-sync-job` 只对 quota 停止本次高频 retry；`resetAt` 的等待、调度器交接和下一 scheduled run 的精确时机未由当前切片唯一确定，留待后续调度/lease 相关切片，不在此处猜测。
- 现有规范没有规定生产随机源的 seed、跨进程重放或按 `sync_job_id` 派生的算法。本小节只冻结现有可注入函数和边界测试确定性，不新增 hash/seed 算法；如需生产级 jitter 可重放性，需另行冻结。

## 49.14 阶段 A3.3：provider-sync-job job lease 合同

本小节只冻结 `provider-sync-job` 的 job lock 获取、续租、续租失败停止、释放和 lease 到期接管语义；不改变 `provider-fixture-sync` 的业务事实时间、不启动 scheduler、不改变其他 settlement 或维护任务的 lease 规则。OpenAPI 认证 security scheme 不在本切片修改范围内，`SPEC_GAP/H4` 保持不变。

### 获取与跳过

1. 每个 `job_type` 只使用同类任务锁 key：

   ```text
   sync:{job_type}
   ```

2. `server_now` 必须先通过既有有效时间校验；无效时在获取锁、写日志、loader 和 fixture 写入前 Fail Closed。
3. 每次成功尝试使用新的 `owner_id`，初次 `lease_until` 为：

   ```text
   server_now + FIXED_CONFIG_V1.JOB_LEASE_MINUTES
   ```

   当前固定配置 `JOB_LEASE_MINUTES = 10`，所以初次 lease 为 `server_now` 后 10 分钟。该初次 lease 时间是本次任务 lease 的合同输入，不使用进程墙钟。
4. `jobLocks.acquire` 必须保持原子 compare-and-set。获取失败表示已有未过期 owner：本次 job 返回 `skipped(lock_held)`，不调用 loader、不写 `sync_logs`，也不创建第二套业务写入。

### 续租与事实时间

成功获取锁后，现有 job 在每个 lease 时长的一半到达时尝试续租。当前固定配置下续租节点为获取后的 5 分钟；续租使用：

```text
lease_until = current lease wall-clock now + 10 minutes
```

这里的 wall-clock 只用于定时触发和计算锁的操作性到期边界。`load(server_now)`、`applyFixture(..., server_now)`、`sync_logs.started_at/finished_at` 以及其他业务事实时间仍全部使用同一次注入的 `server_now`，不得由续租墙钟替代。

`renew(lock_key, owner_id, lease_until)` 只允许当前 owner 且 lease 尚未到期时成功；返回 `false` 或抛异常均视为续租失败。首次观察到续租失败后立即停止后续定时续租尝试。

### 续租失败后的停止边界

续租健康状态在以下既有业务边界检查：

- 每次 loader 调用开始前；
- 每个 fixture 的 `applyFixture` 调用开始前；
- 成功 `sync_log` 更新开始前。

续租失败或异常被观察后，job 在下一个上述检查点抛出既有 `INTERNAL_ERROR`，不再开始新的 loader、fixture 应用或 success log 写入；已开始且正在等待的异步调用不被强行取消。job 进入既有 failed log 路径，记录 `finished_at=server_now` 和最终错误，并在 `finally` 中释放自身 owner 的锁。failed log 是停止结果的最小可观察记录，不是继续处理业务事实。

### 释放与接管

- 只有成功获取锁的本次 job 才执行 `finally release(lock_key, owner_id)`。
- repository 的 release 对非 owner 为空操作；因此一个 job 不得释放其他 owner 的 lease。
- 同一 `lock_key` 在 `lease_until` 未到期时拒绝其他 owner；当 `lease_until <= lock repository wall-clock now` 时视为到期，新的 owner 可通过同一原子 acquire 接管。
- 续租失败的旧 owner 不得通过 renew 恢复或覆盖已被新 owner 接管的 lease；新 owner 的 acquire/lease 结果独立于旧 owner 的释放调用。

### SPEC_GAP

- 本小节只使用现有固定配置和 `provider-sync-job` 已实现的半 lease 续租节点；其他任务、settlement lock 的续租周期和调度器频率未在此冻结。
- 规范没有定义跨进程/跨节点 wall-clock 偏差、锁存储端 server time 或续租 RPC 已发出但结果尚未返回时的竞态；本小节不新增分布式锁重构或时钟同步协议。
- scheduler 如何触发下一次 job、lease 接管后的调度交接和 Provider client 的真实网络行为不在本切片定义。

## 49.15 阶段 A4：`settlement_status` 写入审查与收口

本小节记录 A4 对 `src/**/*.ts` 的完整检索、业务调用链和最终分类；不新增状态、结算/重试规则或 API 字段。分类含义：

- **(a) 初始 `pending`**：新建 match 时的初始值。
- **(b) 合法状态机转移**：业务状态变化统一经 `transitionMatchSettlementStatus`，由 11.2/49.3 合法表校验后调用 `matches.updateSettlementStatus`。
- **(c) 非业务初始化/fixture**：测试/数据构造，或只保持既有状态、不产生 settlement 状态变化的 fixture 路径。
- **(d) 真实缺口**：业务路径直接在完整 `matches.update` 中改变 `settlement_status`，绕过既有 transition 入口。

### 审查清单

| 写入点与调用链 | 分类与结论 | 允许转移/处理 | 回归测试 |
|---|---|---|---|
| `provider-schedule-sync.buildMatch` → `discover` → `matches.insert` | (a)，保留 | 新 match 初始 `pending`，不是状态转移 | `provider-schedule-sync.test.ts` |
| `ProviderResultSyncService.applyFinishedFixture` → `matchResults.insert` → `transitionMatchSettlementStatus` → `matches.update` | 原为 (d)，已修复为 (b) | `pending→waiting`；已结算或结算中出现新版本按既有规则进入/保持 `correcting`；同状态保持 | `provider-result-sync.test.ts`：首次 FT transition 合同、Provider 赛果修正 |
| `ProviderStatusSyncService.applyCancelledFixture` → match 事实 update → `transitionMatchSettlementStatus` | 原为 (d)，已修复为 (b) | `pending/waiting/settling/failed→voided`；已 `settled` 记录 blocking anomaly，不作废历史 | `provider-status-sync.test.ts`：cancelled transition 合同、settled conflict |
| `ProviderStatusSyncService.applyAbandonedFixture` → match 状态 update | (c)，保留 match fixture 语义 | 仅更新 `match_status=abandoned`，保持既有 `settlement_status`；当前不再显式写同值 `pending` | `provider-status-sync.test.ts`：ABD 保持 pending |
| `AdminResultCorrectionService.correct` → `matchResults.insert` → `transitionMatchSettlementStatus` → match 事实 update → audit | 原为 (d)，已修复为 (b) | 未结算首次结果保持/进入 `waiting`；已结算结果按合法表进入 `correcting`；transition 先执行以避免 `settled` 中间态违反 result-version invariant | `admin-result-correction.test.ts`：修正 transition 合同、首次结果 |
| `FirstSettlementService`、`RetrySettlementService`、`CorrectionSettlementService` 的起态、失败和 finalize | (b)，保留 | 全部已使用既有 transition；finalize 先写 `settled_result_version`，再转 `settled/correcting` | 各 service tests、`settlement-state-machine.test.ts`、repository/invariant tests |
| `AdminRetrySettlementService` | (b)，保留 | 只选择目标并校验合法边，实际状态写入委托 First/Retry/Correction service | `admin-retry-settlement.test.ts` |
| `matches.updateSettlementStatus` repository 边界 | (b) 的底层写入口 | 仅由 transition helper 调用；保留其并发安全的局部状态更新，不在 repository 重写业务状态机 | `repositories.test.ts`、各 transition 合同测试 |
| 测试 fixture、类型/schema/invariant/read-only 查询中的 `settlement_status` | (c)，保留 | 仅构造、约束或读取事实，不是业务状态写入 | 对应 domain/application/repository tests |

### A4 结论

确认存在 3 条真实 (d) 缺口：Provider 合法 FT 结果、Provider cancelled、管理员赛果修正。三条路径均先补最小 RED 合同测试，再改为复用 `transitionMatchSettlementStatus` 并通过 GREEN；`settled→correcting` 路径保持既有 invariant 顺序，未放宽约束。除新建 match 的初始 `pending` 和 (c) 路径外，生产业务不再直接写 `settlement_status`。

本审查没有修改状态机转移表、结算/重试规则、A 阶段已冻结 API 或 OpenAPI 认证 security scheme。认证表达的后续关闭记录见 49.16。

## 49.16 H4：Auth OpenAPI 诚实表达关闭记录

本节只关闭 OpenAPI 合同层的 `SPEC_GAP/H4`，不实现网关、云函数、部署或客户端登录流程。

- `src/api/v1/openapi.yaml` 已删除全部 `BearerAuth`、`bearerFormat: JWT` 与 Bearer security 声明；不新增 JWT、Cookie、session token 或客户端可填写的身份 Header/security scheme。
- 文档根级固定 `x-trusted-runtime-openid`：身份字段为 `openid`，由 `gateway_or_runtime` 注入，且 `client_supply_forbidden: true`。
- 所有现有 Auth required operation（含 `POST /v1/session/init`）固定 `x-requires-trusted-openid: true`；公开读接口不写该标记。该标记只表达可信运行时依赖，不是客户端请求参数。
- 401 继续只表示缺少可信身份并使用 `UNAUTHORIZED`；已注销用户保持 `409 USER_DELETED`，非 active admin 保持 `403 FORBIDDEN`。本记录不改变既有 handler、业务字段或错误码。
- H4 合同测试与既有 API 测试继续直接注入 `trusted_openid`；具体平台字段、网关注入点、本地模拟和平台登录流程仍留给 B3，且不得反向改变本 API 合同。

---

> 编码 Agent：第 49 节已冻结，直接执行；本节明确保留的 `SPEC_GAP` 只阻止未定义部分扩展，不得影响已冻结合同。
