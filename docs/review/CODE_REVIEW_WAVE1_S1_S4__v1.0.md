# 赛事预言家：首版全面 Code Review 报告 — Wave 1（S1 + S4）

> 审查日期：2026-11-24  
> 对应计划：[FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md](FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md)  
> 审查范围：**S1（身份认证、会话管理、权限边界与 HTTP 网关）** + **S4（预测计分、幂等结算、赛果修正与一致性/重建）**  
> 首版基线：VPS 首发（PostgreSQL + HTTP 网关）、全部页面/入口及自动换季纳入首版门禁

---

## 0. Wave 1 审查总览

### 0.1 结论摘要

| 切片 | 总体风险 | 表 A：P0（阻断） | 表 A：P1（高危） | 表 A：P2（优化） | 表 B：口径差异（待裁决） |
|---|---|---:|---:|---:|---:|
| **S1（鉴权与网关）** | **高** | 1 | 7 | 2 | 6 |
| **S4（计分与结算账本）** | **高** | 1 | 6 | 2 | 6 |
| **Wave 1 合计** | **高** | **2** | **13** | **4** | **12** |

**两个上线阻断级 P0 摘要**：
1. **`A-S1-01`（远程崩进程 DoS）**：`src/gateway/http.ts:167` 在 `try/catch` 外部解析 `new URL(req.url, ...)`，发送畸形 URL 可直接触发未捕获 Promise rejection 令 Node 20 网关进程退出。
2. **`A-S4-01`（PostgreSQL 并发丢分/统计覆盖）**：`src/infrastructure/postgres-document-db.ts:339, 364, 1173` 在默认 `READ COMMITTED` 下无行锁读取整文档并全量 `document || $2::jsonb` 覆写；同用户跨场并发结算，或结算与等级评估/资料变更并发时，已提交积分和统计会被静默覆盖丢失，而单元测试使用的 `InMemoryRepository` 全局串行事务掩盖了该真并发缺陷。

### 0.2 本次实测自动化验证基线

- **TypeScript 类型检查**：`tsc -p tsconfig.json --noEmit` 通过（exit 0）。
- **后端 S1 + S4 测试套件**：39 个测试文件（514 条用例）全部通过；2 个真实 PostgreSQL 集成测试文件因未配置 `FOOTBALL_TEST_DATABASE_URL` 被跳过：
  - `src/gateway/http-auth.pg.test.ts`（3 skipped）
  - `src/infrastructure/vps03-settlement-idempotency.pg.test.ts`（1 skipped）
  - （另：`src/infrastructure/postgres-auth-sessions.pg.test.ts` 1 skipped、`src/gateway/repository-factory.test.ts` 中 PG 事务用例 1 skipped）
- **小程序端 S1 测试套件**：4 个测试文件（`app`、`services/api`、`services/auth`、`pages/session`，共 128 条用例）全部通过。

---

## 第一部分：切片 S1（身份认证、会话管理、权限边界与 HTTP 网关）

### S1.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S1-01** | **P0** | `src/gateway/http.ts:165-170` | **畸形 `req.url` 在 `try/catch` 外解析导致网关进程崩溃（远程 DoS）**：`http.createServer` 回调的 async IIFE 先执行 `new URL(req.url ?? "/", ...)` 与 `parseQuery(...)`，第 170 行才进入 `try`。遇到可触发 `TypeError: Invalid URL` 的请求目标（如 `GET //:80`、`GET http://[invalid]`）且反代未先拦截时，产生未捕获 rejection，Node 20 默认直接退出进程。 | 将 `new URL(...)` 与 `parseQuery(...)` 移入 `try/catch` 内，非法 URL 统一返回 `400` / `422`。 |
| **A-S1-02** | **P1** | `src/application/profile-mutation.ts:120-179`<br>`src/gateway/assemble.ts:492-504`<br>`src/infrastructure/postgres-auth-sessions.ts:28-32, 67-69`<br>`src/infrastructure/postgres-schema.ts:154-160` | **账号注销后未吊销 `auth_sessions` 有效会话，重注册后旧 Token 可串联接管新账号**：`DELETE /v1/profile/me` 仅写 `deleted_openid_mappings` 并墓碑化 `users.openid`，未清理 `auth_sessions`（尽管已建 `ix_auth_sessions_openid` 索引，代码中零调用）。<br>**复现**：用户注销后，旧设备/泄漏端持原 `access_token`（默认 7 天有效）仍可解析出原 `openid`，不仅可直接调 `POST /v1/session/init` 建新号，若用户在另一设备重注册新号，旧 Token 会按“`active` 优先于 `deleted`”规则直接绑定到新 `user_id`。 | 在 `AuthSessionStore` 增加 `deleteByOpenid(openid)`；在 `DELETE /v1/profile/me` 成功后立即吊销该 `openid` 的全部活跃会话，并补充端到端回归测试。 |
| **A-S1-03** | **P1** | `src/gateway/http.ts:83-91`<br>`ops/vps/Caddyfile:7-9`<br>`src/api/v1/rate-limit.ts:55-107` | **可信代理头顺序不当叠加 Caddy 未覆写 `X-Real-Ip`，可伪造请求头绕过限流并膨胀内存**：`extractClientIp` 在本机回环反代下优先取 `x-real-ip`；但 `Caddyfile` 仅配裸 `reverse_proxy 127.0.0.1:8787`，未覆写客户端自带的 `X-Real-Ip`。外部攻击者每次请求伪造随机 `X-Real-Ip` 即可无限绕过 `120 req/min/IP` 限流并向内存 `windows` 持续灌入新 key。 | 在 `Caddyfile` 显式配置 `header_up X-Real-Ip {remote_host}`；`extractClientIp` 仅信任反代权威覆写头，并对内存限流 Map 增加容量上限保护。 |
| **A-S1-04** | **P1** | `src/gateway/assemble.ts:276-297, 348-358, 583-596`<br>`src/api/v1/share-card.ts:68-81`<br>`src/api/v1/league-seasons.ts:33-65` | **3 个公开/高成本接口未接入限流**：<br>1) `POST /v1/auth/wechat` 完全无限流，匿名高频发垃圾 `code` 可直接放大触发对微信 `jscode2session` 的出站请求；<br>2) `GET /v1/share-card/{user_id}` 无限流且每次实时聚合轮次赛程与预测；<br>3) `GET /v1/league-seasons` 无限流（同为公开读的 `/v1/matches`、`/v1/leagues/status`、`/v1/profiles/{user_id}` 均已限流）。 | 为 `/v1/share-card/{user_id}` 与 `/v1/league-seasons` 接入 `public_reads` 限流；为 `POST /v1/auth/wechat` 接入按 IP 的专属防刷限流与基础 `code` 格式预检。 |
| **A-S1-05** | **P1** | `src/gateway/http.ts:40-59`<br>`ops/vps/Caddyfile:7-9` | **HTTP 网关 `readJsonBody` 与 Caddy 均无请求体大小限制，存在 OOM DoS 风险**：`readJsonBody` 无上限收集 chunk 后 `Buffer.concat`，向免鉴权的 `POST /v1/auth/wechat` 发送超大流式请求体即可耗尽内存。 | 在 `readJsonBody` 增加字节上限（如 64KB~256KB，超限即销毁流返回 413/422），并在 `Caddyfile` 配置 `request_body { max_size ... }`。 |
| **A-S1-06** | **P1** | `miniprogram/services/matches.js:12-24`<br>`miniprogram/services/leagues.js:3-5`<br>`miniprogram/services/api.js:299-324` | **小程序公开只读接口漏传 `auth: "optional"`，本地凭证过期时阻塞游客主链路**：`listMatches`、`getMatchDetail`、`getLeagueStatus` 未声明 `auth: "optional"`。若本地存有过期 `auth_session`，游客进首页会被强制触发 `wx.login` 换票；一旦交换失败，首页赛程与联赛状态直接报错不可用，无法回落到服务端支持的匿名响应。 | 为 `listMatches`、`getMatchDetail`、`getLeagueStatus` 补充 `auth: "optional"`（`getMatchCrowd` 保持 `required`）。 |
| **A-S1-07** | **P1** | `miniprogram/pages/session/session.js:172-213` | **会话初始化页 `onSubmit` 缺少异常捕获，抛错时界面永久卡死 `loading: true`**：`initSession(nickname).then(...)` 无 `.catch()` / `.finally()` 复位 `loading`，若前置请求或存储同步抛错，按钮永久禁用无法重试。 | 补全 `try/catch/finally` 或 `.catch().finally()`，确保任何异常路径复位 `loading: false` 并允许重试。 |
| **A-S1-08** | **P1** | `src/gateway/assemble.ts:276-286, 299-305`<br>`src/api/v1/openapi.yaml:52-60, 87-88, 120-128, 614-626, 808-811`<br>`src/api/v1/openapi-auth-h4.test.ts:76-93` | **OpenAPI 契约与实现及守卫测试多处脱节**：<br>1) `POST /v1/auth/wechat` 对非字符串 `code`（如 `{ code: 123 }`）转空串返回 `401`，但 OpenAPI 声明 `string` 且未声明 `422`；<br>2) `GET /v1/groups/me` 错误引用了 `PredictionHistoryNotFound`/`Conflict`；<br>3) `POST /v1/session/init` 已改 D-P1 方案 B 无 `409` 路径，OpenAPI 仍声明 `409` 且缺 `500`；<br>4) `/v1/league-seasons`、`/v1/share-card/{user_id}` 缺 `429`；<br>5) 携带失效 Bearer 访问任何公开接口都会因前置解析返回 `401`，OpenAPI 公开接口未声明 `401`；<br>6) `openapi-auth-h4.test.ts` 回归列表遗漏 6 个 `/v1/groups*` 与 `/v1/predictions/summary`。 | 逐项对齐 `openapi.yaml` 与网关实现，并将全部 `/v1/groups*` 与 `/v1/predictions/summary` 加入 `openapi-auth-h4.test.ts` 守卫。 |
| **A-S1-09** | **P2** | `src/api/v1/admin-anomalies.ts:89-104` | **管理异常列表接口先限流后鉴权（与其余管理接口倒置）**：普通已登录非管理员高频请求 `GET /v1/admin/anomalies` 会先扣 `admin_apis` 配额，61 次后由 `403` 变为 `429`，并污染内存限流桶。 | 参考 `src/api/v1/admin.ts` 先执行 `authorizeAdmin`，确认活跃管理员后再扣除 `admin_apis` 限流配额。 |
| **A-S1-10** | **P2** | `miniprogram/pages/session/session.js:19-22, 192-200`<br>`src/gateway/assemble.ts:348-358, 756`<br>`src/gateway/http.ts:61-69` | **校验口径偏差、死分支与 HTTP 响应细节**：<br>1) 昵称长度前端按 `Array.from`（code point）算、后端按 `Intl.Segmenter`（grapheme）算，组合 Emoji 会在前端被误拦；<br>2) `session.js` 仍留有不可达的 `409 USER_DELETED` 死分支；<br>3) 多数路由方法不匹配返回 `422` 而非 `405`；<br>4) `writeJson` 对 `204` 仍写 `Content-Type: application/json`。 | 统一前后端字数计数策略；清理死分支；路由方法不匹配统一 `405`；`204` 跳过 `Content-Type` 与 body。 |

### S1.2 表 B：代码与文档口径差异（待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S1-01** | `src/infrastructure/postgres-auth-sessions.ts:67-69, 98-110`<br>`src/infrastructure/postgres-schema.ts:175` | `auth_sessions.token` 以 32 字节随机串**明文**落库并按明文等值查询；若 DB 快照或只读账号泄漏，有效期内会话可直接被冒用。 | `VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md:175` 写“首期不开发凭证安全专项”；`MVP__v2.0.md:5316` 仅禁日志记凭据，未规定落库必须哈希。 | `[x] 判为 Bug（改 SHA-256 摘要落库）`（✅ 已定：零 UX 影响的高价值安全加固） |
| **D-S1-02** | `src/gateway/http.ts:163`<br>`src/api/v1/rate-limit.ts:55-107` | VPS 网关使用单进程 `InMemoryRateLimiter`，未给 PostgreSQL 实现 `RateLimitStore`（重启清零、不支持多实例）。 | `VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md:286` 明确裁定“VPS 首期单 API 进程保留现有 `InMemoryRateLimiter`”。 | `[x] 认代码（首版限定单进程）`（✅ 已定：符合 Q2 单机 VPS 首发方案） |
| **D-S1-03** | `src/gateway/assemble.ts:348-358, 583-596`<br>`src/application/share-card.ts:128-134` | 新增两个免登录公开接口 `GET /v1/league-seasons` 和 `GET /v1/share-card/{user_id}`；后者在目标用户已注销时返回 `409 USER_DELETED`（不同于公开主页返回 `200 + "已注销用户"`）。 | `MVP__v2.0.md` §29 仅定义登录态 `GET /v1/share-card/me`，未记载这两个公开接口；§24.3 规定已注销用户公开战绩显示“已注销用户”。 | `[x] 判为 Bug（改 200 脱敏展示，与公开主页对齐）`（✅ 已拍板） |
| **D-S1-04** | `src/gateway/assemble.ts:475-490`<br>`miniprogram/services/profile.js:10-13` | 新增 `POST /v1/profile/me` 作为 `PATCH /v1/profile/me` 的兼容别名（适配小程序 `wx.request`）。 | `MVP__v2.0.md:3471` 仅定义 `PATCH /v1/profile/me`。 | `[x] 认代码`（✅ 已定：纯小程序 `wx.request` 兼容别名） |
| **D-S1-05** | `src/gateway/assemble.ts:492-504`<br>`miniprogram/pages/settings/settings.js:126-139` | 后端完整实现 `DELETE /v1/profile/me`，但**小程序端无任何账号注销入口**（`settings` 页仅提供本地清缓存的“退出登录”按钮）。 | Q3 已拍板“账号注销”纳入首版；`MVP__v2.0.md:589, 3488` 定义了注销但明确不提供 `/v1/auth/logout`。 | `[x] 已按 Q3 升级为 S6 表 A P0 缺陷（A-S6-02）`（✅ 已定） |
| **D-S1-06** | `miniprogram/app.json:2-3`<br>`miniprogram/pages/session/session.js:49-65` | `pages/session/session`（昵称初始化页）固定为小程序第 0 号启动页，且 `onLoad` 不检查本地已有会话，老用户每次冷启动也会先进填昵称页（且初始无跳过按钮）。 | `MVP__v2.0.md:154` 允许游客直接浏览赛程；`VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md:222` 要求正常启动恢复已有会话。 | `[x] 判为 Bug（默认进比赛首页，游客优先）`（✅ 已拍板） |

### S1.3 权限边界核查结论（正向确认）
- **未发现游客或已注销用户越权访问私有/榜单/管理接口的路径**：`/v1/rankings`、`/v1/matches/{id}/crowd`、`/v1/predictions/*`、`/v1/profile/me`、`/v1/levels/me`、`/v1/unlocks/me`、`/v1/share-card/me`、全部 `/v1/groups*` 均强制 `authenticatedReadUserId`（或幂等预测写校验）；全部 `/v1/admin/*` 均经 `AdminAuthorizationService` 校验活跃管理员；`prod` 环境下 `identity.ts:6-16` 强制丢弃 `FOOTBALL_MOCK_TRUSTED_OPENID`；错误响应统一掩码内部堆栈。

---

## 第二部分：切片 S4（预测计分、幂等结算、赛果修正与一致性/重建）

### S4.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S4-01** | **P0** | `src/infrastructure/postgres-document-db.ts:339, 362-366, 1173`<br>`src/application/settlement-item-application-service.ts:442-455, 505-540, 550-589, 606-619`<br>`src/application/weekly-level-eval.ts:484-520, 573-615`<br>`src/application/level-correction-reeval.ts:407-464, 500-565`<br>`src/application/profile-mutation.ts:87-115, 129-175` | **PostgreSQL `READ COMMITTED` 无行锁先读后全量覆盖，并发跨场结算或并发等级/资料变更导致积分与统计丢更新（违反 §15.6）**。<br>**复现路径**：<br>1) `PostgresDocumentDb` 开启默认 `BEGIN`（`READ COMMITTED`），`get` 无 `FOR UPDATE`，`update` 为 `document || $2::jsonb` 全字段覆盖；锁粒度仅为单场 `settlement:match:{match_id}`。<br>2) **跨场同用户并发结算**：场次 `M1` 与 `M2` 并发结算同一用户 `U`，两事务分别读出旧 `users` / `user_season_stats` / `rankings`，各自加 delta 后整文档回写，先提交事务的分数、命中数与有效场次被静默覆盖丢失，且两笔 `settlement_items` 均标记 `applied`，后续无法通过重试补回。<br>3) **结算 vs 等级评估/资料更新交叉覆盖**：`WeeklyLevelEvalService`、`LevelCorrectionReevalService`、`ProfileMutationService`（无锁）均读取整份 `users` / `user_season_stats` 后整文档回写，与结算并发时会把刚入账的积分退回旧值。<br>（注：单测用的 `InMemoryRepository.withTransaction` 全局串行事务，完全掩盖了该真并发缺陷。） | 1) 在 `PostgresDocumentDb` 为 `users`、`user_season_stats`、`rankings` 引入事务内 `SELECT ... FOR UPDATE` 行锁（按固定顺序加锁防死锁）或原子增量更新原语；<br>2) `ProfileMutationService`、`WeeklyLevelEvalService`、`LevelCorrectionReevalService` 改用局部字段 `patchFields`（`jsonb_set`），禁止整文档覆写积分/统计字段。 |
| **A-S4-02** | **P1** | `src/application/admin-result-correction.ts:143-206`<br>`src/application/provider-result-sync.ts:250-254, 297-323`<br>`src/application/first-settlement-service.ts:137-139, 515-533`<br>`src/infrastructure/cloudbase-app-repository.ts:503-540` | **赛果写入方不持场次结算锁且全量覆盖 `matches`，PG 并发下可把 `settling` 退回 `waiting` 或抛 500**：`AdminResultCorrectionService` 与 `ProviderResultSyncService` 在 `match` 为 `waiting` 时因 `from === to` 跳过更新未加行锁，随后整文档 `matches.update`；若此时 `FirstSettlementService` 已将 `match` 推进至 `settling`，写入方会把它覆盖回 `waiting`（触发后续 `MATCH_STATE_CONFLICT`）；`ProviderResultSyncService` 的 `sameScore` 分支整文档回写也会在并发下触发状态倒退或版本号回退 500。 | 对 `matches` 写入改为 `FOR UPDATE` 读取后按职责字段局部 `patchFields`（不覆写 `settlement_status`/`settled_result_version`/`settled_at`），并加强仓储层状态机与版本 invariant 守卫。 |
| **A-S4-03** | **P1** | `src/application/retry-settlement-target.ts:108-126`<br>`src/application/admin-retry-settlement.ts:142-146` | **等待期跳版本直结后若修正失败，管理员重试必报 500 永久卡死**：`waiting` 保护期内赛果由 `v1 -> v2` 时，首次结算直接按 `v2` 结算（无 `v1` settlement）。后续 `v3` 修正失败调用 `AdminRetrySettlementService.retry` -> `selectFailedSettlementTarget` 时，第 109 行已算出 `firstSettlementVersion = 2`，但第 121 行却硬编码 `for (let version = 1; version <= match.settled_result_version; version += 1)`，因查不到 `v1` settlement 直接抛 `InternalError`，管理员入口无法恢复。 | 将 `retry-settlement-target.ts:121` 循环起点由 `1` 改为 `firstSettlementVersion`，校验 `[firstSettlementVersion..settled_result_version]` 连续性。 |
| **A-S4-04** | **P1** | `src/application/settlement-item-application-service.ts:226-252, 550-588`<br>`src/application/ranking-rebuild-service.ts:235-245, 291-308`<br>`src/application/daily-consistency-snapshot.ts:537-559, 833-882`<br>`src/domain/invariants.ts:120-131` | **已注销用户在周榜存在三方分裂，本周重建清零后遇负分修正必触发负数 invariant 崩溃**：<br>1) 增量重排未排除注销用户仍给 `global_rank`；<br>2) `RebuildPeriodRankingsService` 将注销用户的当周 `rankings` 行就地清零（`period_score=0, valid_predictions=0`）；<br>3) `DailyConsistency` 未过滤注销用户，重建后必报差异；<br>4) **确定性崩溃**：若当周已执行周榜重建把注销用户行清零，随后本周某场赛果修正为 `12 -> 0`（`score_delta = -12`），`SettlementItemApplicationService` 计算 `0 + (-12) = -12`，触发 `assertRankingInvariants` 抛 `InternalError`，整场修正结算永久失败。 | 持久化 `rankings` 应保留注销用户的真实周统计累加值（保证修正 delta 闭合），在非历史周排序与重建时仅将其 `global_rank` 置为 `null` 而不清零积分/计数；统一增量重排、周期重建与一致性校验三者口径。 |
| **A-S4-05** | **P1** | `src/application/level-correction-reeval.ts:245-249, 272-281`<br>`src/application/rebuild-service-support.ts:307-312`<br>`src/application/stats-rebuild-service.ts:390-406, 493-520` | **修正重评与重建回放（`replayLevel`）在 7/1 跨季冻结前窗口及 `score_delta === 0` 场景产生等级永久分裂**：<br>1) 6 月底比赛若在 7/1 之后、首个周一终评冻结之前（`is_level_frozen === false`）发生修正，`LevelCorrectionReevalService:274` 仅比较 `levelSeasonOf(anchor) === levelSeasonOf(asOf)` 直接跳过重评，导致终评冻结错误等级，而重建/一致性回放会改判；<br>2) `score_delta === 0` 时线上重评跳过，而重建 `buildReplayFacts` 仍将 `settled_at` 纳入重放时间点，导致周中重建提前升级。 | 1) 修正重评改为以 `user_season_stats.is_level_frozen !== true` 判断而非简单比对 `levelSeasonOf(asOf)`；<br>2) 经 `D-S4-01` 裁决后，严格统一线上重评与 `buildReplayFacts` 对 `score_delta === 0` 的口径。 |
| **A-S4-06** | **P1** | `src/application/daily-consistency-snapshot.ts:628-646, 659-708, 744-757`<br>`src/application/rebuild-service-support.ts:31-33, 154-163, 307-312` | **每日一致性从第二年起永久漏检所有老用户的 `career`；且任一修正单处于 `failed` 会令每日校验与重建崩溃**：<br>1) 快照仅按各联赛近 2 个赛季加载 `matches`，自 `2028-01-01` 起导致首个等级赛季 `2026_2027` 不可验证，进而跳过所有在 `2026_2027` 有有效预测的老用户的全部 `career` 一致性校验；<br>2) `activeSettlement` 未识别 `failed` 修正单（部分 item 已 `applied` 但 `settlement.settled_at === null`），导致 `DailyConsistency` 与 `RebuildUserStatsService` 读入后在 `buildReplayFacts:308` 抛 `INVALID_LEDGER` 整体崩溃。 | 1) `daily-consistency-snapshot` 改为按有效 `settlements`/`settlement_items` 分批按引用拉取关联 `matches` 用于 `career` 核对；<br>2) `buildReplayFacts` / `DailyConsistency` 对未完成（`failed`、`settled_at === null`）的修正单做好跳过或隔离处理。 |
| **A-S4-07** | **P1** | `src/application/first-settlement-service.ts:430-458`<br>`src/application/retry-settlement-service.ts:285-310`<br>`src/application/correction-settlement-service.ts:383-408` | **结算失败收尾写 `Failed` 事务缺少锁所有权围栏**：Worker A 执行某 item 阻塞超时丢锁、Worker B 合法接管锁重新运行后，Worker A 抛错进入 `catch` 事务未调用 `renewSettlementLockForFinalize`，会强行把 Worker B 正在跑的 `settlement` 与 `match` 覆盖为 `failed`。 | 三个服务的 `catch` 写 `Failed` 事务首行均增加 `renewSettlementLockForFinalize(tx, lockKey, ownerId)` 围栏；失锁则放弃写回。 |
| **A-S4-08** | **P2** | `src/application/daily-consistency-service.ts:147-149`<br>`src/application/stats-rebuild-service.ts:307`<br>`src/application/ranking-rebuild-service.ts:123, 159-160, 343`<br>`src/application/admin-rebuild-*.ts`<br>`src/application/level-correction-reeval.ts:44, 206-219`<br>`src/runtime/scheduled-jobs.ts:84-90` | **5 处任务锁租约未对齐墙钟 + 等级修正重评撞锁后缺周内补偿**：<br>1) 5 处重建/一致性入口仍用 `serverNow + 10m` 算租约，而 PG `acquireJobLock` 用墙钟 `new Date()` 判过期，历史回放或时钟偏移时锁即刻失效；<br>2) `LevelCorrectionReevalService` 撞全局单锁 `sync:level_correction_reeval` 后直接 `skipped` 留 `pending`，但周期调度未补扫，滞留单要拖到下周一。 | 1) 5 处租约统一改用 `Math.max(serverNow.getTime(), Date.now()) + LEASE_MS`；<br>2) 为 `LevelCorrectionReevalService` 补撞锁短重试或在周期调度补扫 `pending` 修正单。 |
| **A-S4-09** | **P2** | `src/application/settlement-timer.ts:53-71, 148-150`<br>`src/infrastructure/cloudbase-app-repository.ts:1012-1033` | **历史累积 >=50 场阻塞异常会令新完场场次在高频结算定时器中饥饿延迟最长 12 小时**：`findSettlementTodos({ limit: 50 })` 按 `kickoff_at ASC` 拉取后才在内存过滤 open blocking anomaly，一旦未处理阻塞异常 >=50 场，高频定时器每次全被占满跳过，新完赛场次只能等 12 小时兜底扫描。 | 为阻塞异常场次隔离查询或支持游标续扫直至填满可执行配额。 |

### S4.2 表 B：代码与文档口径差异（待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S4-01** | `src/application/level-correction-reeval.ts:245-249, 272-281`<br>`src/application/rebuild-service-support.ts:307-312` | 线上修正重评过滤 `score_delta !== 0` 且仅限 `levelSeasonOf(anchor) === levelSeasonOf(asOf)`；而重建回放对所有受 `is_correction` 影响的 `settled_at`（含 `score_delta === 0` 及 7/1 后未冻结上季）均重放。 | `MVP__v2.0.md` §17.7 与 §17.9.2 / §17.8.4 自身存在内部表述冲突（一处写 `score_delta ≠ 0` 且仅当前季，另一处写全部 correction settled_at 且首次周评后才冻结）。 | `[x] 认 §17.9.2+未冻结规则（同步修 A-S4-05）`（✅ 已定：保证线上重评与重建回放严格一致） |
| **D-S4-02** | `src/domain/types.ts:195-292`<br>`src/schema/indexes.ts:52-219` | 新增 `settlements.level_reeval_status/completed_at`、`matches/predictions.canonical_match_id/superseded_by`、`matches/match_results.result_provider/compared_providers` 字段与对应索引。 | `MVP__v2.0.md` §21、§22 未记载上述扩展字段与索引。 | `[x] 认代码（纳入新口径）`（✅ 已定：多源核验与身份连续性必需扩展） |
| **D-S4-03** | `src/application/first-settlement-service.ts:431, 466`<br>`src/application/retry-settlement-service.ts:311-329`<br>`src/application/correction-settlement-service.ts:409-435` | `itemWorker` 失败落库 `failed` 后，`FirstSettlementService.start` 向外抛异常，而 `Retry`/`Correction` 返回 `{ kind: "failed" }` 对象（`settlement-timer` 外层已统一捕获）。 | 文档未规定内部服务返回契约。 | `[x] 认代码`（✅ 已定：纯内部实现契约，无外部影响） |
| **D-S4-04** | `src/infrastructure/postgres-document-db.ts:446, 468`<br>`src/application/first-settlement-service.ts:238-240` | 底层 `jobLocks` 到期判断统一使用系统墙钟 `new Date()`，已调优服务按 `Math.max(serverNow, Date.now())` 计算租约。 | `MVP__v2.0.md` §32.7 写“初次 `lease_until = server_now + JOB_LEASE_MINUTES`，不使用进程墙钟”。 | `[x] 认代码（租约采用系统墙钟，并修 A-S4-08 对齐剩余 5 处）`（✅ 已定） |
| **D-S4-05** | `src/application/ranking-rebuild-service.ts:291-308`<br>`src/application/stats-rebuild-service.ts:408-418, 514-519` | 1) 周榜重建无物理删除，多余行就地清零（`valid_predictions = 0`）；<br>2) 用户统计重建对已注销用户和已冻结赛季原样保留持久化等级、不回放纠错。 | 1) `MVP__v2.0.md` §21.9/§40 写周榜文档仅在 `valid_predictions >= 1` 时存在；<br>2) §17.9.3 写已冻结赛季回放到最终评估，§17.10 写注销冻结。 | `[x] 认代码（A-S4-04 注销清零崩溃另修）`（✅ 已定） |
| **D-S4-06** | `src/application/daily-consistency-snapshot.ts:231-264, 628-646`<br>`src/application/daily-consistency-service.ts:190-201` | 每日一致性按 `completeCoverageStart` 截断验证；快照后有变更则跳过 `rank` 核对；发现差异以 `status=success` 写 `sync_logs`（`DAILY_CONSISTENCY_MISMATCH`）+ 结构化日志报警，不写 `anomalies`。 | `MVP__v2.0.md` §34.5 仅规定“发现不一致只报警，不自动静默修复”，未细化截断规则与报警载体。 | `[x] 判为 Bug（同步写非阻塞 anomalies）`（✅ 已定：确保 Q3 管理 UI 可直接看到对账差异告警） |

---

## 第三部分：Wave 1 测试与验证覆盖缺口汇总

1. **PostgreSQL 真库并发集成测试严重缺失（最高优先级）**：所有 `*.pg.test.ts` 在无 `FOOTBALL_TEST_DATABASE_URL` 时默认跳过；且即便接入 PG，也完全缺少 **真实 `READ COMMITTED` 并发写冲突用例**（同用户跨场并发结算、结算与赛果同步/修正并发、结算与等级/资料更新并发）。现有单测因 `InMemoryRepository` 全局串行事务，对 `A-S4-01` / `A-S4-02` 完全失明。
2. **HTTP 传输层安全边界缺测**：缺少畸形 `req.url`、超大 JSON body、慢请求超时、伪造 `X-Real-Ip` 绕过限流的端到端测试。
3. **注销后会话吊销缺测**：未覆盖“登录拿 Bearer → `DELETE /v1/profile/me` → 原 Bearer 立即 401 且重注册后不串号”的闭环测试。
4. **结算与重建高危边角缺测**：缺少等待期跳版本直结后修正失败重试（`A-S4-03`）、注销用户周榜重建后遇负分修正（`A-S4-04`）、7/1 冻结前窗口修正重评（`A-S4-05`）、`2028+` 老用户 `career` 校验及 `failed` 修正单态下的每日一致性测试（`A-S4-06`）、失败写 `Failed` 锁围栏测试（`A-S4-07`）。

---

## 第四部分：产品快速裁决清单（表 B 共 12 条）

为了方便你集中拍板，以下汇总 Wave 1 的全部 12 条口径差异（每条只需回复编号 + 结论，如 `D-S1-01 改哈希` / `D-S1-02 认代码`）：

1. **`D-S1-01`**：`auth_sessions.token` 明文落库 — 认代码，还是改 SHA-256 哈希落库？
2. **`D-S1-02`**：VPS 首版用单进程内存限流（不建 PG 限流表） — 认代码（限定单进程），还是补 PG 限流？
3. **`D-S1-03`**：免登录公开接口 `/v1/league-seasons` 和 `/v1/share-card/{user_id}`（注销用户返回 409 而非 200 脱敏） — 认代码，还是调整？
4. **`D-S1-04`**：`POST /v1/profile/me` 兼容别名 — 认代码？
5. **`D-S1-05`**：小程序端无账号注销入口（仅后端有 `DELETE /v1/profile/me`，前端只有本地清缓存退出） — 移入 S6 补前端注销入口，还是首版不放前端入口？
6. **`D-S1-06`**：小程序第 0 号启动页固定为填昵称页（老用户冷启动也先进） — 认代码，还是改为有会话自动跳过/默认进首页？
7. **`D-S4-01`**：修正重评 vs 重建回放在 `score_delta === 0` 及 7/1 冻结前窗口的口径 — 推荐统一按“未冻结即重评 + 统一 `score_delta` 规则”，你倾向哪种？
8. **`D-S4-02`**：`settlements` / `matches` / `predictions` / `match_results` 新增扩展字段与索引 — 认代码并收口到文档？
9. **`D-S4-03`**：首次结算失败抛异常 vs 重试/修正失败返回 `{ kind: "failed" }` — 认代码，还是统一契约？
10. **`D-S4-04`**：任务锁租约采用系统墙钟 `Math.max(serverNow, Date.now())` — 认代码（并修剩余 5 处对齐）？
11. **`D-S4-05`**：周榜重建多余行清零（不物理删）+ 注销/已冻结赛季重建不回放等级 — 认代码（另修 `A-S4-04` 崩溃）？
12. **`D-S4-06`**：每日一致性差异仅写 `sync_logs` + 结构化日志告警（不写 `anomalies`） — 认代码，还是同步写 `anomalies`？
