# 上线前复审问题修复可执行开发文档（AI 落地指南 v2.0）

- **文档版本**：v2.0（2026-11-23）
- **基线提交**：`96d763a`（已落地 [PRE_LAUNCH_FIX_DEV_PLAN__v1.0.md](PRE_LAUNCH_FIX_DEV_PLAN__v1.0.md) 全部 Slice 1–9）
- **问题来源**：基于 `PRE_LAUNCH_FIX_DEV_PLAN__v1.0.md` 对提交 `96d763a` 进行全量 Code Review 收敛的 **19 项** 逻辑缺陷与长短期运行隐患（聚焦正确性、跨季/并发/数据增长与用户体验闭环；刻意忽略单纯防御性或安全合规项）。
- **目标读者**：直接执行代码修改与验证的 AI Coding Agent / 开发者

---

## 前置：开发纪律与全量问题-切片总览

### 执行原则与校验门禁

1. **按切片顺序执行（Slice 0 → Slice 5）**：建议按顺序独立交付、独立验收；每个切片遵循 **TDD（先补失败复现测试 → 再实现修复）**。
2. **OpenAPI 契约先行**：涉及响应 schema 或错误码变更（Slice 0），先改 [openapi.yaml](../src/api/v1/openapi.yaml)，再改代码与契约测试。
3. **不破坏已冻结视觉基线**：修改 `miniprogram/pages/matches/matches.js` 时严禁改动 `miniprogram/styles/design-tokens.wxss` 及首页冻结结构，改完首页后须跑 `python3 docs/design/scripts/verify-home-migration.py`。
4. **单切片必跑校验命令**（若容器内 `npm` 不在 `PATH`，直接使用 `./node_modules/.bin/`）：
   ```bash
   ./node_modules/.bin/tsc -p tsconfig.json --noEmit
   ./node_modules/.bin/tsc -p tsconfig.build.json --noEmit
   ./node_modules/.bin/tsc -p tsconfig.cloudfunction.json --noEmit
   ./node_modules/.bin/vitest run <本切片相关测试文件>
   git diff --check -- src miniprogram ops scripts
   ```
   全部切片完成后跑全量 `./node_modules/.bin/vitest run`（若本地无在线 PostgreSQL，需明确记录 6 个 `.pg.test.ts` 跳过，并在有 PG 的环境补跑）。

### 全部 19 项问题与目标切片对照表

| 编号 | 级别 | 问题摘要 | 关键位置 | 目标切片 |
| --- | --- | --- | --- | --- |
| #1 | P0 | `public_reads` 全局单桶 `"local_v0"` 限流 + `InMemoryRateLimiter.windows` 只增不减 | `src/gateway/http.ts`、`src/gateway/assemble.ts`、`src/api/v1/rate-limit.ts` | Slice 0 |
| #2 | P0 | `GET /v1/matches` 用 `server_now` 算赛季，6/12 月看不到下赛季赛程 | `src/application/match-query.ts:389-400`、`src/domain/config.ts` | Slice 1 |
| #3 | P0 | `FOOTBALL_RANKING_FIRST_PERIOD_KEY` 为未来上线周时默认查周榜报 `422` | `src/application/ranking-query.ts:542-553` | Slice 0 |
| #4 | P0 | `auth: "optional"` 公开接口带失效本地 token 401 后不会回退匿名重试 | `miniprogram/services/api.js:189-231` | Slice 4 |
| #5 | P0 | 管理员重试更正结算（`is_correction`）漏调 `LevelCorrectionReevalService` | `src/application/admin-retry-settlement.ts:181-202` | Slice 1 |
| #6 | P0 | 已注销用户未冻结 `user_season_stats` 永久阻塞全站赛季终榜生成 | `src/application/weekly-level-eval.ts:79-100,309`、`profile-mutation.ts` | Slice 1 |
| #7 | P1 | 每日一致性对账在跨年/自然年联赛 6 个月错位期必报假异常 | `src/application/daily-consistency-snapshot.ts:627-765` | Slice 2 |
| #8 | P1 | 周评估部分失败静默退出 0，且每 15 分钟重刷 `Strength` 快照冲毁历史版本 | `src/application/weekly-level-eval.ts:428-430`、`scheduled-jobs.ts:655-680` | Slice 2 |
| #9 | P1 | `matches` / `provider_snapshots` / `sync_logs` / `provider_usage` 缺索引 + 无分批删除超时风险 | `src/schema/indexes.ts`、`maintenance-cleanup.ts`、`postgres-document-db.ts` | Slice 3 |
| #10 | P1 | `rankings` / `matches` / `predictions/me` / `share-card` / 重建 / 对账 / 兜底扫 N+1 与 $O(N^2)$ 扫描 | `ranking-query.ts`、`match-query.ts`、`stats-rebuild-service.ts` 等 | Slice 3 |
| #11 | P1 | `jobLocks.renew` / `release` 在 PG `READ COMMITTED` 下存在 TOCTOU 双持/误删竞态 | `src/infrastructure/cloudbase-app-repository.ts:651-665` | Slice 1 |
| #12 | P1 | `superseded_by != null` 旧比赛在详情与「大家怎么选」接口读取过期字段 | `src/application/match-query.ts:476-503`、`src/application/crowd-query.ts:33-68` | Slice 1 |
| #13 | P1 | `CloudBaseWxDb` 历史分页同时间戳漏行/死循环，目录 10w / 历史 6.4k 上限静默截断 | `src/infrastructure/cloudbase-wx-db.ts:310-390` | Slice 3 |
| #14 | P2 | `share-card`：CloudBase 登录后不自动重试、`userUnavailable` 重选死循环、时间非 UTC+8 | `miniprogram/pages/share-card/share-card.js:46-51,149-162,502-511` | Slice 4 |
| #15 | P2 | 残留 `pending_group_invite_code` 劫持 `return_to=share-card` / `match-detail` 回跳 | `miniprogram/pages/session/session.js:178-188,219-221` | Slice 4 |
| #16 | P2 | `matches.js` 跨日/换季不刷新日历头、`closeEditors()` 重置 `"submitting"`、定时器未取消 | `miniprogram/pages/matches/matches.js:145-153,195-217,406-421` | Slice 4 |
| #17 | P2 | `my-predictions.js` 翻页失败清屏、筛选目录失败无重试（含 `matches` / `rankings` 翻页误清） | `miniprogram/pages/my-predictions/my-predictions.js:100-185,288-290` | Slice 5 |
| #18 | P2 | `Deportivo Alavés` 队徽恒返回 `PLACEHOLDER`，触发 `profile.js` 无上限翻页与并发/缓存缺陷 | `miniprogram/utils/logo-registry.js:163-176`、`profile.js:121-275` | Slice 5 |
| #19 | P2 | `invalidGroupIds` 永不清除、退出未清昵称缓存、`RANKING_REBUILD_ALREADY_RUNNING` 映射 500、OpenAPI 静态枚举残留 | `rankings.js`、`settings.js`、`validation.ts`、`openapi.yaml` | Slice 0 + Slice 5 |

---

## Slice 0（P0 上线阻断）：网关限流分桶/防泄漏、未来上线周兼容与契约纠偏

- **覆盖问题**：`#1`、`#3`、`#19`（后端错误码映射 + OpenAPI 契约部分）
- **前置依赖**：无（建议首个实施，避免压测或上线首日触发全站 429 或首周 422）

### 0.1 公开读限流隔离与 `InMemoryRateLimiter` 过期回收（`#1`）

#### 现状问题
1. `src/gateway/http.ts:86-89` 与 `src/gateway/assemble.ts:304,318,362,491` 把所有公开读路由（`GET /v1/matches`、`GET /v1/matches/:id`、`GET /v1/leagues/status`、`GET /v1/profiles/:user_id`）的限流身份均传为固定常量 `config.public_source`（即 `"local_v0"`）。线上全部用户共享同一个 `public_reads` 120 次/分钟桶，总 QPS > 2 req/s 即大面积返回 `429 RATE_LIMITED`。
2. `src/api/v1/rate-limit.ts:51-78` 的 `InMemoryRateLimiter.windows` 只写入不淘汰，长期运行随累计用户/IP 数无限增长内存。

#### 改造方案
1. **提取真实客户端来源与分桶 key**：
   - `src/gateway/assemble.ts`：在 `GatewayRequestInput` 新增可选字段 `client_ip?: string`。新增 helper：
     ```ts
     function resolvePublicReadRateKey(
       identity: ResolvedIdentity,
       clientIp: string | undefined,
       fallbackPublicSource: string,
     ): string {
       if (identity.kind === "active" || identity.kind === "deleted") {
         return `user:${identity.user_id}`;
       }
       if (typeof clientIp === "string" && clientIp.trim().length > 0) {
         return `ip:${clientIp.trim()}`;
       }
       return fallbackPublicSource;
     }
     ```
     - 将 `/v1/matches`、`/v1/matches/:id`、`/v1/leagues/status`、`/v1/profiles/:user_id` 传入的 `public_source` 替换为 `resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source)`。
     - 当单测不传 `client_ip` 且为匿名请求时，仍回退 `input.config.public_source`，完全兼容既有 `src/gateway/assemble.test.ts` 用例。
   - `src/gateway/http.ts`：新增 `extractClientIp(req)` 传给 `handleGatewayRequest({ ..., client_ip })`。规则：取 `req.socket.remoteAddress`；若来自本机回环反代（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`，匹配 `ops/vps/Caddyfile` 的 `reverse_proxy 127.0.0.1:8787`），优先取 `x-real-ip` 或 `x-forwarded-for` 首个非空段；否则保留 `remoteAddress`。
   - `src/cloud-function/index.ts`：若未显式注入 `client_ip` 且 `trusted_openid` 非空，亦可从 context/event 透传隔离。
2. **`InMemoryRateLimiter` 定期/高水位清理过期窗口**（`src/api/v1/rate-limit.ts`）：
   - `WindowState` 增加 `expires_at: number`（即 `windowStart + config.window_ms`）。
   - 记录 `lastPruneAt`（初始 `0`），当 `this.windows.size >= 1024` 或距离上次清理超过 `ONE_MINUTE_MS` 时扫描删除 `entry.expires_at <= nowMs` 的条目，确保进程长驻内存严格有界。

### 0.2 未来上线周 `GET /v1/rankings?board=week` 兼容（`#3`）

#### 现状问题
- `src/application/ranking-query.ts:542-553`：当 `FOOTBALL_RANKING_FIRST_PERIOD_KEY` 配置为下周（如当前服务器时间在 `"2026-W47"`，配置为 `"2026-W48"` 做上线前部署冒烟）时，`selectableWeekKeys(currentPeriodKey, firstPeriodKey)` 返回 `[]`。此时客户端不传 `period_key` 调用 `GET /v1/rankings?board=week`，`defaultWeekKey` 返回 `currentPeriodKey`，随即被 L551 的 `!selectableWeeks.includes(periodKey!)` 拦截并抛出 `422 VALIDATION_ERROR`。

#### 改造方案
- 在 `src/application/ranking-query.ts:542-553, 591-626, 720-760` 中明确区分两类情形：
  1. `selectableWeeks.length === 0` 且客户端**未显式传 `input.period_key` 且无 `input.cursor`**：视为“首榜周尚未开始”的预热状态，跳过 `!selectableWeeks.includes(...)` 校验与 L600-625 的历史周回扫，直接按无榜单行（`sourceEntries = []`, `updatedAt = null`, `items = []`, `has_more = false`）返回 `200` 正常信封（仍保留 `first_period_key`、可用 `board` 等字段）。
  2. 客户端**显式传了 `input.period_key`**（或带游标翻页）且不在 `selectableWeeks` 内：仍按原契约抛出 `422 VALIDATION_ERROR`。

### 0.3 错误码映射与 OpenAPI 静态枚举清理（`#19` 契约部分）

1. `src/api/v1/validation.ts:47-84`：在 `STATUS_BY_CODE` 中补充 `RANKING_REBUILD_ALREADY_RUNNING: 409`（对应 `settlement-item-application-service.ts:293` 抛出的周榜重建锁冲突，避免误映射为 `500 INTERNAL_ERROR`）。
2. `src/api/v1/openapi.yaml`：移除 `MatchListItem.properties.season_id`（L1210-1212）、`MatchDetailData.properties.season_id`（L1317-1319）与 `PredictionHistoryItem.properties.season_id`（L2189-2191）上的静态 `enum: [2026_2027, '2026']`，统一改为 `type: string`（与 `/predictions/me` 查询参数和 `ShareCardData.season_id` 对齐）。

### 0.4 验收测试
- `src/gateway/assemble.test.ts` / `src/api/v1/rate-limit.test.ts`：
  1. 同进程内传入不同 `client_ip` 或不同已登录 `user_id` 连续请求 `GET /v1/matches` 超过 120 次，互不触发 `429`；相同 IP 超过 120 次触发 `429`。
  2. `InMemoryRateLimiter` 写入大量不同身份后推进 `serverNow` 超过窗口期，验证 `windows.size` 被回收回落。
- `src/application/ranking-query.test.ts`：
  3. 当 `firstPeriodKey = "2026-W48"`、`serverNow` 处于 `"2026-W47"` 时，默认 `board=week` 不传 `period_key` 返回 `200` 空榜单；显式传 `period_key=2026-W47` 仍返回 `422`。
- `src/api/v1/admin-retry-settlement.test.ts` & `src/api/v1/openapi-*.test.ts`：
  4. `RANKING_REBUILD_ALREADY_RUNNING` 通过 `mapErrorToHttp` 返回 `409`。
  5. OpenAPI 契约校验 `PredictionHistoryItem` / `MatchListItem` / `MatchDetailData` 允许 `2025_2026`、`2027` 等多赛季值。

---

## Slice 1（P0/P1 核心赛程、结算重试、注销终榜与分布式锁原子化）

- **覆盖问题**：`#2`、`#5`、`#6`、`#11`、`#12`
- **前置依赖**：无

### 1.1 `GET /v1/matches` 按时间窗计算查询赛季与按联赛裁剪查询（`#2`）

#### 现状问题
- `src/application/match-query.ts:389-400` 固定使用 `activeSeasonIds(row, input.server_now)`，只包含 `server_now` 的当前与上一赛季。在每年 6 月（7 月 1 日跨年联赛开季前）和 12 月（1 月 1 日自然年联赛开季前），默认 30 天（或显式 90 天）窗口内已经同步的新赛季赛程会全部不可见；跨 UTC 午夜翻页时两页的 `seasonIds` 还会发生变化。此外即使用户传了 `league_id`，仍会查询全部支持联赛的 `seasonIds`。

#### 改造方案
1. 在 `src/domain/config.ts` 新增导出纯函数 `windowSeasonIds(league: SupportedLeague, from: Date, to: Date): readonly string[]`：
   - 计算覆盖 `[from, to)` 时间区间的所有可能赛季（即对 `from`、`new Date(to.getTime() - 1)` 分别取 `activeLeagueSeason(league, t).season_id` 及各自 `previousLeagueSeasonId`，若中间跨越换季点也一并纳入，返回去重集合）。
   - 同时保留与 `activeSeasonIds(league, serverNow)` 或直接使用覆盖 `[from, to)` 的确定性集合（因为 cursor 已绑定 `from` 和 `to`，这样同一翻页链路中 `seasonIds` 恒定不变）。
2. 在 `src/application/match-query.ts:389-400`：
   - 若 `window.league_id !== null`，只对匹配的联赛调用 `windowSeasonIds`，不再查询其它无关联赛。
   - 否则遍历 `SUPPORTED_LEAGUES` 计算 `windowSeasonIds(league, window.from, window.to)` 并去重。

### 1.2 管理员重试更正结算补齐等级重评（`#5`）

#### 现状问题
- `src/application/admin-retry-settlement.ts:181-202`：管理员对失败的更正结算调用 `this.correctionService.correct(...)` 后直接调用 `continuePendingCorrections(...)`。而 `continuePendingCorrections` 仅检查并继续后续更高 `result_version` 的更正；对于刚刚被管理员重跑成功的当前 `target.settlement_id`，`this.levelCorrectionReeval.runForSettlement` 从未被调用。

#### 改造方案
- 参考 `src/application/settlement-orchestration-service.ts:137-186`，抽共享 helper `runCorrectionReeval(reeval, settlementId, serverNow)`：
  - 在 `AdminRetrySettlementService.retry`（`src/application/admin-retry-settlement.ts:194-202`）中，当 `target.is_correction` 为真且 `outcome.kind === "settled" || outcome.kind === "correcting" || outcome.kind === "already_settled"` 时，**先**对 `target.settlement_id` 执行等级更正重评（`await runCorrectionReeval(this.levelCorrectionReeval, target.settlement_id, serverNow)`），**再**执行 `continuePendingCorrections(...)`。
  - 注：因为 `levelCorrectionReeval` 内部已按 `(settlement_id, scope, level_season_id)` 做幂等保护，且需对 `deferred` 状态支持由周评估/后续重评 `runPending` 兜底，重用 `settlement-orchestration-service.ts` 现有重评触发模式即可保持完全一致。

### 1.3 注销用户不阻塞终榜，且旧赛 ID 读取最新有效比赛（`#6`、`#12`）

#### 现状问题
1. `#6`：`profile-mutation.ts:120-167` 注销用户只将 `users.status` 置为 `"deleted"`，不冻结其 `user_season_stats`；`weekly-level-eval.ts:309` 跳过非 `active` 用户；`listDueSeasonFinalIds`（`L96`）见任意一条 `is_level_frozen !== true` 即拒生终榜。一人注销，全站终榜永久卡死。
2. `#12`：`MatchQueryService.get`（`match-query.ts:476-503`）与 `CrowdQueryService.get`（`crowd-query.ts:33-68`）直接按入参 `matchId` 读 `M_old`（未沿 `superseded_by` 追踪到最新 `M_new`），导致旧赛已作废后 `M_old` 上残留的 `scheduled` / `pending` / `result_version = 0` 掩盖了已结算预测的得分与大家怎么选状态。

#### 改造方案
1. **注销用户与赛季终榜解耦**：
   - 在 `src/application/profile-mutation.ts` `deleteMyProfile` 事务中：遍历 `tx.userSeasonStats.findByUser(userId)`（若端口存在），将未冻结行的 `is_level_frozen` 置为 `true`、`updated_at: serverNow`。
   - **同时（兼容历史存量已注销用户）**，在 `src/application/weekly-level-eval.ts` 的 `listDueSeasonFinalIds`（L95-97）及 `WeeklyLevelEvalService.run` 对赛季冻结的判定中：过滤掉对应用户已非 `UserStatus.Active`（或已 `Deleted`）的 `user_season_stats` 记录（需配合批量查询或缓存用户状态，避免新增 N+1）；或者在 `listDueSeasonFinalIds` 对未冻结行检查其 `user.status === UserStatus.Active` 才视为阻断，确保无论先注销还是存量历史注销账号均不再阻塞全站终榜。
2. **`MatchQueryService.get` 与 `CrowdQueryService.get` 解析 `effectiveMatch`**：
   - 抽取共用 helper `resolveSupersededMatchChain(matchesRepo, match)`（复用 `repositories.ts:330-344` 的 `resolveEffectiveMatch` 防环策略）：
   - `MatchQueryService.get`：先读取请求 `match`，若 `match.superseded_by != null` 沿着链路解析 `effectiveMatch`（若链断裂则退化使用原 `match` 并保持不可预测）。展示比分、`match_status`、`settlement_status`、`result_version` 与 `mapMyPrediction` 结算判定均基于 `effectiveMatch`（保证已有预测的得分、胜平负命中、精确命中正确显示），同时当原 `match.superseded_by != null` 时强制保持 `can_predict = false`（按 `v1.0` Slice 3 约定，不返回 404 且不允许向已替代旧比赛下单）。
   - `CrowdQueryService.get`：对 `match.superseded_by != null` 解析 `effectiveMatch`，基于 `effectiveMatch` 计算 `crowdStatus`（使改期/取消/提前开球的状态实时反映）并统计 `effectiveMatch.canonical_match_id ?? effectiveMatch.match_id` 的预测分布；响应仍回传兼容的 `match_id`。

### 1.4 `jobLocks.renew` / `release` 原子化（`#11`）

#### 现状问题
- `src/infrastructure/cloudbase-app-repository.ts:651-665` 的 `renew` 与 `release` 在 PG 默认 `READ COMMITTED` 下执行“先普通 `SELECT`，再 `UPDATE WHERE _id = $1`”。若 Worker A 的租约在两步之间到期且被 Worker B 抢占，Worker A 的 `UPDATE` 会无条件覆盖或清除 Worker B 持有的锁。

#### 改造方案
1. 在 `src/infrastructure/cloudbase-db.ts` 为 `CloudBaseDb` 增加两个可选原子端口方法：
   - `renewJobLock?(collection: string, lockKey: string, ownerId: string, leaseUntil: Date, now: Date): Promise<boolean>;`
   - `releaseJobLock?(collection: string, lockKey: string, ownerId: string): Promise<void>;`
   在 `src/infrastructure/db-op-counter.ts` 的 `createCountingDb` 中对应透传并计数 `write`。
2. 在 `src/infrastructure/postgres-document-db.ts` 实现单条条件 SQL（并在 `src/infrastructure/postgres-schema.ts` / `.pg.test.ts` 验证）：
   - `renewJobLock`：
     ```sql
     UPDATE <table>
     SET document = jsonb_set(
       jsonb_set(document, '{lease_until}', to_jsonb($4::text), true),
       '{updated_at}', to_jsonb($3::text), true
     )
     WHERE _id = $1
       AND (document ->> 'owner_id') = $2
       AND utc_timestamptz(document ->> 'lease_until') > $3::timestamptz
     RETURNING _id
     ```
     （仅更新匹配 `owner_id` 且尚未过期的行；受影响行数 `> 0` 返回 `true`）。
   - `releaseJobLock`：
     ```sql
     UPDATE <table>
     SET document = jsonb_set(
       jsonb_set(document, '{lease_until}', to_jsonb($3::text), true),
       '{updated_at}', to_jsonb($4::text), true
     )
     WHERE _id = $1
       AND (document ->> 'owner_id') = $2
     ```
     （`$3` 为 `1970-01-01T00:00:00.000Z`；当锁已被其他 owner 接管时影响 0 行，绝不误放他人锁）。
3. `CloudBaseAppRepository.jobLocks.renew` / `release` 优先调用 `this.db.renewJobLock` / `releaseJobLock`；未实现时保留原有事务退化路径。

### 1.5 验收测试
- `match-query.test.ts`：6 月（含 7 月新赛程）和 12 月（含 1 月新赛程）默认窗口都能查出下赛季已同步赛程；传入 `league_id` 不再查询其他联赛赛季；对已被替代的 `M_old` 调用 `get` 能拿到 `M_new` 的真实结算状态与 `my_prediction` 得分，同时 `can_predict === false`。
- `crowd-query.test.ts`：当 `M_new` 被取消或提前截单时，查 `GET /v1/matches/{M_old}/crowd` 返回最新 `unavailable` 或真实分布。
- `admin-retry-settlement.test.ts`：更正结算首次执行失败后管理员 `retry` 成功，验证目标用户的 `career_level`/`season_level` 与 `level_history` 被正确重评更新。
- `weekly-level-eval.test.ts` & `profile-mutation.test.ts`：用户在赛季中注销后，到 `seasonFinalEvalAsOf` 仍能正常生成赛季终榜（包括存量未冻结的注销数据）。
- `postgres-document-db.test.ts` & `.pg.test.ts`：模拟锁过期并被 Worker B 接管后，Worker A 的 `renew` 返回 `false`、`release` 不会破坏 Worker B 的锁。

---

## Slice 2（P1 周期任务可靠性）：对账跨季窗口对齐、周评失败显式告警与快照止血

- **覆盖问题**：`#7`、`#8`
- **前置依赖**：Slice 1

### 2.1 `loadDailyConsistencySnapshot` 跨制式赛季对齐（`#7`）

#### 现状问题
- `src/application/daily-consistency-snapshot.ts:627-765` 使用各联赛 `activeSeasonIds` 集合（跨年与自然年各留 2 季，相差半年）。但等级赛季 `level_season_id`（`7/1–6/30` 北京时间）与周榜 `period_key` 横跨两类联赛：
  - 例如 `2028-02` 时，自然年 `"2026"` 已从 `seasonIds` 移除，但跨年 `"2026_2027"` 仍在。然而 `2026` 年 7–12 月的中超比赛属于 `"2026_2027"` 与 `2026-W27..W52`。此时用缺失了中超 `2026` 数据的 `facts` 去重建实际包含这些积分的 `career`、`season_stats["2026_2027"]` 和 `rankings["2026-W27..W52"]`，必然每天误报 `DAILY_CONSISTENCY_MISMATCH`。
  - 镜像问题在 `2028-08` 发生（CSL `"2027"` 起点 `2027-01` 把 `"2026_2027"` 拉入 `activeLevelSeasons`，但欧洲 `"2026_2027"` 已不在 `seasonIds` 内）。

#### 改造方案
1. **引入「全联赛完整覆盖边界」判断**（`src/application/daily-consistency-snapshot.ts`）：
   - 对每个支持联赛 `league`，计算本次加载的所有 `activeSeasonIds(league, effectiveNow)` 所覆盖的最小时间起点 `minStartForLeague = min(seasonBounds(s).start)`。
   - **所有联赛共同完整覆盖的最早时刻**：
     `completeCoverageStart = max_{league in SUPPORTED_LEAGUES}(minStartForLeague)`。
     （例如在 `2028-02` 时，欧洲最小为 `2026-07-01Z`，CSL 最小为 `2027-01-01Z`，则 `completeCoverageStart = 2027-01-01Z`；在 `2028-08` 时，欧洲最小为 `2027-07-01Z`，CSL 最小为 `2027-01-01Z`，则 `completeCoverageStart = 2027-07-01Z`）。
2. **三项核对各自按完整边界裁剪**（替代当前拼凑 `activeWindows` 的宽泛判定）：
   - **`season_stats`**：仅当某个 `level_season_id` 的完整周期起止时间 `[start, end)` **完全落在** `completeCoverageStart` 之后（`levelSeasonBounds(seasonId).start >= completeCoverageStart`）——且包含当前正在进行的等级赛季——才把该 `seasonId` 放入 `verifiableLevelSeasons` 进行重建核对；跨过 `completeCoverageStart` 导致某一边联赛历史被截断的旧等级赛季跳过全量重建。
   - **`career`**：仅当用户不存在任何早于 `completeCoverageStart` 的历史已结算预测或非当前完整范围等级赛季统计（即用户的所有 `level_season_id` 全部属于 `verifiableLevelSeasons`，且检查 `statsRows` 不含任一未完整覆盖的 `level_season_id`）时才纳入 `career` 全量重算对照。注意：仅查 `statsRows` 含该旧 `level_season_id` 即排除（因只要用户有参与过该 `level_season_id` 的有效预测，其 `user_season_stats` 必然有一条 `level_season_id` 记录且 `valid_predictions > 0`；再辅以排除跨过 `completeCoverageStart` 的未完整等级赛季即可屏蔽半截数据误报）。
   - **`rankings`**：对于周榜，只对比那些**整周时间窗口完全处于 `completeCoverageStart` 之后**（`periodStartAt("week", periodKey) >= completeCoverageStart`）且属于已加载周期的 `period_key`；以及完全由未结/当前活跃赛程构成的当周。被截断的跨半季旧周（如 `2026-W27..W52`）即使被某些 `facts` 命中也不按缺联赛半边的数据做全量比较（或者仅对比 `actual` 中确认 `is_final === false` 且全部组成事实已加载的周）。

### 2.2 周评估部分失败上浮告警，且不以半成品连续刷爆 `Strength` 快照（`#8`）

#### 现状问题
1. `src/application/weekly-level-eval.ts:428-430`：即使本轮出现 `failed_count > 0`、`settlement_skipped_count > 0` 或 `deferred_count > 0`，方法仍在最后无条件生成全站 `Strength` 榜快照并检查终榜。
2. `src/runtime/scheduled-jobs.ts:665-680, 787-791`：当 `failed_count > 0` 时，`runWeeklyLevelEvalJob` 返回 `{ bucket: "skipped", reason: "user_eval_failed" }`，不推进周期、不加入 `failed`/`errors`，`tick.ts` 退出码仍为 `0`。于是每 15 分钟 `football-periodic.timer` 触发一次，持续静默失败且每 15 分钟生成 1 份新 `Strength` 快照（96 份/天，6 小时冲光 24 份保留版本）。

#### 改造方案
1. **区分「可自愈的暂态锁跳过」与「需告警的评估异常」**（`src/runtime/scheduled-jobs.ts:655-680, 787-791`）：
   - 当 `outcome.failed_count > 0` 时，`runWeeklyLevelEvalJob` 不得伪装为 `skipped`：应记录结构化错误，并将其纳入 `runDuePeriodicJobs` 的 `failed` / `errors` 列表中（使 `outcome === "failed"` 并让 `tick.ts` 以非零状态码退出触发 systemd/监控告警）。
   - 当仅为锁占用（`kind === "skipped"` / `settlement_skipped_count > 0` / `deferred_count > 0`）且 `failed_count === 0` 时，维持既有 `R2` 语义：返回 `skipped` 并不推进 `WeeklyLevelEval` 周期，等待下轮周期重试。
2. **保护 `Strength` 快照与周期标记**（`src/application/weekly-level-eval.ts:415-430`、`src/runtime/scheduled-jobs.ts:333-336`）：
   - `WeeklyLevelEvalService.run` 仅当 `failedCount === 0 && settlementSkippedCount === 0 && deferredCount === 0`（全员完整收口）时才在内部触发 `generateDueSeasonFinals`；若未全员收口（周期即将重试），**不**在每次 15 分钟重试末尾无条件调用 `BoardSnapshotService.generate(RankingBoard.Strength)`，避免半成品数据冲毁 24 份快照保留窗。
   - 在 `planDuePeriodicJobs`（`scheduled-jobs.ts:333`）中，仅当 `weeklyDue` 且预期由本次周期一并刷新时才跳过独立 `BoardSnapshotStrength`；当周评估本身持续失败时，独立周期快照（按自身配置间隔）或上次完整快照不会被每 15 分钟死循环冲刷。

### 2.3 验收测试
- `daily-consistency-snapshot.test.ts`：新增 `2028-02-15`（CSL `2026` 与欧洲 `2026_2027` 错位期）与 `2028-08-15`（CSL `2027` 与欧洲 `2026_2027` 错位期）多联赛交叉测试：用户同时拥有 2026 H2 中超、2026-2027 欧洲和 2027-2028 欧洲预测，验证 `runDailyConsistency` 返回 0 处 `differences`。
- `weekly-level-eval.test.ts` & `scheduled-jobs.test.ts`：模拟某个用户抛 `INVALID_LEDGER`（`failed_count = 1`），验证 `runDuePeriodicJobs` 返回 `outcome: "failed"`、`failed` 包含 `WeeklyLevelEval`、不推进周期且不会额外生成/刷爆 `Strength` 快照；而仅出现 `user_lock_held` 时仍按 `skipped` 处理不误报失败。

---

## Slice 3（P1 索引补齐、热路径批量下推与长事务/清理稳健化）

- **覆盖问题**：`#9`、`#10`、`#13`
- **前置依赖**：Slice 1、2

### 3.1 数据库索引补齐与 SQL/游标优化（`#9` 前半、`#10` SQL 游标）

1. 在 [indexes.ts](../src/schema/indexes.ts) 新增以下非唯一查询索引（同步验证 [postgres-schema.ts](../src/infrastructure/postgres-schema.ts) 表达式对齐与 [indexes.test.ts](../src/schema/indexes.test.ts)）：
   - `matches`：
     - `ix_matches_season_kickoff`: `["season_id", "kickoff_at"]` — 支持 `findBySeasonInWindow` 与 `findBySeason`（消除 `GET /v1/matches` 4 次全表扫）。
     - `ix_matches_league_season_round`: `["league_id", "season_id", "round_id"]` — 支持 `findLeagueSeasonCatalog`（`SELECT DISTINCT` Index-Only/Index Scan）及 `findByLeagueSeasonRound`。
     - `ix_matches_canonical_match`: `["canonical_match_id"]` — 配合 `postgres-schema.ts:37-39` 与 `compilePredictionHistoryPage` 统一 `COALESCE((document ->> 'canonical_match_id'), (document ->> 'match_id'))`（注：在 `matches` 上，历史导入若保证 `canonical_match_id` 与 `_id` 一致或在 DDL 中与查询端统一使用同一表达式 `COALESCE((m.document ->> 'canonical_match_id'), (m.document ->> 'match_id'))`，即可直接命中表达索引，避免 `m._id` 与 `m.document ->> 'match_id'` 不一致导致索引失效）。
   - `provider_snapshots`：
     - `ix_snapshots_created_at`: `["created_at"]` — 支持 60 天定期清理 `DELETE`。
   - `sync_logs`：
     - `ix_sync_logs_started_at`: `["started_at"]` — 支持 60 天定期清理 `DELETE`。
   - `provider_usage`：
     - `ix_provider_usage_bucket_start`: `["bucket_type", "bucket_start"]` — 支持 7 天 / 365 天分桶清理 `DELETE`。
2. `src/infrastructure/postgres-document-db.ts:467`：
   - 将 `compilePredictionHistoryPage` 的 OR 游标改为 PostgreSQL 行值比较：
     ```sql
     AND (${ts}, (p.document ->> 'prediction_id')) < ($n::timestamptz, $m)
     ```
     使其直接利用 `ix_predictions_user_submitted_id` 的多列 B-tree 索引边界定位。
3. **过滤已作废赛程**：`findLeagueSeasonCatalog` 在 `Postgres` / `CloudBaseWxDb` / `InMemoryRepository` 中统一过滤 `superseded_by == null`，避免错轮次被新赛替代后旧空轮次仍留在目录里让分享卡返回假 200 空数据。

### 3.2 `MaintenanceCleanupService` 分批删除、锁保护与 dry-run 可观测（`#9` 后半）

1. `src/infrastructure/cloudbase-db.ts`：`deleteWhere?(collection: string, filter: Record<string, unknown>, options?: { limit?: number }): Promise<number>` 支持可选单批上限。
2. `src/infrastructure/postgres-document-db.ts`：当传入 `limit` 时生成有界删除 SQL：
   ```sql
   DELETE FROM <table>
   WHERE _id IN (
     SELECT _id FROM <table> WHERE <where> LIMIT $k
   )
   ```
   并在 `src/application/maintenance-cleanup.ts` 对每张表循环调用分批删除（默认 `batchSize = 1000`，直到单批删除条数 `< batchSize` 或达安全单轮预算上限，且避免超过 `statement_timeout = 30s`）。
3. `src/runtime/scheduled-jobs.ts`：
   - 将 `MAINTENANCE_CLEANUP_CYCLE_KEY` 纳入 `planDuePeriodicJobs`（使 `tick.ts --dry-run` 可观测到当日清理计划）。
   - 执行清理前获取 `sync:maintenance_cleanup` 分布式锁（复用 `jobLocks.acquire/release`），避免超时重叠触发重复删除。

### 3.3 消除热路径 N+1、$O(N^2)$ 扫描与长事务扫库（`#10`）

1. **补充批量查询仓储接口并在两种仓储同步实现**：
   - `TeamRepository.findByIds(teamIds: readonly string[]): Promise<Map<string, Team>>`
   - `UserRepository.findByIds(userIds: readonly string[]): Promise<Map<string, User>>`
   - `MatchRepository.findByIds(matchIds: readonly string[]): Promise<Map<string, Match>>`
   - `SettlementItemRepository.findByUserAndStatus(userId: string, status: SettlementItemStatus): Promise<SettlementItem[]>`
   （CloudBase/PG 通过分批 `db.inFilter` 一次拉回，InMemory 直接按 Map 查，彻底替代循环内逐个 `findById` 或全表 `findByStatus`）。
2. **改造调用方热路径**：
   - `MatchQueryService.list`（`src/application/match-query.ts:439-446`）：先收集当页 `home_team_id` / `away_team_id`，单次 `teams.findByIds` 读取后再组装返回项。
   - `PredictionHistoryQueryService.listMyPredictions`（`src/application/prediction-query.ts:299-310`）：收集当页 `prediction.match_id`，用轻量批量链路函数按批 `matches.findByIds` 追完 `superseded_by`，再顺序映射，消除每页 100+ 次串行查询。
   - `ShareCardQueryService.getShareCard`（`src/application/share-card.ts:149-157`）：改为收集当轮未作废比赛的 `canonical_match_id ?? match_id`，一次调用 `this.repo.predictions.findByUserAndCanonicalMatchIds(userId, canonicalIds)` 后建立 `Map` 查找。
   - `RankingQueryService.list`（`src/application/ranking-query.ts:581-671, 846-856`）：
     - 将历史终榜赛季检查由“对每个历史赛季 `findFinalBySeason` 全量拉行”改为按轻量存在性判断（例如 `listFinalSeasonIds` 本身已通过 `distinctQuery` 排除 `snapshot_kind === "head"`，无需再把所有历史赛季的成千上万行终榜快照拉进内存）；
     - 收集当前渲染榜及 `availableBoards` 所需 snapshot/ranking 的 `user_id` 后通过 `users.findByIds` 批量预加载进 `userCache`，并避免与当前请求无关的 `availableBoards` / 历史季节快照反复做串行读；对 `available_boards` 的计数可仅检查当前所需的榜或借助轻量存在性判定优化。
   - `RebuildUserStatsService.rebuildUserStatsInTransaction`（`src/application/stats-rebuild-service.ts:300-316`）：
     - 用 `tx.settlementItems.findByUserAndStatus(userId, SettlementItemStatus.Applied)` 替代全表 `findByStatus(Applied)`；
     - L302 校验比赛是否在结算中时先解析 `superseded_by` 找到 `effectiveMatch` 再检查 `activeSettlement(effectiveMatch)`，防止正在换 ID 后新比赛结算期间并发重建。
   - `SettlementItemApplicationService`（`src/application/settlement-item-application-service.ts:182-261, 493-579`）：为同一调用内的 `resolveEffectiveMatch(tx, matchId)` 注入 `Map<string, Match | null>` 缓存，并在更正归零重算时一次性读取并过滤有效比赛。
   - `loadDailyConsistencySnapshot`（`src/application/daily-consistency-snapshot.ts:624-683`）：按批 `inFilter` 或并发可控的方式批量拉取 `settlements` / `settlementItems` / `predictions`，在用户/比赛循环内定期检查 `lockRenewal?.assertHealthy()`，发现丢锁立即中止并释放连接。
3. **消除 `findSettlementFallbackPage` 与 `board_snapshots.findLatest` 的 $O(N^2)$ 翻页扫描**：
   - `board_snapshots`（`cloudbase-app-repository.ts:734-778`）：为 `CloudBaseDb` 增加可选或用 `is_final: false`（与 `PostgresDocumentDb` 对兼容缺失 `is_final` 字段的支持：`PostgresDocumentDb` 专用最新非终榜快照查询方法 `findLatestRegularBoardSnapshot`），结合 `ix_board_snapshots_season_final` 直接由 DB 返回最新非终榜时间点，避免在终榜写入后按 `OFFSET 0, 100, 200...` 扫描全表终榜行。
   - `findSettlementFallbackPage`（`cloudbase-app-repository.ts:946-968`）：按 `after` 游标直接下推 `gteFilter("kickoff_at", after.kickoff_at)`（或专有 PG SQL 查询 `(kickoff_at, match_id) > ($1, $2)` 且排除 `voided`）从断点处续扫，不再每次从 `offset = 0` 重头拉全部已完场历史。

### 3.4 `CloudBaseWxDb` 历史分页与目录去重修复（`#13`）

- 位置：`src/infrastructure/cloudbase-wx-db.ts:226, 310-390`
1. **修复 `offset` 与同时间戳漏行/死循环**：
   - 将云开发底层查询从单键 `orderBy("submitted_at", "desc")` 改为双键稳定排序 `.orderBy("submitted_at", "desc").orderBy("prediction_id", "desc")`（微信云开发链式查询支持多次 `.orderBy`），确保相同 `submitted_at` 跨 100 行批次边界时顺序与游标严格一致。
   - 修正翻页推进：`sameTimeCount` 不得覆盖累加的 `offset`。仅当 `batch` 末尾时间戳与**进入本批时的 `cursor.submitted_at`**相同时，`offset += sameTimeCount`（而非 `offset = sameTimeCount`）；若缺少 `lteFilter`，始终使用 `offset += batch.length` 步进。
2. **明确触达扫描保护上限时的可观测与降级策略**：
   - 提高/可配置 `HISTORY_MAX_BATCHES`（或在未集齐一页且命中上限时通过游标续扫而非假装没有下一页 `has_more: false`）；当 `DISTINCT_MAX_ROWS` 被触发导致未完整扫完 `matches` 时记录高优先级结构化告警事件，同时 `distinctQuery` 带上 `superseded_by: null` 过滤条件（或在无法下推时投影 `superseded_by` 后仅对非作废比赛聚合）。

### 3.5 验收测试
- `src/schema/indexes.test.ts` & `postgres-schema.test.ts`：覆盖新增 6 条索引与行值游标、`canonical_match_id` 表达式一致。
- `postgres-document-db.test.ts` & `.pg.test.ts`：验证带 `limit` 的分批 `deleteWhere`、`findSettlementFallbackPage` 游标续扫、`findLatestRegular` 存在大批量终榜时不翻扫。
- `cloudbase-wx-db.test.ts`：构造 250 条相同 `submitted_at` 跨批次边界、及 `lteFilter` 缺失场景，验证翻页无重复、无漏行、无死循环。
- `stats-rebuild-service.test.ts` / `ranking-query.test.ts` / `prediction-list.test.ts` / `share-card.test.ts`：计数断言 `findByIds` / `findByUserAndCanonicalMatchIds` / `findByUserAndStatus` 调用次数为常数级别（$O(1)$ 批），不再随记录数线性膨胀；验证重组覆盖 `M_old -> M_new (settling)` 正确拦下并发重建。

---

## Slice 4（P2 小程序登录恢复、分享闭环与首页跨日/并发修复）

- **覆盖问题**：`#4`、`#14`、`#15`、`#16`
- **前置依赖**：Slice 0

### 4.1 `auth: "optional"` 公开接口失效 Token 匿名回退（`#4`）

- 位置：`miniprogram/services/api.js:189-231`
- 方案：
  1. 在 `recoverUnauthorized(result, context)` 中：当 `context.authMode === "optional"` 且 `context.hadAuthorization` 为真、接口返回 `401 UNAUTHORIZED` 时：
     - 先按原有逻辑尝试 `beginSessionRecovery` 静默换新。
     - 若静默换新失败（`authResult && authResult.statusCode !== 200`）或因并发导致 `loginGeneration` 变化（或已经清掉了失效 token），**不要把 401/authResult 直接返回给业务页**，而是确保本地失效 `auth_session` 已被清除后，使用匿名状态重发原请求一次（`{ ...context, anonymousRetry: true }`，并在 `resolveRequestToken(path, authMode, options)` 当 `anonymousRetry === true` 时不再附加 `Authorization`）。
  2. 在 `miniprogram/pages/share-card/share-card.js:337-344` 与 `miniprogram/pages/my-predictions/my-predictions.js` 中，确保 `mode === "receiver"` 调用 `getShareCardForUser` 与 `listLeagueSeasons` 均可零登录态正常展示。

### 4.2 分享卡闭环与登录回流跳转纠偏（`#14`、`#15`）

1. **`miniprogram/pages/share-card/share-card.js` 三项修复（`#14`）**：
   - `onShow()`（L149-162）：兼容 CloudBase 传输——仅当 `isHttpTransport()` 时检查 `isAuthSessionActive(readAuthSession(), new Date())`；在 `transport === "cloud"` 下若 `this.pendingLoginRetry` 为真（从 `return_to=share-card` 登录返回），直接清标记、恢复上下文并调用 `this.loadCard()`。
   - `onReselect()`（L502-511）：若当前失败来自他人卡片（如 `errorKind === "userUnavailable"`）或处于 `receiver` 模式点「重新选择」，同步重置 `mode: "preview"`、`sharerId: ""`（对 `userUnavailable` 必须切回 `preview` 并清空 `sharerId`），避免再次请求已注销原分享者形成死循环。
   - `formatGeneratedAt()`（L46-51）：改用 `new Date(time + 8 * 60 * 60 * 1000)` + `getUTCFullYear/UTCMonth/UTCDate/UTCHours/UTCMinutes` 纯 UTC+8 算术计算（可复用 `matches.js` 或抽到 `miniprogram/utils/beijing-time.js`），消除跨时区设备显示错位。
2. **`miniprogram/pages/session/session.js` 回流优先级与邀请码清理（`#15`）**：
   - L178-188：当 `this.data.returnTo === "share-card" || this.data.returnTo === "match-detail"` 时，**优先**执行 `wx.navigateBack({ delta: 1 })` 回到原调用场景（不让陈年 `pending_group_invite_code` 劫持当前回跳）；只有在非特定 `returnTo` 回流时才消费并清理 `pending_group_invite_code`。
   - L219-221：在 `onSkip()` 点击跳过登录时调用 `wx.removeStorageSync("pending_group_invite_code")`，彻底避免放弃登录后的残留邀请码后续突袭其它页面。

### 4.3 `matches.js` 首页跨日/换季刷新、定时器回收与提交防护（`#16`）

- 位置：`miniprogram/pages/matches/matches.js:145-255, 406-421`（改完需跑视觉脚本 `verify-home-migration.py`）
1. **跨午夜 / 跨 7 月 1 日自动刷新日历条与等级赛季文案**：
   - 提取 `syncHeaderDatesAndSeason()`：计算当前北京时间 `today = beijingParts()` 与 `nextSeasonLabel = formatLevelSeasonLabel(currentSeasonId(new Date().toISOString()))`。若 `this.data.dates` 为空或 `this.data.dates[0].key !== today.key`，重建 `dates = buildDates(new Date())`；若用户原先选中项恰好是旧 `dates[0].key`（昨天“今天”）或不在新 `dates` 内，同步将 `selectedDate` 迁往新 `dates[0].key`，并按需刷新 `levelSeasonLabel`。
   - 在 `onShow()` 与 `onPullDownRefresh()` 开头调用 `syncHeaderDatesAndSeason()`。
2. **回收未取消的 `setTimeout` 句柄与清空日期计数**：
   - 在 page 实例保存 `this.reloadTimer` 与 `this.scrollTimer`，每次在 `onLeagueTap`、`onDateTap`、`onNextMatchTap`、`onPredictTap` 启动新定时器前先 `clearTimeout`，并在 `onUnload` / `onHide` 清理。
   - `onDateTap`（L215）补全 `hasMore: false, nextCursor: null, openCount: 0, doneCount: 0, hintText: ""` 与 `onLeagueTap` 对齐。
3. **保护正在提交中的预测卡片**：
   - `closeEditors()`（L406）判断 `if (this.uiStates[key] !== "collapsed" && this.uiStates[key] !== "submitting")` 才重置并删除 `drafts[key]`，防止提交请求尚未返回时打开另一张卡片把进行中卡片误重置为可再提交状态。

### 4.4 验收测试
- `miniprogram/services/api.test.mjs`：`auth: "optional"` 请求携带服务端已失效的未过期 token 收到 401，且 `wx.login` / `POST /v1/auth/wechat` 失败或并发 `loginGeneration` 变更时，自动清掉 token 后以匿名重发并成功拿回 200。
- `miniprogram/pages/share-card/share-card.test.mjs`：覆盖 CloudBase 模式下 `return_to=share-card` 登录回退后自动加载卡片；`userUnavailable` 点「重新选择」切回本人 `preview` 且不再请求坏 `sharerId`；非 UTC+8 时区下 `formatGeneratedAt` 仍输出北京时间。
- `miniprogram/pages/session/session.test.mjs`：覆盖缓存残留 `pending_group_invite_code` 时 `return_to=share-card` 优先 `navigateBack`，以及 `onSkip` 清除 `pending_group_invite_code`。
- `miniprogram/pages/matches/matches.dates.test.mjs` & `matches.workflow.test.mjs`：覆盖跨北京时间 00:00 `onShow` 刷新「今天」与跨 7 月 1 日刷新 `levelSeasonLabel`；快速连切联赛/日期只发最后 1 次请求；提交中（`"submitting"`）点击其它比赛卡片不会解锁提交中状态。
- 执行 `python3 docs/design/scripts/verify-home-migration.py` 验证首页视觉基线未被破坏。

---

## Slice 5（P2 队徽补全与「我的预测 / 个人中心 / 排行榜 / 设置」状态完善）

- **覆盖问题**：`#17`、`#18`、`#19`（其余前端项）
- **前置依赖**：Slice 4

### 5.1 `Deportivo Alavés` 队徽修复与 `getTeamLogo` 名称兜底（`#18` 前半）

- 位置：`miniprogram/utils/logo-registry.js:163-176, 238-244`
1. 在 `TEAM_ALIASES.la_liga` 中补齐 `"deportivo-alaves": "deportivo"`，使 `TEAM_REGISTRY` 全部 112 支核心球队均能 100% 匹配打包队徽资源（无一退回 `PLACEHOLDER`）。
2. 修改 `getTeamLogo(leagueId, team)`（L238-244）：当按 `findTeam(teamId)` 查得 `{ league_id, source_name }` 但 `lookupLeagueLogo(found.league_id, found.source_name)` 返回 `null` 时，继续回退尝试 `lookupLeagueLogo(leagueId, teamName)`，避免有名称别名却过早返回 `PLACEHOLDER`。

### 5.2 `profile.js` 并发保护、失效缓存清理与无界翻页收敛（`#18` 后半）

- 位置：`miniprogram/pages/profile/profile.js:121-275`
1. **并发序列与异常兜底**：为 `loadPage()` 增加单调递增 `this.profileRequestSerial` 校验（含首轮 `Promise.all` 与后续 `listMyGroups` 分页循环每步之后）及 `.catch()` 兜底错误态，避免后发先至覆盖以及异常卡死在 `loading`。
2. **失效图标缓存修复**：
   - `loadFavoriteTeam()` 只有在 `teamLogo && teamLogo !== PLACEHOLDER` 时才执行 `wx.setStorageSync("team_logo:" + teamId, teamLogo)`，绝不把 `PLACEHOLDER` 写进缓存；若已有旧占位缓存则在落入未命中分支后移除或覆写。
   - `onTeamLogoError()`（L274）在把页面切回 `PLACEHOLDER` 时，同步执行 `if (this.data.favoriteTeamId) wx.removeStorageSync("team_logo:" + this.data.favoriteTeamId)`，防止损坏路径长期残留。
   - `loadFavoriteTeam()` 的降级 `listMatches({ limit: 100, cursor })` 循环增加明确最大翻页上限（如 `MAX_TEAM_LOOKUP_PAGES = 5`，最多 500 场近期比赛），避免非注册表冷门升班马在每轮 `onShow` 无休止翻扫接口。

### 5.3 `my-predictions`、`rankings`、`settings` 状态恢复补齐（`#17`、`#19`）

1. **`miniprogram/pages/my-predictions/my-predictions.js` & `.wxml`（`#17`）**：
   - 翻页失败保持列表不丢失：在 `applyListResult(result, replace, serial)` 中，当 `replace === false`（即 `loadNextPage` 触发）且遇网络错误或非 200 时，仅设置 `{ errorMessage, loadingMore: false }`（保留 `state: "list"` 与已加载 `items`/`weeks`，直接消费 `my-predictions.wxml:65` 既有的 `inline-error` 与底部「加载更多」按钮重拉）；同时检查 `matches.js:325` 与 `rankings.js:492-507` 在 `replace === false` 翻页失败时同样不得覆盖整页 `state: "error"` 清掉已展示内容。
   - 筛选目录失败提供重试入口：在 `my-predictions.wxml:15` 的 `filterError` 块内补充 `<button bindtap="onFilterRetry">重试</button>`，并在 `my-predictions.js` 实现 `onFilterRetry()`；`onRetry()` 在 `!this.data.filterReady` 时同步重试 `loadFilters()`。
2. **`miniprogram/pages/rankings/rankings.js`（`#19`）**：
   - 在 `loadFirstPage` / `onShow` 处理完新返回的 `groupsResult.data.items` 时，对于**后端依然正常列出的合法 `group_id`**，从 `this.invalidGroupIds` 自动清除（或者仅当进入失效群恢复时临时置黑、下一次重新拉到该群即解禁），使用户在其他入口重新加群后 `onShow` 立即可见。
   - L525-531 与 L564-573 的 `this.setData(..., () => ...)` 回调内检查 `if (this.requestSerial !== requestSerial) return;` 后再调用 `this.loadFirstPage()`。
   - 为 `groupsResult`、`levelsResult` 及 `applyListResult` 中的 `rankingsResult` 补充 `401 UNAUTHORIZED`（切换 `guest`）与 `409 USER_DELETED`（切换 `userDeleted`）处理，与 `getMyProfile` 口径统一。
3. **`miniprogram/pages/settings/settings.js`（`#19`）**：
   - 在 `miniprogram/utils/nickname.js` 导出 `clearNickname()`（调用 `wx.removeStorageSync(NICKNAME_STORAGE_KEY)`）。
   - 在 `settings.js:134` 用户主动确认退出 `onLogout()` 中 `clearAuth()` 时同步调用 `clearNickname()`（注意不要把 `clearNickname()` 放进 `auth.clearAuth()`，以免 `api.js` 在 HTTP 401 静默续签期间误删当前用户昵称），保证退出后登录页与游客态首页不再残留上一账号昵称。

### 5.4 验收测试
- `miniprogram/utils/logo-registry.test.mjs`：新增全量校验遍历 `TEAM_REGISTRY` 全部 112 支球队，`getTeamLogo(entry.league_id, { team_id: id, name: entry.source_name })` 返回值全部 `!== PLACEHOLDER`（特别覆盖 `"00235af4-869b-4953-a3b7-afc3f8024d81"` / Deportivo Alavés）。
- `miniprogram/pages/profile/profile.team-logo.test.mjs` & `profile.season-count.test.mjs`：`loadPage` 并发先后覆盖测试；`onTeamLogoError` 清 storage；非注册球队超过最大页数时停扫描。
- `miniprogram/pages/my-predictions/my-predictions.test.mjs`：第 2 页加载失败保留第 1 页内容并展示行内重试；`loadFilters` 失败后可通过按钮与整页 `onRetry` 重拉目录。
- `miniprogram/pages/rankings/rankings.group-invalid.test.mjs` & `rankings.rate-limit.test.mjs`：之前失效的群在后续 `listMyGroups` 恢复出现后可选回；子请求返回 401/409 正确切换访客/注销态；`setData` 延迟回调遇到新请求序号直接放弃。
- `miniprogram/pages/settings/settings.test.mjs`：退出登录后验证 `NICKNAME_STORAGE_KEY` 被清除。

---

## 附录：上线验收顺序与真实环境未覆盖项

1. **推荐执行顺序**：
   - **第一批（阻断上线项，必须上线前合入）**：Slice 0 → Slice 1
   - **第二批（长短期运营与稳定性，强烈建议上线前合入）**：Slice 2 → Slice 3
   - **第三批（小程序用户体验与状态机兜底）**：Slice 4 → Slice 5
2. **需在真机 / 在线环境补验项目**（本地单测无法替代）：
   - Caddy 反代下 `X-Forwarded-For` / `X-Real-IP` 是否正确传入 Gateway 并实现单用户独立限流桶。
   - 真实 PostgreSQL 上执行新增 6 条索引建表 DDL、`compilePredictionHistoryPage` 行值游标 `EXPLAIN ANALYZE` 索引命中验证，以及 `.pg.test.ts` 全量运行（含原子 `renewJobLock` / `releaseJobLock` 与分批 `deleteWhere`）。
   - 微信开发者工具 / 真机双账号分享全链路回归、CloudBase 传输下 `return_to=share-card` 登录回跳、退出登录后进入首页与登录页状态。
