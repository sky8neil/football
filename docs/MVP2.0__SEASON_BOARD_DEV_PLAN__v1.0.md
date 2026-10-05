# MVP 2.0 赛季榜（`board=season`）后端开发文档 v1.0

> 状态：可执行开发计划（只读对照产出，**未改任何源码**）。
> 业务基线：`docs/MVP__v2.0.md`（新增第 19.9 节，并联动第 1.2 / 1.3 / 19.1–19.7 / 21.2 / 21.20 / 27.1 / 30.6 / 32.13 / 34.4 / 35.4 节与常量表）。
> 对照对象：`src/`（domain / application / infrastructure / api / schema / sync / scheduler）与 `miniprogram/`。
> 范围：项目未上线，**不做迁移 / 兼容 / 灰度**；开发库数据用既有重建能力回填（§3.7）。
> 扩展：§7 为同一轮需求的「冷启动 / 低流量体验」功能（用户很少、新周开始、新赛季开始、休赛期、无群用户）。
> 扩展：§8 赛季终榜（已纳入）；§9 欧冠（只写规划，不实现）。
> 前端：尚无定稿设计的界面一律用最简占位实现（§10），不改动现有页面；**后端不受影响，必须严谨完整**。
> 设计稿参考：`docs/design/current-baseline-gpt/v0.2.2-cc/`（排行榜 tab 与资格逻辑的演示）。

---

## 0. 结论摘要

赛季榜是在现有「快照榜」机制（`career` / `strength`）上再加一种 `season`，**不是新机制**：快照任务、快照表、cursor 分页、群过滤、`me` 状态机全部复用。真正新增的只有三件事：

1. **数据**：`user_season_stats` 缺少并列键 `last_scoring_match_at`，需要在结算、修正、重建三条写路径上维护（与 `users.career_last_scoring_match_at` 同构）。
2. **快照带赛季**：`board_snapshots` 增加 `level_season_id` 与 `season_*` 字段；查询必须校验「最新快照属于当前等级赛季」，否则跨 07-01 后会把上赛季榜当成当前榜返回（§3.1，**最大风险**）。
3. **可见资格**：`参与过的等级赛季数 ≥ 2` 才可见。榜单本身收录全体入榜用户；资格只影响响应里的 `available_boards` 与 `me.status = not_eligible`。

| 项 | 值 |
|---|---|
| 差异条目（§2） | **49**（其中 5 条仅记录决策、无代码改动） |
| 最大风险 | 跨赛季边界时查询返回上赛季快照（§3.1）；其次是 `last_scoring_match_at` 在修正路径上漏维护导致并列顺序与重建结果不一致（§3.2） |
| 建议切片 | S1 → S6（§4）为赛季榜本体；S7 → S9 为冷启动与低流量体验（§7）。S1–S2 无外部可见变化，可先合入 |
| 待确认 | **5**（§6），均有推荐默认值，不阻塞开工 |

---

## 1. 规则回顾（以规范第 19.9 节为准）

| 项 | 规则 |
|---|---|
| 口径 | 当前**等级赛季**（`levelSeasonOf()`，北京时间每年 07-01 00:00 切换，形如 `"2026_2027"`）的 `user_season_stats.points` 排名 |
| 入榜门槛 | 当前赛季 `valid_predictions ≥ SEASON_BOARD_MIN_VALID(=1)`；已注销用户过滤（同其它榜） |
| 比较器 | 与 week / career **同一比较器**：分数 DESC → `exact_hits` DESC → 有效预测数 ASC → `last_scoring_match_at` ASC（非 null 优先）→ `user_id` ASC |
| 榜单人群 | **收录所有**满足入榜门槛的用户，不按资格过滤；`N`、`top_percent` 都按全体入榜人数 |
| 可见资格 | `seasons_participated = count(user_season_stats where user_id=U and valid_predictions ≥ 1)`（含当前赛季），`≥ SEASON_BOARD_MIN_SEASONS(=2)` 可见 |
| 响应 | 所有 board 的响应带 `available_boards`（各标签按各自数据显隐，规范 §19.10.8）；`board=season` 且请求者资格不足时列表照常返回，`me.status = not_eligible`，带 `seasons_participated` |
| 游客 | **排行榜需登录**（规范 §19.10.9）：接口返回 401，页面显示灰色占位 +「请登录查看榜单」，不请求数据 |
| 更新 | 快照，`SEASON_BOARD_SNAPSHOT_MINUTES=60`；锁 `sync:board_snapshot_season` |
| 历史赛季榜 | 不提供；快照只展示当前 `level_season_id` |
| 群范围 | 沿用 §19.4：全站快照按成员过滤后群内重排；是否展示取决于**请求者**自己的资格 |

---

## 2. 现状 vs 要求 差异清单

每条：位置 / 现状 / 要求 / 类型（新增 / 修改）/ 影响面。行号为本次对照时的快照，动手前请重新定位。

### 2.1 常量、枚举、类型、Schema

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| A01 | `src/domain/enums.ts:55-60` `RankingBoard` | `Week / Career / Strength` | 增 `Season: "season"` | 修改 | 所有 `Object.values(RankingBoard)` 校验点自动放行 `season`（`api/v1/rankings.ts`、`admin.ts:107`、`ranking-query.ts:98/122`、`admin-rebuild-rankings.ts:54`），需逐一确认 |
| A02 | `src/domain/enums.ts:160-161` `SyncJobType` | 仅 `BoardSnapshotCareer / Strength` | 增 `BoardSnapshotSeason: "board_snapshot_season"` | 修改 | `sync_jobs.job_type` 枚举、调度、锁 key |
| A03 | `src/schema/collections.ts:428-429` | `job_type` enum 列表 | 增 `"board_snapshot_season"` | 修改 | schema 测试 |
| A04 | `src/domain/config.ts:63,70` | `RANKING_BOARDS: ["week","career","strength"]`；仅 `CAREER_BOARD_SNAPSHOT_MINUTES` | `RANKING_BOARDS` 增 `"season"`；新增 `SEASON_BOARD_MIN_VALID=1`、`SEASON_BOARD_MIN_SEASONS=2`、`SEASON_BOARD_SNAPSHOT_MINUTES=60` | 修改+新增 | config 测试、规范常量表一致性测试（如有） |
| A05 | `src/domain/types.ts:101-114` `UserSeasonStats` | 无并列键 | 增 `last_scoring_match_at: Date \| null`（规范 §21.2） | 修改 | `emptySeasonStats()`、所有构造 `UserSeasonStats` 字面量的地方（含测试夹具、`gateway/seed.ts`） |
| A06 | `src/schema/collections.ts:19`（`user_season_stats`） | 无该字段 | 增 `last_scoring_match_at: { type: "date", nullable: true }` | 修改 | schema 测试 |
| A07 | `src/domain/types.ts:286-300` `BoardSnapshot` | `board: Career \| Strength`；无赛季字段 | `board` 增 `Season`；增 `level_season_id: string \| null`、`season_points / season_exact_hits / season_valid_predictions / season_last_scoring_match_at`（均 nullable） | 修改 | 所有构造 `BoardSnapshot` 的地方（`board-snapshot.ts` 三处、测试夹具） |
| A08 | `src/schema/collections.ts:504-522`（`board_snapshots`） | `board` enum `["career","strength"]` | enum 增 `"season"`；增 `level_season_id`（string，nullable）与四个 `season_*` 字段；`note` 保持 `UNIQUE(board, snapshot_at, user_id)`（见 §6 Q2） | 修改 | schema 测试 |
| A09 | `src/schema/indexes.ts:204-215` | `ix_board_snapshots_rank (board, snapshot_at desc, rank)` | 保持不变（赛季筛选在内存按 `level_season_id` 过滤最新一版；一版内最多 N 行）。若快照量大，再评估加 `level_season_id` 前缀索引 | 无改动 | 记录决策 |
| A10 | `src/domain/invariants.ts:160` 附近（snapshot 不变量） | 校验 career/strength 互斥字段 | 增 season 分支：`board=season` 时 `season_*` 与 `level_season_id` 必填，其余 career/strength 字段必须为 null；其它 board 的 `season_*` 必须为 null | 新增 | invariants 测试 |
| A11 | `src/domain/invariants.ts:97-111`（`assertSeasonStatsInvariants`） | 无并列键校验 | 增：`points = 0` 时 `last_scoring_match_at` 必须为 null（同 career 规则 §19.5） | 修改 | invariants 测试 |

### 2.2 比较器与资格（domain）

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| B01 | `src/domain/ranking.ts:44` `compareRankingEntry` | `Week \|\| Career` 走分数比较器；`Strength` 独立；其余抛 `validationError` | `Season` 并入第一支（与 week/career 共用 `compareWeekCareerEntry`，规范 §19.5） | 修改 | ranking 测试：新增 season 用例；确认未知 board 仍抛错 |
| B02 | `src/domain/ranking.ts:121-129` | 仅 `isRankEligible` / `isStrengthRankEligible` | 新增 `isSeasonRankEligible(validPredictions)`（`≥ SEASON_BOARD_MIN_VALID`）与 `isSeasonBoardVisible(seasonsParticipated)`（`≥ SEASON_BOARD_MIN_SEASONS`） | 新增 | 供快照、查询复用，**禁止**在调用点内联阈值 |
| B03 | `src/domain/ranking.ts`（新增纯函数） | 无 | `countSeasonsParticipated(stats: readonly UserSeasonStats[]): number`，规则为 `valid_predictions ≥ 1` 的行数 | 新增 | 纯函数，便于测试边界（0 / 1 / 2 个赛季，修正使某赛季 `valid_predictions` 回 0） |

### 2.3 写路径：`last_scoring_match_at`（务必与 career 同构）

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| C01 | `src/application/settlement-item-application-service.ts:125-141` `emptySeasonStats` | 无该字段 | 初值 `last_scoring_match_at: null` | 修改 | — |
| C02 | 同文件 `:470-495`（season 更新） | 只加 `points / valid_predictions / hits` | 仿照 `:446-466` 的 career 写法：`new_score > Miss` 时 `maxScoringAt(旧值, match.period_anchor_at)`；修正导致得分降为 0 且旧值恰为该场 anchor 时，需**重算**（见 C03）；最后用 `lastScoringForPeriodScore(points, 值)` 约束 `points=0 ⇒ null` | 修改 | 结算首次/修正两条路径；`assertSeasonStatsInvariants` |
| C03 | 同文件（`careerLastScoringAt(tx, predictions, updated)` 的赛季版本） | career 有重算 helper，season 无 | 新增 `seasonLastScoringAt(tx, predictions, levelSeasonId, updatedPrediction)`：只在该 `level_season_id` 内取 `match_score > 0` 的 `period_anchor_at` 最大值；触发条件同 career 的 `careerNeedsRebuild`（零分修正且旧值等于本场 anchor） | 新增 | 修正路径；单测必须覆盖「改成 0 分后回退到次新得分场」 |
| C04 | `src/application/stats-rebuild.ts:39-46,179-188`（`RebuiltSeasonStats` 与累计） | 不产出并列键 | `RebuiltSeasonStats` 增 `last_scoring_match_at`；累计时按赛季取 `match_score > 0` 的 anchor 最大值，`points = 0` 时为 null | 修改 | `stats-rebuild-service.ts`（`:100-130`、`:386` 附近）写回 `user_season_stats` |
| C05 | `src/application/admin-rebuild-user-stats.ts:44-60` | 对比 season stats 前后差异时未含该字段 | 差异比较与审计 `old_value / new_value` 纳入 `last_scoring_match_at` | 修改 | 审计日志测试 |
| C06 | `src/application/daily-consistency.ts:19-26,147-156`（`SeasonStatsCacheValues` / `SEASON_FIELDS`）与 `daily-consistency-snapshot.ts` | 校验 season 缓存字段不含并列键 | 把 `last_scoring_match_at` 加入 `SEASON_FIELDS`，expected 由账本推出（沿用 career 的 `expectedCareerLastScoringAt` 思路按赛季过滤） | 修改 | 一致性测试；活动结算中的用户沿用现有 skip 语义 |
| C07 | `src/application/weekly-level-eval.ts:401`、`level-correction-reeval.ts:511` | 对 `user_season_stats` 做 `update({...})` | 确认使用展开 `...stats`，**不得**丢失新字段；若用显式字段拼装需补上 | 修改 | 回归测试：周评估/修正重评后 `last_scoring_match_at` 不变 |
| C08 | `src/gateway/seed.ts`、`session.ts` 等构造 stats 的位置 | 字面量不含新字段 | 补 `last_scoring_match_at: null`（TS 编译会提示） | 修改 | — |

### 2.4 Repository 端口

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| D01 | `src/infrastructure/repositories.ts:334-339` `UserSeasonStatsRepository` | `findByUserAndSeason` / `findByUser` / `insert` / `update` | 新增 `findByLevelSeason(levelSeasonId): Promise<UserSeasonStats[]>`（快照任务全量读当前赛季；索引已有 `ix_user_season_level`） | 新增 | in-memory 实现与 CloudBase 实现各一份；`UnitOfWork` 事务版也要有 |
| D02 | `repositories.ts:341-349` `BoardSnapshotRepository` + `:1776-1800` | `findLatestByBoard(board)` 返回该 board 最新 `snapshot_at` 的所有行 | **接口不变**。season 的「是否属于当前赛季」由调用方判断（见 §3.1）；不要把赛季参数塞进 `findLatestByBoard`，避免三个 board 行为分叉 | 无改动 | 记录决策 |
| D03 | `src/infrastructure/cloudbase-repository.ts` | 当前仅映射了 users 等；`boardSnapshots` / `userSeasonStats` 的 CloudBase 实现若在此（或后续 B1 接线） | 字段映射增 `last_scoring_match_at`、`level_season_id`、`season_*` | 修改 | 若 B1 CloudBase 接线尚未做，则在该切片落地时一并带上，本文只标记 |

### 2.5 快照服务与调度

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| E01 | `src/application/board-snapshot.ts:32-48` | `boardSnapshotJobLockKey` / `assertSnapshotBoard` 仅 career、strength | 两处都放行 `Season`；锁 key `sync:board_snapshot_season` | 修改 | 错误文案「只支持 career 或 strength」同步改 |
| E02 | 同文件 `:50-139` | `careerUsers` / `strengthUsers` / `buildCareerSnapshots` / `buildStrengthSnapshots` | 新增 `seasonRows(...)` / `buildSeasonSnapshots(statsRows, users, levelSeasonId, snapshotAt)`：过滤已注销用户与 `valid_predictions < 1`；排序走 `compareRankingEntry(RankingBoard.Season, …)`；`rank = index + 1`；填 `level_season_id` 与 `season_*`，career / strength 字段置 null | 新增 | **注意签名**：现 `buildBoardSnapshotEntries(users, board, snapshotAt)` 只传 users，season 还要 stats 与 `levelSeasonId`，需扩展参数（见 §3.4） |
| E03 | 同文件 `:141-194` `buildBoardSnapshotEntries` / `writeBoardSnapshotInTransaction` | 读 `tx.users.findAll()` | season 额外读 `tx.userSeasonStats.findByLevelSeason(levelSeasonOf(snapshotAt))`；`UnitOfWork` 类型 `BoardSnapshotUnitOfWork` 增加 `userSeasonStats`；空榜仍写 `head` 哨兵行，哨兵行也要带 `level_season_id`（否则 §3.1 的当前赛季校验会把空榜误判为过期） | 修改 | 幂等：同 `(board, snapshotAt)` 已存在则直接返回（现有逻辑） |
| E04 | `src/sync/config.ts:64-69` | 有 career、strength 两项 | 增 `board_snapshot_season: { intervalMinutes: FIXED_CONFIG_V1.SEASON_BOARD_SNAPSHOT_MINUTES }` | 新增 | `SYNC_JOB_CONFIG` 类型、配置测试 |
| E05 | `src/scheduler/tick.ts`、`src/scheduler/triggers.md:29-30,78` | 分发 career / strength | 增 season 分发：`BoardSnapshotService.generate(RankingBoard.Season, serverNow)`；`triggers.md` 补一行并注明「每小时」 | 新增 | tick 测试 |
| E06 | `src/application/weekly-level-eval.ts:229,279` | 周评估成功后触发 strength 快照 | **不触发 season**：赛季榜只依赖积分，与周评估无关，仅靠每小时任务（避免无谓耦合） | 无改动 | 记录决策 |

### 2.6 查询与 API

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| F01 | `src/application/ranking-query.ts:31-61` 类型 | `RankingListItem` 三种；`RankingMe` 三状态 | `RankingListItem` 增第四种：`{ season_points, season_valid_predictions, exact_hits, last_scoring_match_at }`；`RankingMe` 增 `{ status: "not_eligible"; seasons_participated: number }` | 修改 | api 类型、openapi |
| F02 | 同文件 `:63-72` `RankingQueryResult` | 无赛季信息 | 增 `available_boards: RankingBoard[]`；`board=season` 时增 `level_season_id: string`、`is_provisional: boolean` | 修改 | api 响应体 |
| F03 | 同文件 `:218-256` `compareSources` / `:258-289` `makeItem` | career 分支为兜底（`career_points` 缺失抛错） | 显式加 `Season` 分支，读 `season_*` 字段（缺失抛 `internalError`）；**不要**让 season 落入 career 兜底分支 | 修改 | 单测：season 快照行缺字段 → 500 |
| F04 | 同文件 `:301` 构造器 `repo: Pick<…>` | 无 `userSeasonStats` | 增 `userSeasonStats`（读请求者的赛季参与数） | 修改 | `gateway/assemble.ts:524` 注入、各测试夹具 |
| F05 | 同文件 `:369-388` 快照读取分支 | `findLatestByBoard(input.board)` 后直接使用 | 跨赛季边界的**当前榜**读取：用 `findLatestBySeason(当前赛季)`（F13）而不是 `findLatestByBoard`；当前赛季尚无快照或无入榜者时，由 F13 的「上赛季交接」规则决定显示什么（取代早先「返回空列表」的方案，§3.1 已改）；`updated_at` 取实际展示快照的时刻 | 修改 | 跨 07-01 边界测试（注入 `server_now`） |
| F06 | 同文件 `:412-435` `me` 计算 | 已入榜 → `ranked`；否则 strength 特判 → `not_participated` | `board=season` 时**先**判资格：`seasons_participated < 2` → `{ status: "not_eligible", seasons_participated }`，**即使该用户在榜单里**（榜单收录所有人，但他看不到名次）；资格满足后才走 ranked / not_participated | 修改 | 顺序错了会向首赛季用户泄漏名次，必须有单测 |
| F07 | 同文件（新增） | 无 | 对请求者计算 `seasons_participated = countSeasonsParticipated(findByUser(uid))`（整数，已登录才会走到这里，见 F11）；并据此与各榜 `entry_count` 计算 `available_boards`（F12）；**所有 board 的响应都带 `available_boards`**，由此客户端无需先请求才知道要不要显示 tab | 新增 | 每次排行榜请求多一次 `findByUser`（单用户至多数行，可接受） |
| F08 | 同文件 `:74-81,115-138` cursor payload / 校验 | `board` 校验用 `Object.values(RankingBoard)` | 自动含 `season`；`period_key` 规则不变（非 week 必须为 null）；无需改 payload | 无改动 | 补 season 分页一条测试 |
| F09 | `src/api/v1/rankings.ts:13-60` | 白名单字段、响应体仅含 `board/scope/period_key/updated_at/items/page/me` | 响应体增 `available_boards`、`seasons_participated`、`entry_count`；`board=season` 时增 `level_season_id`、`available_level_seasons`、`is_provisional`；`board` 非法文案改为「week、career、strength 或 season」（`:68`） | 修改 | api 测试 |
| F10 | `src/api/v1/openapi.yaml:441-449,1232-1236` 等 | `board` enum `[week, career, strength]`；`RankingData` 无新字段 | `board` enum 增 `season`；`RankingData` 增 `available_boards`（required）、`level_season_id`（可空）与 `is_provisional`；新增 season item schema；`RankingMe` 增 `not_eligible` 与 `seasons_participated`；描述里「board 固定为…」改写 | 修改 | openapi 合同测试（`openapi-*.test.ts`），**文档与实现同提交** |
| F11 | `src/api/v1/rankings.ts:13-60`、`src/api/v1/rate-limit.ts`、`src/gateway/assemble.ts:524` 一带的路由与鉴权 | 排行榜为公开读：`authenticated_user_id` 可空、`public_source`、公开读限流 | **改为 Auth required**（规范 §19.10.9）：无可信身份 → `401 UNAUTHORIZED`；已注销 → `409 USER_DELETED`；移除公开读限流分支与 `me` 可空逻辑（`RankingQuery.authenticated_user_id` 变必填）；openapi 增 `security` 与 401/409；`x-requires-trusted-openid: true` | 修改 | api / gateway / openapi 测试；已有的游客用例改为期望 401 |
| F12 | `src/application/ranking-query.ts`（新增） | 无 | 计算 `available_boards`（规范 §19.10.8）：`week` 恒有；`career` = 所选范围 `entry_count>0`；`strength` = 请求者 `last_eval_n ≥ 50`；`season` = 资格满足 且（当前赛季范围内 `entry_count>0` 或 全站且上赛季榜可展示）。`entry_count` 取自各榜最新快照（群范围按成员过滤、已注销排除）。纯函数 `computeAvailableBoards(input)` | 新增 | 纯函数单测覆盖：上线初期、新建群、群内无人、首赛季、赛季交接、n=49/50 |
| F13 | 同文件 `:369-388`（快照读取）+ `BoardSnapshotRepository` | 只有 `findLatestByBoard` | **新赛季交接**（规范 §19.10.10）：`board=season` 且未带 `level_season_id` 时，默认赛季 = 当前赛季若全站有入榜者，否则上赛季；上赛季终榜存在 → 终榜；否则取上赛季**最后一版常规快照**，响应 `is_provisional=true`。需新增端口 `findLatestBySeason(levelSeasonId)`（只返回 `is_final=false` 的该赛季最新一版）——不能用 `findLatestByBoard`，因为新赛季的空 head 行会成为「最新」 | 修改+新增 | 交接测试：07-01 后、首个周一前、首个周一后、新赛季首次出现入榜者 |

### 2.7 重建与运维

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| G01 | `src/application/ranking-rebuild-service.ts:310-316`、`:341-360` | `rebuildBoardSnapshot` 只允许 career / strength | 放行 season；重建前先确保 `user_season_stats` 本身可信（规范 §35.4：从当前赛季 stats 全量重算）；锁 key 仍为 `maintenance:rebuild:board_snapshot:season` | 修改 | ranking-rebuild 测试 |
| G02 | `src/application/admin-rebuild-rankings.ts:54-72,101-115,199-206` | 校验与审计值构造按 career / strength | 校验文案、`period_key` 禁止携带的分支纳入 season；`rankingAuditValue` / `snapshotAuditValue` 增 season 汇总：`total_season_points`（规范 §32 审计表） | 修改 | 审计测试 |
| G03 | `src/api/v1/admin.ts:107-125` | `Object.values(RankingBoard)` 校验、`board !== week` 一律禁止 `period_key` | 自动放行 season；错误文案同步；确认响应体里 `board` 回显 | 修改 | admin 测试、`openapi-admin-*.test.ts` |
| G04 | `src/application/daily-consistency-snapshot.ts:198-247` | `for board of [Career, Strength]` | 加 `Season`；`buildBoardSnapshotEntries` 需传 stats 与赛季（同 E02）；`boardSnapshotValues` 增 season 字段；`rank_check_skipped` 判断依据 `user.updated_at` 对 season 不够——还要看 `user_season_stats.updated_at > snapshotAt`（见 §3.5） | 修改 | 一致性测试 |
| G05 | `src/domain/invariants.ts`、`daily-consistency.ts` 的 `BoardSnapshotConsistencyEntry`（`:10,48,138,176` 一带的快照校验字段表） | 字段表仅含 career / window | 增 season 字段 | 修改 | 一致性测试 |

### 2.8 小程序

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| H01 | `miniprogram/services/rankings.js` | `listRankings({ board })` 透传，响应字段按 board 映射 | 透传 `available_boards`、`level_season_id`、`is_provisional`；`board=season` 的 item 映射 `season_points / season_valid_predictions` | 修改 | 服务层测试 |
| H02 | `miniprogram/pages/rankings/rankings.js:28-30,76` / `rankings.wxml:1-18` | 三个 board 按钮；`onBoardTap` 白名单仅 week / career / strength | 白名单加 season；tab 区按 `available_boards` 渲染各标签（不在列表中的不渲染；切换范围后当前标签不可用时回退到 week）；`mainValue` 映射 season；`me.status = not_eligible` 时不展示名次区 | 修改 | 页面测试 |
| H03 | UI 视觉与文案 | 页面当前是骨架（普通按钮） | 视觉未定稿，**按 §10 的占位策略实现**：最简控件、条件渲染的独立块、不改现有页面；设计对照见 `v0.2.2-cc`；定稿后由 S12 替换 | — | — |

---

## 3. 关键设计细节

### 3.1 跨赛季边界（最大风险）

`findLatestByBoard("season")` 返回的是该 board **最新一次快照**，它不关心赛季，且新赛季的空 `head` 行会成为「最新」。07-01 00:00（北京时间）之后：

- 若直接使用，用户会看到**上赛季榜单标成当前榜**，或看到一个空榜。

做法（规范 §19.10.10）：

1. 快照每行带 `level_season_id`（包括空榜的 `head` 哨兵行）。
2. 读取当前赛季一律用 `findLatestBySeason(当前赛季)`（F13），不用 `findLatestByBoard`。
3. 默认赛季：当前赛季在全站已有入榜者 → 当前赛季；否则 → **上赛季榜**（终榜优先，没有则取最后一版常规快照，响应 `is_provisional=true`，界面标「等待最终确认」）。
4. 数据保留：每个赛季的最后一版常规快照在终榜生成前必须保留（§8.2 第 2 条）。
5. 取 `server_now` 而非客户端时间；`levelSeasonOf` 内部已按 Asia/Shanghai 切年。

### 3.2 并列键 `last_scoring_match_at` 的三条写路径

必须与 `users.career_last_scoring_match_at` **同构**（现有实现见 `settlement-item-application-service.ts:446-466`），三处缺一不可：

| 路径 | 作用 | 对应条目 |
|---|---|---|
| 结算 / 修正 item 应用 | 增量维护，零分修正时重算 | C02、C03 |
| `rebuild/user-stats` 全量重建 | 从账本推出，纠正缓存漂移 | C04、C05 |
| 每日一致性 | 检出漂移 | C06 |

只改第一条会出现「增量值」与「重建值」不一致，被每日一致性报告为差异。三条同提交。

### 3.3 `me` 状态机顺序（§2.6 F06）

榜单收录全体入榜用户，所以首赛季用户**可能出现在 season 榜单列表里**。但资格不足者不应看到自己的赛季名次：

```text
board=season:
  seasons_participated < 2        → not_eligible(seasons_participated)
  否则在榜                         → ranked(rank | top_percent)
  否则                             → not_participated
```

`not_eligible` 判断必须排在「在榜 → ranked」**之前**。列表本身仍公开（规范 §19.9）。

### 3.4 快照构造函数的签名

现状 `buildBoardSnapshotEntries(users, board, snapshotAt)` 被两处使用：`board-snapshot.ts:170`（生成）与 `daily-consistency-snapshot.ts`（重算期望值）。season 需要 `user_season_stats` 与 `levelSeasonId`。推荐把入参收成对象：

```text
buildBoardSnapshotEntries({ users, seasonStats?, levelSeasonId?, board, snapshotAt })
```

- `board=season` 时 `seasonStats` 与 `levelSeasonId` 必填，缺失抛 `internalError`。
- 一致性校验与生成**必须调用同一函数**（现状如此，保持），避免两份排序逻辑。

### 3.5 每日一致性对 season 快照的 `rank_check_skipped`

现有判断：`users.some(u => u.updated_at > snapshotAt)` 表示快照后有用户数据变化，则跳过名次校验。赛季榜的数据来自 `user_season_stats`，结算会同时更新 `users` 与 `user_season_stats`（同一事务），但**周评估 / 修正重评只改 stats 不一定改 users**。因此 season 的跳过条件应同时看 `user_season_stats.updated_at`；否则会出现「快照后 stats 变了但 users 没变 → 名次被拿去严格校验 → 误报」。

### 3.6 为什么 `findLatestByBoard` 不加赛季参数、也不改 UNIQUE

- 三个 board 共用一个查询入口，加参数会让 career / strength 带上无意义的可选项。
- 快照 `snapshot_at` 随时间单调，同一赛季的快照天然聚在一起；`UNIQUE(board, snapshot_at, user_id)` 已够，赛季维度靠行内 `level_season_id` 判断即可（Q2）。

### 3.7 开发库数据回填

项目未上线，不写迁移脚本。已有开发数据用既有能力补：

1. `user_season_stats.last_scoring_match_at`：执行 `POST /v1/admin/rebuild/user-stats`（对所有开发用户），由 C04 的账本重建产出。
2. 赛季快照：`POST /v1/admin/rebuild/rankings`，`board=season`，由 G01 生成首版。

---

## 4. 切片与顺序

每个切片完成后都必须独立通过：`tsc` / 全量 `vitest` / `build` / `git diff --check`（沿用 MVP 2.0 修复轮的门禁）。

| 切片 | 内容 | 条目 | 外部可见变化 |
|---|---|---|---|
| **S1 类型与配置** | 枚举、常量、类型、schema、不变量；所有字面量补 `last_scoring_match_at` | A01–A08、A10–A11、C08 | 无 |
| **S2 写路径** | 结算/修正维护并列键；stats 重建；审计；一致性；周评估/修正重评回归 | C01–C07 | 无（字段新增，未对外） |
| **S3 比较器与资格** | `compareRankingEntry` 放行 season；资格纯函数；`countSeasonsParticipated` | B01–B03 | 无 |
| **S4 快照** | repository 新方法；快照构造/写入；配置与调度；重建与 admin 校验；一致性对账 | D01、D03、E01–E05、G01–G05 | 新增后台任务、admin 可重建 season |
| **S5 查询与 API** | 查询服务、`available_boards`、`not_eligible`、跨赛季校验与上赛季交接（`is_provisional`）、**排行榜接口改为需登录**；api 层；openapi | F01–F13 | **对外接口变化**（本切片合入即生效） |
| **S6 小程序** | 服务层映射与页面 tab 显隐 | H01–H02 | 用户可见 |

| **S7 冷启动 · 接口** | 排行榜响应增 `entry_count / seasons_participated / current_period_key`，周榜默认周规则；资料接口增 `previous_season`；新增常量 `RANKING_THIN_BOARD_THRESHOLD=20`、`RANKING_WEEK_WINDOW=4`、`RANKING_FIRST_PERIOD_KEY` | §7.5、§7.9 | **对外接口变化**，与 openapi 同提交 |
| **S8 冷启动 · 小程序** | 少人分档、空状态与引导、无群的「未解锁」入口、游客灰色占位、标签按 `available_boards` 显隐、周选择器限最近 4 周、更新时间格式、比赛页默认联赛、赛季个人回顾卡、首赛季/赛季初提示、上赛季「等待最终确认」标注 | §7.2–§7.14 | 用户可见 |
| **S9 冷启动 · 设计稿** | 在设计稿新版本中演示全部状态（人数分档、周一显示上周、无群、赛季初、休赛期默认中超） | §7 全部 | 无（设计产物） |

| **S10 赛季终榜** | 终榜冻结任务与快照字段、查询支持历史赛季、`available_level_seasons`、小程序赛季选择 | §8 | 用户可见，接口变更，与 openapi 同提交 |
| **S12 占位替换** | 设计稿定稿后，用其替换 §10 的占位界面（只改 `wxml` / `wxss` 与文案文件） | §10.6 | 用户可见（仅视觉） |

S1–S3 无外部影响，可连续合入；S5、S7、S10 是接口变更，必须与 openapi 同提交。S7 依赖 S5（响应体同一结构）。

---

## 5. 测试清单

**domain**
- `compareRankingEntry(season, …)` 与 week/career 同序；非法 board 仍抛 `VALIDATION_ERROR`。
- `isSeasonRankEligible`：0 / 1 场边界。
- `countSeasonsParticipated`：0 / 1 / 2 个赛季；某赛季 `valid_predictions` 被修正回 0 不计入。
- `assertSeasonStatsInvariants`：`points=0` 且并列键非 null → 违约。

**写路径**
- 首次结算：新建 `user_season_stats`，`last_scoring_match_at` = 该场 anchor（得分 > 0）或 null（0 分）。
- 同赛季多场：并列键取最大 anchor。
- 修正：得分改为 0、且旧并列键恰为该场 anchor → 回退为次新得分场；没有则 null。
- 跨赛季：两场分属不同等级赛季，各自赛季的并列键互不影响。
- 周评估 / 修正重评：不丢字段（C07）。
- `rebuild/user-stats`：重建值与增量值一致；一致性任务无差异。

**快照**
- 仅含当前赛季、`valid_predictions ≥ 1`、非已注销用户；排序与比较器一致；`rank` 连续。
- 空榜写 `head` 哨兵行且带 `level_season_id`。
- 同 `(board, snapshotAt)` 重复执行幂等。
- 锁被占用 → `SETTLEMENT_ALREADY_RUNNING`。
- 重建：覆盖最新版本，审计 `total_season_points` 正确。

**查询 / API**
- 首赛季用户（1 个赛季）：`available_boards` 不含 `season`；请求 `board=season` → 列表照常、`me.status=not_eligible`（**包括他在榜单里时**）。
- 2+ 赛季用户：`available_boards` 含 `season`（满足数据条件时），`me` 为 `ranked / not_participated`；`top_percent` 的 N 为全体入榜人数。
- 游客：任一 board 请求返回 `401 UNAUTHORIZED`；已注销用户返回 `409 USER_DELETED`。
- 已注销用户：不在榜。
- 所有 board（week / career / strength / season）响应都带 `available_boards`，各标签显隐按规范 §19.10.8 逐条断言（含群范围、新建群、上线初期）。
- 跨赛季：注入 `server_now` 在 07-01 之后、而最新快照属上赛季 → 返回空列表、`updated_at=null`、**不展示上赛季数据**。
- 群范围：成员过滤后群内重排；请求者非成员 → 403；资格不足者 `not_eligible`。
- 分页：season 的 cursor 往返；cursor 与 board 不匹配 → 422。
- `period_key` 对 season 非法 → 422。

**scheduler / openapi / admin**
- `tick` 分发 season 任务；锁 key 正确。
- openapi 合同测试覆盖新字段与 enum；`admin/rebuild/rankings` 接受 `board=season`，携带 `period_key` → 422。

**小程序**
- `available_boards` 不含 `season` 时无「赛季榜」tab；停留在 season 时切回 week。
- `not_eligible` 时不显示名次区。

---

## 6. 风险与待确认

| # | 问题 | 推荐默认 | 影响 |
|---|---|---|---|
| Q1 | 新赛季首次出现入榜者前，赛季榜显示什么 | **已定**：显示上赛季榜（终榜未生成时为最后一版常规快照，标「等待最终确认」），见规范 §19.10.10；取代早先「空榜」方案 | F05、F13 |
| Q2 | `board_snapshots` 唯一键是否纳入 `level_season_id` | **不改**，保持 `UNIQUE(board, snapshot_at, user_id)`；赛季靠行内字段判断 | A08、D02 |
| Q3 | 是否在 07-01 边界额外触发一次 season 快照 | **可选**，不做也满足规范（空窗 ≤ 1 小时） | E05 |
| Q4 | `seasons_participated` 每次请求现算，还是缓存到 `users` | **现算**（单用户 stats 行极少），避免多一个需维护的缓存与对应重建/一致性项 | F07 |
| Q5 | 「实力榜」改名（如「均分榜」）是否一起做 | **不在本文范围**：仅界面文案；内部 `strength` 枚举与接口字段保持不变 | — |

**风险提示**

1. **漏改某个 `Object.values(RankingBoard)` 校验点**：加枚举值后这些点会自动放行 `season`，但快照读取、重建、一致性中有若干 `if career … else strength` 的二分写法，`season` 会落入错误分支。实施时全仓搜索 `RankingBoard.Career` / `RankingBoard.Strength`（共 10 余处，清单见 §2），逐处确认。
2. **三条并列键写路径漏一条**（§3.2）。
3. **`not_eligible` 判断顺序**（§3.3）：写错会向首赛季用户泄漏名次。
4. **CloudBase 接线**（D03）：本仓库的 CloudBase repository 目前仅覆盖部分集合；接线切片落地时必须带上新字段与 `findByLevelSeason`，否则线上与内存实现行为分叉。
5. **规范未提交**：`docs/MVP__v2.0.md` 当前在 git 中为未跟踪文件，改动无历史可回退；建议开工前先提交一次规范基线。


---

## 7. 冷启动与低流量体验（用户很少 / 新周 / 新赛季 / 休赛期 / 无群）

> 本节为功能需求与后端支撑的开发说明。**规范待同步**：这些行为（人数阈值、默认周选择规则、新增响应字段）目前只在本文，需要在 `docs/MVP__v2.0.md` 补一节（建议 §19.10「低流量与冷启动展示」）后再合入 S7。
> 已确认不做：首批预言家徽章。赛季终榜已纳入（§8）；欧冠只写规划、不实现（§9）。
> 修订记录：v1.0 初稿曾设计 5 阶段 `week_state`、`schedule_hint`、上周回顾卡；经产品确认「周一直接显示上周、周中/周末不加提示、国际比赛日显示最近一周」后，已简化为**默认周选择规则 + 更新时间**（§7.5），上述三项取消。

### 7.0 总原则

1. **不虚构用户**：不放机器人、官方账号、假头像、假名字。
2. **提示越少越好**：除少人状态与无群引导外，周中、周末、圣诞季都**不加额外提示**，只显示「更新于 N 分钟/小时前」。
3. **默认周由服务端决定**（§7.5），客户端不用星期几推断。
4. **阈值**：入榜人数 `< 20` 视为「少人榜」（`RANKING_THIN_BOARD_THRESHOLD = 20`，数值与 `RANKING_TOP_LIMIT` 相同，但单独成常量）。
5. **范围边界**：欧冠及其他杯赛不在 MVP（规范 §1.3 OUT_OF_SCOPE）。

### 7.1 功能清单

| ID | 功能 | 层 |
|---|---|---|
| X01 | 按入榜人数分档展示（0 / 1–2 / 3–19 / ≥20） | 小程序 + `entry_count` |
| X02 | 少人时的邀请入口（邀请好友建群） | 小程序 |
| X03 | 无群用户：范围入口显示「我的群」未解锁行，点击进入创建/加入引导，不展示群选择 | 小程序 |
| X04 | 周榜默认显示哪一周（周一显示上周；本周无人入榜时显示最近一个有人入榜的周） | 后端 + 小程序 |
| X05 | 榜单「更新于 N 分钟 / 小时 / 天前」 | 小程序（用现有 `updated_at`） |
| X07 | 赛季个人回顾卡（上赛季积分、最高等级） | 后端 `previous_season` + 小程序 |
| X08 | 首个赛季提示（生涯榜上一行说明） | `seasons_participated` + 小程序 |
| X09 | 赛季初提示（赛季榜顶部「赛季刚开始，名次变化会比较大」） | 小程序 |
| X10 | 实力榜沿用 X01 分档；`below_threshold` 进度保持 | 小程序 |
| X11 | 比赛页默认联赛：仅休赛期默认中超，否则英超（国际比赛日仍为英超） | 小程序（用比赛列表接口） |
| X12 | 「我的 · 最近预测」可翻阅至少最近 8 周 | 小程序（用现有 `GET /v1/predictions/me`） |
| X13 | 游客：榜单页灰色占位 +「请登录查看榜单」；接口需登录 | 后端 + 小程序 |
| X14 | 榜单标签按各自数据显隐（`available_boards`） | 后端 + 小程序 |
| X15 | 新赛季交接：默认显示上赛季榜，终榜未生成时标「等待最终确认」 | 后端 + 小程序 |
| X16 | 周榜选择器只列最近 4 周，且不早于上线周 | 后端校验 + 小程序 |

> 编号 X06 已随 `schedule_hint` 一并取消，保留空号以免与讨论记录错位。

### 7.2 X01 入榜人数分档

`N = entry_count`：该 board、该范围（全站或群）的**全部**入榜人数，与列表过滤口径一致（已注销用户已排除）。

| N | 领奖台 | 列表标题 | 其它 |
|---|---|---|---|
| 0 | 不显示 | — | 空状态：「{榜名}还没有人入榜。第一场预测结算后，你就是第一名」+「去预测」按钮 |
| 1–2 | 不显示（避免出现空位） | 「全部 {N} 位预言家」 | 第 1 名用一张放大的卡片，其余按列表 |
| 3–19 | 显示 | 「全部 {N} 位预言家」（不写「前 20」） | 其余保持现有布局 |
| ≥ 20 | 显示 | 「全站前 20」（群内「群内前 20」） | 现有逻辑（含 `top_percent`） |

补充：

- `top_percent` 仅在名次 `> 20` 时出现（规范 §19.3），所以 `N ≤ 20` 时本来就只显示绝对名次；设计稿需增加少人状态示例，如「第 2 名 · 共 4 人」。
- 概览卡的「入榜人数」必须使用真实 `entry_count`，不得写死。
- N ≥ 3 时前三名都有人，领奖台不会出现空位；N 为 1–2 时直接不渲染领奖台，所以不需要占位头像。

### 7.3 X02 少人时的邀请入口

- 触发：`scope=global` 且 `N < 20`，或 `scope=group` 且 `N ≤ 1`。
- 文案：「邀请好友建个群，看看谁更懂球」（全站少人）/「邀请好友加入这个群」（群内只有自己）。
- 动作：全站场景跳转到群创建/加入页；群内场景使用现有群邀请码分享。
- 用户已加入 20 个群或已创建 5 个群时，隐藏对应的创建/加入按钮，仅保留可用操作。

### 7.4 X03 无群用户的范围入口

| 用户状态 | 范围入口表现 |
|---|---|
| 没有任何 active 群，或所有群均已解散 | 「全站」为选中；「我的群」显示为未解锁行（锁图标 +「创建或加入群后解锁」），**点击不进入群榜**，进入「创建群 / 输入邀请码加入」引导页；引导页说明「每个群独立排名」「最多加入 20 个、创建 5 个」 |
| 有 1 个及以上 active 群 | 正常：可选择具体群 |
| 群内只有自己 | 可进入群榜，按 X01 的 N=1 显示，并出现 X02 的邀请入口 |

- 判断依据：客户端调用现有 `GET /v1/groups/me`，`items` 为空即无群；**不新增接口**。
- 客户端不得对无群用户发送 `scope=group` 请求（服务端对非成员返回 `403 FORBIDDEN`，是兜底而非交互路径）。
- 视觉：胶囊方案放在弹层里，分段开关方案放在「我的群排行」分段上。

### 7.5 X04 / X05 周榜默认显示哪一周，以及更新时间

**默认周选择规则**（`board=week` 且请求未带 `period_key` 时，服务端决定返回哪一周）：

1. 候选周：北京时间**周一** → 上一周；**周二至周日** → 本周。
2. 若候选周在**所选范围**（全站或群）入榜人数为 0（国际比赛日、休赛期、整周无结算、新建群）→ **在可选窗口内向前取最近一个有人入榜的周**；窗口内仍无则返回候选周的空榜（走 X01 的 N=0 空状态）。
3. **可选窗口**：最近 `RANKING_WEEK_WINDOW = 4` 周（本周 + 前 3 周），且不早于上线周 `RANKING_FIRST_PERIOD_KEY`。周选择器只列窗口内的周；窗口外或上线前的 `period_key` 服务端返回 `422`，**不让用户手动选到上线前的周**。

| 北京时间 | 页面行为 |
|---|---|
| 周一（全天） | 直接显示**上周榜**；周选择器可切到本周 |
| 周二–周四 | 正常显示本周榜；有无比赛都**不加提示** |
| 周五 | 同上 |
| 周六、周日 | 正常显示本周榜；只显示「更新于 N 分钟前」 |
| 圣诞季（12/20–1/5） | 同周六、周日；更新时间显示「N 分钟前」或「N 小时前」；周范围标题用北京时间日期（如「12.29—01.04」），不写自然年（规范 §7.1 的 ISO week-year 可能与自然年不同） |
| 国际比赛日（本周无结算） | 回溯到最近一个有人入榜的周，**只显示该周榜单**，不加说明文字 |
| 休赛期 | 同国际比赛日（回溯）；若有中超比赛结算则本周有人入榜，自然显示本周 |

**响应变化**（见 §7.9）：`period_key` 回显实际返回的周；新增 `current_period_key`（本周 key），供周选择器标出「本周」。

**更新时间格式**（X05，所有榜通用）：`updated_at` 与 `server_now` 相差 `< 1 分钟` →「刚刚更新」；`< 60 分钟` →「N 分钟前更新」；`< 24 小时` →「N 小时前更新」；否则「N 天前更新」。必须用服务端时间做差，不用手机时钟。

要点：

- 为什么不再显示「已封榜 / 结算中」：周日深夜开球的比赛在北京时间已过零点才结算，`rankings.is_final`（`period_finalize` 每小时置位，规范 §32.6）与「全部结算完」并不同步。界面不再出现「已封榜」措辞，统一用更新时间，避免误导。设计稿里原有的「上周 · 已封榜」标记应删除。
- 回溯只读 `rankings`（每周一份），不需要读 `matches`。

### 7.6 周一至周日显示建议（最终）

北京时间（UTC+8）。欧洲联赛晚场落在北京次日凌晨，周日晚在欧洲开球、北京已过零点的比赛算入下一周（规范 §7.1/§7.2），新周第一批比赛周一凌晨即开球，因此周一显示上周榜、周二起切到本周榜是自然的切换点。

| 星期 | 默认显示 | 提示文字 |
|---|---|---|
| 周一 | 上周榜 | 更新于 N 分钟/小时前 |
| 周二–周四 | 本周榜（含联赛补赛、圣诞季周中轮） | 无额外提示 |
| 周五 | 本周榜 | 无额外提示 |
| 周六、周日 | 本周榜 | 更新于 N 分钟前 |
| 圣诞季 | 本周榜 | 更新于 N 分钟/小时前 |
| 国际比赛日 | 最近一个有人入榜的周 | 更新于 N 天前（按 X05 格式） |
| 休赛期 | 最近一个有人入榜的周（有中超结算则为本周） | 更新于 N 天前 |

### 7.7 X11 比赛页默认联赛（仅休赛期显示中超）

- 规则：进入小程序时，比赛页默认联赛 = 英超；**只有英超休赛期才默认中超**。国际比赛日**不**算休赛期，仍默认英超。
- 休赛期**用数据判定，不写死日期**：英超在「过去 7 天」与「未来 21 天」内均无比赛（含未结束与已结束）→ 休赛期。
  - 为什么不对称：国际比赛日英超两场之间最长约 16 天，「未来 21 天」窗口内总会有下一场，不会误判；而休赛期整段 3 个月无比赛，从最后一轮后第 8 天起判为休赛期，到开幕前 21 天恢复英超。
  - 若新赛季赛程尚未同步（未来无比赛），按同一规则判为休赛期，行为一致。
- 休赛期默认中超的前提：中超在此期间有比赛；中超也无比赛时仍默认英超。
- 仅影响**默认选中的联赛标签**，用户可手动切换。
- 数据来源：现有比赛列表接口，**无后端改动**；客户端需要能取到英超「过去 7 天」的比赛（比赛列表接口按日期范围取数，范围需覆盖过去 7 天，若现有接口只支持今天起的范围，需放宽，见实现时确认）。
- 欧冠未纳入（见 §9）。

### 7.8 X07–X09 赛季个人回顾与赛季提示

- **X07 赛季个人回顾卡**：展示「上赛季你拿了 {points} 分，最高到 Lv{best_level}」。
  - 数据：资料接口增 `previous_season: { level_season_id, points, valid_predictions, exact_hits, best_level } | null`，取该用户 `level_season_id` 早于当前赛季、`valid_predictions ≥ 1` 的最近一个赛季；无则 `null`。
  - 排行榜页展示窗口：新赛季起 4 周内，且用户在当前赛季尚未出现在赛季榜上时显示；「我的」页常驻（Q6）。
  - 不依赖历史榜单，只读个人 `user_season_stats`。
- **X08 首个赛季提示**：登录用户且 `seasons_participated < 2` 时，在生涯榜顶部加一行「你正在第一个赛季，生涯榜与赛季榜内容相同」。（排行榜需登录，不存在游客，见 X13。）
- **X09 赛季初提示**：赛季榜顶部加一行「赛季刚开始，名次变化会比较大」，赛季开始后 4 周内显示；赛季开始日期由 `level_season_id`（形如 `"2026_2027"` → 2026-07-01 北京时间）推出。

### 7.9 接口与数据变更汇总

| 位置 | 变更 | 说明 |
|---|---|---|
| `GET /v1/rankings` 响应 `data` | 新增 `entry_count: number` | 全部 board；该 board、该范围的入榜总人数 |
| 同上 | 新增 `seasons_participated: number` | 请求者的参与等级赛季数（整数；接口需登录，不再有 `null`） |
| 同上 | 新增 `available_boards: string[]` | 该请求者在所选范围下可见的榜单标签，规范 §19.10.8；取代早先的 `season_board_visible` |
| 同上（`board=season`） | 新增 `level_season_id / available_level_seasons / is_provisional` | 赛季选择与上赛季交接，规范 §19.10.10、§19.11 |
| 同上（`board=week`） | 新增 `current_period_key: string` | 本周 key，`period_key` 为实际返回周 |
| `GET /v1/rankings` 行为（`board=week` 且未带 `period_key`） | 默认周由 §7.5 规则决定 | **修改规范 §27.1「缺省按当前周」的描述**；带 `period_key` 时行为不变 |
| 资料接口（`src/application/profile.ts`） | 新增 `previous_season` | 见 X07 |
| 配置 | 新增 `RANKING_THIN_BOARD_THRESHOLD = 20`、`RANKING_WEEK_WINDOW = 4`、`RANKING_FIRST_PERIOD_KEY`（上线时登记） | 前者前端分档使用（Q8）；后两者服务端校验 `period_key` 并用于默认周回溯 |

实现要点：

- `entry_count` 在 `RankingQueryService.list` 里已具备（构造 `ranked` 数组后取长度，`src/application/ranking-query.ts:404` 附近），无额外查询成本。
- 默认周选择做成**纯函数**（输入：`server_now`、各候选周的入榜人数查询函数），便于对周一、跨年、国际比赛日、休赛期做单元测试；回溯循环最多 4 次 `rankings.findByPeriod`，且只在 `board=week` 且未带 `period_key` 时发生。
- 周一判定使用北京时间（`toShanghaiParts`），不要用服务器本地时区。
- 所有新字段缺失时客户端必须降级为现有行为，不得白屏。

### 7.10 测试补充

**默认周选择**
- 北京时间周一 00:00、周一 23:59 → 上周；周二 00:00 → 本周；周日 23:59 → 本周。
- 周一且上周也无人入榜 → 继续回溯；回溯满 4 周仍无 → 返回候选周空榜。
- 国际比赛日：本周入榜 0 人、上周 > 0 → 返回上周；两周都无 → 返回再上一周。
- 本周有 1 人入榜（周中补赛）→ **不回溯**，显示本周（少人榜，走 X01）。
- 圣诞跨年：周 key（ISO week-year）正确，`current_period_key` 与 `period_key` 一致/不一致两种情形。
- 带显式 `period_key` 时不触发默认逻辑。

**接口**
- 所有 board 响应都带 `entry_count / seasons_participated / available_boards`。
- `period_key` 超出最近 4 周窗口或早于上线周 → 422；窗口内正常。
- 游客请求排行榜 → 401；小程序游客页不发请求。
- `entry_count` 与 `items`、群范围过滤口径一致（群内只有自己时为 1）。
- 新字段对旧客户端无破坏。

**小程序**
- `entry_count` 为 0 / 1 / 2 / 3 / 19 / 20 的分档渲染（含领奖台与标题）。
- 无群用户：「我的群」为未解锁行，点击进入引导页，**不发出 `scope=group` 请求**。
- 更新时间格式：59 秒 / 1 分钟 / 59 分钟 / 1 小时 / 23 小时 / 24 小时 / 3 天的边界。
- 周榜不再出现「已封榜」字样。
- 比赛页默认联赛：英超窗口有比赛 → 英超；英超窗口无比赛且中超有 → 中超；两者都无 → 英超。
- 赛季个人回顾卡与赛季初提示的显示窗口（4 周）边界。

### 7.11 待确认（均有推荐默认值）

| # | 问题 | 推荐默认 |
|---|---|---|
| Q6 | 赛季个人回顾卡在排行榜页的展示窗口 | 新赛季起 4 周内且用户尚未入赛季榜；「我的」页常驻 |
| Q8 | 少人阈值 20 由接口下发还是写在小程序配置 | 写在小程序配置，与规范常量保持一致 |
| Q10 | 欧冠等杯赛未来纳入后对 §7.5 / §7.7 的影响 | 默认周规则按入榜人数推导，无需改结构；比赛页联赛标签与休赛期判定需调整 |
| Q11 | 国际比赛日是否也让比赛页默认中超 | **已定：否**，仍默认英超；只有休赛期默认中超（§7.7 新判定） |
| Q12 | 周榜可选 / 回溯范围 | **已定：最近 4 周（含本周）**，且不早于上线周（`RANKING_WEEK_WINDOW=4`、`RANKING_FIRST_PERIOD_KEY`）；默认周回溯也只在该窗口内；窗口内全无入榜则返回空榜。注意「最近 4 周」我按**含本周**理解（本周 + 前 3 周） |
| Q13 | 最近预测按周分组时的排序 | **已定：保持现状**——沿用接口的提交时间排序，仅在界面按 `kickoff_at` 所在周显示分组标题；不新增 `period_key` 过滤 |
| Q14 | 休赛期判定窗口（过去 7 天 / 未来 21 天）是否合适 | 合适：国际比赛日英超最长间隔约 16 天，未来 21 天窗口内总有下一场，不会误判；休赛期从最后一轮后第 8 天起默认中超，到开幕前 21 天恢复英超 |

### 7.12 X12 「我的 · 最近预测」回看至少 8 周

- 需求：用户在「我的」的最近预测里，能向前翻阅**至少最近 8 周**的预测与结果。
- 现状：`GET /v1/predictions/me`（规范 §26.2）按 `submitted_at DESC, prediction_id DESC` keyset 分页，**没有时间上限**，已满足「能翻到 8 周」；产品**不设 8 周硬上限**，8 周是客户端必须保证可达的最低范围（规范 §19.10.6）。
- 与默认周回溯（4 周）互不冲突：默认周回溯只管排行榜默认显示哪一周；最近预测是个人记录列表。8 周 ≥ 4 周，用户在榜上看到的任一默认周，都能在最近预测里找到自己对应的预测。
- 开发要点：
  - 客户端必须持续用 `next_cursor` 翻页，直到 `kickoff_at` 早于 8 周前或 `has_more=false`；不得只拉第一页。
  - 若界面要按「周」分组（本周 / 上周 / 第 N 周），分组依据是比赛的 `kickoff_at`（北京时间周一起算，与周榜口径一致）。**注意**：列表按**提交时间**排序，一场下周比赛的预测可能提前很久提交，分组标题可能出现不连续；见 Q13。
- 测试：构造 9 周数据，客户端翻页后能到达第 8 周的最早一条；`has_more=false` 时停止。

### 7.13 已决事项与后续范围

| 事项 | 决定 | 落点 |
|---|---|---|
| 首批预言家徽章 | 不做 | — |
| 少人阈值 | 20 | §7.0、规范 §19.10 |
| 赛季终榜 | **纳入**：与等级赛季最终评估一起冻结；全部赛季永久保留；不做冠军标识 | §8、规范 §19.11 |
| 欧冠 | **只写规划，不实现**；排行榜展示规则已与赛事来源解耦 | §9、规范 §19.12 |
| 国际比赛日的默认联赛 | 仍为英超，**只有休赛期**才默认中超 | §7.7 |
| 默认周回溯上限 | 4 周 | §7.5 |
| 最近预测回看 | 至少 8 周，无硬上限 | §7.12 |
| 周榜可选范围 | 最近 4 周（含本周），不早于上线周 | §7.5、X16 |
| 标签显隐 | 按各自数据判断 | §7.14、X14 |
| 新赛季空窗 | 显示上赛季榜；终榜未生成时标「等待最终确认」 | §3.1、X15 |
| 游客 | 排行榜接口需登录；页面灰色占位 + 「请登录查看榜单」 | X13、F11 |

### 7.14 X13–X16 补充规则与空榜清单

**X13 游客**：排行榜接口需登录（规范 §19.10.9）。游客进入榜单页：内容整体模糊成**通用灰色条纹占位**，居中一行「请登录查看榜单」；占位里不出现任何用户名、头像、分数（不虚构用户）；**不发榜单请求**。登录后正常显示。已注销用户返回 `409 USER_DELETED`。

**X14 标签显隐**：见规范 §19.10.8。后端用纯函数 `computeAvailableBoards`（F12）计算，前端只渲染不判断。

| 榜 | 显示条件（简述） |
|---|---|
| 周榜 | 始终 |
| 生涯榜 | 所选范围内有人入榜 |
| 实力榜 | 请求者自己满 50 场 |
| 赛季榜 | 请求者参与 ≥2 个赛季，且（当前赛季有人入榜，或全站范围存在可展示的上赛季榜） |

**X15 新赛季交接**：见规范 §19.10.10 与 F13、§3.1。上赛季临时榜与终榜的差异只会来自赛季末晚结算的比赛，界面的「等待最终确认」标注在终榜生成后消失。

**X16 周选择器**：只列本周 + 前 3 周（共 4 周），且不早于上线周；服务端对窗口外的 `period_key` 返回 422，界面不依赖前端过滤。`RANKING_FIRST_PERIOD_KEY` 在上线时登记，只追加。

**现在仍会出现空榜的情况**（标签隐藏之后）：

| 场景 | 榜 | 展示 |
|---|---|---|
| 上线初期尚无任何结算 | 周榜（全站） | 空状态：「本周还没有人入榜。第一场预测结算后，你就是第一名」+「去预测」；生涯、赛季、实力标签均不显示 |
| 最近 4 周窗口内全无入榜（极少见） | 周榜（全站） | 同上 |
| 新建的群，群内没人预测过 | 周榜（群） | 空状态：「群里本周还没有人入榜」+「去预测」+「邀请好友」；群范围下生涯、赛季标签不显示 |
| 榜上唯一入榜者是已注销用户（被过滤） | 周榜 | 同上，视范围而定 |
| 快照尚未生成（生涯榜、赛季榜刚有第一个入榜者，最长约 1 小时） | 生涯榜 / 赛季榜 | 标签暂不显示（按 `available_boards`），不是空榜 |

以下**不再是空榜**：实力榜没人满 50 场（标签不显示）；新赛季尚无人入榜（显示上赛季榜）；游客（灰色占位，不是榜单数据）。

---

## 8. 赛季终榜（`board=season` + `level_season_id`，规范 §19.11）

> 决定：与等级赛季最终评估一起冻结；全部赛季永久保留；不做冠军标识；仅全站；入榜与可见资格同当前赛季榜。依赖 S1–S5（赛季榜本体）先落地。

### 8.1 差异清单

| ID | 位置 | 现状 | 要求 | 类型 | 影响面 |
|---|---|---|---|---|---|
| Z01 | `src/domain/enums.ts:150-163` `SyncJobType`；`src/schema/collections.ts:428` | 无终榜任务 | 增 `BoardSnapshotSeasonFinal: "board_snapshot_season_final"`，schema `job_type` enum 同步 | 新增 | schema 测试 |
| Z02 | `src/domain/types.ts:286-300` `BoardSnapshot`；`collections.ts:504-522` | 无终榜标记 | 增 `is_final: boolean`（默认 false，仅 `board=season` 可为 true）；终榜行 `level_season_id` 必填 | 修改 | 所有构造 `BoardSnapshot` 的位置；`invariants.ts` 增校验（`is_final=true` ⇒ `board=season` 且 `level_season_id` 非空） |
| Z03 | `src/infrastructure/repositories.ts:341-349` `BoardSnapshotRepository` | `findLatestByBoard(board)`、`findByBoardAndSnapshotAt`、`insert` | 新增 `findFinalBySeason(levelSeasonId)`、`listFinalSeasonIds()`；**`findLatestByBoard` 必须排除 `is_final=true` 的行**（见 §8.2 第 1 条） | 修改+新增 | in-memory 实现（`:1776-1800`）与 CloudBase 实现各一份 |
| Z04 | `src/application/board-snapshot.ts`（`BoardSnapshotService`） | 只有 `generate(board, serverNow)` | 新增 `generateSeasonFinal(levelSeasonId, serverNow)`：读该赛季 `user_season_stats` 全量，复用赛季榜的构造函数（E02），写入时 `is_final=true`；锁 `sync:board_snapshot_season_final`；同一赛季已有终榜则直接返回（幂等，用 `findFinalBySeason` 判断，不能靠 `snapshot_at`） | 新增 | 快照测试 |
| Z05 | `src/application/weekly-level-eval.ts:229,279`（周评估完成后触发 strength 快照） | 仅触发 strength | 周评估完成后，若 `asOf ≥ 该赛季最终评估时刻`（`seasonFinalEvalAsOf`，见 `stats-rebuild-service.ts:140`）且该赛季尚无终榜 → 调用 `generateSeasonFinal`。**补跑**：若错过多周，遍历 `user_season_stats` 中所有早于当前赛季且无终榜的赛季，逐个生成 | 修改 | weekly-level-eval 测试：首次终评生成、重复周评估不重复生成、漏跑补生成 |
| Z06 | `src/application/ranking-query.ts:20-29,96-113,307-388` | 无 `level_season_id` | `RankingQuery` 增 `level_season_id: string \| null`；校验：仅 `board=season` 可带，格式 `^\d{4}_\d{4}$` 且后一年 = 前一年 + 1；`scope=group` 带历史赛季 → 422；`board=season` 且 `level_season_id` 为历史赛季 → 读 `findFinalBySeason`，**不存在则回退到该赛季最后一版常规快照并带 `is_provisional=true`（仅限上赛季，见 F13）**，该赛季从未有数据 → 404；缺省 → 走 F13 默认赛季规则 | 修改 | 新增 `NOT_FOUND` 映射 |
| Z07 | 同文件 `:390-410`（`isHistoricalWeek` / `keepHistoricalRank`） | 历史周榜保留快照名次、已注销用户显示「已注销用户」 | 终榜沿用同样处理：保留 `snapshot.rank`，已注销用户**不过滤**、显示「已注销用户」 | 修改 | 查询测试 |
| Z08 | 同文件 `me` 块 | 当前榜逻辑 | 终榜的 `me`：用终榜名次计算 `rank / top_percent`；资格不足者仍为 `not_eligible`；未参与该赛季为 `not_participated` | 修改 | — |
| Z09 | 同文件响应 | — | `board=season` 响应增 `available_level_seasons: string[]`（当前赛季、上赛季与 `listFinalSeasonIds()` 中**至少有 1 名入榜者**的赛季，倒序）与 `is_provisional`；终榜的 `updated_at` = 冻结时刻；临时榜的 `updated_at` = 那一版常规快照时刻 | 修改 | api 与 openapi |
| Z10 | `src/api/v1/rankings.ts:13-60` | `RANKINGS_QUERY_FIELDS` 无该字段 | 白名单增 `level_season_id`；响应透传 `level_season_id`、`available_level_seasons` | 修改 | api 测试 |
| Z11 | `src/api/v1/openapi.yaml` | — | 增 `level_season_id` query；`RankingData` 增 `available_level_seasons`；错误表增 `404 NOT_FOUND`、`422`（群榜 + 历史赛季）；与 S5 的 season 字段合并维护 | 修改 | 合同测试 |
| Z12 | `src/application/ranking-rebuild-service.ts`、`admin-rebuild-rankings.ts`、`daily-consistency-snapshot.ts:198-247` | 重建与对账读 `findLatestByBoard` | 因 Z03 已排除终榜，重建与对账**自然只作用于当前赛季榜**；增测试断言「重建 season 不触碰 `is_final=true` 行」；本版不提供修改终榜的管理接口 | 修改 | 回归测试 |
| Z13 | 数据生命周期清理（规范 §37，实现位置待确认） | 「只保留最近 N 版」 | 清理逻辑必须跳过 `is_final=true`；若代码里尚无清理任务，仅在落地时加此约束 | 待确认 | 实施前 `grep` 清理入口 |
| Z14 | `miniprogram/services/rankings.js`、`pages/rankings/*` | 无赛季选择 | 赛季榜内增赛季选择（来自 `available_level_seasons`，默认当前）；选历史赛季时范围固定为全站（群入口隐藏）；不显示冠军标识；`available_level_seasons` 只有 1 项时不显示选择器 | 修改 | 页面测试 |

### 8.2 关键设计细节

1. **终榜行不能混进「最新快照」查询。** `findLatestByBoard("season")` 取的是最新 `snapshot_at` 的整批快照。终榜在周一终评后才生成，其 `snapshot_at` 可能晚于当前赛季最近一次小时快照，若不排除，当前榜会错误地读到上赛季终榜。Z03 把 `is_final=true` 排除在所有 `findLatestByBoard` 之外，终榜只通过 `findFinalBySeason` 读取。
2. **冻结点**：赛季结束后的第一次周评估完成时（规范 §17.8.4）。在此之前（最长约一周）上赛季榜以**最后一版常规快照**临时展示（`is_provisional=true`，界面标「等待最终确认」），终榜生成后自动替换。因此**数据保留策略必须保证：每个赛季的最后一版常规快照在终榜生成之前不被清理**（按 `(board, level_season_id)` 各保留最新一版，而不是只保留全表最近 N 版——新赛季一周的小时快照可能把上赛季最后一版挤掉）。
3. **不可变与对账**：赛季统计（积分）冻结后仍随赛果修正更新（规范 §16.2），因此终榜与其后的 `user_season_stats` 可能不一致，这是预期，**不要**让一致性任务或重建「修复」它（Z12）。
4. **空赛季**：某赛季无人入榜时可写入哨兵 head 行表示「已生成」（沿用现有 head 机制，`is_final=true`），但不进入 `available_level_seasons`。
5. **幂等**：终榜以 `level_season_id` 为幂等键（`findFinalBySeason` 有行即返回），不要用 `snapshot_at` 判断（重复触发时间不同）。
6. **群榜**：不做历史赛季群榜（Z06 返回 422），理由见规范 §19.11。

### 8.3 测试清单

- 终评前：请求上赛季 → 返回最后一版常规快照，`is_provisional=true`；`available_level_seasons` 含上赛季；请求从未有过数据的赛季 → 404。
- 终评前后保留策略：新赛季连续生成一周的小时快照（含空 head 行）后，上赛季最后一版常规快照仍可读取。
- 终评后：生成终榜；`findLatestByBoard("season")` **不返回**终榜行（当前榜不受影响）。
- 重复触发周评估：不重复生成；漏跑多周后补生成全部缺失赛季。
- 冻结后发生赛果修正：终榜不变，`user_season_stats` 更新。
- 重建 / 一致性：不触碰终榜行。
- 查询：`level_season_id` 格式非法 → 422；`board != season` 带该参数 → 422；`scope=group` + 历史赛季 → 422；已注销用户显示「已注销用户」且保留名次；`me` 按终榜计算；资格不足仍 `not_eligible`。
- 小程序：仅 1 个可选赛季时不显示选择器；选历史赛季后群入口隐藏；无冠军标识。

---

## 9. 欧冠（后续规划，本期不实现）

> 规范 §19.12：欧冠及杯赛仍为 OUT_OF_SCOPE，本节只记录与本期工作的边界。

- **本期要做的部分**：只有「排行榜每天如何显示」的逻辑（§7.5–§7.6）。该逻辑按入榜人数和数据驱动，**与赛事来源无关**，将来纳入欧冠（周中比赛）后无需调整。本期不需要为欧冠写任何代码。
- **本期不做**：赛程与结果同步、预测与计分、比赛页联赛标签、球队主数据、等级与排行榜计入。
- **开工前需要先决定**（已写入规范 §19.12）：①是否计分、计入等级/生涯（规范 §17.4：须新规则版本并新增独立积分口径）；②范围（仅欧冠 / 含欧联）；③比分口径（建议 90 分钟，不含加时点球）；④非六联赛球队的主数据与 `league_id` 枚举扩展；⑤Provider 接入与配额；⑥比赛页标签与休赛期默认联赛规则；⑦验收矩阵新增杯赛组。
- **纳入时已知会受影响的本期设计**：周二至周四将出现比赛（§7.6 的星期表只是描述，规则本身不变）；比赛页休赛期判定（§7.7）需把欧冠纳入或排除，需届时明确。

---

## 10. 前端 UI 占位策略（视觉稿定稿前）

> 适用范围：本文所有**还没有定稿设计**的前端界面（S6、S8、§8 的 Z14）。后端不受本节影响：**后端代码必须严谨、完整**，不得因为前端是占位就简化接口、字段、校验或测试。

### 10.1 总原则

1. **功能正确，不追求好看**：占位 UI 用最简单的现成控件（`view` / `text` / `button` / `picker`）实现，目标是数据与逻辑可验证，不是视觉。
2. **不能把现有页面搞乱**：不改动现有页面已有的结构、样式与交互；所有新增界面都是**条件渲染的独立块**，只在新状态下出现（空榜、少人、游客、无群、赛季交接等）。常态（人数 ≥ 20、有群、有数据）下页面与改动前**逐像素一致**。
3. **不引入新的设计 token、不写新的复杂样式**：占位块只使用已有基础样式；需要区分时只用一个统一的占位类名 `ui-placeholder`，便于之后整体查找替换。
4. **每个占位都可被一次性替换**：占位块用统一注释标记 `TODO(UI-v2)`；视觉稿到位后只替换 `wxml` / `wxss`，**不动逻辑**。
5. **后端不为前端占位让步**：不新增「临时」接口字段、不返回 mock 数据、不为占位放宽校验。后端行为一律以规范和本文 §2、§7、§8 为准。

### 10.2 逻辑与展示分离（让之后替换视觉时零风险）

- 新增一个**纯函数视图模型层**（建议 `miniprogram/utils/rankings-view-model.js`），输入接口响应 + 当前选择，输出展示标志，页面只负责渲染：

  | 输出 | 含义 |
  |---|---|
  | `tabs` | 要渲染的榜单标签（直接来自 `available_boards`） |
  | `weekOptions` | 周选择器可选项（最近 4 周，不早于上线周；以服务端 `current_period_key` 为基准） |
  | `showPodium` | 是否显示领奖台（`entry_count ≥ 3`） |
  | `listTitleKind` | `top20` / `all_n`（少人时「全部 N 位预言家」） |
  | `emptyKind` | `none` / `week_global` / `week_group` / `generic` |
  | `notices[]` | 需要显示的单行提示（首赛季、赛季初、等待最终确认、邀请入口等） |
  | `updatedText` | 「更新于 N 分钟 / 小时 / 天前」 |
  | `guestPlaceholder` | 游客是否显示灰色占位 |

- 所有文案集中在**一个文件**（建议 `miniprogram/utils/rankings-copy.js`），页面不写死字符串；之后改文案只改这里。
- 视图模型层与文案文件要有单元测试（§5 / §7.10 的小程序用例）；占位 `wxml` 本身不要求测试。

### 10.3 占位清单（最简实现）

| 场景（编号） | 占位实现 | 之后由设计稿替换 |
|---|---|---|
| 空榜（X01，N=0） | 一个 `view.ui-placeholder`：一行文案 + 一个「去预测」`button`（跳转比赛页） | 空状态插画、版式 |
| 少人（X01，1–2 人 / 3–19 人） | 条件隐藏领奖台；列表标题改文案；1–2 人时第 1 名**不做放大卡片**，仍按普通列表行显示 | 放大卡片版式 |
| 邀请入口（X02） | 一行文字 + 一个 `button`；目前小程序**没有群页面和群服务**（`miniprogram/pages`、`services` 下均无），点击先 `wx.showToast`「群功能即将开放」，并保留跳转位置的 `TODO` | 群创建/加入页（另行开发） |
| 无群未解锁入口（X03） | 范围入口里一个普通 `button`「我的群（创建或加入后解锁）」，点击同上 toast；**不发出 `scope=group` 请求** | 锁图标、引导页 |
| 游客占位（X13） | 一个全宽灰色 `view` + 居中一行「请登录查看榜单」；**先不做模糊效果**；不发榜单请求 | 条纹模糊占位 |
| 标签显隐（X14） | 沿用现有标签按钮，仅按 `available_boards` 条件渲染；不动现有按钮样式 | 标签视觉 |
| 周选择器（X16） | `picker` 或一排现有样式的 `button`，选项来自 `weekOptions` | 选择器视觉 |
| 赛季选择（Z14） | 同周选择器，选项来自 `available_level_seasons`；仅 1 项时不渲染 | 选择器视觉 |
| 「等待最终确认」（X15） | 赛季榜顶部一行文字（`is_provisional=true` 时） | 标签 / 徽标 |
| 更新时间（X05） | 榜单顶部一行文字 | 版式 |
| 首赛季 / 赛季初提示（X08、X09） | 榜单顶部一行文字 | 提示条样式 |
| 赛季个人回顾（X07） | 一行文字（「上赛季你拿了 X 分，最高到 Lv N」） | 回顾卡 |
| 不能选上线前的周（X16） | 仅靠 `weekOptions` 不列出；服务端 422 兜底 | — |
| 比赛页默认联赛（X11） | 纯逻辑，不涉及新 UI | — |
| 最近预测回看 ≥ 8 周（X12） | 在现有 `my-predictions` 页补**翻页逻辑**（持续用 `next_cursor` 拉取直到超过 8 周或 `has_more=false`）；不改列表样式 | 分组标题样式 |

### 10.4 实施约束

- **先看现有页面再动手**：`miniprogram/pages/rankings/*`、`miniprogram/services/rankings.js`、`pages/profile/*` 当前在工作区有未提交的改动（见 `git status`），改之前先确认不会覆盖；每个占位块独立成片，改动要小、可单独撤销。
- **每个占位块出现的条件必须在测试里有对应用例**（视图模型层断言「什么条件下 `emptyKind` / `showPodium` / `notices` 是什么」）；常态用例必须断言**新增块全部不出现**，以证明不会影响现有页面。
- **不得删除或改名现有页面元素**（按钮、数据绑定名、已有 class），只追加。
- 占位 `wxss` 只允许在 `ui-placeholder` 类下写不超过几行的基础排版（字号、居中、内边距）；不得改全局样式、不得改 `styles/design-tokens.wxss`。
- 小程序没有的能力（群页面、群服务、游客登录入口）：**不为占位新建完整页面**，用 toast 或不渲染入口，并在代码里留 `TODO(UI-v2)`。

### 10.5 与后端的边界

| 项 | 要求 |
|---|---|
| 接口与字段 | 严格按规范 §27.1 与本文 §2.6、§7.9、§8 实现，字段齐全、类型准确，**不因占位而省略** |
| 校验 | 完整保留（`period_key` 窗口、`level_season_id` 格式、群范围限制、鉴权 401/409） |
| 测试 | 后端测试清单（§5、§7.10、§8.3）全部要写，不降标 |
| 数据 | 不返回、不写入任何 mock / 演示数据；游客占位的灰色条是前端静态元素，不来自接口 |
| 兼容 | 新字段缺失时客户端降级为现有行为（§7.9），**这是前端容错，不是后端可以少返回字段的理由** |

### 10.6 对切片的影响

- S6（赛季榜小程序）、S8（冷启动小程序）、§8 的 Z14 按本节的「占位清单」实现；验收标准是**功能与逻辑正确 + 常态页面不变**，不要求视觉。
- S9（设计稿）完成后，另起一个切片 **S12：用设计稿替换占位**，只改 `wxml` / `wxss` 与文案文件，不改视图模型层与后端。
