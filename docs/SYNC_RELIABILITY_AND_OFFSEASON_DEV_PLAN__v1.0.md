# 同步可靠性、换季机制与休赛期体验开发计划 v1.0

> **开发执行约束（优先于本文其他表述）**：只关心功能性问题；忽略安全性、防御性问题；不进行过度开发；不尝试做未经授权的测试工作。

> 依据需求文档：[SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md](./SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md)
> 关联专题合同：[个人本联赛小结：后端与前端开发计划 v1.0](./PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md)
> 关联基线约束：[Provider 同步完整性与多源接线优化开发文档 v1.0](./PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md)
> 创建日期：2026-11-15；更新日期：2026-11-16
> 交付策略：**分两批上线**：
> - **第一批（同步基础设施与比赛身份）**：比赛逻辑身份归并（S0） + S1 + S2 + S3（数据源赛季与竞技赛季两层分离、规则化换季、参赛名单沉淀与映射告警）+ S6 第一批构建与受控切换。
> - **第二批（竞技赛季收官、统一阶段接口与前端体验）**：竞技赛季持久化表与收官计算（见个人小结文档） + 统一联赛阶段接口 + S4（只消费后端阶段） + S5 + 个人本联赛小结 + S6 第二批验证与上线。
> - 每批均在全部代码改造与本地/受控测试通过后，再统一构建、验证定时任务并重启 VPS 服务。

---

## 0. 开发切片总览（按依赖与批次顺序）

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

### S0：比赛逻辑身份归并（第一批前置）

1. **逻辑身份与取代关系建模**：
   - 文件：[types.ts](file:///home/football/src/domain/types.ts)、[provider-fixture-sync.ts](file:///home/football/src/application/provider-fixture-sync.ts)、[repositories.ts](file:///home/football/src/infrastructure/repositories.ts)（及对应仓储与迁移文件）
   - 规则：
     - 同步入库阶段即确定比赛的唯一逻辑身份（写入 `canonical_match_id` 作为统计分组键），并在存在被取代旧记录时由旧记录通过 `superseded_by` 指向当前有效比赛的 `match_id`。
     - 当前有效记录的 `canonical_match_id` 可以等于自身的 `match_id`，也可以是独立分组 ID；`superseded_by` 必须指向同一 `canonical_match_id` 下、自身未被取代（`superseded_by == null`）的记录，**禁止链式或环状指向**。
     - 归并依据：相同外部数据源比赛 ID，或同一联赛、同一竞技赛季、同一轮次、相同主客队的改期记录在确认关联后归并到同一逻辑比赛。重赛须确认沿用同一次预测资格，不能仅因主客队相同就自动归并。
     - 逻辑身份一旦确定即保持稳定，更换来源比赛 ID、开球时间或有效记录不重新分配 `canonical_match_id`。当前双循环联赛可按 `(league_id, season_id, home_team_id, away_team_id)` 查找候选，再结合轮次、来源映射与改期依据确认；此候选条件不是所有赛制通用的自动合并规则。
     - **保留不删除**：被取代的历史记录（如改期前的 `postponed` 记录）保留在库中，不物理删除，也不在归并动作中擅自改写既有预测或结算事实。
2. **赛程发现与已有来源映射的处理闭环**：
   - 来源比赛 ID 已有映射：解析到现有比赛；若该记录已被取代，沿 `superseded_by` 解析到当前有效记录后处理，避免更新继续落在历史旧记录上。保留来源映射与历史事实的可追溯关系。
   - 来源比赛 ID 新增：先按目标竞技赛季查找逻辑比赛候选；唯一确认属于同一场时关联已有逻辑身份，按改期规则更新赛程或建立取代关系，不因新来源 ID 直接新增独立逻辑比赛或预测资格。没有对应比赛时才新建；多个候选或证据冲突时保留待核对记录，不自动合并。
   - 有预测的归并须验证原预测可通过正常结算链路使用有效比赛赛果；唯一预测迁移、重复预测复核均按个人小结计划 §3.2 执行。
3. **退出同步候选集**：
   - 所有同步、恢复与核对候选仅按 `superseded_by != null` 排除被取代记录；`canonical_match_id` 仅作分组键，不作排除条件。
4. **存量中超 2026 改期记录处理**：
   - 核查中超 2026 现有 240 场 `finished/settled` 比赛之外的 6 条同联赛、同轮次、同主客队但 `match_id` 不同的 `postponed` 历史记录：
     - 逐组核对来源比赛 ID、开球时间、轮次、来源映射和赛果关联，确认原赛程及改期后有效记录；不能仅凭 `finished` 状态自动认定有效记录。确认关联后写入 `superseded_by` / `canonical_match_id`；
     - 在 S6 上线前核查这 6 条旧记录上是否存在用户预测记录，并按 [个人本联赛小结开发计划 §3](./PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md#3-统计口径) 的确定口径处理。
5. **旧数据读取兼容与物理回填**：
   - 现有 `document-codec.ts` 对比赛缺失的 `canonical_match_id` 回落到 `match_id`、缺失的 `superseded_by` 补 `null`；预测缺失的 `canonical_match_id` 同样回落到 `match_id`。PostgreSQL 与 CloudBase 读取均保留此兼容，不把缺字段误判为整季合并成一场。
   - 物理回填用于统一持久数据与索引查询，仅补缺失字段，保留已有逻辑身份及取代关系；预测身份以关联比赛的已确认逻辑身份为准，不对已归并比赛机械回填为旧 `match_id`。迁移预览与正式执行见 S6。
   - 缺字段回填与身份归并分开列示：回填不覆盖已有字段；已确认归并如需统一两条记录原有的不同身份，必须在预览中明确旧值、新值及受影响预测，经确认后一次性统一，后续来源变更继续沿用该身份。
6. **逻辑比赛只能预测一次**：第一批同步接入预测提交链路与两种部署仓储，以 `(user_id, canonical_match_id)` 约束唯一预测；改期、更换 `match_id` 或新增取代记录不重新开放预测。提交时解析到当前逻辑身份，并通过事务/唯一约束或部署等价的原子机制防止旧、新记录并发产生两份预测；同一幂等请求重放沿用原响应，新的重复提交按现有重复预测约定拒绝。归并发现存量重复预测时先复核处置，禁止自动挑选有利结果或叠加结算；具体统计口径见个人小结计划 §3.2。

---

### S1：实时窗口收敛与按联赛独立日期查询（R2）

1. **统一实时窗口上限（`live_match`）**：
   - 文件：[provider-active-window.ts](file:///home/football/src/application/provider-active-window.ts)、[active-window-query.ts](file:///home/football/src/infrastructure/active-window-query.ts)
   - 规则：
     - `Scheduled` 与 `Live` **统一**使用时间窗口 `[kickoff - 2h, kickoff + 6h]`（即 `kickoff >= now - 6h && kickoff <= now + 2h`）；`Live` 不再无期限滞留高频窗口。
     - `buildActiveWindowFilters("live_match")` 与内存判定 `activeWindow()` 保持完全同构。
     - 超过开球后 6 小时仍处于 `Scheduled` **或 `Live`** 的异常滞留场次（例如中断、腰斩未及时更新终态）退出高频 `live_match`，同时两类状态均需记录结构化告警日志（每场/每轮去重，避免卡在 `Live` 的场次无声消失）。
     - **超时恢复独占候选**：超过开球后 6 小时仍非终态的比赛进入持久化 `stale_recovery` 待办，同时退出 `post_finish_verify`（含其每日兜底），避免同场同时触发窗口核对与恢复请求。优先查询主源，必要时再查 `of`；每个自然小时最多启动一次，由现有 3 分钟 timer 和调度记录控制。未解决场次跨日保留，后续调度续查。恢复为完场后退出恢复待办，再按当前赛果版本进入必要的赛果核对与到期赛后对账；明确取消等最终处置则结束恢复，不伪造完场赛果。
     - `stale_recovery` 使用 S2.3 的独立预算，耗尽即停并告警，不借用窗口同步或对账额度。赛后对账由 S2.4 负责。
2. **按联赛独立计算 `dateFrom` / `dateTo`**：
   - 文件：[provider-window-loader.ts](file:///home/football/src/application/provider-window-loader.ts)
   - 改动：
     - 在 `for (const leagueId of orderedIds)` 循环内，基于当前联赛且 `superseded_by == null` 的 `leagueMatches` 单独计算该联赛自己的 `from` / `to`，避免单一联赛滞留场次拖累其余联赛。
3. **验证**：
   - 单测覆盖：开球超 6 小时的 `Scheduled` 与 `Live` 场次均退出 `live_match`、均产出告警并进入 `stale_recovery` 兜底；采用独立分组 `canonical_match_id` 的有效比赛仍正常进入 `live_match` 与 `post_finish_verify`，仅 `superseded_by` 非空的旧记录被排除；某联赛含历史滞留场次时，另一联赛查询 `dateFrom` 不受污染。

---

### S2：多源核对、额度隔离与对账续查（R3）

1. **`post_finish_verify` 仅查询实际存在待核对比赛的日期**：
   - 文件：[provider-window-loader.ts](file:///home/football/src/application/provider-window-loader.ts)、[registry.ts](file:///home/football/src/provider/registry.ts)、[openfoot-adapter.ts](file:///home/football/src/provider/openfoot-adapter.ts)
   - 改动：
     - 收集当前联赛 `superseded_by == null` 候选比赛实际涉及的 `kickoff_at` 日期集合（含跨零点完场的 `+1` 日必要窗口），去重后仅请求有待核对比赛的日期，避免空日和被取代的旧改期日期无效消耗 `of` 额度。
2. **已有两源一致就停止继续查询副源**：
   - 文件：[provider-window-loader.ts](file:///home/football/src/application/provider-window-loader.ts)、[registry.ts](file:///home/football/src/provider/registry.ts)、[provider-fixture-sync.ts](file:///home/football/src/application/provider-fixture-sync.ts)
   - 以当前逻辑比赛、当前赛果版本的有效完场观测为依据，两个不同渠道的比赛终态与常规时间比分一致后，该场退出本轮及后续重复 `post_finish_verify` 副源候选；`result_version > 0` 或单源已终态均不能单独作为跳过依据。同一渠道重复返回相同结果不算双源。
   - 副源按顺序请求并在每次返回后更新待核对集合，不再无条件遍历所有副源。五大联赛优先 `fd + 5d`，仍缺有效完场观测或存在冲突时再查 `of`；中超优先 `bsd + of`，副源不可用时再查 `sp`。仍遵守各渠道限额，`5d` 优先保障直播。查询按待核对日期批量执行：该日仍有其他未解决比赛时可继续请求，但已一致比赛不再单独触发查询。
   - 比分或比赛终态更正后，旧版本的一致记录不得阻止新版本核对；第三源观测沿用既有冲突/更正流程，不按多数票直接覆盖。此停止规则只消除窗口内重复核对，不取消 S2.4 的赛后重新对账。
3. **三池隔离：为 `provider_reconcile` 设独占保留额度，为 `stale_recovery` 设独立小额池**：
   - 文件：[budget.ts](file:///home/football/src/provider/budget.ts)、[provider-reconcile.ts](file:///home/football/src/application/provider-reconcile.ts)
   - `provider_reconcile` 使用独立任务类型计费，不再复用 `FullScheduleVerify`；预算按实际 HTTP 请求（含分页）扣减。
   - `of` 日额度分为互不侵占的三个池：窗口赛果核对（`post_finish_verify`）、超时恢复（`stale_recovery`）、每日对账（`provider_reconcile`）。恢复池另设单轮核对场次上限，耗尽即停并告警。`of` 不承担 `near_match` / `live_match`；其他渠道仍遵守自身分钟、小时、日与月额度限制。
   - 固定比例为窗口赛果核对 **60%** / 超时恢复 **10%** / 每日对账（含历史漏查续查）**30%**，总和为 100%，三池互不借用。按当前配置，生产 `120` 次/日分为 `72 / 12 / 36` 次，测试 `40` 次/日分为 `24 / 4 / 12` 次；测试环境不关闭恢复功能。配额取整时，窗口池和恢复池分别向下取整，对账池取日额度余数。
   - 三池合计仍受渠道真实日、月总限额约束；池内有余额不能突破总限额。同池按渠道、联赛、赛季和日期合并查询，轮转处理联赛，避免固定顺序耗尽额度；恢复池每小时最多启动一次，未完成恢复与对账均顺延待办。
   - 60/10/30 为初始固定配置；后续依据各池实际耗尽、剩余与待办积压情况调整。
   - 验证：单测覆盖当窗口同步池与 `stale_recovery` 池同时耗尽时，每日 `provider_reconcile` 仍可稳定获取预留额度执行对账。
4. **每日对账保留待办并续查漏项**：
   - 实施前能力边界：现有 `provider_reconcile` 仅查昨天已完场且已结算比赛，不能承担超时未终态比赛恢复，也不会自动补查前一天因额度不足漏掉的对账；本批分别由 S1 恢复待办与本节对账待办补齐。
   - 文件：[provider-reconcile.ts](file:///home/football/src/application/provider-reconcile.ts)、[repositories.ts](file:///home/football/src/infrastructure/repositories.ts) 及对应持久仓储/调度接线。
   - 每日处理“新增到期赛后对账 + 历次未完成待办”。按逻辑比赛、竞技赛季、目标渠道及待核对赛果版本记录待办；额度不足、请求失败、返回缺少目标比赛或身份映射未完成时均保留待办，后续每日调度优先续查历史漏项，不因日期变更或数据源换季丢失。
   - 保留五大联赛 `of`、中超 `sp` 的赛后对账分工；主源重复观测不能冒充独立渠道核对。按渠道、联赛、赛季和待查日期合并请求，但逐场确认观测后才标记对应待办完成；窗口内的两源一致记录不能直接替代本次到期的赛后重新观测。
   - 超时未终态比赛留在 S1 的恢复待办，恢复到符合赛后对账条件后再进入本待办；对账发现差异继续走既有冲突/更正流程，不由对账任务直接重算个人小结或覆盖结算事实。

---

### S3：换季两层分离、规则化切换、升班马告警与中超第二源（R4, R5, R6）

1. **数据源赛季与竞技赛季两层分离（长期机制，不硬编码两年）**：
   - 文件：[config.ts](file:///home/football/src/domain/config.ts)、[fixture-mapper.ts](file:///home/football/src/provider/fixture-mapper.ts)、[fivedollar-adapter.ts](file:///home/football/src/provider/fivedollar-adapter.ts)（及竞技赛季配置/持久化模块）
   - 规则：
     - **第一层：数据源赛季（Provider Season）**：每次同步任务明确携带目标竞技赛季 `season_id`，再生成对应渠道的 `provider_season_refs` / `season_ref`。`activeLeagueSeason(league, now)` 只为未显式指定赛季的日常任务选择默认目标，不代表收官或页面展示季；历史对账、超时恢复与跨年补赛使用各自所属的目标赛季，不能被执行当天的默认赛季覆盖。
     - **换季规则**：内部 `season_id` 按联赛赛制规则（自然年 `YYYY` / 跨年 `YYYY_YYYY`）自动推进生成，并可由外部配置或数据库赛季记录覆盖；同时复用 [PROVIDER_SYNC_RELIABILITY_DEV_PLAN PS08](./PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md#ps08openfoot-赛季表达统一) 的双层表达，将**内部 `season_id`** 与 **各数据源查询赛季引用（`provider_season_refs`）** 明确分离。
     - **第二层：竞技赛季（Competitive Season）**：比赛所属的竞技赛季**以数据源返回所属赛季为准**，彻底移除入库与同步链路上用开球时间边界（`isKickoffInLeagueSeason`）反推或校验赛季归属的逻辑：
       - 修改 [fixture-mapper.ts](file:///home/football/src/provider/fixture-mapper.ts)（针对 `5dollar` 的 `isKickoffInLeagueSeason` 校验）：当数据源明确提供赛季字段且匹配请求赛季时直接采信，不再因开球时间落在日历窗口外（如 12 月延期到次年 1 月）而标记 `league.season` 异常导致整条比赛入库失败；
       - 修改 [fivedollar-adapter.ts](file:///home/football/src/provider/fivedollar-adapter.ts)：当数据源未提供赛季字段时，按调用该接口时携带的数据源查询赛季参数归属，不再调用 `isKickoffInLeagueSeason` 过滤返回空串；
       - 开球时间仅做宽松合理性检查（例如以目标赛季起止前后各留 6 个月缓冲），超出仅记录诊断告警，不拒绝入库；将 `isKickoffInLeagueSeason` 标记为弃用，确认无其他调用后清理。
       - 补充单测：12 月延期到次年 1 月的比赛在 `fixture-mapper` 与 `fivedollar-adapter` 下均能正常入库并归属原赛季。
     - **S3c：目标赛季贯穿请求、映射、发现与入库**：修改 `sources.ts` 的静态赛季取值，并同步修改赛程发现的 `buildMatch()` 等入库路径；来源明确返回赛季且与目标相符时采信，缺少赛季字段时使用本次请求的目标竞技赛季，明确不符时走现有赛季冲突诊断，不静默改归当前季。不得只改请求参数，入库却继续使用 `activeLeagueSeason(league, serverNow)`。
     - 验证：新季日常任务自动使用新季渠道引用；换季后旧季对账/恢复仍请求旧季；旧季补赛首次发现时仍写入旧季，球队映射、逻辑身份候选和 `season_teams` 也使用同一目标季；12 月延期到次年 1 月不换归属。不新增通用赛季调度框架。
     - 竞技赛季的持久化记录（`league_seasons`）、收官核验与状态流转由 [个人本联赛小结开发计划 §4](./PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md#4-联赛结束判定与赛季选择) 统一定义，在第二批落地。
2. **参赛球队名单持久化与升班马未映射明确告警（R5）**：
   - 文件：[provider-cross-source.ts](file:///home/football/src/application/provider-cross-source.ts)、`src/scripts/`
   - 改动：
     - 换季全量同步及运行 `providers:map-teams` 时，将已确认的“联赛 + 竞技赛季参赛球队名单”持久化沉淀（计划表/集合 `season_teams`，与主源建队及映射脚本同一步产出），作为后续完整赛程核验（应有场次与对阵计算）与升班马核查的单一数据源。
     - 当 `of`（或 `bsd`/`sp`）因 `homeTeamProviderId` / `awayTeamProviderId` 在 `team_src_map` 中未找到映射而返回 `unlinked` 时，记录带 `league_id`、`provider`、`provider_team_id`、`team_name` 的结构化告警日志（每轮去重，避免刷屏），方便运营按清单补齐映射与小程序队徽。
3. **中超第二核对源启用 `of`（R6）**：
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

1. **日期条统一按 `Asia/Shanghai` 计算 & 空态文案修正（R7）**：
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

### S5：排行榜休赛期默认展示上赛季终榜（R11，第二批落地）

- 文件：[rankings.js](file:///home/football/miniprogram/pages/rankings/rankings.js)、[rankings-view-model.js](file:///home/football/miniprogram/utils/rankings-view-model.js)
- 改动：
  - 收官卡使用通用【查看等级赛季排行榜 →】入口，不传本联赛 `league_id` 或竞技 `season_id`；以服务器当前时间按北京时间 7 月 1 日边界确定默认等级赛季。竞技赛季不映射等级赛季，按钮不受本联赛是否产生榜单或上线计分周门控，榜单可用性由排行榜服务负责。
  - 在 `board === "season"` 且用户未手动指定 `selectedLevelSeasonId` 时：以“当前等级赛季在后端是否**尚未产生任何有效入榜数据**”为回退依据（而非单纯因列表为空或请求异常误判）。若新赛季暂无有效入榜数据且 `available_level_seasons` 中存在上一赛季，前端自动回退加载并高亮显示上一赛季终榜，同时保留顶部赛季切换器允许用户切回新赛季。
  - 明确与现有“新赛季前 28 天上赛季回顾/等待封榜提示”的联动优先级：无有效入榜数据时默认落在上赛季终榜；新赛季产生首条有效入榜数据后切回新赛季，并在 28 天窗口内保留回顾入口。
  - 当前与上一等级赛季均无可用榜单时展示既有空态；请求异常不得触发回退。“最终排行榜/终榜”只用于实际已封榜的等级赛季，未封榜时沿用等待封榜提示。
  - 补充对应 view-model 单元测试。

---

### S6：上线前门禁配置、存量数据核验与分批切换（R1, R8）

1. **门禁配置与运行边界（R8）**：
   - **`RANKING_FIRST_PERIOD_KEY` 最后单独决定**：当前不改占位值 `2026-W31`，不按执行当天周次自动推定，不与比赛身份归并、换季、小结开发或迁移绑定为同一步骤。**2026-11-17 用户决策：等小程序正式发布后再定**，即取值应为发布所在周的 `period_key`；在那之前保持占位，网关可先上线，周榜窗口不受影响。
   - `ops/vps/football-jobs.timer`：保持每 **3 分钟**一次（`OnCalendar=*-*-* *:00/3:00`，模板与线上一致，2026-11-17 复核确认）；如需提频，另行重算各渠道预算后变更。基线见 [Provider 计划 PS10](./PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md#ps10timer-模板与运行边界)。
2. **存量数据核验与身份关联（R1）**：
   - **先完成 S0 持续归并链路与 S3c，再迁移存量**，避免只清理现有 6 组、后续同步再次产生重复。
   - 提供一次性迁移脚本，默认 `--dry-run` 只读：按目标部署/库生成缺字段统计及逐组变更清单，列明旧记录、有效记录、逻辑身份、判定依据与受影响来源映射、赛果、预测/结算关联；候选不明确或有重复预测时单列待复核，不静默处理。预览数量以当次查询为准，不硬编码 1998 行或假定所有部署预测均为 0。
   - 预览确认后才正式执行：先备份目标数据，在部署支持的事务或等价原子机制中完成缺字段回填与已确认归并，不删除历史、不覆盖已确认的逻辑关联；存量身份冲突仅按 S0 已确认归并清单统一，不擅自改写正常结算事实；保留迁移前后清单及按清单回滚步骤。重复执行应无新增变更；执行时重新核对预览依据，变化项重新预览。
   - 按 S0 逐组确认中超 2026 的 240 场 `finished/settled` 与 6 条旧改期记录，完成身份关联及必要的预测处置；各部署分别检查预测是否存在，不能将 `football_dev` 的查询结果外推到其他账本。
   - 迁移后先核验有效逻辑比赛集合与完整性，再由正常赛季维护任务决定能否收官，不手工强制设为 `completed`；检查旧来源更新到达有效记录、改期不重开预测、原预测正常结算、重复执行幂等。
   - 执行受控 `node dist/jobs/tick.js` 验证：超时异常滞留场次退出 `live_match` 并恢复健康状态，`post_finish_verify` 与 `provider_reconcile` 按新预算隔离规则正常运行。
3. **分批全量构建、测试与切换**：
   - **第一批（S0 + S1 + S2 + S3）**：完成全部相关单测、全量 `tsc --noEmit` / `tsconfig.build.json` / `tsconfig.cloudfunction.json` 与 `vitest run`；在 VPS 完成身份归并验证与受控 `tick.js` 后，开启/重启 `football-jobs.timer` 与 `football-gateway.service` / `football-gateway-bridge.service`。
   - **第二批（竞技赛季表 + 收官判定 + 统一阶段接口 + 个人小结 + S4 + S5）**：完成双部署（VPS PostgreSQL + CloudBase）schema 迁移、双部署仓储一致性测试、API/gateway 测试与小程序测试后，再上线收官卡与个人小结。

---

## 2. 开工/上线前待核查事项与配置

1. **中超 `of` 球队映射（16 队）**：*（注：当前分支已于 `3a339dd` 完成中超 `of` 启用为 `secondary`，上线前核对日志无 `[team_mapping_missing]` 即可。）*
2. **上线周 `RANKING_FIRST_PERIOD_KEY`**：正式上线时从哪一周开始记为第一周（当前占位 `2026-W31`）？
3. **定时任务频率**：`football-jobs.timer` 保持每 **15 分钟**一次，还是在上线时改为每 **3~5 分钟**一次以配合实时比分更新？
