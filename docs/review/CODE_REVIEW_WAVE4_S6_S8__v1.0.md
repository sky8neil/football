# 赛事预言家：首版全面 Code Review 报告 — Wave 4（S6 + S8）

> 审查日期：2026-11-24  
> 对应计划：[FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md](FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md)  
> 交叉基准：[CODE_REVIEW_WAVE1_S1_S4__v1.0.md](CODE_REVIEW_WAVE1_S1_S4__v1.0.md)、[CODE_REVIEW_WAVE2_S2_S3__v1.0.md](CODE_REVIEW_WAVE2_S2_S3__v1.0.md)、[CODE_REVIEW_WAVE3_S5_S7__v1.0.md](CODE_REVIEW_WAVE3_S5_S7__v1.0.md)（已登记问题不重复计数，仅做交叉引用）  
> 审查范围：**S6（个人资料/主队/注销、分享卡、解锁记录与小程序体验闭环 + Q3/Q4）** + **S8（管理运维/管理 UI 核查、VPS 生产部署与发布门禁 + Q2/Q3）**

---

## 0. Wave 4 审查总览

### 0.1 结论摘要

| 切片 | 总体风险 | 表 A：P0（阻断） | 表 A：P1（高危） | 表 A：P2（优化） | 表 B：口径差异（待裁决） |
|---|---|---:|---:|---:|---:|
| **S6（资料/注销/分享卡/解锁）** | **高** | 2 | 4 | 3 | 2 |
| **S8（管理 UI / VPS 生产部署）** | **高** | 1 | 10 | 4 | 4 |
| **Wave 4 合计** | **高** | **3** | **14** | **7** | **6** |

**三个上线阻断级 P0 摘要（均属于 Q3 已拍板首版必做功能的完整前端缺失）**：
1. **`A-S6-01`（公开主页前端完全缺失）**：后端已实现 `GET /v1/profiles/:user_id`，但 `miniprogram/app.json` 无公开主页注册，`services/profile.js` 未封装该接口，排行榜/群榜行亦无点击跳转他人公开主页入口。
2. **`A-S6-02`（账号注销前端入口完全缺失，由 Wave 1 `D-S1-05` 按 Q3 正式升级）**：后端已实现 `DELETE /v1/profile/me`，但 `services/profile.js` 未封装注销调用，`pages/settings` 仅提供清本地缓存的“退出登录”按钮，无真实账号注销入口。
3. **`A-S8-01`（管理 UI 完全缺失）**：全仓库无任何 Web 管理前端或小程序管理页（`miniprogram/` 零 `admin` 引用），仅有 5 个后端 `/v1/admin/*` 接口与 1 个仅负责授权/禁用管理员的 `scripts/vps-admin.mjs` CLI。

### 0.2 本次实测自动化验证基线

- **TypeScript 类型检查与构建**：`./node_modules/.bin/tsc -p tsconfig.json --noEmit` 与 `./node_modules/.bin/tsc -p tsconfig.build.json` 均通过（exit 0）。
- **VPS 部署预检**：`node scripts/deploy-preflight.mjs --target=vps` 通过（exit 0；注：仅校验调度粒度与同步间隔，且 `prod` 下漏检 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`，见 `A-S8-11`）。
- **Wave 4 自动化测试套件**（S6 + S8 后端、脚本与小程序端，共 47 个测试文件）：
  - **45 个文件通过（445 条用例）**；
  - **2 个真实 PostgreSQL 集成测试文件跳过**（因未配置 `FOOTBALL_TEST_DATABASE_URL`）：`src/infrastructure/postgres-document-db.pg.test.ts`（13 skipped）、`src/infrastructure/vps08-init.pg.test.ts`（1 skipped；另有 2 条条件用例跳过，合计 16 skipped）。

---

## 第一部分：切片 S6（个人资料/主队/注销、分享卡、解锁记录与小程序体验闭环）

### S6.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S6-01** | **P0** | `miniprogram/app.json:2-15`<br>`miniprogram/services/profile.js:1-18`<br>`miniprogram/pages/rankings/rankings.wxml:19, 21` | **Q3 确认必做的「公开主页」前端完全缺失**：后端已提供 `GET /v1/profiles/:user_id`（`src/api/v1/profile.ts:122-141`、`src/gateway/assemble.ts:506-519`），但 `miniprogram/app.json` 全部 12 个注册页面中无公开主页，`services/profile.js` 无 `getPublicProfile(userId)` 封装，排行榜与群榜行均无点击进入他人公开主页的交互。 | 1) 在 `services/profile.js` 新增 `getPublicProfile(userId)`（`auth: "optional"`）；<br>2) 新增 `pages/public-profile/*` 并注册至 `app.json`（覆盖正常态、已注销用户 `"已注销用户"` 脱敏态与 404 态）；<br>3) 在排行榜与群榜行点击跳转该页。 |
| **A-S6-02** | **P0** | `miniprogram/services/profile.js:1-18`<br>`miniprogram/pages/settings/settings.js:47-140`<br>`miniprogram/pages/settings/settings.wxml:1-27`<br>（由 Wave 1 `D-S1-05` 按 Q3 升级） | **Q3 确认必做的「账号注销」前端入口完全缺失**：`services/profile.js` 未封装 `DELETE /v1/profile/me`，`pages/settings` 仅有 HTTP 模式下清理本地缓存的 `onLogout`（退出登录），用户无法在小程序内执行账号注销。（需联动修复 Wave 1 `A-S1-02` 吊销 `auth_sessions` 与 Wave 3 `A-S5-05` 清理 `group_members`。） | 在 `services/profile.js` 新增 `deleteMyProfile()`；在 `pages/settings` 增加带强二次确认弹窗的“注销账号”危险入口，成功后清空本地会话态并 `reLaunch` 至登录页。 |
| **A-S6-03** | **P1** | `miniprogram/pages/profile/profile.js:446-450`<br>`miniprogram/pages/profile/profile.wxml:1-36` | **Q4 纳入首版的「解锁记录页」在小程序内完全不可达**：`profile.js:446-450` 已实现 `onUnlocksTap()` 跳转 `/pages/unlocks/unlocks`，但 `profile.wxml`（含第 33 行 utility 卡片，仅绑定 `onRulesTap` 与 `onSessionTap`）未绑定 `onUnlocksTap`，全仓库也无任何其他页面跳转 `/pages/unlocks/unlocks`。 | 在 `profile.wxml:33` 的 utility 卡片中补回绑定 `bindtap="onUnlocksTap"` 的“解锁记录”入口按钮（不暗示装扮穿戴能力）。 |
| **A-S6-04** | **P1** | `miniprogram/pages/share-card/share-card.js:92, 306-312, 449-471` | **分享卡页开启了朋友圈分享菜单但未定义 `onShareTimeline()`**：第 92/308 行调用 `wx.showShareMenu({ menus: ["shareAppMessage", "shareTimeline"] })`，但页面仅实现了 `onShareAppMessage()`，缺少 `onShareTimeline()`。真机点击朋友圈分享无法携带 `user_id`/`league_id`/`season_id`/`round_id`，好友打开会落入空白页。 | 补齐 `onShareTimeline()` 返回 `{ title, query: "user_id=...&league_id=...&season_id=...&round_id=..." }`；若首版不支持朋友圈分享，则将 `SHARE_MENU_OPTIONS` 收窄为 `["shareAppMessage"]`。 |
| **A-S6-05** | **P1** | `miniprogram/pages/settings/settings.js:54-65, 109-115`<br>`miniprogram/pages/settings/settings.wxml:6` | **设置页未区分处理 `401 UNAUTHORIZED` 与 `409 USER_DELETED`**：`loadProfile()` 遇 401/409 仅展示通用错误与“重新加载”按钮（无“去登录”入口，注销态点击重试陷入无限 409）；`onSave()` 遇 401/409 也仅显示 `saveErrorMessage`，不引导重新登录或清理失效会话。 | 在 `settings.js` 显式区分 `401`（展示“去登录”跳转 `/pages/session/session`）与 `409 USER_DELETED`（展示已注销提示并隐藏重试按钮）。 |
| **A-S6-06** | **P1** | `miniprogram/pages/unlocks/unlocks.wxml:8, 13, 18, 22` | **解锁记录页错误态展示裸英文 `"retry"` 且 `unauthorized` 态无登录按钮**：第 13、18、22 行三个错误分支按钮文案均为小写英文 `"retry"`；第 8 行 `state === 'unauthorized'` 仅渲染纯文本无跳转登录入口。 | 将 3 处 `retry` 改为中文“重试”；为 `unauthorized` 态补充“去登录”按钮跳转 `/pages/session/session`。 |
| **A-S6-07** | **P2** | `miniprogram/pages/profile/profile.js:23-32, 267-325` | **`clearIdentityPatch` 未递增 `favoriteTeamRequestId`，存在跨账号/登出主队异步回写竞态**：`clearIdentityPatch` 递增了 `recentRequestSerial` 取消在途近期预测，但未递增 `favoriteTeamRequestId`。若账号 A 的 `loadFavoriteTeam()` 正在翻页拉 `listMatches`，此时切号/登出，A 的迟到回调仍会将 A 的 `favoriteTeamText`/`favoriteTeamLogo` 写回页面。 | 在 `clearIdentityPatch(page)` 中同步递增 `page.favoriteTeamRequestId` 并复位 `favoriteTeamId`/`favoriteTeamText`/`favoriteTeamLogo`。 |
| **A-S6-08** | **P2** | `miniprogram/pages/settings/settings.js:54-65`<br>`miniprogram/pages/unlocks/unlocks.js:100-132`<br>`miniprogram/pages/share-card/share-card.js:314-348` | **弱网并发重试竞态与限流态不一致**：`settings.js` `loadProfile()` 与 `unlocks.js` `loadPage()` 缺 `requestSerial` 守卫（`unlocks.js` 仅在 `onLoad` 拉取，登录返回不自动刷新）；`share-card.js` `mapCardError` 未区分 `429 RATE_LIMITED`，落入 `failed` 分支仍展示重试按钮。 | 为 `settings.js`/`unlocks.js` 补 `requestSerial`（`unlocks` 补 `onShow` 登录恢复）；`share-card.js` 增加 `429` -> `rateLimited` 分支且禁重试。 |
| **A-S6-09** | **P2** | `src/gateway/assemble.ts:506-519`<br>`src/application/unlock-persistence.ts:19-52` | **公开主页路由漏检未知 query 参数 + 死代码**：`GET /v1/profiles/:user_id` 未调 `assertUnknownFields(input.query, new Set())`；`UnlockPersistenceService` 在生产代码零引用（结算与重建均内联写入），属死代码。 | `assemble.ts:508` 补充 `assertUnknownFields(input.query, new Set())`；清理或统一复用 `UnlockPersistenceService`。 |

> **交叉引用 Wave 1 & Wave 3 已登记问题（不重复计数）**：**`A-S1-02`（P1）**（注销未吊销 `auth_sessions`）、**`A-S1-04`（P1）**（`GET /v1/share-card/{user_id}` 无限流）、**`A-S1-10`（P2）**（昵称前端 `Array.from` vs 后端 `Intl.Segmenter` 计数差异）、**`A-S4-01`（P0）**（`ProfileMutationService` 整文档覆写 `users` 与结算并发丢积分）、**`A-S5-05`（P1）**（注销未清理 `group_members`）。

### S6.2 表 B：代码与文档口径差异（待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S6-01** | `src/gateway/assemble.ts:583-596`<br>`src/api/v1/share-card.ts:68-81`<br>`src/application/share-card.ts:24-48, 124-127, 183-188`<br>`miniprogram/pages/share-card/share-card.wxml:2, 39-84`<br>`miniprogram/pages/share-card/share-card.js:449-471` | 1) 新增公开接口 `GET /v1/share-card/{user_id}` 并支持历史赛季；<br>2) 目前仅返汇总指标与 `pending_predictions` 计数、**不返单场明细**，且未校验分享签名；<br>3) `share-card.wxml:2` 背景图用 `/assets/images/home-pitch-bg.webp`（与首页 `/assets/images/baseline-pitch.webp` 不一致）。 | `MVP__v2.0.md` §29.1（4148–4181 行）仅定义登录态 `/v1/share-card/me`、限定当前赛季、不含单场明细。 | `[x] 判为需求改造（已结算>3场显完整汇总+战绩标题，≤3场仅显身份+晒预测标题；下方全程展示单场真实明细含未开赛照抄与未完赛标记；配 share_token 防偷窥；去掉 pending 提示；背景图改与首页一致）`（✅ 已拍板） |
| **D-S6-02** | `miniprogram/pages/unlocks/unlocks.js:4-8, 77-91`<br>`miniprogram/pages/unlocks/unlocks.wxml:1-32` | 小程序保留解锁记录页并消费 `GET /v1/unlocks/me`，在 `UNLOCK_LABELS` 硬编码 3 项中文名（“资料卡样式 1 / 主队名配色 / 主队头像框 1”），展示门槛/日期/进度及 `UI-02` 空态，无装扮穿戴/预览能力。 | `MVP__v2.0.md` §18.2/§28.2 原禁前端消费解锁接口与自行命名；已获 Q4 与 `MINIPROGRAM_UX_REQUIREMENTS` UI-02 有限例外批准，待收口入 `FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md`。 | `[x] 认代码（正式记入首版例外清单）`（✅ 已定：符合 Q4 与 UI-02 拍板） |

### S6.3 正向合规核查确认
- **公开主页与分享卡隐私红线严格通过（P0 核查通过）**：`GET /v1/profiles/{user_id}` 仅返回聚合统计与昵称/主队，绝不返回任何比赛预测明细，注销用户强制脱敏为 `"已注销用户"`；`GET /v1/share-card/{user_id}` 严格过滤 `superseded_by == null` 且仅统计满足 `isCurrentSettledFact` 的已结算事实，绝不泄露任何他人未截止比赛的预测比分或胜平负。
- **解锁规则与不可回收合规（F12 / Q4）**：30/100/200 生涯积分门槛只追加不删除，赛果修正扣分绝不回收既有解锁记录；`unlocks.wxml` 无违规装扮穿戴/预览能力。
- **自定义 TabBar 与分享回流闭环扎实**：`custom-tab-bar` 在 3 个 Tab 页 `onShow` 正确同步选中态；`share-card.js` 正确区分本人态与好友落地态，卡片未就绪时 `onShareAppMessage` 安全回退至首页。

---

## 第二部分：切片 S8（管理运维、管理 UI 核查与 VPS 生产部署门禁）

### S8.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S8-01** | **P0** | 全仓库（`miniprogram/app.json:2-15`、`src/gateway/assemble.ts:598-675`、`scripts/vps-admin.mjs`） | **Q3 确认首版必做的「管理 UI」完全缺失**：全仓库无任何独立 Web 管理前端（无 `web/`/`admin/`/`public/`），小程序内亦无任何管理页（`grep -ri admin miniprogram/` 为 0 命中）。目前仅有 5 个后端 `/v1/admin/*` API 和 1 个仅负责授权/禁用管理员的 `scripts/vps-admin.mjs` CLI。运营人员无法在界面中查看异常、修正赛果、重试结算或触发重建，直接触发 Q3 上线阻断。 | 补齐**最小可用管理 UI**（推荐独立轻量 Web 管理页配管理员登录，或小程序内仅对活跃管理员可见的管理分包），覆盖：<br>1) 异常列表/筛选与手动解除（`GET /v1/admin/anomalies` + 新增 resolve 接口，见 `A-S8-03`）；<br>2) 赛果修正表单（`POST /v1/admin/matches/:id/result-corrections`）；<br>3) 重试结算操作（`POST /v1/admin/matches/:id/retry-settlement`）；<br>4) 重建用户统计（`POST /v1/admin/rebuild/users/:id`）；<br>5) 重建排行榜（`POST /v1/admin/rebuild/rankings`）；<br>6) 只读审计日志查询（建议补 `GET /v1/admin/audit-logs`）。*注：若选独立 Web 端，需配套非 `wx.login` 的管理员认证机制。* |
| **A-S8-02** | **P1** | `src/application/retry-settlement-service.ts:253, 287-328, 351-412`<br>`src/application/correction-settlement-service.ts:351, 385-434, 457-523` | **`retry-settlement`（普通与改判路径）在 DB 事务提交后才写入 `admin_audit_logs`，破坏原子审计约束**：两处均定义 `const tx = this.repo`，并在失败/完成 `withTransaction` 提交**之后**调用 `auditWriter(tx, ...)`。若结算已提交但随后的审计写入遇 DB 瞬断或进程崩溃，结算永久生效但审计账本丢失记录（违反 MVP §30.1）。 | 将 `auditWriter` 移入失败路径与 finalize 路径的 `withTransaction(async (tx) => ...)` 事务内部，使用真实事务句柄并移除混淆的 `const tx = this.repo`。 |
| **A-S8-03** | **P1** | `src/application/admin-result-correction.ts:143-241`<br>`src/gateway/assemble.ts:598-675`<br>`src/application/first-settlement-service.ts:265` | **阻塞型异常（`blocking=true`）缺少管理员解除入口，且赛果修正不自动解除异常，导致结算永久死锁**：所有结算入口均在 `findOpenBlockingByMatch(matchId)` 非空时硬拒（`409 SETTLEMENT_NOT_READY`）。当完场比赛产生无自动恢复路径的阻塞异常（如 `UNEXPECTED_PROVIDER_STATUS`、`PROVIDER_STATE_CONFLICT`、`ADMIN_PROVIDER_RESULT_CONFLICT`）时，即使管理员通过 `result-corrections` 人工录入正确比分，阻塞异常仍保持 `open`，后续自动结算与 `retry-settlement` 永久 409，全系统无 resolve API/CLI，只能手改数据库绕过审计。 | 1) 新增带强审计的 `POST /v1/admin/anomalies/:anomaly_id/resolve`（必填非空 `reason`，事务内写 `admin_audit_logs`）；<br>2) `AdminResultCorrectionService.correct` 同事务内按白名单自动 resolve 赛果类阻塞异常并记录 `resolution = "admin_result_correction:<audit_id>"`。 |
| **A-S8-04** | **P1** | `src/application/profile-mutation.ts:120-179`<br>`src/gateway/assemble.ts:598-675`<br>`src/application/admin.ts:20-40` | **管理员注销个人账号后，其 `admins` 权限未被禁用，仍可执行全部管理操作**：`deleteMyProfile` 未同步禁用同 `openid` 的 `admins` 记录，且 5 条 `/v1/admin/*` 路由直接透传 `trustedOpenid` 不检查用户是否已注销。注销后的管理员凭未过期 token 或重登后仍可操作赛果修正与重建。 | 在 `ProfileMutationService.deleteMyProfile` 同事务内查询 `tx.admins?.findByOpenid(user.openid)`，若为 `active` 则同步置为 `AdminStatus.Disabled`。 |
| **A-S8-05** | **P1** | `scripts/vps-admin.mjs:7-10, 33-66` | **`scripts/vps-admin.mjs` 参数解析高危缺陷：缺值吞掉后续 flag 写脏管理员，拼错 `--status` 静默回落 `active`**：<br>1) 执行 `--openid --apply ...` 时，`argValue` 返回 `"--apply"` 且 `hasFlag("--apply")` 为 `true`，直接向库写入 `openid="--apply"` 的活跃管理员；<br>2) 运维吊销管理员时若误敲 `--statu disabled`，未知 flag 被静默忽略，`status` 回落 `active` 并返回 exit 0，实际未完成吊销。 | 改用 Node 内置 `node:util` `parseArgs({ strict: true, allowPositionals: false })`，严格拒绝未知参数、位置参数及以 `-` 开头的参数值。 |
| **A-S8-06** | **P1** | `src/gateway/config.ts:172-179`<br>`src/gateway/http.ts:148-160` | **`FOOTBALL_ENVIRONMENT=prod` 允许配置 `FOOTBALL_REPOSITORY_BACKEND=memory` 并自动灌入演示 seed 数据**：`loadGatewayRuntimeConfig` 未禁止生产环境使用内存仓储；配置失误启动后直接进入 `http.ts:148` 灌入假比赛与假榜单数据。 | 在 `loadGatewayRuntimeConfig` 中对 `rawEnvironment === "prod" && repositoryBackend === "memory"` 立即 Fail-Closed 抛错拒绝启动。 |
| **A-S8-07** | **P1** | `src/gateway/repository-factory.ts:67-75` | **借出的 `pg.PoolClient` 未挂载 `'error'` 监听器，事务期间数据库断连直接崩溃 Node 进程**：`pool.on("error")` 仅覆盖空闲连接（`pg-pool` 借出连接后会移除其 idle 监听）；`createPostgresConnect` 直接返回原始 `client`。若事务执行中 PG 重启、连接被 `pg_terminate_backend` 或触发 `idle_in_transaction_session_timeout`，`client` 触发未监听 `'error'` 事件导致 `ERR_UNHANDLED_ERROR` 令整个网关进程退出。 | 在 `createPostgresConnect` 为借出的 `client` 挂载单次 `'error'` 监听记录 `clientError` 并写结构化日志；在 `release(err)` 中卸载监听并传 `client.release(err ?? clientError)` 销毁断连。 |
| **A-S8-08** | **P1** | `src/gateway/http.ts:171-175`<br>`src/runtime/vps-runtime.ts:46-54`<br>`ops/vps/Caddyfile:7-9` | **公开无限流 `GET /health` 经 Caddy 暴露且每次直查 PostgreSQL，存在连接池耗尽 DoS 风险**：`GET /health` 在限流之前短路处理，`postgres` 模式下每次请求无缓存直发 `pool.query("SELECT 1")`；`Caddyfile` 透传全路径至 `127.0.0.1:8787`，匿名高频请求 `/health` 即可打满 `FOOTBALL_PG_POOL_MAX (20)` 阻塞全部业务请求。 | 在 `Caddyfile` 屏蔽公网访问 `/health`（`@health path /health` -> `respond @health 404`，仅允许本机回环探活），并在 `healthCheck()` 增加 1–2 秒结果缓存/并发合并。 |
| **A-S8-09** | **P1** | `src/gateway/http.ts:206-214, 242-247` | **HTTP 网关优雅停机不完整**：仅在 `startGatewayServer().then` 后注册 `SIGTERM`（启动期信号丢失、无 `SIGINT`）；`server.close()` 未调 `closeIdleConnections()`，Caddy 的 HTTP/1.1 空闲长连接会拖延停机；`closeResources()`（`pool.end()`）以 `void` 丢弃异常且未等待完成；入口 `.then()` 缺 `.catch()`。 | 统一注册 `SIGTERM`/`SIGINT` 优雅退出逻辑：调用 `server.closeIdleConnections()`、等待 `server.close()` 与 `await closeResources()`（带兜底强制退出超时）并补齐启动 `.catch()`。 |
| **A-S8-10** | **P1** | `src/gateway/config.ts:120-136`<br>`src/infrastructure/environment-config.ts:1-69`<br>`scripts/vps-db.mjs:86-129` | **缺少 `FOOTBALL_ENVIRONMENT` 与 PG `schema`/`namespace` 隔离校验，`vps-db.mjs --apply` 无 `--allow-prod` 护栏**：`environment-config.ts` 在生产代码零引用（死代码）；`dev`/`test` 进程配置 `FOOTBALL_DATABASE_SCHEMA=football_prod` 可直接连生产库读写（违反 MVP §38）；`vps-db.mjs --apply` 亦不检查生产确认标志。 | 在 `loadPostgresRepositoryConfig` 强制校验环境与 `schema`/`namespace` 隔离（`dev`/`test` 禁止含 `prod`，`prod` 禁止含 `dev`/`test`，并校验 URL 协议与 schema 合法标识符）；`vps-db.mjs --apply` 对生产目标强制要求 `--allow-prod`。 |
| **A-S8-11** | **P1** | `scripts/deploy-preflight.mjs:101-111` | **VPS 生产预检漏检必填的 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`**：`deploy-preflight.mjs` 在 `FOOTBALL_ENVIRONMENT=prod` 时仅调用 `parseLevelFirstEvalAsOf`，未调用 `parseRankingFirstPeriodKey`，而网关与任务进程启动时强制要求该变量，导致预检放行但生产启动崩溃。 | 在 `deploy-preflight.mjs:110` 同步调用 `gatewayConfig.parseRankingFirstPeriodKey(env, env.FOOTBALL_ENVIRONMENT)`。 |
| **A-S8-12** | **P2** | `src/api/v1/admin.ts:73-79, 125-131`<br>`src/application/admin-rebuild-rankings.ts:166-170`<br>`src/application/admin-grant.ts:85-95`<br>`src/gateway/assemble.ts:613-675` | **管理端 API 与授权脚本四处规范瑕疵**：<br>1) `reason` 未 `.trim()`，纯空白 `"   "` 可绕过审计非空校验；<br>2) `admin-rebuild-rankings.ts:167` 撞锁误报 `SETTLEMENT_ALREADY_RUNNING` 而非已注册的 `RANKING_REBUILD_ALREADY_RUNNING`；<br>3) `applyAdminGrant` 无事务包裹且授权/吊销无持久化审计日志；<br>4) 4 条管理 POST 路由未调 `assertUnknownFields(input.query, new Set())`。 | 统一 `reason.trim().length >= 1`；改用 `RANKING_REBUILD_ALREADY_RUNNING`；`applyAdminGrant` 接入事务与审计记录；4 条 POST 路由补齐未知 query 校验。 |
| **A-S8-13** | **P2** | `src/infrastructure/cloudbase-app-repository.ts:1312-1320` | **`GET /v1/admin/anomalies` 在 PostgreSQL 下全表拉取 `anomalies` 到内存过滤分页**：`findAnomalyPage` 调用 `this.all("anomalies")` 后在 JS 内存筛选切片；`anomalies` 按 MVP §37 永久留存，长期运行存在内存膨胀与 30s 查询超时隐患。 | 将 `status`、`blocking`、keyset 游标与 `ORDER BY last_seen_at DESC, anomaly_id DESC LIMIT limit + 1` 下推至 PostgreSQL 查询层。 |
| **A-S8-14** | **P2** | `src/infrastructure/postgres-document-db.ts:268-318`<br>`src/infrastructure/postgres-schema.ts:135-161, 305-366` | **PostgreSQL 查询编译与 Schema DDL 三处隐患**：<br>1) `{ field: null }` 编译为 `(document -> 'field') = 'null'::jsonb`，无法命中 `->>` 表达式索引且漏掉缺失该键的文档；<br>2) 对未声明字段用 `Date`/`number`/`boolean` 过滤时两侧类型不匹配报 SQL 错；<br>3) `applyPostgresSchema` 无并发锁（并发执行易撞 `pg_type_typname_nsp_index`）且 `inspectPostgresSchema` 仅比对索引名不检测索引定义漂移。 | `null` 过滤改为 `(${expr}) IS NULL`；未声明字段过滤统一类型转换或 fail-closed；`applyPostgresSchema` 加事务/`pg_advisory_xact_lock` 并比对归一化 `indexdef`。 |
| **A-S8-15** | **P2** | `ops/vps/football-api.service:1-16`<br>`ops/vps/football-jobs.service:12`<br>`ops/vps/football-jobs.timer:8-10`<br>`ops/vps/football-periodic.timer:5-7`<br>`ops/vps/Caddyfile:7-9`<br>`scripts/deploy-preflight.mjs:143` | **VPS systemd、Caddy 与预检脚本生产加固缺口**：<br>1) `jobs.timer`（`*/3`）与 `periodic.timer`（`*/15`）无 `RandomizedDelaySec` 每 15 分钟同刻共振（3 进程峰值 60 连接逼近 PG 默认 100 上限），且 `jobs.service` `TimeoutStartSec=1800` 过长（单次卡死阻塞实况 30 分钟）；<br>2) `football-api.service` 缺 `After=postgresql.service`、`MemoryMax`、`LimitNOFILE`、`NoNewPrivileges`/`PrivateTmp`；<br>3) `Caddyfile` 缺安全响应头（HSTS/`nosniff`/`DENY`）与 `transport http` 超时/keepalive 对齐；`football.env` 权限未要求 `chmod 600`；<br>4) `deploy-preflight.mjs:143` 裸拼接 `file://${process.argv[1]}` 未用 `pathToFileURL`。 | 错峰 `periodic.timer`（如 `*:01/15:00`）、缩短 `jobs.service` `TimeoutStartSec` 至 `150`–`170`s 并为任务调低 `FOOTBALL_PG_POOL_MAX`；补齐 systemd 依赖/限额/沙箱与 Caddy 安全头/超时；文档补充 `chmod 600 football.env`；改用 `pathToFileURL`。 |

> **交叉引用 Wave 1–3 已登记问题（不重复计数）**：**`A-S1-01`（P0）**（畸形 `req.url` 崩网关进程）、**`A-S1-03`（P1）**（Caddy 未覆写 `X-Real-Ip` 绕过限流）、**`A-S1-05`（P1）**（HTTP 网关与 Caddy 无请求体大小上限）、**`A-S1-09`（P2）**（`admin-anomalies` 先限流后鉴权）、**`A-S3-07`（P1）**（oneshot 进程重启丢长 429 冷却）、**`A-S4-01`（P0）**（PG `READ COMMITTED` 无行锁覆写丢积分）、**`A-S4-02`（P1）**（`admin-result-correction` 整文档覆写 `matches`）、**`A-S4-03`（P1）**（`retry-settlement-target` 跳版本重试必 500）、**`A-S5-03`（P1）**（`admin-rebuild-rankings` 锁在事务内）。

### S8.2 表 B：代码与文档口径差异（待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S8-01** | `src/application/admin-retry-settlement.ts:135-146` | 允许将 `status=running` 的结算纳入重试候选，由 `jobLocks` 判定：无锁（崩溃僵死）时允许管理员接管恢复，有锁时返回 `409 SETTLEMENT_ALREADY_RUNNING`。 | `MVP__v2.0.md` §30.4（4348 行）要求存在任意 `status=running` 结算时直接返 `409`。（代码更利于崩溃恢复，推荐认代码。） | `[x] 认代码`（✅ 已定：崩溃恢复更健壮） |
| **D-S8-02** | `src/application/admin-rebuild-user-stats.ts:40-49`<br>`src/application/admin-rebuild-rankings.ts:88-97, 104-131` | 1) `rebuild_user_stats` 审计日志增写完整 `season_stats` 数组；<br>2) `rebuild_rankings` 审计日志多出 `board` 字段，周榜用 `max_global_rank`（非 `max_rank`），快照榜省略 `ranked_entry_count`/`max_rank`。 | `MVP__v2.0.md` §21.14（2838–2845 行）冻结了审计快照字段集合。 | `[x] 认代码`（✅ 已定：增量审计详情更利于排障） |
| **D-S8-03** | `src/domain/enums.ts:183-197`<br>`src/api/v1/openapi.yaml:2692` | `AnomalyType` 扩展为 13 项（新增 `DIAG_PROVIDER_RESULT_CONFLICT`、`DIAG_PROVIDER_MATCH_UNLINKED`、`DIAG_PROVIDER_RESULT_PENDING`）；仅暴露只读 `GET /v1/admin/anomalies`。 | `MVP__v2.0.md` §21.18/§30.2 仅冻结 10 项 `AnomalyType`，且 §30 未定义管理员 resolve 异常接口（已入 `A-S8-03`）。 | `[x] 认 13 项枚举（同步补 A-S8-03 resolve 接口）`（✅ 已定） |
| **D-S8-04** | `scripts/vps-admin.mjs`<br>`ops/vps/football-jobs.timer`<br>`ops/vps/football-periodic.timer`<br>`ops/vps/README.md:72` | 1) 通过 `scripts/vps-admin.mjs` 写入/禁用管理员；<br>2) VPS 拆为 `realtime(3m)` + `periodic(15m)` 双 timer（`ops/vps/README.md:72` 示例命令仍停留在旧 15m 描述，交叉引用 `D-S3-07`）。 | `MVP__v2.0.md` §21.15/§48.3 原写云控制台 provision；`VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN` §11.5 原写单 3m timer。 | `[x] 认代码（同步更新 ops/vps/README.md）`（✅ 已定） |

### S8.3 正向合规核查确认
- **PostgreSQL Schema 与索引定义 100% 静态对齐**：`buildPostgresSchemaPlan` 动态从 `COLLECTION_DEFINITIONS`、`UNIQUE_INDEXES`（24 个）与 `QUERY_INDEXES`（43 个）生成全量 23 张集合表 + `auth_sessions` 及 69 个索引，并在构建期校验所有索引字段合法性。
- **PostgreSQL 事务与 Savepoint 工程质量高**：`PostgresDocumentDb` 在独立 `PoolClient` 上实现了真实 `BEGIN/COMMIT/ROLLBACK`、嵌套 `SAVEPOINT`、`AsyncLocalStorage` 祖先句柄防死锁检测、未 await 嵌套事务检测与 `COMMIT` 回执校验。
- **管理鉴权与审计账本防护严密**：`AdminAuthorizationService` 仅信任服务端解析的 `trustedOpenid` 且实时查库无缓存；4 个管理写入口采用“前置鉴权 + 事务内二次鉴权”防 TOCTOU；`AdminAuditLogRepository` 物理禁绝 `update`/`delete`；全部管理响应严格受控投影，无直接篡改积分/排名/等级的后门。
- **部署模板无真实密钥泄漏**：`ops/vps/football.env.example` 全为占位符，`football-api.service` 严格监听 `127.0.0.1:8787`。

---

## 第三部分：Wave 4 测试与验证覆盖缺口汇总

1. **Q3 缺失前端页面的端到端测试空白**：公开主页、账号注销入口、管理 UI 均尚未实现，对应前后端联调与权限边界测试完全缺失。
2. **PostgreSQL 真库运行与故障注入测试缺口**：`postgres-document-db.pg.test.ts` 与 `vps08-init.pg.test.ts` 在无 `FOOTBALL_TEST_DATABASE_URL` 时默认跳过；缺少 PG 下的 `GET /health` 断库返回 503 测试、借出 `PoolClient` 断连不崩进程测试（`A-S8-07`）、`SIGTERM`/`SIGINT` 优雅停机测试（`A-S8-09`）、热路径查询 `EXPLAIN` 索引命中验证，以及 5 个 Admin API 的 PG 集成测试。
3. **运维审计与安全护栏缺测**：缺少 `retry-settlement` 审计原子性故障注入测试（`A-S8-02`）、“阻塞异常 → 管理员修正赛果 → 结算解锁”闭环测试（`A-S8-03`）、管理员注销后调管理接口测试（`A-S8-04`）、`vps-admin.mjs` 畸形/未知参数测试（`A-S8-05`），以及 `prod + memory` / 环境隔离 / `deploy-preflight` 缺 `FOOTBALL_RANKING_FIRST_PERIOD_KEY` 拦截测试（`A-S8-06`、`A-S8-10`、`A-S8-11`）。
4. **S6 小程序边界缺测**：缺少从 `profile.wxml` 跳转 `/pages/unlocks/unlocks` 可达性测试（`A-S6-03`）、`onShareTimeline` 测试（`A-S6-04`）、`settings` 401/409 测试（`A-S6-05`）及 `profile.js` 主队翻页期切号隔离测试（`A-S6-07`）。

---

## 第四部分：产品快速裁决清单（Wave 4 表 B 共 6 条）

1. **`D-S6-01`**：公开 `GET /v1/share-card/{user_id}` + 支持历史赛季（`404 ROUND_NOT_FOUND`）+ 增返 `pending_predictions` 等 5 字段 — 认代码，还是公开接口隐藏 `pending_predictions`？
2. **`D-S6-02`**：解锁记录页消费 `/v1/unlocks/me` 及 `UNLOCK_LABELS` 3 项中文名 — 确认正式记入 `FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md`？
3. **`D-S8-01`**：`admin-retry-settlement` 允许接管无锁 `status=running` 僵死结算 — 认代码（推荐）？
4. **`D-S8-02`**：`rebuild_user_stats`/`rebuild_rankings` 审计日志快照字段扩展/命名差异 — 认代码，还是严格对齐 MVP §21.14？
5. **`D-S8-03`**：`AnomalyType` 扩展至 13 项 — 认代码（同步补 `A-S8-03` 手动 resolve 异常接口）？
6. **`D-S8-04`**：`vps-admin.mjs` 授权机制 + VPS `realtime(3m)`/`periodic(15m)` 双 timer — 认代码并更新 `ops/vps/README.md`？

---

## 附录：首版全面 Code Review（Wave 1–4 / S1–S8）全量汇总

| 波次 | 切片 | 总体风险 | 表 A：P0（阻断） | 表 A：P1（高危） | 表 A：P2（优化） | 表 B：口径差异（待裁决） | 报告文件 |
|---|---|---|---:|---:|---:|---:|---|
| **Wave 1** | S1 + S4 | **高** | 2 | 13 | 4 | 12 *(注：`D-S1-05` 已在 S6 升级为 `A-S6-02` P0)* | [CODE_REVIEW_WAVE1_S1_S4__v1.0.md](CODE_REVIEW_WAVE1_S1_S4__v1.0.md) |
| **Wave 2** | S2 + S3 | **高** | 0 | 16 | 5 | 14 | [CODE_REVIEW_WAVE2_S2_S3__v1.0.md](CODE_REVIEW_WAVE2_S2_S3__v1.0.md) |
| **Wave 3** | S5 + S7 | **高** | 2 | 16 | 7 | 10 | [CODE_REVIEW_WAVE3_S5_S7__v1.0.md](CODE_REVIEW_WAVE3_S5_S7__v1.0.md) |
| **Wave 4** | S6 + S8 | **高** | 3 | 14 | 7 | 6 | [CODE_REVIEW_WAVE4_S6_S8__v1.0.md](CODE_REVIEW_WAVE4_S6_S8__v1.0.md) |
| **全量合计** | **S1–S8** | **高** | **7** | **59** | **23** | **41** *(去重 `D-S1-05`)* | — |

### 全部 7 条上线阻断级 P0 一览
1. **`A-S1-01`**：HTTP 网关畸形 `req.url` 在 `try/catch` 外解析，远程单请求可崩 Node 进程（DoS）。
2. **`A-S4-01`**：PostgreSQL `READ COMMITTED` 无行锁先读后整文档覆写，并发跨场结算或并发等级/资料变更导致积分与统计丢更新。
3. **`A-S5-01`**：PostgreSQL 群组写操作无行锁与条件更新，并发加群击穿 500 人上限、解散与加/退群并发令已解散群复活、重复并发加群报 500。
4. **`A-S7-01`**：Q5 自动换季门禁未闭环（升班马副源映射/中文队名/队徽仍为纯手工或需重发小程序，且缺少跨季赛程提前探测/旧季补赛拉取）。
5. **`A-S6-01`**：Q3 首版必做「公开主页」小程序端完全缺失。
6. **`A-S6-02`**：Q3 首版必做「账号注销」小程序端入口完全缺失（原 `D-S1-05` 升级）。
7. **`A-S8-01`**：Q3 首版必做「管理 UI」完全缺失（全仓库仅有后端 Admin API + `vps-admin.mjs` 授权脚本）。
