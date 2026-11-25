# 上线前二轮深度复审问题修复可执行开发文档（AI 落地指南 v3.0）

- **文档版本**：v3.0（2026-11-23）
- **基线来源**：基于 `docs/MINIPROGRAM_UX_DEV_PLAN__v1.0.md`、`docs/PRE_LAUNCH_FIX_DEV_PLAN__v1.0.md` 与 `docs/PRE_LAUNCH_FIX_DEV_PLAN__v2.0.md`（含 v2.0 Slice 0–5 全部落地改动）对全仓源码进行功能性、逻辑性与长短期运维隐患 Code Review 的 **18 项** 已核实缺陷（已剔除纯防御性与安全合规项）。
- **目标读者**：直接执行代码修改与验证的 AI Coding Agent / 开发者

---

## 前置：开发纪律与全量问题-切片总览

### 执行原则与校验门禁

1. **按切片顺序执行（Slice 1 → Slice 6）**：每个切片独立交付、独立验收；每个切片遵循 **TDD（先补失败复现测试 → 再实现修复）**。
2. **OpenAPI 契约先行**：涉及响应字段新增（Slice 4 的 `PredictionHistoryItem.home_team / away_team`），必须先修改 [openapi.yaml](../src/api/v1/openapi.yaml)，再修改后端服务与契约测试。
3. **视觉基线保护边界**：
   - Slice 1–5 严禁改动 `miniprogram/styles/design-tokens.wxss` 及首页冻结结构；
   - Slice 6 调整 `miniprogram/pages/matches/matches.wxss`（仅针对 `UX-01` 长中文队名换行展示）与 `matches.wxml`（仅针对 `submitError` 保护与 `summarySeasonId` 格式化）时，不得修改玻璃卡档位、`.bug` 实色、日期条 11 天与顶栏/联赛行间距，改完后须运行 `python3 docs/design/scripts/verify-home-migration.py` 并做视觉截图抽检。
4. **单切片必跑校验命令**（若容器内 `npm` 不在 `PATH`，直接使用 `./node_modules/.bin/`）：
   ```bash
   ./node_modules/.bin/tsc -p tsconfig.json --noEmit
   ./node_modules/.bin/tsc -p tsconfig.build.json --noEmit
   ./node_modules/.bin/tsc -p tsconfig.cloudfunction.json --noEmit
   ./node_modules/.bin/vitest run <本切片相关测试文件>
   git diff --check -- src miniprogram ops scripts
   ```
   全部切片完成后跑全量 `./node_modules/.bin/vitest run`（若无在线 PostgreSQL，需记录 6 个 `.pg.test.ts` 跳过，并在有 PG 的环境补跑）。

### 全部 18 项问题与目标切片对照表

| 编号 | 级别 | 问题摘要 | 关键位置 | 目标切片 |
| --- | --- | --- | --- | --- |
| #1 | P0 | 同周多场并发结算时 `rebuildGlobalRanks` 整行覆写丢失积分，且事务内持锁易触发 PG `25P02` | `settlement-item-application-service.ts`、`first/correction/retry-settlement-service.ts` | Slice 1 |
| #2 | P0 | `RebuildUserStatsService` 对已注销用户继续重放注销后周一评估，篡改冻结等级或在内存库崩溃 | `stats-rebuild-service.ts`、`profile-mutation.ts`、`repositories.ts` | Slice 1 |
| #3 | P1 | `WeeklyLevelEval` 未完时仍调 `runPending` 谎报完成，且无条件饿死 `Strength` 与 `SeasonFinal` 快照 | `weekly-level-eval.ts`、`level-correction-reeval.ts`、`scheduled-jobs.ts` | Slice 2 |
| #4 | P1 | 换季 24h 后清理任务误删上赛季常规快照致 `404`；截断仍推进周期、无续租、`auth_sessions` 未分批 | `maintenance-cleanup.ts`、`scheduled-jobs.ts`、`postgres-auth-sessions.ts` | Slice 2 |
| #5 | P1 | `RebuildPeriodRankingsService` 按赛季候选选赛漏掉历史及跨季延期比赛，重建周榜清零旧积分 + 全表扫 | `ranking-rebuild-service.ts`、`daily-consistency-snapshot.ts`、各仓储锚点区间查询 | Slice 2 |
| #6 | P1 | 结算进入 `RebuildRanks` / `Finalize` 前后缺少锁健康检查与事务内 DB 锁所有权围栏 | `first/retry/correction-settlement-service.ts` | Slice 1 |
| #7 | P1 | `board_snapshots` 查询 `COALESCE` 破坏 PG 复合索引，CloudBase 每次查榜触发 `O(N)` 终榜翻扫 | `postgres-document-db.ts`、`cloudbase-app-repository.ts`、`ranking-query.ts` | Slice 3 |
| #8 | P1 | CloudBase 历史扫描触限假返回 `has_more: false`（含客户端空页卡死）、同时间续扫游标停滞、兜底少 `match_id` 排序、`distinctQuery` 无序翻页 | `cloudbase-wx-db.ts`、`cloudbase-app-repository.ts`、`my-predictions.js/.wxml`、`indexes.ts` | Slice 3 |
| #9 | P1 | `DATA-01` 后端未落地：`PredictionHistoryItem` 缺 `home_team/away_team`，我的页仍发 N+1 详情请求，公共展示函数忽略服务端名称 | `prediction-query.ts`、`predictions.ts`、`openapi.yaml`、`my-predictions.js`、`profile.js`、`team-presentation.js` | Slice 4 |
| #10 | P1 | `groups.js` 创建第 1 个群成功后永不复位 `loadingAction`，永久阻塞创建第 2–5 个群 | `miniprogram/pages/groups/groups.js` | Slice 5 |
| #11 | P1 | `rankings.js` 历史赛季加群回跳死循环 `422`、跨周钉死 `selectedPeriodKey` 致 `422`、换号串态 | `miniprogram/pages/rankings/rankings.js` | Slice 5 |
| #12 | P1 | `formatKickoff` / `formatShanghaiKickoff` / `formatShanghaiDate` 仍依赖 `toLocaleString({ timeZone })` | `match-presentation.js`、`prediction-history.js`、`unlocks.js` | Slice 4 |
| #13 | P1 | 首页截单后不收起已打开编辑器；`my-predictions` 缺 `onShow`；`profile` 最近预测无并发序号与清空，模板仍渲染旧身份记录 | `matches.js`、`my-predictions.js`、`profile.js/.wxml` | Slice 5 + Slice 6 |
| #14 | P2 | `InMemoryRateLimiter` 单分钟活跃 key ≥ 1024 后每次请求退化为全 Map 扫描（$O(N^2)$） | `src/api/v1/rate-limit.ts` | Slice 3 |
| #15 | P2 | `groups/detail.js` 未就绪点转发崩溃，且 `detail`/`profile`/`rankings`/`unlocks` 多处缺 `.catch()` 卡死 | `detail.js`、`profile.js`、`rankings.js`、`unlocks.js` | Slice 5 |
| #16 | P2 | `matches.js` 成功后残留红字错误、失败残留昨日计数、收官按钮未跳赛季榜且 `summarySeasonId` 裸露下划线 | `matches.js`、`matches.wxml`、`rankings.js` | Slice 6 |
| #17 | P2 | `share-card.js` 重选未清 `roundIndex` 无法重选原轮次；`match-detail.js` `onShow` 与 `409` 不刷新大家怎么选 | `share-card.js`、`match-detail.js` | Slice 5 |
| #18 | P2 | 取消比赛误显「待结算」、主队队徽优先信旧缓存、首页长中文队名被省略号截断（`UX-01`/`UX-04`） | `my-predictions.js`、`match-detail.js`、`profile.js`、`matches.wxss` | Slice 4 + Slice 6 |

---

## Slice 1（P0）：并发结算防丢分、结算锁健康围栏与注销用户统计重建保护

- **覆盖问题**：`#1`、`#2`、`#6`
- **前置依赖**：无

### 1.1 同周并发结算防覆写丢分与事务外加锁（`#1`）

#### 现状问题
1. `FirstSettlementService.start`（`src/application/first-settlement-service.ts:459-467`）、`CorrectionSettlementService.correct`（`src/application/correction-settlement-service.ts:443-451`）与 `RetrySettlementService.retry`（`src/application/retry-settlement-service.ts:339-347`）均先开启 `this.repo.withTransaction(...)`，再在事务 `rankTx` 内部调用 `rebuildSettlementWeekRanks` → `rebuildGlobalRanks`（`src/application/settlement-item-application-service.ts:210-255`）。
2. `rebuildGlobalRanks` 在 `rankTx` 内调用 `tx.jobLocks.acquire/release`，若并发获取或更新失败抛错，PG 事务会进入 aborted 状态，随后 `finally` 中的 `jobLocks.release` 立即触发 `25P02: current transaction is aborted`，掩盖真实异常；且 `acquire` 竞争会阻塞在 PG 未提交行锁上。
3. 更致命的是：`ApplyItems` 阶段写 `rankings` **不持有** `ranking:week:{periodKey}` 锁，而 `rebuildGlobalRanks` 通过普通 `findByPeriod` 读取快照后，使用 `rankings.update({ ...item.entry, global_rank, updated_at })` 做整文档覆盖写。同周比赛 A 与 B 并发结算时，B 在 `RebuildRanks` 读到旧积分，A 提交 `ApplyItems` 增加积分，B 回写 `global_rank` 会把整条文档覆盖回旧积分，静默丢分。

#### 改造方案
1. **锁外移至事务之外，避免事务内持有 `jobLocks`**：
   - 将 `rebuildSettlementWeekRanks` 的签名调整为接收 `repo: AppRepository`（或抽出 `rebuildSettlementWeekRanksWithRepo(repo, periodAnchorAt, now)`）：先在事务外调用 `repo.jobLocks.acquire(rankingPeriodLockKey(PeriodType.Week, periodKey), ownerId, leaseUntil)`，再开启 `repo.withTransaction((rankTx) => ...)` 仅负责读取和更新排名，最后在最外层 `finally` 调用 `repo.jobLocks.release(lockKey, ownerId).catch(() => undefined)`（与 `RebuildPeriodRankingsService.rebuildBoardSnapshot` 模式一致）。
   - 同时保留供已在事务外/重建期已持锁场景复用的纯排名计算 helper `rebuildGlobalRanksInTransaction(tx, periodType, periodKey, now)`。
2. **仅原子局部更新 `global_rank`，禁止用旧快照整行覆写积分/命中字段**：
   - 在 `src/infrastructure/repositories.ts` 的 `RankingRepository` 新增方法：
     ```ts
     updateGlobalRank?(
       periodType: PeriodType,
       periodKey: string,
       userId: string,
       globalRank: number | null,
       updatedAt: Date,
     ): Promise<void>;
     ```
   - 在 `src/infrastructure/cloudbase-db.ts`、`src/infrastructure/postgres-document-db.ts`、`src/infrastructure/cloudbase-wx-db.ts` 与 `src/infrastructure/db-op-counter.ts` 提供**仅更新特定字段的原子 patch 能力**（绝不做“读取再整行覆写”）：
     - **PostgreSQL**：在 `rankTx` 事务内执行原子 `jsonb_set`，只更新 `global_rank` 与 `updated_at` 两个键，**绝不碰 `period_score`、`valid_predictions`、`wdl_hits`、`exact_hits`、`last_scoring_match_at`**：
       ```sql
       UPDATE <table>
       SET document = jsonb_set(
         jsonb_set(document, '{global_rank}', COALESCE(to_jsonb($4::int), 'null'::jsonb), true),
         '{updated_at}', to_jsonb($5::text), true
       )
       WHERE (document ->> 'period_type') = $1
         AND (document ->> 'period_key') = $2
         AND (document ->> 'user_id') = $3
       ```
     - **CloudBase（`CloudBaseWxDb`）**：利用微信云开发 `.doc(id).update({ data: { global_rank, updated_at } })` 原生局部字段更新能力新增 `patch?(collection, id, fields)`，仅原位修改 `global_rank` 与 `updated_at` 两个字段，严禁在读出后组装整文档写回；
     - **InMemory / 无 `patch` 事务退化路径**：必须在事务锁/单次同步读写内完成（`InMemory` 同 event-loop 同步读改写且仅改 `global_rank` / `updated_at`，或事务内按版本号冲突重试），不得在无并发隔离条件下“先读整行再整行写回”。
   - **同时补强同周并发的最终名次收敛**：如果 `rebuildGlobalRanks` 期间或紧接着有另一次 `applyInTransaction` 改变了分数，后提交的比赛进入自己的 `RebuildRanks` 会重新把整周 `global_rank` 算到最新（而先跑完的比赛不会抹掉后者的分数）；若需避免同周两个并发结算在 `RebuildRanks` 撞锁互报错，可在 `rebuildSettlementWeekRanks` 遇到 `rankingPeriodLockKey` 被同周另一场结算占用时做有界短退避重试（如最多 3 次、间隔 `50ms/100ms/200ms`，单测/内存库若需立即冲突行为可配置），仍撞锁再抛 `RANKING_REBUILD_ALREADY_RUNNING`。

### 1.2 `RebuildUserStatsService` 对已注销及已冻结等级的边界保护（`#2`）

#### 现状问题
- `src/application/stats-rebuild-service.ts:353-383`（Career）直接把 `untilAsOf: serverNow` 传给 `replayScope`；`437-449`（Season）仅把已冻结赛季的 `untilAsOf` 截断到 `seasonFinalEvalAsOf(seasonId)`。
- 一旦用户在赛季中通过 `ProfileMutationService.deleteMyProfile` 注销账号（`users.status = "deleted"` 且 `user_season_stats.is_level_frozen = true`），若后续赛果改判或管理员触发重建，`replayScope` 会把注销后每周一的降级继续重放进去：内存仓储在 `repositories.ts:2240-2245` 直接抛出 `INTERNAL_ERROR: 已冻结赛季的 level/best_level 不可修改`；PG/CloudBase 则静默篡改已注销用户的 `career_level` 和已冻结赛季等级。
- **从未评估的注销用户同样需要保护**：注销保留当时的等级与评估状态（`profile-mutation.ts:154-173`），而 `replayLevel` 会生成截止前的周评事件（`levels.ts:436-438`）。若首评因锁冲突跳过，用户仍为 `Lv1`、`last_eval_as_of = null`，之后才注销，直接以 `deleted_at` 截止重放仍会补造注销前未执行的周评并升至 `Lv2`；仅限制“注销后不评估”不足以保护冻结结果。

#### 改造方案
- 在 `src/application/stats-rebuild-service.ts` 新增辅助函数 `resolveScopeReplayUntilAsOf`：
  1. **Career 作用域**：若 `user.status !== UserStatus.Active`（已注销）且 `user.career_level_state?.last_eval_as_of != null`，取 `Math.min(serverNow.getTime(), user.career_level_state.last_eval_as_of.getTime(), (user.deleted_at ?? serverNow).getTime())` 对应的时间作为截止；若已注销且无 `last_eval_as_of`，使用无评估事件截止 `new Date(0)`，不得以 `deleted_at` 补做注销前未实际执行的周评。注销用户仅重算统计数字，保留持久化的 `career_level`、`career_best_level` 与 `career_level_state`，不新增周评或改判等级历史。
  2. **Season 作用域**：若 `oldStats.is_level_frozen === true` 或 `user.status !== UserStatus.Active`，先以 `serverNow`、`seasonFinalEvalAsOf(seasonId)` 与有效的 `user.deleted_at` 取较小值作为时间上界；若 `oldStats.level_state?.last_eval_as_of != null`，再取其与上述上界的较小值；若已注销且该作用域从未评估，则同样使用 `new Date(0)`，不得补造注销前周评。已有冻结行的等级及状态仍按下述保护规则原样保留。
  3. **保护已冻结行不被重复篡改**：当 `oldStats.is_level_frozen === true` 且 `existingSeasonIds.has(seasonId)` 时，仅允许重算统计数字（`points`、`valid_predictions`、`wdl_hits`、`exact_hits`、`last_scoring_match_at`），保持冻结时的 `level` / `best_level`（或确认 `level`/`best_level` 与冻结前一致且仅在发生实际前序改判并允许解冻重评时才变；对应 `WeeklyLevelEval` 与 `LevelCorrectionReeval` 均跳过已注销/已冻结用户的设计，`stats-rebuild-service` 对已冻结且已注销用户应严格维持其冻结等级与 `level_state` 不变，防止触发 `InMemoryRepository` 的 `已冻结赛季的 level/best_level 不可修改` 断言）。

### 1.3 结算进入 `RebuildRanks` / `Finalize` 前后补齐锁健康校验（`#6`）

#### 现状问题
- `FirstSettlementService.start`（`src/application/first-settlement-service.ts:453-508`）和 `RetrySettlementService.retry`（`src/application/retry-settlement-service.ts:333-388`）在进入耗时的 `rebuildSettlementWeekRanks` 后直至提交 `Finalize` 事务再无 `lockRenewal.assertHealthy()`。
- `CorrectionSettlementService.correct`（`src/application/correction-settlement-service.ts:438-493`）在进入 `RebuildRanks` 前缺失 `assertHealthy()`，在 `Finalize` 事务内也拖到两次 `tx.settlements.update` 写完之后（L467）才检查。

#### 改造方案
- 首先明确边界：`lockRenewal.assertHealthy()` 读取的是内存态异步续租失败标志（`FirstSettlementService:166-195`），若租约在后台刚过期且续租回调尚未返回，内存检查仍会放行；因此需要**内存快速失败 + 数据库写前所有权围栏**双层防护：
  1. **内存快速失败检查点**（在三个结算服务统一补齐）：
     - 更新 `SettlementPhase.RebuildRanks` 之前（`CorrectionSettlementService` 补上 L437）；
     - `rebuildSettlementWeekRanks` 完成之后、开启 `Finalize` 事务之前。
  2. **数据库级锁所有权围栏（`Finalize` 事务内部）**：
     - 在 `Finalize` 事务开启后、修改 `settlements` 状态为 `Finalize`/`Done` 与写入 `matches` **之前**，在事务内执行数据库锁所有权校验与续租围栏（例如调用 `await tx.jobLocks.renew(lockKey, ownerId, finalizeLeaseUntil)` 或专用事务内 `assertLockHeld`：在 PostgreSQL 下单条 `UPDATE job_locks ... WHERE _id = $1 AND owner_id = $2 AND lease_until > $3` 不仅校验当前仍为合法持有者，还对 `job_locks` 持有行级排他锁直至 `Finalize` 提交，阻塞并发 Worker B 抢占；若受影响行数为 0 返回 `false`，直接抛出 `SETTLEMENT_ALREADY_RUNNING` 回滚 `Finalize` 事务）。
     - 最后保留 `lockRenewal.assertHealthy()` 检查已知续租异常，形成可校验的写前防线。

### 1.4 验收测试
- `src/application/settlement-item-application-service.test.ts` & `src/infrastructure/postgres-document-db.pg.test.ts`：
  - 模拟同周比赛 A 的 `applyInTransaction` 在比赛 B `rebuildGlobalRanks` 读取之后、写入之前提交积分更新，验证比赛 B 使用局部更新写入新 `global_rank` 后**绝不会覆盖丢失**比赛 A 新增的 `period_score` / `valid_predictions` / `exact_hits`（覆盖 CloudBase `patch` 与 PG `jsonb_set`）；
  - 验证 `rankTx` 内模拟异常不会引发 `25P02` 掩盖原始报错。
- `src/application/rebuild-service.test.ts` & `stats-rebuild-service.test.ts`：构造用户在赛季中 `2026-10-15` 注销（`is_level_frozen = true`），将 `serverNow` 推进至 `2026-12-01`（跨多个周一）触发 `rebuildUserStats`，验证在 `InMemoryRepository` 与 `CloudBaseAppRepository` 下均不崩溃、不产生注销后 `level_history`、不改动已冻结等级，`DailyConsistency` 无差异。
  - 补充首评 `2026-08-03 10:00`（北京时间）、已有 20 条有效预测但首评因锁冲突跳过，用户于 `2026-08-05` 注销的场景：Career / Season 的 `last_eval_as_of` 均为空，之后重建仅更新统计数字，等级保持 `Lv1`、最佳等级与冻结状态原样保留，不补造 `2026-08-03` 周评或新增等级历史；同时覆盖已有 `last_eval_as_of` 的注销用户。
- `src/application/first-settlement-service.test.ts` / `correction-settlement-service.test.ts` / `retry-settlement-service.test.ts` & `.pg.test.ts`：模拟锁续租在 `rebuildSettlementWeekRanks` 期间失活（含内存续租回调尚未触发但 DB 锁已被 Worker B 接管的场景），验证 `Finalize` 事务内的锁围栏拦下旧持有者且不提交 `Settled/Done`。

---

## Slice 2（P1）：周期调度防饿死、改判协同收口、跨季清理安全与历史周榜重建

- **覆盖问题**：`#3`、`#4`、`#5`
- **前置依赖**：Slice 1

### 2.1 `WeeklyLevelEval` 协同 `runPending` 收口与快照防饿死（`#3`）

#### 现状问题
1. `src/application/weekly-level-eval.ts:430`：`await correctionReeval.runPending(asOf, serverNow)` 放在 `if (failedCount === 0 && settlementSkippedCount === 0 && deferredCount === 0)` 保护分支之外，向改判重评谎报本周评估已完成：一旦被跳过用户本周有改判单，要么抛 `SPEC_GAP` 崩溃，要么写入 `week_base_as_of = asOf` 导致后续补偿周评永久跳过该用户。
2. `src/application/level-correction-reeval.ts:314-334`（`runPendingInWindow`）：每次周评估调用 2 次 `settlements.findByStatus(Settled)` 全库拉取所有历史赛季改判单并逐单重查重算，且不续租外层周评锁。
3. `src/runtime/scheduled-jobs.ts:334-348`（`planDuePeriodicJobs`）：只要 `weeklyDue === true` 就无条件抑制独立的 `BoardSnapshotStrength` 与 `BoardSnapshotSeasonFinal`。若单用户失败或长期锁延期，全站 `Strength` 榜和赛季终榜被无限期饿死。

#### 改造方案
1. **收紧 `correctionReeval.runPending` 触发条件并用持久化状态标记替代全库线性扫**：
   - `src/application/weekly-level-eval.ts:430`：仅当 `failedCount === 0 && settlementSkippedCount === 0 && deferredCount === 0` 时才调用 `await correctionReeval.runPending(asOf, serverNow)`，禁止在部分失败/跳过时传入 `completedWeeklyAsOf = asOf`。
   - **持久化待重评标记（禁止用“只扫最近 7 天”截断漏扫）**：
     - 在 `SettlementDoc`（`src/domain/types.ts` & `src/schema/collections.ts`）新增可选字段 `level_reeval_completed_at?: Date | null`（或 `level_reeval_status?: "pending" | "completed" | null`）：
       - `CorrectionSettlementService` / `RetrySettlementService` 在 `is_correction === true` 的结算单创建/完成时置 `level_reeval_status: "pending"`；
       - `LevelCorrectionReevalService.runForSettlementInternal` 仅在整单全部活跃用户处理完毕（`kind === "completed"` 且无被跳过用户需要延后补偿）时将其更新为 `level_reeval_status: "completed"`（并记录 `level_reeval_completed_at`）；若遇锁冲突/部分未决/失败则保持 `"pending"`。
     - `runPendingInWindow` 仅查询未完成的已结算改判单（`is_correction === true && status === "settled" && level_reeval_status !== "completed"`；对早期无该字段的历史遗留单据在首次扫完并确认幂等无待办后批量/逐单标记为 `"completed"`，此后不再被任何周评估重复加载）；并在遍历结算单之间通过 `onStep?: () => Promise<void>` 回调续租外层 `WEEKLY_LEVEL_EVAL_LOCK_KEY`。这样即使某改判单因故障或停机超过 7 天甚至数周未重评，恢复后仍会被可靠补偿。
2. **`planDuePeriodicJobs` 引入宽限退避，防止单用户故障饿死全站快照与终榜**（`src/runtime/scheduled-jobs.ts:329-360`）：
   - 正常周一 `weeklyAsOf` 刚刚到点且在宽限窗口内（例如 `serverNow.getTime() - weeklyAsOf.getTime() < WEEKLY_INLINE_SNAPSHOT_GRACE_MS`，如 `60 * 60_000` = 1 小时）才允许用 `"inline_weekly_refresh"` 跳过独立的 `BoardSnapshotStrength` 和 `BoardSnapshotSeasonFinal`。
   - 一旦超过 1 小时 `weeklyDue` 仍未完成（说明周评估被个别用户异常/死锁阻塞），`planDuePeriodicJobs` 自动恢复独立调度 `BoardSnapshotStrength`（受自身 24h `snapshotIntervalMs` 约束，不会每 15 分钟刷爆）与 `BoardSnapshotSeasonFinal`，防止单个坏用户卡死全站实力榜与终榜。

### 2.2 `MaintenanceCleanupService` 跨季快照分组保留、截断续清与 `auth_sessions` 分批（`#4`）

#### 现状问题
1. `src/application/maintenance-cleanup.ts:221-245`（`cleanupBoardSnapshots`）：对 `board === RankingBoard.Season` 未按 `level_season_id` 分组，7 月 1 日换季 24 小时后新赛季生成 24 份快照，`keepBoundaryMs` 即越过 `2027-07-01` 把上赛季全部分常规快照删光，而在 `seasonFinalEvalAsOf`（最多晚 6 天）生成终榜之前，上赛季从 `available_level_seasons` 消失并报 `404 LEVEL_SEASON`。
2. `deleteInBatches` 触达 500 批（50w 行）上限截断后仅打日志，返回值无 `truncated` 标志；`runMaintenanceCleanupJob`（`scheduled-jobs.ts:825-827`）照常推进 24h 周期，积压数据延迟 24 小时才能再清。
3. 清理全部集合期间（最高 4,000 条 SQL）持 10 分钟锁但从未调用 `jobLocks.renew`；`authSessions.deleteExpiredBefore`（`postgres-auth-sessions.ts:70`）是无 `LIMIT` 全表条件删除，积压时易超时阻断后续清理。

#### 改造方案
1. **按 `level_season_id` 独立保留赛季常规快照**（`src/application/maintenance-cleanup.ts:212-248`）：
   - 当 `board === RankingBoard.Season` 时：
     - 先查出已生成终榜的赛季集合（通过 `boardSnapshots.listFinalSeasonIds()` 或查询 `{ board: "season", is_final: true, snapshot_kind: "head" }`）；
     - 将查询字段从 `["snapshot_at"]` 扩展为 `["level_season_id", "snapshot_at"]`，按 `level_season_id` 分别汇总 `distinctMs` 并各自独立保留最近 `24` 个 `snapshot_at`；
     - **关键保护**：对**尚未**生成 `is_final: true` 终榜的历史赛季（`level_season_id` 仍在等待 `seasonFinalEvalAsOf`），至少强制保留其最新若干份（或暂不清理）常规快照，绝不删空导致 7 月初 404。
2. **`truncated` 状态与锁续租**：
   - `deleteInBatches` 返回 `{ deleted: number; truncated: boolean }`，并在每次批次循环间隙检查/续租 `sync:maintenance_cleanup` 锁（如每 10 批或间隔 2 分钟调用 `onBatchProgress?.()` 续租，续租失败立即抛出中止）。
   - `MaintenanceCleanupResult` 增加 `truncated: boolean`；`runMaintenanceCleanupJob`（`scheduled-jobs.ts:825`）仅当 `!result.truncated` 时调用 `markPeriodicCycle(runtime, MAINTENANCE_CLEANUP_CYCLE_KEY, serverNow)`，否则留待下一个 periodic tick 继续消化积压。
3. **`auth_sessions` 分批删除**（`src/infrastructure/postgres-auth-sessions.ts:70, 110-116`）：
   - 为 `deleteExpiredBefore(cutoff: Date, options?: { limit?: number })` 增加可选 `limit`：
     ```sql
     DELETE FROM <table>
     WHERE token IN (
       SELECT token FROM <table> WHERE expires_at < $1 LIMIT $2
     )
     ```
   - `MaintenanceCleanupService` 循环分批调用 `authSessions.deleteExpiredBefore(authCutoff, { limit: this.batchSize })`（最多 `maxBatchesPerTarget` 批，兼容无 `limit` 的轻量实现），同步纳入 `truncated` 与续租计数。

### 2.3 `RebuildPeriodRankingsService` 按周期时间窗选赛与对账周榜裁剪（`#5`）

#### 现状问题
1. `src/application/ranking-rebuild-service.ts:181-193`：按 `activeSeasonIds(league, serverNow)` 加载比赛，到 2028 年重建 2026 年历史周榜时因 `"2026"` / `"2026_2027"` 已退出活跃窗口而漏载比赛，第 278–295 行把未在重建集合内的该周历史用户积分与排名**全部覆写清零**。
2. `selectTargetItems`（L76-92）全表扫 `settlementItems.findByStatus(Applied)` 后 N+1 查 `settlements.findById`；`daily-consistency-snapshot.ts:834` 全表 `tx.rankings.findAll()` 再内存丢弃早于 `completeCoverageStart` 的历史周。
3. **`windowSeasonIds` 不能作为实际比赛的完整赛季集合**：`config.ts:453` 仅推导日期所属赛季及上一赛季，但改期保留比赛原 `season_id`（`provider-status-sync.ts:348`），开赛时再写 `period_anchor_at`（L775）。例如 `2024_2025` 的比赛延期至 `2026-W35` 开赛，日期候选只含 `2025_2026` / `2026_2027`，仍会漏载并触发历史周榜清零。

#### 改造方案
1. **`rebuildPeriodRankingsWhileHoldingRankingLock` 直接按 `period_anchor_at` 时间窗选赛**：
   - 计算 `[periodStartAt(periodType, periodKey), periodEndAt(periodType, periodKey))`，在 `MatchRepository` 新增按锚点区间查询的方法（如 `findByPeriodAnchorWindow(startAt, endAt)`），并补齐 InMemory / PostgreSQL / CloudBase 实现与所需索引，直接查询实际锚点落在该周期的比赛，再按既有联赛范围及 `calculatePeriodKey(periodType, match.period_anchor_at) === periodKey` 核对目标集合。
   - 查询必须跨原始 `season_id`，不得先用 `activeSeasonIds` 或 `windowSeasonIds` 缩小赛季范围；不得把“只有 1–2 个历史赛季”作为完整性前提。`windowSeasonIds` 可继续用于其他日期候选逻辑，但不再承担历史周榜选赛的完整性保证。
2. **消除 `selectTargetItems` 全库扫与 N+1**：
   - 利用 `tx.settlements.findByMatchIds`（若可用）一次性取 `selectedMatches` 关联的 `settlements`，再用 `tx.settlementItems.findBySettlementIdsAndStatus(settlementIds, SettlementItemStatus.Applied)` 批量拉取目标周期明细，彻底消除全库 `findByStatus(Applied)`。
3. **裁剪 `loadDailyConsistencySnapshot` 的 `rankings` 全表读取**（`src/application/daily-consistency-snapshot.ts:834`）：
   - 在 `RankingRepository` 新增可选方法 `findWeekEntriesSince?(minPeriodKey: string, includeUnfinalized?: boolean): Promise<RankingEntry[]>`（PostgreSQL / CloudBase 用 `period_type = 'week'` 且 `period_key >= minPeriodKey OR is_final = false` 查询），在 `daily-consistency-snapshot.ts:834` 优先调用该方法替代无边界 `tx.rankings.findAll()`。

### 2.4 验收测试
- `weekly-level-eval.test.ts` & `level-correction-reeval.test.ts` & `scheduled-jobs.test.ts`：
  1. 模拟第 1 个用户 `settlement_already_running` 跳过且本周存在已结算改判单，验证 `WeeklyLevelEvalService.run` 不抛 `SPEC_GAP` 也不误写 `week_base_as_of = asOf`，下轮全部用户解锁后成功补齐本周评估与改判重评，并将该改判单持久标记为 `level_reeval_status: "completed"`。
  2. 模拟某笔改判单重评失败或系统停机跨过 2 周（> 7 天）后恢复运行 `WeeklyLevelEvalService.run`，验证仍能正常补偿完成该历史待重评改判单，而已完成标记的更早改判单不再重复扫描。
  3. 模拟某个用户持续抛 `INVALID_LEDGER` 超过宽限期（> 1 小时）后，`planDuePeriodicJobs` 不再一直用 `"inline_weekly_refresh"` 抑制 `BoardSnapshotStrength` 与 `BoardSnapshotSeasonFinal`。
- `maintenance-cleanup.test.ts` & `postgres-auth-sessions.test.ts`：
  3. 模拟 7 月 1 日跨季后新赛季已有 25 份快照而上赛季尚无终榜，验证 `cleanupBoardSnapshots` **保留**上赛季最新常规快照不误删；模拟超过 `maxBatches * batchSize` 积压时 `truncated === true` 且不推进 `MAINTENANCE_CLEANUP_CYCLE_KEY`；验证 `authSessions.deleteExpiredBefore` 带 `limit` 分批删除 SQL。
- `ranking-rebuild.test.ts` & `daily-consistency-snapshot.test.ts`：
  4. `serverNow = 2028-02-15` 时调用 `RebuildPeriodRankingsService.rebuild("week", "2026-W35", ...)`，验证 2026 年中超与跨年联赛历史积分均完整保留、不被清零，且不再调用 `settlementItems.findByStatus(Applied)`。
  5. 构造 `season_id = "2024_2025"`、实际 `period_anchor_at` 落在 `2026-W35` 的跨季延期比赛，验证不依赖日期候选赛季也能加载其结算及 Applied 明细，保留该周积分与名次；锚点不在目标周的比赛不得混入。

---

## Slice 3（P1/P2）：索引修复、CloudBase/PG 翻页去重加固与限流防退化

- **覆盖问题**：`#7`、`#8`、`#14`
- **前置依赖**：Slice 1、2

### 3.1 `board_snapshots` PG 索引命中修复与消除 CloudBase 终榜翻扫（`#7`）

#### 现状问题
1. `src/infrastructure/postgres-document-db.ts:539`（`compileLatestRegularBoardSnapshot`）使用 `COALESCE(${isFinal}, false) = false`，而 `ix_board_snapshots_season_final`（`src/schema/indexes.ts:288` & `postgres-schema.ts:44`）的索引列表达式为裸 `((document ->> 'is_final')::boolean)`。表达式不匹配导致 PG 无法命中该多列索引，退化扫描 `ix_board_snapshots_rank`。
2. `src/application/ranking-query.ts:664, 690-692` 每次 `GET /v1/rankings` 均并发执行 `findLatestBySeason(previousSeasonId)`。在 CloudBase 上 `findLatestRegularSnapshots`（`cloudbase-app-repository.ts:973-995`）未带 `is_final: false` 过滤，上赛季一旦写入 `N` 行终榜（时间戳最新），每次查询都要按 `OFFSET 0, 100, 200...` 翻扫全部 `N` 行终榜，然后第 690 行在终榜已存在时又把结果直接丢弃。

#### 改造方案
1. **PG 表达式对齐**：`src/infrastructure/postgres-document-db.ts:539` 将 `COALESCE(${isFinal}, false) = false` 改为 `${isFinal} = false`（`collections.ts:649` 已强制 `is_final` 为必填布尔字段，默认 `false`；对于极早期若存在缺失 `is_final` 的历史表可在迁移脚本一次性 `UPDATE ... SET document = jsonb_set(document, '{is_final}', 'false'::jsonb)` 补齐，线上代码直接命中索引）。
2. **CloudBase 下推过滤**：`src/infrastructure/cloudbase-app-repository.ts:973-975` 的 `findLatestRegularSnapshots` 在 `baseFilter` 中直接加入 `is_final: false`。
3. **查询短路跳过冗余读取**：`src/application/ranking-query.ts:664-692` 中先获取 `previousSeasonFinalVersion`（可与 `careerVersion`/`currentSeasonVersion` 同轮并发，而 `previousSeasonRegularVersion` 改为仅当 `previousSeasonFinalVersion.length === 0` 时再按需查询），彻底消除终榜就绪后每次 `GET /v1/rankings` 对上赛季常规快照的无效读取。

### 3.2 CloudBase 历史分页续扫、兜底双键排序与 `distinctQuery` 稳定排序（`#8`）

#### 现状问题
1. `src/infrastructure/cloudbase-wx-db.ts:323-415`：带联赛/赛季筛选时若前 64 批（6,400 行）内未凑够一页，`findPredictionHistoryPage` 直接返回已命中的 `<= limit` 条；`PredictionHistoryQueryService.listMyPredictions`（`prediction-query.ts:296`）见 `rows.length <= input.limit` 便误返回 `has_more: false, next_cursor: null`，导致旧预测永久不可达。
2. `src/infrastructure/cloudbase-app-repository.ts:1022-1026`：`findSettlementFallbackPage` 退化查询仅传 `{ order_by: "kickoff_at" }` 缺少次级排序键 `match_id`，同开球时间比赛多于单批 `limit` 时，推进兜底游标会永久漏掉较小 `match_id` 比赛。
3. `src/infrastructure/cloudbase-wx-db.ts:436`：`distinctQuery` 使用 `.skip(offset).limit(PAGE_SIZE)` 但完全没有 `.orderBy(...)`，在并发同步写 `matches` 时分页游走不稳定、易漏赛季/轮次。
4. **续扫游标可能不推进**：`findPredictionHistoryPage` 每次调用将 `offset` 归零，仅下推 `submitted_at <= cursor.submitted_at`，取回批次后才按 `prediction_id` 过滤；同一 `submitted_at` 的记录超过单次扫描上限时，下一次请求仍会读回入口游标之前的同一批记录，反复返回相同游标，即使增加 `resumeCursor` 也无法取得后续数据。

#### 改造方案
1. **历史扫描触限续扫协议**：
   - 在 `src/infrastructure/cloudbase-db.ts` 与 `src/infrastructure/repositories.ts` 扩展可选返回（或增加 `findHistoryPageWithScanResume` / 让 `findPredictionHistoryPage` 返回 `{ documents: CloudBaseDocument[]; exhausted: boolean; resumeCursor: { submitted_at: Date; prediction_id: string } | null }`）。
   - 当 `CloudBaseWxDb.findPredictionHistoryPage` 因 `batches >= this.historyMaxBatches && !exhausted` 提前退出且 `selected.length < params.limit` 时，返回 `resumeCursor = cursor`（最后扫描到的位置，保证严格晚于后续未扫描行且小于入口游标）。
   - **双键游标必须下推至数据库查询**：采用 `(submitted_at DESC, prediction_id DESC)` 稳定排序，入口游标为 `(T, ID)` 时以 `submitted_at < T OR (submitted_at = T AND prediction_id < ID)` 查询，并与 `user_id` 等既有条件正确组合；补齐 CloudBase 查询条件表达、对应复合索引与测试 mock。禁止仅用 `submitted_at <= T` 再在内存过滤 ID，否则每次从 `offset = 0` 开始仍会重复扫描同一批。每个非终止续扫响应的游标必须按上述顺序严格推进，不能返回原入口游标。
   - `PredictionHistoryQueryService.listMyPredictions`：当底层返回 `hasMore` 或 `resumeCursor !== null` 时，输出 `has_more: true` 并用 `resumeCursor` 编码 `next_cursor`（注意当 `selected.length === 0` 时返回 `items: [], has_more: true, next_cursor` 让客户端/翻页可继续向后推进，避免永远丢弃早期记录）。
   - **同步改造客户端 `my-predictions.js` & `my-predictions.wxml` 空页续扫闭环**（必须与后端游标协同落地）：
     - 当前 `my-predictions.js:192` 用 `items.length === 0 ? "empty" : "list"`，且 `my-predictions.wxml:24-31` 的 `empty` 态只有「去预测」按钮、没有「加载更多」，导致若首屏（或某页）返回 `items: [], has_more: true, next_cursor` 时用户会被死锁在「还没有预测记录」无法继续拉取后续记录。
     - 修复：在 `my-predictions.js` 的 `applyListResult` 中，当收到 `nextItems.length === 0 && page.has_more === true && page.next_cursor` 时：
       1. 自动续扫下一页（设置递增游标并限制单次交互内最大静默空扫页数，如 `MAX_EMPTY_SCAN_PAGES = 5`）；
       2. 若达到静默空扫上限后累计 `items.length` 仍为 `0` 且 `hasMore === true`，**不得进入纯 `empty` 死胡同**——应保持可续扫状态（或扩展 `my-predictions.wxml` 的 `empty` / 独立扫描提示区展示「加载更早记录」按钮触发 `onMore`），只有当 `items.length === 0 && !hasMore`（后端已耗尽全量记录）时才展示最终空态。
2. **`findSettlementFallbackPage` 双键稳定排序**：
   - `src/schema/indexes.ts:207` 检查并将 `ix_matches_status_kickoff` 扩展为 `["match_status", "kickoff_at", "match_id"]`。
   - `src/infrastructure/cloudbase-app-repository.ts:1022-1026` 传入 `order_bys: [{ field: "kickoff_at", direction: "asc" }, { field: "match_id", direction: "asc" }]`（兼容仅支持单键 `order_by` 的 stub 时退化保留 `{ order_by: "kickoff_at", ... }`）。
3. **`distinctQuery` 确定性排序**：
   - `src/infrastructure/cloudbase-wx-db.ts:433-436` 增加 `.orderBy("_id", "asc")`（若云函数 SDK mock 无 `.orderBy` 则判 `typeof query.orderBy === "function"` 后调用），确保跨批次遍历顺序稳定。

### 3.3 `InMemoryRateLimiter` 动态清理高水位（`#14`）

#### 现状问题
- `src/api/v1/rate-limit.ts:81`：`if (this.windows.size >= PRUNE_SIZE_THRESHOLD || nowMs - this.lastPruneAt >= ONE_MINUTE_MS)`。当 1 分钟内活跃 key ≥ 1,024 时（窗口未过期，一次也删不掉），**每一次**请求都会触发全量遍历 `this.windows`，退化为 $O(N^2)$。

#### 改造方案
- 在 `InMemoryRateLimiter` 增加 `private nextPruneSize = PRUNE_SIZE_THRESHOLD;` 与最小冷却间隔 `PRUNE_COOLDOWN_MS = 10_000`：
  - 触发条件改为：`nowMs - this.lastPruneAt >= ONE_MINUTE_MS || (this.windows.size >= this.nextPruneSize && nowMs - this.lastPruneAt >= PRUNE_COOLDOWN_MS)`；
  - `pruneExpired(nowMs)` 执行后重置 `this.nextPruneSize = Math.max(PRUNE_SIZE_THRESHOLD, this.windows.size * 2)`（若大量过期回收导致 `size < 512`，自然回到 `PRUNE_SIZE_THRESHOLD = 1024`），保证高并发突刺下均摊 $O(1)$ 复杂度且内存严格有界。

### 3.4 验收测试
- `postgres-document-db.test.ts` & `postgres-schema.test.ts`：校验 `compileLatestRegularBoardSnapshot` 不含 `COALESCE`，与 `ix_board_snapshots_season_final` 表达式一致；`ranking-query.test.ts` 验证有终榜时不再调用 `findLatestBySeason(previousSeasonId)`。
- `cloudbase-wx-db.test.ts` & `cloudbase-repository.test.ts` & `prediction-list.test.ts` & `my-predictions.test.mjs`：
  - 构造前一批 0 命中、后续批才有命中的记录集并触发 `historyMaxBatches = 1`，验证服务端返回 `items: [], has_more: true, next_cursor`，次轮续扫可取回全部命中项；
  - 构造 250 条相同 `submitted_at` 的记录、`historyMaxBatches = 1`，前 100 条不符合联赛筛选、后续包含命中项：连续请求中数据库双键边界严格推进、游标不重复，最终完整取得命中项并返回耗尽状态，无重复或漏行；验证 CloudBase 查询实际应用时间与 ID 的组合条件，而非测试夹具预先过滤。
  - 验证 `my-predictions.js` 在首屏返回 `items: [], has_more: true, next_cursor` 时会自动续扫并在后续页命中后正常渲染 `state: "list"`，不会停在死胡同 `state: "empty"`；只有 `has_more: false` 时才展示最终空态；
  - 构造相同 `kickoff_at` 多场完场赛（超过单批 `limit`），验证 `findSettlementFallbackPage` 按 `(kickoff_at, match_id)` 升序无漏行；验证 `distinctQuery` 调用 `.orderBy("_id", "asc")`。
- `rate-limit.test.ts`：同一分钟写入 2,000 个活跃身份后再请求 200 次，断言 `pruneExpired` 不会随请求次数线性扫描 2,000 条（仅触发常数次）。

---

## Slice 4（P1/P2）：`DATA-01` 全链路落地、纯 `UTC+8` 时间格式化与取消态/主队缓存修正

- **覆盖问题**：`#9`、`#12`、`#18`（非首页视觉部分）
- **前置依赖**：Slice 3

### 4.1 `DATA-01` 补齐：`PredictionHistoryItem` 返回 `home_team` / `away_team`（`#9`）

#### 现状问题
- `docs/MINIPROGRAM_UX_DEV_PLAN__v1.0.md` §6 `DATA-01` 要求 `PredictionHistoryItem` 由服务端批量查询 `teams` 后返回 `home_team` / `away_team`（`{ team_id, name }`），并移除「我的页」最近预测的 `getMatchDetail` N+1 查询。当前接口未实现该字段，导致：
  1. 非 112 队静态表内的升降级/历史球队（含图集已有 `长春亚泰`/`梅州客家`/狼队等）在 `my-predictions.js` 显示「球队资料待补全」+ 占位队徽；
  2. `profile.js:321` 对最近预测并发调 `getMatchDetail`，遇到 429/错误时连阿森纳/切尔西都退化为「球队资料待补全」。
  3. `miniprogram/utils/team-presentation.js:9-10` 的 `presentTeam` 仅使用静态注册表的 `name_zh`，忽略服务端 `team.name` 并将非注册球队标记为 `missing: true`；即使历史接口已透传 `{ team_id, name: "长春亚泰" }`，只改页面传参也仍显示「球队资料待补全」。

#### 改造方案
1. **OpenAPI 契约（`src/api/v1/openapi.yaml`）**：
   - 在 `PredictionHistoryItem`（L2174-2237）补充可选或必选属性 `home_team` 与 `away_team`（结构与 `MatchListItem.home_team` / `TeamSummary` 对齐：`{ team_id, name }`，保留 `home_team_id` / `away_team_id` 兼容旧字段）。
2. **后端查询与序列化**：
   - `src/application/prediction-query.ts`：
     - `PredictionHistoryItem` 接口补充 `home_team: { team_id: string; name: string }` 与 `away_team: { team_id: string; name: string }`。
     - `PredictionHistoryQueryService` 的 `repo` 依赖补充 `teams?: AppRepository["teams"]`（并在 `src/gateway/assemble.ts` / `src/runtime/application-runtime.ts` 等构造处确认已传入完整 `repo`，含 `teams`）。
     - 在 `listMyPredictions`（L299-341）收集当页唯一 `home_team_id` 与 `away_team_id`，使用 `teams.findByIds` 一次批量加载进 `Map<string, Team>`（无 `findByIds` 时去重并发回退 `findById`），映射为 `{ team_id, name: team?.name ?? "" }`。
   - `src/api/v1/predictions.ts:225-247`（`toPublicPredictionHistoryItem`）：透传 `home_team` 与 `away_team`。
3. **小程序端消费（`my-predictions.js` & `profile.js`）**：
   - `miniprogram/pages/my-predictions/my-predictions.js:33-41`：新增 `resolveHistoryTeam(teamObj, teamId)`，优先使用 `teamObj && teamObj.team_id ? teamObj : historyTeam(teamId)`，既优先享受注册表中文名（`team_id` 命中 `TEAM_REGISTRY`），又对非注册表球队保留服务端原名 `team.name` 用作 `getTeamLogo(leagueId, team)` 解析 packaged crest 与展示。
   - `miniprogram/pages/profile/profile.js:317-341`（`loadRecentPredictions`）：移除 `getMatchDetail` 的 N+1 扇出请求（同时清理不再使用的 `getMatchDetail` import），直接消费 `item.home_team` / `item.away_team`（兜底 `{ team_id: item.home_team_id, name: (findTeam(item.home_team_id) || {}).source_name }`），彻底消除最近预测的 N+1 调用与 429 降级空白。
4. **公共展示函数同步消费服务端名称（`miniprogram/utils/team-presentation.js`）**：
   - `presentTeam(team, leagueId)` 的名称优先级固定为“注册表有效 `name_zh` → 有效服务端 `team.name` → `MISSING_NAME`”；有效服务端名称须为去除首尾空白后非空、且不等于缺失提示的字符串。
   - `missing` 与最终名称来源同步：命中注册表中文名或有效服务端名称时为 `false`，仅两者均缺失时为 `true`；不得继续以 `!found` 判断名称缺失，也不得将缺少徽章等同于名称缺失。继续把服务端名称传给 `getTeamLogo` 解析现有 packaged crest。

### 4.2 全量消除剩余 `toLocaleString` / `toLocaleDateString`（`#12`）

#### 现状问题
- `miniprogram/utils/match-presentation.js:13-24`（`formatKickoff`）、`miniprogram/utils/prediction-history.js:17-29`（`formatShanghaiKickoff`）与 `miniprogram/pages/unlocks/unlocks.js:64-74`（`formatShanghaiDate`）仍调用带 `{ timeZone: "Asia/Shanghai" }` 的 `toLocaleString` / `toLocaleDateString`，在缺少 ICU 数据的微信基础库上会抛 `RangeError` 导致详情/历史/我的/解锁页崩溃，或在非 UTC+8 设备上输出错乱时区/英文格式。

#### 改造方案
- 在 `miniprogram/utils/match-presentation.js` 使用纯 `UTC+8` 算术重写 `formatKickoff(value)`（并导出 `formatShanghaiDate(value)` 供 `unlocks.js` 复用，或内联同一纯算术实现）：
  ```js
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatKickoff(value) {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return "";
    const d = new Date(time + SHANGHAI_OFFSET_MS);
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日${WEEKDAYS[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }

  function formatShanghaiDate(value) {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return "";
    const d = new Date(time + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`;
  }
  ```
- `miniprogram/utils/prediction-history.js:17-29` 改为复用或使用完全一致的纯 `UTC+8` 算术 `formatShanghaiKickoff`（注意检查各测试单测的 `require` shim 白名单，避免因新增跨文件 `require` 破坏旧测试隔离夹具；若单测禁止新增 `require`，在对应工具内保持无依赖纯算术实现即可）。
- `miniprogram/pages/unlocks/unlocks.js:64-74` 的 `formatShanghaiDate` 改为纯 `UTC+8` 算术。

### 4.3 取消/延期比赛文案修正与 `profile.js` 主队缓存自愈（`#18` 非首页视觉部分）

1. **取消/延期/腰斩预测状态修正（`UX-04`）**：
   - `miniprogram/pages/my-predictions/my-predictions.js:44-62`、`miniprogram/pages/profile/profile.js:335-338`、`miniprogram/pages/match-detail/match-detail.js:194-203`：
     - 统一先判断 `item.match_status === "cancelled"`（或 `match.settlement_status === "voided"`）：`actualText` / `pointsText` 显示 `"—"`（或 `"不计分"`），`resultText` 显示 `"比赛取消 · 不计分"`；
     - 对于 `item.match_status === "postponed"` / `"abandoned"` 且 `match_score === null` 时，避免一律显示误导性的 `"等待比赛结算"`，显式按映射展示：
       - `postponed` → `"比赛延期"`
       - `abandoned` → `"比赛腰斩"`
2. **`profile.js:loadFavoriteTeam` 注册表优先修正旧缓存（`MINIPROGRAM_UX_DEV_PLAN__v1.0.md` §3.3）**：
   - `miniprogram/pages/profile/profile.js:239-263`：先查询 `findTeam(teamId)`；对已注册球队且 `getTeamLogo` 解析出有效路径（`!== PLACEHOLDER`）时，直接展示并覆写校准本地 `team_logo:<id>` 与 `team_name:<id>` 缓存，不再被历史上写歪的非占位缓存提前 `return` 阻塞。未录入注册表的冷门球队才回退缓存或 `listMatches`。

### 4.4 验收测试
- `src/api/v1/openapi-predictions.test.ts` & `src/api/v1/prediction-list.test.ts` & `src/application/prediction-query.test.ts`：校验 `PredictionHistoryItem` 返回 `home_team` / `away_team`（`teams.findByIds` 仅 $O(1)$ 批调用），且符合 OpenAPI schema。
- `miniprogram/pages/my-predictions/my-predictions.test.mjs` & `profile.team-logo.test.mjs`：验证非 `TEAM_REGISTRY` 球队（如长春亚泰）通过服务端 `home_team`/`away_team` 正确解析徽章与名称；`profile.loadRecentPredictions` 不再调用 `getMatchDetail`；`loadFavoriteTeam` 覆盖校正错误 `team_logo:<id>` 缓存；取消比赛不显示「待结算」。
- 公共 `presentTeam` 单测及上述两页集成测试：注册球队中文名优先于服务端原名；未注册 ID 配有效服务端名称时 `nameZh === "长春亚泰"`、`missing === false`；未注册且名称为空白/缺失提示时回退 `MISSING_NAME`、`missing === true`；名称有效但徽章未命中时仍正常显示名称，不误报名称缺失。
- `miniprogram/utils/match-presentation.test.mjs` & `prediction-history.test.mjs` & `unlocks.test.mjs`：Stub 禁用 `Date.prototype.toLocaleString` / `toLocaleDateString` 并在 `TZ=UTC` / `TZ=Etc/GMT+8` / `TZ=Etc/GMT-13` 下验证 `formatKickoff`、`formatShanghaiKickoff`、`formatShanghaiDate` 输出恒定北京时间。

---

## Slice 5（P1/P2）：小程序榜单状态机、群组页面、登录回流与异步防护闭环

- **覆盖问题**：`#10`、`#11`、`#13`（`my-predictions` / `profile` 部分）、`#15`、`#17`
- **前置依赖**：Slice 4

### 5.1 群组创建卡死、分享崩溃与全站缺失 `.catch()` / 并发序号补齐（`#10`、`#13`、`#15`）

1. **`miniprogram/pages/groups/groups.js:35-85`**：
   - `loadGroups()` 开头重置 `loadingAction: false`，补 `.catch(() => this.setData({ state: "error", loadingAction: false, errorMessage: COPY.groupLoadFailed }))`；
   - `onCreateTap()` 在 `201` 跳转前执行 `this.setData({ loadingAction: false })`，并补 `.catch(() => this.setData({ loadingAction: false, errorMessage: COPY.groupActionFailed }))`。
2. **`miniprogram/pages/groups/detail.js:43-117`**：
   - `loadGroup()` 未就绪或失败时调用 `wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] })`，就绪时调用 `wx.showShareMenu(...)`；`onShareAppMessage()` 在 `!group || !group.invite_code` 时返回 `{ title: COPY.groupSharedTitle, path: "/pages/groups/groups" }` 防 `TypeError`；
   - `loadGroup()` 与 `confirmAction()` 补 `.catch()` 复位 `state: "error"` / `loadingAction: false`。
3. **补齐其他页面异步 `.catch()` 与并发防护**：
   - `miniprogram/pages/profile/profile.js`：
     - `loadPage()` 在进入 `unauthorized` / `userDeleted` / `userNotFound` / `rateLimited` / `error` 时同步清零 `userId: "", nickname: "", avatarText: "球"`（避免 `.welcome` 渲染旧用户身份）；
     - `loadRecentPredictions()` 增加单调 `this.recentRequestSerial`，进入时同步重置 `recentState: "loading", recentPredictions: []`；成功、非成功响应与 `.catch()` 均核对序号及当前登录代次，丢弃旧身份请求的所有回写。换身份或进入未登录/注销态时递增序号使在途旧请求失效，并清空数组，不能只清 `userId` / 昵称。
     - **最近预测展示闭环（`profile.wxml:32`）**：当前列表循环独立于 loading/error 提示，可能在 B 的资料先成功、最近预测仍等待或失败时继续展示 A 的预测。将记录循环放在 `recentState === "ready"` 的条件容器内；加载/错误分支只显示对应提示，且数组已清空。
     - `onCreateGroupTap()` 增加 `if (this.data.state !== "ready" || this.data.groupCreating) return;` 防连点，校验 `result && result.statusCode === 201 && result.data && result.data.group_id`，先置 `groupCreating: false` 再跳转，并补 `.catch()` 恢复错误文案。
   - `miniprogram/pages/my-predictions/my-predictions.js`：
     - `loadFilters()` 增加单调 `this.filterRequestSerial` 防旧失败覆盖新成功；
     - `loadFirstPage()` 补 `.catch(() => this.applyListResult({ statusCode: 0, code: "NETWORK_ERROR" }, true, serial))`。
   - `miniprogram/pages/rankings/rankings.js`：`loadFirstPage()` 与 `onMore()` 补 `.catch()`，失败时（非分页）切 `"error"` 或（分页时）保持 `"list"` 且复位 `loadingMore: false`。
   - `miniprogram/pages/unlocks/unlocks.js`：`loadPage()` 补 `.catch(() => this.setData({ state: "error", errorMessage: "网络异常，请重试" }))`。

### 5.2 `rankings.js` 跨周/历史跳转死循环与换号串态根治（`#11`）

- 位置：`miniprogram/pages/rankings/rankings.js`
1. **消费 `pending_ranking_group_id` 时复位不兼容的榜种与赛季参数**：
   - 注意 `userChangedSeason`、`autoSeasonFallback`、`invalidGroupIds` 均属于 `Page` 实例字段（`this.userChangedSeason` 等，定义在 `rankings.js:146-148`，**不是** `this.data` 字段）；必须直接赋值复位实例属性，再调用 `this.setData(...)`：
     ```js
     this.userChangedSeason = false;
     this.autoSeasonFallback = false;
     this.userSelectedWeek = false;
     this.setData({
       scope: "group",
       groupId: pendingGroupId,
       board: "week",
       selectedLevelSeasonId: null,
       selectedPeriodKey: null,
     }, () => this.loadFirstPage());
     ```
     避免从历史赛季榜（`board: "season", selectedLevelSeasonId: "2025_2026"`）加群回跳后永久触发 `422`。
2. **解耦「当前默认周」与「用户手选历史周」**：
   - 增加页面实例标记 `this.userSelectedWeek = false`。仅当用户通过 `onWeekChange` 选中某个周时（若选第 0 项即本周则设 `false`、否则设 `true`）才保留 `selectedPeriodKey`。
   - `applyListResult` 正常把服务端的 `payload.period_key` 展示到 `selectedWeekIndex` 即可，若 `!this.userSelectedWeek`，在 `onShow()` 重新进入或 `onBoardTap` / `onScopeTap` / `onRetry` 时保持传入 `periodKey = null`（或在 `onShow()` 开头当 `!this.userSelectedWeek` 时清空 `selectedPeriodKey: null`）。同时在 `422` 错误态按 `onRetry()` 时，若原因涉及周/赛季越界可清零旧选定键回退默认周期，消除跨周/超 4 周窗后永久 `422`。
3. **跟踪 `getLoginGeneration()` 隔离退出与换号**：
   - 引入 `require("../../services/auth.js").getLoginGeneration`（兼容测试未注入该模块时的兜底 `0`）。
   - 检测到 `loginGeneration` 变化时，**分别**复位页面实例属性（`this.userSelectedWeek = false; this.userChangedSeason = false; this.autoSeasonFallback = false; this.invalidGroupIds = {}; this.profileData = null; this.currentSeasonRanked = false;`）并通过 `this.setData(...)` 重置数据状态（`scope: "global"`, `groupId: null`, `board: "week"`, `selectedLevelSeasonId: null`, `selectedPeriodKey: null`, `groups: []`, `nickname: ""`, `avatarText: "球"`, `currentUserId: ""`）。
   - 在 `applyAuthOrDeletedState` 切入 `"guest"` 或 `"userDeleted"` 时，一并清空 `nickname: "", avatarText: "球", currentUserId: ""`。

### 5.3 `my-predictions`、`share-card`、`match-detail` 回流与联动修复（`#13`、`#17`）

1. **`miniprogram/pages/my-predictions/my-predictions.js` & `miniprogram/pages/session/session.js`（`#13`）**：
   - `my-predictions.js`：记录 `this.loginGeneration = currentLoginGeneration()` 与 `this.hasShown = false`，在 `onShow()` 中若 `loginGeneration` 变更或当前处于 `unauthorized` 返回（或经过 `onSessionTap` 登录返回），自动重置筛选/游标并重新执行 `loadFirstPage()`；
   - `onSessionTap()` 跳转 `/pages/session/session?return_to=my-predictions`，`session.js` 将 `"my-predictions"` 纳入 `returnTo` 支持列表并在登录成功后优先 `wx.navigateBack({ delta: 1 })`。
2. **`miniprogram/pages/share-card/share-card.js:504-515`（`#17`）**：
   - `onReselect()` 同步重置 `selectedRoundId: null` 与 `roundIndex: 0`（保持已选联赛/赛季方便用户只重选轮次），避免微信 `<picker>` 因 `value="{{roundIndex}}"` 没变化而不触发 `bindchange`。
3. **`miniprogram/pages/match-detail/match-detail.js:129-134, 377-385`（`#17`）**：
   - 当前页面未定义或设置 `this.initialized`，不得直接把它作为刷新前置条件。`onLoad()` 初始化 `this.hasShown = false` 并保留既有首次 `loadDetail()`；首次 `onShow()` 只设置 `this.hasShown = true` 后返回，之后每次 `onShow()` 在 `!this.data.submitting && this.data.matchId` 时调用 `this.loadDetail()`。这样普通后台切回或次级页面返回均会刷新，首次进入不重复请求，也不依赖不存在的初始化标记。
   - `applySubmitResult` 遇到 `409 PREDICTION_LOCKED` 时同样调用 `this.loadDetail()`，让状态、截止提示与「大家怎么选」卡片同步解锁刷新。

### 5.4 验收测试
- `groups/groups.test.mjs` & 新增 `groups/detail.test.mjs`：创建 1 个群后返回 `groups` 页可连续创建第 2 个群；`detail` 未加载完成触发 `onShareAppMessage` 不抛错；异步 reject 后不卡死 `loadingAction`。
- `rankings.group-invalid.test.mjs` & `rankings.rate-limit.test.mjs` & `rankings.week-options.test.mjs`：历史赛季下通过 `pending_ranking_group_id` 回跳自动复位为周榜并正常加载；跨周后 `onShow` 不钉死旧 `selectedPeriodKey`；`loginGeneration` 变更后清空旧昵称、ID 与群范围。
- `my-predictions.test.mjs` & `session.test.mjs`：`return_to=my-predictions` 登录返回后 `onShow` 自动重载列表；`loadFilters` 旧失败不覆盖新成功。
- `profile` 页面测试：A 已加载最近预测后切换 B，让 B 的资料先成功、最近预测延迟或失败，验证 B 页面 loading/error 状态下数组为空且不渲染 A 的记录；随后 A 的旧请求成功或 reject 均不能回写，B 的新请求成功后才显示 B 的记录。
- `share-card.test.mjs` & `match-detail.crowd.test.mjs`：`onReselect` 后 `roundIndex === 0`；`match-detail` 在 `409 PREDICTION_LOCKED` 后调用 `loadDetail` 刷新并打开大家怎么选。
  - `match-detail` 生命周期测试：`onLoad + 首次 onShow` 合计只加载一次；普通后台返回、次级页面返回各触发一次刷新；提交中不刷新；未定义 `initialized` 的情况下返回刷新仍正常执行。

---

## Slice 6（P1/P2）：首页 `matches` 状态机收口、收官导航（`UI-01`）与长中文队名显示适配（`UX-01`）

- **覆盖问题**：`#13`（`matches.js` 部分）、`#16`、`#18`（`matches.wxss` 部分）
- **前置依赖**：Slice 5

### 6.1 `matches.js` 状态一致性、`submitErrors` 清理与收官直达赛季榜（`#13`、`#16`）

1. **截单/开球后自动收起失效编辑区（`#13`）**：
   - `miniprogram/pages/matches/matches.js:432-440`（`decorateItem`）：当 `!submitted` 且 `storedUi === "editing"` 但 `!cardState.showPredict` 时，立即重置 `this.uiStates[key] = "collapsed"`（并 `delete this.drafts[key]`、`deleteSubmitError(key)`），使刷新后的已截单/进行中/取消比赛卡片立即收起编辑表单。
2. **清理残留 `submitErrors[key]` 与加载态计数（`#16`）**：
   - `matches.js`：抽 helper `clearSubmitError(key)`，在 `onSubmitTap` 启动、`200/201` 成功、`409` 收口、`onScoreTap`、`closeEditors`、`rememberLoginGeneration` 中清除 `submitErrors[key]`；同时在 `matches.wxml:80` 增加 `wx:if="{{item.uiState !== 'submitted_locked' && item.submitError}}"` 双保险。
   - `loadFirstPage()`（L309）开头与 `applyListResult()`（L392）非分页报错分支清零 `openCount: 0, doneCount: 0, hintText: ""`，避免跨午夜报错时残留昨日统计。
3. **收官按钮直达目标赛季榜与 `summarySeasonId` 格式化（`UI-01` / `#16`）**：
   - `matches.js:292-294`（`onRankingsTap`）：写入 `wx.setStorageSync("pending_ranking_target", { board: "season", levelSeasonId: currentSeasonId(new Date().toISOString()) })` 再执行 `wx.switchTab({ url: "/pages/rankings/rankings" })`。
   - `rankings.js` `onShow()`：读取并删除 `"pending_ranking_target"`（仅在无 `pending_ranking_group_id` 时生效），先直接复位页面实例标记 `this.userChangedSeason = false; this.autoSeasonFallback = false; this.userSelectedWeek = false;`，再通过 `this.setData({ board: "season", scope: "global", groupId: null, selectedLevelSeasonId: target.levelSeasonId || null })` 切到目标赛季榜，并沿用 `rankings.js:555-567` 既有的 `availableBoards` 资格检查——有赛季榜资格直接落到目标 `level_season_id` 赛季榜，无资格自动退回周榜，不强开资格。
   - **显式目标禁止空榜回退上季**：现有 `rankings.js:587-611` 会在本季空榜且存在上季时自动改选上季，与上述“直达目标赛季”冲突。新增页面实例字段 `this.explicitTargetSeasonId`（初始化为 `null`），消费目标导航时赋为目标赛季；`applyListResult` 的空榜自动回退分支仅在该字段为空时允许执行。有资格但目标赛季无记录时保留目标赛季及空态，不得静默切到上季。用户主动切换赛季/榜种/范围、消费群导航或登录代次变化时清除此字段，恢复普通浏览的既有回退规则；资格不足回周榜时也清除该字段。
   - `matches.js` 在 `loadLeagueSummary` 写入 `summarySeasonLabel`（若为 `YYYY_YYYY` 格式则格式化为 `YYYY/YYYY`，自然年 `YYYY` 保持不变），`matches.wxml:38` 展示 `{{summarySeasonLabel ? summarySeasonLabel + ' 赛季 · ' : ''}}` 消除原始下划线 `2026_2027`。

### 6.2 `matches.wxss` 长中文队名完整展示适配（`#18` / `UX-01`）

- 位置：`miniprogram/pages/matches/matches.wxss:100-106, 130, 176`
- 方案：
  1. 在不改变 `.match` 卡片毛玻璃、`var()` 颜色/模糊 token、`.bug` 实色方块尺寸与 `.leagues-wrap` / `.dates-wrap` 布局的前提下：
     - 将 `.team` 由固定窄比调整为自适应弹性占比（`flex: 1; min-width: 0;` 替代死宽 `34%`），释放中间 `.bug` 两侧剩余留白给队名；
     - 将 `.team-name`（L105）移除 `white-space: nowrap; text-overflow: ellipsis; overflow: hidden;`，改为允许最多 2 行自然折行（`line-height: 1.25; word-break: break-word;`），客队保持 `text-align: right`；
     - 将 `.stepper-team text`（L130）放宽 `max-width`（如 `max-width: 110px`）并同样允许换行替代省略号截断，确保 375px 参考屏下「门兴格拉德巴赫」「托特纳姆热刺」「巴黎圣日耳曼」「球队资料待补全」完整可辨。
  2. 改后必须执行 `python3 docs/design/scripts/verify-home-migration.py` 验证未破坏首页不变量，并在微信开发者工具 375px 视口下实机/模拟器核验长队名卡片高度与折行效果。

### 6.3 验收测试
- `matches.workflow.test.mjs` & `matches.offseason.test.mjs` & `rankings.season-fallback.test.mjs`：
  1. 展开某场编辑区后服务器下发 `can_predict: false, showPredict: false`（截单/开球/取消），刷新后 `editorVisible === false`、`uiState === "collapsed"`；
  2. 提交失败置 `submitErrors[key]` 后二次重试成功，验证 `item.submitError` 为空；
  3. 跨午夜 `loadFirstPage` 返回 500 时验证 `hintText === ""`、`openCount === 0`；
  4. 点击收官卡「查看 2026—2027 赛季榜 →」写入 `pending_ranking_target`，验证 `rankings.onShow()` 对有资格用户切入对应赛季榜、对无资格用户自动回退周榜。
  5. 有赛季榜资格、目标为 `2026_2027`、本季 `items: []` 且存在 `2025_2026` 榜单时，验证仍展示 `2026_2027` 空态，不触发上季回退请求；普通浏览未带显式目标时保留原有回退行为，清除目标标记后不影响用户后续手选及换号。
- `python3 docs/design/scripts/verify-home-migration.py`（结合人工/模拟器检查 `matches.wxss` 长队名折行视觉）。

---

## 附录：真机与在线数据库补充核验清单

1. **PostgreSQL 真实实例补验**：
   - 运行全部 6 个 `.pg.test.ts` 集成测试，验证 `updateGlobalRank` 原子局部更新与 `ranking:week:{periodKey}` 事务外锁的并发安全性；
   - 运行 `EXPLAIN ANALYZE` 验证 `compileLatestRegularBoardSnapshot` 去掉 `COALESCE` 后完整命中 `ix_board_snapshots_season_final`，以及 `authSessions.deleteExpiredBefore(..., { limit })` 走分批删除；
   - 检查生产历史 `board_snapshots` 表中是否存在缺失 `is_final` 键的旧行（若有，一次性回填 `false`）。
2. **微信开发者工具 / 真机环境补验**：
   - 无 ICU/老版本安卓内核或 UTC-8/UTC+13 设备下验证详情页、我的预测、我的页、解锁页日期时间显示全部为纯北京时间且无 `RangeError`；
   - 从 `rankings` 历史赛季态扫码/点击邀请加群跳转，验证自动切回周榜群榜无 `422` 死循环；
   - `groups` 连续创建第 1、2 个群及未就绪点击右上角转发；
   - 375px 视口下核验 `拜仁慕尼黑` / `门兴格拉德巴赫` / `托特纳姆热刺` / `球队资料待补全` 在首页卡片与步进器中的折行排版。
