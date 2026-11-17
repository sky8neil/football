# 个人本联赛小结：后端与前端开发计划 v1.0

> **开发执行约束（优先于本文其他表述）**：只关心功能性问题；忽略安全性、防御性问题；不进行过度开发；不尝试做未经授权的测试工作。

> 状态：待实施，纳入**第二批**；第一批前置为比赛逻辑身份归并、数据源/竞技赛季分层及 `season_teams` 落库。
> 来源：[同步可靠性、换季机制与休赛期开发计划 S4 / R9](./SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md#s4小程序休赛期--间歇期体验与时区修正r7-r9-r10)。
> 实施时使用 `subagent-driven-development` 按切片开发，主 agent 独立核验实际结果。

**目标**：在一个联赛的一个赛季确认结束后，展示当前用户在该联赛该赛季的完整预测小结；预测统计包含延期、腰斩等全部场次，精确比分命中单独显示；同时由后端统一提供联赛实时阶段（正常周 / 间歇期 / 赛前 / 休赛期）与收官资格，彻底消除前端盲测误差。

**架构**：后端基于常规赛双循环唯一对阵槽位自动核验赛季收官（辅以极端情况人工兜底登记）并计算联赛四态状态机，前端直接消费 `GET /v1/leagues/status` 与 `GET /v1/predictions/summary` 复用比赛页收官卡。以预测事实和比赛的联赛/赛季归属查询，不复用跨联赛等级赛季统计，不让前端逐页累加或跨 30/120 天盲猜。

**技术栈**：现有 TypeScript 应用层与 API / gateway、AppRepository、PostgreSQL / CloudBase 文档数据库、小程序 JS / WXML / WXSS、Vitest 与 Node 测试。

---

## 1. 本轮确定的需求与边界

1. 竞技赛季确认收官后才有该联赛的个人小结。国际比赛日、冬歇期、普通空比赛日或同步滞后均属于 `break` / `in_season`，不能提前展示收官与小结。
2. 范围固定为 `当前登录用户 + league_id + 竞技 season_id`，不是六大联赛合并，也不是 `level_season_id`。
3. 预测总场次按**逻辑比赛（`canonical_match_id`）**去重计数，包含本范围内所有已成功提交的预测，不按比赛状态剔除：包括延期、腰斩、取消、后来恢复或更正的场次。
4. 命中数汇总全部逻辑比赛的有效结算结果，不按当前比赛状态额外排除延期、腰斩的记录；没有结算结果不能自动视为命中。
5. 精确比分命中单独显示一项，首版即交付。
6. UI 使用现有比赛页收官卡的字体、颜色、间距和按钮，最简单的三个数字即可。
7. 首版包含后端（含竞技赛季与参赛名单表结构及迁移）、两种部署的仓储接线、统一联赛阶段接口、小程序 service / 页面 / 样式、相关测试。按 §8 分片实施。
8. 首版不增加海报、分享、图表、排名、荣誉、长篇文案或历史赛季选择页。小结不修改现有结算规则、积分或等级。

## 2. 当前代码核查与差距

| 现有文件 / 规划能力 | 已有能力 | 本功能要补的部分 |
|---|---|---|
| `src/domain/config.ts` | 支持联赛基础定义与 UTC 赛季推导（当前仍按 `01-01 / 07-01` 切换） | 补 `expected_matches`（380/306/240）；`activeLeagueSeason` 与 `seasonBounds` 一起改为中超 `02-15`（`[02-15, 次年02-15)`）、五大联赛 `07-15`（`[07-15, 次年08-10)` 留宽容错） |
| `src/provider/football-data-adapter.ts` | 拉取五大联赛赛程；`bsd-adapter.ts` 已过滤 `regular-season` | 过滤 `match.stage === "REGULAR_SEASON"` 排除附加赛；`fetchSeasonFixtures` 时顺带落库 `season.startDate / endDate / currentMatchday` |
| `src/application/provider-full-schedule.ts` | 每日全量赛程核对与写库 | 赛季收官后进入换季窗时低频试探下季赛程；超 `endDate + 14d` 未收官告警 |
| `miniprogram/pages/matches/matches.js` 的 `loadEmptyStateFollowup()` | 空日探测未来 30 / 120 天，构造 `offseasonInfo` | 废除前端 30 / 120 天盲测；改读 `GET /v1/leagues/status` 与 `GET /v1/predictions/summary` |
| `miniprogram/utils/matches-default-league.js` | 循环请求 `listMatches` 探测 6 个联赛 | 改为单次读取 `GET /v1/leagues/status` 确定默认联赛与顶部“休赛”角标 |
| `miniprogram/pages/matches/matches.wxml` | 收官主题、倒计时、切联赛和排行榜按钮 | 无个人统计，补三个数字与局部加载/失败状态 |
| `miniprogram/pages/matches/matches.wxss` | `.offseason-card` 与现有主题变量 | 只增加简单数字行，不新增视觉体系 |
| `src/application/prediction-query.ts` | 自己的预测详情、分页历史 | 历史服务逐条查比赛，且应用层静态赛季校验与换季不完全兼容；不能直接作为小结实现 |
| `src/api/v1/predictions.ts`、`src/gateway/assemble.ts` | 已有认证、校验、响应封装及预测路由 | 新增小结与联赛状态独立 handler 及显式路由 |
| `src/domain/types.ts` | Prediction 有 `wdl_hit`、`exact_hit`、`applied_result_version`；Match 有 `league_id`、`season_id` | 无需给旧预测补冗余联赛字段；按 `match_id` 关联；新增 `LeagueSeasonMeta` 轻量元数据文档 |
| `src/infrastructure/repositories.ts` | 预测、比赛仓储及内存实现 | 新增小结专用读取端口、联赛收官/状态所需的比赛轻量读取端口及 `league_season_meta` 仓储 |
| `src/infrastructure/cloudbase-app-repository.ts` | CloudBase 文档仓储；VPS 也可经文档数据库适配器使用 | 补按联赛/赛季与用户限制的批量查询，处理所有分页 |
| `src/infrastructure/cloudbase-db.ts` | 通用 query / count / inFilter 等接口 | 没有原生跨集合 join / aggregate；不能在计划中假定可直接执行数据库 join |

`UserSeasonStats` 按等级赛季聚合，不能据此返回个人本联赛统计。联赛竞技赛季与等级赛季是两套概念。

## 3. 统计口径

### 3.1 三个展示指标

| API 字段 | UI 标签 | 定义 |
|---|---|---|
| `predicted_matches` | 预测场次 | 该用户在目标联赛/竞技赛季全部已提交预测的不同**逻辑比赛（`canonical_match_id`）**数量；包含所有比赛状态 |
| `wdl_hits` | 胜平负命中 | 同一逻辑比赛集合内当前有效结算事实中 `wdl_hit === true` 的逻辑场次数 |
| `exact_hits` | 精确比分命中 | 同一逻辑比赛集合内当前有效结算事实中 `exact_hit === true` 的逻辑场次数 |

同一用户对同一逻辑比赛只允许提交一次预测，唯一业务键为 `(user_id, canonical_match_id)`；改期或更换 `match_id` 不新增预测资格。幂等重放返回原结果，新的重复提交拒绝，不新建预测。此约束在第一批总计划 S0 的提交链路与仓储中落实，不能仅靠小结查询去重。小结只读取该逻辑比赛唯一有效预测及其已应用结算结果，不把账本多个版本当成多个预测。

精确比分命中是胜平负命中的子集：`exact_hits <= wdl_hits <= predicted_matches`。例如显示“胜平负命中 8 场，精确比分命中 2 场”，总命中不是 10 场。

首版只显示场次，不增加命中率。

### 3.2 改期合并、延期、腰斩、撤销与更正

- **改期记录合并与逻辑身份（`canonical_match_id`）**：
  - 身份建立、改期归并与取代指针按 [总计划 S0](./SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md#s0比赛逻辑身份归并第一批前置) 实施；本节定义归并后的预测统计与历史预测处置。
  - 赛程完整性核验与个人预测统计均按 `canonical_match_id` 聚合；同一用户旧、新记录属于同一预测资格，禁止重复提交。逻辑身份确定后保持稳定，来源 ID 或有效记录变更不重新分配。
  - S0 必须同时覆盖新增来源 ID 的赛程发现与已有来源映射解析：确认同场则关联已有身份；旧记录已被取代时更新到达有效记录；多候选/证据冲突不自动归并。当前双循环联赛的同主客队条件仅用于查候选，不能当通用赛制唯一键，不能只凭 `finished` 状态认定有效记录。
  - 旧文档缺身份字段由 `document-codec.ts` 读取兼容，不会因此把整季比赛合并为一场；上线物理回填仅补缺失字段、保留已确认身份，预测使用关联比赛的逻辑身份。存量预览、备份、确认后执行及回滚统一按总计划 S6，不在小结服务里临时修数据。
  - **历史旧记录预测处置闭环**：上线前核查中超 2026 现有 6 条 `postponed` 旧记录上是否存在用户预测：
    - 若**无预测**：仅写入 `superseded_by` / `canonical_match_id` 归并关联，不改写历史预测表与结算事实。
    - 若**存在唯一预测**：在上线切换前执行受控迁移，将旧记录上的预测关联到同一逻辑比赛，并确保正常结算链路能应用对应有效比赛的赛果；不产生第二份预测或重复计分。
    - 若发现同一用户同一逻辑比赛有**存量重复预测**：作为历史数据冲突列入人工复核，上线前确定唯一有效预测并完成必要的结算对账；保留处置依据，不自动选最早、最新、任一命中或最好结果，也不拼接两份预测的命中。冲突未处理完毕前不得将该迁移标为完成或发布受影响小结。
  - 若存在身份尚未确认的重复记录（既无共同外部 ID 也未人工/规则确认归并），不能忽略放行，对应竞技赛季保持 `open`。
- 比赛延期或腰斩：已提交预测始终进入 `predicted_matches`。有有效结算命中事实时进入对应命中项；无结算时只增加预测总数。
- 比赛取消或结算撤销：预测仍计入总数；撤销后的事实不产生命中，不能沿用失效的旧命中。
- 比赛恢复、补赛、赛果更正：读取对应逻辑比赛当前已应用的预测结算结果，随既有结算链路更新；不在小结服务中按比分重新结算。
- `null` 表示未产生结算值，不作为 true。不能用 truthy 判断或用 `match_score > 0` 代替 `wdl_hit`。
- 后端查询应核对逻辑比赛当前结算进度与预测 `applied_result_version`；更正尚未完全应用时返回 `is_provisional: true`，前端标注“结算更新中”。不得把更正中的数字标成最终冻结结果。
- 没有任何预测：返回三个 0，UI 显示“你本赛季还没有参与该联赛预测”，不伪装为加载失败。

小结是收官后可更新的事实查询，不是排行榜终榜，不写入 `board_snapshots`，不引入一次生成后永久冻结的副本。

## 4. 联赛结束判定、四态模型与赛季选择

### 4.1 常规赛隔离、理论场次常量与赛季元数据

禁止以“未来 30 / 120 天没比赛”“最近比赛已完场”“日历跨入下一赛季”“等级赛季冻结”“提前产生夺冠球队”直接判断该联赛结束。冬歇期（各联赛长短不一，如德甲约 3 周、英超无冬歇）、FIFA 新赛历高频长间歇（如合并后的 16 天国际窗口及欧国联窗口）、数据源故障或新赛程未同步都会导致长空窗。

为实现后端自动且可靠的判定，需先补齐三项基础能力：

1. **常规赛隔离（排除附加赛干扰）**：
   - `bsd-adapter.ts` 已过滤 `event.stage === "regular-season"`。
   - `football-data-adapter.ts` 补齐过滤，仅采集 `match.stage === "REGULAR_SEASON"`（排除德甲 `RELEGATION`、法甲/意甲潜在 `PLAYOFFS` 等附加赛）。六个联赛的常规赛边界由此完全统一为**严格双循环**。
2. **常规赛唯一主客对阵总量配置（`src/domain/config.ts`）**：
   - 在 `SUPPORTED_LEAGUES` 增加 `expected_matches`：英超 `380`（38 轮）、西甲 `380`（38 轮）、意甲 `380`（38 轮）、德甲 `306`（34 轮）、法甲 `306`（34 轮）、中超 `240`（30 轮）。
3. **赛季元数据免费落库（`league_season_meta`）**：
   - 在 `football-data` 调用 `fetchSeasonFixtures` 时提取响应体自带的 `season.startDate`、`season.endDate`、`season.currentMatchday`，持久化为 `LeagueSeasonMeta`（不额外消耗 API 额度）。
   - 中超主源 `bsd` 接口无顶层 `season.endDate`，`LeagueSeasonMeta.endDate` 允许为 `null`。
   - 用于赛程覆盖度核验及超期巡检告警（若 `server_now > (endDate ?? max(该赛季库内比赛 kickoff_at)) + 14 天` 仍未通过收官判定，触发运维告警排查漏同步或未处理的永久取消场次）。

### 4.2 赛季收官双通道判定（`src/domain/league-season-summary.ts`）

判定 `(league_id, season_id)` 是否已收官（`is_ended === true`），采用**“自动结构化完赛核验（通道 A）+ 显式收官登记兜底（通道 B）”**双保险。**通道 B 命中优先放行；否则必须完整通过通道 A 全部 4 个条件。**

#### 通道 A：自动结构化完赛核验（99% 正常赛季自动触发，无需人工介入）
1. **唯一主客对阵槽位 100% 齐备**：
   - 过滤常规赛后，库内该 `(league_id, season_id)` 去重后的 `(home_team_id, away_team_id)` 有序对数量**严格等于 `expected_matches`**（380 / 306 / 240）。不强依赖不同数据源格式不统一的 `round_id` 字符串匹配。
   - *拦截：数据源漏同步、半截赛程、开季初期未同步完，或异常混入非本季场次导致超过理论场次。*
2. **全部对阵槽位均已产生终态结果（解决延期补赛与旧记录残留痛点）**：
   - 按 `(home_team_id, away_team_id)` 槽位聚合，**全部 `expected_matches` 个槽位下均至少有 1 场状态为 `finished`（且有有效完场比分）的比赛**；
   - 同时，该赛季内**不存在任何 `live` 比赛**，也**不存在任何 `kickoff_at > server_now` 的 `scheduled` 待开赛记录**。
   - *说明：若某场延期后数据源新建了补赛记录并已 `finished`，旧记录仍残留 `postponed` 时，该主客槽位已有 `finished` 记录，不阻塞收官；若补赛尚未踢完，槽位无 `finished`，严格拦截。*
3. **末轮冷却期已过**：
   - `server_now >= max(该赛季所有 finished 比赛的 kickoff_at) + 6 小时`。
4. **首次结算无滞留**：
   - 该赛季所有 `finished` 场次均不存在 `settlement_status === "unsettled"`（确保个人小结统计完整；若存在更正重算任务进行中，仍可判定收官并在响应中标 `is_provisional: true`）。

#### 通道 B：显式收官登记兜底（`LEAGUE_SEASON_CLOSURE_OVERRIDES`）
- 针对 1% 极端情况（例如某场因不可抗力被足协永久取消 `cancelled` 或腰斩 `abandoned` 且官方裁定不再补赛，导致差 1 场永远凑不满 `expected_matches` 个 `finished` 槽位）：
- 按 `league_id + season_id` 登记 `{ ended_at, evidence }`（如 `{ league_id, season_id, ended_at, evidence }`）。
- 仅当 `server_now >= ended_at` 时生效放行。

### 4.3 联赛四态模型与换季平滑过渡

后端基于“收官判定 + 本地球季 `scheduled`/`live` 赛程分布”，统一为每个联赛计算当前阶段 `phase`（可做 5~10 分钟服务端缓存）：

| `phase` | 判定条件 | 展示赛季 (`display_season_id`) 与前端行为 |
|---|---|---|
| `in_season_active` | 活跃赛季未收官，且未来 7 天内存在 `scheduled` / `live` 比赛 | 当前活跃赛季；正常赛程流，空日提示跳至后端返回的 `next_match_at` |
| `in_season_break` | 活跃赛季未收官，未来 7 天内无比赛，但库内后续存在 `scheduled` 比赛（覆盖冬歇期、合并国际比赛窗口、欧国联窗口） | 当前活跃赛季；**禁止展示收官**；直接显示 `next_match_at` 与精确倒计时 |
| `off_season` | 最近赛季已确认收官，且下一赛季赛程尚未入库 | 刚收官的上一赛季；展示【本赛季已收官】+ 个人小结，顶部联赛栏带“休赛”角标 |
| `pre_season` | 上赛季已收官，下一赛季赛程已入库但首场比赛尚未开球（`min(nextSeason.kickoff_at) > server_now`） | **仍默认指向刚收官的上一赛季**；展示收官卡与个人小结，底部附带新赛季揭幕战倒计时；首战开球即刻切入 `in_season_active` |

换季锚点与新赛季自动探测规则：
- **日历锚点与物理边界统一修正（`src/domain/config.ts`）**：`activeLeagueSeason` / `deriveSeasonId` 默认切换边界调整为**中超 UTC 2 月 15 日**、**五大联赛 UTC 7 月 15 日**；同步调整 `seasonBounds`（中超 `[YYYY-02-15, (YYYY+1)-02-15)` 兼容类似 2021 跨年 1 月初补赛；五大联赛 `[YYYY-07-15, (YYYY+1)-08-10)` 留宽容错兼容极端延期）。同步更新 `config.test.ts`。
- **事件驱动新赛季低频试探（`src/application/provider-full-schedule.ts`）**：当某联赛当前赛季已 `off_season` 且进入换季窗口（中超 1 月起、五大联赛 6 月起）时，每日 `full_schedule_verify` 附带 1 次低频尝试拉取下一赛季赛程；未公布时静默跳过不报异常，一旦官方公布即自动入库（写库与校验兼容提前入库的 `nextSeasonId`，不报 `season_mismatch`）并进入 `pre_season`。

### 4.4 查询与默认赛季

**先选竞技赛季，再判阶段**：不得将已公布赛程但尚未实际开赛的新季直接当作进行中赛季。最近展示季已收官、下一季尚未实际开赛时，按下一季是否公布赛程优先返回 `completed` / `between_seasons`；新季实际开赛后，才以新季为当前赛季判定 `in_season` / `break`。旧季因补录重开时，不再展示其收官卡；若下一季已开赛，页面仍以新季为当前赛季，旧季独立继续恢复与收官核验。没有已收官展示季时，使用最近已实际开赛的竞技赛季；尚无任何已开赛季时，以最近已公布赛程的竞技赛季判定，未同步出赛程则为 `break`、`active_season_id: null`。

“实际开赛”以当前有效逻辑比赛已有 `live`、已完场或可信来源记录的实际开赛事实为准，不能仅凭计划开球时间已到就认定新季开赛。`live` 单独判断，不受未来开球时间下界限制；所有判定排除 `superseded_by != null` 的旧记录。

小结查询规则（`GET /v1/predictions/summary`）：
- `league_id` 必填，`season_id` 可选。
- 显式指定赛季：校验赛季格式与联赛形态，再按 4.2 检验该 `(league_id, season_id)` 是否确认收官；不使用仅接受静态 `league.season_id` 的历史预测校验函数。
- 不传赛季：后端自动选出当前 `display_season_id`（优先最近已确认收官且新赛季尚未开球的赛季）。
- 若候选赛季之后已有该联赛新赛季的比赛实际开赛（`min(nextSeason.kickoff_at) <= server_now`），则默认不再返回旧赛季小结；显式指定已结束赛季仍可查询。
- 当前赛季未结束、或默认旧季已退出展示期：返回 `availability: "not_available"`、`summary: null`。不返回个人中途统计。
- 后端用 `server_now` 判定，不接受客户端传入时间控制开放。

## 5. 后端接口合同

### 5.1 个人本联赛小结接口

新增 `GET /v1/predictions/summary?league_id=<id>&season_id=<id>`，使用现有可信登录身份。禁止接受 `user_id` 查询他人小结。

正常响应沿用现有 API envelope，以下仅示意 `data` 结构，数字是测试示例：

```json
{
  "league_id": "chinese_super_league",
  "season_id": "2026",
  "availability": "available",
  "ended_at": "<收官时刻，ISO 8601>",
  "closure_source": "auto_verified",
  "summary": {
    "predicted_matches": 10,
    "wdl_hits": 6,
    "exact_hits": 2,
    "is_provisional": false
  }
}
```

未开放同样返回 200，`availability: "not_available"`、`summary: null`、`closure_source: null`；`season_id` 无候选时为 null，`ended_at` 未确认时为 null。未知联赛、错误赛季格式、未知查询字段按现有约定返回校验错误；未登录和注销用户沿用既有鉴权/账号状态行为。

响应的联赛、赛季、收官确认时间与实际结束时间由后端返回，前端不能用顶部当前赛季名称覆盖真实小结归属。该接口是个人数据，不使用跨用户共享响应缓存。

### 5.2 联赛实时状态接口（公开只读，供比赛页默认联赛/休赛角标/空日引导）

新增 `GET /v1/leagues/status`（沿用现有公开接口限流与响应 envelope，服务端可按 5~10 分钟 TTL 缓存，不涉及个人数据），一次性返回全部 6 个支持联赛的当前阶段：

```json
{
  "server_now": "2026-11-16T06:00:00.000Z",
  "items": [
    {
      "league_id": "chinese_super_league",
      "phase": "off_season",
      "active_season_id": "2026",
      "is_offseason": true,
      "next_match_at": null,
      "days_until_next_match": null,
      "closure": {
        "is_ended": true,
        "ended_at": "2026-11-08T13:30:00.000Z",
        "source": "auto_verified"
      }
    }
  ]
}
```

- `days_until_next_match` 基于 `Asia/Shanghai` 自然日差计算（`next_match_at` 所在北京时间日期减当前北京时间日期）。
- `in_season_break` / `in_season_active` 时，`closure.is_ended` 必须为 `false`，`is_offseason` 为 `false`。

## 6. 查询方案与两种部署

### 6.1 新增专用仓储读取能力

在 `AppRepository` 增加小结与收官状态所需的专用查询端口，由应用层统一归约口径，内存实现与生产实现结果一致：

1. **个人小结查询端口**（`userId / leagueId / seasonId`）：
   - 在数据库侧按 `league_id + season_id` 查询比赛的必要字段，完整读取所有页。
   - 按命中的 `match_id` 分批，结合 `user_id` 限定查询预测；`inFilter` 可用时使用集合查询。每批大小明确并测试边界。
   - 对数据归约得到三个计数及暂定状态。不能先取用户所有联赛所有年份的预测，再逐条 `matches.findById()`。
   - 不支持集合过滤的适配器，需提供等价的有范围查询；不得在正式实现中静默退化为逐场 N+1。
2. **联赛收官与四态状态计算读取端口**（`leagueId / seasonIds`）：
   - 读取目标联赛相关赛季（`[currentSeasonId, previousSeasonId]` 及可选下一赛季）的比赛轻量投影字段（`match_id`, `season_id`, `round_id`, `home_team_id`, `away_team_id`, `kickoff_at`, `match_status`, `settlement_status`, `regular_home_score`, `regular_away_score`），完整读完所有页（单联赛单赛季最多 380 条，轻量投影开销极低）。
   - 同时提供 `LeagueSeasonMetaRepository`（`findByLeagueAndSeason` / `upsert`），持久化 `football-data` 同步时提取的 `startDate`、`endDate`、`currentMatchday`。
   - `LeagueStatusService` 在服务端对 `GET /v1/leagues/status` 做 5~10 分钟内存 TTL 缓存（写入新赛果或全量赛程同步完成时主动失效或自然过期），避免高频读取数据库。

所有查询都受联赛、赛季和用户范围限制；不能依赖 SDK 默认一页能返回全部数据。同时需核对 PostgreSQL（`postgres-schema.ts`）与 CloudBase `matches` 集合是否具备 `(league_id, season_id)` 复合索引，避免高频查询或状态刷新产生全表扫描与额外资源点消耗。VPS 当前通过 `PostgresDocumentDb` 使用文档仓储，CloudBase 使用 SDK 文档仓储；首版采用两边可用的批量方案，不额外创建仅 PostgreSQL 可用的旁路 API。若改为原生 SQL 聚合，必须同时交付 CloudBase 等价实现与独立一致性测试。

### 6.2 相关文件与 Schema 迁移

- 修改：`src/domain/config.ts`，新增 `expected_matches`，调整中超 UTC `02-15` / 五大联赛 UTC `07-15` 换季边界。
- 修改：`src/domain/types.ts`、`src/schema/collections.ts`，补充 `LeagueSeasonMeta` 文档类型。
- 修改：`src/provider/football-data-adapter.ts`、`src/application/provider-full-schedule.ts`，过滤 `REGULAR_SEASON`、落库 `LeagueSeasonMeta`、事件驱动低频试探下季赛程与超期告警。
- 新增：`src/domain/league-season-summary.ts`，唯一对阵槽位自动核验、显式登记兜底、四态模型 `phase`、展示赛季选择与统计归约纯函数。
- 新增：`src/application/league-status.ts`、`src/application/personal-league-summary.ts` 及对应 `.test.ts`。
- 新增：`src/api/v1/leagues-status.ts`、`src/api/v1/personal-league-summary.ts` 及对应 `.test.ts`。
- 修改：`src/infrastructure/repositories.ts`、`src/infrastructure/cloudbase-app-repository.ts`，补读取端口及 `LeagueSeasonMetaRepository` 实现。
- 修改：`src/gateway/assemble.ts`，显式接线 `GET /v1/leagues/status` 与 `GET /v1/predictions/summary`；用路由测试确认 `summary` 不被解释为 prediction ID，`status` 路由正确分发。
- 按实际需要修改：`src/infrastructure/postgres-document-db.ts`、`src/infrastructure/cloudbase-wx-db.ts`、`src/infrastructure/postgres-schema.ts`、`src/infrastructure/schema-migration.ts`，只在现有查询能力/索引确有缺口时调整。
- 测试：内存仓储、文档仓储、两种网关入口行为，覆盖批量/分页与跨环境一致性。

## 7. 最简单的前端 UI 与加载流程

位置：比赛页现有 `.offseason-card` 内，收官标题后、倒计时与操作按钮前。

```text
本赛季已收官
2026 赛季 · 中超

我的本联赛小结
预测场次        胜平负命中        精确比分命中
  10               6                 2

新赛季赛程公布后将第一时间开放预测
[去看看正在进行的 XX 联赛 →]
[查看等级赛季排行榜 →]
```

排行榜入口为通用等级赛季榜导航，不建立竞技赛季与等级赛季的一对一映射，不按本联赛过滤。默认等级赛季、无数据回退与封榜展示统一按 [总计划 S5](./SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md#s5排行榜休赛期默认展示上赛季终榜r11第二批落地) 执行。

- 新增 `miniprogram/services/leagues.js`（或在 `miniprogram/services/matches.js` 扩展）调用 `GET /v1/leagues/status`；修改 `miniprogram/utils/matches-default-league.js`，使用 `/v1/leagues/status` 确定默认联赛（优先 `in_season_active` > `in_season_break` > `premier_league`）与顶部 `is_offseason` “休赛”角标，废除前端 6 联赛循环 `listMatches` 探测。
- 修改 `miniprogram/services/predictions.js`，新增 `getMyLeagueSummary({ leagueId, seasonId })`。
- 修改 `matches.js`：废除 `loadEmptyStateFollowup()` 内的 30 / 120 天窗口探测；当选中日无比赛时，结合 `/v1/leagues/status` 中该联赛状态：
  - 若 `phase` 为 `in_season_active` 或 `in_season_break`（周中空档、冬歇期、国际比赛日/欧国联窗口），显示普通无比赛提示 + 快捷按钮【跳到下一轮比赛日：MM月DD日（周X）→】（数据直接取后端 `next_match_at` 与 `days_until_next_match`）；
  - 若 `phase` 为 `off_season` 或 `pre_season`，再调用 `getMyLeagueSummary`，**仅当 `availability === "available"`** 时展示“本赛季已收官”并显示个人统计；`pre_season` 时基于后端 `next_match_at` 展示“距离新赛季揭幕战还有 X 天”。
- 请求仍使用 `requestSerial`，并核对请求时联赛，避免快速切联赛后旧响应覆盖新联赛。开始新请求即清空旧小结。
- `summaryState` 使用 loading / ready / error；加载时显示“正在加载个人小结”，失败显示“小结暂时加载失败，重试”，不以 0 代替错误。
- 若状态或资格请求失败，无法确认收官，只显示普通无比赛提示及局部重试；不能保留未经确认的收官标题。
- 无参与时保留收官信息，统计区显示无参与文案；存在预测时三项全显示，0 命中也应显示 0。
- `is_provisional === true` 时加一行“结算更新中”，不增加弹窗。
- `matches.wxml / matches.wxss` 只增加一行三列布局或窄屏换行，复用现有 theme tokens，不做新页面、图片或动画。
- 页面重新进入、下拉刷新或局部重试重新读取，不做永久本地缓存。

## 8. 开发切片与验收命令

### P1：配置、适配器常规赛隔离与收官/四态纯函数

先写失败测试：
- `config.ts`：`expected_matches` 配置、中超 UTC `02-15` / 五大联赛 UTC `07-15` 换季边界；
- `football-data-adapter.ts`：过滤非 `REGULAR_SEASON` 场次（排除 `RELEGATION`/`PLAYOFFS`）、提取 `season` 元数据；
- `league-season-summary.ts`：唯一 `(home, away)` 槽位未满不开放、末轮已完赛但前面轮次未补赛不开放、旧 `postponed` + 新补赛 `finished` 同对阵自动放行、冷却 6h 与结算校验、人工兜底登记时间边界、16 天国际窗口/3 周冬歇期判定为 `in_season_break`、换季仍定位刚结束赛季、`pre_season` 未开球保留上季、下一季已开赛默认隐藏、显式查旧季仍有效、延期腰斩计入预测总数、精确命中不重复加总。

实现 `config.ts`、`football-data-adapter.ts`、`league-season-summary.ts` 与相关类型；用固定 `server_now` 测试，不依赖机器当前日期。单独提交。

### P2：仓储、新赛季低频试探与应用层

先写内存/文档仓储相同 fixture 的失败测试，再补：
- `MatchRepository` 轻量批量读取端口、`LeagueSeasonMetaRepository`；
- `ProviderFullScheduleVerifyService` 落库 `LeagueSeasonMeta`、超 `endDate + 14d` 告警、收官后低频试探下季赛程（未公布静默跳过）；
- `LeagueStatusService`（含 5~10 分钟服务端缓存）与 `PersonalLeagueSummaryService`（含用户状态检查）。

测试超过一页、超过一批、跨用户/联赛/赛季、空集合、撤销、更正及未结算记录。单独提交。

### P3：API 与 gateway

先补 `leagues-status` 和 `personal-league-summary` handler 与 route 的失败测试，随后实现参数校验、身份注入、响应封装与接线。VPS HTTP 与 CloudBase 入口都经真实 gateway 测试；确认 `/v1/predictions/summary` 不被解释为 prediction ID，`/v1/leagues/status` 正常返回 6 联赛四态。单独提交。

### P4：小程序完整接线

先补 `matches.offseason.test.mjs`、`matches-default-league` 与 service 测试，再废除前端 30/120 天盲测，实现 `/v1/leagues/status` 驱动默认联赛/休赛角标/下一比赛日引导，以及收官卡三数字 UI、请求生命周期与局部重试。覆盖 `in_season_break`（16 天长间歇不误判收官）、`pre_season` 倒计时、`off_season`、0 参与、0 命中、部分未结算、接口失败、快速切联赛和跨赛季。单独提交。

### P5：独立复核与文档回填

先完成总计划 S0 的持续归并链路与 S3c 目标赛季贯穿，再按 S6 生成并确认存量迁移预览、执行备份与迁移；不得用一次性清理替代持续归并。各部署分别核查身份字段、取代关系和预测，不预填生产行数或验收结果。

独立验收至少覆盖：旧数据解码后身份正确；新增来源 ID 不产生第二次预测资格；旧来源更新到达有效记录；已有唯一预测可正常结算；重复预测冲突先复核；迁移重复执行无新增修改；换季后旧季补赛首次发现仍归旧季。中超归并后由正常维护任务核验完整性及终态、决定是否收官，不直接写收官状态。

`RANKING_FIRST_PERIOD_KEY` 最后由用户单独决定，当前不改值，不作为本节代码开发、身份迁移或小结验收的捆绑决策。

按实际新增文件运行相关测试；下面是计划命令，尚未执行，不代表通过：

```bash
npm run typecheck
npx vitest run src/domain/league-season-summary.test.ts src/application/league-status.test.ts src/application/personal-league-summary.test.ts src/api/v1/leagues-status.test.ts src/api/v1/personal-league-summary.test.ts
node --test miniprogram/pages/matches/matches.offseason.test.mjs
```

仓储、gateway、adapter 和 service 测试以实际落地的文件名补入验收记录。无需因本功能重跑所有无关测试；涉及双部署打包时检查 TypeScript 构建配置包含新模块。

UI 至少检查窄屏布局、三个数字、0 值、精确命中标签、加载/失败/重试；真实微信开发者工具未执行时如实标记。部署前按项目要求 build，再对真实已确认结束赛季（如 2026 中超）及进行中/间歇期赛季（如五大联赛）分别做受控 HTTP 验证；本计划不授权立即重启服务。

## 9. 必须通过的业务样例

以下都是人工测试 fixture，不是生产统计：

- 同一用户同一联赛同一竞技赛季有 10 场不同逻辑比赛预测，其中 6 场有效胜平负命中、2 场精确命中；总数 10 / 6 / 2，不把精确命中另加到胜平负。
- 同一用户已在改期前旧记录提交预测，再对改期后新记录提交：因属于同一 `canonical_match_id` 拒绝重复提交；同一幂等请求重放返回原预测，最终只保留一份有效预测及结算。历史重复数据须先按 §3.2 人工复核处理，不作为正常允许场景。
- 其中延期、腰斩各一场且未结算：总数仍为 10，不能从分母或总数删除，也不能凭状态增加命中。
- 延期/腰斩场次后来产生有效结算：按结算事实增加命中；若结算撤销，则读取撤销后的命中值。
- 另一用户、另一联赛和同联赛另一赛季的预测，全部不混入。
- 赛季中处于 16 天国际比赛窗口 / 欧国联窗口或 3 周冬歇期（未来 20 天无比赛）：`phase` 判定为 `in_season_break`，返回精确 `next_match_at`，绝不开放收官与小结。
- 数据同步中断仅入库前 25 轮（槽位数 `< expected_matches`），或末轮踢完但第 29 轮尚有延期补赛未踢：均不能自动开放收官与小结。
- 补赛已另建记录并完场，旧记录仍残留 `postponed`：同 `(home, away)` 槽位已有 `finished` 且满额、冷却满 6h 且无未结算场次，正常自动收官，旧记录上的预测仍计入 `predicted_matches`。
- 德甲/法甲包含 `RELEGATION`/`PLAYOFFS` 附加赛数据：适配器过滤后不影响 306 场常规赛判定。
- 某场比赛永久取消且不补赛：未在 `LEAGUE_SEASON_CLOSURE_OVERRIDES` 登记前不自动开放；登记且 `server_now >= ended_at` 后正常开放小结。
- 新赛季未来赛程已发布但尚未开赛（`pre_season`）：继续显示刚结束赛季的收官卡与小结，并附带揭幕战倒计时；新赛季实际开赛后默认退出旧季小结。
- 更正任务部分完成：标记结算更新中；任务完成后刷新恢复正式统计，不要求重建小结快照。

## 10. 完成标准与回滚

- [ ] 常规赛过滤（`REGULAR_SEASON` / `regular-season`）、`expected_matches` 常量、自动完赛核验与人工兜底双通道已落地，未使用空赛程推断收官。
- [ ] `GET /v1/leagues/status` 正确区分四态并输出 `next_match_at`，前端已移除 30/120 天窗口盲测。
- [ ] 所有统计口径、两种部署仓储和 API 接线的相关测试通过。
- [ ] 页面仅消费后端四阶段状态与小结接口，默认请求不传数据源日历赛季；排行榜跳转使用通用等级赛季榜入口。
- [ ] 最简单 UI 与现有风格一致；加载/错误不冒充 0 值。
- [ ] 补入实际执行命令、测试结果及人工检查范围，不预填“通过”。
- [ ] 总计划保留入口；收官、小结与阶段接口规则在本文维护，待确认参数已明确。

切片按 P0–P4 独立提交，回滚按依赖反序。首版不擅自删除历史比赛或更改正常结算事实；对新增表/集合、索引与必要的旧改期记录预测迁移均单独记录迁移与回滚方案。

---

## 11. 验收记录（P5 独立复核）

本节记录 2026-11-17 在 `feat/resource-point-opt` 分支上的实际执行结果，命令与输出均为当次真实产出。

### 11.1 执行命令与结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 退出 0 |
| `npx tsc -p tsconfig.build.json --noEmit` | 退出 0 |
| `npx tsc -p tsconfig.cloudfunction.json --noEmit` | 退出 0 |
| `npx tsc -p tsconfig.cloudfunction.json --noEmit --listFiles` | 传递引入 `league-season-status.ts`、`league-season-summary.ts`、`league-season-maintenance.ts`、`league-status-service.ts`、`personal-league-summary-service.ts`、`api/v1/league-status.ts`、`api/v1/personal-league-summary.ts`，CloudBase 入口打包覆盖新模块 |
| `npx vitest run`（全量） | 231 文件通过 / 6 跳过；2254 项通过 / 23 跳过 |

> 更正：§P5 原计划命令 `node --test miniprogram/pages/matches/matches.offseason.test.mjs` 不成立 —— 该文件从 `vitest` 导入 `describe/it/expect`，`node --test` 会因 “Vitest failed to access its internal state” 直接失败。正确命令为 `npx vitest run miniprogram/pages/matches/matches.offseason.test.mjs`（14 项通过）。

### 11.2 业务验收项与证据

| 验收项 | 证据 | 结果 |
|---|---|---|
| 旧数据解码后身份正确 | `src/infrastructure/document-codec.test.ts:120`「历史 Match 与 Prediction 读取时补逻辑身份默认值」，该文件 9 项通过 | 通过 |
| 新增来源 ID 不产生第二次预测资格 | `src/application/predictions.test.ts:138`「同一 `canonical_match_id` 的不同比赛记录只能提交一份预测」、`:157`「归并前已提交的预测仍阻止新记录重复预测」，该文件 27 项通过 | 通过 |
| 旧来源更新到达有效记录 | `src/application/provider-status-sync.test.ts:222`「旧来源 ID 的状态更新落到有效记录」，该文件 30 项通过；`src/application/match-identity.test.ts` 覆盖一跳/三跳取代解析 | 通过 |
| 已有唯一预测可正常结算 | `src/application/settlement-item-application-service.test.ts`（14 项）含 §15.2「首次 0 -> v3 真实 apply：prediction applied_result_version=3」 | 通过 |
| 重复预测冲突先复核 | `src/application/match-identity-migration.test.ts:40`「reviews duplicate predictions without choosing either update」、`:58` 入向取代无法安全重定向时列入复核；`src/domain/league-season-summary.test.ts:75`「blocks duplicate predictions instead of combining or selecting hits」 | 通过 |
| 迁移重复执行无新增修改 | `src/application/match-identity-migration.test.ts:50`「is idempotent after applying the plan in memory」；生产库执行后重跑 `--dry-run` 得 `match_updates 0 / prediction_updates 0 / review 0` | 通过 |
| 换季后旧季补赛首次发现仍归旧季 | `src/application/provider-schedule-sync.test.ts:56`「跨年补赛发现时归入目标赛季且不写入参赛名单」、`:75`「来源未返回赛季时发现记录使用显式目标季」 | 通过 |
| 中超归并后由维护任务核验并自行收官 | 见 §11.4，未手工写入 `completed` | 通过 |

### 11.3 VPS PostgreSQL 核验（schema `football_dev`）

```
matches 总数            1998
含 canonical_match_id   1998（100%）
superseded_by 非空         6
predictions                0
```

### 11.4 中超 2026 收官链路

维护任务（`leagueSeasons.run`）实际输出：

```json
{"event":"league_season_transition","league_id":"chinese_super_league","season_id":"2026","from":"open","to":"completed"}
{"event":"league_season_maintenance_result","seasons_checked":6,"completed":1,"reopened":0}
```

库侧落值：`schedule_status = locked`、`completion_status = completed`、`completion_confirmed_at = 2026-11-17T03:35:10.465Z`、`reopen_count = 0`。中超 2026 比赛 246 条，其中 240 条为有效记录、6 条改期旧记录 `superseded_by` 已指向有效记录。

### 11.5 未完成 / 未验证项（如实标记）

1. **CloudBase 部署未核验（用户 2026-11-17 决策：待定）**：本机缺少 CloudBase 凭据文件，双部署一致性、`uk_user_canonical_match` 索引创建状态仍待发布前在真实环境确认。
2. **真实微信开发者工具未执行**：窄屏布局、三个数字、0 值文案、精确命中标签、加载/失败/重试与等级赛季排行榜入口的实际渲染未人工确认。
3. **登录态 HTTP 验证未执行**：`/v1/predictions/summary` 需要登录身份，当前库 `users = 0`、`predictions = 0`，只能靠单测覆盖；`/v1/leagues/status` 的游客路径已做真实 HTTP 验证（200，6 联赛，中超 `completed`）。
4. **`RANKING_FIRST_PERIOD_KEY`** 仍为占位 `2026-W31`；用户 2026-11-17 决策：**等小程序正式发布后再定**，取发布所在周。
5. `season_teams` 历史 112 行的 `source` 仍为旧值 `schedule`，数值本身正确，待下一轮 `future_schedule` 由 `team-sync` 以 `map_teams` 重写。
