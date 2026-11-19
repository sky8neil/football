# football-mvp-baogao.md 审查（第二版）

审查日期：2026-11-18  
对照对象：`docs/football-mvp-baogao.md`  
第一版：`docs/football-mvp-baogao-核对.md`（保留，不删；本文推翻其中 1 条结论、修正 3 处证据强度）

## 这一版改了什么

第一版有一条写错、两处没证据就下了判断。查到真实数据库后修正如下：

| 项 | 第一版 | 第二版（已核实） |
|---|---|---|
| 赛程合并是否已在线上发生 | "没有查生产库" | **已查**：库里 6 条旧赛被标 `superseded_by`，全部中超第 18/22 轮延期赛 |
| 合并造成的双卡是否当前可见 | 未判断 | **当前不可见**：旧赛开球在 7—8 月，列表默认窗口是 `now-24h ~ now+30d`，全部落在窗口外 |
| 旧赛上有没有用户预测 | 未判断 | **0 条**。849 条预测全部落在新赛上，12 条已结算 |
| 队徽匹配率依据 | 注册表 `source_name` | **用库里真实球队原名校验**，结论同为 45/112 |

数据库连接方式：`/etc/football/gateway.env` 的 `FOOTBALL_DATABASE_URL`，schema `football_dev`，表为文档模型（`document` jsonb + `_id`），不是关系表。

## 结论分层

9 条里：**现在就会错 5 条**，**有真实数据支撑的潜伏问题 1 条**，**说重了/不成立 3 条**。

---

## 一、现在就会错

### 1. 首页列表不回显「我的预测」

真问题。报告的现象描述不准。

- `src/application/match-query.ts:36` 的 `MatchListItem` 没有 `my_prediction`；`MatchDetailResult`（:76）才继承它。
- `miniprogram/pages/matches/matches.js:283` `decorateItem()` 只读内存 `submittedMap`。
- `matches.js:357-363` 提交成功后写 `submittedMap` 并**立刻** `loadFirstPage()`，重拉后 `submittedMap` 不含该项，服务端又不给 `my_prediction`。

实际表现：按钮被锁成「已提交」（`match-card-state.js:69` 认 `ALREADY_SUBMITTED`），但比分行显示「未预测」（`buildPredText` 收到 `null` 走 `:32`）。

报告说"变回可预测"不成立。`matches.js:255` 的 `doneCount` 也拿 `ALREADY_SUBMITTED` 计数，说明服务端确实返回了该 reason，按钮不会解锁。

补充一个报告没提的：完场后 `match-card-state.js:57` 的 `scoreSub` 判据是 `hasCompleteScore && hasSubmitted`，`hasSubmitted` 永远为假，所以**已经结算的比赛在首页也显示「待结算」**，哪怕预测拿了满分。这条比"未预测"更误导。

### 2. 「我的」未登录按钮进设置页

真问题，范围比报告小。

- `profile.wxml:7` 未登录态按钮 `bindtap="onSessionTap"`。
- `profile.js:288` `onSessionTap()` 跳 `/pages/settings/settings`。
- `settings.js:23` 进页面就 `getMyProfile()`，未登录仍是 401，用户卡在设置页。

对照组：`my-predictions.js:153` 的 `onSessionTap()` 跳 `/pages/session/session`，是对的。

401 不清 token、过期前复用，**仅 HTTP 网关模式**成立：

- `api.js:184-187` 收到 401 只返回状态，不调 `clearAuth()`。
- `auth.js:117-126` `ensureAuth()` 在 `expires_at` 前直接返回缓存会话。

云函数模式不走 `authPreparer`（`api.js:204`），不要外推。

### 3. 「我的预测记录」队徽全占位

真问题。比例已用真实数据核实。

- `team-presentation.js:11` 调 `getTeamLogo(leagueId, team)`。
- `logo-registry.js:196` 只取 `team.name`，**不读 `team_id`**。
- `my-predictions.js:33-34` 传的是 `{ team_id: item.home_team_id }`，无 `name`。

实测（库内 112 支球队真实原名跑 `getTeamLogo`）：

| 输入 | 落占位图 |
|---|---|
| 只传 `team_id` | **112 / 112** |
| 传库里真实 `name` | **45 / 112** |

也就是说：即使补上名字，仍有 45 支缺别名，主要是西甲（Osasuna、Getafe、Levante、Málaga、Valencia、Villarreal、Real Madrid CF 等全称带 FC/CF）、德甲（`1. FC Köln`、`Bayer 04 Leverkusen`）、法甲（`AJ Auxerre`、`OGC Nice`）、意甲（`AC Monza`、`US Lecce`）。

报告写的 44/114 两个数都不对：队数是 112，不是 114。

不是同一个洞的地方：`profile.js:237-242` 的最近预测先拿详情，用带 `name` 的 `home_team` 传给 `presentTeam`，单独看是对的。但它同样受 45 支缺别名影响。

### 4. 排行榜三处显示

- **我的积分取自已加载列表**：`rankings.js:455` `merged.find(...)`，找不到就 `"—"`。前端 `services/rankings.js` 不传 `limit`，服务端 `API_DEFAULT_LIMIT=20`，但 `ranking-query.ts:776` 又取 `min(RANKING_PAGE_SIZE=10, 20)=10`。**首屏只有 10 人**，榜到 20 人。首屏时第 11—20 名看不到自己，自己积分显示「—」；20 名外永远「—」。报告"页 10 榜 20"的描述是对的。
- **前三名重复出现**：`rankings.js:472` 算出 `listItems = merged.slice(3)`，但 `rankings.wxml:21` 的 `wx:for` 用的是 `items`，`listItems` 全页无引用（已 grep 确认，只在 js 里出现两次，wxml 零次）。领奖台（:19 `podiumItems`）+ 列表（:21 `items`）导致前三名画两遍。
- **退群后停在错误态**：`rankings.js:194-197`，群 scope 下找不到该群就 `setData({state:"error"})` 并 return，不回落 `scope="global"`。报告写的行号 262 已过时，实际 ~195。
- **更新时间被选择器挡住**：`rankings.wxml:9` 选择器与 `view.updatedText` 是 `wx:if` / `wx:else` 关系，有周/赛季选择器时不显示更新时间。只影响展示，不影响数据。

### 5. 已提交用户截止后看不到大家预测

真问题。根因在前端判据。

- `src/domain/prediction-policy.ts:127-131` 先判 `existingPrediction !== null` → `ALREADY_SUBMITTED`，`:136-139` 才判截止。已提交者永远拿不到 `CLOSED`。
- `crowd-view-model.js:11-13` 把 `null` 和 `"ALREADY_SUBMITTED"` 一并当 `locked`。
- `crowd-view-model.js:8` 只在 `postponed/cancelled/abandoned` 时 `hidden`，`finished` 会正常往下走。
- `match-detail.js:237` 遇到 `locked` 直接 `return`，**根本不发请求**。

服务端 `crowd-distribution.ts:82-87` 截止后照常返回分布。**后端有数据，前端不请求。**

顺带一条报告没说的：`crowd-view-model.js:22` 的 `crowdComparison()` 要求 `matchStatus === "finished"` 才出对比文案。但已提交用户在完场后 reason 仍是 `ALREADY_SUBMITTED`，被 `crowdPlan` 判 `locked`，所以**完场后已提交用户连份额分布和对比都看不到**——这正好是最该看到的时候。

---

## 二、有数据支撑的潜伏问题

### 赛程合并（报告 P0-2）：代码缺陷真实存在，当前数据未触发用户可见故障

**先说代码**——报告这部分的判断是对的：

- `provider-schedule-sync.ts` 会把旧赛标 `superseded_by`，新赛继承 `canonical_match_id`。
- `cloudbase-app-repository.ts` 的 `findBySeason` **只按 `season_id` 查，不过滤 `superseded_by`**（对比：`findLive`、`findFinishedSettledOnDay` 都过滤了）。
- `match-query.ts:363-376` 列表直接吃 `findBySeason` 结果，只按联赛/状态/kickoff 过滤，**不排除已作废比赛**。
- 预测、提交冲突、结算仍按 `match_id`，不走 `canonical_match_id`。

**再说数据**（第一版没查，这版查了）：

```
matches 总数                        2238
superseded_by 非空                     6
这 6 条的状态                         全部 postponed
这 6 条的联赛                         全部 chinese_super_league
轮次                                 第 18 轮 ×5，第 22 轮 ×1
主客队与新赛是否相同                   6/6 相同
旧赛开球时间                          2026-07-11 ~ 2026-08-08
新赛开球时间                          2026-07-14 ~ 2026-09-18，状态全 finished
旧赛上的预测数                         0
新赛上的预测数                         12（全部已结算）
旧赛上的结算条目                       0
```

**结论**：

1. 合并确实发生了，但不是推测，是 6 次真实改期（中超延期后补赛），机制工作正常。
2. **旧赛全部不在默认查询窗口内**。`match-query.ts:218-219`：窗口默认 `server_now - 24h ~ server_now + 30d`。当前时间 2026-11-18，窗口是 `11-17 ~ 12-18`，而旧赛在 7—8 月。所以**现在用户看不到双卡**。
3. 更重要的：旧赛的球队与补赛完全相同、轮次相同，但**旧赛是 `postponed`**。前端 `match-card-state.js:58` 把 `postponed` 渲染成「延期」卡。
4. 报告说的"详情 500"不成立。`match-detail` 按当前 `match_id` 查预测，查不到就当 `null`（`applyMatch` 里 `match.my_prediction || null`），不会抛错。

**真正该记的风险**（比报告说的更具体）：

- 6 条旧赛**永久留在库里**且 `findBySeason` 不过滤。任何人只要把查询窗口开到 7—8 月（按轮次翻历史、赛季榜点旧赛季、后台对账），就会看到同一对球队、同一轮次、两张卡：一张「延期」、一张「已结束」。
- 如果以后补赛日期落在 +30d 窗口内，**首页会当场出现双卡**。目前只是时间上的侥幸。
- 修法很小：`findBySeason` 加 `.filter(m => m.superseded_by == null)`（其他查询早已这么写），或在 `match-query.ts` 的列表过滤链里补一条。不改 API 合同。

### `LEVEL_FIRST_EVAL_AS_OF: null`（报告 P0-3）：是闸门，但重算路径确实会毁数据

- `config.ts:69` 为 `null`，`levels.ts:322`、`time.ts:243` 注释标明是 Q1 未登记项。
- `weekly-level-eval.ts:141-148`：仅当保护期会改变结果时抛 `SPEC_GAP`。等级 1—2 或结果不受保护期影响的用户正常写入。不是"每个周一全员崩"。
- **但 `levels.ts:422-430`**：`firstEvalAsOf === null` 时 `replayLevel` 直接返回 `level:1, best_level:1` 的基线。`stats-rebuild-service` 和 `daily-consistency-snapshot` 都走这条回放。

所以：日常展示不会错，**手动跑一次等级重算/统计重建会把所有用户等级回放成 Lv.1**。这是高危脚枪，报告定的 P0 在"重算会毁数据"这个意义上成立，在"每周评估会崩"这个意义上不成立。

---

## 三、说重了或不成立

- **`level-presentation.js` 不是死代码**。`profile.js:11` 引入，`:130-136` 调用 `buildLevelView()`；`profile.wxml:20-21` 绑 `levelViewTitle` / `levelViewDetail`。报告这条错。
- **赛季成绩单两格写死「—」属实，但性质是缺字段**。`profile.wxml:26` 生涯格读 `careerPoints`/`careerExactHits`，赛季格硬编码 `"—"`；`levels` 接口的 `season` 对象里没有积分和精确命中。不是展示层算错，是接口没给。
- **主队 logo 翻比赛列表属实，但不是一律不可用**。`profile.js:196-208` 按游标翻 `listMatches(limit:100)`，一旦当前页出现该队就缓存并返回。风险是：球队不在已返回页里就永远出不来，且**每翻一页 100 条请求**。设置页走 `findTeam(team_id)` 注册表，不受影响。
- **解锁入口没接上属实**。`profile.js:296` 有 `onUnlocksTap()`，`profile.wxml` 无任何绑定（已 grep 确认）。
- **「我的预测记录」缺少 tabBar 留白不成立**。`my-predictions.wxss:4` 用 `--page-padding-bottom`，`design-tokens.wxss:194` 定义为 `calc(160rpx + env(safe-area-inset-bottom))`，注释即"让开 tabBar"。
- **首页 `.feed` 双写属实，遮挡未实测**。`matches.wxss:183` 设 `padding-bottom: calc(80px + safe-area)`，`:185` 又设 `padding-bottom:16px` 并加固定高度。tabBar 是 `custom: true`（`app.json:36`），组件 `custom-tab-bar/index.wxss:4` 高度 `calc(64px + safe-area-inset-bottom)`。`16px < 64px`，**最后一屏内容会被 tabBar 盖住约 48px**。这是从样式推算，没有真机量过。
- **180ms 定时器不多画错数据，只多请求**。`matches.js:149/160` 每次切换都 `setTimeout(loadFirstPage, 180)`，不清旧定时器；但 `:145` 同时 `requestSerial += 1`，`loadFirstPage` 会丢弃非当前 serial 的响应。代价是重复请求，不是报告说的结果覆盖。

---

## 四、建议处理顺序

按"用户可见 / 修复成本"排：

1. **P1-5 队徽**：先补 `presentTeam` 传 `name`（或用注册表 `source_name`），再补 45 支别名。两段都能独立验收。
2. **P0-4 「我的」登录**：`profile.wxml:7` 的按钮改跳 `/pages/session/session`，一行。
3. **P1-6 排行榜**：wxml 换 `listItems`、群失效回落 `global`、`ownItem` 缺自身时单独取一次 `me` 或直接显示「—」+ 不显示假名次。
4. **P0-1 首页回显**：要动接口（列表补 `my_prediction`）或前端按已提交 match_id 批量查。改动最大。
5. **P1-7 大家预测**：`crowdPlan` 在 `finished` 时不判 `ALREADY_SUBMITTED` 为 locked，或后端在截止后把已提交者的 reason 改判 `CLOSED`。
6. **P0-2 过滤**：`findBySeason` 补 `superseded_by == null`，一行，建议顺手做掉，避免补赛日期进窗口后翻车。
7. **P0-3 等级重算**：不修代码，先立规矩——`LEVEL_FIRST_EVAL_AS_OF` 登记前禁止跑 stats rebuild / 每日快照重建；或给这两个入口加前置断言。

## 五、没验证的部分

- 双卡在真机上的实际渲染（当前数据窗口外，构造不出来）。
- `.feed` 遮挡的真实像素（只做了样式推算，没有真机/模拟器截图）。
- 45 支缺别名补全后的视觉一致性（队徽尺寸/裁切）。
- 排行榜 20 名外用户的真实名单（需要 20+ 人的赛季榜数据）。
