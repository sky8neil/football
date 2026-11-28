# 赛事预言家：小程序全量 Code Review 缺陷修复开发计划（v5.0 修订版）

> 状态：已合入第三方审核修订意见（`R1`～`R15`），待派发实施  
> 日期：2026-11-28（Asia/Shanghai；初稿 2026-11-26）  
> 基线快照：本地 `main`，HEAD `266ef5179c3174111d54a41974692d6612a5278f` + 当前未提交工作区（含 5 个页面高保真 UI 落地、后端 `users.gender` 联调与 `/home/neilxu/football-v5-review-source-manifest.json` 66 个文件指纹）；审查覆盖 `app.json` 13 个注册路由、`miniprogram/services/` 15 个模块、`miniprogram/utils/` 16 个模块及页面/配置。  
> 审核依据：三路独立小程序审查结果 + 第三方复核报告 `/home/neilxu/football-v5-plan-review-20261126.md`（含 VM 复现证据 `football-v5-review-evidence.mjs` 与 `football-v5-review-additional-evidence.mjs`）。  
> 基线测试状态：`./node_modules/.bin/vitest run --no-cache miniprogram/` **53/53 文件、724/724 用例通过**（仅代表已有断言通过，不代表下述未覆盖缺陷已修复）。  
> 问题汇总：**P0 零项、P1 6 项、P2 12 项**（合计 18 项，编号 `CR50-01`～`CR50-18`）。
>
> **定级标准**：
> - **P1（严重功能缺陷）**：主链路功能不可达/卡死（如无轮次无法生成分享卡、页面停在 loading/游客态、重复提交后恢复可预测态）、核心弹窗遮挡错误/登录态、或明确突破产品已拍板范围约束（`UI-02`）。
> - **P2（中等逻辑/状态机缺陷）**：特定边界条件、跨账号异步竞态、错误态文案/勾选错位、或与后端契约参数不一致，不阻塞主链路但影响一致性与体验。

---

## 1. 修复总览与并行切片规划

18 项缺陷按页面与公共模块所有权拆分为 **3 个并行执行切片**；各切片先跑定向测试与独立审查，汇总后再做全量 `miniprogram/` 与公共集成边界校验（`wxml-binding.test.mjs`、共享 VM loader、公共 view-model）：

| 切片 | 负责范围 | 覆盖条目 | 文件所有权边界 |
|---|---|---|---|
| **Slice A** | 我的预测分享入口 / 分享卡 / 解锁 / 设置 | `CR50-01`、`CR50-02`、`CR50-03`（P1）；`CR50-06`、`CR50-07`、`CR50-08`（P2） | `miniprogram/pages/my-predictions/*`、`miniprogram/pages/share-card/*`、`miniprogram/services/share-card.js`、`miniprogram/pages/unlocks/*`、`miniprogram/pages/settings/*` |
| **Slice B** | 赛程 / 比赛详情 / 会话 | `CR50-04`、`CR50-05`、`CR50-18`（P1）；`CR50-15`、`CR50-16`、`CR50-17`（P2） | `miniprogram/pages/matches/*`、`miniprogram/utils/match-card-state.js`（及测试）、`miniprogram/pages/match-detail/*`、`miniprogram/utils/crowd-view-model.js`、`miniprogram/pages/session/*` |
| **Slice C** | 排行榜 / 预言群 | `CR50-09`～`CR50-14`（P2） | `miniprogram/pages/rankings/*`、`miniprogram/pages/groups/*` |

---

## 2. P1 严重功能缺陷（6 项）

### CR50-01（P1 / Slice A）：`my-predictions` 分享入口缺 `round_id` 导致无法生成轮次分享卡；`share-card` 残留死入口与冗余请求（合入 R6、R9）

- **位置**：
  - `miniprogram/pages/my-predictions/my-predictions.wxml:7-19`、`my-predictions.js:375-385`
  - `miniprogram/pages/share-card/share-card.wxml:9-13, 28-29`
  - `miniprogram/pages/share-card/share-card.js:3, 24-26, 51-59, 319-332, 344-480, 624-721, 800-831`
  - `miniprogram/pages/share-card/share-card.test.mjs:528-535, 587, 625-660`
- **触发路径与根因**：
  1. **真实入口断链（R9）**：`my-predictions` 仅有联赛/赛季选择器，`onShareCardTap()` 只拼接 `league_id` 与 `season_id`，**从未传递 `round_id`**；而 `share-card.js:344-365` 必须同时收到 `league_id`、`season_id`、`round_id` 三项才请求卡片，导致从「我的预测」进入分享页永远落入 `state === "picker"`。
  2. **死入口与冗余请求**：`share-card.wxml` 已按定稿移除 `.filter-row`，但错误态 L29 仍展示「重新选择」按钮，点后跳回无 `<picker>` 的 `picker` 态；`onLoad` L363 仍无条件调用 `loadCatalog()` 发一次无人消费的 `GET /v1/league-seasons`。
  3. **接口边界说明**：`src/application/share-card.ts:288-305` 仅私有 `me` 模式对已注销用户返回 `409 USER_DELETED`，公开接收模式允许已注销用户返回 `200` 脱敏展示 `"已注销用户"`。
- **修复方法**：
  1. **补齐 `my-predictions` 轮次选择与完整分享参数**：在 `my-predictions` 明确提供用户可选的轮次分享入口（例如按所选联赛+赛季或已加载预测记录中的轮次列表由用户显式选择轮次，**不得擅自替用户默认取第 1 页或最近轮次**），点击后携带完整 `league_id`、`season_id`、`round_id` 跳转 `/pages/share-card/share-card`。
  2. **精确清理 `share-card` 废弃目录/选择器逻辑（R6）**：
     - **必须保留的业务上下文**：`selectedLeagueId`、`selectedSeasonId`、`selectedRoundId`（用于卡片请求、登录返回重试与上下文保存）、`sharerId`、`shareToken`、`mode`。
     - **删除纯目录/picker 逻辑**：移除 `share-card.wxml:29`「重新选择」按钮并将 L28「返回我的预测」扩展覆盖 `badParams`；移除 `listLeagueSeasons` import（L3）、占位常量（L24-26）、`sortedRounds`（L51-59）、`buildPickerState`（L426-466）、`loadCatalog`（L363 调用及定义）、`onLeagueChange`、`onSeasonChange`、`onRoundChange`、`onCatalogRetry`、`onReselect` 及目录展示状态。
  3. **迁移旧测试**：将 `share-card.test.mjs:528-535, 587, 625-660` 中依赖废弃 picker 事件的旧用例改写为真实入口测试（从 `my-predictions` 选轮次进入、带完整参数预览、接收者 `share_token` 保留、登录往返、错误态返回我的预测），禁止靠保留死方法或 skip 通过测试。
- **最小回归测试**：
  - `my-predictions.test.mjs` + `share-card.test.mjs`：从真实分享按钮选轮次进入，断言 URL 含 `league_id`/`season_id`/`round_id` 且目的页调用分享 API 进入 `card` 态；验证 `onLoad` 不再调用 `listLeagueSeasons`；`badParams`/`roundNotFound`/`userUnavailable` 均直接提供「返回我的预测」。

---

### CR50-02（P1 / Slice A）：`unlocks` 新增未达成清单违反 `UI-02` 规范，并补充防御性兜底（合入 R8）

- **位置**：
  - `miniprogram/pages/unlocks/unlocks.js:17-21, 96-108, 166-183`
  - `miniprogram/pages/unlocks/unlocks.wxml:71-83, 101-114`
- **触发路径与根因**：
  1. **已确认规范违背**：`docs/MINIPROGRAM_UX_REQUIREMENTS__v1.0.md:89, 93`（UI-02）与 `FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md:72` 明确规定仅补空态说明与「去预测」按钮，**不新增装扮清单、预览、下一目标或差额**。当前 `unlocks.js` 硬编码 `MILESTONES` 并在 `list` 态渲染了未达成项 `lockedItems` 及 `unlockedCount / totalCount`。
  2. **防御性边界（非当前正常合同故障）**：当前后端 `src/application/profile.ts:28-34` 必返 `career_points: number`，`src/domain/config.ts:544-548` 也仅定义 3 个 `unlock_code`；但前端 `presentUnlock` 仍应做好 `careerPoints ?? 0` 兜底，并对未来可能新增的非硬编码 `unlock_code` 原样展示记录，不因硬编码总数产生错配。
- **修复方法**：
  1. 移除 `unlocks.js` 中的 `MILESTONES`、`lockedItems`、`totalCount` 及 `unlocks.wxml:101-114` 的未达成列表块；顶部深绿概览卡仅展示「已记录 `unlockedCount` 项里程碑」（不展示未达成总数或清单）。
  2. `presentUnlock` 对 `careerPoints` 做 `careerPoints ?? 0` 兜底；保留现有已解锁项的中文名、门槛、进度与日期展示及 UI-02 空态。
- **最小回归测试**：
  - `unlocks.test.mjs`：列表态仅渲染后端返回的已解锁项、不含未达成清单；非硬编码 `unlock_code` 可原样展示；缺字段异常响应下进度为 `0/30` 而非 `undefined/30`；空态完整保留 UI-02 文案与「去预测」入口。

---

### CR50-03（P1 / Slice A）：`settings` 深链 `?section=team` 遮挡 `loading`/`401`/`error` 态，且初始定位需避免覆盖用户操作（合入 R10）

- **位置**：
  - `miniprogram/pages/settings/settings.wxml:10-31, 95`
  - `miniprogram/pages/settings/settings.js:145-150, 170-214, 330-355, 395-400`
- **触发路径与根因**：
  1. 从个人页点击主队进入 `/pages/settings/settings?section=team` 时，`onLoad` 立即置 `showTeams: true`，而抽屉位于 `loading`/`error` 分支之外；加载期点球队被 `if (loading) return` 静默吞掉，遇 `401`/`409`/网络错误时抽屉直接盖住「去登录」/「重新加载」面板。
  2. **防止覆盖用户操作（R10）**：若在 `loadProfile`/`loadTeams` 成功回调中无条件按主队重置 `activeLeagueId`，当资料先返回（抽屉已可见）而球队仍在途时，用户主动切换到德甲后会被迟到的 `loadTeams` 强制改回西甲。
- **修复方法**：
  1. `settings.wxml:95` 改为 `wx:if="{{showTeams && !loading && !errorKind && !errorMessage}}"`；`loadProfile()` 在 `401`/`409`/error/reject 分支重置 `showTeams: false`。
  2. 引入**一次性初始定位标记** `this.pendingInitialTeamFocus = section === "team"`：
     - 当用户主动切换联赛 Tab（`onLeagueTabTap`）、输入搜索（`onSearch`）、关闭抽屉或选择球队时，立即置 `this.pendingInitialTeamFocus = false`；
     - 仅在 `this.pendingInitialTeamFocus && this.data.showTeams && this.data.favoriteTeamId` 且已加载球队命中时，执行一次 `activeLeagueId` 定位并随即置 `this.pendingInitialTeamFocus = false`。
- **最小回归测试**：
  - `settings.test.mjs`：覆盖 `?section=team` 在 `loading`/`401`/`409`/error/reject 下不遮挡且重置 `showTeams: false`；覆盖 `loadProfile` 先返回 vs `loadTeams` 先返回两种顺序的西甲主队自动定位；覆盖「资料已返回、球队在途期间用户主动切德甲，球队返回后保持德甲不被覆盖」。

---

### CR50-04（P1 / Slice B）：`match-detail` 冷启动未订阅 `onAuthRestored` 且缺少卸载失效守卫（合入 R4）

- **位置**：`miniprogram/pages/match-detail/match-detail.js:265-295, 303-333, 489-541`
- **触发路径与根因**：
  1. 冷启动直达 `match-detail` 遇过期 token 时，`getMatchDetail`（`auth: "optional"`）先按匿名请求渲染游客态；随后 `app.js` 异步 `restoreAuth()` 续登成功并广播 `onAuthRestored`，但 `match-detail.js` 未订阅该事件，页面一直停留在游客态。
  2. **卸载后在途请求泄漏（R4）**：当前 `match-detail.js` 没有 `onUnload` 与 `this.unloaded`；仅退订 `onAuthRestored` 无法阻止已发出的详情/crowd/提交请求在页面卸载后继续 `setData` 或触发后继请求。
- **修复方法**：
  1. 在 `onLoad` 置 `this.unloaded = false`，订阅 `authService.onAuthRestored(...)` 保存退订函数（回调中判断 `!this.unloaded && this.data.matchId && !this.data.submitting` 后调用 `this.loadDetail()`）。
  2. 新增 `onUnload()`：置 `this.unloaded = true`，调用并清空退订引用，递增 `this.detailRequestSerial` 与 `this.crowdRequestSerial` 使全部在途详情/crowd 请求失效；详情、crowd、提交的 `.then`/`.catch` 回调均校验 `if (this.unloaded) return;`（不再写 `setData` 或发后继请求）。
- **最小回归测试**：
  - `match-detail.crowd.test.mjs` / `match-detail.prefill.test.mjs`：模拟冷启动匿名游客态 → `onAuthRestored` 自动重载切为可预测态；模拟旧匿名请求晚于登录请求返回不覆盖登录态；模拟 `onAuthRestored` 触发新请求后立即 `onUnload`，回包不写 `setData`、不发 `/crowd`；分享卡预填仅应用一次、不覆盖用户已编辑比分。

---

### CR50-18（P1 / Slice B，审核新增 R11）：`match-detail` 请求序号先于登录代次分配，导致切号后新详情请求被误判过期、页面停在 `loading`

- **位置**：`miniprogram/pages/match-detail/match-detail.js:223-224, 255-263, 308-310, 490-491`
- **触发路径与根因**：
  1. `loadDetail()` L308 先执行 `const serial = ++this.detailRequestSerial`，L310 再执行 `this.rememberLoginGeneration()`。
  2. 当旧请求在途期间登录代次变化、旧响应通过 `handleStaleLoginGeneration()`（L255-259）触发重载进入 `loadDetail()` 时，`rememberLoginGeneration()`（L223）发现代次变化会**再次递增 `this.detailRequestSerial`**，导致本次新请求刚捕获的 `serial` 立即小于 `this.detailRequestSerial`，响应在 L319 被永久丢弃，页面卡死在 `state: "loading"`。
  3. 同步检查 `loadCrowd()`（L490-491）的同类顺序，避免 `crowdRequestSerial` 出现相同问题。
- **修复方法**：
  - 在 `loadDetail()` 与 `loadCrowd()` 中，先调用 `const loginGeneration = this.rememberLoginGeneration();` 完成代次确认与旧序号作废，**再**递增分配本次请求的 `serial = ++this.detailRequestSerial` / `++this.crowdRequestSerial`。
- **最小回归测试**：
  - `match-detail.crowd.test.mjs`：模拟旧详情请求在途 → `loginGeneration` 变更（早于下一次 `onShow`）→ 旧响应返回触发重载 → 新请求成功返回，断言页面进入 `ready` 而非停留在 `loading`。

---

### CR50-05（P1 / Slice B）：`matches` 列表提交返回 `409 PREDICTION_ALREADY_SUBMITTED` 后回退可预测态（合入 R1）

- **位置**：
  - `miniprogram/pages/matches/matches.js:476-477, 516-527, 555-557, 667-676`
  - `miniprogram/utils/match-card-state.js:15-18, 36-43`
- **触发路径与根因**：
  1. `matches.js` 并无 `this.rawItems`，`refreshItems()` 重绘的是 `this.data.items`。
  2. 收到 `409 PREDICTION_ALREADY_SUBMITTED` 时只设 `this.uiStates[key] = "submitted_locked"` 而未记录已提交状态，`decorateItem` 中 `submitted` 为 `null` 会把 `uiState` 打回 `"collapsed"` 并重新显示「去预测 →」。
  3. 仅改 `can_predict_reason = "ALREADY_SUBMITTED"` 会导致 `match-card-state.js:36-43` 显示错误文案 `"未预测"`；而用空对象冒充 `submitted` 则会显示 `"已提交 undefined : undefined · 不可修改"`，也不能把刚被拒绝的草稿当成服务端真实已提交比分。
- **修复方法（显式建模「已提交、比分待同步」状态）**：
  1. 在 `matches.js` 新增与 `this.submittedMap` 同维度（按 `scope(league, date, match_id)` 与 `loginGeneration` 隔离）的明确结构，或在 `this.submittedMap[key]` 中支持带显式标记的记录 `{ pendingSync: true, loginGeneration }`（切账号或服务端真实 `my_prediction` 返回时自动替换/失效）。
  2. 在 `miniprogram/utils/match-card-state.js` 显式处理 `submitted && submitted.pendingSync === true`（以及 `item.can_predict_reason === "ALREADY_SUBMITTED"` 且无 `my_prediction`）：
     - `showPredict: false`、卡片样式 `is-submitted`、`stateText` / `uiState` 进入已提交锁定态；
     - `predText: "已提交 · 比分同步中"`（或 `"已提交 · 点开查看详情"`），**严禁出现 `"未预测"`、`undefined` 或把草稿比分伪装为真实已提交比分**。
  3. 在 `matches.js` 收到 `409 PREDICTION_ALREADY_SUBMITTED` 时写入该 `pendingSync` 标记、清空草稿并调用 `this.refreshItems()`，随后由 `silentRefreshAfterSubmit` 在返回完整 `my_prediction` 时覆盖为真实比分。
- **最小回归测试**：
  - `match-card-state.test.mjs` + `matches.workflow.test.mjs`：覆盖 409 后静默刷新失败、静默刷新未包含第 2 页该场比赛、最终服务端比分与原草稿不同、切换账号后标记消失；同时断言 `showPredict`、`uiState`、`predText`、`openCount`、`doneCount`。

---

## 3. P2 中等逻辑与状态机缺陷（12 项）

### CR50-06（P2 / Slice A）：`settings` 拉取 `/v1/teams` 失败降级静态表时，误将活跃升班马标为「已停用」
- **位置**：`miniprogram/pages/settings/settings.js:240, 296-311`
- **根因**：`loadTeams()` 失败降级 `buildRegistryTeams()` 时仍设 `this.teamsLoaded = true`，`refreshTeamName()` 据 `this.teamsLoaded && !loaded` 误判停用。
- **修复**：初始化 `this.serverTeamsLoaded = false`；仅在 `listTeams()` 返回 `200` 且数组合法时置 `this.serverTeamsLoaded = true`（`200 []` 视为服务端权威空结果，不回填静态表）；仅在 `this.serverTeamsLoaded && !loaded` 时置 `isFavoriteTeamInactive = true`。
- **回归测试**：`settings.test.mjs` 覆盖接口失败降级不误标停用、以及 `200 []` 不回填静态队。

### CR50-07（P2 / Slice A）：`settings` 昵称 `maxlength="12"` 与文案「2–12 字」同后端/登录页（1–32 字）不一致
- **位置**：`miniprogram/pages/settings/settings.wxml:38, 40`（对照 `src/application/profile-mutation.ts:81`、`miniprogram/pages/session/session.js:20`）
- **修复**：`settings.wxml:40` 改为 `maxlength="32"`，L38 提示文案改为 `1–32 字，展示于榜单与分享卡`。
- **回归测试**：`settings.test.mjs` 覆盖 1 字、13 字、32 字保存与服务端超长拒绝；注明微信原生 `maxlength` 对组合 Emoji 的实际计量需在真机/开发者工具实测，不以单测替代。

### CR50-08（P2 / Slice A）：`services/share-card.js` 拼接 `userId` 未做 `encodeURIComponent`
- **位置**：`miniprogram/services/share-card.js:48-65`
- **修复**：L63 改为 `path: "/v1/share-card/" + encodeURIComponent(userId)`，保持 query 与 `share_token` 透传不变。
- **回归测试**：`miniprogram/services/share-card.test.mjs` 断言特殊字符 `userId` 编码后的完整 `path` 与 `query`。

### CR50-09（P2 / Slice C）：`rankings` 切群及失效群重试自动选剩余群时未重置周周期（合入 R14）
- **位置**：`miniprogram/pages/rankings/rankings.js:325-344, 409-427, 463-473, 518-525, 569-576, 816-826`
- **根因**：`onGroupChange` 未清空 `selectedPeriodKey`/`userSelectedWeek`；且群 A 失效后重试自动选中剩余群 B（L325-344、L816-826）也未清空旧周，导致携带群 A 的历史周 `period_key` 查询群 B。
- **修复**：在 `onGroupChange` 及任何实际发生群/范围切换（含失效群自动切换至剩余群）时重置 `this.userSelectedWeek = false` 与 `selectedPeriodKey: null`；保留同一有效群内用户显式选历史周的行为。
- **回归测试**：`rankings.week-options.test.mjs` + `rankings.group-invalid.test.mjs` 覆盖「全站→群 A」「群 A→群 B」「群 A 选历史周 → A 失效剩余 B → 重试自动选 B」首次请求均不带旧 `period_key`，且同群内选周保留。

### CR50-10（P2 / Slice C）：`rankings` 跨账号 `resetLoginGeneration()` 漏复位派生字段，且 `onShow` 前迟到响应可写回旧账号数据（合入 R3、R13）
- **位置**：`miniprogram/pages/rankings/rankings.js:124-165, 177-198, 249-369`、`rankings.wxml:7-9, 26`
- **根因**：
  1. `resetLoginGeneration()` 遗漏成组派生字段（特别是 `showGroupScope`、`showCareerBoard`/`showStrengthBoard`/`showSeasonBoard`、选择器标签与索引、`scopeSheetOpen`、`view`/`listItems`/`podiumItems`/`entryCount`/`me`）。
  2. `loadFirstPage`（L249-369）及分页回调只校验 `requestSerial` 未校验 `loginGeneration`，在 `loginGeneration` 改变但下一次 `onShow` 尚未触发前到达的旧响应仍会写回旧昵称与 `currentUserId`。
- **修复**：
  1. `resetLoginGeneration()` 对照 `Page.data` 初始合同成组复位：`scopeSheetOpen: false`、`availableBoards: ["week", "career", "strength"]`、`showCareerBoard: true`、`showStrengthBoard: true`、`showSeasonBoard: false`、`weekOptions: []`、`weekOptionLabels: []`、`selectedWeekIndex: 0`、`availableLevelSeasons: []`、`seasonOptionLabels: []`、`seasonOptionLabels` 对应 `selectedSeasonLabel: ""`、`selectedSeasonIndex: 0`、`currentLevelSeasonId: null`、`showHistorySeasonEntry: false`、`showGroupScope: true`、`view: {}`、`items: []`、`listItems: []`、`podiumItems: []`、`entryCount: 0`、`me: null`（仅保留 `headerHeight` 等静态常量）。
  2. 在 `loadFirstPage`、`loadMore` 及关联 profile/groups 异步回调入口捕获 `generation = currentLoginGeneration()`，响应回来时若 `generation !== currentLoginGeneration()` 直接丢弃返回。
- **回归测试**：`rankings.slice7.test.mjs` 覆盖：① A 处历史赛季禁群态 → 切 B 且加载失败 → 打开范围弹窗仍有加群入口且全部成组字段复位；② A 的 profile/榜单/分页请求在途 → `generation` 变更（不触发 `onShow`）→ 旧响应到达均不写入页面状态。

### CR50-11（P2 / Slice C）：`rankings` 范围弹窗点「加入预言群 ›」未关闭弹窗，返回后遮挡新群榜
- **位置**：`miniprogram/pages/rankings/rankings.js:200-227, 596-602`
- **修复**：在 `onInviteTap()` 跳转前及 `onShow()` 入口均设置 `scopeSheetOpen: false`。
- **回归测试**：`rankings.group-invalid.test.mjs` 覆盖 `onInviteTap()` 立即关闭及加群后通过 `pending_ranking_group_id` 返回新群榜时弹窗保持关闭。

### CR50-12（P2 / Slice C）：`rankings` 群失效后顶部范围按钮与弹窗勾选同时错位（合入 R15）
- **位置**：`miniprogram/pages/rankings/rankings.js:409-427`、`rankings.wxml:6, 26`
- **根因**：失效态 `groupId: null, selectedGroupIndex: 0, scope: "group"` 导致 L6 顶部按钮显示空白或群 B，且 L26 弹窗仍仅按 `scope === 'group' && selectedGroupIndex === index` 把剩余第一个群 B 勾成已选。
- **修复**：
  - `rankings.wxml:6` 改为 `{{scope === 'group' ? (groupId && groupNames[selectedGroupIndex] ? groupNames[selectedGroupIndex] : '我的群') : '全站'}}`。
  - `rankings.wxml:26` 弹窗群项的选中样式与勾号改为 `{{scope === 'group' && groupId === item.group_id ? 'checked' : ''}}` 与 `{{scope === 'group' && groupId === item.group_id ? '✓' : ''}}`。
- **回归测试**：`rankings.group-invalid.test.mjs` 覆盖无剩余群与有剩余群 B 两种失效态（顶部显示「我的群」、弹窗无误勾选）及重选 B 后恢复高亮。

### CR50-13（P2 / Slice C）：`groups/join` 请求在途未禁用输入框，且失败分支硬编码 `canConfirm: true`
- **位置**：`miniprogram/pages/groups/join.wxml:13`、`miniprogram/pages/groups/join.js:52-79, 102, 118-130, 135-147, 185`
- **修复**：`join.wxml:13` 增加 `disabled="{{loading}}"`；`join.js` 所有恢复/错误分支的 `canConfirm` 统一按 `isValidInviteCode(this.data.inviteCode)` 计算。
- **回归测试**：`groups.test.mjs` 分别断言模板 `disabled="{{loading}}"` 与各错误恢复路径下 `canConfirm` 跟随当前输入合法性。

### CR50-14（P2 / Slice C）：`groups`/`detail` 跨账号回调解锁新账号操作锁，且确认弹窗阶段存在双击重入窗口（合入 R2）
- **位置**：`miniprogram/pages/groups/groups.js:138-189`、`miniprogram/pages/groups/detail.js:181-233`
- **根因**：
  1. `groups.js:143-145` 与 `detail.js:192-194` 在 `then` 的跨账号分支仍执行 `setData({ loadingAction: false })`，且 `.catch()` 缺少代次判断；旧账号 A 的 resolve/reject 会直接解开新账号 B 正在进行的操作锁或写入错误。
  2. `detail.js:182-190` 直到 `wx.showModal` 确认后才设 `loadingAction: true`，弹窗弹出前的双击可排入两次确认回调。
- **修复**：
  1. `groups.js` 与 `detail.js` 写操作的 `.then()` 与 `.catch()` 在 `currentLoginGeneration() !== generation` 时**直接 `return`，禁止任何 `setData` 或导航**。
  2. `detail.js` `confirmAction` 引入确认阶段锁（如 `this.confirmingAction = true`，在 `showModal` 前即拦截重入，于 `cancel`/`fail`/写操作结束或账号切换时释放），并在 `success` 回调同时保留 `loadingAction` 检查。
- **回归测试**：`groups.test.mjs` + `detail.test.mjs` 覆盖：① 账号 B 已有在途操作时，分别结束旧账号 A 的 resolve 与 reject，断言 B 的 `loadingAction`/错误/导航均不受影响且 B 自身能正常收尾；② 使用延迟 `wx.showModal` 回调测试连点两次仅弹出/执行一次。

### CR50-15（P2 / Slice B）：`session` 卸载后所有异步/失败/隐私回调仍写页面状态或导航（合入 R5）
- **位置**：`miniprogram/pages/session/session.js:95-128, 197-255`
- **根因**：`onSubmit` 的 200/201、非 2xx、reject、导航 `fail` 回调及迟到的 `getPrivacySetting.success` 在 `onUnload` 后仍执行 `setData` 或导航；`onUnload` 置空 `_privacyResolve` 前未 resolve `{ event: "disagree" }`。
- **修复**：`onLoad` 置 `this._unloaded = false`；`onUnload` 置 `this._unloaded = true`，取走并置空 `_privacyResolve` 后调用一次 `{ event: "disagree" }` 并注销隐私监听；`onSubmit` 200/201 成功时可保留 `storeNickname`，但**所有回调（200/201、非 2xx、reject、导航 fail、隐私查询）在 `this._unloaded === true` 时禁止 `setData` 与页面导航**。
- **回归测试**：`session.test.mjs` 分别覆盖 200/201、非 2xx、reject 在 `onUnload` 后返回，以及迟到 `getPrivacySetting` 与 `_privacyResolve` 一次性触发。

### CR50-16（P2 / Slice B）：`match-detail` 已注销用户三处入口未一致隐藏「大家怎么选」（合入 R12）
- **位置**：`miniprogram/utils/crowd-view-model.js:7-16`、`miniprogram/pages/match-detail/match-detail.js:489-541, 669-677`
- **根因**：除 `crowdPlan` 未处理 `USER_DELETED` 与 `loadCrowd` 未处理 `409 USER_DELETED` 外，提交预测收到 `409 USER_DELETED`（L669-677）也未隐藏 crowd 且未作废在途 crowd 请求。
- **修复**：
  1. `crowdPlan` 对 `match.can_predict_reason === "USER_DELETED"` 返回 `"hidden"`；
  2. `loadCrowd` 收到 `409 USER_DELETED` 时置 `crowdKind: "hidden"`；
  3. 提交预测收到 `409 USER_DELETED`（L669-677）时，同步递增 `this.crowdRequestSerial` 作废在途 crowd 请求，并将 `crowdKind: "hidden"`、`crowdState: "idle"` 及 `match.can_predict_reason: "USER_DELETED"` 一致落盘（保留普通 500 重试与幂等成功重放）。
- **回归测试**：`crowd-view-model.test.mjs` + `match-detail.crowd.test.mjs` 覆盖详情 reason、crowd 409、提交 409 三种入口均进入一致注销终态，且迟到 crowd 响应不覆盖。

### CR50-17（P2 / Slice B）：`match-detail` 提交预测在途未禁用步进器
- **位置**：`miniprogram/pages/match-detail/match-detail.wxml:89-104`、`miniprogram/pages/match-detail/match-detail.js:549-564`
- **修复**：4 个 `step-btn` 增加 `disabled="{{submitting}}"`，`onScoreStep` 首行增加 `if (this.data.submitting) return;`。
- **回归测试**：`match-detail.prefill.test.mjs` 验证 `submitting === true` 时不改变比分、`derivedResultText` 与 `hasUserEditedScore`，失败后恢复可改且 0–20 边界不变。

---

## 4. 验收门禁（区分自动化验证与界面实测）

### 4.1 自动化验证（全部命令退出码必须为 `0`）
1. **各切片定向测试**：Slice A / B / C 各自先运行对应测试文件，不逐片重复全仓。
2. **后端类型检查**：`./node_modules/.bin/tsc --noEmit`（覆盖 `src/` 与 `vitest.config.ts`，**注意：`tsconfig.json` 不检查小程序 JS/WXML**）。
3. **小程序全量测试**：`./node_modules/.bin/vitest run --no-cache miniprogram/`（0 failed、0 skipped，含 `wxml-binding.test.mjs` 与 `compliance.workflow.test.mjs`）。
4. **模板与 Diff 检查**：确认 `miniprogram/pages/**/*.wxml` 无原始 `<svg>` 标签，且 `git diff --check` 退出码 0。

### 4.2 微信开发者工具 / 界面验收项（自动化测试不可替代；未执行须显式登记为未验证）
- `CR50-01`：从「我的预测」实际选轮次进入分享卡生成与错误态按钮核对；
- `CR50-02`：解锁记录页仅展示已解锁项与空态视觉；
- `CR50-03`：从个人页点击主队（`?section=team`）在 loading/401/error 下的抽屉遮挡与西甲主队初始定位；
- `CR50-07`：昵称输入框 `maxlength="32"` 对普通字符与组合 Emoji 的微信真机计量行为；
- `CR50-10/11/12`：排行榜跨账号切换、加群返回关闭弹窗与失效群弹窗勾选态；
- `CR50-17`：比赛详情页提交中 4 个步进按钮实际禁用态。
