# 上线前问题修复可执行开发文档（AI 落地指南）

- **文档版本**：v1.0（2026-11-19，补充历史赛季查询与分享闭环）
- **基线提交**：`8e37d49`
- **需求来源**：[PRE_LAUNCH_CONSOLIDATED_REVIEW__v1.0.md](PRE_LAUNCH_CONSOLIDATED_REVIEW__v1.0.md)
- **补充需求**：历史预测跨赛季持续可查、赛季筛选与分页下推、分享卡发送与接收闭环（Slice 8、9）。
- **目标读者**：直接执行代码修改的 AI Coding Agent / 开发者

---

## 0. 执行前必读：人工确认门禁与开发纪律

### 0.1 上线日期相关参数：改为运行时环境变量（无需现在定死上线周）

为避免上线日期变动导致重新改代码或重新提审小程序，以下 **2 项** 不在代码里写死上线日期，改为**环境变量 + 启动校验**，全部 9 个切片可按依赖顺序开发：

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

1. **按切片顺序执行（Slice 1 → Slice 9）**，每个切片独立提交或独立验收，禁止跨切片大重构。Slice 8 复用 Slice 3 的 canonical 归属，Slice 9 依赖 Slice 8 的接口与分页能力；原有切片已验收的部分不重复实现。
2. **TDD 流程**：每个切片先补充复现该缺陷的失败测试，再实现修复。
3. **OpenAPI 优先**：涉及接口字段新增、赛季校验语义调整或新接口（Slice 6、8、9）必须先更新 `src/api/v1/openapi.yaml`，再改后端与小程序，确保前后端字段名和类型严格一致；禁止仅放宽代码校验、修改测试而保留旧契约。
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

### 0.3 赛季查询与分享的统一约定

1. **活动赛季与历史查询范围分离**：Slice 2 的 `activeSeasonIds` 用于近期赛程取数，不作为历史记录或分享卡的查询白名单。已接入的历史赛季在停止同步后仍可查询，不随换季移出目录；不得以“当前 + 上一赛季”限制永久历史。
2. **赛季目录由服务端提供**：复用已有联赛配置与持久化赛程，按 `(league_id, season_id)` 登记可查询范围；已有历史赛程必须纳入。目录不因某用户没有预测或旧赛季停止同步而消失，不接受仅凭年份格式推导出的任意赛季。比赛赛季与等级赛季分别命名、分别取值。
3. **历史记录默认不筛赛季**：`GET /v1/predictions/me` 不传筛选项时返回本人全部历史的分页结果；可单独按联赛筛选，传 `season_id` 时仍须同时传 `league_id`。切换筛选必须清空旧游标和已加载列表，翻页不能因换季自动切换查询范围。
4. **空数据与错误分开**：赛季格式非法、联赛赛季组合未接入返回 `422 VALIDATION_ERROR`，错误详情区分格式错误与未接入；已接入赛季但用户无预测返回 `200` 空列表。数据库或网络失败保持错误态，不转换成“暂无记录”。
5. **分享时间口径固定**：链接固定分享者、联赛、比赛赛季与轮次；轮次成绩读取该范围最新有效结算结果，更正结算后允许更新。昵称、主队、等级和生涯积分展示当前值并明确标注；当前等级附带当前 `level_season_id`，不声称是该历史轮次发生时的等级。本期不新增历史昵称或等级快照系统。

上述约定由 Slice 8、9 落地；不是将既有“只认登记赛季”静默改为格式校验，也不是将尚无小程序调用的分享卡视为已完成。

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
- **修订后新增任务【已完成】**：本切片已有的 `activeSeasonIds` 只处理近期赛程与对账；新增历史预测及分享查询时，须补充可查询赛季目录，不得把当前及上一赛季当作历史查询白名单。原本近期赛程的实现不需要为此重复开发，历史赛季目录和两处校验按 Slice 8 的第 1、2 项完成与验收。（已落地：`GET /v1/league-seasons` 目录 + 共用 `assertLeagueSeasonAttached` 两级校验，`activeSeasonIds` 未改动。）

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
   - 本切片仅调整近期赛程读取；历史预测与分享的可查询赛季按 0.3 节及 Slice 8 执行，不能复用活动赛季白名单限制历史查询。
2. **`src/application/daily-consistency-snapshot.ts`**
   - 将 L602–604 中 `now === undefined` 分支也统一要求传入 `now` 或使用 `activeSeasonIds(league, now ?? new Date())`，消除对静态 `league.season_id` 的依赖。

### 验收测试
- 在 `match-query.test.ts` 新增用例：
  1. `server_now = 2027-03-15T12:00:00Z` 时，能查到中超 `season_id = "2027"` 的比赛。
  2. `server_now = 2027-08-15T12:00:00Z` 时，能查到英超 `season_id = "2027_2028"` 的比赛。

---

## Slice 3（P0）：比赛逻辑身份 `canonical_match_id` 全链路贯通

- **对应问题**：核验一.2
- **修订后新增任务【已完成】**：原有代码已在历史预测、分享卡和结算等路径接入 canonical，且旧预测到新比赛结算已有端到端测试；新增的历史分页下推和分享接收者路径仍须保留该归属，在新查询中验证旧赛预测不漏、不重，并覆盖换 ID 后的分享摘要。按 Slice 8 的第 3、4 项及 Slice 9 的分享验收执行，不以原端到端测试代替新增路径验收。（已落地：历史分页在数据库内按已解析的 canonical 归属筛选，接收者接口复用同一公开摘要组装逻辑。）

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
- **修订后新增任务【已完成】**：本切片的查询下推针对榜单、周榜与比赛时间窗；新增的预测历史分页及赛季目录去重也须下推数据库，并补充索引、两种仓储实现与分页测试，见 Slice 8 第 1、3 项。现有比赛时间窗下推不能视为这些新任务已完成。**原 Slice 4 本身仍是部分实现，榜单快照等原有待办仍需按本节验收。**（新任务已落地：预测历史按用户/联赛/赛季/游标在 SQL 内筛选后截断，赛季目录单条 `SELECT DISTINCT`，并补 `(user_id, submitted_at desc, prediction_id desc)` 索引与内存仓储实现。）

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

- **落地状态【未做】（2026-11-20 审计）**：本切片 4 项（5.1–5.4）在代码中均无实现，逐项证据见文末《Slice 5/6/7 落地审计》。不得视为已完成。

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

- **落地状态【已落地（后端与契约；全量回归未跑）】**：6.1–6.4 已在 OpenAPI、查询服务与仓储实现。本轮另补旧预测批量兼容，以及 Slice 6 新增可空字段的 OpenAPI 3.1 表达。文末《Slice 5/6/7 落地审计》是 **2026-11-20 实施前只读快照**，其中 6.1–6.4「未做」不代表当前状态。Slice 7 未做。不得将本切片标为已通过全量验收。

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

### 落地说明（2026-11-20 实施后，含本轮补修）

1. **6.1–6.4**：列表补 `settlement_status` / `my_prediction`，当页一次 `findByUserAndCanonicalMatchIds`；详情补 `is_prediction_closed`（`can_predict_reason` 优先级未改）；排行榜补 `first_period_key` 与 `RankingMe` 各榜指标，解析 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`；等级补 `season.season_points` / `season.exact_hits`（无记录为 `0`）。
2. **旧预测批量兼容**：CloudBase `findByUserAndCanonicalMatchIds` 先按 `canonical_match_id` 批量命中，未命中再按 `match_id` 补齐未回填行，与单条 `findByUserAndCanonicalMatch` 对齐。未在真实数据库上验证历史数据。
3. **OpenAPI 3.1 新增字段可空表达**：Slice 6 新增可空字段按 3.1 表达（列表 `my_prediction` 为 `anyOf` + `null`；`RankingMe.rank` / `top_percent` 为 `type: [integer, 'null']`）。**未**把规范中既有 `nullable: true` 全部改写。
4. **定向测试（非全量回归）**：仓储和列表 84 项、契约等 19 项、类型检查通过。未跑全量 `npm test`，不得写已通过验收。Slice 7 未做。

---

## Slice 7（P1/P2）：小程序端全部功能与兼容性修复

- **落地状态【未做】（2026-11-20 审计）**：本切片 6 项（7.1–7.6）在代码中均无实现，逐项证据见文末《Slice 5/6/7 落地审计》。其中 7.2、7.5 属改造既有运行逻辑，回归风险高于纯字段新增。不得视为已完成。

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

## Slice 8（P1，API 合同升级）：历史赛季目录、预测分页下推与分享查询

- **对应问题**：补充需求（0.3）；原 Slice 2 仅覆盖近期赛程，Slice 3 仅覆盖 canonical 归属，均未定义历史查询范围和分享接收路径。
- **前置依赖**：Slice 3、4、6；先完成 OpenAPI 与仓储契约，再实现后端，Slice 9 消费本切片接口。
- **修订新增【已完成（后端）】**：本切片为本次补充的任务；原状态为两处赛季校验只检查年份格式、OpenAPI 仍是原登记赛季契约、历史预测先按用户全量读取。已完成：赛季目录接口与共用两级校验（格式 → 目录）、`/predictions/me` 与分享卡的筛选/游标下推、分享卡新增 `season_id`、`season_label`、`level_season_id`、`generated_at`、`pending_predictions`，以及接收者接口 `GET /v1/share-card/{user_id}`（游客可读、未接入轮次 404、不改用接收者身份）；`ShareCardData` 契约同步补齐字段。canonical 归属沿用既有实现。

### OpenAPI 与后端改动清单
1. **可查询赛季目录（`src/api/v1/openapi.yaml`、`src/api/v1/`、`src/infrastructure/repositories.ts`）**
   - 新增 `GET /v1/league-seasons`，支持可选 `league_id`，返回已接入联赛赛季条目：`league_id`、`season_id`、`season_label`、`round_ids`（实际已接入的轮次，按轮次排序）。联赛内按赛季倒序返回，不依赖用户预测记录。
   - 优先复用已有赛季配置/仓储；不足时增加最小查询方法，基于已登记配置及持久化赛程形成目录，不新增独立赛季管理后台。历史记录至少保留到其关联预测、结算事实仍需查询时；Slice 5 清理任务不得删除目录所依赖的核心事实。
   - PostgreSQL 在数据库中完成联赛赛季/轮次去重与筛选，禁止每次拉全量比赛到应用内去重；补齐对应查询索引与内存仓储实现。
2. **统一赛季校验（`src/application/prediction-query.ts`、`src/application/share-card.ts`）**
   - 将两处复制的格式判断归并为共用的联赛赛季校验：先验证联赛及该联赛的赛季格式，再验证目录中已接入该组合；历史赛季不要求仍处于活动同步范围。
   - 更新 OpenAPI 的静态 `enum` 与“必须匹配当前登记赛季”描述，改为目录契约；保持 `season_id` 必须与 `league_id` 同时提供的历史查询规则。分享卡仍必传联赛、赛季、轮次，轮次须属于所选赛季，不能只用当前联赛 `round_max` 判断全部历史赛季。
   - 保留原有非法参数测试，新增已接入历史赛季可查、格式正确但未接入赛季被拒绝的测试；不得仅删除拒绝断言来迁就格式放宽。
3. **历史记录筛选与游标分页下推（`src/application/prediction-query.ts`、两种仓储实现、`src/schema/indexes.ts`）**
   - 新增本人历史分页查询方法，按 `user_id`、可选联赛/赛季、游标位置过滤，以 `submitted_at DESC, prediction_id DESC` 稳定排序，只读取 `limit + 1` 条预测以判断是否还有下一页；禁止先 `findByUser()` 读完本人全部历史再分页。
   - 按实际 SQL 设计索引及必要的比赛关联查询，筛选必须发生在截取页面之前；只批量加载当页展示所需比赛与球队。保留 Slice 3 的 canonical 解析，作废赛上的旧预测仍归属正确的业务比赛，不重复、不漏项。
   - 沿用 opaque cursor，绑定已解析的联赛/赛季条件和排序位置；换季不重算已选赛季，旧游标不得跨筛选复用。不修改预测原始提交时间或以新比赛创建时间重新排序。
4. **分享者与接收者查询（`src/application/share-card.ts`、`src/api/v1/`、网关路由）**
   - 保留 `GET /v1/share-card/me` 的本人登录语义；响应补充 `season_id`、`season_label`、`level_season_id`、`generated_at`、`pending_predictions`（该范围内本人已提交但尚待有效结算的预测数量，按既有取消/作废规则排除不计分项），供页面区分全部已结算与尚待结算。明确 `season_level` 为当前等级赛季等级、`career_points` 为当前生涯积分，轮次成绩仅对应请求的比赛赛季与轮次。
   - 新增接收者可读取的 `GET /v1/share-card/{user_id}`，参数仍为 `league_id`、`season_id`、`round_id`；返回同一份公开成绩摘要。按路径指定分享者，不把接收者的登录身份替换为分享者；仅返回分享所需字段，不复用私有历史明细接口。网关与云函数路由同时注册，接收者无需先登录才能查看卡片。
   - 复用公开摘要组装逻辑和有效结算判断，保留 canonical 去重；明确无已结算预测时返回零项成绩，不伪造未结算分数。未接入轮次返回 `404`，用户不存在/已注销返回明确不可用状态，不能回退展示接收者自己的成绩。
   - 本期链接只携带固定查询身份，不另建分享快照表；后续结算更正反映在重新打开的卡片中，界面按 `generated_at` 标注读取时间。

### 验收测试
- 新增/补充 API、仓储与 PG 集成测试：
  1. 系统进入新赛季后，至少两个赛季以前的已接入赛季仍在目录中，旧预测和轮次成绩均可查；未接入的合法格式赛季返回明确 `422`。
  2. 不传筛选项可翻到全部历史；联赛/赛季筛选在分页前生效，同一提交时间的多条记录不重不漏；切换筛选后复用旧游标被拒绝。
  3. 已接入赛季无本人记录返回 `200` 空列表，查询异常不返回伪空列表；旧比赛换 ID 后预测仍可在原业务赛季找到。
  4. 查询第一页不调用全量 `predictions.findByUser()`；PG 查询包含用户、筛选、稳定排序与条数限制，应用只加载当页关联数据。大样本只验证读取范围，不以不可比耗时宣称性能收益。
  5. 分享卡同时返回比赛 `season_id` 与当前等级 `level_season_id`；换季前后固定链接仍读取原轮次成绩，接收者读取分享者而非自己，无登录态也可访问。
  6. 未结算、部分结算、结算更正及 canonical 换 ID 的摘要符合既有结算规则；读接口不更改用户积分或预测。

---

## Slice 9（P1/P2）：小程序历史筛选与分享卡发送、接收闭环

- **对应问题**：补充需求（0.3）；现有 `listMyPredictions({ limit, cursor })` 未透传联赛/赛季，分享卡尚无小程序调用路径。
- **前置依赖**：Slice 7、8；沿用设计 token 与现有页面风格，不修改首页冻结布局。
- **修订新增【已完成（代码与单测；真机多账号回归未验）】**：这是新增小程序任务，不属于原 Slice 7 已列出的修复项；须完成筛选、分享及接收路径，并单独验收，不能因后端已有分享卡查询而标记闭环完成。已完成：`listLeagueSeasons` 服务、`listMyPredictions` 联赛/赛季透传、「我的预测」筛选与游标重置/旧响应丢弃、分享入口、`pages/share-card/` 本人预览与接收者打开、`onShareAppMessage` 固定分享者与赛季轮次、错误态与空态分离。**未验证项**：微信开发者工具/真机双账号的完整分享闭环，本轮按用户要求未在微信环境验证，上线前仍需补做。

### 改动清单
1. **历史筛选入口与参数透传（`miniprogram/pages/my-predictions/`、`miniprogram/services/predictions.js`）**
   - `listMyPredictions` 扩展为 `{ leagueId, seasonId, limit, cursor }`，分别映射 `league_id`、`season_id`；默认仍为全部历史，不擅自附加当前赛季。
   - 在“我的预测”增加联赛、赛季筛选，选项来自 `GET /v1/league-seasons`；全联赛时不携带赛季，单联赛可选择“全部赛季”或指定已接入赛季，年份不写死在小程序包内。
   - 切换联赛时重置赛季，切换任意筛选时清空列表、游标和 `hasMore` 后重载；使用请求序号丢弃旧筛选响应，后续加载始终携带相同筛选。无个人记录显示“你在这个赛季还没有预测记录”，请求失败保留重试入口。
2. **分享卡入口与页面（新增 `miniprogram/services/share-card.js`、`miniprogram/pages/share-card/`，更新 `miniprogram/app.json`）**
   - 在“我的预测”增加“分享轮次成绩”入口；进入分享卡页后选择联赛、赛季与轮次，选项来自服务端目录。已有历史筛选可传为初始值，无筛选时展示选择器，不由客户端猜测当前轮次。
   - 本人预览调用 `/v1/share-card/me`，展示联赛/赛季/轮次、已结算场次、命中与轮次积分；昵称、等级与生涯积分标注“当前”，显示等级赛季和数据读取时间，避免历史成绩与当前身份混为同一时间口径。
   - 配置 `onShareAppMessage`，分享路径固定携带分享者 `user_id`、`league_id`、`season_id`、`round_id`，不得在换季后用“当前赛季”覆盖。复用页面卡片布局作为分享展示，分享标题不宣称尚未结算的成绩。
3. **接收者打开与恢复行为（`miniprogram/pages/share-card/`、`miniprogram/services/share-card.js`）**
   - 从分享路径打开时按指定分享者调用 `/v1/share-card/{user_id}`，游客可查看；不能误调用 `/me` 显示接收者自己的卡片，不能要求登录后才能确认分享内容。
   - 部分或全部未结算时明确说明只统计已结算预测；用户不可用、轮次不存在、参数错误或网络失败分别展示对应状态及适当的返回/重试操作，不能用零分掩盖接口失败。
   - 提供返回“我的预测”入口；接收者再次分享时仍携带原分享者和固定成绩范围。此切片以微信消息分享为验收目标，不扩展独立海报编辑或历史快照系统。

### 验收测试
- 单测覆盖参数映射、默认全部历史、筛选重置游标、旧响应丢弃、目录选项及空态/错误态分离。
- 分享页单测分别断言本人预览与接收者访问调用不同接口，路径中的身份与赛季/轮次完整保留；系统时间推进到新赛季后，旧链接仍请求原赛季。
- 微信开发者工具/真机使用两个账号完整验证：筛选旧赛季 → 查看轮次卡片 → 分享给另一账号 → 接收者打开原分享者成绩 → 未登录接收者打开 → 旧链接换季后仍读取原范围；另验网络失败重试与未结算提示。
- 未具备微信环境时明确记录未验证项；仅有后端接口或页面单测通过，不得将分享闭环标记为完成。

---

## 代码审查修复记录（2026-11-19）

依据本轮对未提交改动的代码审查（报告 11 项：3×P1、8×P2），逐项修复状态如下。全部改动均未提交、未构建、未部署；微信真机与真实 CloudBase 环境**未验证**。

| 编号 | 问题 | 状态 | 落地方式 |
|---|---|---|---|
| R1 | 历史分页 SQL 排除缺少 `superseded_by` 的旧比赛 | 已修 | PG 条件改为 `(m.document ->> 'superseded_by') IS NULL`，同时覆盖字段缺失与 JSON null，仍排除已被替代 |
| R2 | 用户等级锁被占用时仍标记整周完成 | 已修 | 周评新增 `deferred_count`；锁占用不再计入 `skipped_count`，调度器见 `deferred_count > 0` 返回 `user_lock_held` 且不推进周期 |
| R3 | 接收者查看分享卡被本地登录准备拦截 | 已修 | `request()` 新增 `auth: "optional"`；公开的成绩单与他人成绩单、赛季目录走可选认证，`/share-card/me` 仍强制认证 |
| R4 | 本人预览 401 后无登录恢复入口 | 已修 | 错误区增加「去登录」，会话页支持 `return_to=share-card`，返回后按原模式/分享者/联赛/赛季/轮次重试；无登录态不发起请求 |
| R5 | 卡片未就绪仍可分享出空参数链接 | 已修 | 未就绪（初始/加载/失败/切筛选）隐藏转发菜单，仅完整卡片出现后开放；未就绪时分享落到比赛首页，不伪造身份参数 |
| R6 | CloudBase 适配器全量读取，分页未下推 | **部分完成** | 历史分页已下推用户、游标、排序、有界 limit，按批 `in` 查比赛后过滤；目录改为字段投影 + 分页 + 去重。**联赛/赛季过滤与「未被替代」判断仍在应用层**：`Prediction` 无这两个字段，云数据库无 join/distinct，与 PostgreSQL 完全等价的下推不可达 |
| R7 | 真实断网被归为普通失败 | 已修 | 请求失败返回 `statusCode: 0` + `code: "NETWORK_ERROR"`；分享页与该类错误映射为网络异常，服务器 5xx 仍走失败分支 |
| R8 | 从分享页返回丢失历史筛选与分页 | 已修 | 上一页为历史页时 `navigateBack` 保留原实例；无历史页时才跳转新历史页 |
| R9 | 新旧格式预测混存时「大家怎么选」漏算旧记录 | 已修 | 统计 canonical 命中与「canonical 缺失且 match_id 命中」的并集，不重复计数 |
| R10 | 较新终榜行挡住缺少 `is_final` 的旧非终榜快照 | 已修 | 改为按页扫描直到命中非终榜截面，全路径统一 `is_final !== true`，有明确终止条件 |
| R11 | 首评配置接受不存在的日期 | 已修 | 解析前严格校验日历日期，`2026-02-30`、非闰年 `02-29`、`04-31`、`13 月` 一律拒绝 |

### 验证记录

- 全量 `npm test`：**248 文件通过 / 6 跳过；2462 项通过 / 24 跳过 / 0 失败**。
- `npm run typecheck`、`tsc -p tsconfig.build.json --noEmit`、`tsc -p tsconfig.cloudfunction.json --noEmit`：均通过。
- `git diff --check`：无空白错误。
- R1 的 PG 语义用例在独立 schema 内真跑通过（覆盖字段缺失、显式 null、已被替代三种数据），跑后已确认无残留 schema。
- R2/R9/R10/R11/R3/R4/R5/R8/R7 均由主 agent 用真实仓储或真实页面函数另行复现验证，不只依赖子任务自报。
- R6 新增 5 条适配器用例（下推条件与有界 limit、跨批凑页、取尽终止、批次上限、去重与投影）。

### 仍未验证 / 未处理

- **微信真机双账号分享回归未做**：分享、游客打开、登录返回恢复、断网提示、转发菜单显隐均需在开发者工具或真机确认，不能以单测通过代替。
- **真实 CloudBase 环境未验证**：R6 的分页与投影行为只在 fake SDK 上验证过。
- `src/infrastructure/postgres-document-db.pg.test.ts` 中两条**既有** JobLock 用例在本机会失败（该测试 schema 缺 `jsonb_utc_timestamptz` 函数），与本次改动无关；这些用例此前一直因无数据库连接而跳过，属既有测试环境问题，本轮未修。
- 本文档 Slice 4 精确榜单快照、Slice 5 运维项、Slice 7 未落地部分仍按原状态跟踪，不因 11-19 审查修复而视为完成。Slice 6 当前状态见该切片正文；下一节审计表是 **2026-11-20 实施前快照**，其中 6.1–6.4「未做」不是当前状态。

---

## Slice 5/6/7 落地审计（2026-11-20，实施前快照）

- **快照性质**：下表与当时结论记录审计时刻的代码状态，**不是当前状态**。审计之后 Slice 6 的 6.1–6.4 已落地（含本轮旧预测批量兼容与新增字段 3.1 可空表达，见 Slice 6 正文）。Slice 5、Slice 7 截至文档更新时仍未做，下表对这两项仍可对照。
- **审计范围**：Slice 5（5.1–5.4）、Slice 6（6.1–6.4）、Slice 7（7.1–7.6），共 14 项。
- **审计方式**：只读。以当时工作区代码为准，**不采信本文档自述，不以「已有测试」代替「已实现」**，字段类条目同时核对「契约里有」与「代码真的会返回」。
- **执行工具**：claude code v2.1.289 + `auto/deepseek-v4.1-flash`（只读模式）；每项证据由主 agent 回到源码逐一复核，非直接采信工具输出。
- **无污染校验**：审计前后 `git status --short | wc -l` 均为 **84**，未修改任何源码、未构建、未提交、未连接数据库。
- **完整报告**：`/home/neilxu/football-slice5-7-audit-20261120.md`（含每项文件行号与代码片段）。

### 当时结论：14 项全部「未做」

| 编号 | 条目 | 结论 | 关键证据（文件:行号） |
|---|---|---|---|
| 5.1 | PG 连接池与回滚加固 | 未做 | `src/runtime/vps-runtime.ts:32` 仅 `new pg.Pool({ connectionString })`，无 `max`/`idleTimeoutMillis`/`connectionTimeoutMillis`/`statement_timeout`、无 `pool.on("error")`；`postgres-document-db.ts:30-33` release 仍为 `release: ()`；`:584-588` ROLLBACK 失败后仍以无参 `release()` 归还连接；`src/gateway/repository-factory.ts:57` 另有一处裸连接池 |
| 5.2 | 对账缓存 + 周评租约续期 + 活跃赛季边界 | 未做 | `rebuild-service-support.ts:70,78` 每个 applied item 直查 `settlements.findById` / `matches.findById`，无调用级缓存；全仓无 `jobLocks.renew` 调用；`daily-consistency-snapshot.ts:621` 仍 `findByStatus(Applied)` 全表扫 |
| 5.3 | Tick 模式拆分 | 未做 | `src/jobs/tick.ts:116-151` 无 `--mode` 解析；`ops/vps/` 无 `football-periodic.service` / `football-periodic.timer` |
| 5.4 | 定期数据清理任务 | 未做 | `CloudBaseDb` 无 `deleteWhere`；`postgres-auth-sessions.ts` 无 `deleteExpiredBefore`；`src/application/maintenance-cleanup.ts` 不存在；`runDuePeriodicJobs` 无清理任务 |
| 6.1 | `GET /v1/matches` 补 `settlement_status` / `my_prediction` | 未做 | `match-query.ts:37-58` 的 `MatchListItem` 无两字段（`my_prediction` 仅存在于 `:78` 的详情结构）；`openapi.yaml` 列表项定义无两字段；`match-query.ts:403-414` 在 for 循环内逐场 `findByUserAndCanonicalMatch`（N+1） |
| 6.2 | `GET /v1/matches/{id}` 补 `is_prediction_closed` | 未做 | 全仓无该字段实现；`prediction-policy.ts:120-143` 既有优先级（`ALREADY_SUBMITTED` 优先）保持原样，未被破坏 |
| 6.3 | `GET /v1/rankings` 补 `first_period_key` + 本人指标 | 未做 | `ranking-query.ts:79-108` 无 `first_period_key`，`RankingMe` 无各榜指标字段；`gateway/config.ts` 未解析 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`；`assemble.ts:534` 未传 `firstPeriodKey`；`ops/vps/football.env.example` 无该项 |
| 6.4 | `GET /v1/levels/me` 补赛季字段 | 未做 | `levels.ts:30-38` 的 `SeasonLevelData` 仅 7 字段，无 `season_points` / `exact_hits`；`openapi.yaml:2332-2356` 同样缺 |
| 7.1 | 登录入口 + HTTP 401 静默恢复 | 未做 | `profile.wxml:7` 登录按钮仍 `bindtap="onSessionTap"`（跳设置），无 `onLoginTap`；`api.js:200-225` 无 `401 && UNAUTHORIZED` → `clearAuth` → `ensureAuth` → 重发一次的逻辑 |
| 7.2 | 首页回显、完场文案解耦、日期纯算术化 | 未做 | `matches.js:279-284` 仅用本地 `submittedMap`，未消费 `item.my_prediction`；`match-card-state.js:57` `hasCompleteScore && hasSubmitted ? "FT" : "待结算"`——非参与者完场仍显示「待结算」；`matches.js:32,51` 仍 `toLocaleString("sv-SE", { timeZone })` |
| 7.3 | 排行榜本人指标 + 群失效恢复 | 未做 | `rankings.js:455-456` 仍 `merged.find(...)` 反查本人成绩；`:194-198` 群失效仅报错，不清 `groupId`、无「切回全站榜」按钮 |
| 7.4 | 队徽按 `team_id` 解析 + 主队候选脱离赛程 | 未做 | `team-presentation.js:6-13` 队徽仅按名称解析；`my-predictions.js:34-35` 只传 `team_id`；`settings.js:41`、`profile.js:198` 仍用 `listMatches({ limit: 100 })` 构建主队候选 |
| 7.5 | 成绩单/Lv.1 进度/建群数量/加群错误态/大家预测 | 未做 | `profile.wxml:26` 赛季积分与精确命中写死 `—`；`profile.js:279` `owned_count` 写死 `1`；`level-presentation.js:36` 无 `nextThreshold === null` 分支（会误显 100%）；`crowd-view-model.js:7-13` 未用 `is_prediction_closed`；`join.wxml:18-20` error 态无「重新输入」「重试」 |
| 7.6 | 周榜起始周消费服务端下发 | 未做 | `rankings-view-model.js:165` 仍 `buildWeekOptions(payload.current_period_key)`；`rankings.js` 无 `data.first_period_key` 引用 |

### 依赖关系与建议实施顺序（审计当时）

- **Slice 6 是 Slice 7 的前置**：7.2 / 7.3 / 7.5 / 7.6 分别消费 6.1（`my_prediction`、`settlement_status`）、6.3（`first_period_key` 与本人指标）、6.4（`season_points`、`exact_hits`）。审计当时未补 6，故当时结论是 7 无数据可接、顺序不能颠倒。Slice 6 现已落地，见该切片正文；Slice 7 仍未做。
- **Slice 5 与上线功能解耦**：均为运维/性能项（连接池、缓存、定时任务拆分、数据清理），可独立排期，不阻塞功能上线。
- **风险分级**：6.1–6.4 以新增字段与契约为为主，改动面清晰；7.2（日期算术重写、完场文案解耦）与 7.5（Lv.1 进度条、`owned_count`）属**改造既有运行逻辑**，回归风险高于纯字段新增，应单独切片验收并做视觉/文案核对。
- 当时建议顺序：**Slice 6 → Slice 7 → Slice 5**。

### 本轮未覆盖范围

- **Slice 1 / 2 / 3 未做逐项审计**，本轮不给结论。
- Slice 4 的 5 项中，2–5 项已在代码中落地；仅「榜单快照精确截面 + 终榜 `head` 标记行」一项仍待做（现有实现为有界分页扫描 + 应用层过滤，不再是全表读取）。

---

## 附录：暂不纳入本轮阻断项（上线后按需跟进）

以下来自合并报告的 P3 低风险与体验微调项，不阻塞上线，可按排期后续处理：
- **L1**：联赛换季（UTC 7/1）与等级赛季（北京时间 7/1）的 8 小时边界差。
- **L2**：待核实上游 Provider 日额度重置时区后再调整 `provider/budget.ts`。
- **L4**：`CloudBaseWxDb.query` 无序翻页（仅切回 CloudBase 时需要）。
- **L5 / L6**：VPS systemd 模板用户名替换、服务器侧 PostgreSQL 定时 `pg_dump` 备份配置（属运维部署操作）。
- **核验三**：领奖台与前 20 重复、选择器遮挡更新时间、解锁页入口、180ms 切换防抖取消、详情“开球时间”文案、本赛季标签格式化。
