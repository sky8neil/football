# 同步可靠性、换季机制与休赛期体验开发计划 v1.0

> 依据需求文档：[SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md](./SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md)
> 创建日期：2026-11-15
> 开发原则：**所有代码改造与本地/受控测试全部完成后，再统一构建、启 `football-jobs.timer` 并重启 VPS 服务**，实现一次性可长期稳定运行的版本。

---

## 0. 开发切片总览（按依赖顺序）

| 切片 | 覆盖需求 | 核心目标 | 涉及主要文件 |
|---|---|---|---|
| **S1** | R2 | 实时窗口收敛 + 按联赛独立计算查询日期 | `src/application/provider-active-window.ts`, `src/infrastructure/active-window-query.ts`, `src/application/provider-window-loader.ts` |
| **S2** | R3 | OpenFoot (`of`) 按实际待核对日期查询 + 去重 + 对账预留额度 | `src/application/provider-window-loader.ts`, `src/provider/registry.ts`, `src/provider/budget.ts`, `src/application/provider-reconcile.ts` |
| **S3** | R4, R5, R6 | 联赛多赛季自动切换 + 升班马未映射告警 + 中超 `of` 第二核对源配置（含 **S3b** 收官双通道核验、常规赛隔离与元数据落库） | `src/domain/config.ts`, `src/domain/league-season-summary.ts`, `src/provider/sources.ts`, `src/provider/football-data-adapter.ts`, `src/application/provider-full-schedule.ts`, `src/application/provider-cross-source.ts`, `src/scripts/` |
| **S4** | R7, R9, R10 | 小程序首页 `Asia/Shanghai` 日期对齐 + 空态文案 + 休赛期收官卡/下一比赛日跳转 + 默认联赛与休赛角标（含 **S4c** 后端状态机 `GET /v1/leagues/status` 替换前端盲测） | `src/application/league-status.ts`, `src/api/v1/leagues-status.ts`, `miniprogram/pages/matches/matches.js`, `miniprogram/pages/matches/matches.wxml`, `miniprogram/utils/matches-default-league.js`, `miniprogram/services/matches.js` |
| **S5** | R11 | 排行榜新赛季零数据期默认展示上一赛季终榜 | `miniprogram/pages/rankings/rankings.js`, `miniprogram/utils/rankings-view-model.js`, `src/application/ranking-query-service.ts`（如需） |
| **S6** | R1, R8 | 上线前门禁配置（`RANKING_FIRST_PERIOD_KEY`、调度频率确认）、全量验证与 VPS 一次性上线切换 | `src/domain/config.ts`, `ops/vps/football-jobs.timer`, VPS `football_dev` & systemd |

---

## 1. 切片详细设计

### S1：实时窗口收敛与按联赛独立日期查询（R2）

1. **实时窗口增加后置截止上限（`live_match`）**：
   - 文件：[provider-active-window.ts](file:///home/football/src/application/provider-active-window.ts)、[active-window-query.ts](file:///home/football/src/infrastructure/active-window-query.ts)
   - 改动：
     - 将 `activeWindow` 中 `live_match` 条件由无限期覆盖 `scheduled` 改为：`match_status === Live` **或**（`match_status === Scheduled && kickoff <= now + 2h && kickoff >= now - 6h`）。
     - `buildActiveWindowFilters("live_match")` 同步补充/配合筛选，确保超过开球 6 小时仍为 `scheduled` 的异常滞留场次退出高频 `live_match`，交给每日 `full_schedule_verify` 处理。
     - 对超过 6 小时仍挂 `scheduled` 的场次记录告警日志（复用现有诊断/异常日志口径）。
2. **按联赛独立计算 `dateFrom` / `dateTo`**：
   - 文件：[provider-window-loader.ts](file:///home/football/src/application/provider-window-loader.ts)
   - 改动：
     - 移除全局共用的 `earliestKickoffMs`（当前所有联赛共用同一个 `from`）。
     - 在 `for (const leagueId of orderedIds)` 循环内，基于当前联赛的 `leagueMatches` 单独计算 `leagueEarliestKickoffMs`，再得出该联赛自己的 `from` / `to`，避免中超等单一联赛的滞留场次拖累五大联赛。
3. **验证**：
   - 补充单测覆盖：开球超 6 小时 `scheduled` 场次不进入 `live_match`；某联赛含 3 个月前滞留场次时，另一联赛查询 `dateFrom` 不受污染。

---

### S2：OpenFoot (`of`) 额度精细化控制（R3）

1. **`post_finish_verify` 仅查询实际存在待核对比赛的日期**：
   - 文件：[provider-window-loader.ts](file:///home/football/src/application/provider-window-loader.ts)、[registry.ts](file:///home/football/src/provider/registry.ts)、[openfoot-adapter.ts](file:///home/football/src/provider/openfoot-adapter.ts)
   - 现状：`fetchFixturesByDateRange` 会把 `from..to` 每一天都展开成 1 次 `of` 请求（每次通常 3 天 = 3 次请求）。
   - 改动：
     - 针对 `post_finish_verify`，收集当前联赛候选比赛实际涉及的 `kickoff_at` 日期集合（含跨零点完场的 `+1` 日必要窗口），去重后仅请求这些有比赛的日期，避免空日无效消耗额度。
2. **已双源核对一致的场次跳过重复 `of` 查询**：
   - 文件：[provider-window-loader.ts](file:///home/football/src/application/provider-window-loader.ts) / [provider-fixture-sync.ts](file:///home/football/src/application/provider-fixture-sync.ts)
   - 改动：在筛选 `post_finish_verify` 副源比较候选时，若场次已有双源一致的完场观测或已进入终态，不再重复触发副源请求。
3. **为每日 `provider_reconcile` 预留额度**：
   - 文件：[budget.ts](file:///home/football/src/provider/budget.ts)、[provider-reconcile.ts](file:///home/football/src/application/provider-reconcile.ts)
   - 现状：`provider_reconcile` 内部复用 `jobType: SyncJobType.FullScheduleVerify`（`PRIORITY_SHARE` 为 `0.5`），与 `post_finish_verify`（`1.0`）共享同一日桶，高频任务很容易把 50% 以上的日额度先耗尽导致对账被拒。
   - 改动：为 `of` 的日预算引入对账预留机制（或给 `post_finish_verify` 等窗口任务设置日上限比例 `<= 0.85`，保留 `>= 0.15` 给每日 `provider_reconcile`），并在单测中验证在日额度接近上限时 `provider_reconcile` 仍可拿到预留额度。

---

### S3：换季自动切换、升班马告警与中超第二源（R4, R5, R6）

1. **联赛赛季边界与自动切换**：
   - 文件：[config.ts](file:///home/football/src/domain/config.ts)
   - 改动：
     - 为每个联赛引入带起止时间窗口的赛季列表（当前赛季 + 下一赛季，例如中超 `2026` 与 `2027`，五大联赛 `2026_2027` 与 `2027_2028`），提供 `activeLeagueSeason(leagueId, now)` 解析当前生效的 `season_id` 与 `provider_season_refs`。
     - 保持 `leagueSeasonBounds`、`isKickoffInLeagueSeason` 向后兼容，同时确保到换季时间自动切换，不再需要人工改代码发版。
2. **升班马未映射明确告警**：
   - 文件：[provider-cross-source.ts](file:///home/football/src/application/provider-cross-source.ts)
   - 改动：当 `of`（或 `bsd`/`sp`）因 `homeTeamProviderId` / `awayTeamProviderId` 在 `team_src_map` 中未找到映射而返回 `unlinked` 时，记录带 `league_id`、`provider`、`provider_team_id`、`team_name` 的结构化告警日志（每轮去重，避免刷屏），方便运营按清单补齐映射与小程序队徽。
3. **中超第二核对源启用 `of`（并完成 16 队映射准备）**：
   - 文件：[sources.ts](file:///home/football/src/provider/sources.ts)
   - 改动：确认中超 `of` 的 `result` 角色切换策略（若立即启用为 `secondary`，需同步确认并导入 16 支中超球队的 `openfoot` 映射；若当前中超已处于休赛期且 2026 仅 `bsd` 历史赛程，可在导入 16 支中超映射后一并切换为 `secondary`）。
   - 配套补充：文档中明确“换季两步检查清单”（跑 `providers:map-teams` 导入升班马 + 补小程序 `logo-registry`）。
4. **S3b：赛季收官自动核验、换季锚点修正与新赛季低频试探（架构升级，解决原 R4/R9 边界缺陷）**：
   - **换季默认锚点与物理边界统一调整**（[config.ts](file:///home/football/src/domain/config.ts)）：
     - 将 `activeLeagueSeason` / `deriveSeasonId` 切换锚点及 `seasonBounds` 一起调整为：**中超 UTC 2 月 15 日**（`[02-15, 次年02-15)`，兼容跨年 1 月初补赛）、**五大联赛 UTC 7 月 15 日**（`[07-15, 次年08-10)` 留宽容错）；写库与校验兼容换季前提前试探入库的 `nextSeasonId`，并同步更新 `config.test.ts`。
     - 为 `SUPPORTED_LEAGUES` 补充常规赛理论唯一主客对阵常量 `expected_matches`（英超/西甲/意甲 `380`、德甲/法甲 `306`、中超 `240`）。
   - **常规赛隔离与赛季元数据免费落库**（[football-data-adapter.ts](file:///home/football/src/provider/football-data-adapter.ts)）：
     - 与 [bsd-adapter.ts](file:///home/football/src/provider/bsd-adapter.ts)（已过滤 `stage === "regular-season"`）对齐，在 `FootballDataAdapter` 仅采集 `match.stage === "REGULAR_SEASON"` 场次，排除德甲/法甲/意甲附加赛干扰。
     - 在 `fetchSeasonFixtures` 时顺带提取响应体自带的 `season.startDate`、`season.endDate`、`season.currentMatchday`，写入轻量集合 `league_season_meta`（零额外 API 额度；中超 `bsd` 无顶层 `endDate` 时允许为 `null`，回退 `max(kickoff_at)`），用于覆盖度核验与超期 14 天未收官告警。
   - **赛季收官双通道判定**（[league-season-summary.ts](file:///home/football/src/domain/league-season-summary.ts)，详细规则见 [PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md](./PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md#4-联赛结束判定四态模型与赛季选择)）：
     - **通道 A（自动结构化完赛核验）**：唯一 `(home_team_id, away_team_id)` 对阵槽位严格等于 `expected_matches`（不强校验各家格式不一的 `round_id`）；全部槽位均至少有 1 场 `finished` 且具备有效完场比分（兼容旧 `postponed` 影子记录 + 新 `finished` 补赛）；无 `live` 或未来 `scheduled`；末轮开球冷却满 6 小时；所有 `finished` 场次均已完成首次结算。
     - **通道 B（显式人工兜底 `LEAGUE_SEASON_CLOSURE_OVERRIDES`）**：仅用于不可抗力场次永久取消/腰斩不补赛的极端情况。
   - **事件驱动试探新赛季**（[provider-full-schedule.ts](file:///home/football/src/application/provider-full-schedule.ts)）：
     - 当某联赛当前赛季已收官且进入换季前窗口（中超 1 月起、五大联赛 6 月起）时，每日 `full_schedule_verify` 附带 1 次低频尝试拉取下一赛季赛程；未公布则静默跳过不报异常，一旦官方公布即自动入库并进入 `pre_season` 倒计时。

---

### S4：小程序休赛期 / 间歇期体验与时区修正（R7, R9, R10）

> **R9 个人本联赛小结及后端状态机升级已独立拆分**：完整后端 + 前端开发合同见 [个人本联赛小结开发计划 v1.0](./PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md)。该项不再按下文“若可获取”作为可选内容，也不再由前端探测 30/120 天盲猜收官：
> 1. 仅在后端确认赛季收官（自动核验或显式兜底）后展示“本赛季已收官”及个人三项小结；
> 2. 冬歇期（长短不一，如德甲 3 周、英超无冬歇）与高频国际比赛日（如合并后的 16 天 FIFA 窗口、欧国联窗口）统一由后端四态模型（`in_season_active` / `in_season_break` / `pre_season` / `off_season`）识别并下发精确 `next_match_at`；
> 3. 收官判定、四态模型、接口契约、双部署仓储、页面接线与验收均在独立文档维护，本段为开发入口。

1. **日期条统一按 `Asia/Shanghai` 计算 & 文案修正（R7）**：
   - 文件：[matches.js](file:///home/football/miniprogram/pages/matches/matches.js)、[matches.wxml](file:///home/football/miniprogram/pages/matches/matches.wxml)
   - 改动：
     - `buildDates(anchor)` 改用 `beijingParts()` 生成日期键和“今天/明天/周X”标签，与 `dayBounds(key)` 的 `+08:00` 查询区间完全一致。
     - 将空态文案“下拉看看别的日期”改为“点选上方日期或切换其他联赛看看”。
2. **默认联赛升级 & 休赛角标（R10 -> S4c 后端直出）**：
   - 文件：[matches-default-league.js](file:///home/football/miniprogram/utils/matches-default-league.js)、[matches.js](file:///home/football/miniprogram/pages/matches/matches.js)、[matches.wxml](file:///home/football/miniprogram/pages/matches/matches.wxml)
   - 现状与升级：
     - 现有初版通过前端循环调用 `listMatches` 探测 6 个联赛近期 7~21 天窗口；
     - **S4c 升级目标**：改为一次调用后端 `GET /v1/leagues/status`（后端 5~10 分钟缓存），按 `phase === "in_season_active"` > `in_season_break`（按 `next_match_at` 最近）> `premier_league` 选中默认联赛，并对 `is_offseason === true`（`off_season` / `pre_season`）的联赛展示“休赛”角标，避免把国际比赛日或德甲冬歇误标为“休赛”。
3. **比赛页休赛期收官卡 & 下一比赛日快捷跳转（R9 -> S4c 后端直出）**：
   - 文件：[matches.js](file:///home/football/miniprogram/pages/matches/matches.js)、[matches.wxml](file:///home/football/miniprogram/pages/matches/matches.wxml)、[matches.wxss](file:///home/football/miniprogram/pages/matches/matches.wxss)、[predictions.js](file:///home/football/miniprogram/services/predictions.js)、[matches.js(service)](file:///home/football/miniprogram/services/matches.js)
   - 现状与升级：
     - 现有初版在 `loadEmptyStateFollowup()` 中探测未来 30 / 120 天无比赛即进入 `offseason`；
     - **S4c 升级目标**：废除前端 30 / 120 天探测，改为读取 `GET /v1/leagues/status` + `GET /v1/predictions/summary`：
       1. **`in_season_active` / `in_season_break`（赛季中某天无比赛、冬歇期或国际比赛日）**：显示当日无比赛提示 + **【跳到下一轮比赛日：MM月DD日（周X）→】**（直接使用后端返回的精确 `next_match_at` 与 `days_until_next_match`）。
       2. **`off_season` / `pre_season`（且后端确认 `availability === "available"`）**：展示【本赛季已收官】主题卡片（刚收官赛季文案、`pre_season` 时附带新赛季揭幕战倒计时、个人本联赛 3 项小结），并提供 **【去看看正在进行的 XX 联赛 →】** 和 **【查看本赛季最终排行榜 →】** 按钮；新赛季首战开球前保留上季收官卡，开球后自动退场。

---

### S5：排行榜休赛期默认展示上赛季终榜（R11）

- 文件：[rankings.js](file:///home/football/miniprogram/pages/rankings/rankings.js)、[rankings-view-model.js](file:///home/football/miniprogram/utils/rankings-view-model.js)
- 改动：
  - 在 `board === "season"` 且用户未手动指定 `selectedLevelSeasonId` 时：如果当前新赛季返回的榜单条目数 `items.length === 0` 且 `available_level_seasons` 中存在上一赛季，前端自动回退加载并高亮显示上一赛季（例如 `2026_2027` 最终封榜），同时保留顶部赛季切换器允许用户切回新赛季。
  - 补充对应 view-model 单元测试。

---

### S6：上线前门禁配置、存量数据修复与一次性部署切换（R1, R8）

> **全部在 S1–S5 代码开发并完成全量测试后统一执行**：

1. **门禁配置确认（R8）**：
   - 将 [config.ts](file:///home/football/src/domain/config.ts) 中的 `RANKING_FIRST_PERIOD_KEY` 更新为正式上线周（由你最终确认具体周次，如 `2026-W47`）。
   - 与你确认 `ops/vps/football-jobs.timer`（`/etc/systemd/system/football-jobs.timer`）最终触发间隔（保持 15 分钟或调整为 3~5 分钟）。
2. **全量构建与测试**：
   - `tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.build.json`、`tsc -p tsconfig.cloudfunction.json`
   - 全量 `vitest run`（含新增的 S1–S5 单测与小程序端 `.test.mjs` 测试）
3. **VPS 存量数据恢复与服务一次性开启（R1）**：
   - 在 VPS 上确认并清理中超/实时异常历史状态后，执行受控 `node dist/jobs/tick.js`，验证中超 240 场转为完场/待结算且 `live_match` 恢复 `ok`。
   - 开启并启动 `football-jobs.timer`，重启 `football-gateway.service` / `football-gateway-bridge.service` 使所有服务加载最新构建与 `/etc/football/gateway.env`。

---

## 2. 需在开工前或 S6 前与你确认的 3 个业务参数

1. **中超 `of` 球队映射（16 队）**：*（注：当前分支已于 `3a339dd` 完成中超 `of` 启用为 `secondary`，上线前核对日志无 `[team_mapping_missing]` 即可。）*
2. **上线周 `RANKING_FIRST_PERIOD_KEY`**：正式上线时从哪一周开始记为第一周（当前占位 `2026-W31`）？
3. **定时任务频率**：`football-jobs.timer` 保持每 **15 分钟**一次，还是在上线时改为每 **3~5 分钟**一次以配合实时比分更新？
