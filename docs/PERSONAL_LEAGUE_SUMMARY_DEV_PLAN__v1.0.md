# 个人本联赛小结：后端与前端开发计划 v1.0

> 状态：设计与开发合同；本文不代表功能已经实现。
> 来源：[同步可靠性、换季机制与休赛期开发计划 S4 / R9](./SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md#s4小程序休赛期--间歇期体验与时区修正r7-r9-r10)。
> 实施时使用 `subagent-driven-development` 按切片开发，主 agent 独立核验实际结果。

**目标**：在一个联赛的一个赛季确认结束后，展示当前用户在该联赛该赛季的完整预测小结；预测统计包含延期、腰斩等全部场次，精确比分命中单独显示。

**架构**：后端负责收官资格、统计和当前用户身份校验；前端复用比赛页现有收官卡。以预测事实和比赛的联赛/赛季归属查询，不复用跨联赛等级赛季统计，不让前端逐页累加。

**技术栈**：现有 TypeScript 应用层与 API / gateway、AppRepository、PostgreSQL / CloudBase 文档数据库、小程序 JS / WXML / WXSS、Vitest 与 Node 测试。

---

## 1. 本轮确定的需求与边界

1. 联赛结束才有该联赛的个人小结。国际比赛日、冬歇期、普通空比赛日均不能提前展示。
2. 范围固定为 `当前登录用户 + league_id + season_id`，不是六大联赛合并，也不是 `level_season_id`。
3. 预测总场次包含本范围内所有已成功提交的预测，不按比赛状态剔除：包括延期、腰斩、取消、后来恢复或更正的场次。
4. 命中数汇总全部场次的有效结算结果，不按当前比赛状态额外排除延期、腰斩的记录；没有结算结果不能自动视为命中。
5. 精确比分命中单独显示一项，首版即交付。
6. UI 使用现有比赛页收官卡的字体、颜色、间距和按钮，最简单的三个数字即可。
7. 首版包含后端、两种部署的仓储接线、小程序 service / 页面 / 样式、相关测试。本文先冻结合同，代码分片实施。
8. 首版不增加海报、分享、图表、排名、荣誉、长篇文案或历史赛季选择页。小结不修改现有结算规则、积分或等级。

## 2. 当前代码核查与差距

| 现有文件 | 已有能力 | 本功能要补的部分 |
|---|---|---|
| `miniprogram/pages/matches/matches.js` 的 `loadEmptyStateFollowup()` | 空日探测未来 30 / 120 天，构造 `offseasonInfo` | 无未来比赛不能证明收官；改读后端收官资格并加载个人统计 |
| `miniprogram/pages/matches/matches.wxml` | 收官主题、倒计时、切联赛和排行榜按钮 | 无个人统计，补三个数字与局部加载/失败状态 |
| `miniprogram/pages/matches/matches.wxss` | `.offseason-card` 与现有主题变量 | 只增加简单数字行，不新增视觉体系 |
| `src/application/prediction-query.ts` | 自己的预测详情、分页历史 | 历史服务逐条查比赛，且应用层静态赛季校验与换季不完全兼容；不能直接作为小结实现 |
| `src/api/v1/predictions.ts`、`src/gateway/assemble.ts` | 已有认证、校验、响应封装及预测路由 | 新增小结独立 handler 与显式路由 |
| `src/domain/types.ts` | Prediction 有 `wdl_hit`、`exact_hit`、`applied_result_version`；Match 有 `league_id`、`season_id` | 无需给旧预测补冗余联赛字段；按 `match_id` 关联 |
| `src/infrastructure/repositories.ts` | 预测、比赛仓储及内存实现 | 新增小结专用读取端口，避免逐条查比赛 |
| `src/infrastructure/cloudbase-app-repository.ts` | CloudBase 文档仓储；VPS 也可经文档数据库适配器使用 | 补按联赛/赛季与用户限制的批量查询，处理所有分页 |
| `src/infrastructure/cloudbase-db.ts` | 通用 query / count / inFilter 等接口 | 没有原生跨集合 join / aggregate；不能在计划中假定可直接执行数据库 join |

`UserSeasonStats` 按等级赛季聚合，不能据此返回个人本联赛统计。联赛赛季与等级赛季是两套概念。

## 3. 统计口径

### 3.1 三个展示指标

| API 字段 | UI 标签 | 定义 |
|---|---|---|
| `predicted_matches` | 预测场次 | 该用户在目标联赛/赛季全部已提交预测的不同 `match_id` 数量；包含所有比赛状态 |
| `wdl_hits` | 胜平负命中 | 同一集合内当前有效结算事实中 `wdl_hit === true` 的场次数 |
| `exact_hits` | 精确比分命中 | 同一集合内当前有效结算事实中 `exact_hit === true` 的场次数 |

同一比赛同一用户只计一次；重复请求或幂等重放不能增加数量。既有唯一约束仍是数据约束，小结不能把结算账本多个版本当成多个预测。

精确比分命中是胜平负命中的子集：`exact_hits <= wdl_hits <= predicted_matches`。例如显示“胜平负命中 8 场，精确比分命中 2 场”，总命中不是 10 场。

首版只显示场次，不新增命中率。如果后续增加命中率，分母应按本需求使用全部预测场次，包含延期、腰斩等记录，不得静默改成仅已结算场次。

### 3.2 延期、腰斩、撤销与更正

- 比赛延期或腰斩：已提交预测始终进入 `predicted_matches`。有有效结算命中事实时进入对应命中项；无结算时只增加预测总数。
- 比赛取消或结算撤销：预测仍计入总数；撤销后的事实不产生命中，不能沿用失效的旧命中。
- 比赛恢复、补赛、赛果更正：读取当前已应用的预测结算结果，随既有结算链路更新；不在小结服务中按比分重新结算。
- `null` 表示未产生结算值，不作为 true。不能用 truthy 判断或用 `match_score > 0` 代替 `wdl_hit`。
- 后端查询应核对 `applied_result_version` 与比赛当前结算进度；更正尚未完全应用时返回 `is_provisional: true`，前端标注“结算更新中”。不得把更正中的数字标成最终冻结结果。
- 没有任何预测：返回三个 0，UI 显示“你本赛季还没有参与该联赛预测”，不伪装为加载失败。

小结是收官后可更新的事实查询，不是排行榜终榜，不写入 `board_snapshots`，不引入一次生成后永久冻结的副本。

## 4. 联赛结束判定与赛季选择

### 4.1 必须有独立收官依据

禁止以“未来 30 / 120 天没比赛”“最近比赛已完场”“日历跨入下一赛季”“等级赛季冻结”直接判断该联赛结束。数据源请求失败、赛程未同步、长间歇都可能产生同样现象。

当前仓库没有足以直接复用的联赛赛季官方收官事实。首版设计采用**经确认的联赛赛季结束登记**，建议新建 `src/domain/league-season-summary.ts`：

- 按 `league_id + season_id` 登记 `ended_at` 与确认依据 `evidence`（官方公告/赛季页面出处）。
- 后端仅在存在登记且 `server_now >= ended_at` 时开放该赛季小结。`ended_at` 是已确认的实际收官时刻，不是预计最后一轮日期。
- 未登记表示“未确认收官”，不凭空推断。实际登记值须核对一手来源后填写；本计划不编造具体时间。
- 延期、腰斩的历史状态不会自动否定经确认的联赛收官，避免遗留 `postponed` 让小结永远打不开。
- 六个支持联赛使用同一结构。此方式有每季维护登记的成本；后续若已有可靠官方状态同步，可替换登记读取端口，不改变小结 API / UI。

此处是新增的实施方案，不是声称仓库已经存在收官登记或官方状态同步。

### 4.2 查询与默认赛季

- `league_id` 必填，`season_id` 可选。
- 显式指定赛季：校验赛季格式与联赛形态，再检查该联赛赛季是否有收官登记；不使用仅接受静态 `league.season_id` 的历史预测校验函数。
- 不传赛季：后端根据该联赛最近一次已生效的收官登记选出候选赛季。
- 若候选赛季之后已有该联赛新赛季的比赛实际开赛，则默认不再返回旧赛季小结；显式指定已结束赛季仍可查询。
- 新赛季仅发布未来赛程、还未开赛时，可继续展示最近已结束赛季的小结，UI 明示真实赛季。
- 当前赛季未结束、无收官登记、从未收官、或默认旧季已退出展示期：返回 `availability: "not_available"`、`summary: null`。不返回个人中途统计。
- 后端用 `server_now` 判定，不接受客户端传入时间控制开放。

## 5. 后端接口合同

新增 `GET /v1/predictions/summary?league_id=<id>&season_id=<id>`，使用现有可信登录身份。禁止接受 `user_id` 查询他人小结。

正常响应沿用现有 API envelope，以下仅示意 `data` 结构，数字是测试示例：

```json
{
  "league_id": "chinese_super_league",
  "season_id": "2026",
  "availability": "available",
  "ended_at": "<经确认的收官时刻，ISO 8601>",
  "summary": {
    "predicted_matches": 10,
    "wdl_hits": 6,
    "exact_hits": 2,
    "is_provisional": false
  }
}
```

未开放同样返回 200，`availability: "not_available"`、`summary: null`；`season_id` 无候选时为 null，`ended_at` 未确认时为 null。未知联赛、错误赛季格式、未知查询字段按现有约定返回校验错误；未登录和注销用户沿用既有鉴权/账号状态行为。

响应的联赛、赛季、收官时间由后端返回，前端不能用顶部当前赛季名称覆盖真实小结归属。该接口是个人数据，不使用跨用户共享响应缓存。

## 6. 查询方案与两种部署

### 6.1 新增专用仓储读取能力

在 `AppRepository` 增加小结所需的专用查询端口，参数为 `userId / leagueId / seasonId`，返回当前预测结算事实及一致性信息或同等聚合结果。由应用层统一归约口径，内存实现与生产实现结果一致。

首版复用现有文档数据库能力：

1. 在数据库侧按 `league_id + season_id` 查询比赛的必要字段，完整读取所有页。
2. 按命中的 `match_id` 分批，结合 `user_id` 限定查询预测；`inFilter` 可用时使用集合查询。每批大小明确并测试边界。
3. 对数据归约得到三个计数及暂定状态。不能先取用户所有联赛所有年份的预测，再逐条 `matches.findById()`。
4. 不支持集合过滤的适配器，需提供等价的有范围查询；不得在正式实现中静默退化为逐场 N+1。
5. 所有查询都受联赛、赛季和用户范围限制；不能依赖 SDK 默认一页能返回全部数据。

VPS 当前通过 `PostgresDocumentDb` 使用文档仓储，CloudBase 使用 SDK 文档仓储；首版采用两边可用的批量方案，不额外创建仅 PostgreSQL 可用的旁路 API。若改为原生 SQL 聚合，必须同时交付 CloudBase 等价实现与独立一致性测试。

### 6.2 相关文件

- 新增：`src/domain/league-season-summary.ts`，收官登记结构、赛季选择与纯函数。
- 新增：`src/application/personal-league-summary.ts`、对应 `.test.ts`。
- 新增：`src/api/v1/personal-league-summary.ts`、对应 `.test.ts`。
- 修改：`src/infrastructure/repositories.ts`、`src/infrastructure/cloudbase-app-repository.ts`，补读取端口及实现。
- 修改：`src/gateway/assemble.ts`，在已有预测路由相邻位置显式接线；用路由测试确认 summary 不被解释为 prediction ID。
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
[查看本赛季最终排行榜 →]
```

原有排行榜入口与文案沿用现状，小结不声称现有排行榜已能按本联赛过滤。

- 修改 `miniprogram/services/predictions.js`，新增 `getMyLeagueSummary({ leagueId, seasonId })`。
- 修改 `matches.js`：空比赛日探测后调用小结接口，只有 `availability === "available"` 才使用“本赛季已收官”并显示个人统计。未开放时显示普通无比赛/间歇文案，并保留可用的下一比赛日引导。
- 新赛季倒计时仅使用已知属于下一赛季的未来比赛；同赛季补赛不能标成“新赛季揭幕战”。
- 请求仍使用 `requestSerial`，并核对请求时联赛，避免快速切联赛后旧响应覆盖新联赛。开始新请求即清空旧小结。
- `summaryState` 使用 loading / ready / error；加载时显示“正在加载个人小结”，失败显示“小结暂时加载失败，重试”，不以 0 代替错误。
- 若首次资格请求失败，无法确认收官，只显示普通无比赛提示及局部重试；不能保留未经确认的收官标题。
- 无参与时保留收官信息，统计区显示无参与文案；存在预测时三项全显示，0 命中也应显示 0。
- `is_provisional === true` 时加一行“结算更新中”，不增加弹窗。
- `matches.wxml / matches.wxss` 只增加一行三列布局或窄屏换行，复用现有 theme tokens，不做新页面、图片或动画。
- 页面重新进入、下拉刷新或局部重试重新读取，不做永久本地缓存。

## 8. 开发切片与验收命令

### P1：收官资格与统计纯函数

先写失败测试：未结束不开放、登记时间边界、长间歇不误判、换季仍能定位刚结束赛季、下一季已开赛默认隐藏、显式查旧季仍有效、延期腰斩计入总数、精确命中不重复加总。

实现 `league-season-summary.ts` 与统计类型；用固定 `server_now` 测试，不依赖机器当前日期。单独提交。

### P2：仓储与应用层

先写内存/文档仓储相同 fixture 的失败测试，再补专用批量读取端口、`PersonalLeagueSummaryService` 与用户状态检查。测试超过一页、超过一批、跨用户/联赛/赛季、空集合、撤销、更正及未结算记录。单独提交。

### P3：API 与 gateway

先补 handler 和 route 的失败测试，随后实现参数校验、身份注入、响应封装与接线。VPS HTTP 与 CloudBase 入口都经真实 gateway 测试；不能只测直接调用应用层。单独提交。

### P4：小程序完整接线

先补 `matches.offseason.test.mjs` 与 service 测试，再实现三数字 UI、请求生命周期及局部重试。覆盖不开放、0 参与、0 命中、部分未结算、接口失败、快速切联赛和跨赛季。单独提交。

### P5：独立复核与文档回填

按实际新增文件运行相关测试；下面是计划命令，尚未执行，不代表通过：

```bash
npm run typecheck
npx vitest run src/domain/league-season-summary.test.ts src/application/personal-league-summary.test.ts src/api/v1/personal-league-summary.test.ts
node --test miniprogram/pages/matches/matches.offseason.test.mjs
```

仓储、gateway 和 service 测试以实际落地的文件名补入验收记录。无需因本功能重跑所有无关测试；涉及双部署打包时检查 TypeScript 构建配置包含新模块。

UI 至少检查窄屏布局、三个数字、0 值、精确命中标签、加载/失败/重试；真实微信开发者工具未执行时如实标记。部署前按项目要求 build，再对真实已确认结束赛季及进行中赛季分别做受控 HTTP 验证；本计划不授权立即重启服务。

## 9. 必须通过的业务样例

以下都是人工测试 fixture，不是生产统计：

- 同一用户同一联赛同一赛季有 10 场预测，其中 6 场有效胜平负命中、2 场精确命中；总数 10 / 6 / 2，不把精确命中另加到胜平负。
- 其中延期、腰斩各一场且未结算：总数仍为 10，不能从分母或总数删除，也不能凭状态增加命中。
- 延期/腰斩场次后来产生有效结算：按结算事实增加命中；若结算撤销，则读取撤销后的命中值。
- 另一用户、另一联赛和同联赛另一赛季的预测，全部不混入。
- 已完赛但无官方确认收官依据、未来 30 天无比赛、同步接口失败：均不能开放小结。
- 确认收官后仍有历史遗留 postponed：小结可开放，预测仍计入。
- 新赛季未来赛程已发布但尚未开赛：显示刚结束赛季；新赛季实际开赛后默认退出旧季小结。
- 更正任务部分完成：标记结算更新中；任务完成后刷新恢复正式统计，不要求重建小结快照。

## 10. 完成标准与回滚

- [ ] 收官确认来源已核对并登记，未使用空赛程推断。
- [ ] 所有统计口径、两种部署仓储和 API 接线的相关测试通过。
- [ ] 页面实际调用后端，三个指标均来自同一联赛/赛季的个人事实。
- [ ] 最简单 UI 与现有风格一致；加载/错误不冒充 0 值。
- [ ] 补入实际执行命令、测试结果及人工检查范围，不预填“通过”。
- [ ] 原开发计划保留入口，详细规则仅在本文维护。

切片按 P1–P4 独立提交，回滚按依赖反序。首版不修改历史预测、不回填命中、不改变结算结果；若新增索引需单独记录迁移与回滚。本文件当前仅为设计，以上条目尚未验收。
