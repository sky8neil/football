# 赛事预言家：M1–M9 功能与逻辑全量 Code Review 问题清单与修复计划（v4.1）

> 状态：**✅ M1–M9 全量 Code Review 确认的 31 项功能与逻辑缺陷（0 P0 / 12 P1 / 19 P2）已全部修复、补充回归测试并通过独立代码审核与全量门禁（`tsc --noEmit` 0 err、`tsc -p tsconfig.build.json` 0 err、Vitest `272 passed | 11 skipped | 0 failed`，`3254 passed`）；进入 M10（切片 10）**  
> 生成日期：2026-11-24  
> 上游基线：[PRE_LAUNCH_FIX_DEV_PLAN__v4.0.md](PRE_LAUNCH_FIX_DEV_PLAN__v4.0.md)  
> 审查范围：切片 1–9 全部后端、基础设施、同步器、小程序、独立 Web 管理端与运维脚本（仅聚焦功能性、逻辑性、并发/数据一致性与安全正确性问题，不含样式/代码风格建议）。

---

## 1. 审查总览

| 所属区域 | 覆盖切片 | P0 | P1 | P2 | 状态 |
|---|---|---:|---:|---:|---|
| 区域 1：网关安全、限流、PG 锁与 Schema | 切片 1–2 | 0 | 4 | 5 | ✅ 已修复并通过审核 |
| 区域 2：结算账本、注销、榜单与一致性 | 切片 3 | 0 | 3 | 2 | ✅ 已修复并通过审核 |
| 区域 3：S3 多源同步与 S7/Q5 换季 | 切片 4–5 | 0 | 3 | 3 | ✅ 已修复并通过审核 |
| 区域 4：小程序首页、榜单/群组、分享卡 | 切片 6–8 | 0 | 0 | 5 | ✅ 已修复并通过审核 |
| 区域 5：独立 Web 管理端与异常解除 | 切片 9 | 0 | 2 | 4 | ✅ 已修复并通过审核 |
| **合计** | **切片 1–9** | **0** | **12** | **19** | **✅ 31/31 已闭环** |

---

## 2. P1 高危功能 / 逻辑缺陷（12 项，必须全部清零）

### 2.1 区域 1（切片 1–2：网关、限流与 PG Schema）

- **`CR-01`（切片 2 遗留待办 #1）`scripts/vps-db.mjs:90-135` — 运维巡检/计划模式完全丢弃 `driftedIndexes`**
  - **问题与根因**：`diffPostgresSchema()` 已计算 `driftedIndexes`，`--apply` 分支也打印了 `report`，但 `printDiff()`（默认/`--plan`/`--dry-run`）手工拼装输出字段时遗漏了 `driftedIndexes`，导致运维巡检对索引漂移完全静默。
  - **修复要求**：在 `printDiff()` 输出中增加 `driftedIndexes: diff.driftedIndexes`，并在 `counts` 中增加 `drifted_indexes: diff.driftedIndexes.length`（严格只报告、不自动 DROP/重建）。补单测覆盖。

- **`CR-02`（切片 2 遗留待办 #3）`src/infrastructure/postgres-schema.ts:310-325` — `normalizePostgresIndexDef` 无条件抹除 `NULLS FIRST/LAST`，掩盖真实索引漂移**
  - **问题与根因**：第 316 行 `normalized.replace(/\bnulls\s+(?:first|last)\b/g, "")` 无条件删掉所有空值排序修饰符。PG B-tree 中 `ASC` 默认 `NULLS LAST`、`DESC` 默认 `NULLS FIRST`；项目含多条 `:desc` 索引，若线上存在 `DESC NULLS LAST` 或 `ASC NULLS FIRST` 漂移，会被静默忽略导致查询无法走索引消除排序。
  - **修复要求**：按索引键方向分别归一化默认值（仅在 `DESC` 后移除默认 `NULLS FIRST`，仅在 `ASC`/缺省方向后移除默认 `NULLS LAST`），保留非默认空值排序差异。补单测覆盖 `ASC`/`DESC` + `NULLS FIRST`/`NULLS LAST` 组合。

- **`CR-03` `src/api/v1/rate-limit.ts:69-119` — `InMemoryRateLimiter` 满桶后未先清理过期桶且 `nextPruneSize` 超上限，可致新用户最长 60s 误杀 429**
  - **问题与根因**：当 `windows.size` 达到 `IN_MEMORY_RATE_LIMIT_MAX_BUCKETS`（8192）并执行一次 `pruneExpired` 后，`nextPruneSize = Math.max(PRUNE_SIZE_THRESHOLD, this.windows.size * 2)` 变为 `16384`，导致容量触发清理永不再触发；随后第 105 行在拒流前未先调用 `pruneExpired(nowMs)`，即便全部 8192 个桶已过期，在 60s 定时清理前所有新用户/新 IP 均被直接 429。
  - **修复要求**：在第 105 行拒流前先执行一次 `this.pruneExpired(nowMs)` 再复检容量上限；同时将 `nextPruneSize` 上限钳制在 `IN_MEMORY_RATE_LIMIT_MAX_BUCKETS`。补单测覆盖。

- **`CR-04` `scripts/vps09-templates.test.mjs:35-36` — 优雅停机重构后既有模板单测失败**
  - **问题与根因**：`http.ts` 将信号注册重构为 `runGatewayEntrypoint`（`deps.onceSignal("SIGTERM", onSignal)` + `process.once(signal, listener)`）与 `server.close((err) => ...)`，而 `scripts/vps09-templates.test.mjs:35-36` 仍字面量匹配 `process.once("SIGTERM"` 和 `server.close()`，导致全量 Vitest 存在 1 个失败用例。
  - **修复要求**：更新 `scripts/vps09-templates.test.mjs:35-36` 断言以准确验证当前优雅停机实现。

### 2.2 区域 2（切片 3：结算、榜单与一致性）

- **`CR-05` `src/application/period-finalize-service.ts:173-224` — 周榜周期内注销用户未在封榜时重算 `global_rank`，导致历史周榜名次断层且每日一致性持续误报**
  - **问题与根因**：当周最后一场结算完成后、周一 00:00（`weekEndAt`）前，若第 1 名用户注销账号且后续无新比赛结算，`deleteMyProfile` 不重排 `rankings`，`PeriodFinalizeService.finalize` 仅 `patchFields({ is_final: true })`。封榜后 `RankingQueryService` 隐藏注销用户但 `keepHistoricalRank = true` 仍展示第 2 名的 `global_rank = 2`（名次断层），同时 `DailyConsistencyService` 按 `deleted_at < weekEndAt` 算出期望 `global_rank = 1`，持续触发 `DAILY_CONSISTENCY_MISMATCH`。
  - **修复要求**：在 `PeriodFinalizeService.finalize` 封榜事务内（已持 `rankingPeriodLockKey` 与全周期行锁）写 `is_final: true` 前，调用 `rebuildGlobalRanksInTransaction(tx, periodType, periodKey, serverNow)`（或等价逻辑）重算该周期 `global_rank`。补单测覆盖。

- **`CR-06` `src/application/daily-consistency-snapshot.ts:111-116, 728-735` — 丢弃 `failed` 修正单导致部分已入账 item 触发 `DAILY_CONSISTENCY_MISMATCH` 误报**
  - **问题与根因**：`CorrectionSettlementService` 按单 item 独立提交。若修正单部分 item 已 `applied` 后中途失败变为 `status = "failed"`，该比赛 `settlement_status = "failed"`（不在 `activeSettlement` 中），而 `daily-consistency-snapshot.ts:730` 用 `isUsableCorrection(settlement)` 过滤掉了整个 `failed` 修正单，导致已入账 item 缺失于 `expected` 聚合，触发误报。
  - **修复要求**：移除第 730 行在收集 `settlementsById` 时的 `isUsableCorrection` 过滤，保留已 `applied` item 参与积分/统计/周榜聚合（等级回放继续由 `buildReplayFacts` 的 `isIncompleteCorrection` 隔离）；若 `failed` 比赛尚未完成最终 `global_rank` 重排，将其纳入 `active_settlements` 的 rank 跳过范围。补单测覆盖。

- **`CR-07` `src/application/ranking-rebuild-service.ts:202-210, 248-300` — `RebuildPeriodRankingsService` 写 `rankings` 未加行锁且整文档覆写，与并发单场结算存在丢失更新竞态**
  - **问题与根因**：单场结算在 `ApplyItems` 阶段仅持 `settlement:match:{match_id}` 锁，不持 `rankingPeriodLockKey`。在 PG `READ COMMITTED` 下，`RebuildPeriodRankingsService` 无锁读比赛与 `rankings` 后整文档 `tx.rankings.update(...)`，可能静默抹掉期间并发结算已提交的新分数或将新用户清零。
  - **修复要求**：在 `rebuildPeriodRankingsWhileHoldingRankingLock` 事务内对 `selectedMatches` 加行锁（`findByIdForUpdate` 后复检 `activeSettlement`），同时对目标 `rankings` 行按 `user_id` 升序加 `findByPeriodAndUserForUpdate` 并改用 `patchFields` 局部更新（尊重跨表锁序 `users → user_season_stats → rankings → matches → groups` 或先锁 matches 再锁 rankings 时确保与结算锁序无环——注意核对现有跨表锁序约定！）。补单测覆盖。

### 2.3 区域 3（切片 4–5：S3 多源同步与换季探测）

- **`CR-08` `src/application/provider-fixture-sync.ts:360-377, 150-194` — 非权威副源在 `normalizeFixture` 失败路径绕过 `!isScheduleAuthority` 防护，直接改写比赛状态并写入阻塞异常**
  - **问题与根因**：`applyFixture` 的 `!isScheduleAuthority` 防护位于第 459 行，但在第 360 行 `normalized.entityFailed` 分支中已先调用 `persistMapperFailure`。一旦副源（`5dollar`/`openfoot`/`sportapi`）返回导致 `entityFailed` 的数据（如缺比分 `FT` 或未知状态），会直接把 `match_status` 改为 `Finished`、`settlement_status` 推进到 `Waiting`，或写入 `blocking: true` 的 `UnexpectedProviderStatus`/`InvalidFinalScore` 异常阻塞结算。
  - **修复要求**：在 `normalized.entityFailed` 分支（或 `persistMapperFailure` 内部）判断 `!isScheduleAuthority`：非权威副源的 mapper 失败仅记录 `provider_error` 快照与非阻塞诊断日志，禁止修改 `matches` 状态/结算状态，且禁止打开 `blocking: true` 异常。补单测覆盖。

- **`CR-09` `src/provider/registry.ts:523-526, 428-449` — `ProviderRegistry.fetchQuery` 将单联赛/次级季 400/404 错误标记为整个源在当前 tick 不可用，连坐阻断同源其他联赛**
  - **问题与根因**：6 月/12 月换季探测期，第 1 个联赛探测未发布新季收到 HTTP 400/404 时，`fetchQuery` 无条件调用 `markSourceUnavailable` 将 `"fd"` 在当前 tick 拉黑，导致同 tick 后续其余 4 个联赛连当前赛季的 `full_schedule_verify` 全部失败。
  - **修复要求**：仅对源级故障（429、5xx、网络/超时、本地配额拒绝、401/WAF 403 且无可用备用 key）调用 `markSourceUnavailable`；对 HTTP 400/404 等单查询参数错误不标记源级不可用。补单测覆盖。

- **`CR-10` `src/provider/registry.ts:88-91, 125-129` — `PooledProviderHttpClient` 对 HTTP 401/403 不触发同源 KeyPool failover，且误将 `ProviderDataError` 当网络错误重试**
  - **问题与根因**：`isRetryable(error)` 对 `ProviderHttpError` 仅放行 `status >= 500`，当 `fd#1` 收到 401/403（单 key 失效或 WAF 冷却）时不切换健康备用 `fd#2` 而直接抛错，连带拉黑整个 `fd` 源；同时 `return error instanceof Error` 把 `ProviderDataError`（200 非法 JSON）当作可重试网络错误重复请求并污染 `network_errors`。
  - **修复要求**：`isRetryable` 对 `ProviderDataError` 返回 `false`；对 `ProviderHttpError` 返回 `error.status >= 500 || error.status === 401 || error.status === 403`；且 `ProviderDataError` 不计入 `KeyPool` 的 `network_errors`。补单测覆盖。

### 2.4 区域 5（切片 9：独立 Web 管理端）

- **`CR-11` `admin/app.js:416-427` & `src/application/match-query.ts:46-74, 313-318` — Web 管理台“读取比赛”调公开接口拿不到 `result_version` 且 `settlement_status` 被脱敏，导致无法修正已有赛果的比赛**
  - **问题与根因**：`GET /v1/matches/{match_id}` 是公开接口，不返回 `result_version` 且将内部 `failed` 脱敏为 `not_ready`。Web 管理台“读取比赛”显示 `当前版本: vundefined` 并将 `expected_result_version` 置为 `0`，提交修正直接报 `409 RESULT_VERSION_CONFLICT`；而前端 `formatApiError` 又未展示 `details.actual_result_version`，导致管理员无法完成二次修正，也看不到比赛是否处于 `failed` 可重试态。
  - **修复要求**：
    1. 新增管理员只读详情接口 `GET /v1/admin/matches/{match_id}`（先鉴权再限流，同步更新 `openapi.yaml`），返回真实 `result_version`、`settled_result_version`、`settlement_status`、`result_source`、`regular_home_score`、`regular_away_score`、双方球队信息及当前 `open` 异常摘要；
    2. `admin/api.js` 与 `admin/app.js` 改调 `GET /v1/admin/matches/{match_id}`；
    3. `admin/state.js` 的 `formatApiError` 对 `RESULT_VERSION_CONFLICT` 展示 `details.actual_result_version`。补前后端单测覆盖。

- **`CR-12` `src/gateway/assemble.ts:378, 407` & `src/gateway/admin-auth.ts:161-171` — 一次性管理员登录令牌防重放 `consumedJtis` 仅存进程内存，重启/多实例可在 TTL 内重放**
  - **问题与根因**：`DEFAULT_ADMIN_CONSUMED_JTIS = new Map()` 未持久化；在 `login_token` 有效期内若进程重启或多实例部署，已使用过的 `login_token` 可再次换取 8 小时管理会话。
  - **修复要求**：为 `admin-auth` 增加持久化消费记录存储（PG 表 `admin_login_consumed_jtis(jti PRIMARY KEY, expires_at TIMESTAMPTZ)` 纳入 `postgres-schema.ts`，通过 `INSERT ... ON CONFLICT DO NOTHING` 实现原子防重放并清理过期项；内存模式保持兼容存储），并在 `assemble.ts` / `vps-runtime.ts` 接入。补单测覆盖。

---

## 3. P2 边界逻辑与一致性缺陷（19 项，一并清理）

### 3.1 区域 1（切片 1–2）

- **`CR-13`（切片 2 遗留待办 #2）`src/infrastructure/postgres-schema.ts:475-503` — `applyPostgresSchema` 并发初始化时 `created` 归属失真**
  - **修复要求**：在持有 `pg_advisory_xact_lock` 的同一事务/会话连接内采集 `before` 快照并执行 DDL，基于持锁后的真实状态计算 `created`。
- **`CR-14` `scripts/deploy-preflight.mjs:101-112` — 非 `prod` 环境仅配置非法 `FOOTBALL_RANKING_FIRST_PERIOD_KEY` 时跳过校验**
  - **修复要求**：第 101-105 行 `if` 条件补充检查 `FOOTBALL_RANKING_FIRST_PERIOD_KEY` 非空。
- **`CR-15` `src/gateway/assemble.ts:416-443` 等 — 部分不接受 Query 参数的路由未校验未知 Query 字段**
  - **修复要求**：对 `POST /v1/auth/wechat`、`POST /v1/session/init`、`POST /v1/predictions`、`PATCH/POST/DELETE /v1/profile/me`、`POST /v1/groups`、`POST /v1/groups/join`、`POST /v1/groups/:id/leave`、`GET/DELETE /v1/groups/:id` 统一补齐 `assertUnknownFields(input.query, new Set())`。
- **`CR-16` `src/infrastructure/postgres-document-db.ts:275-296` — `comparisonType` 允许运行期值类型覆盖已声明 `string` 字段类型**
  - **修复要求**：`comparisonType()` 优先 `if (declared !== undefined) return declared;`，仅对未声明字段按运行期值类型推断。
- **`CR-17` `src/gateway/config.ts:157-176` & `scripts/vps-db.mjs:45-64` — `dev` 与 `test` 环境未互相隔离标识**
  - **修复要求**：在 `dev` 下禁止 schema/namespace 含 `test`/`prod`，在 `test` 下禁止含 `dev`/`prod`（确认不破坏现有测试默认值）。

### 3.2 区域 2（切片 3）

- **`CR-18` `src/application/period-finalize-service.ts:117-119` & `src/application/board-snapshot.ts:362, 386` — 租约截止时间未对齐墙钟 `Date.now()`**
  - **修复要求**：统一改为 `new Date(Math.max(serverNow.getTime(), Date.now()) + LEASE_MS)`。
- **`CR-19` `src/application/admin-result-correction.ts:67-69` — `AdminResultCorrectionService.assertInput` 漏检纯空白 `reason`**
  - **修复要求**：改为 `input.reason.trim().length < 1`。

### 3.3 区域 3（切片 4–5）

- **`CR-20` `src/provider/key-pool.ts:18-24, 132-146` — `KeyPool.markFailure` 对非 `"1010"`/`"waf_403"` 的 WAF 403 错误码无法递增退避**
  - **修复要求**：第 134 行改用 `isWaf403Failure(403, previous.last_error_code)`。
- **`CR-21` `src/application/provider-fixture-sync.ts:619-621` & `src/application/provider-schedule-sync.ts:213, 270-277` — `applyAdoptableResult` 冲突分支与 `discover` 合并分支存在无行锁整文档 `matches.update` 覆写风险**
  - **修复要求**：两处改用事务内行锁（`findByIdForUpdate`）+ `patchFields` 局部更新（`discover` 锁后复验 `!terminal && !liveOrAnchored`）。
- **`CR-22` `src/application/provider-post-finish.ts:93-125` & `src/application/provider-window-loader.ts:185-193` — 单联赛拉取失败被隔离后仍推进当日 `POST_FINISH_DAILY_FALLBACK_STATE_ID`**
  - **修复要求**：仅当所有含超 24h 候选的联赛均成功拉取时再推进 `POST_FINISH_DAILY_FALLBACK_STATE_ID`。

### 3.4 区域 4（切片 6–8：小程序）

- **`CR-23` `miniprogram/pages/profile/profile.js:310-320` — 主队回查忽略服务端下发的 `name_zh` 与 `logo_url`**
  - **修复要求**：改用 `presentTeam(team, match.league_id)` 解析 `nameZh` 与 `logo` 并写入状态与缓存。
- **`CR-24` `miniprogram/pages/settings/settings.js:284-297` — HTTP 模式退出登录未清理跨页状态缓存**
  - **修复要求**：`onLogout()` 复用 `clearLocalSessionAndCache()`。
- **`CR-25` `miniprogram/pages/profile/profile.js:411-431` — 个人页创建群组缺少 `loginGeneration` 竞态校验与 `401/409` 收口**
  - **修复要求**：比对 `currentLoginGeneration()`，响应先经 `applyErrorState(this, result)` 处理 `401/409`，并补齐 `GROUP_JOIN_LIMIT_REACHED` 文案映射。
- **`CR-26` `miniprogram/pages/session/session.js:8, 208-211` 与二级页 `onLoginTap` — 二级页未登录去登录后无法回跳原页**
  - **修复要求**：将 `groups` / `group-detail` / `settings` / `unlocks` 纳入 `RETURN_TARGETS`，对应页面 `onLoginTap` 携带 `return_to` 参数，`session.js` `navigateBack` 补 `fail: () => wx.switchTab({ url: HOME_URL })` 兜底。
- **`CR-27` `miniprogram/pages/settings/settings.js:185, 214` — `onSave()` 调用 `wx.navigateBack()` 无单页栈兜底**
  - **修复要求**：补充 `fail: () => wx.switchTab({ url: "/pages/profile/profile" })`。

### 3.5 区域 5（切片 9：独立 Web 管理端）

- **`CR-28` `scripts/vps-admin.mjs:108-111` — 读取 `FOOTBALL_ADMIN_LOGIN_SECRET` 使用 `??`，空字符串不回落到 `FOOTBALL_MATCH_CURSOR_SECRET`**
  - **修复要求**：对 `values.secret`、`env.FOOTBALL_ADMIN_LOGIN_SECRET`、`env.FOOTBALL_MATCH_CURSOR_SECRET` 依次 `trim()` 取首个非空值，与 `src/gateway/config.ts` 一致。
- **`CR-29` `src/application/admin-result-correction.ts:45-53` — 赛果修正自动解除异常白名单未包含阻塞类异常 `LIVE_TOO_LONG`**
  - **修复要求**：在已确认比赛 `finished` 且写入常规比分的前提下，将 `AnomalyType.LiveTooLong` 加入 `RESULT_CORRECTION_AUTO_RESOLVE_ANOMALY_TYPES`。
- **`CR-30` `admin/app.js:382-391, 566-575` & `admin/state.js:112-122` — Web 管理台筛选条件变更未重置分页游标，且翻页失败时游标状态不回滚**
  - **修复要求**：筛选控件 `change` 时调用 `pager.reset()`；翻页先发请求成功后再提交 pager 状态变更。
- **`CR-31` `ops/vps/Caddyfile:22-28` — `/admin/*` 的 `try_files` 回退到 `/admin/index.html` 导致子路径相对资源白屏并暴露 `*.test.mjs`**
  - **修复要求**：改为仅放行存在文件（`try_files {path} {path}/index.html =404`），且显式拦截 `*.test.mjs`（返回 404）。

---

## 4. 修复与审核门禁

1. 所有 `CR-01` ~ `CR-31` 由 `Gemini 4 Hydrogen` 按文档逐项修复并补充回归单测；
2. 修复完成后必须全量通过：
   - `npm run typecheck`（0 errors）
   - `npm run build`（0 errors）
   - `npm test`（0 failed；仅未配置 `FOOTBALL_TEST_DATABASE_URL` 的 `*.pg.test.ts` 允许 skipped，将在 M10 全部转绿）
3. 由协调者对全部 31 项修复逐项做代码审核（Diff + 回归测试核验），全部通过后更新状态并启动 **M10（切片 10：PG 真库并发测试与 VPS 加固验收）**。
