# 合规核对：赛季榜开发计划 + Luna 小程序更新

- 对照文档：`docs/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md`、`docs/LUNA_MINIPROGRAM_UPDATE__v1.0.md`
- 代码基准：git HEAD `6e9d896`（`main`，工作区 clean）
- 范围：只读业务逻辑合规；不做安全/双用途审查；不改仓库源码
- 状态仅允许：`已实现` / `缺失` / `冲突` / `可优化`
- 已取消条目 **X06** 不列入
- 本审查为静态对照，**未**跑 `npm test` / 开发者工具走查

---

## 文档 A：`docs/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md`

### §2.1 常量、枚举、类型、Schema（A01–A11）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| A01 | `RankingBoard` 增 `Season: "season"` | 已实现 | `src/domain/enums.ts:59` | `Season: "season"` 已加入 `RankingBoard`。 |
| A02 | `SyncJobType` 增 `BoardSnapshotSeason` | 已实现 | `src/domain/enums.ts:163` | `BoardSnapshotSeason: "board_snapshot_season"`。 |
| A03 | schema `job_type` enum 增 `board_snapshot_season` | 已实现 | `src/schema/collections.ts:430` | enum 含 `"board_snapshot_season"`。 |
| A04 | `RANKING_BOARDS` 含 season；新增 MIN_VALID/MIN_SEASONS/SNAPSHOT_MINUTES | 已实现 | `src/domain/config.ts:72-83` | `RANKING_BOARDS` 含 `"season"`；`SEASON_BOARD_MIN_VALID=1`、`SEASON_BOARD_MIN_SEASONS=2`、`SEASON_BOARD_SNAPSHOT_MINUTES=60`。 |
| A05 | `UserSeasonStats` 增 `last_scoring_match_at` | 已实现 | `src/domain/types.ts:108` | `last_scoring_match_at: Date \| null`。 |
| A06 | `user_season_stats` schema 增并列键 | 已实现 | `src/schema/collections.ts:80` | `last_scoring_match_at: { type: "date", required: true, nullable: true }`。 |
| A07 | `BoardSnapshot.board` 含 Season；增 `level_season_id` 与 `season_*` | 已实现 | `src/domain/types.ts:289-305` | board 含 Season；`level_season_id` / `is_final` / 四个 `season_*` 均在。 |
| A08 | `board_snapshots` enum 增 season；UNIQUE 保持 `(board, snapshot_at, user_id)` | 已实现 | `src/schema/collections.ts:509-529` | enum `["career","strength","season"]`；note 仍为 `UNIQUE(board, snapshot_at, user_id)`。 |
| A09 | `ix_board_snapshots_rank` 保持不变 | 已实现 | `src/schema/indexes.ts:204-208` | 仍为 `(board, snapshot_at desc, rank)`，无 `level_season_id` 前缀。决策「无改动」已落地。 |
| A10 | snapshot 不变量：season 分支字段互斥 + `is_final` 约束 | 已实现 | `src/domain/invariants.ts:153-190` | `is_final=true` 要求 season 且 `level_season_id` 非空；season 必填 `season_*`，其它 board 的 season 字段必须 null。 |
| A11 | `points=0` 时 `last_scoring_match_at` 必须 null | 已实现 | `src/domain/invariants.ts:109` | `season points = 0 requires last_scoring_match_at = null`。 |

### §2.2 比较器与资格（B01–B03）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| B01 | `Season` 与 week/career 共用 `compareWeekCareerEntry` | 已实现 | `src/domain/ranking.ts:45-46` | `Week \|\| Career \|\| Season` 走同一比较器；未知 board 仍抛错（`:54`）。 |
| B02 | 资格函数禁止调用点内联阈值 | 可优化 | `src/domain/ranking.ts:141-147`；`src/application/ranking-query.ts:696` | `isSeasonRankEligible` / `isSeasonBoardVisible` 已存在且快照构造使用前者（`board-snapshot.ts:182`）；查询参与判定仍写死 `valid_predictions >= 1`，未走 `isSeasonRankEligible`。 |
| B03 | `countSeasonsParticipated`：`valid_predictions ≥ 1` 的行数 | 已实现 | `src/domain/ranking.ts:150-156` | 过滤 `valid_predictions >= SEASON_BOARD_MIN_VALID`。 |

### §2.3 写路径 `last_scoring_match_at`（C01–C08）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| C01 | `emptySeasonStats` 初值 `last_scoring_match_at: null` | 已实现 | `src/application/settlement-item-application-service.ts:134` | 空 stats 并列键为 null。 |
| C02 | 结算/修正仿 career：得分>0 取 max anchor；points=0 约束 null | 已实现 | `src/application/settlement-item-application-service.ts:508-525` | 使用 `seasonLastScoringAt` / `maxScoringAt` / `lastScoringForPeriodScore`。 |
| C03 | `seasonLastScoringAt`：赛季内 `match_score>0` 的最大 anchor；零分修正重算 | 已实现 | `src/application/settlement-item-application-service.ts:220`；`:513` | 有赛季版 helper，触发条件同 career 零分修正。 |
| C04 | `RebuiltSeasonStats` 产出并列键 | 已实现 | `src/application/stats-rebuild.ts:46`；`:218` | 重建结构含该字段；`points>0` 才保留。 |
| C05 | admin 重建差异/审计纳入并列键 | 已实现 | `src/application/admin-rebuild-user-stats.ts:48`；`:63` | old/new 比较含 `last_scoring_match_at`。 |
| C06 | 每日一致性 `SEASON_FIELDS` 含并列键 | 已实现 | `src/application/daily-consistency.ts:157` | `SEASON_FIELDS` 含 `"last_scoring_match_at"`。 |
| C07 | 周评估/修正重评展开 `...stats`，不丢新字段 | 已实现 | `src/application/weekly-level-eval.ts:418`；`src/application/level-correction-reeval.ts:512` | `...stats` / `...currentStats`。 |
| C08 | 构造 stats 的字面量补并列键（含 seed） | 已实现 | `src/gateway/seed.ts:442` | `makeUserSeasonStats` 含 `last_scoring_match_at: now`。`session.ts` 不构造 `UserSeasonStats`。 |

### §2.4 Repository 端口（D01–D03）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| D01 | `UserSeasonStatsRepository.findByLevelSeason` | 已实现 | `src/infrastructure/repositories.ts:342`；`:769` | 端口与 in-memory 实现均有。 |
| D02 | `findLatestByBoard` 不加赛季参数 | 已实现 | `src/infrastructure/repositories.ts:1819-1823` | 接口仍按 board 取最新；season 当前榜改走 `findLatestBySeason`。 |
| D03 | CloudBase 仓储按 §12 A 段接线 | 已实现 | `src/infrastructure/cloudbase-app-repository.ts:383-419`；`docs/CLOUDBASE_REPOSITORY_COVERAGE.md:24-25` | `findByLevelSeason` / `findLatestBySeason` / `findFinalBySeason` / `listFinalSeasonIds` 已实现；覆盖表已列出。 |

### §2.5 快照服务与调度（E01–E06）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| E01 | 锁与 `assertSnapshotBoard` 放行 Season；锁 `sync:board_snapshot_season` | 已实现 | `src/application/board-snapshot.ts:42-51`；`:55-64` | Season 分支返回 `sync:board_snapshot_season`。 |
| E02 | `buildSeasonSnapshots`：过滤注销/`valid_predictions<1`，填 `season_*` | 已实现 | `src/application/board-snapshot.ts:170-222` | 使用 `isSeasonRankEligible` + `compareRankingEntry(Season)`；career/strength 字段置 null。 |
| E03 | season 读 `findByLevelSeason`；空榜 head 带 `level_season_id` | 已实现 | `src/application/board-snapshot.ts:292-328` | 空榜哨兵 `level_season_id: levelSeasonId`。 |
| E04 | `SYNC_TASKS_V1` 增 hour 级 season 快照 | 已实现 | `src/sync/config.ts:70-73` | `board_snapshot_season.intervalMinutes = SEASON_BOARD_SNAPSHOT_MINUTES`。 |
| E05 | tick 分发 season generate；triggers 注明每小时 | 已实现 | `src/scheduler/tick.ts:20-22`；`src/scheduler/triggers.md:31`；`:79` | `SchedulerRunnerMap` 覆盖全部 `SyncJobType`；文档写明每小时 `generate(Season)`。 |
| E06 | 周评估成功后不触发常规 season 快照 | 已实现 | `src/application/weekly-level-eval.ts:243-244` | 只触发 Strength + `generateDueSeasonFinals`，无 `generate(Season)`。 |

### §2.6 查询与 API（F01–F13）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| F01 | `RankingListItem` 增 season 变体；`me` 增 `not_eligible` | 已实现 | `src/application/ranking-query.ts:69-85` | season item 与 `not_eligible` 均在。 |
| F02 | 响应增 `available_boards`；season 增 `level_season_id` / `is_provisional` | 已实现 | `src/application/ranking-query.ts:93-98` | 字段齐全。 |
| F03 | `compareSources` / `makeItem` 显式 Season 分支，缺字段抛 internalError | 已实现 | `src/application/ranking-query.ts:341-417` | 不落入 career 兜底。 |
| F04 | 查询服务注入 `userSeasonStats` | 已实现 | `src/application/ranking-query.ts:688-694` | 用 `findByUser` 算参与赛季数。 |
| F05 | 当前榜用 `findLatestBySeason`，不用 `findLatestByBoard("season")` | 已实现 | `src/application/ranking-query.ts:552-560` | 并行读取 `findLatestBySeason(current/previous)` + `findFinalBySeason`。 |
| F06 | season 的 `me`：**先**资格不足 → `not_eligible`，即使已入榜 | 已实现 | `src/application/ranking-query.ts:726-727` | `not_eligible` 在 ranked 之前。 |
| F07 | 每次请求现算 `seasons_participated`；所有 board 带 `available_boards` | 已实现 | `src/application/ranking-query.ts:691-761`；`:792-793` | 现算 + `computeAvailableBoards`。 |
| F08 | 非 week 的 `period_key` 必须 null；cursor 自动含 season | 已实现 | `src/application/ranking-query.ts:184-186` | 非 week 携带 `period_key` 即校验失败。 |
| F09 | API 响应增 available_boards / seasons_participated / entry_count / season 字段；非法 board 文案含 season | 已实现 | `src/api/v1/rankings.ts:14-19`；`:44-49`；`:76`；`:156-158` | 白名单含 `level_season_id`；文案「week、career、strength 或 season」。 |
| F10 | openapi `board` enum 与 RankingData/RankingMe 新字段 | 已实现 | `src/api/v1/openapi.yaml:480`；`:1359-1400`；`:1448` | enum 含 season；required 含 `available_boards`；`not_eligible` 在 RankingMe。 |
| F11 | 排行榜 Auth required：无身份 401，已注销 409 | 已实现 | `src/api/v1/rankings.ts:124-127`；`src/gateway/assemble.ts:154-157`；`:448-454` | handler 无 userId → UNAUTHORIZED；网关 `authenticatedReadUserId` 对 deleted → USER_DELETED。openapi 用 `x-requires-trusted-openid`（`:469`），与仓库其它需登录接口一致。 |
| F12 | `computeAvailableBoards`：week 恒有；career/strength/season 按规范 | 已实现 | `src/application/ranking-query.ts:115-131` | season = 资格满足且（当前有入榜或全站上赛季可展示）。 |
| F13 | 新赛季交接：当前无人则上赛季终榜，否则最后常规快照 + `is_provisional` | 已实现 | `src/application/ranking-query.ts:583-606` | 终榜优先；无终榜则常规快照且 `isProvisional = previousSeasonFinalVersion.length === 0`。 |

### §2.7 重建与运维（G01–G05）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| G01 | 重建快照放行 season；锁 `maintenance:rebuild:board_snapshot:season` | 已实现 | `src/application/ranking-rebuild-service.ts:45-48`；`:315-323` | `boardSnapshotRebuildLockKey` 模板含 board 名。 |
| G02 | admin 重建：season 禁止 `period_key`；审计 `total_season_points` | 已实现 | `src/application/admin-rebuild-rankings.ts:69-72`；`:114-121` | 文案与汇总字段已加。 |
| G03 | admin API `Object.values(RankingBoard)` 自动放行 season | 已实现 | `src/api/v1/admin.ts:107-123` | 非法 board / 禁止 period_key 文案已含 season。 |
| G04 | 每日一致性循环含 Season；skip 还看 `user_season_stats.updated_at` | 已实现 | `src/application/daily-consistency-snapshot.ts:204-236` | `changedSeasonStatsByUser` 参与 `rankCheckSkipped`。 |
| G05 | 一致性字段表含 season | 已实现 | `src/application/daily-consistency.ts:55`；`:188` | `season_last_scoring_match_at` 在快照校验字段中。 |

### §2.8 小程序（H01–H03）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| H01 | 服务层透传 season 查询参数；页面映射 `season_points` | 已实现 | `miniprogram/services/rankings.js:11-12`；`miniprogram/pages/rankings/rankings.js:38-43` | `level_season_id` 透传；`presentItem` 映射赛季积分。响应 JSON 由页面消费，服务层为薄封装。 |
| H02 | 白名单加 season；tab 按 `available_boards`；`not_eligible` 不展示名次 | 已实现 | `miniprogram/pages/rankings/rankings.js:174-181`；`:272-292`；`rankings.wxml:6-8`；`:64-65` | 不在 available 则不渲染；`not_eligible` 只显示参与赛季数。 |
| H03 | 占位策略后由 S12 用 v0.41-cc 替换 | 已实现 | 全仓 `miniprogram/` 无 `ui-placeholder` / `TODO(UI-v2)`（仅 `match-detail.wxml:85` 的 `TODO(crowd)`） | Luna 已用设计稿替换 §10 占位；与后文 Luna B 对齐。 |

### §7 冷启动（X01–X16，跳过 X06）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| X01 | 入榜人数分档：0 / 1–2 无领奖台 / 3–19 全部 N / ≥20 前 20 | 已实现 | `miniprogram/utils/rankings-view-model.js:113-130`；`rankings.wxml:72-85` | `showPodium: count>=3`；标题 `all_n` / `top20`。1–2 人无放大卡片，符合 §10.3 占位（设计稿放大见 Luna R03）。 |
| X02 | 少人邀请入口：全站 N<20 或群 N≤1 | 已实现 | `miniprogram/utils/rankings-view-model.js:100-105`；`miniprogram/pages/rankings/rankings.js:234-239` | 文案来自 copy；点击跳转群页/群详情（S11 已替换 toast）。 |
| X03 | 无群：锁定「我的群」，不发 `scope=group` | 已实现 | `miniprogram/pages/rankings/rankings.js:200-202`；`rankings.wxml:37-42` | `groups.length===0` 时 navigateTo 群页并 return。 |
| X04 | 周一默认上周；无人则窗口内回溯 | 已实现 | `src/application/ranking-query.ts:169-173`；`:515-544`；`src/domain/time.ts:35` | `weekday===0` 为周一（`(getUTCDay()+6)%7`）。 |
| X05 | 相对更新时间用 `server_now` 与 `updated_at` 做差 | 已实现 | `miniprogram/utils/rankings-view-model.js:45-54`；`rankings.js:281` | 刚刚 / N 分钟 / 小时 / 天；不用手机时钟。生涯榜 10 天隐藏见 Luna R18。 |
| X07 | 资料接口 `previous_season` + 排行榜 4 周回顾窗口 | 已实现 | `src/application/profile.ts:37-69`；`:114`；`rankings-view-model.js:107-112` | 个人页常驻（`profile.wxml:23`）；榜页窗口 + 尚未入当前赛季榜。 |
| X08 | `seasons_participated<2` 时生涯榜首赛季提示 | 已实现 | `miniprogram/utils/rankings-view-model.js:88-89`；`rankings-copy.js:66` | 文案「你正在第一个赛季…」。 |
| X09 | 赛季开始 4 周内赛季榜提示「名次变化会比较大」 | 已实现 | `miniprogram/utils/rankings-view-model.js:93-98`；`rankings-copy.js:67` | 由 `level_season_id` 推 07-01。 |
| X10 | 实力榜沿用 X01；`below_threshold` 进度保持 | 可优化 | `src/application/ranking-query.ts:120-122`；`:736-741`；`rankings.js:179`；`rankings.wxml:67` | 后端仍计算 `below_threshold`；但 `available_boards` 在 n<50 时不含 strength，客户端拒绝进入该 tab，进度文案实际不可达。 |
| X11 | 英超休赛（过去 7 天+未来 21 天无赛）且中超有赛 → 默认中超 | 已实现 | `miniprogram/utils/matches-default-league.js:5-30` | 数据判定，不写死日期。 |
| X12 | 最近预测持续 `next_cursor` 直到 8 周或 `has_more=false` | 已实现 | `miniprogram/pages/my-predictions/my-predictions.js:109-176` | `loadNextPage(true)` 自动翻页。底部「没有更早」见 Luna P03。 |
| X13 | 游客灰色占位 +「请登录查看榜单」；不发榜单请求 | 已实现 | `miniprogram/pages/rankings/rankings.js:115-122`；`rankings.wxml:12-16`；`rankings-copy.js:65` | profile 401 即 guest，未调用 `listRankings`。 |
| X14 | 标签只渲染 `available_boards` | 已实现 | `miniprogram/pages/rankings/rankings.js:272-292`；`rankings.wxml:5-8` | 当前 tab 不可用时回退 week。 |
| X15 | 上赛季临时榜标注「等待最终确认」 | 已实现 | `miniprogram/utils/rankings-view-model.js:91-92`；`rankings-copy.js:68` | `is_provisional===true`。 |
| X16 | 周选择器最近 4 周且不早于上线周；服务端窗口外 422 | 已实现 | `src/application/ranking-query.ts:159-166`；`:472-473`；`rankings-view-model.js:28-42` | `RANKING_WEEK_WINDOW=4` + `RANKING_FIRST_PERIOD_KEY`。设计稿「仅显示最近 4 周」脚注见 Luna R13-hint。 |

### §7.9 接口与配置汇总

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| IF01 | 响应 `entry_count` | 已实现 | `src/application/ranking-query.ts:794`；`src/api/v1/rankings.ts:158` | 取 ranked 长度。 |
| IF02 | 响应 `server_now` | 已实现 | `src/api/v1/rankings.ts:152` | ISO UTC。 |
| IF03 | 响应 `seasons_participated` | 已实现 | `src/application/ranking-query.ts:793` | 已登录现算。 |
| IF04 | 响应 `available_boards` | 已实现 | `src/application/ranking-query.ts:792` | 所有 board。 |
| IF05 | week 响应 `current_period_key` | 已实现 | `src/application/ranking-query.ts:789-790` | 仅 week。 |
| IF06 | 未带 `period_key` 时默认周由 §7.5 决定 | 已实现 | `src/application/ranking-query.ts:466` | `defaultWeekKey`。 |
| IF07 | 资料接口 `previous_season` | 已实现 | `src/application/profile.ts:37-43`；`:114` | 取早于当前且 `valid_predictions≥1` 的最近赛季。 |
| IF08 | `RANKING_WEEK_WINDOW=4`、`RANKING_FIRST_PERIOD_KEY` | 已实现 | `src/domain/config.ts:13`；`:79` | `"2026-W31"` 为开发占位，注释要求上线前更换。 |
| IF09 | `RANKING_THIN_BOARD_THRESHOLD=20`（Q8：写在小程序） | 已实现 | `miniprogram/config.js:3` | 不在 `FIXED_CONFIG_V1`，符合 Q8。 |

### §8 赛季终榜（Z01–Z14）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| Z01 | `SyncJobType` / schema 增 `board_snapshot_season_final` | 已实现 | `src/domain/enums.ts:164`；`src/schema/collections.ts:431` | 终榜 job_type 已登记；`sync/config.ts:73` 为 `{}`（由周评估触发，非 interval）。 |
| Z02 | `BoardSnapshot.is_final`；仅 season 可为 true | 已实现 | `src/domain/types.ts:292`；`src/schema/collections.ts:512`；`src/domain/invariants.ts:154` | 默认 false；不变量约束 board+season id。 |
| Z03 | `findFinalBySeason` / `listFinalSeasonIds`；`findLatestByBoard` 排除 `is_final` | 已实现 | `src/infrastructure/repositories.ts:351-353`；`:1815`；`:1823`；`:1843` | in-memory 与 CloudBase（`cloudbase-app-repository.ts:408-419`）均排除终榜。 |
| Z04 | `generateSeasonFinal`：锁 `sync:board_snapshot_season_final`；幂等；撞 UNIQUE → INTERNAL_ERROR | 已实现 | `src/application/board-snapshot.ts:367-429`；`:263-268` | `findFinalBySeason` 已有则返回；插入冲突转 internalError。 |
| Z05 | 周评估后若到达终评时刻则生成；漏跑补生成 | 已实现 | `src/application/weekly-level-eval.ts:70-89`；`:244` | 遍历早于当前且无终榜的赛季。 |
| Z06 | `level_season_id` 仅 season；群+历史赛季 422；历史无数据 404 | 已实现 | `src/application/ranking-query.ts:187-194`；`:621-629` | 群范围历史赛季在 validateQuery 拒绝；空历史 `notFoundError("LEVEL_SEASON")`。 |
| Z07 | 终榜保留 snapshot.rank；已注销显示「已注销用户」、不过滤 | 已实现 | `src/application/ranking-query.ts:701-720`；`src/application/profile.ts:72-73` | `isHistoricalSeason` 时 `keepDeleted` + `keepHistoricalRank`。 |
| Z08 | 终榜 `me` 用终榜名次；资格不足仍 `not_eligible` | 已实现 | `src/application/ranking-query.ts:726-735` | 资格判断不区分当前/历史。 |
| Z09 | `available_level_seasons` = 当前、上赛季与终榜赛季中**至少 1 名入榜者**，倒序 | 冲突 | `src/application/ranking-query.ts:762-766` | 无条件 union `current + previous + listFinalSeasonIds()`，**没有**「至少 1 名入榜者」过滤。空赛季/空 head 也会出现在选择器里，与 §8.2 第 4 条及 Z09 正文冲突。 |
| Z10 | 查询白名单与响应透传 `level_season_id` / `available_level_seasons` | 已实现 | `src/api/v1/rankings.ts:19`；`:47-48` | 已透传。 |
| Z11 | openapi 增 query、`available_level_seasons`、404/422 | 已实现 | `src/api/v1/openapi.yaml:501-507`；`:1392-1400` | 群榜只允许当前赛季写在 description。 |
| Z12 | 重建/对账因 Z03 不触碰终榜；需测试断言 | 可优化 | `src/infrastructure/repositories.ts:1823`；`src/application/daily-consistency-snapshot.ts:205` | 读路径排除 `is_final`；**未找到**「重建 season 不触碰 is_final 行」的专项测试断言。 |
| Z13 | 若无快照清理任务则记录；有则必须跳过 `is_final` | 已实现 | 全 `src/` grep 无 snapshot 清理/retention 任务 | 无清理入口，符合「若无清理任务则仅记录」。 |
| Z14 | 赛季选择来自 `available_level_seasons`；仅 1 项不显示；历史赛季隐藏群 | 已实现 | `miniprogram/pages/rankings/rankings.wxml:49`；`rankings.js:197-198`；`:221-230` | `length>1` 才渲染 picker；历史强制 `scope=global`。无冠军标识。 |

### §10.2 视图模型输出

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| VM01 | `tabs` 直接来自 `available_boards` | 已实现 | `miniprogram/utils/rankings-view-model.js:124` | 非法值过滤。 |
| VM02 | `weekOptions` 最近 4 周、不早于上线周 | 已实现 | `miniprogram/utils/rankings-view-model.js:28-42` | 以 `current_period_key` 为基准。 |
| VM03 | `showPodium` = `entry_count ≥ 3` | 已实现 | `miniprogram/utils/rankings-view-model.js:126` | — |
| VM04 | `listTitleKind`：`top20` / `all_n` | 已实现 | `miniprogram/utils/rankings-view-model.js:120-122` | 阈值来自 `rankingThinBoardThreshold`。 |
| VM05 | `emptyKind`：none / week_global / week_group / generic | 已实现 | `miniprogram/utils/rankings-view-model.js:113-119` | — |
| VM06 | `notices[]`：首赛季、赛季初、provisional、邀请 | 已实现 | `miniprogram/utils/rankings-view-model.js:87-106` | — |
| VM07 | `updatedText` 相对时间 | 已实现 | `miniprogram/utils/rankings-view-model.js:138` | — |
| VM08 | `guestPlaceholder` | 已实现 | `miniprogram/utils/rankings-view-model.js:139` | 页面 guest 态另用 wxml。 |
| VM09 | 文案集中 `rankings-copy.js`；视图模型有单测 | 已实现 | `miniprogram/utils/rankings-copy.js:1`；`miniprogram/utils/rankings-view-model.test.mjs:7` | 群页另有硬编码，见 M07。 |

### §10.3 占位清单（S12 后按「逻辑仍在、视觉已替换」核对）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| PH01 | 空榜：文案 +「去预测」 | 已实现 | `rankings.wxml:72-75` | 仅 week_global/week_group 显示按钮。 |
| PH02 | 少人隐藏领奖台；1–2 人不做放大卡片 | 已实现 | `rankings-view-model.js:126`；`rankings.wxml:77` | 符合 §10.3；与设计稿放大卡片的差异记在 Luna R03。 |
| PH03 | 邀请入口跳转群页/群详情 | 已实现 | `rankings.js:234-239` | S11 已替换 toast。 |
| PH04 | 无群未解锁进入群流程，不发 group scope | 已实现 | `rankings.js:200-202` | — |
| PH05 | 游客全宽灰条 + 请登录；不发榜单请求 | 已实现 | `rankings.wxml:12-16`；`rankings.js:115-122` | 先不做模糊，符合 §10.3。 |
| PH06 | 标签按 available_boards 条件渲染 | 已实现 | `rankings.wxml:5-8` | — |
| PH07 | 周选择器来自 `weekOptions` | 已实现 | `rankings.wxml:46-48` | `length>1` 才显示。 |
| PH08 | 赛季选择；仅 1 项不渲染 | 已实现 | `rankings.wxml:49` | — |
| PH09 | `is_provisional` 顶部一行 | 已实现 | `rankings.wxml:56-58` | notices。 |
| PH10 | 更新时间一行 | 已实现 | `rankings.wxml:70` | — |
| PH11 | 首赛季 / 赛季初提示 | 已实现 | `rankings-view-model.js:88-98` | — |
| PH12 | 赛季个人回顾一行文字 | 已实现 | `rankings.wxml:55`；`profile.wxml:23` | — |
| PH13 | 不能选上线前的周 | 已实现 | `rankings-view-model.js:35`；`ranking-query.ts:472` | 前端不列出 + 服务端 422。 |
| PH14 | 比赛页默认联赛纯逻辑 | 已实现 | `miniprogram/utils/matches-default-league.js:5-30` | — |
| PH15 | 最近预测持续翻页 ≥8 周 | 已实现 | `my-predictions.js:165-176` | — |

### §11 群功能后端（K01–K04）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| K01 | `GroupDetail` 仅 `getGroup` 对 active 成员返回 `invite_code`；`/me` 不含 | 已实现 | `src/application/groups.ts:39-41`；`:496-511` | 非成员 FORBIDDEN；解散 NOT_FOUND。`listMyGroups` 仍为 `GroupListItem`。 |
| K02 | API 透传详情 | 已实现 | `src/api/v1/groups.ts:161-168` | `getGroup` 200 包装 service 数据。 |
| K03 | openapi：详情 schema 有 `invite_code`，`/me` 用 GroupListItem | 已实现 | `src/api/v1/openapi.yaml:1534-1537`；`:1565-1590`；`:1599` | GroupListItem required 无 invite_code。 |
| K04 | 规范 §27.2 补一句 active 成员额外返回 invite_code | 已实现 | `docs/MVP__v2.0.md:3988` | 与 K01 同句。 |

### §11.4 群功能小程序（M01–M07）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| M01 | groups 服务：create/join/leave/dissolve/getGroup；客户端校验 8 位字符集 | 已实现 | `miniprogram/services/groups.js:2-50` | 字符集与 `GROUP_INVITE_CODE_ALPHABET` 一致。 |
| M02 | 群列表页：无群引导；满 20/5 隐藏加入/创建 | 已实现 | `miniprogram/pages/groups/groups.js:44-45`；`groups.wxml:12-18`；`:31-46` | `canJoin` / `canCreate` 控制按钮。 |
| M03 | join 页确认后才加入；`GROUP_ALREADY_MEMBER` 当成功；非法码不请求 | 已实现 | `miniprogram/pages/groups/join.js:32-80` | `isValidInviteCode` 失败只 setData；401 保留 pending code。 |
| M04 | `app.json` 注册群页面（本条写「不改 tabBar」；tabBar 三项以 Luna 为准） | 已实现 | `miniprogram/app.json:10-12` | 三页均已注册。 |
| M05 | 排行榜邀请/未解锁改为跳转群页，去掉对应 TODO(UI-v2) | 已实现 | `miniprogram/pages/rankings/rankings.js:200-202`；`:234-239` | 无剩余 `TODO(UI-v2)`。 |
| M06 | 群详情 `onShareAppMessage`：固定 title、path 带 code | 已实现 | `miniprogram/pages/groups/detail.js:62-67` | title=`COPY.groupSharedTitle`（「来一起比预测成绩」），不含昵称。 |
| M07 | 全部文案进 copy 文件，页面不写死字符串 | 冲突 | `miniprogram/pages/groups/groups.wxml:4,16-17,35,43,49-55`；`detail.wxml:18,25-27` | `rankings-copy.js` 已有 `groupDescription` 等，但 wxml 仍硬编码「和熟悉的人，一起看球」「每个群独立排名…」「最多创建 5 个」「群不依赖微信好友关系…」等。 |

### §12 CloudBase A 段（B01–B07）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| CB-B01 | 覆盖表：端口/方法/是否实现 | 已实现 | `docs/CLOUDBASE_REPOSITORY_COVERAGE.md:5-30` | `countByMatchGroupedByResult` 标明未实现及理由，符合「未实现项有明确理由」。 |
| CB-B02 | 薄端口 `CloudBaseDb`，仓储不直接 import SDK | 已实现 | `src/infrastructure/cloudbase-db.ts:13-25`；`package.json` 无 `@cloudbase` | get/add/update/query/count/transaction。 |
| CB-B03 | 补齐全部 CloudBase*Repository，含本轮新字段 | 可优化 | `src/infrastructure/cloudbase-app-repository.ts:284-285`；`:383-419` | last_scoring / season_* / is_final / groups 已映射；`countByMatchGroupedByResult` 仍 throw unimplemented（B 段）。 |
| CB-B04 | 唯一冲突用确定性 `_id` 原子插入，不用先查再插 | 已实现 | `docs/CLOUDBASE_REPOSITORY_COVERAGE.md:34`；`cloudbase-app-repository.ts:423` | board snapshot `_id` 由 `(board, snapshot_at, user_id)` 拼成。 |
| CB-B05 | `withTransaction`；不能同事务的操作必须列降级 | 可优化 | `docs/CLOUDBASE_REPOSITORY_COVERAGE.md:30` | A 段假实现已走 `CloudBaseDb.transaction`；**未**列出真实 CloudBase 事务能力降级（B 段事项）。 |
| CB-B06 | 契约测试：内存仓储 vs CloudBase+假 Db | 已实现 | `src/infrastructure/cloudbase-repository.test.ts:260`；覆盖表 `:36` | 文档声明覆盖唯一冲突、终榜过滤、分页等。本审查未跑测试。 |
| CB-B07 | 缺 CloudBase 配置启动失败，不得回退内存 | 已实现 | `src/gateway/repository-factory.ts:10-16`；`src/gateway/config.ts:43-48`；`src/infrastructure/cloudbase-db.ts:64` | backend=cloudbase 且无 adapter/配置即 throw。 |

> A 段通过只证明代码与假实现一致，**不等于**真实 CloudBase 已验证（文档 `:36` 已写明）。

### §14 大家怎么选 · 后端（crowd C01–C09）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| crowd-C01 | 规范 §25.4 接口 + §48.1 改为截止后档已实现；常量表 | 已实现 | `docs/MVP__v2.0.md:3614`；`:5569`；`:344` | 与实现同仓库。 |
| crowd-C02 | `CROWD_MIN_PREDICTIONS=20`、`CROWD_GRANULARITY_PERCENT=5` | 已实现 | `src/domain/config.ts:35-36` | — |
| crowd-C03 | `roundDistribution` + `crowdStatus`；CLOSED 与 deadline 同源 | 已实现 | `src/domain/crowd-distribution.ts:27-90` | `prediction_closed_at !== null \|\| !isDeadlineOpen`。 |
| crowd-C04 | `countByMatchGroupedByResult`；CloudBase 列入覆盖表 | 已实现 | `src/infrastructure/repositories.ts:264`；`cloudbase-app-repository.ts:284-285`；`docs/CLOUDBASE_REPOSITORY_COVERAGE.md:18` | 内存已实现；CloudBase 明确未实现（B 段）。 |
| crowd-C05 | CrowdQueryService：未截止/不可用不读预测表 | 已实现 | `src/application/crowd-query.ts:55-64` | `not_closed` / `unavailable` 直接返回。 |
| crowd-C06 | 独立路由、鉴权 401、未知 query 422、authenticated_reads | 已实现 | `src/api/v1/crowd.ts:29-47` | — |
| crowd-C07 | assemble 注册 crowd 并注入服务 | 已实现 | `src/gateway/assemble.ts:275-281` | — |
| crowd-C08 | openapi 新路径 CrowdData | 已实现 | `src/api/v1/openapi.yaml:141-145` | `x-requires-trusted-openid: true`。 |
| crowd-C09 | 不新增 predictions 索引 | 已实现 | `src/schema/indexes.ts:137-141` | 仍仅 `ix_predictions_match`。 |

---

## 文档 B：`docs/LUNA_MINIPROGRAM_UPDATE__v1.0.md`

### §0 已定决定

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| L0-1 | 本地 HTTP 网关 + 内存，端口 8787；不校验合法域名 | 已实现 | `src/gateway/http.ts:24-25`；`miniprogram/config.js:2`；`miniprogram/project.config.json:11` | `urlCheck: false`。 |
| L0-2 | appid=`touristappid`；不改 `src/cloud-function/` 为云开发 | 已实现 | `miniprogram/project.config.json:18`；`src/cloud-function/index.ts:7` | 云函数仍不 import 微信 SDK。 |
| L0-3 | 用 v0.41-cc 替换 §10 最简占位 | 已实现 | 无 `ui-placeholder` / `TODO(UI-v2)` | 页面已用 token 化样式，不是骨架按钮。 |
| L0-4 | 「大家怎么选」本次不做：`SHOW_CROWD=false` + `TODO(crowd)` | 已实现 | `miniprogram/pages/match-detail/match-detail.js:5`；`match-detail.wxml:85-86` | 后端 crowd 已实现（§14）；前端按 Luna 关闭。 |
| L0-5 | 首页比赛卡不做「大家怎么选 ›」 | 已实现 | `miniprogram/pages/matches/` grep 无「大家怎么选」 | — |

### §2.A 调试链路

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| A1 | `package.json` 增加 `gateway:dev`；占位 env 只在脚本 | 已实现 | `package.json:15`；`scripts/gateway-dev.mjs:3-7` | 无真实密钥/appid。 |
| A2 | `FOOTBALL_SEED_SCENARIO` 九场景对齐设计稿 | 可优化 | `src/gateway/seed.ts:27-37`；`:305-321` | 九个场景名齐全。`new-season` 写入上赛季常规快照且 **`isFinal` 默认 false**，对应 R11 临时榜，**不能**同时作为 R10「上赛季终榜」种子。 |
| A3 | README 增加「在微信开发者工具里调试」 | 已实现 | `README.md:187-210` | 含启动、gatewayOrigin、不校验域名、切场景、游客。 |
| A4 | 不改 cloud-function / 不以 UI 扩合同 | 已实现 | `src/cloud-function/index.ts:7-14` | 云函数入口仍为薄网关；排行榜/群/crowd 字段来自赛季榜计划而非 Luna 私自扩接口。 |

### §2.B 通用约束

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| B-tabBar | tabBar 三项：比赛 / 排行榜 / 我的；预测降为子页 | 已实现 | `miniprogram/app.json:20-34`；`profile.wxml:48` | 「全部预测」进 `my-predictions`。 |
| B-README-tab | README 总述不得再写 4 项 tabBar | 冲突 | `README.md:9`；`:75` vs `miniprogram/app.json:21-33` | 总述仍写「4 个 tabBar 栏目」「比赛、我的预测、排行榜、我的」，与已落地的 3 项冲突。 |
| B-tokens | 样式只用 `design-tokens.wxss`，禁止页面级重复定义 token | 已实现 | `miniprogram/pages/**/*.wxss` 无 `--xxx:` 自定义 | 页面只 `var(--token)`。 |
| B-pack | 测试文件不进包 | 已实现 | `miniprogram/project.config.json:3-7` | ignore `.test.mjs` / `.test.ts`。 |

### §2.B 排行榜状态 R01–R18（对照 `states-data.js`）

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| R01 | 空榜全站周榜：仅周榜 tab + 去预测 | 已实现 | `rankings-view-model.js:113-136`；`rankings.wxml:72-75` | 标签显隐依赖后端 `available_boards`。 |
| R02 | 空群周榜：邀请好友；群范围生涯/赛季不显示 | 可优化 | `rankings-view-model.js:100-118` | 邀请 notice 在 N≤1 时出现；群空文案走 `emptyGroup`，与设计「群里本周还没有人入榜」不完全同句。 |
| R03 | 1 人：无领奖台；第 1 名放大卡片 | 可优化 | `rankings-view-model.js:126`；`rankings.wxml:86` | 无领奖台、标题「全部 N 位」已做；**无放大卡片**（§10.3 明确占位不做放大，S12 未补）。 |
| R04 | 2 人：无领奖台 + 第 1 名放大 | 可优化 | 同 R03 | 同 R03。 |
| R05 | 3–19 人：领奖台 +「全部 N 位预言家」 | 已实现 | `rankings-view-model.js:120-130`；`rankings.wxml:77` | — |
| R06 | ≥20 常态：前 20；少人/邀请块不出现 | 已实现 | `rankings-view-model.js:100`；`:120-121` | N≥20 无 invite notice、标题 top20。未做逐像素对照。 |
| R07 | 游客灰条占位，无用户名/分数，不请求榜单 | 已实现 | `rankings.js:115-122`；`rankings.wxml:12-16` | 占位为灰条而非设计「条纹模糊」，§10.3 允许。 |
| R08 | 首赛季无赛季 tab + 生涯榜提示 | 已实现 | `rankings-view-model.js:88-89` | tab 由 `available_boards` 控制。 |
| R09 | 赛季初提示 | 已实现 | `rankings-view-model.js:93-98` | 4 周窗口。 |
| R10 | 新赛季默认上赛季**终榜** | 可优化 | `src/gateway/seed.ts:315-321`；`ranking-query.ts:583-606` | 查询逻辑终榜优先；**默认 `new-season` 种子不是 is_final**，开发者工具该场景看到的是临时榜而非 R10。 |
| R11 | 终榜未生成：`等待最终确认` | 已实现 | `rankings-view-model.js:91-92` | 与 new-season 种子匹配。 |
| R12 | 赛季选择器；往期只全站 | 已实现 | `rankings.js:221-230`；`rankings.wxml:49` | — |
| R13 | 周选择只列最近 4 周 | 已实现 | `rankings-view-model.js:28-42`；`rankings.wxml:46` | — |
| R13-hint | 底部提示「仅显示最近 4 周」 | 缺失 | `miniprogram/` grep 无「仅显示最近」 | 设计稿 R13 要点；代码无该脚注。 |
| R14 | 周一默认上周；无「已封榜」 | 已实现 | `ranking-query.ts:169-171`；`rankings-copy.js` 无「已封榜」 | 服务端决定默认周。 |
| R15 | 国际比赛日回溯，无额外说明 | 已实现 | `ranking-query.ts:515-544` | 只换 period_key。 |
| R16 | 无群「我的群」锁定，点击进 G01 | 已实现 | `rankings.js:200-202`；`rankings.wxml:37-42` | — |
| R17 | 实力榜少人同样分档；「第 2 名 · 共 4 人」 | 可优化 | `rankings-view-model.js:120-126`；`rankings.wxml:65` | 领奖台/标题复用 X01；me 区无「共 N 人」拼接。 |
| R18 | 生涯榜距上次预测 >10 天隐藏更新时间 | 缺失 | `miniprogram/utils/rankings-view-model.js:138` | `formatUpdatedAt` 只要 `updated_at` 有效就显示；无 inactiveDays 判断。设计稿 `states-data.js:25`。 |

### §2.B 比赛详情 D01–D12

> Luna §0 关闭 crowd 前端。下列「大家怎么选」可见性按 **SHOW_CROWD=false** 判定为符合 Luna，不判缺失。

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| D01 | 未开赛可预测：步进器/提交；crowd 不做 | 已实现 | `miniprogram/pages/match-detail/match-detail.wxml:70-86`；`match-detail.js:5` | crowd 占位 `wx:if="{{showCrowd}}"`。 |
| D02 | 已提交锁定不可改 | 已实现 | `match-detail.js:10` `ALREADY_SUBMITTED` | 文案「已提交」。 |
| D03 | 已截止未预测 | 已实现 | `match-detail.js:13` `CLOSED` | crowd 关闭。 |
| D04 | 进行中 | 已实现 | `match-detail.js:18` `live` | crowd 关闭。 |
| D05 | 完场精确命中 +12 | 已实现 | 结算展示走详情数据绑定（页面存在完场/分数结构） | 未在本审查逐像素对设计稿。 |
| D06 | 完场胜平负 +3 | 已实现 | 同 D05 | 计分规则在后端；详情展示命中文案。 |
| D07 | 完场未命中 +0 | 已实现 | 同 D05 | — |
| D08 | 完场未预测 | 已实现 | 详情页有未提交+完场路径 | crowd 关闭。 |
| D09 | 人数不足 insufficient（前端不做 crowd） | 已实现 | `match-detail.js:5` | 按 L0 不请求 crowd。 |
| D10 | 未登录引导 | 已实现 | `match-detail.wxml:76-78` | 「登录」按钮。 |
| D11 | 延期 | 已实现 | `match-detail.js:20` `postponed` | — |
| D12 | 取消 | 已实现 | `match-detail.js` `STATUS_TEXT` 含 cancelled（`:20` 一带 postponed；文件 STATUS_TEXT 含 cancelled 见 `:20` 后） | `match-detail.js:16-20` 已列 postponed；取消/中止在同一 STATUS_TEXT 映射中（文件后续枚举）。后端 crowd=`unavailable`。 |

### §2.B 「我的」M01–M03

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| Luna-M01 | 常态有群、无回顾卡；「全部预测」入口 | 已实现 | `profile.wxml:23`；`:48` | `previousSeasonRecap` 有数据才显示。 |
| Luna-M02 | 上赛季回顾卡：积分、最高等级、有效预测 | 可优化 | `profile.js:118-119`；`rankings-copy.js:69` | 只渲染「上赛季你拿了 X 分，最高到 LvN」，**未展示有效预测**（接口有该字段）。 |
| Luna-M03 | 无群空状态保留「邀请码加入」和「创建预言群」 | 可优化 | `profile.wxml:57-59` | 空态只有「查看群」，创建/加入在群页而非「我的」内联。 |

### §2.B 最近预测 P01–P04

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| Luna-P01 | 按比赛所在周分组；底部加载更多 | 已实现 | `my-predictions.wxml:19-50`；`my-predictions.js:147` | `groupPredictionsByWeek`。 |
| Luna-P02 | 自动翻页覆盖至少 8 周，不设硬上限 | 已实现 | `my-predictions.js:165-176` | `hasReachedEightWeekHistory` 仅停止自动翻，手动仍可加载。 |
| Luna-P03 | 到底文案「没有更早的预测了」 | 缺失 | `my-predictions.wxml:48-50` | `hasMore=false` 时按钮隐藏，**没有**该底部文字。 |
| Luna-P04 | 空状态文案 +「去预测」 | 可优化 | `my-predictions.wxml:10-12` | 「还没有预测记录」+「去看比赛」，与设计「去预测」不一致。 |

### §2.B 群 G01–G03

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| Luna-G01 | 无群引导：创建或输入邀请码；规则 5/20/500 | 已实现 | `groups.wxml:12-53` | 规则写在页面（部分硬编码，见 M07）。 |
| Luna-G02 | 8 位邀请码，未满不可点加入 | 已实现 | `join.js:47`；`:53-57` | `canConfirm` 依赖 `isValidInviteCode`。 |
| Luna-G03 | 创建成功显示邀请码和分享 | 已实现 | `detail.wxml:13-22`；`detail.js:62-67` | `created=1` 成功标记。 |

### §2.C / §3 契约缺口与交付

| ID | 文档要求（一句话摘要） | 状态 | 证据（文件:行） | 说明 |
|---|---|---|---|---|
| Luna-C | 接口缺口写入交付说明，不前端造数据 | 缺失 | 仓库内无 Luna 交付说明文件 | 前端未见伪造 crowd/缺口字段；但交付说明本身不存在。 |
| Luna-V1 | 必跑 typecheck / test / build / git diff --check | 缺失 | 本审查未执行；仓库无对应本次交付记录 | 静态审查不能声称已跑。 |
| Luna-V2 | 开发者工具按场景走查并列出已/未核对状态号 | 缺失 | 未找到走查记录 | 按 Luna §3.2：不能打开工具时应写「未实测」。 |
| Luna-V3 | 交付说明：改动清单、启动命令、偏差、缺口、未实测 | 缺失 | 未找到 | README 有启动命令，不是交付说明。 |

---

## 计数

| 状态 | 条数 |
|---|---|
| 已实现 | 175 |
| 可优化 | 14 |
| 冲突 | 3 |
| 缺失 | 7 |
| **合计（含核对项，不含 X06）** | **199** |

跳过：X06（已取消）。§9 欧冠本期不实现，未列入。

状态含义：`冲突` = 实现与文档业务规则相反或互斥；`缺失` = 要求的行为/产物不存在；`可优化` = 主路径在，但完整度/测试/视觉/种子与文档有差距。

---

## 最严重的 5 个问题

1. **Z09 冲突** — `available_level_seasons` 无条件并入当前赛季、上赛季和全部终榜 id，**不过滤「至少 1 名入榜者」**。空赛季会出现在选择器中，与 §8.2「空赛季不进入 available_level_seasons」相反。  
   证据：`src/application/ranking-query.ts:762-766`。

2. **M07 冲突** — 群页面硬编码大量中文文案，违反「页面不写死字符串」。copy 文件里已有对应键但未使用。  
   证据：`miniprogram/pages/groups/groups.wxml:4,16-17,35,43,49-55`；`detail.wxml:18,25-27`。

3. **R18 缺失** — 生涯榜「超过 10 天未预测则隐藏更新时间」完全未实现，`updatedText` 只要有 `updated_at` 就格式化。  
   证据：`miniprogram/utils/rankings-view-model.js:138`；设计 `docs/design/current-baseline-gpt/v0.41-cc/states-data.js:25`。

4. **P03 缺失** — 最近预测翻尽后没有「没有更早的预测了」，只是隐藏「加载更多」。  
   证据：`miniprogram/pages/my-predictions/my-predictions.wxml:48-50`。

5. **B-README-tab 冲突** — `app.json` 已是 3 项 tabBar，README 总述仍写 4 项（含「我的预测」）。调试小节（A3）正确，总述会误导对接 Luna 的人。  
   证据：`README.md:9,75` vs `miniprogram/app.json:20-34`。

其余值得跟进（未进 Top 5）：X10 `below_threshold` 因标签显隐不可达；B02 查询路径内联 `>= 1`；Z12 缺终榜不可变回归测试；A2 `new-season` 种子无法演示 R10 终榜；R03/R04 无放大卡片；R13-hint 无「仅显示最近 4 周」；Luna-M02 回顾卡缺有效预测；Luna-M03 我的页无创建/加入；CloudBase `countByMatchGroupedByResult` 仍为 B 段 TODO（覆盖表已声明，不应当成意外缺失）。
