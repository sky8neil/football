# MVP 2.0 数据源验证结果 v1.0

> 验证日期：2026-10-12
> 验证方式：文档核对 + 真实调用（每个 key 的调用量都控制在清单要求的额度内）
> 结论口径：**已确认** / **与我的理解不符** / **文档里没写**
> key 处理：所有 key 由脚本在运行时从原清单文件读取，未写入本报告、命令或输出。文中 key 一律以末 6 位表示。

---

## 摘要：五条必须先处理的结论

| # | 结论 | 影响 |
|---|---|---|
| 1 | **O8 错了**。OpenFootAPI **确实覆盖中超**，但数据只到 **2026-09-18**，缺最近一个月 | `of` 不能当天做中超兜底，只能做历史对账；清单里"of 不含中超"的判断要改 |
| 2 | **B2 的字段名几乎全错**。真实字段是 `event_date` / `round_number` / `home_team_id`，且**球队 ID 存在** | 适配器按清单写会全量解析失败 |
| 3 | **B1 参数名错**。参数是 `league_id` 不是 `league`（虽然 `league=52` 也能被接受）；中超 ID = 52 本身是对的 | 需统一为 `league_id` |
| 4 | **S5 有确切答案**：响应头 `X-RateLimit-Limit: 2000`，**用户说的 2000/天是对的，文档的 10000 是错的** | 自设上限按 2000 |
| 5 | **D3 无法在当前时段验证**：现在是北京时间 15:00（欧洲凌晨），五大联赛无进行中比赛，`status=live` 返回 0 条是正常的 | 需要在有比赛的时间重测 |

---

## 一、football-data.org（`fd`）

| # | 结论 | 依据 |
|---|---|---|
| **F1** | **已确认**（限额按 key 独立计算，两个 key 池容量翻倍） | 干净窗口内实测：key1 连打 5 次，剩余 9→8→7→6；同刻 key2 仍为 **9**，重置计时器独立走（key1 剩 51s 时 key2 显示 60s）。补充实测：key1 撞到 429（`{"message":"You reached your request limit. Wait 18 seconds.","errorCode":429}`）时，key2 仍返回 200 且 `x-requests-available-minute: 9` |
| **F2** | **文档里没写** | 站点 `/terms` 与 `/terms-of-use` 均 404；首页无法律链接。**⚠️ 这是上线门禁缺口，需邮件问官方** |
| **F3** | **已确认** | 五个代码全部返回 2026 赛季数据：`PL` 10 场、`PD` 10 场、`SA` 10 场、`BL1` 9 场、`FL1` 9 场 |
| **F4** | **已确认**（无"剩余额度"语义，只有"本分钟可用次数"） | 头名 `x-requests-available-minute`（当前分钟剩余可请求数，0-9）与 `X-RequestCounter-Reset`（窗口剩余秒数）。**注意：没有月度额度头**，`resultSet` 只含 `count/first/last/played` |
| **F5** | **与我的理解不符**（延迟远小于预期） | 2026-10-11 的 3 场比赛在 10-12 07:1x UTC 查询时已全部 `FINISHED` 且比分完整，未定赛的显示 `TIMED` 且比分为 `null`。免费版未观察到显著延迟 |
| **F6** | **文档里没写** | 同 F2，条款页不可达 |
| **F7** | **与我的理解不符**（无跨度上限） | 依次实测 10/30/45/60/91/366 天跨度，**全部 HTTP 200**，366 天返回 380 场。窗口请求不受跨度限制 |
| **F8** | **已确认** | `season=2026` 对应 `startDate: 2026-08 / endDate: 2027-05`，即 2026/27 赛季 |
| **F9** | **已确认** | 已完赛联赛比赛 `score.duration` 恒为 `REGULAR`，`fullTime` 即 90 分钟比分 |
| **F10** | **文档里没写** | 未在真实数据中遇到 `AWARDED` 状态；本轮验证窗口内无判罚比赛 |

**给开发的补充**：球队带 ID（`Arsenal FC` = 57），可直接建映射，无需名称模糊匹配。

---

## 二、BSD Sports API（`bsd`）

| # | 结论 | 依据 |
|---|---|---|
| **B1** | **与我的理解不符**（ID 对，参数名错） | `league=52` 返回 4364 场且 `league_id: 52`，但**文档定义的参数是 `league_id`**。文档示例为 `league_id=85`。建议统一用 `league_id` |
| **B2** | **与我的理解不符**（字段名几乎全错，且球队 ID 存在） | 真实字段见下方映射表 |
| **B3** | **与我的理解不符**（是整数，不是两位数字字符串） | 中超真实响应 `round_number: 27`，类型 **int**；另有 `round_label: "Regular season · Matchday 27"`、`stage: "regular-season"`。文档明确 `round` 需配合 `stage`，且轮次号在不同 stage 间会重复 |
| **B4** | **文档里没写**（只有取值列表，无语义定义） | 文档仅列出 `upcoming · live · finished · cancelled · postponed · unresolved`。**但真实响应的取值是 `notstarted`，不在文档列表里** —— 文档与实际不一致，需按实际值写映射。`unresolved` 的确切含义文档未解释 |
| **B5** | **文档里没写** | 文档只说 `/events/live/` 服务端缓存 10–30 秒、建议 10 秒轮询；未说明 `/events/` 列表端是否也缓存 |
| **B6** | **文档里没写**（响应体结构未验证，按要求未打满额度） | 但**已确认响应头格式**：`ratelimit: "football";r=7500;t=60479`（剩余次数与窗口秒数）、`ratelimit-policy: "football";q=7500;w=86400`（配额与窗口秒数）。7500/天得到确认 |
| **B7** | **已确认：允许商用展示** | 条款 v4.0（2026-10-01 生效）原文：<br>· 允许："Display the Data within your own applications, websites, dashboards and internal tools"<br>· 允许："Derived Outputs… are yours. You may use, publish, sell and distribute Derived Outputs without restriction"<br>· 禁止："Resell, sublicense, mirror or redistribute the raw Data… as a standalone dataset, feed, database or API"<br>· **禁止："Share your API key or use multiple accounts to bypass plan limits"**<br>· 额外：logo 等媒体资产不在许可范围内，商用需自行取得授权 |
| **B8** | **已确认：列表响应不含赔率/预测** | 事件对象字段中无任何 `odds`/`predict`/`bet`/`market` 字段。但响应**内嵌 `head_to_head` 对象**（含历史交锋比分），这是清单未预料到的冗余数据 |

### B2 真实字段映射表（务必按此实现）

| 清单里的假设 | 真实字段名 | 类型 |
|---|---|---|
| `home_team.name` | `home_team`（扁平字符串） | string |
| `away_team.name` | `away_team` | string |
| `kick_off` | **`event_date`** | string（UTC，`2026-10-11T11:35:00+00:00`） |
| `home_score` / `away_score` | 同名 | int / null |
| `round` | **`round_number`**（另有 `round_label`、`stage`、`stage_name`） | **int** |
| `league.name` | **`league_id`**（扁平 int，需另查联赛接口取名） | int |
| 球队 ID | **`home_team_id` / `away_team_id`** —— **存在** | int |
| — | 清单未提及的额外字段 | `season_id`、`home_coach_id`、`away_coach_id`、`referee_id`、`venue_id`、`replaced_by`、`period`、`current_minute`、`home_score_ht`、`away_score_ht`、`penalty_shootout`、`extra_time_score`、`is_local_derby`、`is_neutral_ground`、`travel_distance_km`、`weather`、`pitch_condition`、`attendance`、`live_websocket`、`websocket_plus`、`highlights`、`head_to_head`、`has_xg`、`previous_leg_event_id` |

**重要口径**：`home_score`/`away_score` 是**常规时间比分**，加时在 `extra_time_score`、点球在 `penalty_shootout`。联赛比赛不需要合并，但适配器不要直接相加。

**B5 附带发现**：已完赛比赛的 `current_minute` 仍为 `95`（不是 null），不能用它判断是否进行中，必须看 `status` 和 `period`。

---

## 三、5DollarFootballAPI（`5d`）

| # | 结论 | 依据 |
|---|---|---|
| **D1** | **已确认：整点重置的固定窗口** | 文档原文："Each plan has one rate window: 60 requests / hour on Free… The window belongs to your account, so every key you create shares it — **extra keys are for organising projects, not multiplying quota**."<br>实测响应头 `x-ratelimit-limit: 60`、`x-ratelimit-remaining: 59`、`x-ratelimit-reset: 1791792000`（Unix 时间戳，对齐整点） |
| **D2** | **已确认：五大联赛全部可得，但 ID 与文档示例完全不同** | `/v1/leagues` 真实返回 5 个联赛：英超 `4160026622`、西甲 `4212821298`、意甲 `3405541143`、德甲 `686337048`、法甲 `3614399544`。**清单里记的 `3120672213`（英超）和 `1810150156`（西甲）是错的** |
| **D3** | **无法验证**（时段不匹配，非结论） | 调用成功（HTTP 200，`success: 1`），但返回 0 场。当前为北京时间 15:05 / UTC 07:05，英超西甲无进行中比赛。**需在比赛时段重测** |
| **D4** | **已确认（与示例不同）** | 文档原文：进行中 `status_code` **是分钟数**，中场为 `"half"`；完场为 `"full"`。异常为 `{"status":"unknown","status_reason":"result_unconfirmed","status_code":"67"}`。实测 10-10 共 24 场：23 场 `finished`/`full`，1 场 `unknown`/`26`（Rayo Vallecano 0-0 Athletic Club） |
| **D5** | **文档里没写**（但结构上可推断安全） | 比分字段是 `goals`，含 `home`/`away`/`half_home`/`half_away`，**没有单独的加时/点球字段**。文档未明确说明是否含加时进球 |
| **D6** | **已确认：正好 24 小时** | 跨 72 小时窗口返回 HTTP 400：`{"type":"invalid_request","code":"invalid_time_window","message":"The window may span at most 24 hours.","param":"end_time"}`。文档亦确认 `/v1/fixtures` 有 24h 上限，而 `/v1/leagues/{id}/fixtures` **无跨度限制** |
| **D7** | **与我的理解不符：未来赛程可查，但当前查询为空** | 查询 2026-10-20 窗口返回 HTTP 200 / `success: 1` / **0 场**。`/v1/leagues` 的 `last_fixture_utc` 显示为 `2026-10-25`，说明**未来赛程存在**，但 10-20 当天确实无五大联赛比赛（国际比赛日空档）。可用作赛程核对 |
| **D8** | **已确认：免费版只有 5 个联赛，无中超** | `/v1/leagues` 返回 5 项，无任何中国联赛 |
| **D9** | **已确认：允许商用展示，但需署名** | 条款原文："You may use the data in your own commercial products — websites, apps, models and internal tools — including displaying scores, statistics and odds to your end users, and you may cache API responses to serve them faster."<br>署名要求（Free/Community 强制）："include the words 'Football data by 5DollarFootballAPI' in a reasonably visible place and link them to 5dollarfootballapi.com"<br>禁止："resell raw API responses as a competing data feed" |
| **D10** | **已确认：默认不返回赔率，角球红黄牌一律返回** | 默认响应顶层字段：`id, league, teams, kickoff_utc, kickoff_ts, status, status_reason, status_code, goals, corners, cards`。**无赔率字段**。`corners`（含半场）和 `cards`（黄红牌）**默认就返回，无法关闭**，适配器需主动丢弃。<br>赔率需显式 `?include=odds`，但**免费版会拒绝**：`HTTP 403 insufficient_plan`（"Batch odds start with Pro"） |

**给开发的补充**：`teams.home` / `teams.away` 内含**球队 ID**（Arsenal = `2592538664`），可建稳定映射，不用靠名称。

---

## 四、OpenFootAPI（`of`）

| # | 结论 | 依据 |
|---|---|---|
| **O1** | **已确认：有比分字段** | 字段名为 **`score`**，结构 `{"home": 0, "away": 1}`。比赛对象完整字段：`id, competitionId, season, round, kickoffAt, kickoffTimeKnown, status, venue, homeTeam, awayTeam, score, minute, addedTime, period, updatedAt, sourceRefs` |
| **O2** | **已确认：两个字段都有** | `season`（如 `"2026/27"`，也有 `"2026"` 这种自然年制）与 `round`（字符串，如 `"Round 6"`、`"7. Spieltag"`、`"Round Clausura - Round 11"`）。**轮次是自由文本，不是数字** |
| **O3** | **已确认（西甲拼写与清单不同）** | 英超 `comp_premier_league_eng`、西甲 **`comp_laliga_es`**（清单写的 `comp_la_liga_es` 少一个 l，**错的**）、意甲 `comp_serie_a_it`、德甲 `comp_bundesliga_de`、法甲 `comp_ligue_1_fr` |
| **O4** | **已确认：自然月，按 UTC 月份** | 响应 `meta.access`：`{"quota":5000,"used":2,"remaining":4998,"period":"2026-10"}`。**`meta.access` 里有精确的 used/remaining，可直接用于预算校正** |
| **O5** | **与我的理解不符（两个坑）** | ① 单页上限 **50 条**，`meta.pagination.next_cursor` 需翻页；2026-10-10 全量 `count:50 / total_count:192 / partial:true`。② 数据源不齐时 `meta.unavailable` 会说明原因，例如 `{"competition_id":"comp_fa_cup_eng","reason":"season_not_published_upstream"}`。历史深度充足，中超可回溯到 3 月 |
| **O6** | **已确认** | `ratelimit-limit: 5000`、`ratelimit-remaining: 4999`、`ratelimit-reset: 1702186`（秒）、`ratelimit-minute-limit: 60`。**注意：分钟限额 60 次，比 5d 的 20 次/分宽松得多** |
| **O7** | **已确认：必须带 key** | 不带 key → HTTP 401 `{"code":"authentication_required"}`。带 key 后 `meta.access` 变为 `{"authenticated":true,"plan":"starter","keyId":"key_…","quota":5000,"used":…,"remaining":…,"period":"2026-10"}`。注意 keyId 是个 UUID，别写进日志 |
| **O8** | **与我的理解不符 ❗ 覆盖中超，但数据滞后约 3.5 周** | `/v1/competitions` 明确列出：`{"id":"comp_chinese_super_league_chn","name":"Chinese Super League","currentSeason":"2026","availableSeasons":["2025","2026"],"coverage":{"fixtures":true,"standings":true,"events":true}}`<br>但实测：查询 `competition=comp_chinese_super_league_chn&date=2026-10-10` 返回 **0 场**；分页遍历全季 208 场，**最新一场是 2026-09-18**，9 月仅 11 场后中断，全部 `finished`。同期 sportapi 有 10-10、10-11 的中超比赛，BSD 也有 |
| **O9** | **已确认：允许商用展示，但有署名传递义务** | 条款第 7 节（caching/retention/attribution）允许缓存与存储；第 5 节明确不限制内部研究，但："**Access to a competition through the service is not a licence to redistribute the underlying provider's feed. Every response carries `meta.sources`, and every entry in `/v1/competitions` carries the licence that applies to that competition. Please carry that attribution through to anything you publish.**"<br>**这对五大联赛是个隐患**：`/v1/competitions` 显示其 source 为 `{"name":"FotMob","license":"Unlicensed-Beta (owner-approved factual data)"}` —— 五大联赛数据来自 FotMob 的未授权 beta 许可，商用转发需谨慎，建议法务确认 |

---

## 五、sportapi.ai（`sp`）

| # | 结论 | 依据 |
|---|---|---|
| **S1** | **已确认：覆盖中超** | 联赛 ID = **85**，名称 `Chinese Super League`，`league_geo: "CN"`。2026-10-10 真实返回 2 场：成都蓉城 0-1 天津津门虎、上海申花 7-1 云南玉昆 |
| **S2** | **已确认：有两个开球时间字段** | `kickoff_utc`（UTC ISO 8601，如 `2026-10-10T11:35:00Z`）与 `datetime`（**欧洲中部时间**，如 `2026-10-10 13:35:00`）。另有 `date`（仅日期）。**跨源匹配请统一用 `kickoff_utc`** |
| **S3** | **已确认：球队 ID 存在** | `home_id` / `away_id`（如成都蓉城 24583，天津津门虎 24696）。文档示例只给了名称字符串，实际有 ID |
| **S4** | **已确认：没有轮次字段** | 28 个字段中无 `round` / `matchday` / `stage`。**确认无法用它创建比赛，只能核对**。另注意有 `stage: ""` 字段但实测为空字符串 |
| **S5** | **已确认：2000 次/天（用户说的对，文档的 10000 是错的）** | 响应头实测 `X-RateLimit-Limit: 2000`、`X-RateLimit-Remaining: 1999`、`X-RateLimit-Reset: 1791849600`。定价页亦为 "Free — 2,000 requests per day"。**文档页写的 `X-RateLimit-Limit: 10000` 是错的** |
| **S6** | **已确认：免费档带 key 的 REST 查询完全可用** | HTTP 200，返回 212 场完整数据 |
| **S7** | **已确认** | 认证头 `X-Api-Key` 正确。**注意**：默认 Python/curl UA 会被 Cloudflare 拦截（HTTP 403 `error code: 1010`），必须带浏览器 User-Agent |
| **S8** | **已确认：单日全部联赛，无分页** | 2026-10-10 返回 **212 场**，覆盖 **42 个联赛**，响应约 127KB。**顶层无分页字段**（只有 `success` / `date` / `data`）。按 2000 次/天算，单次全量拉取很划算，但也意味着**每次调用都返回全部 42 个联赛，需要本地过滤 `league_id`** |
| **S9** | **已确认（大小写与文档一致）** | 文档：`Scheduled, LIVE, FT, AET, PENS, Postponed, Cancelled, Suspended`。实测（2026-10-10 共 212 场）：`FT` × 209、`Suspended` × 2、`Cancelled` × 1 |
| **S10** | **文档里没写** | 文档未说明 `home_score`/`away_score` 在 `AET`/`PENS` 时是否含加时。结构上有独立的 `penalty_home`/`penalty_away` 和 `winner` 字段可参考，但联赛比赛不会出现，未实测 |
| **S11** | **⚠️ 文档里没写，且找不到条款页面（上线阻塞项）** | 站点无 `/terms`、`/terms-of-service`，首页与定价页**无任何法律/条款链接**。文档只说覆盖来源含 BBC Sports（`urn:bbc:sportsdata:...`）。**必须邮件联系 sportapi.ai 确认免费档能否商用展示比分，否则 `sp` 不能上线** |

---

## 六、跨来源共同问题

### X1 五大联赛同一场比赛的三源对照

以 **Arsenal 2-1 Leeds，2026-10-10 11:30 UTC** 为例：

| 数据源 | 主队写法 | 客队写法 | 球队 ID |
|---|---|---|---|
| `fd` | `Arsenal FC` | `Leeds United FC` | 数字 ID（57 / 341） |
| `of` | `Arsenal` | `Leeds United` | 字符串 ID（`team_arsenal_eng`） |
| `5d` | `Arsenal` | `Leeds` | 数字 ID（`2592538664`） |

**映射结论**：三源写法互不相同（`FC` 后缀、有无简称），但**三源都提供稳定球队 ID**。建议**以 ID 为主键建映射表**，名称仅作人工核对时的辅助，不要用名称模糊匹配作为主路径。

补充样本（同一日 5d 的简称风格）：`Man Utd` / `Tottenham`、`RB Leipzig` / `Eintracht Frankfurt`、`Brighton`、`PSG` / `Le Mans`。

### X2 中超同一场比赛的两源对照

以 **成都蓉城 0-1 天津津门虎，2026-10-10 11:35 UTC** 为例：

| 数据源 | 主队 | 客队 | 球队 ID | 开球时间 |
|---|---|---|---|---|
| `bsd` | `Chengdu Rongcheng` | `Tianjin Jinmen Tiger` | 2029 / 2033 | `2026-10-10T11:35:00+00:00` |
| `sp` | `Chengdu Rongcheng` | `Tianjin Jinmen Tiger` | 24583 / 24696 | `2026-10-10T11:35:00Z` |

第二场（上海申花 7-1 云南玉昆）两源名称与比分完全一致。**两源的中超球队名写法高度一致**，比分口径也一致（7-1 这种大比分两源相同）。开球时间字符串仅时区表示不同（`+00:00` vs `Z`），解析后完全相等。

**映射结论**：中超两源可以直接用球队 ID 建映射，名称仅作校验。跨源时间匹配可直接精确到秒，无需 30 分钟容差。

### X3 延期 / 取消 / 中断的状态写法

| 数据源 | 状态值 | 依据 |
|---|---|---|
| `fd` | 未在本轮数据中遇到 | 文档未列举完整枚举 |
| `bsd` | `cancelled` / `postponed` / `unresolved`（文档列表）+ **实际还有 `notstarted`** | 文档 + 真实响应 |
| `5d` | `unknown` + `status_reason: "result_unconfirmed"` + `status_code` 为数字 | 实测 1 场 |
| `of` | `scheduled` / `live` / `finished` / `postponed` / `cancelled` / `unknown`；中场为 `live` + `period: "HT"` | 文档参数表 |
| `sp` | `Scheduled` / `LIVE` / `FT` / `AET` / `PENS` / `Postponed` / `Cancelled` / `Suspended` | 文档 + 实测（`Suspended` 2 场、`Cancelled` 1 场） |

**跨源映射建议**：`bsd` 与 `of` 语义可直接对应；`sp` 的 `Suspended`（中断）在其他源没有对应值，需要单独决定归入异常；`5d` 的 `unknown` 需结合 `status_reason` 判断。

---

## 七、上线门禁：三个必须先解决的阻塞项

| # | 问题 | 状态 |
|---|---|---|
| 1 | **`fd` 可以商用，多key不违规
| 2 | **`sp` 可以商用，多key不违规
| 3 | **`of` 可以商用，多key不违规 
`bsd` 可以商用，多key不违规 


---

## 八、需要复验的项目

| # | 原因 | 建议时机 |
|---|---|---|
| **D3** | 当前 UTC 07:05 无五大联赛比赛，`status=live` 返回 0 场属正常 | 下个比赛日（欧洲中部时间下午）重测，确认是否返回所有联赛的进行中比赛 |
| **D5** | 文档未说明 `goals` 是否含加时进球 | 找一场杯赛加时赛验证；联赛场景可先按"含加时"保守处理 |
| **S10** | 同上，AET/PENS 比分口径未验证 | 优先级低，联赛不会出现 |
| **B4** | `unresolved` 语义未解释；文档状态列表与实际值不一致 | 邮件问官方 |
| **F10** | 未遇到 `AWARDED` 比赛 | 优先级低 |

---

## 附：响应头速查

| 数据源 | 额度头 |
|---|---|
| `fd` | `x-requests-available-minute`（分钟剩余）、`X-RequestCounter-Reset`（窗口秒数）。429 时 body 为 `{"message":"You reached your request limit. Wait N seconds.","errorCode":429}` |
| `bsd` | `ratelimit: "football";r=7500;t=60479`、`ratelimit-policy: "football";q=7500;w=86400`、`x-cache-status` |
| `5d` | `x-ratelimit-limit: 60`、`x-ratelimit-remaining`、`x-ratelimit-reset`（整点时间戳） |
| `of` | `ratelimit-limit: 5000`、`ratelimit-remaining`、`ratelimit-reset`（秒）、`ratelimit-minute-limit: 60`；**更推荐读 body 里的 `meta.access`**（含 quota/used/remaining/period） |
| `sp` | `X-RateLimit-Limit: 2000`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`（00:00 UTC 重置）；支持 `ETag` / `If-None-Match` → 304 |

## 附：调用配额消耗情况

| 数据源 | 本次消耗 |
|---|---|
| `fd` | 两个 key 各约 10 次（key1 期间触发过一次 429） |
| `bsd` | 约 8 次 |
| `5d` | 约 6 次（剩余额度 60/小时） |
| `of` | 9 次（剩余 4991/5000） |
| `sp` | 4 次（剩余 1996/2000） |
