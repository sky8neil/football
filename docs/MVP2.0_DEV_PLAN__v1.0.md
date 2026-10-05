# MVP 2.0 源码对齐开发文档 v1.0

> 状态：可执行开发计划（只读对照产出）。业务基线：`docs/MVP__v2.0.md`（FROZEN）。  
> 范围：项目未上线，**不做迁移 / 兼容 / 灰度**；旧实现直接拆除。  
> 对照对象：`src/`（domain / application / infrastructure / provider / api / schema / sync / scheduler / gateway / cloud-function / acceptance）与 `miniprogram/`。  
> 本文件不改规范、不改代码。

---

## 0. 结论摘要

现有源码是 v1 机器：八级 + 胜平负准确率即时定级、周/月榜、英超单联赛、无群、无生涯/实力快照。MVP 2.0 把等级、排行榜、联赛范围、对外口径整套换掉。账本（settlements / settlement_items / predictions / match_results）与计分 `scoring_v1` 可保留；**等级写路径、排行比较器、赛季口径必须整模块替换**，否则会出现双真值。

| 项 | 值 |
|---|---|
| 差异条目（下文 §1） | **72** |
| 最大风险 | 结算 item 仍即时 `calculateLevel`；若不先切断旧写路径，周评估 / replay 会与缓存互相覆盖 |
| 待确认 | **8**（文末 §6） |
| 建议切片 | S0 → S10（§3），S0 必须先于任何业务写路径改动 |

---

## 1. 现状 vs MVP 2.0 差异清单

每条：位置 / 现状 / 要求 / 类型 / 影响面。类型：**新增** / **修改** / **删除**。

### 1.1 等级

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D01 | `src/domain/levels.ts` `LEVEL_MAX=8`；`theoreticalAccuracyLevel` / `sampleSizeLevel` / `calculateLevel` | 八级；`final = min(准确率档, 样本档)`；career `<20 → 1`，season `<10 → 1` | §17.2：取值域 `1..6`；称号表六级。§0.4：入口改为 `build_level_inputs` / `evaluate_level` / `replay_level` | **修改**+**删除** | domain、settlement、rebuild、daily consistency、levels API、OpenAPI、全部 L 组测试 |
| D02 | 同上；`src/application/level-rebuild.ts` `rebuildLevelState` | 每场结算/rebuild 用当前 `valid_predictions`+`wdl_hits` 即时算出等级，可一次跨多级（测试：season 40/28 从 4 直接到 6） | §17.6：周评估，一次最多 ±1；升级需 `s` 过线 **且** `B` 过线；Lv2 地板不降回 Lv1（除 rebuild 纠错） | **修改** | `settlement-item-application-service.ts:415+444`、`stats-rebuild-service.ts:222+291`、`share-card.ts:157`、`daily-consistency-snapshot.ts:152+191` |
| D03 | 无 `build_level_inputs` / 窗口逻辑 | 无 300 场 / 730 天窗口，无 `S`/`n`，无收缩公式 | §17.5：窗口按 `period_anchor_at DESC, match_id ASC` 取 `min(300, 候选)`；`s=(S+68)/(n+40)`；判定用交叉乘法 `100*(S+P0) >= T*(n+K)`，禁止浮点真相 | **新增** | 新 domain 模块；实力榜 `s_display_x100`；level_history 截面 |
| D04 | 无 `LEVEL_B_POINTS`；B 值未参与定级 | 参与门槛是样本量 | §3 / §17.3：B 线 `{3:80,4:170,5:380,6:630}`；career 取 `career_points`（`applied_at < as_of` 的 `SUM(score_delta)`），season 取该等级赛季积分；B 永不导致降级 | **新增** | evaluate_level、rebuild、consistency |
| D05 | 无周评估 job | 等级随 settlement item 写入 | §17.6.2 / §32.9：`as_of` = 每周一 10:00 Asia/Shanghai（= 周一 02:00 UTC）；任务最早 `as_of+10min`；锁 `sync:weekly_level_eval`；同 as_of 幂等 | **新增** | `src/domain/enums.ts` `SyncJobType`、`src/sync/config.ts`、`src/scheduler/tick.ts`、`src/scheduler/triggers.md`、新 application 服务 |
| D06 | `LevelHistoryReason` = `settlement \| correction \| rebuild \| season_start`（`enums.ts:106-114`） | 首次结算即写 history（reason=settlement）；correction 即时改等级 | §17.7：首次结算 **不**即时评估；correction `phase=done` 后 **supersede** 本周结论（以 `week_base` 为起点重跑）；reason 封闭为 `weekly_eval \| correction_reeval \| rebuild` | **修改**+**删除** | settlement 写路径、level_history schema、correction 编排、§44 J-73/J-74 |
| D07 | `user_season_stats.season_id`（`types.ts:71`、`collections.ts:60`）按 **联赛** `matches.season_id` 分组（`settlement-item-application-service.ts:437` `match.season_id`；`stats-rebuild.ts` 按 prediction→season_id） | 英超 `2026_2027` 一条；无冻结 | §16.2 / §17.8：`level_season_id` 平台口径，北京时间 7/1 00:00 切年，形如 `"2026_2027"`；不按联赛 `season_id`；`is_level_frozen` 最终评估后冻结等级 | **修改** | schema UNIQUE、stats rebuild 分组键、settlement 创建 stats、分享卡 season_level |
| D08 | 无 `career_level_state` / `level_state` | users 只有 `career_level`/`career_best_level` | §17.6.1 / §21.1 / §21.2：`below_count`、`week_base_*`、`last_eval_*`（n/S/b/rule_version/as_of） | **新增** | users、user_season_stats、invariants、rebuild、daily consistency |
| D09 | `level-rebuild.ts` / `stats-rebuild-service.ts` 用 `calculateLevel` 覆盖缓存 | 「当前统计的纯函数」，可跨多级 | §17.9：`replay_level` 按周评估时刻 + correction `settled_at` 事件序列 fold；路径依赖；rebuild 允许跨多级纠错并写 `reason=rebuild` | **修改** | rebuild、daily consistency §17.9.4（周中缓存≠即时计算结果 **不是**差异） |
| D10 | `share-card.ts:157-161` 现场 `calculateLevel(Season, …)` | 读预测缓存现场算本赛季等级 | §17.8.3 / §20 / §29：`season_level` **读缓存，禁止现场计算** | **修改** | share-card 服务与测试 |
| D11 | `invariants.ts:49-52` 只断言 `best >= level`，无 `1..6`、无 `level>=2 ⇒ valid>=20`、无窗口约束 | 允许 1..8 | §21.1 / §40：`1<=level<=6`；`career_level>=2 ⇒ career_valid_predictions>=20`；`last_eval_n<=300`；`0<=S<=12n`；非 rebuild 相邻 `|Δlevel|<=1` | **修改** | invariants + 测试 |
| D12 | 保护期 / `below_count` / 一次一级 均不存在 | 无 | §17.6.4：`LEVEL_PROTECTION_EVALS=13` 全局；连续 2 周低于保级线才降；Lv1/Lv2 不降 | **新增** | evaluate_level、周评估、L-98..L-101 |
| D13 | `levels.ts` API 返回 `wdl_hits`/`wdl_accuracy_percent`，season 用 `MVP_SEASON.season_id` | 对外展示准确率 | §28.1：不返回 s/S/n/B/阈值/降级计数；返回 `is_rated`、`remaining_to_rated`、`last_evaluated_at`、`next_evaluation_at`、`level_season_id`、`is_frozen`、`rule_version=level_v3.0`、可选 `career.is_former_top` | **修改** | `application/levels.ts`、`api/v1/levels.ts`、`openapi-levels.test.ts`、小程序 profile |

### 1.2 排行榜

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D14 | `src/domain/ranking.ts` `compareRankingEntry` | 排序：分数 DESC → **准确率交叉乘法** → exact DESC → last_scoring ASC → user_id ASC | §19.5：week/career 为分数 DESC → exact DESC → **valid_predictions ASC** → last_scoring ASC → user_id；**不得**用准确率。实力榜另比较器：`s` 交叉乘法 DESC → n DESC → user_id | **修改** | ranking domain、settlement 重排、rebuild、query、测试 K 组 |
| D15 | `MIN_RANK_PREDICTIONS=3`（`config.ts:57`）、`isRankEligible`、`rankForPosition`；`ranking.test.ts` K78/K79 | `<3` 场 `global_rank=null` | §19.1 `WEEK_BOARD_MIN_VALID=1`：1 场即入本周榜且有 rank | **修改** | config、settlement 重排、ranking-rebuild.ts:22 注释与实现 |
| D16 | `PeriodType = week \| month`（`enums.ts:49-53`）；settlement 同时写 week **和** month（`settlement-item-application-service.ts:462-470`） | 月榜是一等公民 | §1.3 / §19.1 / §21.9 / §32.6：**取消月榜**；`rankings.period_type` 收敛为 `week`；非法 `board`/`period_type=month` → 422 | **删除** | domain/time `monthPeriodKey`、period-finalize、admin rebuild rankings、API、OpenAPI、前端 |
| D17 | 无 `board=career/strength`，无 `board_snapshots` | 生涯/实力不入榜 | §19.1 / §21.20 / §32.11-32.12：生涯榜 60min 快照；实力榜周评估后 + 每日 1 次；入榜门槛 career `valid>=1`、strength 窗口 `n>=50` | **新增** | 新 collection、job、query、admin rebuild |
| D18 | `api/v1/rankings.ts` query=`period_type+period_key`；响应无 `board`/`scope`/`me`/`updated_at`；`ranking-query.ts` item 含 `wdl_hits`/`wdl_accuracy_percent` | 公开周/月列表 | §27.1：`board` required；`scope=global\|group`；`me` 块（ranked / not_participated / below_threshold）；Top20 / 每页 10 / 无第 3 页；禁止准确率字段 | **修改** | API、OpenAPI、gateway、前端 `miniprogram/services/rankings.js` |
| D19 | 无群 | — | §19.4 / §21.21-21.22 / §27.2：`groups`/`group_members`；邀请码 8 位；上限 500/20/5；群榜按全站数据过滤后重排，不单独持久化 | **新增** | 全新模块：domain/application/api/schema/indexes/gateway/限流 |
| D20 | 无 `users.career_last_scoring_match_at`（`types.ts` User 无此字段；全仓 grep 0 命中） | 生涯并列键不存在 | §16.1 / §19.5 / §21.1：生涯榜第 4 键；语义 = 有效预测中 `match_score>0` 的 `period_anchor_at` 最大；分数=0 时 null | **新增** | users schema、settlement 增量、stats-rebuild、consistency |
| D21 | `period-finalize-service.ts` 对任意 `PeriodType`（含 month）封榜 | 调度注释写 week/month | §32.6：只 finalize `week`；correction 不得把 `is_final` 改回 false | **修改** | period-finalize、scheduler triggers.md:25 |
| D22 | 已注销用户：ranking-query 读 display_name「已注销用户」，但仍可能出现在当前榜 | 需核对 query 是否过滤 `status=deleted` | §19.7：当前 week/career/strength **不进入**排序；已 `is_final` 历史周保留并显示「已注销用户」 | **修改** | ranking-query、快照 job、测试 M 组 |

### 1.3 准确率对外口径

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D23 | `application/profile.ts:19,32,82,108`；`application/levels.ts:20,34-38,49`；`application/ranking-query.ts:25-27`；`miniprogram/pages/profile/profile.js` `displayAccuracy`；`pages/rankings/rankings.js` `wdl_accuracy_percent` | 对外返回 `career_wdl_accuracy_percent` / `wdl_accuracy_percent` | §16.3 / §24.2 / §24.5 / §27.1 / §28.1：准确率只内部统计，**任何对外 API 不得出现**；内部比较仍用交叉乘法 | **删除**（对外） | API 合同、OpenAPI schema、前端展示、openapi-*.test.ts |
| D24 | `career_wdl_hits` / season `wdl_hits` 仍写入账本（正确） | 结算增量维护命中 | §16.3 / §17.11：继续维护，供运营；不用于定级/排序 | **保留**（非差异，列此防误删） | 勿删 settlement delta 与 rebuild 公式 |

### 1.4 Schema / 索引

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D25 | `schema/collections.ts` users：`career_level`/`career_best_level` `min:1 max:8`；无 `career_last_scoring_match_at`、无 `career_level_state` | v1 缓存形状 | §21.1 | **修改** | collections、cloudbase-repository、invariants、session `buildUser` |
| D26 | `user_season_stats`：`season_id`；UNIQUE(user_id, season_id)；level max 8；无 `level_state`/`is_level_frozen` | 联赛赛季文档 | §21.2：`level_season_id`；UNIQUE(user_id, level_season_id)；level 1..6 | **修改** | indexes.ts:18-22、repositories `findByUserAndSeason` 参数名与键 |
| D27 | `teams` 无 `league_id`（`types.ts:82-91`、`collections.ts:74-86`）；`provider-team-sync.ts:111-121` 创建 Team 不写联赛 | 球队不属联赛 | §21.3：`league_id` 六联赛枚举 required | **新增** | team sync、favorite_team 校验、多联赛隔离 |
| D28 | `matches.round_id` note `"01..38"`；`league_id` default `premier_league` | 单联赛假设 | §21.5 / §5.3：round 上限按 league（38/34/30）；`league_id` 封闭六枚举 immutable | **修改** | collections、provider-schedule-sync `parseRoundId` 1..38 写死 |
| D29 | `rankings.period_type` enum `["week","month"]` | 月榜可落库 | §21.9：enum 仅 `week` | **修改** | collections、indexes 可保留 period_type 前缀但取值收敛 |
| D30 | `level_history`：`season_id`、`wdl_hits`、`valid_predictions`、reason 四值、from/to max 8 | v1 定级输入快照 | §21.13：`level_season_id`；改为 `eval_as_of`/`window_n`/`window_score_sum`/`b_points`/`level_rule_version`/`settlement_id`；删除 wdl/valid 快照字段；reason 三值 | **修改** | collections、level-rebuild 写入、indexes 22.2 需补 `(user_id, scope, level_season_id, changed_at DESC)` |
| D31 | 无 `board_snapshots` / `groups` / `group_members` | 集合不存在 | §21.20-21.22 / §22.1-22.2 | **新增** | collections、indexes、repositories、cloudbase |
| D32 | `sync_logs.job_type` 七值（`collections.ts:370-381`、`enums.ts:115-123`） | 无等级/快照 job | §21.17 增加 `weekly_level_eval`、`level_correction_reeval`、`board_snapshot_career`、`board_snapshot_strength` | **新增** | enums、schema、scheduler |
| D33 | `indexes.ts` 无 groups / board_snapshots / user_season_stats `(level_season_id, level DESC)` | v1 索引集 | §22.1-22.2 | **新增**+**修改** | schema-migration、indexes.test.ts |
| D34 | `admin_audit_logs` rebuild_rankings 快照用 `total_period_score`/`max_global_rank`（`admin-rebuild-rankings.ts:48-58`） | 只服务 week/month | §21.14：`entity_id` = `board` + "-" + (`period_key` 或 `"snapshot"`)；career/strength 用 `total_career_points`/`total_window_score_sum`；rebuild_user_stats 增加 `level_state_changed: bool` | **修改** | admin audit contract 测试、openapi-admin-* |

### 1.5 API 合同（§24 / §26 / §27 / §28 / §29 / §30 / §4.6）

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D35 | `gateway/assemble.ts` 只接线：session/init、matches 列表/详情、POST predictions、GET predictions/me、profile/me GET、levels/me、unlocks/me、rankings。`assemble.ts:334` 其它路径 422「不支持的请求」 | PATCH/DELETE profile、GET profiles/:id、GET predictions/me/:id、share-card、全部 admin、全部 groups **网关未暴露**（部分 application/api handler 已存在） | §24.3-24.5 / §26.3 / §27.2 / §29 / §30 | **修改**（补齐网关）+ **新增**（groups） | gateway、cloud-function、测试 v1-v6 |
| D36 | `api/v1/session.ts` 响应含 `career_level`（已有）；`application/session.ts` `buildUser` 无 level_state / last_scoring | 新用户 level=1 点数正确 | §24.1 响应字段已对齐；创建时需初始化 `career_level_state` 默认与 `career_last_scoring_match_at=null` | **修改** | session buildUser |
| D37 | `application/profile.ts` MyProfile 含 `career_wdl_hits`+准确率，**无** `season_level`；PublicProfile 含准确率、无 `career_exact_hits`/`season_level` | v1 资料卡 | §24.2 / §24.5 | **修改** | profile query + api + 前端 |
| D38 | `api/v1/matches.ts` `MATCHES_QUERY_FIELDS` 无 `league_id`；`match-query.ts` `MatchListQuery` 无 league 过滤 | 默认全表（实际只有英超） | §25.1：`league_id` optional 六枚举；缺省全部联赛 | **修改** | matches API、OpenAPI、小程序已按 league 分组但后端滤不了 |
| D39 | `api/v1/predictions.ts:26` history query 仅 `season_id`（必填语义，绑 `MVP_SEASON`）；`prediction-query.ts:248` 过滤 `match.league_id !== MVP_SEASON.league_id` | 只能看英超当前赛季 | §26.2：`league_id` optional，缺省全部联赛；`season_id` 仅与 league 同时提供且必须等于该联赛当前登记值 | **修改** | predictions API、cursor 绑定 league+season |
| D40 | 群 API 全无；`domain/errors.ts` 无 `GROUP_*` | — | §23.7 新增 8 个 GROUP_ 错误码；§27.2 六个端点 | **新增** | errors、api、gateway、rate-limit `POST /groups*` 10/min |
| D41 | `api/v1/rate-limit.ts` 无 groups scope | 五档 | §36.4 增加 `POST /groups*` 10/min/user | **新增** | rate-limit + 测试 |
| D42 | `application/share-card.ts` query 仅 `season_id+round_id`；round regex `01..38`；`season_level` 现场计算；无 `league_id` 响应字段；deleted 抛 `USER_NOT_ACTIVE` | 单联赛分享卡 | §29.1：`league_id` required；season/round 按联赛校验；读缓存 season_level；响应含 `league_id`；注销 409 `USER_DELETED` | **修改** | share-card 全栈 |
| D43 | `api/v1/admin.ts` rebuild rankings body=`period_type+period_key+reason` | week/month rebuild | §30.6：`board` + 条件 `period_key`；career/strength 走 §35.4 | **修改** | admin API、audit entity_id |
| D44 | OpenAPI `src/api/v1/openapi.yaml` info 写「规范 v1.0」；`/rankings` summary「周榜或月榜」；无 `/groups*` | 合同落后 | §23-30 全量对齐；groups tag | **修改** | yaml + 全部 openapi-*.test.ts |
| D45 | 鉴权：`gateway/identity.ts` + `assemble.ts` resolveIdentity 四态（anonymous/unregistered/deleted/active）已按 §4.5.1 | 身份解析可用 | §4.6 保持；groups 写接口必须 Auth required + active | **保留**+接线 | 新 handler 复用 `authenticatedReadUserId` |

### 1.6 多联赛 / Provider / 同步

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D46 | `domain/config.ts` `MVP_SEASON` 单例英超 39 / 2026 / `2026_2027` | 全仓同步/查询/分享卡/levels 都读它 | §1.4 `SUPPORTED_LEAGUES` = 六行表；`LEVEL_ELIGIBLE_LEAGUES` 同源 | **修改** | config、fixture-loader、team-sync、schedule-sync、match-query、prediction-query、share-card、levels |
| D47 | `provider-fixture-loader.ts:75-76` `leagueId: MVP_SEASON.api_football_league_id` | 只拉英超 | §32：五类 sync **对每个联赛分别执行**（可单任务遍历），lease 不按联赛拆 job_type | **修改** | future/full/near/live/post-finish loaders |
| D48 | `provider-schedule-sync.ts:48-76` round 解析固定 1..38；`buildMatch` 写入 `MVP_SEASON.league_id/season_id` | 德甲/法甲 35+、中超 31+ 无法表达；中超 season_id 格式会被写成跨年 | §5.3 / §1.4：按 league 上限；五大 `YYYY_YYYY+1`，中超 `YYYY`；超出 → `PROVIDER_DATA_INVALID` | **修改** | schedule-sync、fixture-mapper、异常 |
| D49 | `provider-team-sync.ts` 只 sync 英超；Team 无 league_id | 其它联赛球队不存在，主队无法选 | §1.2.4 / §4.4 / §21.3 | **修改** | team-sync 遍历六联赛 |
| D50 | 无等级赛季函数 `level_season_of(period_anchor_at)` | C22 测试仍按跨月踢（`acceptance-44-c-postponement.test.ts:29` `CROSS_MONTH_KICKOFF`） | §17.8.1 / §44 C-22：6/30 23:59 北京 → 旧等级赛季；7/1 00:00 → 新；延期跨此边界按新 anchor | **新增** | domain/time、延期测试改写 |

### 1.7 配置与版本

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D51 | `FIXED_CONFIG_V1` 含 `GLOBAL_WEEK_MIN_PREDICTIONS=3`、`GLOBAL_MONTH_MIN_PREDICTIONS=3`、`RANKING_UI_LIMIT=20`；无任何 `LEVEL_*` / `RANKING_BOARDS` / `GROUP_*` | v1 冻结集 | §3：`LEVEL_RULE_VERSION=level_v3.0` 及全部 LEVEL_/RANKING_/GROUP_ 常量；删除月榜门槛 | **修改**+**新增**+**删除** | config.ts 及所有引用 MIN=3 的测试 |
| D52 | 无规则版本生效表（as_of） | 等级无版本 | §3 / §17.8.5：数值变更必须 `level_v3.x` 只追加；评估取 as_of 时生效版本 | **新增** | domain 配置表（可先只登记 v3.0） |
| D53 | `LEVEL_FIRST_EVAL_AS_OF` 未登记 | — | §3：上线后首个周一 10:00，只追加不回溯 | **新增** | 待确认 Q1 |

### 1.8 结算 / 修正衔接

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D54 | `settlement-item-application-service.ts:412-457` 每个 applied item 调 `rebuildLevelState`（reason=settlement 或 correction）并写 users/season level + 可能写 level_history | 首次结算即时升/降；correction 也当即时重算，可跨多级 | §17.7.7：仅 correction 触发重评任务；§34.1-34.3：item 只更新 **week** rankings + career/season **积分命中**；等级不在 item 事务里定 | **修改** | 结算核心；最大双真值风险点 |
| D55 | 同文件同时更新 week+month rankings，重排两套 global_rank | 月榜增量 | §34.1-34.3 只 week；career/strength **不做逐场增量**（§34.4） | **删除** month 分支 | 15.8 rank 锁 key 仍 `ranking:week:{period_key}` |
| D56 | 无 `level_correction_reeval` 编排；correction settlement `phase=done` 不入队重评 | 等级已在 item 内改完 | §32.10 / §17.7：done 后对 `score_delta≠0` 用户入队；与周评估按 as_of 串行 | **新增** | settlement-orchestration / post-finish 之后的 hook |
| D57 | `lastScoringAt` 只服务 period ranking | 无 career last_scoring 维护 | §15.7 + §16.1 生涯键 | **修改** | item apply 与 rebuild |

### 1.9 权限 / 生命周期 / 不变量 / 验收

| ID | 位置 | 现状 | MVP 2.0 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D58 | `invariants.ts` 无等级 1..6、无窗口、无群 member_count、无 board_snapshots | v1 子集 | §40 等级段 + 排行榜/群段 | **修改** | domain/invariants + tests |
| D59 | 无 groups 软删除保留 | — | §0.6 / §37：groups/group_members/board_snapshots/level_history 禁止物理删（快照按 N 版运维清理） | **新增** | 生命周期；N 待确认 Q2 |
| D60 | `acceptance/matrix-44-coverage.test.ts` 追踪 **M100-M104**（v1 编号）；`domain/levels.test.ts` 标题 L92-L96 测八级准确率；`domain/ranking.test.ts` K78-K82 测 3 场门槛+准确率并列 | 覆盖的是 v1 矩阵 | §44：K 组 78-88 全部改写；L 组 89-114 全部改写；M 现为 115-122；C22 改为等级赛季边界 | **修改** | 验收测试基线；旧标题必须删以免假绿 |
| D61 | 无 L-24 / §17.13 模板回测 | — | 上线前门禁：三种固定模板滚动回测，若 n=300 时 s≥2.05 则出 level_v3.1 | **新增** | 独立回测脚本/测试；待确认 Q3 |
| D62 | §17.12 Elo/挑联赛监控 | 未实现 | 不入判定、不入 anomalies、不入用户字段 | **新增**（可后置） | 待确认 Q4：是否纳入本轮 DoD |
| D63 | `miniprogram/app.json` 无群页面；rankings 周/月+准确率；matches mock 缺意甲/德甲（`matches.js` LEAGUES 仅英超/西甲/法甲/中超） | v1 UI + 部分联赛展示稿 | 规范 §1.3 前端 UI 为 OUT_OF_SCOPE，但 **现有前端会在 API 改字段后立即损坏** | **修改**（跟随合同） | 小程序 services/pages；群 UI 待确认 Q5 |

### 1.10 其它已核对、本轮非主差异（保持）

以下与 v2.0 仍一致或仅需随字段扩展，**不要重写**：

- 计分 `src/domain/scoring.ts` 0/3/12、`derive_result`
- 比赛/结算状态机、prediction lock 10min、两层幂等
- `deleted_openid_mappings` 与 session 重注册隔离（§4.5.1 已落地）
- unlock 30/100/200 永不回收（`unlock-decision.ts`）
- job lock CAS / lease 10min / sync retry 1/2/5/10/30
- daily consistency「只报警不修复」策略（需改 **期望值公式**，不是改策略）
- Provider 只读、FT 才抽 fulltime、未知状态 fail-closed

---

## 2. 变更清单（按模块 → 文件）

约定：`改` = 改现有文件；`加` = 新文件；`删` = 删除符号/分支/测试（文件可留，禁止双实现）。依赖列的是必须先完成的切片。

### 2.1 domain

| 文件 | 动作 | 内容 | 依赖 |
|---|---|---|---|
| `src/domain/config.ts` | 改 | 删除 `GLOBAL_MONTH_MIN_PREDICTIONS`、`GLOBAL_WEEK_MIN_PREDICTIONS=3`、`MIN_RANK_PREDICTIONS`；`MVP_SEASON` 升级为 `SUPPORTED_LEAGUES` 表（六行，含 api_football_league_id/season/season_id/round_max）；新增全部 §3 `LEVEL_*` / `RANKING_*` / `GROUP_*`；`LEVEL_RULE_VERSION="level_v3.0"` | S0 |
| `src/domain/enums.ts` | 改 | `PeriodType` 仅 `week`（或保留 month 但所有业务入口拒绝）；`LevelHistoryReason` → `weekly_eval \| correction_reeval \| rebuild`；`SyncJobType` +4；新增 `RankingBoard`、`RankingScope`、`GroupStatus`、`GroupMemberStatus` | S0 |
| `src/domain/errors.ts` | 改 | 增加 §23.7 `GROUP_*` 工厂 | S0 |
| `src/domain/ids.ts` | 改 | 增加 `invite_code` 生成（alphabet §3，原子唯一由 repo 保证）；`group_id` 走现有 UUID | S6 |
| `src/domain/types.ts` | 改 | User + `career_last_scoring_match_at` + `career_level_state`；UserSeasonStats `season_id`→`level_season_id` + `level_state` + `is_level_frozen`；Team + `league_id`；RankingEntry `period_type` 仅 week；LevelHistoryEntry 换字段；新增 BoardSnapshot / Group / GroupMember | S0 |
| `src/domain/levels.ts` | 改（实质重写） | **删除** `calculateLevel`/`theoreticalAccuracyLevel`/`sampleSizeLevel`/`LEVEL_MAX=8`。实现唯一入口：`buildLevelInputs`、`evaluateLevel`、`replayLevel`、`levelSeasonOf`、整数 `s` 判定与 `s_display_x100` | S1 |
| `src/domain/levels.test.ts` | 改 | 删除 L92-L96 v1 用例；按 §44 L89-L114 重写（见 §4） | S1 |
| `src/domain/ranking.ts` | 改 | `compareRankingEntry(board, a, b)`：week/career 一比较器，strength 另一比较器；删除 `compareAccuracy`；门槛 1 / 50 | S2 |
| `src/domain/ranking.test.ts` | 改 | 按 §44 K78-K88 | S2 |
| `src/domain/time.ts` | 改 | 增加 `levelSeasonOf`、`nextMondayEvalAt`（周一 10:00 上海）；`calculatePeriodKey` 拒绝 month；`monthPeriodKey` 删除或仅测试禁用 | S0/S1 |
| `src/domain/time.test.ts` | 改 | 等级赛季 6/30 vs 7/1；删 month 周期用例（或标删除） | S0 |
| `src/domain/invariants.ts` | 改 | §40 等级/榜/群断言；level 1..6 | S0 |
| `src/domain/invariants.test.ts` | 改 | 同步 | S0 |
| `src/domain/groups.ts` | 加 | 群名拼接「{昵称}的预言群」/「已注销用户的预言群」；成员上限校验纯函数 | S6 |

### 2.2 schema / infrastructure

| 文件 | 动作 | 内容 | 依赖 |
|---|---|---|---|
| `src/schema/collections.ts` | 改 | 按 §21 改 users/user_season_stats/teams/rankings/level_history/sync_logs；新增 board_snapshots/groups/group_members | S0 |
| `src/schema/indexes.ts` | 改 | UNIQUE 与查询索引按 §22；`uk_user_season` 字段改 `level_season_id` | S0 |
| `src/schema/indexes.test.ts` | 改 | 断言新索引集合 | S0 |
| `src/infrastructure/repositories.ts` | 改 | UserSeasonStatsRepository 键改名；新增 BoardSnapshot/Group/GroupMember ports；InMemoryStore 同步 | S0 |
| `src/infrastructure/repositories.test.ts` | 改 | 唯一约束：invite_code、board snapshot、group_members | S0 |
| `src/infrastructure/cloudbase-repository.ts` | 改 | 映射新字段；新集合读写 | S0 |
| `src/infrastructure/schema-migration.ts` | 改 | **未上线**：只保证空库按新 schema 建齐；禁止写 1..8→1..6 数据迁移 | S0 |
| `src/infrastructure/environment-config.ts` | 改 | 如有单联赛环境键，改为联赛表 | S3 |

### 2.3 application — 结算 / 统计 / 等级

| 文件 | 动作 | 内容 | 依赖 |
|---|---|---|---|
| `src/application/level-rebuild.ts` | 改（重写） | 现 `rebuildLevelState(scope, valid, wdlHits, …)` **删除**。改为调用 `replayLevel`；输出是否写 `reason=rebuild` history | S1, S4 |
| `src/application/level-rebuild.test.ts` | 改 | 删除「40/28 → level 6」「跨多级普通结算」；改为 replay 轨迹 | S1 |
| `src/application/settlement-item-application-service.ts` | 改 | **切断** item 内 `rebuildLevelState`；只更新 career/season 积分命中、`career_last_scoring_match_at`、**仅 week** rankings；correction 不在此改 level | S4 必须先于继续结算功能 |
| `src/application/settlement-item-application-service.test.ts` | 改 | 断言首次结算后 level 仍为结算前；month 文档不再出现 | S4 |
| `src/application/stats-rebuild.ts` | 改 | season 分组键：`period_anchor_at → level_season_of`，**禁止** `matches.season_id` | S1, S4 |
| `src/application/stats-rebuild-service.ts` | 改 | 调 replay；best_level 只增；写 `level_state_changed` | S4 |
| `src/application/ranking-rebuild.ts` | 改 | 删除 month；门槛 1；比较器无准确率；valid ASC | S2 |
| `src/application/ranking-rebuild-service.ts` | 改 | `assertPeriodType` 只允许 week；增加 `rebuildBoardSnapshot(board)` | S2, S5 |
| `src/application/daily-consistency.ts` | 改 | expected 含 level_state / last_inputs 截面；rankings 仅 week；加 snapshots/groups 抽样差异类型 | S4, S5 |
| `src/application/daily-consistency-snapshot.ts` | 改 | **禁止**再调 `calculateLevel`；按 §17.9.4 重算 last_inputs 与 evaluate(week_base, last_inputs) | S4 |
| `src/application/weekly-level-eval.ts` | 加 | §32.9 job：选评估对象、幂等 as_of、写缓存+history | S1, S4 |
| `src/application/level-correction-reeval.ts` | 加 | §32.10 / §17.7 supersede | S1, S4 |
| `src/application/board-snapshot.ts` | 加 | career 60min；strength 周评估后+每日；只读 users/last_inputs，禁止扫 predictions | S1, S2, S5 |
| `src/application/groups.ts` | 加 | 创建/加入/退出/解散/列表；邀请码冲突重试 | S6 |
| `src/application/period-finalize.ts` / `period-finalize-service.ts` | 改 | 只接受 week；triggers 文案去掉 month | S2 |
| `src/application/share-card.ts` | 改 | 必填 league_id；round 上限按联赛；season_level 读 user_season_stats；注销码 USER_DELETED | S3, S4 |
| `src/application/profile.ts` | 改 | 去掉准确率；加 season_level、公开资料 exact_hits | S4 |
| `src/application/levels.ts` | 改 | §28.1 形状；读缓存 | S1, S4 |
| `src/application/ranking-query.ts` | 改 | board/scope/group；me 块；Top20/page=10；过滤 deleted；career/strength 读快照 | S2, S5, S6 |
| `src/application/match-query.ts` | 改 | query.league_id | S3 |
| `src/application/prediction-query.ts` | 改 | league_id optional；去掉写死 `MVP_SEASON.league_id` 过滤；cursor 绑定 league+season | S3 |
| `src/application/session.ts` | 改 | buildUser 初始化 level_state / last_scoring=null | S0 |
| `src/application/admin-rebuild-rankings.ts` | 改 | 入参 board；audit 字段 §21.14 | S2, S5 |
| `src/application/admin-rebuild-user-stats.ts` | 改 | audit + `level_state_changed` | S4 |
| `src/application/provider-fixture-loader.ts` | 改 | 遍历 SUPPORTED_LEAGUES | S3 |
| `src/application/provider-schedule-sync.ts` | 改 | round 上限按 league；match.league_id/season_id 来自映射表而非 MVP_SEASON | S3 |
| `src/application/provider-team-sync.ts` | 改 | 六联赛；写入 `teams.league_id` | S3 |
| `src/application/settlement-orchestration-service.ts` | 改 | correction done → enqueue level_correction_reeval | S4 |

### 2.4 api / gateway / scheduler / OpenAPI

| 文件 | 动作 | 内容 | 依赖 |
|---|---|---|---|
| `src/api/v1/rankings.ts` | 改 | 校验 board/scope/group_id/period_key 组合；响应新 envelope | S2 |
| `src/api/v1/levels.ts` | 改 | 新 data 形状 | S1 |
| `src/api/v1/profile.ts` | 改 | 去准确率；season_level；确保 PATCH/DELETE/公开资料 handler 仍可用 | S4 |
| `src/api/v1/matches.ts` | 改 | league_id query | S3 |
| `src/api/v1/predictions.ts` | 改 | history 参数 league_id/season_id 规则 | S3 |
| `src/api/v1/share-card.ts` | 改 | 三必填 query | S3 |
| `src/api/v1/admin.ts` | 改 | rebuild rankings board | S5 |
| `src/api/v1/groups.ts` | 加 | §27.2 六个端点 | S6 |
| `src/api/v1/rate-limit.ts` | 改 | groups 10/min | S6 |
| `src/api/v1/openapi.yaml` | 改 | 基线改为 v2.0；rankings/groups/profile/levels/share-card/admin | 随对应切片 |
| `src/api/v1/openapi-*.test.ts` | 改 | 合同断言同步 | 同上 |
| `src/gateway/assemble.ts` | 改 | 补齐未接线路由：PATCH/DELETE `/v1/profile/me`、GET `/v1/profiles/:user_id`、GET `/v1/predictions/me/:id`、GET `/v1/share-card/me`、admin、groups | S7 |
| `src/sync/config.ts` | 改 | `SYNC_TASKS_V1` 增加 4 个 job 的间隔（周评估、correction 由事件触发可 interval 空、career 60min、strength daily） | S4, S5 |
| `src/scheduler/tick.ts` | 改 | runners 类型随 SyncJobType 扩展 | S4, S5 |
| `src/scheduler/triggers.md` | 改 | 11 类任务表；删 month finalize | S4, S5 |
| `src/cloud-function/index.ts` | 改 | 若按 job_type 分发，登记新 job | S4, S5 |

### 2.5 测试 / 验收

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/acceptance/matrix-44-coverage.test.ts` | 改 | 追踪 ID 改为 v2.0：C17-C23（C22=等级赛季）、K78-K88、L89-L114、M115-M122、J73-J74 等 |
| `src/application/acceptance-44-c-postponement.test.ts` | 改 | C22 从跨月改为 6/30→7/1 北京时间 |
| `src/domain/levels.test.ts` / `ranking.test.ts` | 改 | 见上，禁止保留 v1 标题制造假覆盖 |
| `src/application/level-rebuild.test.ts` 等所有引用 `calculateLevel` 或 month 的测试 | 改 | 全量替换期望 |
| `src/application/weekly-level-eval.test.ts` 等 | 加 | 每切片自带 |

### 2.6 miniprogram（合同跟随，不做视觉设计）

| 文件 | 动作 | 内容 |
|---|---|---|
| `miniprogram/services/rankings.js` | 改 | `period_type` → `board`；支持 career/strength/scope | S7 |
| `miniprogram/pages/rankings/rankings.js` + wxml | 改 | 去掉准确率、月榜；三榜切换；me 块 | S7 |
| `miniprogram/pages/profile/profile.js` + wxml | 改 | 去掉准确率；展示 season_level；等级 1..6 称号表 | S7 |
| `miniprogram/services/levels.js` | 改 | 适配新 envelope | S7 |
| `miniprogram/pages/matches/matches.js` | 改 | LEAGUES 补 `serie_a`/`bundesliga`；真实 API 后 mock 可关 | S3/S7 |
| `miniprogram/services/groups.js` + pages | 加或缓 | 视 Q5；无群 UI 时至少不要因未知字段崩溃 | Q5 |

---

## 3. 实施计划（垂直切片）

原则：每片可独立 `typecheck` + 定向 `vitest`；**旧写路径在 S4 一次性切断**，避免双真值窗口拉长。

```text
S0 基础类型/配置/schema
 ├─ S1 等级纯函数（evaluate/replay/窗口/等级赛季）
 ├─ S2 排行比较器（去准确率、去月榜、门槛=1、strength 比较器）
 └─ S3 六联赛配置 + Provider/sync/round 取值域
      └─ S4 结算写路径切断即时定级 + week-only 增量 + last_scoring
           ├─ S5 快照 job + rebuild/consistency 期望值
           ├─ S6 群领域 + API
           └─ S7 API/网关/OpenAPI/前端跟随
                └─ S8 周评估 + 修正 supersede job（可与 S7 部分并行，但依赖 S4）
                     └─ S9 验收矩阵 K/L/J/C22 全绿
                          └─ S10 残留拆除清单清零 + DoD
```

S1/S2/S3 互不依赖，可并行。S6 不依赖 S8。S5 的 strength 快照依赖 S1 的 last_inputs 字段，但可先落地 career 快照。

### S0 — 配置 / 枚举 / Schema / 仓库端口

- **范围**：§2.1 表中 config/enums/types/collections/indexes/repositories；不改结算行为。
- **完成定义**：新字段可写入 InMemory；旧测试若因类型编译失败，允许先用临时 adapter（但 **禁止** 继续写 month 文档）。`npx tsc --noEmit` 通过。
- **验证**：`npx tsc --noEmit`；`npx vitest run src/schema src/infrastructure/repositories.test.ts src/domain/invariants.test.ts`

### S1 — 等级纯函数

- **范围**：`build_level_inputs` / `evaluate_level` / `replay_level` / `level_season_of` / 展示值向下取整。无 I/O。
- **完成定义**：§44 L89、L90、L93、L96-L101、L108-L109 的纯函数用例绿；无浮点比较。
- **验证**：`npx vitest run src/domain/levels.test.ts src/domain/time.test.ts`

### S2 — 排行比较器

- **范围**：`compare_ranking_entry`；删除准确率键；week 门槛 1；strength 比较器。
- **完成定义**：K78（1 场入榜）、K79 并列链、K81、K85 month→422 的 domain 侧预备。
- **验证**：`npx vitest run src/domain/ranking.test.ts`

### S3 — 六联赛

- **范围**：SUPPORTED_LEAGUES；loader 遍历；round 上限；teams.league_id；matches 创建不再写死英超。
- **完成定义**：给定德甲 fixture round 34 可入库、35 为 PROVIDER_DATA_INVALID；中超 season_id=`2026`；GET /matches?league_id=la_liga 只返回该联赛（API 可在 S7 接线，本片至少 application query 支持）。
- **验证**：`npx vitest run src/application/provider-schedule-sync.test.ts src/application/provider-team-sync.test.ts src/application/provider-fixture-loader.test.ts src/application/match-query.test.ts`

### S4 — 切断旧等级写路径（最高优先级行为变更）

- **范围**：settlement item 不再调用 `calculateLevel`/`rebuildLevelState`；不再写 month rankings；维护 career_last_scoring；season stats 按 level_season_of 建档（`level=1`，from==to 不写 history，§17.8.3）。
- **完成定义**：
  1. 首次结算后 `career_level` 与结算前相同；
  2. `rankings` 无 `period_type=month` 新行；
  3. 积分/命中/unlock 行为与现在一致（回归 I 组、J66-J72、J76）。
- **验证**：`npx vitest run src/application/settlement-item-application-service.test.ts src/application/acceptance-44-i-settlement-idempotency.test.ts` 以及既有 first/correction/retry settlement 测试。

### S5 — 快照 + rebuild + daily consistency

- **范围**：board_snapshots 读写；`rebuild_period_rankings(week)`；`rebuild_board_snapshot`；consistency 期望值改 replay/last_inputs，**周中等级≠即时计算不算差异**。
- **完成定义**：N123/N124/N125 语义按 v2；career 快照不扫 predictions。
- **验证**：`npx vitest run src/application/rebuild-service.test.ts src/application/daily-consistency.test.ts src/application/admin-rebuild-*.test.ts`

### S6 — 群

- **范围**：schema 已在 S0；本片实现领域+application+API+限流。
- **完成定义**：§27.2 判定顺序表；邀请码 UNIQUE 冲突重试；群主 leave→409；解散后 rankings scope=group → 404 GROUP_NOT_FOUND；K84。
- **验证**：新 `src/application/groups.test.ts`、`src/api/v1/groups.test.ts`

### S7 — API / 网关 / OpenAPI / 前端跟随

- **范围**：§24-30 字段；gateway 补齐 v1 已实现但未接线的 profile PATCH/DELETE、公开资料、prediction 详情、share-card、admin；新 groups。
- **完成定义**：OpenAPI 与 handler 一致；对外响应 grep 不到 `wdl_accuracy`；非法 `board=month` → 422。
- **验证**：`npx vitest run src/api src/gateway`；人工 grep `wdl_accuracy` 仅允许测试「不得出现」断言。

### S8 — 周评估 + supersede

- **范围**：weekly_level_eval、level_correction_reeval、与周评估串行、保护期、history 两行并存（weekly_eval 不删）。
- **完成定义**：J73/J74、L91-L92、L102-L106、L111、L114。
- **验证**：新 job 测试 + 改写的 J 组。

### S9 — 验收矩阵重基线

- **范围**：coverage 扫描 ID 与用例正文全部改为 v2.0 编号/语义。
- **完成定义**：§4 命令全绿；coverage 测试不再认 M100-M104 为 M 组。
- **验证**：`npx vitest run`；`npx tsc -p tsconfig.build.json`

### S10 — 残留拆除与 DoD

- **范围**：§5 拆除清单清零；triggers.md 11 job；文档索引如需指向本计划可另改（本任务不改存量文档）。
- **完成定义**：§45 DoD 清单自检；无 `calculateLevel` 符号；无 month 写路径。

---

## 4. 验收方式

### 4.1 工程命令（现状 `package.json`）

```bash
npx tsc --noEmit                 # 或 npm run typecheck
npx vitest run                   # npm test
npx tsc -p tsconfig.build.json   # npm run build
```

每切片先跑该片 glob，再在切片结束跑全量 `npx vitest run`。禁止在红测试上叠下一切片。

未跑全量 typecheck 的原因：本任务为只读对照，**未执行**上述命令（避免把时间花在与写文档无关的编译上）。实施时以当时输出为准。

### 4.2 测试基线维护（强制）

1. **禁止双套期望**：同一生产函数不得既有 v1 测试又有 v2 测试「择一跳过」。v1 断言删除或改写。
2. **标题 ID 必须跟 `MVP__v2.0.md` §44**：`matrix-44-coverage.test.ts` 用 `[A-N]\d{2,3}` 扫标题。当前文件仍要求 M100-M104，与 v2.0 M=115-122 **冲突**，S9 必须先改 coverage 再改用例，否则假绿/假红。
3. **K/L 组新语义（摘要，细节以规范为准）**：

| 组 | v2.0 条目 | 替代现有 |
|---|---|---|
| K | 78 本周 1 场入榜；79 新并列链（exact→valid ASC→last_scoring→user_id）；80-81 实力榜门槛/n 并列；82-83 me.top_percent；84 群榜；85 `board=month` 422；86 响应禁准确率；87 第 3 页空；88 历史周 is_final+correction | 删除 K78「1 场 rank=null」、K82 准确率并列 |
| L | 89 n=0 → s=1.70；90 15 场全中仍 Lv1；91 周一 10:05 applied 本周不计；92 一周最多 +1 且 B 挡 Lv4；93 交叉乘法不升；… 114 注销停评 | 删除 L92-L96 八级/准确率样本上限 |
| C | C22 改为跨 **7/1 等级赛季** | 现 C22 文件头仍写 C17-C22，kickoff 用跨月 |
| J | 73 supersede 不二次升级；74 改判可降（非额外降级） | 现 correction 测试期望即时 calculateLevel |
| M | 115-122 | coverage 停止追踪 M100-M104 |
| N | 123 含 replay | rebuild 期望不再是 calculateLevel(valid, wdl) |

4. OpenAPI 测试与 yaml 同步改；info.description 去掉「规范 v1.0」。

### 4.3 切片完成时的额外静态检查

```bash
# 生产代码不得再出现旧入口（测试里的「不得调用」字符串除外）
rg -n "calculateLevel|theoreticalAccuracyLevel|sampleSizeLevel" src --glob '!**/*.test.ts'
rg -n "PeriodType.Month|monthPeriodKey|GLOBAL_MONTH" src --glob '!**/*.test.ts'
rg -n "wdl_accuracy_percent" src miniprogram --glob '!**/*.test.ts'
```

三条在 S10 必须均为空（或仅注释/拆除说明）。

---

## 5. 风险与注意

### 5.1 双真值（最高）

旧路径：`settlement-item-application-service` → `rebuildLevelState` → `calculateLevel` 写入 `users.career_level`。  
新路径：周评估 / supersede / `replay_level` 写入同一字段。

若两套并存：

- daily consistency 会按其中一套报警；
- 用户周一前就升级，破坏「一次一级」；
- replay 无法复现线上等级。

**规则**：S4 合并后，生产路径只允许 `evaluate_level` 写入等级缓存；settlement 只写账本与积分。

### 5.2 账本 / 幂等 / 可重建

- 积分/命中唯一事实：`settlement_items status=applied`（已遵守，S4 保持）。
- 等级事实：评估时刻表（每周一 10:00 序列）+ correction `settlements.settled_at` + 规则版本 as_of 表。这些必须不可变、只追加。
- `replay_level` 必须能从空缓存重建到与线上一致；rebuild 与 replay 共用入口。
- 周评估同 `(user, scope, as_of)` 幂等：已有该 as_of 的 last_eval 则跳过。
- 修正重评不得删除 `weekly_eval` history 行（§0.6 / §17.9.5）。

### 5.3 群榜边界

- 群榜 **不落库**；成员变更立即可见。
- 解散后 `GET /v1/rankings?scope=group` → 404，不是空榜。
- `member_count` 是缓存，consistency 对账 `COUNT(active members)`。
- 邀请码「先查再插」禁止，必须 UniqueConstraint 重试（同 session openid）。

### 5.4 快照与性能

- career/strength Top20 与 me 名次来自快照或索引，禁止实时全表扫 predictions（§19.7 / §42.1）。
- strength 只读 `last_eval_n` / `last_eval_score_sum`；未评估用户（无 last_inputs）不上实力榜。

### 5.5 多联赛

- `round_id` 不可跨联赛比较；分享卡必须带 `league_id`。
- 中超 `season_id` 与五大联赛格式不得混用、不得推断。
- sync job_type 不按联赛拆锁；一任务内遍历六联赛，失败策略保持 Fail Closed（单 fixture 失败不 retry loader）。

### 5.6 未上线 ≠ 可以脏写

无迁移包袱，但仍须：空库 schema 一次到位；测试夹具不要再插入 `period_type=month` 或 `level=8`。

---

## 6. 范围说明与旧实现残留拆除清单

**不做**：数据迁移脚本、双算、灰度、cutover、1..8 映射、月榜兼容读。

**要做**：把 v1 特有实现从生产路径删干净。拆除时核对下列符号/分支，S10 清零。

| # | 残留 | 位置（现状） | 拆除方式 |
|---|---|---|---|
| R1 | `calculateLevel` / `theoreticalAccuracyLevel` / `sampleSizeLevel` / `LEVEL_MAX=8` | `src/domain/levels.ts` | 删除函数；测试改写 |
| R2 | `rebuildLevelState(..., wdlHits, ...)` | `level-rebuild.ts` 及 settlement/stats-rebuild/share-card/daily-consistency-snapshot 调用点 | 替换为 replay/evaluate；share-card 改读缓存 |
| R3 | `PeriodType.Month` 写入 | settlement-item `periodRefs`、ranking-rebuild、period-finalize、admin rebuild、API validate、OpenAPI PeriodType、前端 `periodType` | 删除写路径；API 遇 month → 422 |
| R4 | `monthPeriodKey` / `GLOBAL_MONTH_MIN_PREDICTIONS` / `GLOBAL_WEEK_MIN_PREDICTIONS=3` / `MIN_RANK_PREDICTIONS` | config、ranking.ts、time.ts | 删除 |
| R5 | `compareAccuracy` | `ranking.ts` | 删除 |
| R6 | 对外 `wdl_accuracy_percent` / `career_wdl_accuracy_percent` | profile/levels/ranking-query、OpenAPI、小程序 | 删除字段 |
| R7 | `LevelHistoryReason.Settlement` / `.Correction` / `.SeasonStart` | enums、settlement reason 三元、level-rebuild 测试 | 改为三枚举；season 开档不写 history |
| R8 | `user_season_stats.season_id` 及 `findByUserAndSeason(..., match.season_id)` | types/collections/repos/settlement/stats-rebuild/levels | 改 `level_season_id` |
| R9 | `level_history.wdl_hits` / `valid_predictions` | collections/types | 改为窗口截面字段 |
| R10 | `MVP_SEASON` 单例被当作全集 | config 及 20+ application/provider 文件 | 改为表驱动 `SUPPORTED_LEAGUES` |
| R11 | round `1..38` 写死 | schedule-sync、share-card ROUND_ID_PATTERN、collections note | 按 league 上限 |
| R12 | 验收标题 L92-L96 / K78-K82 v1 语义 / coverage M100-M104 | levels.test.ts、ranking.test.ts、matrix-44-coverage.test.ts | 改写 |
| R13 | OpenAPI「规范 v1.0」「周榜或月榜」 | openapi.yaml | 改 v2.0 合同 |
| R14 | scheduler 文案 week/month | triggers.md:25 | 只 week + 新 4 job |
| R15 | 前端月榜开关与准确率展示 | rankings/profile js+wxml | 跟随 API |
| R16 | `emptySeasonStats()` 用 `MVP_SEASON.season_id` | application/levels.ts:56-60 | 当前等级赛季 id + 缺省 Lv1 块 |

---

## 7. 待确认

实施中遇到下列项 **Fail Closed / 标 SPEC_GAP**，不得自行发明。

| ID | 问题 | 为何不确定 | 建议 |
|---|---|---|---|
| Q1 | `LEVEL_FIRST_EVAL_AS_OF` 的具体日历日 | §3 写「由上线日期决定」；仓库无上线日 | 上线周确定后只追加登记；代码用配置注入，测试用固定周一 |
| Q2 | `board_snapshots` 保留最近 N 版的 N | §37 写运维配置，规范未给数字 | 先实现「当前版 + 至少 1 份上一版」；N 做成配置默认值待产品拍板 |
| Q3 | §17.13 / L-24 模板回测是否阻塞 S9 | 需近 3 季六联赛历史赛果，当前环境未必有 fixture 库 | 门禁可独立任务；无数据时不得假装通过 |
| Q4 | §17.12 Elo/挑联赛监控是否纳入本轮 DoD | 「不入判定」；规范 1.2 未单列必须实现监控管道 | 建议本轮不做用户可见，监控可后置；若做不得写入 anomalies |
| Q5 | 小程序是否本轮做群 UI | §1.3 前端 UI OUT_OF_SCOPE，但 1.2 要求群能力在后端；现有 tab 无群入口 | 后端 S6 必做；前端群页可另任务，本轮至少改掉会因合同破坏的 rankings/profile |
| Q6 | gateway 未接线的 v1 API（PATCH profile 等）是否算 v2 范围 | 属 v1 欠债，v2 合同仍要求 | **纳入 S7**，否则 §24/§26/§29/§30 无法验收 |
| Q7 | `share-card.ts` 注销现抛 `USER_NOT_ACTIVE` | v2 统一 409 `USER_DELETED` | 按 v2 改；若 OpenAPI 仍写 403 以规范为准 |
| Q8 | 实力榜 `last_inputs` 在用户尚无周评估时是否快照 | 规范：数据源为评估缓存；n&lt;50 为 below_threshold | 无 last_eval 视为 n=0，不上榜；me.status=`below_threshold` 或 `not_participated` 的细分待产品确认（规范 19.3 表只明确实力榜 below_threshold=窗口 n&lt;50） |

---

## 8. 建议开工顺序（给编码 Agent）

1. 读本文件 §1 D54、§5.1、§6 R1-R2 —— 先理解双真值。  
2. 落地 S0+S1+S2（可并行 PR）。  
3. **S4 单独成 PR**，测试必须证明「结算不再改等级」。  
4. S3 可与 S4 并行。  
5. S8 依赖 S4 合入后再做，否则周评估会与即时定级打架。  
6. S9 最后改 coverage ID，避免中途假绿。

规范冲突时以 `docs/MVP__v2.0.md` 为准（§0.1）。未定义行为 Fail Closed（§0.3）。
