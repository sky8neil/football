# 赛事预言家：首版全面 Code Review 报告 — Wave 2（S2 + S3）

> 审查日期：2026-11-24  
> 对应计划：[FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md](FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md)  
> 交叉基准：[CODE_REVIEW_WAVE1_S1_S4__v1.0.md](CODE_REVIEW_WAVE1_S1_S4__v1.0.md)（已登记问题不重复计数）  
> 审查范围：**S2（六联赛赛程、球队识别、比分预测、我的预测与“大家怎么选”）** + **S3（比赛数据同步、数据源策略、身份连续性与定时调度）**

---

## 0. Wave 2 审查总览

### 0.1 结论摘要

| 切片 | 总体风险 | 表 A：P0（阻断） | 表 A：P1（高危） | 表 A：P2（优化） | 表 B：口径差异（待裁决） |
|---|---|---:|---:|---:|---:|
| **S2（赛程/预测/大家怎么选）** | 中偏高 | 0 | 4 | 3 | 6 |
| **S3（数据同步/身份/调度）** | **高** | 0 | 12 | 2 | 8 |
| **Wave 2 合计** | **高** | **0** | **16** | **5** | **14** |

> 注：Wave 2 未发现远程崩进程或资金级直接损坏的 P0，但 **S3 存在多项上线后极易在真实生产环境触发的高危 P1 集群**（非权威副源滞后 `LIVE` 阻塞完赛结算、单源 `ProviderResultPending` 触发全局 30 分钟退避拖垮六联赛、改期归并重开已关闭预测、VPS `oneshot` 进程重启丢失长 429 冷却、`stale_recovery` 被旧取代记录饿死、以及 `MaintenanceCleanupService` 误删 60 天以上关键 `provider_snapshots`）。

### 0.2 本次实测自动化验证基线

- **TypeScript 类型检查**：`tsc -p tsconfig.json --noEmit` 通过（exit 0）。
- **Wave 2 自动化测试套件**（后端 S2 + S3 + 小程序 S2，共 70 个测试文件）：
  - **69 个文件通过（790 条用例）**；
  - **1 个文件跳过**：`src/jobs/tick.pg.test.ts`（7 skipped，因环境未配置 `FOOTBALL_TEST_DATABASE_URL`）。
- **队徽资产静态核对**：`miniprogram/assets/logos/manifest.json` 声明 120 个 PNG（6 联赛徽 + 114 球队徽），磁盘校验缺失 `0`；`scripts/logos-check.mjs` 需外部 `--input <normalized-provider-sample.json>` 运行，本次未连外部源执行。

---

## 第一部分：切片 S2（六联赛赛程、球队识别、比分预测、我的预测与“大家怎么选”）

### S2.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S2-01** | **P1** | `miniprogram/pages/matches/matches.js:320, 344, 398-402, 548-596, 616-619`<br>`miniprogram/pages/matches/matches.wxml:58-87` | **首页赛程加载/提交异常未捕获卡死、冲突幂等键死锁、提交确认被立即抹除、翻页报错静默**：<br>1) `loadFirstPage` 第 344 行 `await listMatches(...)` 无 `try/catch`，一旦 reject 页面永久卡在 `state: "loading"` 无重试入口；<br>2) `onSubmitTap`（`559-596`）无 `.catch()`，reject 时按钮永久卡死 `"submitting"`；且收到 `409 IDEMPOTENCY_KEY_REUSED` 走通用报错时未清空 `idempotencyKeys[key]`/`lastPayloads[key]`，用户不改比分重试会无限 409 死循环；<br>3) 提交成功 `574` 行刚 `refreshItems()` 展示 `✓ 预测已提交`，`575` 行立刻调 `loadFirstPage()` 执行 `setData({ state: "loading", items: [] })` 将确认卡片瞬间清空；<br>4) `onMore` 翻页失败写入 `errorMessage`，但 `matches.wxml:59-87` 的 `state === 'list'` 视图从未渲染 `errorMessage`。 | 1) 为 `344` 行补 `try/catch` 落入 `error` 态；<br>2) 为 `onSubmitTap` 补 `.catch()` 复位 `"editing"`，并在 `IDEMPOTENCY_KEY_REUSED` 时清除旧幂等键；<br>3) 提交成功改为静默局部刷新，不清空当前列表与确认态；<br>4) 在列表底部补充翻页错误提示与重试按钮。 |
| **A-S2-02** | **P1** | `miniprogram/pages/match-detail/match-detail.js:121, 130-139, 147-156, 259-278, 302, 343-350, 362-400`<br>`miniprogram/pages/match-detail/match-detail.wxml:22, 70, 76-83` | **比赛详情页存在请求竞态、多处缺 `.catch()` 致界面卡死及缺 `loginGeneration` 隔离**：<br>1) `loadDetail()` 无请求序号保护且无 `.catch()`，`onLoad`/`onShow` 连续触发时旧响应可覆盖新数据，reject 时永久卡在 `loading`；<br>2) `loadCrowd()`、`onSubmit()` 均缺 `.catch()`，reject 时分别永久卡死 `"loading"` 与 `submitting: true`；<br>3) 缺少 `loginGeneration` 校验，切换账号期间在途详情/提交回调仍会落盘；`refreshAfterSession` 只写不读；部分 401/409 错误在 `wxml:76-83` 渲染双份重复提示。 | 为 `loadDetail` 加 `detailRequestSerial` 与 `.catch()`；为 `loadCrowd`/`onSubmit` 补 `.catch()`；接入 `getLoginGeneration()` 并在切号时清草稿；去重报错区并修正非开赛终态下的 `score-caption`。 |
| **A-S2-03** | **P1** | `src/application/prediction-query.ts:198-200, 213-215, 338-340, 366-368`<br>（对比 `src/application/match-query.ts:316-327`）<br>`miniprogram/pages/my-predictions/my-predictions.js:56, 64-66` | **我的预测接口在赛果修正中/腰斩作废带比分时暴露过期得分，且缺 `settlement_status` 致前端腰斩作废渲染分裂**：<br>`MatchQueryService` 严格要求 `match.settlement_status === Settled && prediction.applied_result_version === match.result_version` 才返回得分；但 `PredictionQueryService` 与 `PredictionHistoryQueryService` 仅判断 `regular_home_score !== null && match_status !== "cancelled"`。<br>**复现**：赛果修正重结算未完成时，`/v1/predictions/me` 会把**新比分与旧 `match_score`/`wdl_hit`/`exact_hit`** 一并输出；同时接口未返回 `settlement_status`，使 `my-predictions.js:56` 的 `settlement_status === "voided"` 成为死代码，`abandoned` 转 `voided` 场次错显“待结算”。 | 将 `prediction-query.ts:198-200, 338-340` 对齐为 `match.settlement_status === SettlementStatus.Settled && prediction.applied_result_version === match.result_version` 才输出得分字段；并在 DTO 中补齐 `settlement_status`（或明确作废标识）。 |
| **A-S2-04** | **P1** | `src/application/match-query.ts:282-292, 444-451` | **单场比赛缺失球队资料直接导致整个 `GET /v1/matches` 赛程页崩溃返回 500**：`mapTeam` 发现任一球队缺失或 `name === ""` 直接 `throw internalError`，导致当页全部健康比赛均不可浏览与预测（而 `prediction-query.ts:349-356` 已按 UX 规范降级返回 `{ team_id, name: "" }` 交前端展示“球队资料待补全”）。 | 改为记录结构化告警日志并降级返回 `{ team_id: teamId, name: "" }`，避免单条脏数据拖垮整页赛程。 |
| **A-S2-05** | **P2** | `src/infrastructure/cloudbase-app-repository.ts:609-628`<br>`src/infrastructure/postgres-schema.ts:37-39`<br>`src/infrastructure/document-codec.ts:102-104` | **“大家怎么选”聚合在 PostgreSQL 下存在无上限全量文档扫描，且显式 `canonical_match_id: null` 会双倍计数**：每次请求除 3 次 `db.count` 外，`616` 行还会无 `LIMIT` 拉取并解码该场全部 `Prediction` 文档；在 PG 下因 `postgres-schema.ts:37-39` 已用 `COALESCE(canonical_match_id, match_id)`，`db.count` 已覆盖缺字段记录，该扫描既冗余又有热门场 O(N) 性能隐患，且遇到显式 `null` 文档会被重复累加。 | 为 `PostgresDocumentDb` 提供单条 `GROUP BY derived_result` 聚合 SQL，移除 PG 路径下多余的全量文档扫描。 |
| **A-S2-06** | **P2** | `miniprogram/pages/my-predictions/my-predictions.js:122-132`<br>`miniprogram/utils/prediction-history.js:29-41` | **“我的预测”从详情提交预测后返回未刷新，且按比赛周分组在提交/开球逆序下乱序**：`onShow()` 仅在切号或未登录时重拉，从列表进详情下单返回仍见旧状态；按 `submitted_at DESC` 遍历插桶会在先猜晚轮、后猜早轮或改期时出现“早周排在新周前”。 | 进详情返回时按脏标记静默刷新；明确周分组排序与加载更多翻页时的顺序口径。 |
| **A-S2-07** | **P2** | `src/api/v1/matches.ts:75-87`<br>`src/gateway/assemble.ts:421-437`<br>`src/api/v1/predictions.ts:134-153` | **赛程查询放行无效公历日期静默滚天 + 单条预测详情漏校未知 query 参数**：`matches.ts:parseDate` 未用 `isExistingUtcCalendarDate`（如 `2026-02-30` 会静默滚成 `2026-03-02`）；`GET /v1/predictions/me/:id` 未调 `assertUnknownFields` 校验多余 query。 | 接入 `isExistingUtcCalendarDate` 拒绝非法公历日期；为 `GET /v1/predictions/me/:id` 补齐 `assertUnknownFields(input.query, new Set())`。 |

> **交叉引用 Wave 1 已登记问题（不重复计数）**：**`A-S1-06`（P1）**（`miniprogram/services/matches.js` 与 `leagues.js` 漏传 `auth: "optional"`，本地凭证过期时阻塞游客浏览 S2 赛程与详情）。

### S2.2 表 B：代码与文档口径差异（待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S2-01** | `src/application/match-query.ts:38-89, 294-363` | `GET /v1/matches` 列表项与详情新增返回 `settlement_status`、`my_prediction`、`is_prediction_closed`。 | `MVP__v2.0.md` §25.1 列表未含上述 3 字段，§25.3 仅在详情增返 `my_prediction`。 | `[x] 认代码`（✅ 已定：必要增量字段，避免首页 N+1 查询） |
| **D-S2-02** | `src/application/prediction-query.ts:44-45, 349-356`<br>`src/api/v1/predictions.ts:195-213` | `GET /v1/predictions/me` 增返 `home_team`/`away_team` 对象，且 `season_id` 开放查询该联赛全部已接入历史赛季。 | `MVP__v2.0.md` §26.2 未定义球队对象且限定 `season_id` 为当前登记赛季（后由 `MINIPROGRAM_UX_DEV_PLAN` DATA-01 补充，MVP v2 未同步）。 | `[x] 认代码`（✅ 已定：符合 UX DATA-01 要求） |
| **D-S2-03** | `miniprogram/utils/team-registry.js:5-123`<br>`miniprogram/utils/team-presentation.js:6-21` | 中文队名映射硬编码 112 个快照 UUID；当 `team_id` 未命中且服务端 `team.name` 非空时，`presentTeam:14` **静默回退显示英文原名**而非“球队资料待补全”。 | `MINIPROGRAM_UX_REQUIREMENTS__v1.0.md` §1、§5.8 要求“强制中文、不静默回退英文、缺失时提示‘球队资料待补全’并记录待修项”。 | `[x] 认代码（缺失中文时回退显示英文原名）`（✅ 已拍板） |
| **D-S2-04** | `miniprogram/pages/matches/matches.wxml:61`<br>`miniprogram/pages/matches/matches.js:52-77, 344` | 首页仅对进行中/已结束比赛展示“大家怎么选 ›”（已截止未开球需进详情页看）；首页日期条固定今天起 11 天，无日历回看历史入口。 | `MVP__v2.0.md` §25.1/§25.4 未限制已截止未开球首页入口与 11 天日期窗口。 | `[x] 判为 Bug（已截止未开球补“大家怎么选 ›”入口 + 日期条支持往前选 11 天）`（✅ 已拍板） |
| **D-S2-05** | `miniprogram/pages/my-predictions/my-predictions.js:196-204, 325-344` | “我的预测”改为首屏 20 条 + 按钮“加载更多”（筛选空页最多自动续扫 5 页），撤销原“最近 8 周自动续翻”与两段式方案。 | `MVP__v2.0.md` §19.10.6 要求可达至少近 8 周；`MINIPROGRAM_UX_DEV_PLAN` §6 已记录 2026-11-18 撤销决定。 | `[x] 认代码（纳入现行例外清单）`（✅ 已定：已有 2026-11-18 撤销记录） |
| **D-S2-06** | `miniprogram/utils/crowd-view-model.js:7-16, 40-48`<br>`src/application/crowd-query.ts:34-77` | 比赛延期/取消/腰斩（`unavailable`）时前端直接隐藏整张“大家怎么选”卡片不展示文案；`CrowdQueryService.get` 对不存在的 `user_id` 返回 `401` 而非 `404`。 | `MVP__v2.0.md` §25.4 定义了 `unavailable` 状态枚举，未强制前端隐藏或显示说明。 | `[x] 认代码`（✅ 已定：取消/延期场次隐藏空卡片体验更干净） |

### S2.3 正向合规核查确认
- **硬约束全部严密**：`0..20` 整数校验、`serverNow < predictionDeadlineAt`（恰到截止拒绝）、`prediction_closed_at` 不可回退（延期不重开）、服务端推导 `derived_result`、无修改/删除接口、`uk_user_match` + `uk_user_canonical_match` + `uk_user_idempotency` 三重防重、HMAC 签名游标、以及 Q6“大家怎么选”防泄露（仅登录态 + 截止后 + 样本 >=20 + 5% 圆整百分比、不返人数/具体比分/用户列表）均无越界漏洞。

---

## 第二部分：切片 S3（比赛数据同步、数据源策略、身份连续性与定时调度）

> 注：经源码亲自复核，`src/provider/status.ts:43` 映射为 `cancelled` 的是 `"AWD"` 而非 `"AWARDED"`；`football-data-adapter.ts` 与 `bsd-adapter.ts` 对加时/点球/缺 `REGULAR` 返回的 `"AWARDED"` 会安全落入 `mapProviderStatus` 的 `{ kind: "unexpected" }` 分支（fail-closed，不结算、不作废），此链路无 P0 缺陷。

### S3.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S3-01** | **P1** | `src/application/provider-fixture-sync.ts:407-440`<br>`src/application/provider-window-loader.ts:160-192`<br>`src/application/provider-status-sync.ts:698-722, 820-946` | **非赛程权威次要源可直接改写状态/作废比赛，且滞后 `LIVE` 观测诱发阻塞性 `PROVIDER_STATE_CONFLICT` 卡死结算**：<br>1) `applyFixture` 仅在 `discover` 校验赛程权威源，对已建场次放行 `5d`/`of`/`sp` 直接调用 `applyScheduled`/`Postponed`/`Live`/`Cancelled`/`Abandoned`，副源误报 `CANC` 可直接作废比赛；<br>2) `loadPostFinishBatches` 仅过滤 `short !== "NS"` 后把副源整批交给 `applyFixture`：主源 `fd` 已将比赛推进 `Finished`（`Waiting`），副源 `of`/`5d` 尚滞留 `LIVE`/`HT`，`applyLiveFixture` 判定 `Finished -> Live` 非法转移并打开 `blocking: true` 的 `PROVIDER_STATE_CONFLICT`，直接阻断正式结算。 | 非状态权威副源（`of`/`sp` 及非 `live` 下的 `5d`）在 `applyFixture` 中仅参与赛果观测或忽略非终态观察，禁止写状态转移、禁止因滞后 `LIVE` 打开阻塞冲突、禁止副源直接 `Cancelled` 作废比赛。 |
| **A-S3-02** | **P1** | `src/application/provider-fixture-sync.ts:468-473`<br>`src/application/provider-sync-job.ts:208-212, 538-623`<br>`src/runtime/scheduled-jobs.ts:153-156` | **正常单源等待（`ProviderResultPending`）或单场异常即触发全局 `live_match`/`post_finish_verify` 指数退避（最高 30 分钟），拖垮全部六联赛**：<br>五大联赛 `live_match` 主源为 `5d`。当 `5d` 先于 `fd` 报 `FT` 时，`applyAdoptableResult` 正常落库非阻塞的 `ProviderResultPending`，但返回 `{ kind: "failed" }`（`473` 行）；外层 `ProviderFixtureSyncJobService` 将整条任务写入 `sync_logs(status="deferred")` 按 `1->2->5->10->30` 分钟退避，导致其余 5 个联赛（含中超）实时同步全部被降级。 | `ProviderResultPending` 属于预期等待状态，不应返回 `kind: "failed"` 触发任务级退避；单场已落库隔离的 `entity` 级异常也不应反复把全局多联赛高频任务退避至 30 分钟。 |
| **A-S3-03** | **P1** | `src/application/provider-schedule-sync.ts:70-89, 206-249`<br>`src/application/match-identity.ts:136-140` | **改期/更换外部 ID 归并时未继承 `prediction_closed_at`、未拦截 `Live` 归并且未校验轮次，可重开已关闭预测**：<br>当旧比赛 `M_old` 已过截止时间被关盘（或已进入 `Live`），主源换新 `providerMatchId` 触发 `discover()` 归并时，`buildMatch` 未继承 `candidate.prediction_closed_at` 而将其重置为 `null` 并赋予新未来截止时间，导致未下单用户可在关盘后再次下单，破坏“延期后已关闭不重开”硬约束；且 `filterByTeamPair` 未校验 `round_id`。 | 拒绝将 `Live`（`period_anchor_at != null`）自动取代归并；若 `candidate.prediction_closed_at !== null` 或已过原截止时间，新建 `M_new` 必须强制继承原关闭状态与截止时间；同时补充 `round_id` 校验。 |
| **A-S3-04** | **P1** | `src/application/provider-cross-source.ts:43-44`<br>`src/application/provider-window-loader.ts:74-86`<br>`src/application/provider-reconcile.ts:138-148` | **比赛发生 `superseded_by` 取代后，已建立的次要源（`5d`/`of`/`sp`）映射永久脱钩失明**：<br>取代前副源已写入 `provider_match_id -> M_old`；取代后窗口与对账 `ids` 仅含 `M_new`，而 `ensureCrossSourceMatchMapping:43-44` 命中 `M_old` 后未调 `resolveEffectiveMatch` 直接原样返回 `M_old`，导致次要源观察被静默丢弃、夜间对账永远落入 `MATCH_NOT_OBSERVED`。 | `ensureCrossSourceMatchMapping` 与 `fixturesToItems` 命中 `match_provider_mappings` 后，必须先经 `resolveEffectiveMatch` 解析至最新有效 `M_new` 再做匹配与返回。 |
| **A-S3-05** | **P1** | `src/application/provider-window-loader.ts:118-145, 154`<br>`src/application/provider-fixture-loader.ts:85-98`<br>`src/application/provider-team-sync.ts:95-109` | **多联赛加载循环缺乏按联赛隔离，单联赛异常拖垮其余五个联赛**：`loadActiveWindowFixtures`、`loadFixturesForSupportedLeagues`、`ProviderTeamSyncService.sync` 均串行 `await` 各联赛且无单联赛 `try/catch`。任一联赛（如中超 `bsd`）超时/5xx/预算延迟会直接抛错中断，丢弃此前已拉取的英超等数据并跳过后续联赛与副源比对。 | 改为按联赛 `try/catch` 容错收集，保留并提交健康联赛的 `items`，仅记录故障联赛的错误/延迟状态。 |
| **A-S3-06** | **P1** | `src/provider/registry.ts:445-461, 487-497, 633-634, 663-666`<br>`src/provider/budget.ts:234, 240` | **`5d` 直播失败污染源级节流阻断同轮其余联赛降级 `fd`，且预算冷却拒绝被吞为 `[]`**：<br>1) 英超请求 `5d` 失败时，`withRequest` 写入源级节流键 `"5d:live_match"`，英超成功降级 `fd`；但同轮西甲进入 `448` 行命中节流直接静默 `return []`（不抛错也不降级 `fd`），其余欧洲联赛整轮失明；<br>2) `ProviderBudget.acquire` 在 `provider_cooldown`/`provider_quota` 未填 `retry_at`，抛普通 `ProviderBudgetDeniedError`；`registry.ts:492, 496` 将其吞为 `return []`，既不走 `fallback` 备源又误报“0 场成功”推进状态。 | `5d` 失败后本轮直接标记本 tick 不可用，让其余联赛正常降级 `fd`；`ProviderBudget.acquire` 补齐 `retry_at`，`registry` 先走备源降级、无备源时上抛 `ProviderBudgetDeferredError`，禁止吞为 `[]`。 |
| **A-S3-07** | **P1** | `src/provider/registry.ts:81-83, 636-638, 757-770`<br>`src/provider/budget.ts:192-193, 232-243`<br>`src/provider/key-pool.ts:48-52, 72-82` | **VPS `oneshot` 进程退出后丢失跨天/跨月 429 冷却，且任意 401/403 永久作废 `key_id`**：<br>1) `football-jobs.service` 为 `Type=oneshot`，每轮新建进程；UTC 午夜（`bsd`/`sp`）或下月 1 日（`of`）长冷却仅存于内存 Map，持久化 `KeyPool.markFailure` 未接收 `quotaResetAt` 仅落库 1 分钟，下轮进程重启后继续高频撞击已耗尽源；<br>2) `KeyPool.markFailure` 遇任意 401/403（含 Cloudflare WAF `403/1010`）即按序号 `key_id` 永久标 `invalid`，换新环境变量密钥也不会自动恢复。 | 将 `quotaResetAt` 持久化到 `provider_key_state.cooldown_until`；记录密钥脱敏指纹，换 Key 自动复位状态；WAF 403/1010 改冷却退避而非永久 `invalid`。 |
| **A-S3-08** | **P1** | `src/infrastructure/active-window-query.ts:78-83`<br>`src/infrastructure/cloudbase-app-repository.ts:996-1003` | **`stale_recovery` 候选被库内历史 `superseded_by != null` 旧记录饿死**：查询仅按 `match_status in [scheduled, live]` 与 `kickoff_at <= now - 6h` 排序取 `LIMIT 10`，未下推 `superseded_by: null`。因被取代的旧场次保留 `scheduled` 状态与旧开球时间，累计 ≥10 条历史改期旧记录后，DB 永远只返回这 10 条旧记录，内存剔除后变 `[]`，真正滞留比赛彻底饿死。 | 在 `buildActiveWindowFilters` 与 `findActiveWindow` 下推 `superseded_by: null` 过滤条件（PG 已支持 `(document -> 'superseded_by') = 'null'::jsonb`）。 |
| **A-S3-09** | **P1** | `src/application/provider-active-window.ts:34-36`<br>`src/jobs/tick.ts:149`<br>`src/runtime/scheduled-jobs.ts:146-164` | **`post_finish_verify` 超 24 小时后的每日兜底（仅 `00:00 UTC` 单分钟）在真实 3 分钟定时器下极易漏检**：`AccuracySec=10s` 抖动（如 `23:57:04` -> `00:00:02`，差 `178s < 180s` 触发 `interval_not_due`）、`test` 档 5 分钟间隔或 `deferred` 退避都会跳过 `00:00` 整点，导致滞留比赛连续多日失漏。 | 改为持久化记录当日（UTC 日）是否已完成每日兜底复核，即使 `00:00` 被跳过也能在当日下一轮自动补跑。 |
| **A-S3-10** | **P1** | `src/runtime/scheduled-jobs.ts:146-164, 216-222, 971-976`<br>`src/application/provider-sync-job.ts:368-382`<br>`src/application/provider-reconcile.ts:31-69, 74-90` | **调度异常恢复、锁续租与并发控制存在多处死区与竞态**：<br>1) 进程在写 `sync_logs(running)` 后 OOM/SIGKILL 崩溃，锁 10 分钟过期但日志永驻 `running`，`intervalSkip` 将其当正常执行锁死整个周期（如对账 24h、stale 60m）；<br>2) `provider_reconcile` 失败后仍强等 24 小时、仅查 `yesterday` 单日（停机即永久漏建待办）、且无 `startJobLockRenewal` 锁续租；<br>3) `--mode=periodic` 中的 `leagueSeasons.run` 完全无分布式锁，与 15m timer 重叠或人工 `--mode=all` 并发时存在覆盖竞态。 | 超 `JOB_LEASE_MINUTES` 的僵死 `running` 日志按失败冷却收敛；`provider_reconcile` 接入短冷却、锁续租与近数日回溯补建；为 `leagueSeasons.run` 增加分布式锁。 |
| **A-S3-11** | **P1** | `src/application/maintenance-cleanup.ts:13, 166-174` | **`MaintenanceCleanupService` 无条件物理删除 60 天以上的全部 `provider_snapshots`**：未区分 `event_type`，直接违反 `src/schema/collections.ts:482`（关键快照不自动清理）和 `MVP__v2.0.md` §37，会抹除 `provider_conflict`/`admin_conflict`/`result_changed`/`discovered` 审计证据及 `result_observed` 观测记录。 | 严禁自动删除关键审计与观测快照（`discovered`/`kickoff_changed`/`status_changed`/`result_observed`/`result_changed`/`*_conflict`/`provider_error`）；默认停止按时间整表清理 `provider_snapshots`。 |
| **A-S3-12** | **P1** | `src/provider/football-data-adapter.ts:21, 47` | **`football-data.org` 缺失 `competition.code` 时硬编码回退 `"PL"`（英超）**：一旦西甲/意甲/德甲/法甲响应缺 `competition.code`，赛程会被错标为英超写入 `premier_league`。 | 将当前请求 `league` 传入 `mapMatch`，回退到 `league.source_league_ref`（若仍空则交 mapper fail-closed）。 |
| **A-S3-13** | **P2** | `src/provider/bsd-adapter.ts:26-33, 110-135`<br>`src/provider/fivedollar-adapter.ts:175-182`<br>`src/provider/openfoot-adapter.ts:115-132` | **Adapter 分页循环缺少最大页数/游标判重防护，且 `bsd` `next` 链接未校验同源**：上游返回重复游标会死循环耗尽配额；`bsd` 若收到外站 `next` URL 会携带 `Authorization: Token` 发往第三方域名。 | 为分页循环加 `visitedCursors` 判重与 `MAX_PAGES` 上限；`bsd` `nextEventsUrl` 校验 `url.origin` 同源。 |
| **A-S3-14** | **P2** | `src/provider/fixture-mapper.ts:288-304`<br>`src/application/provider-fixture-sync.ts:331, 450-484`<br>`src/application/provider-result-adoption.ts:36, 43-45` | **异常链路存在告警静默丢失、不可达死分支与 Admin 覆盖前误开阻塞冲突**：`5d` 开球超 `±180d` 告警静默丢失；`finished_live_conflict` 分支实跑不可达；`match.result_source === "admin"` 时若两上游比分冲突会先误开阻塞 `ProviderResultConflict` 而非收敛到非阻塞 `ADMIN_PROVIDER_RESULT_CONFLICT`。 | 非阻塞告警补充落库/日志；清理或接通 `finished_live_conflict`；`applyAdoptableResult` 优先保护 `admin` 终果。 |

### S3.2 表 B：代码与文档口径差异（含 Q7 数据源全量核实，待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S3-01** | `src/provider/sources.ts:71-126, 170-247`<br>`src/application/provider-reconcile.ts:81`<br>`ops/vps/football.env.example:33` | **Q7 实际数据源组合与部署模板差异**：代码配置 5 源——五大联赛 `fd`（双 Key 池，主赛程/赛果/备直播）+ `5d`（主直播/备赛果）+ `of`（备赛果/对账）；中超 `bsd`（主）+ `of`（备赛果）+ `sp`（备直播/备赛果/夜间对账，且 `provider-reconcile.ts:81` 硬编码中超对账找 `sp`）；但部署模板 `football.env.example:33` 仅默认填 `FOOTBALL_PROVIDER_SOURCES=fd,bsd`。 | `MVP__v2.0.md` §31.10 写中超 `bsd+sp` 且“`of` 不用于中超当日结果”；`SYNC_RELIABILITY` S3.3 已升中超 `of` 为 `result: secondary`；需拍板首版 VPS 线上实际启用的 `FOOTBALL_PROVIDER_SOURCES` 组合及中超夜间对账源。 | `[x] 认代码并全开 5 源（fd,5d,of,bsd,sp，中超对账用 sp，同步更新 env 模板）`（✅ 已拍板） |
| **D-S3-02** | `src/application/provider-cross-source.ts:24-28, 61-63` | 中超跨源开球时间容差设为 **90 分钟**（兼容 `openfoot` 误套欧洲夏令时 `+60m` 偏移）；其余联赛 30 分钟。 | `MVP__v2.0.md` §31.10（4635 行）规定“中超容差 **5 分钟**，其他联赛 30 分钟”。 | `[x] 认代码（纳入新口径）`（✅ 已定：适配上游 `openfoot` 夏令时偏移的必要容错） |
| **D-S3-03** | `src/provider/budget.ts:53-113, 250-292`<br>`src/provider/registry.ts:668-676` | `fd` 按 `Asia/Shanghai` 零点切日桶；`LiveMatch` 设源级最小间隔：`bsd/sp` 2m、`5d` 3m、`fd/of` **5m**（即仅开 `fd,bsd` 时五大联赛直播实为 5 分钟一刷）。 | `MVP__v2.0.md` §32.4 定义 `live_match` 间隔 3 分钟，未冻结各源具体节流与时区日界。 | `[x] 认代码`（✅ 已定：上游配额保护必需节流参数） |
| **D-S3-04** | `src/application/provider-result-adoption.ts:47-58` | 非权威双源联合采信仅支持五大联赛 `5d + of`，未支持中超 `of + sp` 联合取代 `bsd`。 | `MVP__v2.0.md` §31.10 与 `5d+of` 一致；中超启用 `of` 后文档未明确 `of+sp` 是否互证。 | `[x] 认代码`（✅ 已定：与 MVP §31.10 一致，首版保持稳健） |
| **D-S3-05** | `src/domain/config.ts:349-410`<br>`src/provider/fixture-mapper.ts:204-233` | 换季完全按 UTC 日期自动推导（跨年 7/1、自然年 1/1，接受 `±1` 相邻季），未实现外部配置/DB 覆盖开关。 | `SYNC_RELIABILITY` R4 / S3.1 曾写“可由外部配置或数据库赛季记录覆盖”。 | `[x] 认代码（纯自动推导，配合 A-S7-01 补相邻季探测）`（✅ 已定） |
| **D-S3-06** | `src/application/maintenance-cleanup.ts:8-17` | `sync_logs` 留存 **60 天**、`auth_sessions` 7 天、`provider_usage` 短桶 7 天/长桶 365 天、`board_snapshots` 非终榜各留 24 份。 | `MVP__v2.0.md` §3/§37 及 `src/domain/config.ts:53` 冻结 `SYNC_LOG_RETENTION_DAYS = 30`。 | `[x] 认代码（统一为 60 天）`（✅ 已定：排障窗口更充裕，PG 存储开销可忽略） |
| **D-S3-07** | `ops/vps/football-*.timer`<br>`ops/vps/README.md:16, 18`<br>`src/runtime/scheduled-jobs.ts:185-214, 802-806` | VPS 拆为 3m `--mode=realtime` + 15m `--mode=periodic`（`ops/vps/README.md` 未收录 `periodic`）；仅排程类任务按联赛拆 `sync_logs`，其余高频任务共用 1 条 `sync_logs`；单轮 `sleep` 重试改为跨 tick `deferred` 持久化；`maintenance_cleanup` 硬编码 24h 执行。 | `MVP__v2.0.md` §32 原写五类任务按联赛隔离 `sync_logs` 且单轮内重试 5 次。 | `[x] 认代码（补齐 ops/vps/README.md）`（✅ 已定：更契合 VPS systemd oneshot 架构） |
| **D-S3-08** | `src/application/provider-active-window.ts:28-37` | `post_finish_verify` 定量采用 `elapsed >= 105m` 兜底入窗、`24h` 后切每日复核（6h 未终态让渡 `stale_recovery`）。 | `MVP__v2.0.md` §32.5 仅定性描述高频确认，未定量约定 `105m` 与 `24h`。 | `[x] 认代码`（✅ 已定：合理的定量工程参数） |

---

## 第三部分：Wave 2 测试与验证覆盖缺口汇总

1. **PostgreSQL 真库并发下单与调度集成缺测**：`src/jobs/tick.pg.test.ts`、`src/infrastructure/postgres-document-db.pg.test.ts` 因无 `FOOTBALL_TEST_DATABASE_URL` 跳过；缺少 PG 真并发下的双击同 key / 异 key / `uk_user_canonical_match` `23505` 测试，以及 VPS `oneshot` 跨进程重启保留长 429 冷却测试（`A-S3-07`）。
2. **多源协同与失败降级联合测试缺口**：缺少“主源先 `FT` + 副源滞后 `LIVE`”（`A-S3-01`）、“`5d` 先报 `FT` 触发 `ProviderResultPending` 是否拖垮全局退避”（`A-S3-02`）、“同轮英超 `5d` 失败后西甲继续降级 `fd`”与“预算冷却拒绝是否走备源而非吞为 `[]`”（`A-S3-06`）的联合用例。
3. **改期身份连续性边界与 `stale_recovery` 真实仓储测试缺口**：缺少已关盘/`Live` 场次被取代的继承测试（`A-S3-03`）、副源旧 `M_old` 映射在取代后的解析测试（`A-S3-04`）、库内存在 ≥10 条 `superseded_by != null` 旧记录的 `stale_recovery` 仓储测试（`A-S3-08`），以及僵死 `running` 日志恢复测试（`A-S3-10`）。
4. **S2 前后端联调与异常注入缺口**：缺少修正中间态 `/v1/predictions/me` vs `/v1/matches` 得分一致性测试（`A-S2-03`），以及小程序 `matches`/`match-detail` 异常 reject、409 冲突键重试、竞态与真机 E2E 验证（`A-S2-01`、`A-S2-02`）。

---

## 第四部分：产品快速裁决清单（表 B 共 14 条）

为了方便你集中拍板，以下汇总 Wave 2 全部 14 条口径差异（每条回复编号 + 结论即可）：

1. **`D-S2-01`**：`/v1/matches` 列表/详情扩展返回 `settlement_status`、`my_prediction`、`is_prediction_closed` — 认代码并收口？
2. **`D-S2-02`**：`/v1/predictions/me` 增返 `home_team`/`away_team` 并开放查询全部已接入历史赛季 — 认代码并收口？
3. **`D-S2-03`**：球队中文映射未命中 112 队快照 UUID 时静默回退英文 — 认代码（靠同步表维护），还是改为严格提示“球队资料待补全”？
4. **`D-S2-04`**：首页仅进行中/已结束显示“大家怎么选 ›”（已截止未开球需进详情），且日期条固定今天起 11 天 — 认代码？
5. **`D-S2-05`**：我的预测保留按钮“加载更多”并取消 8 周自动续翻 — 确认纳入例外清单？
6. **`D-S2-06`**：延期/取消/腰斩（`unavailable`）时前端直接隐藏“大家怎么选”卡片 — 认代码？
7. **`D-S3-01`（Q7 核心）**：首版 VPS 线上实际启用哪些数据源（仅 `fd,bsd` 还是 `fd,5d,of,bsd,sp` 全开）？中超夜间对账是否继续用 `sp`？
8. **`D-S3-02`**：中超跨源开球容差 90 分钟（兼容 `openfoot` 夏令时偏移） — 认代码？
9. **`D-S3-03`**：`fd` 按北京时间切日桶，且 `fd` 实况源级最小间隔 5 分钟 — 认代码？
10. **`D-S3-04`**：非权威双源互证仅支持五大联赛 `5d+of`，暂不支持中超 `of+sp` — 认代码？
11. **`D-S3-05`**：自动换季纯按 UTC 日期规则推导，不做外部配置/DB 手动覆盖开关 — 认代码？
12. **`D-S3-06`**：`sync_logs` 留存 60 天（MVP v2 原写 30 天） — 认 60 天，还是改回 30 天？
13. **`D-S3-07`**：VPS 拆 `realtime(3m)` + `periodic(15m)`、高频任务共用 `sync_logs`、跨 tick `deferred` 退避 — 认代码（同步补齐 `ops/vps/README.md`）？
14. **`D-S3-08`**：`post_finish_verify` 定量 `105m` 兜底入窗、`24h` 后转每日复核 — 认代码？
