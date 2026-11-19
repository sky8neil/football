# 上线前问题修复可执行开发文档（AI 落地指南）

- **文档版本**：v1.0（2026-11-19）
- **基线提交**：`8e37d49`
- **需求来源**：[PRE_LAUNCH_CONSOLIDATED_REVIEW__v1.0.md](PRE_LAUNCH_CONSOLIDATED_REVIEW__v1.0.md)
- **目标读者**：直接执行代码修改的 AI Coding Agent / 开发者

---

## 0. 执行前必读：人工确认门禁与开发纪律

### 0.1 上线日期相关参数：改为运行时环境变量（无需现在定死上线周）

为避免上线日期变动导致重新改代码或重新提审小程序，以下 **2 项** 不在代码里写死上线日期，改为**环境变量 + 启动校验**，全部 7 个切片现在即可直接开发：

| 环境变量 | 格式与校验要求 | 生效行为 | 影响切片 |
| --- | --- | --- | --- |
| `FOOTBALL_LEVEL_FIRST_EVAL_AS_OF` | ISO 8601 UTC 字符串，必须满足 `isMondayLevelEvalAt(date)`（即周一 10:00:00.000 Asia/Shanghai / `02:00:00.000Z`） | 注入周评、重评、重建、每日对账；`FOOTBALL_ENVIRONMENT=prod` 时缺失或非法则**拒绝启动**并在 `vps:preflight` 报错；非 `prod` 允许为空（沿用测试注入）。 | Slice 1 |
| `FOOTBALL_RANKING_FIRST_PERIOD_KEY` | ISO 周编号，必须满足 `isValidPeriodKey(PeriodType.Week, value)`（如 `"2026-W47"`） | 注入 `RankingQueryService` 并通过 `GET /v1/rankings` 的 `first_period_key` 下发给小程序；`FOOTBALL_ENVIRONMENT=prod` 时缺失或非法则**拒绝启动**；非 `prod` 回落 `RANKING_FIRST_PERIOD_KEY`。 | Slice 6、7 |

（需同步在 `ops/vps/football.env.example` 与 `ops/vps/cloudbase.env.example` 补充上述两项占位注释。）

以下 **默认运维参数** 若无特殊要求，AI 可直接按默认值实现：
- `auth_sessions` 过期清理宽限：`7` 天（删除 `expires_at < now - 7d`）
- `provider_usage` 清理：`minute` / `hour` 级 bucket 保留 `7` 天，`day` / `month` 保留 `365` 天
- `sync_logs` / `provider_snapshots` 清理：保留 `60` 天
- `board_snapshots` 非终榜快照：每个榜（`career` / `strength` / `season`）仅保留最近 `24` 份时间截面，终榜（`is_final = true`）永久保留

### 0.2 全局开发与验收纪律

1. **按切片顺序执行（Slice 1 → Slice 7）**，每个切片独立提交或独立验收，禁止跨切片大重构。
2. **TDD 流程**：每个切片先补充复现该缺陷的失败测试，再实现修复。
3. **OpenAPI 优先**：涉及接口字段新增（Slice 6）必须先更新 `src/api/v1/openapi.yaml`，再改后端与小程序，确保前后端字段名和类型严格一致。
4. **不破坏已冻结视觉基线**：修改小程序逻辑时不得改动 `miniprogram/styles/design-tokens.wxss` 及首页冻结布局；改动首页 WXML/JS 后需跑 `python3 docs/design/scripts/verify-home-migration.py`。
5. **每个切片完成后的必跑校验命令**：
   ```bash
   npm run typecheck
   npx tsc -p tsconfig.build.json --noEmit
   npx tsc -p tsconfig.cloudfunction.json --noEmit
   npx vitest run <本切片相关测试文件>
   git diff --check
   ```
   全部切片完成后再跑全量 `npm test` 与 `npm run build`。

---

## Slice 1（P0）：等级首评时间轴环境变量化与周评估单用户隔离

- **对应问题**：F1 + 核验一.1 + M6
- **前置依赖**：无（无需提前定死上线日期，上线前在服务器 `.env` 填入即可）。

### 改动清单
1. **运行时配置与启动门禁（`src/gateway/config.ts`、`src/runtime/application-runtime.ts`、`ops/vps/football.env.example`）**
   - 新增解析 `FOOTBALL_LEVEL_FIRST_EVAL_AS_OF`（支持合法 ISO 时间，并用 `isMondayLevelEvalAt(date)` 校验必须是周一 10:00 Asia/Shanghai）。
   - 当 `FOOTBALL_ENVIRONMENT === "prod"` 时，若未配置或格式非法，直接在配置加载阶段抛错阻断启动（`vps:preflight` 与服务启动均生效）；非 `prod` 允许返回 `null` 保持现有单测兼容。
   - 在 `ops/vps/football.env.example` 中补充 `FOOTBALL_LEVEL_FIRST_EVAL_AS_OF` 注释与示例格式。
2. **统一注入四条等级链路（`src/runtime/application-runtime.ts`、`src/application/daily-consistency-snapshot.ts`、`src/application/daily-consistency-service.ts`、`src/application/stats-rebuild-service.ts`）**
   - 将解析出的 `levelFirstEvalAsOf: Date | null` 统一注入 `WeeklyLevelEvalService`、`LevelCorrectionReevalService`、`StatsRebuildService`、`DailyConsistencyService`（以及 `loadDailyConsistencySnapshot` 的可选参数），确保四条链路严格共用同一时间轴，不再各自硬读 `FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF`。
3. **周评估单用户异常隔离（`src/application/weekly-level-eval.ts`）**
   - 在 `WeeklyLevelEvalService.run` 的用户遍历循环（L280–295）中，为每个用户的 `evaluateCareer` 与 `evaluateSeasons` 包裹 `try/catch`：
     - 若捕获 `DomainError` 且 `code === "SETTLEMENT_ALREADY_RUNNING"`（M6）：计入 `skippedCount`，记录结构化日志，不中断循环，也不标记整批失败。
     - 若捕获其他异常（包括 `SPEC_GAP`）：记录错误日志/写入非阻塞 `anomaly`（若 repo 可用），递增错误计数，**继续评估后续用户**。
   - 当本批存在 `skipped` 或单用户失败时，是否推进 `WeeklyLevelEval` 周期标记：
     - 仅当全部活跃用户无未捕获异常且无 `SETTLEMENT_ALREADY_RUNNING` 跳过时才由 `scheduled-jobs.ts` 推进 `completed_cycle_at`；若存在被跳过的用户，下轮 tick 重跑时因已评估用户具备 `last_eval_as_of === asOf` 幂等跳过，不会重复评估。

### 验收测试
- 新增/补充单测：
  1. `FOOTBALL_ENVIRONMENT=prod` 且缺少或传入非周一 10:00 北京时间的 `FOOTBALL_LEVEL_FIRST_EVAL_AS_OF` 时，配置加载抛错。
  2. 传入合法 `FOOTBALL_LEVEL_FIRST_EVAL_AS_OF` 时，某 `L=3` 用户本周未达标正常完成评估（保护期内不降级，保护期后累计 `below_count`），不再抛 `SPEC_GAP`。
  3. 对 Lv.5 用户执行 `stats-rebuild-service`（注入同一 `firstEvalAsOf`），重建后等级与评估窗口保持一致，不会掉回 Lv.1。
  4. 列表第 1 个用户触发 `SETTLEMENT_ALREADY_RUNNING` 时，第 2 个用户仍能正常完成周评估。

---

## Slice 2（P0）：比赛列表与对账动态赛季切换

- **对应问题**：F2（含 `daily-consistency-snapshot.ts:603`）

### 改动清单
1. **`src/application/match-query.ts`**
   - 在 `MatchQueryService.list`（L363）中，将静态：
     ```ts
     const seasonIds = [...new Set(SUPPORTED_LEAGUES.map((row) => row.season_id))];
     ```
     替换为动态：
     ```ts
     const seasonIds = [...new Set(SUPPORTED_LEAGUES.flatMap((row) => activeSeasonIds(row, input.server_now)))];
     ```
     （`activeSeasonIds` 已在 `src/domain/config.ts:428` 导出，返回 `[当前赛季, 上一赛季]`）。
   - 同时保留按 `from` / `to` 时间窗过滤，避免跨年/换季过渡期漏掉邻近赛季比赛。
2. **`src/application/daily-consistency-snapshot.ts`**
   - 将 L602–604 中 `now === undefined` 分支也统一要求传入 `now` 或使用 `activeSeasonIds(league, now ?? new Date())`，消除对静态 `league.season_id` 的依赖。

### 验收测试
- 在 `match-query.test.ts` 新增用例：
  1. `server_now = 2027-03-15T12:00:00Z` 时，能查到中超 `season_id = "2027"` 的比赛。
  2. `server_now = 2027-08-15T12:00:00Z` 时，能查到英超 `season_id = "2027_2028"` 的比赛。

---

## Slice 3（P0）：比赛逻辑身份 `canonical_match_id` 全链路贯通

- **对应问题**：核验一.2

### 改动清单
1. **`src/infrastructure/repositories.ts` & `src/infrastructure/cloudbase-app-repository.ts`**
   - 在 `PredictionRepository` 接口新增方法：
     ```ts
     findByCanonicalMatch(canonicalMatchId: string): Promise<Prediction[]>;
     ```
   - 在 `InMemoryRepository` 与 `CloudBaseAppRepository` 中实现 `findByCanonicalMatch`：
     - 查询 `canonical_match_id === canonicalMatchId` 的记录，同时兼容历史未回填记录（`match_id === canonicalMatchId` 且 `(p.canonical_match_id ?? p.match_id) === canonicalMatchId`），按 `prediction_id` 去重。
   - 检查 `src/schema/indexes.ts`：为 `predictions` 补充查询索引 `ix_predictions_canonical_match`（字段 `["canonical_match_id"]`），并同步更新 `postgres-schema` / 索引相关测试。
2. **`src/application/match-query.ts`**
   - `list()`（L371）：过滤掉已作废比赛 `.filter((match) => match.superseded_by == null)`。
   - `list()`（L399）与 `get()`（L453）：查用户本人预测时，从 `findByUserAndMatch(user.user_id, match.match_id)` 改为 `findByUserAndCanonicalMatch(user.user_id, match.canonical_match_id ?? match.match_id)`。
   - 详情页 `get(matchId)`：若传入的是已被 `superseded_by` 取代的旧 `match_id`，仍允许读取历史预测记录，但保持 `can_predict = false`（避免旧记录入口 404）。
3. **`src/application/settlement-item-preparation.ts`**
   - 在 `prepareSettlementItems`（L35）中：先加载 `match = await tx.matches.findById(settlement.match_id)`，改为按 `canonicalId = match.canonical_match_id ?? match.match_id` 调用 `tx.predictions.findByCanonicalMatch(canonicalId)`，确保旧比赛上的预测被纳入新比赛的结算项。
   - 同步核查 `src/application/settlement-item-application-service.ts`、`src/application/first-settlement-service.ts`、`src/application/correction-settlement-service.ts` 中是否存在 `prediction.match_id !== settlement.match_id` 的硬性报错断言；若有，改为校验 `(prediction.canonical_match_id ?? prediction.match_id) === (match.canonical_match_id ?? match.match_id)`。

### 验收测试
- 新增端到端内存仓储集成测试：
  1. 用户对旧比赛 `M_old` 提交预测 `P1`。
  2. 供应商换 ID 合并产生新比赛 `M_new`（`canonical_match_id = M_old.canonical_match_id`，`M_old.superseded_by = M_new.match_id`）。
  3. 验证 `GET /v1/matches` 不再展示 `M_old`，只展示 `M_new`。
  4. 验证 `GET /v1/matches/M_new` 返回 `my_prediction = P1`、`can_predict = false`、`can_predict_reason = "ALREADY_SUBMITTED"`。
  5. `M_new` 完场并触发首次结算后，生成 1 条指向 `P1` 的 `settlement_item`，`P1` 正常结算得分并计入用户积分与榜单。

---

## Slice 4（P0/P1）：高频全量查询下推与锁原子化

- **对应问题**：F3（读取侧）+ H1 + H2 + M1 + M5

### 改动清单
1. **`board_snapshots` 读取下推（F3）** — `src/infrastructure/cloudbase-app-repository.ts:632-650`
   - `findLatestByBoard(board)`：
     - 先查 1 条最新非终榜记录：`where("board_snapshots", { board, is_final: false }, { order_by: "snapshot_at", direction: "desc", limit: 1 })`（注：若历史数据存在 `is_final` 缺失需兼容，可不带 `is_final` 查最近若干条取首个 `is_final !== true` 的 `snapshot_at`）。
     - 拿到 `latestAt` 后，再执行 `where("board_snapshots", { board, snapshot_at: latestAt })` 并过滤 `is_final !== true` 后按 `rank` 排序返回。
   - `findLatestBySeason(seasonId)`：同上，先按 `{ board: "season", level_season_id: seasonId }` + `order_by: "snapshot_at", direction: "desc", limit: 1` 取最新时间截面，再按 `{ board: "season", level_season_id: seasonId, snapshot_at: latestAt }` 精确查询。
   - `listFinalSeasonIds()`：在 `src/schema/indexes.ts` 确认 `board_snapshots` 索引覆盖 `(board, is_final, level_season_id)` 或 `(board, level_season_id, snapshot_at:desc)`；写入终榜时无论是否为空均写入一条 `snapshot_kind: "head"` 标记行，使 `listFinalSeasonIds()` 只需查 `{ board: "season", is_final: true, snapshot_kind: "head" }`（每赛季仅 1 行）。
2. **消除 `listDueSeasonFinalIds` 的 N+1（H1）** — `src/application/weekly-level-eval.ts:70-92`
   - 不再调用 `repo.users.findAll()` 再逐个 `findByUser`。
   - 改为从 `asOf` 反推可能待生成终榜的候选赛季（当前赛季的上一赛季及已登记起始赛季至上一赛季的有限列表，例如最多回溯最近 2–3 个等级赛季），对每个候选 `seasonId` 检查 `asOf >= seasonFinalEvalAsOf(seasonId)`、`findFinalBySeason(seasonId)` 为空、且 `findByLevelSeason(seasonId)` 全部已冻结。
3. **消除 `listDuePeriodKeys` 的全表读取（H2）** — `src/runtime/scheduled-jobs.ts:262-265` & `src/infrastructure/repositories.ts`
   - 在 `RankingRepository` 新增 `findUnfinalizedWeeks(): Promise<RankingEntry[]>`（或在 `CloudBaseAppRepository` 中查 `where("rankings", { period_type: "week", is_final: false })`）。
   - `src/schema/indexes.ts` 为 `rankings` 增加索引 `ix_rankings_period_final`：`["period_type", "is_final", "period_key"]`。
4. **比赛列表时间窗下推（M5）** — `src/application/match-query.ts:366`
   - 利用 `db.gteFilter("kickoff_at", window.from)` / `db.lteFilter("kickoff_at", window.to)`，在 `MatchRepository` 新增 `findBySeasonsInWindow(seasonIds, from, to)`，避免每次 `/v1/matches` 拉取 6 联赛全季上千行。
5. **`job_locks.acquire` 原子化（M1）** — `src/infrastructure/cloudbase-db.ts`、`postgres-document-db.ts`、`cloudbase-app-repository.ts:528-542`
   - 在 `CloudBaseDb` 增加可选原子方法 `acquireLock?(collection, lockKey, ownerId, leaseUntil, now): Promise<boolean>`。
   - 在 `PostgresDocumentDb` 中用单条 SQL 实现：
     ```sql
     INSERT INTO <table> (_id, document) VALUES ($1, $2::jsonb)
     ON CONFLICT (_id) DO UPDATE SET document = EXCLUDED.document
     WHERE <utc_timestamptz>(<table>.document ->> 'lease_until') <= $3::timestamptz
     RETURNING _id
     ```
   - `CloudBaseAppRepository.jobLocks.acquire` 优先调用 `db.acquireLock`，不支持时再退化为事务读改写并捕获 `UniqueConstraintError` 返回 `false`。

### 验收测试
- 针对上述每项补充单测与 PG 集成测：验证 `board_snapshots` 多时间截面下只查最新截面、`job_locks.acquire` 并发竞争只有一个返回 `true` 且不抛异常、`listDueSeasonFinalIds` 不再调用 `users.findAll()`。

---

## Slice 5（P1）：连接池加固、周期任务拆分、分批缓存与数据清理

- **对应问题**：F3（清理侧）+ H3 + H4 + H5 + H6 + H7 + L3

### 改动清单
1. **PG 连接池与回滚加固（H7 + L3）**
   - `src/runtime/vps-runtime.ts:32`：
     - 配置 `new pg.Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 })`（支持环境变量覆盖）。
     - 注册 `pool.on("error", (err) => { console.error(JSON.stringify({ event: "pg_pool_error", message: err.message })); })`。
   - `src/infrastructure/postgres-document-db.ts:32, 474-478`：
     - 将 `PostgresExclusiveClient.release` 签名改为 `release: (err?: Error) => void | Promise<void>`。
     - 当 `ROLLBACK` 自身抛错时，记录错误并在 `finally` 中调用 `client.release(rollbackError)`，确保损坏连接被连接池销毁而非复用。
2. **对账与周评估 N+1 缓存 + 租约续期（H3 + H4）**
   - `src/application/rebuild-service-support.ts`：在 `loadAppliedSettlementFacts` 内部建立本次调用级的 `settlementCache = new Map<string, SettlementDoc>()` 与 `matchCache = new Map<string, Match>()`，先查缓存再查库，消除同场/同结算单的重复查询。
   - `src/application/weekly-level-eval.ts`：在用户循环中每处理 20 名用户（或每超过 2 分钟）调用 `this.repo.jobLocks.renew(WEEKLY_LEVEL_EVAL_LOCK_KEY, ownerId, new Date(Date.now() + LEVEL_JOB_LEASE_MILLISECONDS))`，若续租失败立即安全中止本轮。
   - `src/application/daily-consistency-snapshot.ts`：限制只对账活跃赛季（`activeSeasonIds`）内的 `matches` 对应的结算单，不再无边界扫全历史 `applied` 项。
3. **Tick 模式拆分（H5）**
   - `src/jobs/tick.ts`：支持 CLI 参数 `--mode=all | realtime | periodic`（默认 `all` 保持兼容）：
     - `realtime`：仅跑 `runDueProviderJobs`（实时同步与赛果）+ `runSettlementTimer`。
     - `periodic`：跑 `leagueSeasons.run` + `runDuePeriodicJobs`（封榜、对账、周评估、快照）+ 每日清理任务。
   - `ops/vps/`：保留 `football-jobs.timer`（3 分钟，可传 `--mode=realtime`），新增 `football-periodic.service` + `football-periodic.timer`（如每 15 分钟，`--mode=periodic`），避免重任务阻塞实时比分。
4. **定期数据清理任务（F3 + H6）**
   - `src/infrastructure/cloudbase-db.ts` 新增可选 `deleteWhere?(collection: string, filter: Record<string, unknown>): Promise<number>`；在 `PostgresDocumentDb` 中实现 `DELETE FROM <table> WHERE ...`。
   - `src/infrastructure/postgres-auth-sessions.ts` 新增 `deleteExpiredBefore(cutoff: Date): Promise<number>`。
   - 新增 `src/application/maintenance-cleanup.ts`，按 0.1 节默认保留期清理：
     - `auth_sessions`（`expires_at < now - 7d`）
     - `provider_usage`（`bucket_type in ['minute','hour']` 且 `bucket_start < now - 7d`）
     - `sync_logs`（`started_at < now - 60d`）
     - `provider_snapshots`（`created_at < now - 60d`）
     - `board_snapshots`（每个 `board` 非终榜仅保留最近 24 个 `snapshot_at`，删除更早的非终榜行）
   - 接入 `runDuePeriodicJobs`（每日执行一次，记录 `scheduler_state` 周期标记）。

### 验收测试
- 单测验证 `loadAppliedSettlementFacts` 缓存命中显著减少 `settlements.findById` / `matches.findById` 调用次数。
- 单测验证 `tick.ts --mode=realtime` 与 `--mode=periodic` 职责隔离。
- 单测验证 `maintenance-cleanup.ts` 只删过期日志与超量非终榜快照，**绝不删除** `is_final = true` 终榜与核心账本数据。

---

## Slice 6（P1，API 合同升级）：补齐前端所需服务端字段

- **对应问题**：核验二.4、二.5、二.8、二.10
- **核心原则**：**先改 `src/api/v1/openapi.yaml`，再改 TypeScript 实现与 API 测试**。

### OpenAPI 与后端改动清单
1. **`GET /v1/matches`（核验二.4）**
   - `src/api/v1/openapi.yaml` & `src/application/match-query.ts`（`MatchListItem`）：
     - 新增 `settlement_status: SettlementStatus`（`"not_ready" | "waiting" | "settling" | "settled" | "correcting" | "voided"`）。
     - 新增 `my_prediction: MyMatchPrediction | null`（与 `MatchDetailResult.my_prediction` 完全同构；游客或未预测返回 `null`）。
   - `match-query.ts:list()` 改用批量 `findByUserAndCanonicalMatchIds` 一次查询当页比赛对应的本人预测，避免 N+1。
2. **`GET /v1/matches/{match_id}`（核验二.10）**
   - `src/api/v1/openapi.yaml` & `src/application/match-query.ts`（`MatchDetailResult` / `MatchListItem`）：
     - 新增 `is_prediction_closed: boolean`：服务端按 `match.prediction_closed_at !== null || (match.prediction_deadline_at !== null && serverNow.getTime() >= match.prediction_deadline_at.getTime())` 计算。
     - **不改变** `can_predict_reason` 的既有领域优先级（`ALREADY_SUBMITTED` 仍优先）。
3. **`GET /v1/rankings`（核验二.5 + M4）**
   - `src/gateway/config.ts` & `src/runtime/application-runtime.ts`：新增解析 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`（用 `isValidPeriodKey(PeriodType.Week, value)` 校验；`prod` 必填，非 `prod` 回落 `RANKING_FIRST_PERIOD_KEY`），并作为 `firstPeriodKey` 传入 `RankingQueryService`；同步更新 `ops/vps/football.env.example`。
   - `src/api/v1/openapi.yaml` & `src/application/ranking-query.ts`（`RankingQueryResult` / `RankingMe`）：
     - 在 `RankingQueryResult` 新增 `first_period_key: string`（下发当前生效的周榜起始周，供小程序动态构建可选周下拉，无需写死在小程序包内）。
     - 在 `RankingMe` 的 `status: "ranked"` 分支补充本人指标字段（按当前 `board` 返回，避免前端从分页 `items` 里反查）：
       - `week`：`period_score: number`、`valid_predictions: number`、`exact_hits: number`
       - `career`：`career_points: number`、`career_valid_predictions: number`、`exact_hits: number`
       - `season`：`season_points: number`、`season_valid_predictions: number`、`exact_hits: number`
       - `strength`：`strength_index: string`、`window_n: number`
4. **`GET /v1/levels/me`（核验二.8）**
   - `src/api/v1/openapi.yaml` & `src/application/levels.ts`（`SeasonLevelData`）：
     - 新增 `season_points: number`、`exact_hits: number`（无赛季记录时均为 `0`，有记录时取 `stats.season_points` 与 `stats.exact_hits`）。

### 验收测试
- 更新/补充 `src/api/v1/` 与 `src/gateway/v*.test.ts` 契约测试：
  1. 已登录用户调用 `GET /v1/matches` 返回 `my_prediction` 与 `settlement_status`。
  2. 排名第 25 名用户调用 `GET /v1/rankings?limit=10` 时，`me` 中直接包含本人积分/评分。
  3. 调用 `GET /v1/levels/me` 返回 `season.season_points` 与 `season.exact_hits`。
  4. 截止后开球前，已提交预测用户调用 `GET /v1/matches/{id}` 返回 `can_predict_reason: "ALREADY_SUBMITTED"` 且 `is_prediction_closed: true`。

---

## Slice 7（P1/P2）：小程序端全部功能与兼容性修复

- **对应问题**：合并 M2 + 核验二.3–二.11 + M3 + M4

### 改动清单
1. **登录入口 & HTTP 401 静默恢复（M2 + 核验二.3）**
   - `miniprogram/pages/profile/profile.wxml:7` & `profile.js:288`：登录按钮绑定新增的 `onLoginTap()`，导航至 `/pages/session/session`；设置按钮继续走 `onSessionTap()`（或更名为 `onSettingsTap`）跳 `/pages/settings/settings`。
   - `miniprogram/services/api.js` + `miniprogram/services/auth.js`：在 HTTP 模式下，若非 `/v1/auth/wechat` 的业务请求收到 `statusCode === 401 && code === "UNAUTHORIZED"`，且本次请求尚未重试过，则调用 `clearAuth()` → `ensureAuth()` 重新换取 token 并原样重发一次请求。
2. **首页预测回显、完场文案解耦 & 日期纯算术化（核验二.4 + M3）**
   - `miniprogram/pages/matches/matches.js`：
     - 优先使用接口返回的 `item.my_prediction`（本地 `submittedMap` 仅作为当次提交后的乐观补充）。
     - `buildCardState` 解耦全场比分、结算状态（`settlement_status`）与个人预测状态：非参与者完场后不再显示“待结算”。
     - 重写 `beijingParts` 与 `buildDates`：用 `new Date(date.getTime() + 8 * 60 * 60 * 1000)` + `getUTCFullYear/Month/Date/Hours/Minutes/Day` 纯算术计算，彻底移除 `toLocaleString("sv-SE", { timeZone })`。
3. **排行榜本人指标 & 群失效恢复（核验二.5 + 二.6）**
   - `miniprogram/pages/rankings/rankings.js`：
     - 渲染“我的”栏时直接读取 `data.me` 中的服务端指标字段，不再依赖 `merged` 列表查找。
     - L195 检测到所选群失效时，清除 `groupId` / 刷新群列表，并在错误态展示「切回全站榜」按钮。
4. **队徽稳定解析 & 主队候选脱离赛程（核验二.7）**
   - `miniprogram/utils/team-presentation.js` & `miniprogram/utils/logo-registry.js`：支持按 `team_id`（优先）→ 归一化名称/别名解析本地队徽，补齐已知缺失别名。
   - `miniprogram/pages/my-predictions/my-predictions.js`：传递完整队名与 `team_id`。
   - `miniprogram/pages/settings/settings.js` & `profile.js`：主队候选列表改为从全量静态球队注册表（`team-registry.js`）构建，不再依赖近期赛程接口。
5. **本赛季成绩单、Lv.1 进度、创建群数量、加群错误态、大家预测（核验二.8–二.11）**
   - `miniprogram/pages/profile/profile.wxml` & `profile.js`：绑定 `season.season_points` 与 `season.exact_hits`；`onCreateGroupTap` 传入真实 `ownedCount + 1`（而非写死 `1`）。
   - `miniprogram/utils/level-presentation.js`：当 `nextThreshold === null`（如 Lv.1 待首评）时，不将 `null` 当 `0` 比较，直接进入待评估态，防止误显 100% 满格。
   - `miniprogram/utils/crowd-view-model.js`：`crowdPlan` 优先使用 `match.is_prediction_closed === true` 允许请求分布，解决截止后开球前已提交者被锁的问题。
   - `miniprogram/pages/groups/join.wxml` & `join.js`：error 态增加「重新输入」与「重试」操作按钮。
6. **周榜起始周改为优先消费接口下发（M4）**
   - `miniprogram/pages/rankings/rankings.js` & `miniprogram/utils/rankings-view-model.js`：调用 `buildWeekOptions(currentPeriodKey, data.first_period_key || rankingFirstPeriodKey)`，优先使用后端 `GET /v1/rankings` 返回的 `first_period_key`，本地 `miniprogram/config.js` 的 `rankingFirstPeriodKey` 仅作兜底。上线周确定时只需修改服务端环境变量 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`，无需重新提审小程序。

### 验收测试
- 运行小程序相关 `.test.mjs` 单元测试（覆盖 `crowd-view-model`、`level-presentation`、`rankings-view-model`、`team-presentation`、`auth` 401 重试等）。
- 运行首页视觉校验脚本：`python3 docs/design/scripts/verify-home-migration.py`。
- 微信开发者工具/真机人工过一遍：登录跳转、401 恢复、首页回显、排行榜第 20 名外本人积分、`.feed` 底部是否被底栏遮挡（核验四）。

---

## 附录：暂不纳入本轮阻断项（上线后按需跟进）

以下来自合并报告的 P3 低风险与体验微调项，不阻塞上线，可按排期后续处理：
- **L1**：联赛换季（UTC 7/1）与等级赛季（北京时间 7/1）的 8 小时边界差。
- **L2**：待核实上游 Provider 日额度重置时区后再调整 `provider/budget.ts`。
- **L4**：`CloudBaseWxDb.query` 无序翻页（仅切回 CloudBase 时需要）。
- **L5 / L6**：VPS systemd 模板用户名替换、服务器侧 PostgreSQL 定时 `pg_dump` 备份配置（属运维部署操作）。
- **核验三**：领奖台与前 20 重复、选择器遮挡更新时间、解锁页入口、180ms 切换防抖取消、详情“开球时间”文案、本赛季标签格式化。
