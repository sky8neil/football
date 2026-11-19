# **赛事预言家（football-mvp）全局深度代码审查报告**

# **一、全局拓扑测绘**

本项目为「赛事预言家」足球比分预测系统，采用 **TypeScript 全栈分层架构 \+ 微信小程序原生前端**，支持自建 VPS（Node HTTP \+ PostgreSQL JSONB 文档存储）与微信云开发（CloudBase 云函数 \+ 文档库）双运行时同构部署。

* **核心模块划分**：后端按 DDD 划分为领域层（`domain`）、应用编排层（`application`）、接口契约层（`api/v1`）、网关与云函数入口层（`gateway` / `cloud-function`）、多源赛事同步层（`provider` / `scheduler` / `runtime`）及仓储适配层（`infrastructure`）；前端分为服务层（`services`）、视图模型层（`utils`）与页面视图层（`pages`）。  
* **主干数据流向**：定时任务拉取上游赛事数据经 `ProviderFixtureSync` 落库 `matches` → 小程序读取赛程并提交幂等预测至 `predictions` → 完场后由 `SettlementTimer` 驱动 `settlement_items` 账本原子结算，增量更新用户统计与周榜，并由周期任务生成生涯榜、实力榜、赛季榜快照及周一定级评估。

# **二、跨文件深度缺陷报告**

## **\[P0\] 1\. 首页比赛列表与后端接口契约断层，导致已预测及已完场比赛全部误显为「未预测 / 待结算」**

* **严重程度说明**：`P0`（核心功能阻断/严重逻辑错误）  
* **涉及文件**：`src/application/match-query.ts`（`MatchListItem` / `toItem`） ↔ `miniprogram/pages/matches/matches.js`（`decorateItem` / `onSubmitTap`） ↔ `miniprogram/utils/match-card-state.js`（`buildCardState` / `buildPredText`）  
* **根因与触发路径**：  
  1. 后端列表接口 `GET /v1/matches`（`src/application/match-query.ts:35-56, 288-307`）返回的 `MatchListItem` 仅包含布尔态 `can_predict` 与枚举原因 `can_predict_reason: "ALREADY_SUBMITTED"`，**未返回当前用户的预测详情字段 `my_prediction`**（仅详情接口 `GET /v1/matches/:id` 返回了 `my_prediction`），也未返回 `display_time` 字段。  
  2. 前端 `miniprogram/pages/matches/matches.js:245-246` 在渲染列表项时，仅从页面内存字典 `this.submittedMap[key]` 读取 `submitted` 传给 `buildCardState(item, submitted)`：

```js
// miniprogram/pages/matches/matches.js:245-246
const submitted = this.submittedMap[key];
const cardState = buildCardState(item, submitted);
```

     而 `this.submittedMap[key]` 仅在当次页面生命周期内通过首页卡片内联提交时才会被写入（且仅存了 `{ home, away }`，不含结算后的 `match_score`）。一旦用户重新进入小程序、下拉刷新、切换日期/联赛，或在详情页完成预测返回首页，`this.submittedMap[key]` 均为 `undefined`。

     

  3. 在 `miniprogram/utils/match-card-state.js:21-28, 31-85` 中：

```js
function buildPredText(submitted, showPredict) {
  if (submitted) {
    const pair = predPair(submitted);
    if (submitted.match_score != null) return `我的预测 ${pair} · 得分 +${submitted.match_score}`;
    return `已提交 ${pair} · 不可修改`;
  }
  if (showPredict) return "";
  return "未预测";
}
```

     当 `submitted` 为 `undefined` 时，`hasSubmitted` 为 `false`：

     

     * **已预测的未开赛比赛**：虽然命中 `reason === "ALREADY_SUBMITTED"` 分支将样式设为 `is-submitted` 且隐藏预测按钮（`showPredict = false`），但 `buildPredText(null, false)` 直接返回 **`"未预测"`**，导致卡片处于已锁定状态却向用户展示「未预测」。  
     * **已完场比赛**：`scoreSub = hasCompleteScore(match) && hasSubmitted ? "FT" : "待结算"` 因 `hasSubmitted === false` 恒为 **`"待结算"`**（永不显示 `"FT"`），且左下角预测文案恒为 **`"未预测"`**（永不展示用户的预测比分与得分 `+3` / `+12`）。  
     * **内联提交成功动效被瞬时冲掉**：`matches.js:379-380` 在设置 `this.uiStates[key] = "submitted_locked"` 并调用 `this.refreshItems()` 后，下一行立即同步调用 `this.loadFirstPage()`，该函数首行即执行 `this.setData({ state: "loading", items: [] })`，导致 `✓ 预测已提交` 的状态反馈被瞬间清空并重载整页。  
* **修复方案**：  
  1. 在 `src/application/match-query.ts` 的 `MatchListItem` 与 `toItem()` 中复用 `mapMyPrediction`，将 `my_prediction: MyMatchPrediction | null` 一并随列表返回。  
  2. 在 `miniprogram/pages/matches/matches.js` 的 `decorateItem(item)` 中，优先读取服务端返回的 `item.my_prediction` 并注入格式化后的 `display_time`：

```js
// miniprogram/pages/matches/matches.js
decorateItem(item) {
  const kick = beijingParts(item.kickoff_at);

  const displayTime = item.display_time || (kick ? `${pad(kick.hour)}:${pad(kick.minute)}` : "--:--")
```

;  
\|---\|this.data.selectedDate, item.match\_id);  
const draft \= this.drafts\[key\] \|\| { home: 0, away: 0 };  
const submitted \= item.my\_prediction \|\| this.submittedMap\[key\] \|\| null;  
const cardState \= buildCardState({ ...item, display\_time: displayTime }, submitted);  
// ...  
}  
\`\`\`  
3\. 在 `miniprogram/utils/match-card-state.js` 中，将完场比赛 \`scoreSub\` 的 \`"FT"\` 判定改为仅依赖比赛是否有正式比分或已完成结算（\`hasCompleteScore(match)\`），不与当前用户是否预测耦合。

## **\[P0\] 2\. 比赛取代合并（`canonical_match_id` / `superseded_by`）全链路断层，导致重复赛程展示、预测死循环及结算漏算**

* **严重程度说明**：`P0`（核心功能阻断/严重逻辑错误）  
* **涉及文件**：`src/application/provider-schedule-sync.ts`（`ProviderScheduleSyncService.discover`） ↔ `src/application/match-query.ts`（`MatchQueryService.list` / `get`） ↔ `src/application/settlement-item-preparation.ts`（`prepareSettlementItems`） ↔ `src/application/prediction-query.ts`（`PredictionHistoryQueryService.listMyPredictions`） ↔ `src/application/crowd-query.ts`（`CrowdQueryService.get`）  
* **根因与触发路径**：  
  1. 当多源同步或赛程变更在 `ProviderScheduleSyncService.discover`（`src/application/provider-schedule-sync.ts:223-249`）触发同对阵比赛合并时，新比赛 `M2` 会继承旧比赛 `M1` 的 `canonical_match_id = M1`，并将旧比赛标记为 `M1.superseded_by = M2`。此后所有上游同步任务（`provider-window-loader.ts:101`、`provider-active-window.ts:14`）均只更新 `M2`，`M1` 永久停留在旧状态。  
  2. 但下游业务读写链路未对齐 `canonical_match_id` 与 `superseded_by`：  
     * **赛程列表重复展示废弃比赛**：`MatchQueryService.list`（`src/application/match-query.ts:318-337`）调用 `findBySeason(seasonId)` 后未过滤 `match.superseded_by !== null`，导致前端同时渲染被废弃的 `M1`（永远卡在 `scheduled`）与生效中的 `M2`。  
     * **查询与提交契约分裂导致死循环**：用户在 `M1` 被取代前已提交预测 `P1`（`P1.match_id = M1, P1.canonical_match_id = M1`）。当用户查看新比赛 `M2` 时，`MatchQueryService.list`（第 346 行）与 `MatchQueryService.get`（第 409 行）均调用 `this.repo.predictions.findByUserAndMatch(user.user_id, match.match_id)`（按 `match_id = M2` 查找，而仓储层专门实现的 `findByUserAndCanonicalMatch` 在全库应用层中从未被调用），返回 `null`，且 `mapMyPrediction`（第 273 行）硬编码校验 `prediction.match_id !== matchId` 抛 500 错误。前端因此认为 `M2` 尚未预测（`can_predict: true`）；但当用户点击提交时，`PredictionService.submit`（`src/application/predictions.ts:158-161`）按 `canonical_match_id` 查出 `P1` 并返回 `409 PREDICTION_ALREADY_SUBMITTED`；前端收到 `409` 后调用 `loadDetail()` / `loadFirstPage()` 重刷接口，接口又返回 `can_predict: true`，形成死循环。  
     * **结算漏算旧 match\_id 下的预测**：`M2` 完场结算时，`prepareSettlementItems`（`src/application/settlement-item-preparation.ts:36`）仅调用 `tx.predictions.findByMatch(settlement.match_id)` 查找 `match_id === M2` 的预测，导致挂在 `M1` 下的有效预测 `P1` **永远不会被生成 `settlement_items` 参与结算**。  
     * **历史预测列表与群体分布失真**：`PredictionHistoryQueryService.listMyPredictions`（`src/application/prediction-query.ts:250`）通过 `this.repo.matches.findById(prediction.match_id)` 读取已被废弃的 `M1`，导致「我的预测记录」中该场永远显示「未开赛 / 待结算」；`CrowdQueryService.get`（`src/application/crowd-query.ts:61`）仅统计 `match_id === M2` 的预测数，丢失 `M1` 上的全部投票。  
* **修复方案**：  
  1. 在 `src/application/match-query.ts` 中：  
     * `list()` 过滤掉 `match.superseded_by !== null` 的记录；  
     * `get()` 若命中有 `superseded_by` 的比赛，先通过 `resolveEffectiveMatch(this.repo, matchId)` 解析到当前有效比赛；  
     * 将用户预测查询统一改为 `this.repo.predictions.findByUserAndCanonicalMatch(user.user_id, match.canonical_match_id ?? match.match_id)`，并将 `mapMyPrediction` 的归属校验改为比对 `prediction.canonical_match_id === (match.canonical_match_id ?? match.match_id)`。  
  2. 在 `src/application/settlement-item-preparation.ts` 与 `src/application/crowd-query.ts` 中，先通过 `tx.matches.findIdsByCanonicalMatchId(match.canonical_match_id)` 获取同逻辑比赛的所有 `match_id`，再汇总关联的 `predictions`。  
  3. 在 `src/application/prediction-query.ts`（`getMyPrediction` / `listMyPredictions`）与 `src/application/settlement-item-application-service.ts`（`lastScoringAt` 等）中使用 `resolveEffectiveMatch` 获取比赛最新状态与赛果。

## **\[P0\] 3\. `LEVEL_FIRST_EVAL_AS_OF` 固定为 `null`，导致周评估遇保级判定崩溃、管理员重建用户统计将等级清零、每日一致性检查全量误报**

* **严重程度说明**：`P0`（核心功能阻断/严重逻辑错误）  
* **涉及文件**：`src/domain/config.ts`（`FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF`） ↔ `src/application/weekly-level-eval.ts`（`evaluateWithProtection` / `WeeklyLevelEvalService`） ↔ `src/domain/levels.ts`（`replayLevel`） ↔ `src/application/stats-rebuild-service.ts`（`RebuildUserStatsService`） ↔ `src/application/daily-consistency-snapshot.ts`（`replayExpectedLevel`）  
* **根因与触发路径**：  
  1. `src/domain/config.ts:69` 中 `LEVEL_FIRST_EVAL_AS_OF` 被固定配置为 `null`，且 `WeeklyLevelEvalService`、`LevelCorrectionReevalService`、`RebuildUserStatsService`、`DailyConsistencyService` 在生产装配（`src/runtime/application-runtime.ts` 与 `src/gateway/assemble.ts`）中全部使用该默认值 `null`。  
  2. **评估态与重放态逻辑自相矛盾**：  
     * `WeeklyLevelEvalService.run`（`src/application/weekly-level-eval.ts:342, 414`）在 `firstEvalAsOf === null` 时仍正常执行每周一评估，将达成条件的用户升级至 `Lv.2+` 并写入 `last_eval_as_of`、`last_eval_n`、`last_eval_score_sum`、`last_eval_b_points`。  
     * 然而，被 `RebuildUserStatsService`（`src/application/stats-rebuild-service.ts:181`）和 `DailyConsistencyService`（`src/application/daily-consistency-snapshot.ts:363`）调用的 `replayLevel`（`src/domain/levels.ts:421-430`）却规定：

```
if (firstEvalAsOf === null) {
  return {
    level: 1, best_level: 1, below_count: 0,
    week_base: { level: 1, best_level: 1, below_count: 0 },
    week_base_as_of: null, last_inputs: null, last_eval_as_of: null,
  };
}
```

  3. **触发的三大严重后果**：  
     * **周评估与改判重评阻断崩溃**：一旦任何已升至 `Lv.3..Lv.6` 的用户在某周未达保级线（`!meetsThresholdX100(S, n, holdX100(L))`），`evaluateWithProtection`（`src/application/weekly-level-eval.ts:121-147`）对比保护期内外结果不一致，直接抛出 `DomainError("SPEC_GAP", "LEVEL_FIRST_EVAL_AS_OF 未登记，当前评估结果受保护期影响")`，导致整个周评估任务中断，后续所有用户无法评估且实力榜快照与赛季终榜无法生成。  
     * **管理员重建用户统计抹除用户等级与实力榜资格**：调用 `POST /v1/admin/rebuild/users/:user_id` 时，因 `firstEvalAsOf === null`，`replayLevel` 返回 `level: 1, last_eval_as_of: null`，`storedLevelState`（`src/application/stats-rebuild-service.ts:154`）返回 `defaultLevelState()`，直接将该用户的 `career_level` 和 `season.level` 重置回 `Lv.1`，并将其实力榜窗口场次 `last_eval_n` 清零。  
     * **每日一致性检查 100% 误报**：`DailyConsistencyService` 每天对比线上已周评用户的 `career_level` / `last_eval_as_of` 与 `replayLevel` 的全空结果，产生全量 `DAILY_CONSISTENCY_MISMATCH` 告警。  
* **修复方案**：  
  1. 在 `src/domain/config.ts` 中为 `LEVEL_FIRST_EVAL_AS_OF` 登记明确的基准周一评估时间（如与 `RANKING_FIRST_PERIOD_KEY = "2026-W31"` 对齐的 `new Date("2026-08-03T02:00:00.000Z")`），或从用户最早有效预测所属周的下一个周一 `nextMondayEvalAt` 动态推导首评起点。  
  2. 统一 `WeeklyLevelEvalService` 与 `replayLevel` 对 `firstEvalAsOf` 的语义，禁止一侧执行评估落库而另一侧返回空基线。

## **\[P0\] 4\. HTTP 网关模式下登录态恢复与失效清理闭环断裂，且「我的」页未登录按钮错跳设置页导致无法登录**

* **严重程度说明**：`P0`（核心功能阻断/严重逻辑错误）  
* **涉及文件**：`miniprogram/pages/profile/profile.wxml` ↔ `miniprogram/pages/profile/profile.js`（`onSessionTap`） ↔ `miniprogram/services/api.js`（`request`） ↔ `miniprogram/services/auth.js`（`restoreAuth` / `ensureAuth`） ↔ `miniprogram/pages/session/session.js`（`onSubmit`）  
* **根因与触发路径**：  
  1. **「我的」页未登录态按钮路由绑错**：  
     在 `miniprogram/pages/profile/profile.wxml:6` 中，未登录态（`state === 'unauthorized'`）展示的「登录」按钮绑定了 `bindtap="onSessionTap"`：

```
<view wx:elif="{{state !== 'ready'}}" class="state-panel">
  <text>{{state === 'unauthorized' ? '登录后查看个人资料' : errorMessage}}</text>
  <button wx:if="{{state === 'unauthorized'}}" bindtap="onSessionTap">登录</button>
</view>
```

     但 `miniprogram/pages/profile/profile.js:288` 中 `onSessionTap` 的实现却是跳转至设置页：

```js
onSessionTap() {
  wx.navigateTo({ url: "/pages/settings/settings" });
},
```

     未登录用户点击「登录」后会跳进「个人资料设置」页，而设置页加载时再次请求 `GET /v1/profile/me` 得到 `401` 并报错「需要登录后访问个人资料」，页面中没有任何登录入口，形成死胡同。

     

  2. **服务端会话失效（401）后本地缓存未清理，导致登录页死锁**：  
     当本地缓存的 `auth_session` 未过本地 `expires_at` 但服务端会话已失效（如服务端重启、清理会话或时钟偏差返回 `401 UNAUTHORIZED`）时，`miniprogram/services/api.js` 不会调用 `clearAuth()` 清除本地 `auth_session`。当用户跳转至 `/pages/session/session` 点击「开始预测」调用 `initSession(nickname)` 时，`miniprogram/services/auth.js:104-114` 的 `ensureAuth()` 检查本地 `isAuthSessionActive(cached, now)` 仍为 `true`，直接复用已失效的旧 `access_token` 而不重新调用 `wx.login()` 换取新 token，导致 `POST /v1/session/init` 持续返回 `401`，登录页报错「请在微信中打开」并永久卡死。  
  3. **已注册老用户在无本地缓存时无法通过 `authPreparer` 自动静默登录**：  
     `miniprogram/services/auth.js:16` 将 `setAuthPreparer(() => restoreAuth())` 注册给 `api.js`。但 `restoreAuth()`（第 123 行）在本地无缓存（`!cached`）时直接返回 `skippedResult()`（`statusCode: 200`）而不触发 `startLogin()`。导致已注册用户换机、清除缓存或从分享卡片直接进入 `matches` / `rankings` / `groups/join` 时，所有请求均不带 `Authorization` 头裸奔发送，无法通过 `wx.login()` 自动恢复已有账号会话。  
* **修复方案**：  
  1. 在 `miniprogram/pages/profile/profile.js` 中拆分登录跳转与设置跳转：未登录按钮绑定 `onLoginTap() { wx.navigateTo({ url: "/pages/session/session" }); }`，设置按钮绑定 `onSettingsTap()`。  
  2. 在 `miniprogram/services/api.js` 与 `miniprogram/services/auth.js` 中：当非登录请求收到 `statusCode === 401` 时，立即调用 `clearAuth()` 清除失效缓存并自动重跑一次 `ensureAuth()` 重放请求；将 `setAuthPreparer` 指向 `ensureAuth` 以确保无本地缓存时也能通过 `wx.login` 获取会话。

## **\[P1\] 5\. 球队队徽解析逻辑缺陷，导致「我的预测记录」页 100% 队徽丢失，且全站 44 支注册球队（含皇马、马竞、国米、勒沃库森等）队徽回退为占位图**

* **严重程度说明**：`P1`（次要功能异常/前后端契约偏差/状态不同步）  
* **涉及文件**：`src/application/prediction-query.ts`（`PredictionHistoryItem`） ↔ `miniprogram/pages/my-predictions/my-predictions.js`（`presentItem`） ↔ `miniprogram/utils/team-presentation.js`（`presentTeam`） ↔ `miniprogram/utils/logo-registry.js`（`getTeamLogo` / `TEAM_ALIASES`） ↔ `miniprogram/utils/team-registry.js`（`TEAM_REGISTRY`）  
* **根因与触发路径**：  
  1. **「我的预测记录」页队徽 100% 丢失**：  
     后端 `GET /v1/predictions/me`（`src/application/prediction-query.ts:36-43`）仅返回 `home_team_id` 与 `away_team_id`，不返回球队英文名 `name`。前端 `miniprogram/pages/my-predictions/my-predictions.js:30-31` 调用：

```js
const homePresented = presentTeam({ team_id: item.home_team_id }, leagueId);
```

     而在 `miniprogram/utils/team-presentation.js:6-12` 中：

```js
function presentTeam(team, leagueId) {
  const teamId = team && team.team_id;
  const found = findTeam(teamId);
  const nameZh = found && found.name_zh ? found.name_zh : MISSING_NAME;
  const missing = !found || !found.name_zh;
  const logo = getTeamLogo(leagueId, team);
  return { teamId, nameZh, logo, missing };
}
```

     `presentTeam` 已经通过 `findTeam(teamId)` 拿到了包含 `source_name` 的 `found` 对象，却依然把不含 `name` 的 `team` 原样传给 `getTeamLogo(leagueId, team)`。`getTeamLogo` 读取 `team.name` 得到 `undefined`，导致 `my-predictions` 页面所有比赛的主客队队徽 100% 退化为默认占位图 `team-placeholder.png`。

     

  2. **全站 44/114 支球队的供应商标准名无法命中本地已打包的队徽资源**：  
     `miniprogram/utils/logo-registry.js:169-171` 仅剥离了首尾的 `fc` / `afc` / `football-club`，且 `TEAM_ALIASES` 覆盖不全，导致 `TEAM_REGISTRY` 中登记的 44 支球队的 `source_name`（即后端 `teams.name`）归一化后与 `MANIFEST` 中的键名失配（例如：`Real Madrid CF` → `real-madrid-cf` 无法命中 `real-madrid`；`Club Atlético de Madrid` → `club-atletico-de-madrid` 无法命中 `atletico-madrid`；`FC Internazionale Milano` → `internazionale-milano` 无法命中 `inter`；`Bayer 04 Leverkusen` → `bayer-04-leverkusen` 无法命中 `bayer-leverkusen`；`Liaoning Tieren FC` → `liaoning-tieren` 无法命中 `liaoning-tiening`；`Shenzhen Peng City` → `shenzhen-peng-city` 无法命中 `shenzhen-xinpengcheng`），尽管对应的 PNG 队徽文件均已打包在 `miniprogram/assets/logos/teams/` 目录下。  
* **修复方案**：  
  1. 在 `miniprogram/utils/team-presentation.js` 中，当 `team.name` 缺失时自动回退使用 `found.source_name`：

```js
const logo = getTeamLogo(leagueId, (team && team.name) ? team : (found ? found.source_name : team));
```

  2. 在 `miniprogram/utils/logo-registry.js` 中补齐常见俱乐部词缀剥离（如 `cf`、`ud`、`rcd`、`calcio`、`cfc`、`osc`、`ogc`、`aj`、`sco`、`1909`、`1913`、`04`、`07`、`29`、`1901` 等）或直接在 `TEAM_REGISTRY` 中为每个 `team_id` 显式映射对应的 `logo_slug`，彻底消除按英文名模糊归一化带来的失配。

## **\[P1\] 6\. 排行榜页（`rankings`）「我的积分/评分」计算缺陷、领奖台前 3 名重复渲染及更新时间戳丢失**

* **严重程度说明**：`P1`（次要功能异常/前后端契约偏差/状态不同步）  
* **涉及文件**：`src/application/ranking-query.ts`（`RankingQueryService.list` / `RankingMe`） ↔ `miniprogram/pages/rankings/rankings.js`（`applyListResult`） ↔ `miniprogram/pages/rankings/rankings.wxml`  
* **根因与触发路径**：  
  1. **排名第 11 名及以后的已上榜用户，顶部卡片「我的周积分/生涯积分/赛季积分/预测评分」显示为 `"—"`**：  
     后端 `RankingQueryService.list`（`src/application/ranking-query.ts:530-532`）每页仅返回 `RANKING_PAGE_SIZE = 10` 条记录，且最多只公开前 `RANKING_TOP_LIMIT = 20` 名；同时 `payload.me`（`RankingMe`）仅返回 `{ status: "ranked", rank, top_percent }`，不包含用户自身的积分/评分字段。  
     而前端 `miniprogram/pages/rankings/rankings.js:511-512` 却通过检索当前已加载的列表数组 `merged` 来获取用户自己的分数：

```js
const ownItem = merged.find(item => item.user_id === (this.profileData && this.profileData.user_id));
const standingValue = ownItem ? ownItem.mainValue : "—";
```

     * 当用户排在 **第 11～20 名** 时：首屏加载 `merged` 只有前 10 名，`ownItem` 为 `undefined`，顶部英雄卡显示「我的排名：第 12 名」，但旁边的「我的周积分」却显示 **`—`**；直到用户滑到底部手动点击「查看第 11—20 名 ↓」后，`standingValue` 才突然变成真实分数。  
     * 当用户排在 **第 21 名之后**（显示「前 X%」）时：因 `merged` 永远不会包含第 20 名之后的记录，用户的 `standingValue` **永久显示为 `—`**。  
  2. **`listItems` 与 `view.listTitle` 计算后未绑定 WXML，导致前 3 名重复渲染**：  
     `rankings.js:525` 专门计算了排除前 3 名的 `listItems: view.showPodium ? merged.slice(3) : merged`，`rankings-view-model.js:176` 也计算了 `view.listTitle`（不满 20 人时显示「全部 N 位预言家」）。但 `rankings.wxml:19-20` 却硬编码了 `{{scope === 'group' ? '群内' : '全站'}}前 20` 且列表循环绑定了 `wx:for="{{items}}"` 而非 `listItems`，导致当 `entryCount >= 3` 时，第 1～3 名在领奖台（`.podium`）渲染一次后，紧接着又在下方 `.rank-list` 中重复渲染一次。  
  3. **周榜与多赛季榜的 `view.updatedText`（「更新于 X 分钟前」）被 `wx:if / wx:elif / wx:else` 互斥吞没**：  
     `rankings.wxml:9`：

```
<view class="board-meta">
  <text>{{board === 'season' ? selectedSeasonLabel : board === 'career' ? '永久累计' : ''}}</text>
  <picker wx:if="{{board === 'week' && weekOptions.length > 0}}" ...>...</picker>
  <picker wx:elif="{{board === 'season' && availableLevelSeasons.length > 1}}" ...>...</picker>
  <text wx:else>{{view.updatedText}}</text>
</view>
```

     在周榜（`board === 'week'`）下，`weekOptions.length > 0` 恒成立，右侧命中 `<picker>` 分支，导致 `<text wx:else>{{view.updatedText}}</text>` 永远不渲染，而左侧 `<text>` 又为空字符串；在赛季榜有多个可选赛季时，左、右两侧同时重复渲染 `{{selectedSeasonLabel}}`（「2026—2027 赛季」），同样丢失 `view.updatedText`。

     

  4. **退群/解散群后切回排行榜陷入错误死锁**：  
     `rankings.js:262-265` 在 `scope === "group"` 且发现当前 `groupId` 已不在 `groupItems` 中时，直接 `this.setData({ state: "error", errorMessage: COPY.groupMembershipChanged }); return;`，既未更新 `this.data.groups` / `groupNames`，也未回退到全站榜；用户点击页面上的「重试」按钮会继续使用已失效的 `groupId` 发起请求，无限报错。  
* **修复方案**：  
  1. 在 `src/application/ranking-query.ts` 的 `RankingMe`（`status === "ranked"`）中直接附带当前用户在该榜单的数值（`period_score` / `career_points` / `season_points` / `strength_index`），前端 `rankings.js` 优先从 `payload.me` 读取 `standingValue`。  
  2. 在 `miniprogram/pages/rankings/rankings.wxml` 中将 `.rank-list` 的数据源改为 `wx:for="{{listItems}}"`（当 `listItems.length > 0` 时展示列表），列表标题绑定 `{{view.listTitle}}`；在 `.board-meta` 中将 `{{view.updatedText}}` 作为周榜左侧文本展示。  
  3. 在 `rankings.js:262` 当检测到 `selectedGroupIndex < 0` 时，先同步更新 `groups` 与 `groupNames`，并将 `scope` 重置为 `"global"`、`groupId: null` 后重新拉取全站榜。

## **\[P1\] 7\. 已提交预测的用户在比赛截止后至开球前无法查看「大家怎么选」（`crowdPlan` 状态判定优先级漏洞）**

* **严重程度说明**：`P1`（次要功能异常/前后端契约偏差/状态不同步）  
* **涉及文件**：`src/domain/prediction-policy.ts`（`predictRejectReason`） ↔ `miniprogram/utils/crowd-view-model.js`（`crowdPlan`） ↔ `miniprogram/pages/match-detail/match-detail.js`（`loadCrowd`）  
* **根因与触发路径**：  
  1. 根据业务规则与后端 `CrowdQueryService.get`（`src/domain/crowd-distribution.ts:69-75`），当到达预测截止时间（开赛前 10 分钟，`server_now >= prediction_deadline_at` 或 `prediction_closed_at !== null`）后，即使 `match.match_status` 仍为 `"scheduled"`，后端 `/v1/matches/:id/crowd` 已开放返回群体预测分布。  
  2. 但在后端 `predictRejectReason`（`src/domain/prediction-policy.ts:118-137`）中，判定优先级顺序为：  
     * 优先级 3：`if (existingPrediction !== null) return "ALREADY_SUBMITTED";`  
     * 优先级 6：`if (match.prediction_closed_at !== null || !isDeadlineOpen(...)) return "CLOSED";`  
       因此，对于**已经提交过预测的用户**，即使比赛已经过了预测截止时间，`match.can_predict_reason` 依然恒为 `"ALREADY_SUBMITTED"`（而未提交预测的用户此时为 `"CLOSED"`）。  
  3. 前端 `miniprogram/utils/crowd-view-model.js:7-16` 的 `crowdPlan` 却写为：

```js
function crowdPlan({ match, identityMissing }) {
  if (!match || TERMINAL_STATUSES.includes(match.match_status)) return "hidden";
  if (identityMissing) return "guest";
  if (
    match.match_status === "scheduled" &&
    (match.can_predict_reason === null || match.can_predict_reason === "ALREADY_SUBMITTED")
  ) return "locked";
  return "fetch";
}
```

     由于已预测用户的 `can_predict_reason` 在截止后仍是 `"ALREADY_SUBMITTED"`，`crowdPlan` 误判为未截止并返回 `"locked"`，直接拦截了 `getMatchCrowd` 请求。导致**未预测的用户在截止后能正常看到「大家怎么选」，而真正参与了预测的用户在截止后至开球前反而被锁死看不到**。


* **修复方案**：  
  在 `miniprogram/utils/crowd-view-model.js` 中，当 `match.can_predict_reason === "ALREADY_SUBMITTED"` 时，若比赛已关闭预测（`match.prediction_closed_at != null`）或直接放行交由后端 `CrowdQueryService` 按可信 `server_now` 判定是否 `not_closed`：

```js
function crowdPlan({ match, identityMissing }) {
  if (!match || TERMINAL_STATUSES.includes(match.match_status)) return "hidden";
  if (identityMissing) return "guest";
  if (match.match_status === "scheduled" && match.can_predict_reason === null) {
    return "locked";
  }
  return "fetch";
}
```

## **\[P1\] 8\. 「我的」页面（`profile`）定级等待态死代码、本赛季成绩单字段缺失、主队查询低效及创建群计数硬编码错误**

* **严重程度说明**：`P1`（次要功能异常/前后端契约偏差/状态不同步）  
* **涉及文件**：`src/application/levels.ts`（`LevelsQueryService.getLevels`） ↔ `src/application/profile.ts`（`ProfileQueryService.getMyProfile`） ↔ `miniprogram/utils/level-presentation.js`（`buildLevelView`） ↔ `miniprogram/pages/profile/profile.js` ↔ `miniprogram/pages/settings/settings.js`  
* **根因与触发路径**：  
  1. **Lv.1 满 20 场待周评用户的等级进度条错乱，且定级等待文案沦为死代码**：  
     * 后端 `src/application/levels.ts:46-48` 定义 `is_rated = valid_predictions >= 20`、`remaining_to_rated = Math.max(0, 20 - valid_predictions)`。因此当 `is_rated === false` 时，`remaining_to_rated` 必然 `> 0`。  
     * 前端 `miniprogram/utils/level-presentation.js:13-24` 中 `if (isRated === false)` 内的 `: "已达到定级场次，等待每周评估"` 成为永远不可能到达的死分支；当 `Lv.1` 用户在周中完成第 20 场有效预测但尚未到周一 10:00 评估时，后端返回 `career.level = 1, is_rated = true, remaining_to_rated = 0`，`profile.js:125` 计算 `nextThreshold = null`，进入 `buildLevelView` 后若 `bPoints` 非 `null`（如 `0`），`0 < null` 为 `false`，向仍处于 `Lv.1` 的用户错误展示 100% 满进度条与「评估积分已达门槛」。  
  2. **「我的成绩单」切换到「本赛季」时，累计积分与精确命中被硬编码为 `'—'`**：  
     后端 `user_season_stats` 表已完整维护了本赛季的 `points`、`valid_predictions`、`exact_hits`，但 `MyProfileData` 与 `SeasonLevelData` 均未暴露本赛季的 `points` 和 `exact_hits`。前端 `miniprogram/pages/profile/profile.wxml:22` 直接写死 `{{statScope === 'career' ? careerPoints : '—'}}` 与 `{{statScope === 'career' ? careerExactHits : '—'}}`，且底部左下角直接输出未格式化的原始 `seasonId`（如 `2026_2027`）。  
  3. **个人资料设置页与成长档案页通过分页拉取近 30 天比赛来反查球队**：  
     `settings.js:31-50` 的 `loadTeams()` 与 `profile.js:173-199` 的 `loadFavoriteTeam()` 调用 `listMatches({ limit: 100 })` 从近 30 天赛程中提取球队，导致处于休赛期或间歇期的联赛球队无法被搜索或显示队徽，而前端 `miniprogram/utils/team-registry.js` 已内置全量 114 支球队的 `TEAM_REGISTRY`。  
  4. **从「我的」页面创建预言群时 `owned_count` 硬编码为 `1`，且解锁页入口 `onUnlocksTap` 未绑定 WXML**：  
     `profile.js:280` 硬编码 `owned_count=1`；`profile.js:296` 定义了 `onUnlocksTap()` 但 `profile.wxml` 无任何元素绑定该事件，导致 `pages/unlocks/unlocks` 无法进入。  
* **修复方案**：  
  1. 在 `miniprogram/utils/level-presentation.js` 中，将未定级分支条件修正为 `if (level <= 1 || isRated === false)`。  
  2. 在 `src/application/levels.ts` 的 `SeasonLevelData` 中返回 `points: stats.points` 与 `exact_hits: stats.exact_hits`，并在 `profile.js` / `profile.wxml` 中绑定 `seasonPoints`、`seasonExactHits` 及 `formatLevelSeasonLabel(season.level_season_id)`。  
  3. 在 `settings.js` 与 `profile.js` 中直接基于 `TEAM_REGISTRY` 构建全量球队列表与解析主队队徽；在 `profile.js` 中传入真实的 `ownedCount + 1`，并在 `profile.wxml` 中绑定 `onUnlocksTap` 入口。

## **\[P2\] 9\. 首页样式表底部高度覆盖冲突导致列表底部被自定义 TabBar 遮挡，且快速切换联赛/日期存在定时器竞态**

* **严重程度说明**：`P2`（UI 渲染瑕疵/交互体验断层）  
* **涉及文件**：`miniprogram/pages/matches/matches.wxss` ↔ `miniprogram/custom-tab-bar/index.wxss` ↔ `miniprogram/pages/matches/matches.js`（`onLeagueTap` / `onDateTap`） ↔ `miniprogram/pages/my-predictions/my-predictions.wxml`  
* **根因与触发路径**：  
  1. **首页 `.feed` 列表底部被 `fixed` TabBar 遮挡**：  
     `miniprogram/custom-tab-bar/index.wxss:4` 将自定义底部导航栏设为 `position: fixed; bottom: 0; z-index: 20; height: calc(64px + env(safe-area-inset-bottom));`。而在 `miniprogram/pages/matches/matches.wxss:172-174` 中，后追加的规则 `.feed { height:calc(100vh - var(--native-header-height,88px) - 213px - env(safe-area-inset-bottom));padding-bottom:16px; }` 覆盖了前一条规则的 `padding-bottom: calc(80px + env(safe-area-inset-bottom))`，导致列表最后一张比赛卡片的底部操作区或「更多」按钮被 `64px` 高的固定 TabBar 遮挡。  
  2. **二级页面 `my-predictions` 误挂载 `app-tab-bar`**：  
     `pages/my-predictions/my-predictions` 是二级子页面（非 TabBar 页），但 `my-predictions.wxml:55` 渲染了 `<app-tab-bar active-index="2" />`，与其他二级页面体验割裂。  
  3. **首页快速切换联赛/日期的 `setTimeout` 竞态与详情页/加群页交互瑕疵**：  
     * `matches.js:141, 150` 在 `onLeagueTap` 和 `onDateTap` 中使用未清理的 `setTimeout(() => this.loadFirstPage(), 180)`，180ms 内连续点击会触发多余并发请求与过渡动画抖动。  
     * `match-detail.wxml:20` 在 `VS` 下方的 `.score-caption` 写为 `{{match.match_status === 'live' ? '进行中' : match.match_status === 'finished' ? '全场比分' : '开球时间'}}`，导致未开赛及延期/取消/腰斩比赛在 `VS` 下方显示字面量「开球时间」。  
     * `groups/join.wxml:18-20` 当 `state === 'error'` 时无重试或返回重填按钮。  
* **修复方案**：  
  1. 在 `miniprogram/pages/matches/matches.wxss:174` 中保留 `padding-bottom: calc(80px + env(safe-area-inset-bottom));`，并移除 `my-predictions.wxml` 中的 `<app-tab-bar>`。  
  2. 在 `matches.js` 中用实例句柄 `this.switchTimer` 管理切换定时器，每次点击前先执行 `clearTimeout(this.switchTimer)`。  
  3. 将 `match-detail.wxml:20` 的兜底文案改为 `{{statusText}}`，并在 `groups/join.wxml` 的 `.error-panel` 中增加重试/返回输入态按钮。

# **三、全局结构性改进建议**

| 优化维度 | 现存问题描述 | 结构性改进建议方案 |
| :---- | :---- | :---- |
| **仓储与查询层** | 业务逻辑层散落着对 `canonical_match_id` 与 `superseded_by` 的手动比对，容易遗漏校验导致死循环或数据缺失 | 在 `MatchRepository` 与 `PredictionRepository` 层面将「按有效比赛查询（默认过滤 `superseded_by === null`）」和「按 `canonical_match_id` 聚合预测」收敛为默认仓储契约方法 |
| **视图与领域状态** | 首页列表未内嵌用户预测，依靠小程序内存态 `submittedMap` 拼凑，易失效 | 在后端 `MatchListItem` 中统一内嵌精简版 `my_prediction`（含预测比分与结算得分），前端以服务端返回值为唯一事实来源（Single Source of Truth），移除页面级内存字典 |
| **等级与计算基线** | `LEVEL_FIRST_EVAL_AS_OF` 默认为 `null` 导致增量评估与全量重放逻辑冲突 | 将配置升级为环境必填或系统首个周期自动锚定，确保周评估增量计算、改判重评、每日一致性校验与管理员全量重建四个入口共享完全一致的时间轴与保护期边界 |
| **前端样式 Token** | 样式文件（如 `matches.wxss`）末尾存在重复追加的选择器块，产生不确定的级联覆盖 | 统一 `design-tokens.wxss` 与 `baseline-v041.wxss` 的单位制，清理页面级样式表末尾的覆盖规则，避免 TabBar 与安全区重叠冲突 |

