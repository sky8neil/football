# football-mvp-baogao.md 核对

核对日期：2026-11-18  
对照对象：`docs/football-mvp-baogao.md`  
对照基线：当时工作区代码（`main`，已含首页预测展示、队名注册表、排行榜与「我的」页的现有实现）

结论先说：报告里的 9 条，现在就会让用户看到错状态或走不通的是 5 条；2 条是真漏洞，但只在特定条件下触发；其余是说重了、行号过时，或者已经不成立。

本文只记录代码核对结果，没有改业务代码，也没有查生产库里是否已经发生赛程合并。

## 现在就会错

### 1. 首页列表不带「我的预测」

真问题。报告把提交后的表现说歪了。

- `src/application/match-query.ts` 的列表项 `MatchListItem` 没有 `my_prediction`。这个字段只在详情 `get()` 里组装。
- `miniprogram/pages/matches/matches.js` 的 `decorateItem()` 只认本页内存里的 `submittedMap`。
- 提交成功后会立刻 `loadFirstPage()`，本地 `submittedMap` 被清掉。

同一场比赛、服务端已经记上预测时：按钮会锁成「已提交」（`can_predict_reason === "ALREADY_SUBMITTED"`），但比分那一行仍是「未预测」；完场后状态是「待结算」而不是全场比分。报告写的「变回可预测」不准确，那只在服务端没认出这场预测时才会出现。详情页走 `my_prediction`，不受这条影响。

### 2. 「我的」未登录按钮进了设置页

真问题，范围比报告小。

- `miniprogram/pages/profile/profile.wxml` 未登录按钮绑的是 `onSessionTap()`。
- `miniprogram/pages/profile/profile.js` 的 `onSessionTap()` 跳到 `/pages/settings/settings`。
- 设置页自己还要拉个人资料。未登录用户点「登录」进设置，请求仍会 401，人卡在设置页。

「我的预测记录」不是这个洞。`miniprogram/pages/my-predictions/my-predictions.js` 的 `onSessionTap()` 去的是 `/pages/session/session`。

401 不清本地 token、过期前继续复用，只在 HTTP 网关模式成立：

- `miniprogram/services/api.js` 收到 401 只把状态返回给页面，不调用 `clearAuth()`。
- `miniprogram/services/auth.js` 的 `ensureAuth()` 在 `expires_at` 之前直接交回缓存会话。

云函数模式的请求不走这套 `authPreparer`，这条不要外推到云模式。

### 3. 「我的预测记录」队徽全是占位图

真问题。报告的比例数字不对。

- `miniprogram/utils/team-presentation.js` 的 `presentTeam()` 调用 `getTeamLogo(leagueId, team)`。
- `miniprogram/utils/logo-registry.js` 的 `getTeamLogo()` 只读 `team.name`（或把参数本身当字符串），不读 `team_id`。
- `miniprogram/pages/my-predictions/my-predictions.js` 传入的是 `{ team_id }`，没有 `name`。

因此不传名字时，注册表里的 112 支全部落到占位图。用注册表的 `source_name` 再对一遍，仍有 45 支对不上现有别名。不是报告写的 44/114。

「我的」页最近两条预测不是同一个洞。`profile.js` 的 `loadRecentPredictions()` 先要详情，再把带 `name` 的 `home_team` / `away_team` 传给 `presentTeam()`。首页比赛卡同样传的是接口里的球队对象。

### 4. 排行榜三处显示

都属实，严重程度不一样。

- 我的积分从当前已加载列表里找自己。`miniprogram/pages/rankings/rankings.js` 用 `merged.find(...)` 得到 `ownItem`，找不到就写「—」。`src/domain/config.ts` 里 `RANKING_PAGE_SIZE` 是 10，`RANKING_TOP_LIMIT` 是 20。第一屏时第 11–20 名是「—」；20 名开外列表里根本没有自己，名次能显示「前 x%」，积分一直是「—」。
- 领奖台用前 3 名，下面的列表用的是完整 `items`。页面已经算出切掉前 3 的 `listItems`，但 `rankings.wxml` 没有用它。前三名出现两次。
- 群成员变化只把页面设成 error 就返回，不把范围改回全站。位置在 `rankings.js` 约 195 行，不是报告写的 262 行。重试仍用原来的群 scope，会再失败一次。
- 周榜、赛季榜有选择器时，`updatedText` 不会画出来（`rankings.wxml` 里选择器与更新时间是 `wx:if` / `wx:else`）。只是更新时间没显示，榜单数据本身没错。

### 5. 已经提交的人，截止后看不到大家预测

真问题。

- `src/domain/prediction-policy.ts` 的 `predictRejectReason()` 先判断「已提交」，再判断「已截止」。截止后，提交过的人 reason 仍是 `ALREADY_SUBMITTED`，不会变成 `CLOSED`。
- `miniprogram/utils/crowd-view-model.js` 的 `crowdPlan()` 把 `can_predict_reason === null` 和 `"ALREADY_SUBMITTED"` 都当成 locked，不再请求。
- 没提交的人截止后 reason 是 `CLOSED`，`crowdPlan()` 返回 `fetch`。

服务端 `crowdStatus()` 在截止后可以返回分布或样本不足。不对称是前端不请求，不是后端没数据。

## 条件成立，不是无条件故障

### 赛程合并（报告 P0-2）

代码路径是真的。报告没有证明线上已经发生，这次也没有查库。

- `src/application/provider-schedule-sync.ts` 发现新比赛时，若同主客队已有未终态比赛，会把旧比赛标 `superseded_by`，新比赛继承旧比赛的 `canonical_match_id`。
- `src/infrastructure/repositories.ts` 的 `findMatchesBySeason()` 只按 `season_id` 查，不过滤 `superseded_by`。列表因此可能同时出现新旧两场。
- 预测查询、提交冲突、结算准备仍按 `match_id` 查，不按 `canonical_match_id` 归并。`findByUserAndCanonicalMatchIds()` 只在个人联赛摘要里使用，没有接进比赛列表、提交或结算。

只有供应商换了比赛 ID、同步走到这条合并时，才会出现两场都在列表里、旧预测对不上新比赛、再提交返回 409。详情现在按当前 `match_id` 查预测，对不上就当没有，不会像报告说的那样打出 500。

### `LEVEL_FIRST_EVAL_AS_OF: null`（报告 P0-3）

这是写明的未登记闸门，不是漏赋值。`src/domain/config.ts` 该值为 `null`，`src/domain/levels.ts` 和 `src/domain/time.ts` 的注释把它标成 Q1：首次评估日未登记，保护期终点必须显式注入。

- 周评估只在「保护期会改变这次结果」时抛错并中断整批（`src/application/weekly-level-eval.ts`）。等级 1–2，或保护期不改变结果的用户，仍会正常写入。不是每个周一、每个用户都崩。
- `replayLevel()` 在这个值是 `null` 时固定回放成 1 级。`stats-rebuild-service` 和每日一致性快照都走这个回放。真去跑等级重算，会把已有更高等级算成 1 级。这是脚枪，不是当前展示层每天都在错。

## 不成立或已经过时

- **`level-presentation.js` 不是死代码。** `profile.js` 引入并调用 `buildLevelView()`，`profile.wxml` 的升级标题和说明绑的是它的 `levelViewTitle` / `levelViewDetail`。
- **赛季成绩单的「—」是模板写死。** 生涯积分、生涯精确命中有数字；切到「本赛季」时，这两格直接是「—」，中间格才是本赛季有效场次。等级接口的赛季对象没有积分和精确命中字段，所以这是缺字段，不是展示层算错。
- **主队 logo 靠翻比赛列表属实，但不是一律不可用。** `profile.js` 的 `loadFavoriteTeam()` 先看本地缓存，没有就按游标翻 `listMatches()`，直到当前列表里出现这支球队。球队不在已返回页里时 logo 出不来。设置页已经按 `team_id` 查注册表，不走这条。
- **解锁入口没有接上属实。** `profile.js` 有 `onUnlocksTap()`，跳 `/pages/unlocks/unlocks`，但 `profile.wxml` 没有任何绑定。函数是死的，不是页面不存在。
- **「我的预测记录」没给 tabBar 留白不成立。** 该页 padding 使用 `--page-padding-bottom`。`miniprogram/styles/design-tokens.wxss` 把它定义成 `calc(160rpx + env(safe-area-inset-bottom))`，注释就是让开 tabBar。
- **首页 `.feed` 写了两条属实。** `matches.wxss` 先写 `padding-bottom: calc(80px + env(safe-area-inset-bottom))`，紧接着另一条 `.feed` 把它改成 `16px`，并改了高度。滚动区有可能被底栏挡住。「最后一项完全点不到」没有在真机量过。
- **180ms 的 `setTimeout` 会多发请求，但不会把上一个联赛画到当前选择上。** `onLeagueTap` / `onDateTap` 没有清掉上一个定时器。每次切换会增加 `requestSerial`，`loadFirstPage()` 丢掉过期响应。快速连点的代价是重复请求，不是报告说的结果互相覆盖。

## 和报告条目的对应

| 报告 | 核对 |
|---|---|
| P0-1 首页不回显我的预测 | 成立。按钮已锁、比分仍显示未预测；不是一概变回可预测 |
| P0-2 赛程合并未贯穿 | 代码路径成立。只在发生合并时触发；详情 500 不成立；是否已在库里发生未查 |
| P0-3 首次评估日为 null | 是已知闸门，不是无条件崩溃。重算会把等级回放成 1 级 |
| P0-4 登录死路与 401 | 「我的」未登录进设置成立。「我的预测记录」的登录按钮是对的。401 复用缓存只针对 HTTP |
| P1-5 预测记录队徽 | 成立。112 支因不传名字全部占位；即使用原名仍有 45 支对不上。不是 44/114 |
| P1-6 排行榜名次与领奖台 | 积分取已加载列表、前三重复、退群后停在错误态，成立。更新时间被选择器挡住只影响展示。行号 262 已过时 |
| P1-7 大家预测对已提交用户锁定 | 成立 |
| P1-8 等级死代码、赛季成绩、主队、解锁 | 等级展示不是死代码。赛季两格写死「—」、主队翻比赛列表、解锁无入口，成立；主队不是一律不可用 |
| P2-9 底栏与定时器 | 首页 `.feed` 后写覆盖前写，成立，遮挡程度未实测。预测记录页留白不成立。定时器不会造成联赛结果覆盖 |
