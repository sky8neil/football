# 小程序识别、理解与数据展示整改开发文档 v1.0

- 日期：2026-11-17。
- 对应需求：[MINIPROGRAM_UX_REQUIREMENTS__v1.0.md](MINIPROGRAM_UX_REQUIREMENTS__v1.0.md)。
- 基线：`01fee09`。本文件是可逐项执行的开发方案，以下“新增”“修改”“测试”均为后续实施任务，并非本次已完成项。
- 本次交付范围：需求和开发文档；不修改业务代码、不写数据库、不构建上线、不跑会产生预测或造数的 E2E。

## 1. 实施约束

1. 按“切片 → 独立复核真实执行结果 → 提交”推进。改代码前记录工作区、备份受影响内容、检查运行任务，先跑相关已有测试建立基线。
2. 工作区已有未跟踪的 `scripts/fb-final.mjs`、`scripts/fb-snap.mjs`、`scripts/fb-test-maintain.mjs`，不是本次文档产物；不得覆盖、清理或顺手提交。
3. 当前 VPS 的 `dist/` 是线上服务产物；`npm run build` 会写该目录。后续测试使用隔离检出目录或临时输出目录，不把构建当无副作用检查。本次不执行构建。`vps:db`、部分 preflight/admin/jobs 命令也先构建，不能直接作为只读验证入口。
4. 不新增预测、修改线上等级、重排线上榜单或修复测试库来“验证文档”。需要异常数据和多账号测试时使用隔离数据集；如后续确需修复真实数据，另列可审阅的计划与备份、dry-run、回滚内容。
5. 业务字段、供应商原名、ID 和规则不因 UI 中文化而被改写；不引入运行时模型翻译服务。
6. 四项暂缓事项 `DEFER-01` 至 `DEFER-04` 不进入本轮实施。定向领域错误用例和接口分页用例分别不等于完成断网专项与滚动到底专项。

## 2. 已核对的调用链与事实

| 主题 | 当前事实 | 代码位置 |
|---|---|---|
| 比赛展示 | 比赛查询返回 `home_team/away_team` 的 `team_id` 与 `name`；页面直接使用英文原名 | `src/application/match-query.ts`；`miniprogram/pages/matches/matches.js`；`miniprogram/pages/match-detail/match-detail.js` |
| 队徽 | `getTeamLogo` 基于原名归一化及 slug 查表；简单替换 `name` 为中文可能失配 | `miniprogram/utils/logo-registry.js`；源清单 `docs/design/assets/logos/manifest.json` |
| 历史预测缺资料 | `PredictionHistoryItem` 有球队 ID，但无球队对象；前端按 89 天窗口调用比赛列表，每窗口只取 100 场，不消费下一页 cursor | `src/application/prediction-query.ts`；`miniprogram/pages/my-predictions/my-predictions.js` |
| 八周口径 | ~~`hasReachedEightWeekHistory` 按开球时间判断是否到边界~~ **已于 2026-11-18 删除**：该函数只用于自动续页，随文案修正一并移除；页面改为只取第一页，由用户点“加载更多” | `miniprogram/utils/prediction-history.js`；`miniprogram/pages/my-predictions/my-predictions.js` |
| 最近预测与缓存 | 我的页另查比赛详情；设置和我的页存取 `team_name:<id>` 与 `team_logo:<id>`；旧英文缓存可继续被展示 | `miniprogram/pages/profile/profile.js`；`miniprogram/pages/settings/settings.js` |
| 等级来源 | 页面使用 profile 的等级与 levels 的 `career.b_points`；后者是上次评估时保存的 B 分，按对应 scope 累计，不受表现窗口截断；`is_rated`/`remaining_to_rated` 只说明定级场次 | `src/application/levels.ts`；`miniprogram/pages/profile/profile.js` |
| 领域错误 | `assertLevelState` 通过 `internalError(message)` 抛 `DomainError(INTERNAL_ERROR)`；HTTP 映射直接返回原始 `message/details` | `src/domain/invariants.ts`；`src/domain/errors.ts`；`src/api/v1/validation.ts` |
| 解锁 | 纯决策按 `career_points` 累计门槛发放，不依赖“某次预测命中”，不删除历史解锁 | `src/application/unlock-decision.ts`；`src/application/unlock-persistence.ts`；`src/domain/config.ts` 的 `UNLOCK_CONFIG_V1` |
| 历史赛季 | 页面已有 `userChangedSeason`、`previousAvailableSeason`、赛季选择处理和历史赛季转全站逻辑 | `miniprogram/pages/rankings/rankings.js`；`miniprogram/pages/rankings/rankings.season-fallback.test.mjs` |
| 排名 | 实力榜比较原始分子/分母的交叉乘积，再比窗口场次、用户 ID；不是按显示的两位小数排序 | `src/domain/ranking.ts`；`src/domain/levels.ts` |

特别纠正原报告的两个实施建议：

- 不采用“按积分门槛推导等级”。升级还依赖表现、周评估和单次最多一级，前端只改解释。
- 不把断言问题仅当作 `SPEC_GAP` 映射。本次已定位的断言实际是 `INTERNAL_ERROR`；要修真实映射路径并核对 HTTP/云函数共同入口。

## 3. 切片一：球队身份与完整对阵（UX-01，DATA-01 的前置）

### 3.1 盘点与确认

1. 以需求附录 A 的 112 支球队原名为首轮盘点，重新读取实际 `team_id`，记录 `league_id + team_id + source_name + name_zh + logo_key`。
2. 补盘点全部历史比赛引用的球队、喜爱球队引用以及球队存量数据。不能只扫描未来赛程，也不能以当前联赛队徽列表代替历史全集。
3. 所有英文球队名逐队联网搜索中国大陆网站实际使用的简体中文名；两个不同网站使用同一名称即定稿，不用大模型翻译或自行音译。需求附录 A 已完成 112 队首轮定名，证据见 `docs/TEAM_NAME_EVIDENCE__v1.0.md`；实施时按 `league_id + team_id` 回填球队 ID 并复核证据仍有效。历史球队、二队/青年队与后续新增球队按同一规则补取证，未达两站一致的写回附录 B。`Paris FC` 定名「巴黎FC」为用户拍板的破例，不改成纯中文；队徽短名另核身份。
4. 对“同名不同队”“同队不同英文拼法”“历史更名”保留身份边界；不要用字符串包含关系把不同 ID 合并。

### 3.2 具体方案

优先采用小程序统一展示注册表，不改变供应商原名或既有比赛 API 的 `name` 含义，避免为这次 UI 需求迁移数据库：

- 新增 `miniprogram/utils/team-registry.js`：以联赛及球队 ID 为稳定键，保存中文名与已确认的队徽 key；这是计划新增文件。
- 新增 `miniprogram/utils/team-presentation.js`：集中输出 `nameZh`、队徽路径、资料是否缺失。所有页面复用，不在 WXML 或各页面各写翻译表。
- `logo-registry.js` 优先使用已确认 ID 对应的队徽 key，再兼容保留的原名逻辑。展示中文名不能反过来作为英文队徽查找输入。
- 页面模型保留原 `team`，另提供 `homeName/awayName` 等中文展示字段。WXML 只绑定展示字段。
- ID 缺失或未知时显示“球队资料待补全”，记录联赛、球队、比赛 ID 进入待核清单；已知球队不能通过此提示蒙混验收。
- 不因翻译显示而更换球队 ID、重写比赛、修改喜爱球队保存值或调用供应商映射写入工具。

覆盖页面：`matches`、`match-detail`、`my-predictions`、`profile`、`settings`。还须静态检查其余 WXML/JS 中直接绑定 `team.name` 的位置；队名是否出现以代码为准，不凭页面名推断。

### 3.3 缓存与布局

- `team_name:<id>` 旧英文缓存读取后必须经过统一展示层，优先按 ID 解析中文；不能等用户清空缓存才生效。
- `team_logo:<id>` 保留兼容，必要时用注册表修正已证实的错误关联。避免清空整个本地存储而影响登录态。
- 设置搜索以中文展示名为主；可兼容原名作为搜索别名，但结果只显示中文；保存仍提交 `favorite_team_id`。
- 我的页已有喜爱球队 ID 时先查注册表，不依赖未来赛程恰好包含该队。清缓存和历史球队都要验证。
- 默认参考尺寸下两队中文名完整可辨；通过换行、队名区域宽度与行高解决，不用缩成无法辨认的省略号。保持主客队顺序，不能交换位置来适配长名。

### 3.4 验证

- 注册表测试与人工证据复核：每条有稳定 ID、两个以上不同大陆网站使用同一简体中文名的可追溯证据（`AC米兰`、`巴黎FC` 为已批准破例）；其余中文名无拉丁字母；无误合并；队徽 key 可用；实际覆盖数据无未知身份或未取证定稿。
- 页面测试：拜仁慕尼黑、门兴格拉德巴赫、托特纳姆热刺等较长中文名；中文名相似球队；预测前后、详情和历史页同队同名同徽。
- 运行既有 `profile.team-logo.test.mjs`，补旧英文缓存、清缓存、历史喜爱球队场景。
- 实际核对队徽图片内容，`logos:check` 只证明资源引用检查，不能证明图像属于正确球队。

## 4. 切片二：计数、轮次、状态和联赛标签（UX-02～UX-05）

### UX-02：选中日期计数

**涉及文件**：`miniprogram/pages/matches/matches.js/.wxml`，需要时检查 `src/application/match-query.ts` 和对应 API 字段。

- 先核实计数当前来自完整结果还是已加载分页。若来自分页数组，优先补齐选中日全部结果再计数；不能未经说明把部分结果当全天总数。确需服务端聚合时再增字段，避免提前增加无用接口。
- 展示日期用北京时间，明确跟随当前联赛和选中日期。
- `待预测` 只计真正 `can_predict` 的未提交比赛；`已预测` 计本人已提交。不可预测的未提交比赛不硬算入待预测，两个数字不要求始终等于全部比赛数。
- 请求结果绑定当时的联赛和日期；切换或提交返回后不能让旧请求回填新日期。
- 成功提交后刷新权威状态或按唯一 `match_id` 更新一次；首次 201 与幂等重放 200 不得双减双增。

**用例**：今天/非今天、未来/历史、切联赛、提交后返回、幂等重放、分页超过一页、跨北京时间零点。原截图 `open 5 + done 1 = 6` 只作为该场景核对例，不冻结为所有日期的恒等式。

### UX-03：统一轮次和时间

**涉及文件**：三页 `matches`、`match-detail`、`my-predictions` 的 JS/WXML；计划新增公共格式化工具 `miniprogram/utils/match-presentation.js`。

- 数字轮次格式化为“第 N 轮”；已带单位、淘汰赛阶段、补赛标签按实际字符串展示，不对所有字符串拼“第…轮”。
- 时间统一北京时间；未知轮次不输出裸数字或 `undefined`，不使用默认第 1 轮。
- 首页/详情/历史页共用格式化函数；由服务端保留 `round_id` 原值。

**用例**：`10`、`第10轮`、`半决赛`、空值、跨日开球；检查三页一致。

### UX-04：拆分比赛与预测状态

**涉及文件**：`matches`、`match-detail`、`my-predictions`，以及我的页最近预测区。

| 事实 | 比赛状态层 | 个人预测层/操作 |
|---|---|---|
| 未开赛且可预测，无个人预测 | 未开赛；开球/截止时间 | 预测按钮 |
| 未开赛，已提交 | 未开赛 | “已提交 2 : 1”；查看详情；不可修改说明只出现一次 |
| 未开赛但预测截止 | 未开赛 | “预测已截止”；不能写“比赛已结束” |
| 正在比赛 | 进行中 | 有预测则显示已提交的比分；无预测说明不可参与 |
| 完场但未结算 | 已结束，真实比赛比分 | “等待结算”；不能把未知分数按 0 分展示 |
| 已结算 | 已结束，真实比赛比分 | 预测比分、得分及命中结果 |
| 延期/取消/腰斩 | 对应比赛状态 | 按后端 `can_predict_reason` 与已有业务规则显示，不自行重开或结算 |

统一文案模型并去掉同卡多处“已锁定”。预测提交前显示主客队中文名、比分、自动推导赛果；提交成功清楚回显并可返回首页/查看记录。规则保持“精确比分命中 12 分，仅赛果命中 3 分，未命中 0 分”，不在精确命中场次叠加 3 分。

**用例**：表中各态、提交成功/失败后的表单保留、返回刷新、未结算 `null` 和 0 分的区别。失败用例为模块定向测试，不扩大为断网专项。

### UX-05：联赛标签缺失（本轮忽略，不实施）

**涉及文件**：`matches.js/.wxml/.wxss`，必要时关联联赛常量与 `getLeagueLogo`。

**2026-11-18 用户决定本轮忽略，不做修改。** 保留记录供后续查阅：

1. 现象：`9-home-after-predict.png`（15:38）六个联赛只剩图标，文字与选中下划线均消失；`3-home.png`（15:27）文字完整。两张截图来自同一轮 E2E 脚本。
2. 已排除数据层：`matches.js:121` 初始化 `LEAGUES.map((item) => ({ ...item, logo }))`、`:202` 更新 `.map((league) => ({ ...league, offSeason }))`，两处都保留 `name`，`leagues` 数组不会丢字段。
3. 复现结论：macOS 侧本地模型用微信开发者工具手动执行切联赛、切日期、提交预测后返回，**未能重现**，文字始终正常。
4. 剩余未验证方向：渲染层尺寸零余量（24px 图标 + 4px 间距 + 12px 文字约 45px，`.league` 的 `min-height` 为 46px，文字与下划线位于最底部，可能被 `scroll-view` 裁切）。此假设未取得实测节点数据，不据此改代码。
5. 后续若要重启：优先用原 E2E 脚本复现（脚本连续操作、不留渲染间隔，与人手操作时序不同），而不是继续手动点。

**本轮验收**：不适用。UX-05 不计入本轮完成项，也不得标记为已修复。

## 5. 切片三：等级与榜单理解（UX-06、UX-07）

### UX-06：等级呈现状态

**涉及文件**：`miniprogram/pages/profile/profile.js/.wxml/.wxss`；后端事实来源 `src/application/levels.ts`、`src/domain/config.ts`、`src/domain/levels.ts`。

- 以 `career.level`/profile 返回等级为准；核对两接口一致性，发现不一致时记录并追源，不在客户端择高或择低“修复”。
- `career.b_points` 为最近评估积分，可为空。为空显示“待评估”，不能转换成 0 或生涯积分。
- 当前前端硬编码下一门槛表，实施时与领域配置逐项核对。提取成可测试的展示函数；不复制一套升级算法。
- 状态顺序：满级 → 尚未定级 → 无评估积分 → 未达积分门槛 → 积分达线但综合条件未确认。本轮删除“已满足升级条件”展示与验收，不扩接口。积分达线文案：“上次评估积分已达门槛，升级还需满足表现条件，以每周评估结果为准”。等级数值取服务端，称号沿用现有 `LEVEL_NAMES` 映射。
- 满 20 场表示满足定级场次条件，不等于即时定级或升级。
- 进度环明确为“评估积分门槛进度”，不命名为综合升级完成率。满级不再展示下一门槛或升级进度环。
- 评估时间优先使用 `next_evaluation_at`，说明每周一 10:00（北京时间）。

**定向测试**：Lv.1 0 场、19 场、20 场待评估；Lv.5 积分不足；Lv.5 726 分仍保持 Lv.5 并解释等待综合评估；Lv.6 726 分正常满级；`b_points=null`；服务端字段不一致的异常呈现。不得把 Lv.5 726 当成必然脏数据。

### UX-07：榜单空态与重复文字

**涉及文件**：`miniprogram/utils/rankings-copy.js`、`rankings-view-model.js`、`pages/rankings/rankings.js/.wxml/.wxss`。

- 替换 `emptyGlobal` 中“你就是第一名”的承诺。按榜种分别描述条件，不能把周榜文案套到要求 50 场的实力榜。
- `me=null` 不能证明没有预测，也不能证明已有待结算预测。只有获得当前周期本人预测事实时才区分“未参与/待结算”；字段不足时使用中性条件文案，禁止猜测状态。
- 保留全站/群组语义；“去预测”采用明确按钮；去除本人摘要中的重复名次。
- 不改 `availableBoards` 资格，不向新用户强开生涯/实力/赛季入口。

**验证**：周榜空、已预测未结算、已有榜单但本人未入榜、群榜空、实力榜不足 50 场；复用并扩展 `rankings-view-model.test.mjs`，确认所有文案没有保证第一名。

## 6. 切片四：历史资料（DATA-01；DATA-02 已撤销）

### DATA-01：让历史接口返回球队资料

**涉及文件**：`src/application/prediction-query.ts`、`src/api/v1/predictions.ts`、`src/infrastructure/repositories.ts` 及实际相关适配器；对应 OpenAPI 文件；小程序历史和我的页最近预测。

主方案为给 `PredictionHistoryItem` 增加 `home_team`、`away_team` 对象，包含 `team_id` 和原始 `name`；保留已有 `home_team_id/away_team_id`，加字段不改旧字段含义。

1. 历史查询已取得比赛身份，应按 `team_id` 从真实球队资料解析；分页级别去重/批量获取，不用每条发外网请求。
2. 若仓储仅有逐个查询，先对本页唯一球队去重复用；需要批量接口才扩展仓储及各实际适配器，不预设 SQL 表名。
3. 缺资料时不返回伪造球队。返回可识别的缺失状态并记录缺失 ID，小程序显示中文资料待补全；实际正常覆盖集必须补齐。
4. 更新 API 合同、序列化和应用层测试，再让小程序直接使用历史返回对象，统一走切片一的中文展示层。
5. 删除按 89 天时间窗取前 100 场的补查依赖。兼容发布期间必要的旧接口分支须明确移除条件，不能长期保留双源不一致。
6. 我的页最近预测使用同样资料，减少额外详情查找；仍保留原比分、得分及预测身份。

**验证**：历史超过一页、同一时间窗超过 100 场、多联赛、当前/过去赛季、球队更名、确实缺资料；确认正确球队与 `match_id` 对应，无“主队/客队”冒充正常结果。运行 `src/application/prediction-query.test.ts` 并补接口字段兼容测试。

### DATA-02：已撤销（2026-11-18 决定不做）

**决定**：不做“近期 / 更早”两段式，不改历史接口合同，不新增 `kickoff_from` / `kickoff_before`、cursor 版本化和两段式空态。

**撤销依据（已核对代码与截图）**：

1. `GET /v1/predictions/me` 走 `findByUser(userId)` 取该用户全部预测，仅在传入 `league_id` / `season_id` 时过滤；本次调用只传 `limit`，等于全历史。排序为 `submitted_at` 倒序（`src/application/prediction-query.ts:292`），最新一条排第一。
2. 页面 `listMyPredictions({ limit: 20 })` 只取第一页（`miniprogram/pages/my-predictions/my-predictions.js:96`），已有 cursor 分页和“加载更多”。
3. 八周逻辑当时只用于自动续页：`hasReachedEightWeekHistory` 用 `.some()`，任一条早于 8 周即停止。老张第一页 20 条全部早于 8 周，第一次判断就返回，没有多拉任何更早记录。该函数与自动续页已随文案修正一并删除（2026-11-18）。
4. 结论：老张页面的 6 月 27—28 日记录就是他最新的 20 条预测，不是分页越界。前置原因是他自 6 月 28 日后没有新预测——赛季榜显示“暂无排名”、可见记录全部为中超第 16 轮、首页中超标注“休赛”。
5. 对他的情况，硬性 56 天“近期”视图会是空的，需要先看“近期暂无预测”再点一次才能看到原本就在眼前的记录，体验更差。

**文案与分页行为已修正（2026-11-18）**：`miniprogram/pages/my-predictions/my-predictions.wxml` 页面标题由“最近预测”改为“我的预测记录”，副标题由“回顾最近 8 周的预测记录”改为“按比赛周分组，最新的排在前”；导航栏标题“我的预测”不变。同时删除 `hasReachedEightWeekHistory` 及其自动续页：`loadFirstPage` 只取第一页 20 条，之后由用户点“加载更多”触发 `onMore` → `loadNextPage`，不再进入页面就连续翻页。`miniprogram/utils/prediction-history.js` 只保留按周分组与时间格式化。

**与 Luna-P02 的关系**：`docs/archive/LUNA_MINIPROGRAM_UPDATE__v1.0.md:59` 的设计原文是“「加载更多」持续用 `next_cursor` 翻页至少覆盖 8 周”，主体是“加载更多”按钮，属按钮驱动；归档审查表 `MVP2.0__COMPLIANCE_REVIEW__v1.0.md` 把它转述成“自动翻页覆盖至少 8 周”。本次改动符合设计原文（按钮驱动、不设 8 周上限），与归档表的转述不一致。归档文件按历史记录不改；`compliance.workflow.test.mjs` 中对应用例已改为“点加载更多才翻页”。

## 7. 切片五：领域数据异常与统计口径（DATA-03、DATA-04）

### DATA-03：修错误出口并追溯非法数据

**已确认代码链路**：`src/application/profile.ts` 的 `ProfileQueryService.getMyProfile()` 与 `src/application/levels.ts` 的 `LevelsQueryService.getLevels()` 都调用 `assertUserCareerInvariants` → `src/domain/invariants.ts` 的窗口断言 → `internalError` → `DomainError(INTERNAL_ERROR)` → 网关 `src/gateway/assemble.ts` → `src/api/v1/validation.ts` 的 `mapErrorToHttp` 原样返回 message/details → 小程序服务封装及页面错误状态。云函数 `src/cloud-function/index.ts` 也调用公共映射。`last_eval_n > 300` 可同时使 profile 与 levels 失败，不能假定个人资料接口仍然成功。这里定位的是代码路径，尚未读取实际异常记录或生产日志，不能宣称生产数据根因已查明。

**实施步骤**：

1. 隔离夹具构造 `last_eval_n > 300`、赛季最高等级低于当前等级；通过实际服务/网关入口复现，不只直接调用文案函数。
2. 内部服务错误返回稳定用户文案，内部断言详情留在结构化日志，携带 `request_id`；核对 HTTP 和云函数两条路径，不能只修某一页。
3. 页面针对等级数据读取失败显示“暂时无法读取你的等级数据，请稍后重试”；其他内部错误显示对应的中性提示。程序按状态码/错误码分支，不依赖字符串包含断言名。
4. 在保留服务端校验的前提下拆开页面独立模块错误：只有本次请求实际独立成功的群组、最近预测等模块可以继续展示；profile 和 levels 同时失败时，资料区与等级区分别显示失败说明，不能保留未经验证的默认资料或把旧缓存当正常结果。前端拆模块本身不能恢复失败的 profile；若将来要求非法等级数据下仍可读取基础资料，须另行设计合法的独立查询来源，本轮不绕过完整用户不变量。排行榜失败时不得渲染伪造的空榜、零积分或零等级。
5. 追查异常来自报告造数、正式迁移、重建、周评估还是其他写入链路。核对 `scripts/fb-test-maintain.mjs` 等现场脚本只读，不直接重跑；检查 `weekly-level-eval`、统计重建相关实现与领域窗口规则。
6. 如仅测试造数脚本有问题，修夹具生成并重建隔离数据；如正常链路能产出非法状态，修责任写入端并增加回归。两类结论都需实际证据。
7. 需要历史修复时，必须按合法窗口重新计算完整评估状态和相关积分，不能仅将场次截成 300 而留下不匹配的分数/时间/等级。提供 dry-run 差异、备份及可回滚方案，另行实施。

**验收**：异常字段不出现在用户响应/页面，日志能定位原文；合法错误（如认证/校验）不被全改成泛化 500；正常账号行为不受影响；数据恢复后重新读取成功。必须查清并修复责任源，再用合法夹具及异常回归证明；查不到责任源则 DATA-03 未完成。生产存量修复仍另列可审阅方案，不能以此推迟责任源核查。仅错误文案变友好不算 DATA-03 全部完成。

### DATA-04：核对各统计对象，不为视觉一致改业务值

**涉及文件**：`src/application/personal-league-summary-service.ts`、`ranking-query.ts`、`board-snapshot.ts`、`levels.ts`，以及 `src/domain/ranking.ts` 和 `invariants.ts`；按仓库真实实现核对实际统计来源。

- 收官小结是所选联赛赛季；等级赛季按产品的跨年边界；生涯积分为当前累计；评估 B 分是对应 scope 在评估时点的累计积分，不限最近 730 天/300 场；受该窗口约束的是表现指数的输入。API 的 `career.b_points` 保存上次评估快照，不能拿当前生涯积分替代；二者相同或不同均须结合 scope、时点及有效事实核对。页面用标签区分。
- 文案为“赛果命中 X 场，其中精确比分 Y 场”。包含关系 2026-11-18 已核实到代码级：`src/domain/scoring.ts` 的 `calculateMatchScore` 在精确命中分支硬编码返回 `wdl_hit: true, exact_hit: true`；`assertPredictionInvariants` 在 `src/infrastructure/repositories.ts:1551,1618` 与 `src/infrastructure/cloudbase-app-repository.ts:508,523` 的写入路径强制 `exact_hit => wdl_hit`；`league-season-summary.ts` 按 `wdl_hit === true` 与 `exact_hit === true` 分别计数。因此 `exact_hits <= wdl_hits` 是结构性结论，不需要另设独立核验切片。
- 积分按精确 12、仅赛果 3、未中 0 核查，不将精确命中算 15。
- 周/生涯/赛季比较：积分降序、精确命中数降序、有效场次升序、最近得分比赛时间升序（非空优先）、用户 ID 升序。
- 实力比较：未截断真实指数比较，再按窗口场次降序、用户 ID 升序。两人显示 `1.93` 仍可能真实值不同，不能因展示值相同改成并列。
- 解释入口提供上述规则的可读版，底层比较器继续为唯一排序依据。

**验收**：需求中的 pA/pB/pC 数据与接口逐项核对；统计到原始事实的抽样可追溯；两个显示指数相同的夹具仍按真实比较器排序。原报告克隆的 2025 比赛缺 `match_results/settlements`，不得拿它声称验证了结果纠正或重结算链路。

## 8. 切片六：收官按钮、解锁空态、历史赛季（UI-01～UI-03）

### UI-01：收官按钮

**涉及文件**：`miniprogram/pages/matches/matches.wxml/.wxss/.js`；沿用现有 `season-action season-rankings` 的入口行为。

- 次级按钮采用深色文字与清楚描边，保留按下态；不可用才显示禁用态。无需更换整页背景或卡片视觉。
- 文案使用明确目标，例如“查看 2026—2027 赛季榜”。目标来自真实等级赛季，不能把中超 2026 直接当作等级赛季 ID。
- 点击参数、排行榜选择结果、标题三者一致；若用户无赛季榜资格，遵从既有资格和替代引导，不能凭按钮强开入口。
- 复核不同参与场次的收官卡与已结算状态，未结束联赛不显示伪收官。

**用例**：普通/按下/不可用；新用户、pA、pB、pC；按钮目标赛季与页面选中赛季一致。

### UI-02：解锁空态

**涉及文件**：`miniprogram/pages/unlocks/unlocks.js/.wxml/.wxss`；规范来源 `docs/MVP__v2.0.md` §18.2、§28.2。当前已有页面并不意味着装扮 UI 元数据已冻结。按用户本次要求，只完善记录页空态说明与“去预测”入口，并在实施时同步记录规范有限例外；不借此恢复装扮功能。

已核实后端 `UNLOCK_CONFIG_V1` 的 code 与累计积分门槛：30 → `profile_card_style_1`，100 → `favorite_team_name_accent`，200 → `favorite_team_avatar_frame_1`。这些是后端规则事实，不构成已冻结的用户可见名称、图标或资源。`decideUnlockGrants` 按当前累计积分与已有记录判断，历史已解锁项保留。

- 空态文案：“暂无解锁记录。解锁按生涯积分达标后自动记录；已解锁记录不会因赛果修正而回收。”
- 主按钮“去预测”，到首页。不要写“一场命中即可解锁”，也不把设置喜爱球队当作积分解锁前提。
- 只修改空态；已有记录页保留当前中文标签、门槛数字、进度及时间，不删除、不重命名、不增加展示。不新增装扮清单、下一目标、差额、预览或装扮入口。
- 既有中文标签属于当前页面现状，不宣称为全局冻结装扮元数据。实施时同步规范，明确记录页既有展示保留及空态补充这一有限例外。后端记录、默认资源、发放与回收规则不变。
- 原报告提到的 `miniprogram/assets/illustrations/` 实际不存在。使用说明文字和清楚的按钮完成空态，不另行设计或选择未冻结的装扮图片。

**用例**：空记录/已有记录、去预测导航；0/29/30/99/100/199/200 分用于核对后端既有规则，不将门槛制作成新的前端解锁清单；积分已达标但无记录时不能提示“还差积分”，须核查发放链路；记录在积分回落后保留；不新增发放行为或扩展 API。

### UI-03：历史赛季入口

**涉及文件**：`miniprogram/pages/rankings/rankings.js/.wxml`、`utils/rankings-view-model.js`；复用已有 `rankings.season-fallback.test.mjs`。

- 所有可见的等级赛季 ID 格式化为“2026—2027 赛季”，请求仍使用 `2026_2027`。
- 当前赛季未参与但有历史的用户显示“本赛季尚未参与”及“查看历史赛季”按钮；点击后由用户主动选择真实可用赛季。
- `availableLevelSeasons` 表示可查询赛季，不一定证明本人参与。现有字段不足以确认个人参与时，按钮使用中性“查看历史赛季”，不能写“看看你某赛季的成绩”。若要个性化推荐，先取得个人参与事实再做。
- 继承现有历史赛季仅全站范围约束，调用统一赛季切换处理，设置用户主动选择标记；不能绕过 `userChangedSeason`。
- 本季空榜或本人未入榜均不得自动把用户切到上季；主动回本季后仍保持本季。
- 新用户只开放周榜属于现有设计，历史引导不能改变资格。

**用例**：pC 本季未参与/有旧赛季、pA/pB 本季有排名、无历史、新用户、主动选本季空榜不回退、历史转全站、快速切换旧请求不覆盖新选择。

## 9. 回归矩阵与执行方式（QA-01）

### 9.1 逐项追踪

| 需求编号 | 本文实施位置 | 必要证据 |
|---|---|---|
| UX-01 | 切片一 | ID/中文名/队徽核对表；相关页面截图；缓存与搜索测试 |
| UX-02 | 切片二 | 日期计数与分页测试；提交前后同场景截图 |
| UX-03 | 切片二 | 轮次格式化测试；三页对照 |
| UX-04 | 切片二 | 状态矩阵用例；预测前后与结算状态截图 |
| UX-05 | 本轮忽略 | 保留现象截图、已排除数据层的结论、手动复现失败记录；不计入完成项 |
| UX-06 | 切片三 | 本节列明的等级状态及原服务端等级未改的证据 |
| UX-07 | 切片三 | 各榜空态、等待结算事实、重复文案消除 |
| DATA-01 | 切片四 | 历史接口字段与超 100 场场景；多页中文对阵 |
| DATA-02 | 切片四 | 已撤销，不实施；仅保留撤销依据与前置原因记录 |
| DATA-03 | 切片五 | 真实调用链异常响应及日志；责任源修复/排除证据 |
| DATA-04 | 切片五 | 三账号统计口径与比较器核对记录 |
| UI-01 | 切片六 | 按钮可辨识截图与目标赛季导航 |
| UI-02 | 切片六 | 新空态与导航；已有标签/门槛/进度/时间不变；不新增装扮展示 |
| UI-03 | 切片六 | 主动历史入口、赛季格式、本季空榜不回退 |
| QA-01 | 本节 | 完整命令/退出码/用例数/版本与截图对应表 |

### 9.2 后续实施的检查命令

以下是已核对存在的测试入口，**本次文档任务未执行这些业务测试**。改代码前先在隔离工作区跑相关基线，新增用例先明确目标行为，再实施最小修复。

```bash
npm run typecheck
npm test -- src/application/match-query.test.ts src/application/prediction-query.test.ts src/application/unlocks.test.ts
node --test miniprogram/utils/rankings-view-model.test.mjs miniprogram/pages/rankings/rankings.season-fallback.test.mjs miniprogram/pages/rankings/rankings.podium.test.mjs miniprogram/pages/profile/profile.team-logo.test.mjs
npm run logos:check
```

后续还需运行新增的展示工具、历史范围、网关错误出口及页面回归测试；定向测试不能替代交付前主 agent 亲自跑全量 `npm test` 与全部小程序 Node 测试。测试所需数据库是否隔离、是否修改状态须先核对，数据库依赖未具备时如实标记。类型检查使用 `--noEmit`，不写线上 `dist`。

小程序 E2E 入口确为 `node scripts/miniprogram-e2e.mjs --keep-open`，但会登录及提交预测；后续仅在准备好的隔离账号/数据环境执行。本次不运行。UI 回归继续使用原标准模拟器尺寸，四项暂缓专项不顺带执行。

### 9.3 账号与数据限制

- 新用户：Lv.1、无记录、周榜资格、解锁空态。
- pA：238 场中超小结、Lv.5、历史预测分页。
- pB：240 场完整联赛小结、Lv.5、当前赛季榜。
- pC：跨赛季回归、Lv.6、当前赛季未参与、主动查看历史。
- 这四类按隔离夹具生成，不重用报告里明文 token，不把线上既有账号状态当恒定数据。
- 脏数据场景单独夹具，不污染正常账号；原报告克隆历史缺少结果与结算记录，只能验展示，不能证明完整重结算正确。

## 10. 提交与回滚边界

建议每个切片独立提交，依赖为：中文身份层先完成；历史对象接线依赖中文展示层；近期/更早过滤依赖历史查询合同；按钮与引导最后统一复核。数据口径核查发现前置错误时回到责任切片修复，不能靠视觉掩盖。

- 每段报告真实 diff 范围、测试命令/退出码、页面证据和未验证项。
- API 加字段先服务端后小程序；范围过滤及 cursor 必须一起发布并测试旧请求兼容，不能让老客户端误用新游标。
- 中文注册表和 UI 更改可按提交回退；不清登录缓存，不改供应商映射。
- 若确需数据库字段或历史修复，另列迁移/修复方案，不混入纯 UI 回退；本方案当前优先无 schema 变更。
- 推送前先 fetch 核对多设备远端提交，再决定合并；不覆盖本地或其他设备成果。

## 11. 本次文档交付的验证边界

本次只核对报告、截图、当前代码和公开只读比赛查询，并检查文档覆盖、文件引用与改动边界。未新增业务测试结果，未执行网络故障注入、窄屏、滚动到底、生产重建或线上数据修复。后续实现不得引用本文件作为“已验收通过”的证明。
