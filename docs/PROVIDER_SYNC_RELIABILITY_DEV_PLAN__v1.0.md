# Provider 同步完整性与多源接线优化开发文档 v1.0

> **For Hermes:** 逐节点实施，每节点只跑受影响文件的单测；全量测试、typecheck 与构建只在最后统一执行一次。
>
> 状态：代码开发基本完成，定向测试通过；PS06 与 PS09 尚未联合关闭，PS02 建档权限待确认，PS11 尚未执行。本文更新不代表授权修改运行库、恢复服务或部署。
> 审计日期：2026-11-13；进度回填：2026-11-14。代码基线：`e2868d8`，开发在隔离工作树 `/home/football-provider-dev`（基于 `feat/resource-point-opt` 的 `e2868d8` 检出），成果推送分支 `feat/provider-sync-reliability`。
> 目标：补齐多联赛初始化、首次比赛发现、失败补偿和多源数据分发，使“请求成功”与“业务同步完成”可区分。
> 架构：沿用现有 TypeScript 业务服务、Provider Registry、文档仓储和共享调度；VPS 与 CloudBase 复用同一修复。

## 1. 范围与执行约束

### 1.1 本期范围

- 多联赛任务的到期判断与重试隔离。
- 主赛程源首次发现不同状态比赛时的建档。
- 请求成功、批次完成、部分失败和配额延后的状态语义。
- 5d 同轮直播分发、联赛过滤与赛季核验。
- 联赛 ID 配置与业务映射一致性。
- OpenFoot 查询赛季表达。
- 次要源球队映射准备与同场比赛关联验收。
- timer 模板与实际确认频率一致。

### 1.2 不做的事

- 不重写预测、计分、结算、周榜封存、等级和快照业务规则。
- 不引入 Redis、消息队列、多进程任务平台或新调度框架。
- 不以一次性补库或忽略错误替代首次发现和补偿机制。
- 不做防御性、安全性、健壮性专项；不为未出现的场景预埋机制。
- 不默认提高当前 15 分钟 timer 频率。
- 不自动提交、推送、重启服务、运行真实写库同步或调整线上数据。

### 1.3 开发纪律

1. 从当前本地仓库继续，不重新克隆或覆盖已合并成果。
2. 改代码前确认没有正在运行的任务，并备份要改的文件。
3. 每节点先补能复现问题的测试，确认失败，再做最小实现。
4. **测试策略：**节点内只跑受影响测试文件（见各节点“相关测试”）；`typecheck`、`npm test`、`build` 只在 PS11 统一执行一次，节点内不跑全量。
5. 需要真实 PostgreSQL 时只用明确隔离的测试库；缺少连接就标“未验收”，不把跳过说成通过。
6. 真实接口请求、运行库写入、映射导入和服务变更另行安排；密钥不进入 Git、文档或日志。
7. 涉及历史赛果采纳、异常状态建档语义或旧失败任务迁移的歧义，先报告再实施。
8. PS06 按本次修订与 PS03、PS05、PS09 联动实施；定向验证取这些节点已列出的受影响测试文件，必要用例补在其中，不自行新增测试项目。不得以只通过适配器和 mapper 单测代替真实应用调用链验收。
9. 开发、测试及可能间接触发的构建只在隔离工作树 `/home/football-provider-dev` 执行；不得写 `/home/football/dist`。指定 OpenCode 模型开发，主 agent 独立审查差异与执行结果。

## 2. 已核实事实与证据边界

以下运行状态是审计时快照，实施前重查。

| 事项 | 审计事实 | 证据边界 |
|---|---|---|
| 首次真实导入 | 本地库有英超 280 场 scheduled；全赛季校验 100 条 MATCH_NOT_FOUND | 未覆盖所有来源与联赛 |
| 联赛阻断 | 锁内按 job_type 读最新日志；英超执行后西甲被 not_due_after_lock 跳过 | 已用内存仓库独立复现 |
| 首次发现 | 球队映射齐全时，首次发现 live/finished/postponed/cancelled/abandoned 均触发 MATCH_NOT_FOUND | 不只影响历史已结束比赛 |
| 失败状态 | items_failed>0 时持久化状态仍可为 success；HTTP 返回后即更新联赛成功时间 | 数据库只读查询与模拟批次均已核实 |
| 配额延后 | 预算拒绝且未发请求时，Registry 可返回空数组 | 模拟预算复现；不等同“没有比赛” |
| 次要源映射 | 审计时仅 football-data 有 20 条球队映射、280 条比赛映射 | 缺映射忽略观察符合规范，属验收缺口 |
| 5d 直播 | 一次假 HTTP 返回英超+西甲，串行读取结果为 1 场、0 场 | 第二联赛被源级节流挡在共享缓存之前 |
| 5d 过滤 | 2025 假比赛被标为请求的 2026 赛季并通过归一化；西甲日期查询可返回英超 | 证实适配器缺口，未证实运行库污染 |
| 联赛 ID 覆盖 | 配置接受源 ID 999，业务归一化却拒绝对应比赛 | 特定覆盖配置下复现 |
| OpenFoot 赛季 | 中超 season_ref=2026 被拼为 season=2026/2027 | 全季入口错误；默认 historical 角色，未证明定时任务受影响 |
| timer | 实际安装 15 分钟，仓库模板 10 分钟 | 15 分钟为用户确认值 |

已有测试通过不能替代上述场景：审计中两组定向测试分别 54 项、28 项通过，独立复现仍揭示缺口。这些数字是历史记录，不是后续验收结果。

主要依据：`docs/MVP__v1.0.md` §32.2；`docs/MVP2.0__PROVIDER_VERIFICATION_RESULT__v1.0.md`（历史接口事实）；`docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md`；现有 `src/application/provider-*.ts`、`src/provider/*.ts` 与共享 runtime。

### 2.1 本次补充证据与尚未证明的事项

- 真实 5d 联赛详情已逐一确认五大联赛当前赛季为 `26/27`；比赛详情样本 `league_season_id=null`，日期列表样本没有逐场赛季字段。不得将这些字段视为始终存在。
- 官方文档将联赛赛程 `season` 参数描述为该赛季开球窗口的快捷方式。英超 `season=26/27` 查询成功；`25/26` 返回 HTTP 403 `insufficient_plan`，不能当作历史赛季没有比赛。
- 英超 `season=26/27` 与日期窗口组合请求返回对应日期的 5 场比赛及比赛 ID；这仅证明该组合被接受，尚不能证明两个筛选条件必定取交集，也未证明所有联赛、所有页均正确。最终采纳不得依赖此未证实语义。
- 当前调用链先归一化并校验赛季，再做跨源关联，导致无赛季字段的 5d 数据在读取既有比赛身份之前被拒绝；窗口加载中跳过失败行还有误报空结果成功的风险。已有比赛映射直接命中也需补核对，不能无条件信任映射。
- 定时器已按授权暂停并禁用开机启动；恢复前必须重查状态。此前失败构建改写过运行目录产物，随后有 5 轮任务；日志中的 17,327 次是写入操作次数，不是受影响行数，具体业务影响尚未核实。

上述证据不等同节点验收完成。接口结果、测试输出与未验收范围应在节点记录中分别列出，禁止记录凭据。

## 3. 任务表

| 编号 | 任务 | 优先级 | 依赖 | 属性 |
|---|---|---|---|---|
| PS01 | 按联赛隔离到期与重试状态 | P1 | 无 | 已证实缺陷 |
| PS02 | 主赛程源首次发现统一建档 | P1 | 无 | 已证实缺陷，部分语义待确认 |
| PS03 | 请求成功与同步完成分离 | P1 | PS01 | 已证实缺陷 |
| PS04 | 配额不足明确延后 | P1 | PS03 | 已证实缺陷 |
| PS05 | 5d 共享直播结果完整分发 | P1 | 无 | 已证实缺陷 |
| PS06 | 5d 身份确认、联赛过滤与赛季核验 | P1 | PS02、PS03、PS05、PS07 联动 | 调用链修复，与 PS09 联合验收 |
| PS07 | 生效联赛映射统一 | P1 | 无 | 特定配置下缺陷 |
| PS08 | OpenFoot 源赛季表达 | P2 | PS06、PS07 | 特定入口缺陷 |
| PS09 | 次要源映射准备与关联验收 | P1 | PS05～PS08 | 接线与验收缺口 |
| PS10 | timer 模板与运行边界说明 | P2 | PS01、PS03、PS04 | 模板修正 |
| PS11 | 最终验证与真实环境验收 | P1 | PS01～PS10 | 验收 |

节点可分别开发；同一 Registry 文件的修改串行整合。PS01 与 PS03 的持久化状态契约先统一再实现。

收尾顺序：先核对 PS02 赛程权威来源权限；串行整合 PS06 身份与赛季解析及 PS03/PS05 结果传播；完成 PS09 映射清单、隔离导入和同场关联；最后执行 PS11，并形成运行产物恢复及历史影响处理方案。不得把“缺映射”和“历史影响”转为无限期遗留事项。

## 4. 逐项要求

### PS01：按联赛隔离到期与重试

**问题：**外层按联赛选择，锁内却按任务类型查全局日志。full 可退化为每 24 小时最多一个联赛；future 也受正常周期间隔限制，无法逐轮补齐联赛。

**涉及文件：**`src/application/provider-sync-job.ts`、`src/application/provider-sync-dispatcher.ts`、`src/runtime/application-runtime.ts`、`src/runtime/scheduled-jobs.ts`、`src/provider/registry.ts`；契约如需扩展再动 `src/infrastructure/repositories.ts`、`src/infrastructure/cloudbase-app-repository.ts`、`src/domain/types.ts`、`src/schema/collections.ts`、`src/schema/indexes.ts`。

**步骤：**

1. 先在 `provider-sync-job.lock-eligibility.test.ts` 补“英超刚执行，西甲仍可执行”的失败测试。
2. 资格判断、运行日志、退避状态的统一键至少包含 `(job_type, league_id)`；锁保留任务级互斥，不增加并行。
3. dispatcher、锁内复查、持久化查询使用同一维度；重试不读另一联赛的 deferred/failed 记录。
4. 旧无 league_id 日志不扩散成所有联赛成功，也不重跑已完成账本。
5. 契约若变，内存、CloudBase、PostgreSQL 三种适配同步修改。

**验收：**同一周期内多联赛可分别执行；同联赛成功后按周期跳过；锁内重复调用仍被挡住；联赛间不共享退避。

**相关测试：**`src/application/provider-sync-job.lock-eligibility.test.ts`、`src/application/provider-sync-dispatcher.test.ts`

### PS02：主赛程源首次发现统一建档

**问题：**`provider-fixture-sync.ts` 仅 scheduled 可触发 discover，其他状态依赖已有 MATCH。

**涉及文件：**`src/application/provider-fixture-sync.ts`、`provider-schedule-sync.ts`、`provider-status-sync.ts`、`provider-result-sync.ts`。

**步骤：**

1. 在 `provider-fixture-sync.test.ts` 增加球队映射齐全、比赛不存在时各状态的测试。
2. 把主源“确保比赛及来源映射存在”与“应用状态/赛果”拆开，复用现有服务；不靠删错误或跳过整条比赛。
3. 仍只有赛程权威来源可首次建档；5d/of/sp 继续匹配已有比赛，不复制比赛。
4. 已结束比赛仍走既有权威源采纳与结算入口；不为历史比赛生成预测或直接改排行榜。
5. 延期但无可靠开球时间、取消、中止等若规范不足以确定合法记录，先报告，不捏造 kickoff_at 或轮次。
6. 同一 fixture 重复输入复用原 match_id，不重复触发有效结算。

**验收：**合法主源 fixture 首次出现不因 MATCH 不存在失败；重复输入幂等；非法数据仍进异常流程；次要源权限与历史账本不变。

**相关测试：**`src/application/provider-fixture-sync.test.ts`、`src/application/provider-status-sync.test.ts`

### PS03：请求成功与同步完成分离

**问题：**Registry 在 HTTP 返回后即 markSuccess，球队请求成功也会推进比赛任务的成功时间；批次逐场失败最终仍写 success，持久化与补偿资格不一致。

**涉及文件：**`src/provider/registry.ts`、`src/infrastructure/cloudbase-provider-league-state.ts`、`src/application/provider-sync-job.ts`、`src/runtime/scheduled-jobs.ts`。

**步骤：**

1. 补“球队成功但比赛加载失败”“HTTP 成功但全部入库失败”“部分入库成功”的失败测试。
2. 请求级时间只用于节流和额度；业务完成时间在批次满足完成条件后才推进。
3. 沿用现有 failed/deferred 状态表达结果，不新增 partial 等中间态。
4. 部分失败保留已写入结果，失败部分按既有退避重试；允许幂等重放整批，不建逐条任务队列。
5. 正常周期控制成功后的下一轮，失败/延后按重试资格控制。
6. 摘要、持久化日志、联赛完成状态表达同一结果。旧错误 success 的补偿另行列出，不自动重置全部状态。
7. 区分其他联赛的正常过滤、真实零比赛、缺映射/关联歧义、目标比赛数据无效和预算未执行。窗口加载器不得静默丢弃应处理的失败行后报零条成功；保留原始条数、有效采纳、未关联与失败原因的可观察结果，不把未关联计入有效采纳。
8. 缺映射沿用既有“不采纳观察”语义并留下原因，不把每条未关联观察自动升级为整批失败；应处理的目标比赛数据无效计入失败及补偿。主源成功而次要源不可用时，按既有规则判断主源完成，但单独披露次要源未核验，不能据此宣称多源验收通过。

**验收：**100 条失败不得持久化为全量成功；球队请求不代表比赛同步完成；跨 tick 能进入补偿；重复补偿不重复产生业务效果。

**相关测试：**`src/application/provider-sync-job.test.ts`、`src/provider/registry.test.ts`

### PS04：配额不足明确延后

**问题：**非 live 任务的预算拒绝可能在 Registry 被吞为 `[]`，上层无法区分无数据与未执行。

**涉及文件：**`src/provider/registry.ts`、`src/provider/budget.ts`、`src/application/provider-sync-job.ts`、`src/application/provider-fixture-loader.ts`。

**步骤：**

1. 模拟日配额耗尽，断言请求数为零且结果不是空数据成功。
2. 通过现有异常或明确结果向上传递延后原因，复用已有 deferred 机制。
3. next_attempt_at 用现有可获取的预算重置时间与退避规则。
4. 配额拒绝不推进业务完成时间；真正成功返回零比赛仍是合法空结果。
5. post_finish_verify 的备用源分支存在同样问题，一并核对。

**验收：**真实空数据、预算延后、失败三者可区分；到期后可继续。

**相关测试：**`src/provider/budget.test.ts`、`src/application/provider-sync-job.deferral.test.ts`

### PS05：5d 直播共享结果先分发、后限制新请求

**问题：**源级 liveRequestDue 在共享缓存读取前执行；首个联赛请求后，其他联赛读不到本轮数据。

**涉及文件：**`src/provider/registry.ts`、`src/provider/fivedollar-adapter.ts`、`src/application/provider-window-loader.ts`。

**步骤：**

1. 在 `src/provider/registry.test.ts` 用同时含英超、西甲的假 live 响应复现第二联赛为零。
2. 同一 tick 优先复用共享结果；只有创建新请求时检查源级频率与配额。
3. 每个联赛独立筛选结果。
4. 实际请求仍只计费一次，业务完成状态服从 PS03。
5. PS06 的身份与赛季核验使用本地权威比赛账本，不为每个联赛增加直播赛季查询；不引入全季 ID 目录、长期缓存或新 TTL。共享原始响应不按某个联赛补写赛季，避免污染后续联赛读取。

**验收：**一次 HTTP，多联赛各收自己的比赛；未到允许时间不新增请求。

**相关测试：**`src/provider/registry.test.ts`、`src/provider/registry-league-cache.test.ts`

### PS06：5d 身份确认、联赛过滤与赛季核验

**问题：**适配器直接补目标赛季会误采旧数据；仅删除默认值、缺赛季一律拒绝又会阻断正常直播。当前先校验赛季、后关联比赛，无法利用权威账本中已确定的赛季，且失败行可能被窗口加载静默跳过。

**涉及文件：**`src/provider/fivedollar-adapter.ts`、`src/provider/fixture-mapper.ts`、`src/domain/config.ts`、`src/application/provider-cross-source.ts`、`src/application/provider-fixture-sync.ts`、`src/application/provider-window-loader.ts`；结果传播联动 PS03 的 job/service 和 Registry，其他实际使用该解析过程的 full/near/live/post-finish/reconcile 入口一并核对，仅修改必要调用点。

**步骤：**

1. 在现有测试中先复现“无赛季但能确认同场比赛被拒绝”“明确旧赛季冲突被改标”“失败行丢失后报零条成功”。保留原有旧赛季混入、混合联赛、跨年与自然年用例。
2. 在应用层统一次要源身份解析：先验证来源、有效联赛映射、外部比赛 ID、主客队 ID 与开球时间等必要身份字段，再确定关联比赛及其赛季，最后执行完整状态/比分归一化和既有应用规则。不为通过身份核验绕过比分、状态等校验；纯 mapper 不访问仓储。
3. 已有 `(provider, provider_match_id) → match_id` 时读取实际比赛，核对有效联赛与目标赛季、主客队映射和必要身份一致性。映射指向不存在的比赛、其他联赛或其他赛季时拒绝，不无条件信任旧映射。球队变化等已有业务异常沿用原处理规则，不偷偷覆盖账本。
4. 无比赛映射时，仅用人工确认的球队映射、有效联赛、目标赛季及既有开球时间容差，在主赛程源建立的比赛中寻找唯一候选；沿用现有主客队顺序和欧洲联赛 30 分钟、中超 5 分钟容差，不新增名称模糊匹配。零个候选或多个候选均不采纳，分别记录缺映射/无匹配/歧义；唯一候选按现有幂等方式建立来源映射。
5. 上游无赛季时，以身份已确认的比赛账本赛季作为核验依据，显式传递独立的解析上下文；记录依据为已有比赛映射或唯一候选。保留原始响应，不向原始 `league.season` 或共享缓存补写目标值。缺少依据时拒绝采纳，不用当前年份、固定 `2026`、日期年份或未经登记的边界猜赛季。
6. 上游明确提供赛季时保留并校验，格式转换只用已核实规则；与账本或目标赛季矛盾时留下冲突并拒绝，不以账本值覆盖冲突。该流程不赋予 5d/of/sp 首次建档权限，不扩大它们的赛果采纳角色。
7. 全季/日期查询使用明确登记的源赛季参数；按联赛请求仍过滤目标 `source_league_ref`。查询成功或参数被接受不等同逐场赛季已确认，采纳仍服从身份与赛季核验。目标赛季不自动跟随上游 `current` 切换；直播全量响应由 PS05 一次共享后分发，使用本地账本核验，不增加逐联赛赛季目录请求。
8. 将未关联、歧义、明确冲突和目标比赛处理失败传到 PS03 的可观察结果；真正空数据与过滤掉其他联赛不制造失败，目标数据无效不能静默变为成功。预算不足沿用 PS04 deferred，时间与额度配置不变。

**验收：**无赛季但已有可靠身份的 5d 直播能更新同一场比赛；旧赛季/联赛冲突、错误映射与歧义无法通过；重复输入不新增比赛或重复结算；一次直播请求仍能供多个联赛使用，且不新增赛季核验 HTTP；窗口、逐场同步和调度结果一致，PS09 同场关联验收完成后才关闭本节点。

**相关测试：**保留 `src/provider/extended-adapters.test.ts`、`src/provider/fixture-mapper.test.ts`；应用身份与异常传播补在本文已有的 `src/application/provider-cross-source.test.ts`、`src/application/provider-fixture-sync.test.ts`、`src/application/provider-sync-job.test.ts`；共享分发与预算补跑 PS03～PS05 已列出的实际受影响文件。仅在这些既有测试范围内补用例，不另建测试项目；全量仍留 PS11。

### PS07：统一有效联赛映射

**问题：**配置支持覆盖 5d/of 的 source_league_ref，归一化和跨源匹配却读固定 provider_refs。

**涉及文件：**`src/provider/sources.ts`、`src/provider/fixture-mapper.ts`、`src/application/provider-cross-source.ts`、`src/domain/config.ts`、`src/runtime/application-runtime.ts`。

**步骤：**

1. 增加配置覆盖为 999 后假响应能被同一有效映射识别的测试。
2. 让请求、归一化、跨源关联共用 runtime 已解析的映射，不各自再读环境变量。
3. 保持默认静态配置兼容；二选一并明确：支持覆盖，或配置阶段拒绝不支持的值。
4. 多个内部联赛指向同一源 ID 时沿用既有约束，不按名称猜测归属。

**验收：**配置被支持时全链路一致；不支持时配置阶段失败，而非请求 200 后逐条拒绝。

**相关测试：**`src/provider/sources.test.ts`、`src/application/provider-cross-source.test.ts`

### PS08：OpenFoot 源赛季表达

**问题：**fetchSeasonFixtures 无条件拼成开始年/次年，自然年中超因此生成错误参数。

**涉及文件：**`src/provider/openfoot-adapter.ts`、`src/provider/sources.ts`、`src/domain/config.ts`。

**步骤：**

1. 在 `extended-adapters.test.ts` 断言中超请求 season=2026，而非 2026/2027。
2. 分开表达内部 season_id 与源查询赛季值；跨年格式用已核实的写法。
3. 保持 OpenFoot 中超 historical 角色，不借修参数提升为赛程/赛果权威。

**验收：**自然年与跨年源参数分别正确；历史角色与采纳优先级不变。

**相关测试：**`src/provider/extended-adapters.test.ts`、`src/provider/sources.test.ts`

### PS09：次要源映射准备与关联验收

**定性：**缺映射时忽略次要观察符合规范，不改为猜测关联；但鉴权 200 不代表备用源能参与业务。

**涉及文件：**`scripts/providers-map-teams.mjs`、`src/application/provider-cross-source.ts`、`src/application/provider-reconcile.ts`。

**步骤：**

1. 检查现有脚本输入输出；当前只输出报告，不能描述成已导入映射。
2. 为启用来源列出外部球队 ID → 已有内部 team_id 的清单，人工确认；不为同一支球队再建内部球队，不用模糊名称自动落库。
3. 需要导入能力时按实际需要实现，导入前先演练一遍，不建自动匹配系统。
4. 用一场受控比赛验证主源与次要源落到同一 match_id；缺映射时不采纳且原因可见。
5. HTTP 200 但零场关联时，不标记“多源赛果核验已验收”。
6. 由开发方准备可审查清单，列出来源、外部球队 ID/名称、内部球队 ID/名称及核对依据；人工确认对应关系，取证、整理和演练由开发方完成，现有来源角色不变。
7. 已确认清单先在隔离环境 dry-run/导入演练；用一场无赛季 5d 观察验证 PS06 身份解析、同一 match_id 关联、赛果采纳/冲突及重复输入，核对赛季一致、无重复比赛及结算。运行库导入仍另行授权。
8. 当前 `provider-tools.test.ts` 经 `cloudbase:schema` 间接构建失败是本节点必须查明并修复的阻塞；保留真实错误，修复后在隔离工作树复跑完整指定测试，不以名称筛选通过替代完整结果，不再次改写运行产物。

**验收：**至少一场受控比赛串通主源、次要源、结果采纳与冲突规则；真实覆盖另行记录。

**相关测试：**`src/application/provider-cross-source.test.ts`、`src/scripts/provider-tools.test.ts`

### PS10：timer 模板与运行边界

**涉及文件：**`ops/vps/football-jobs.timer`、`ops/vps/README.md`。

1. 模板从 10 分钟改为已确认的 15 分钟：`OnCalendar=*-*-* *:00/15:00`。
2. 保留原有 Persistent、随机延迟设置；不改实际安装的 unit。
3. README 说明：短退避与更短的比分轮询只在下次 tick 唤起时执行，15 分钟调度无法提供更高刷新频率。
4. 提高实时性是单独决策，不在本期启用。

**验收：**模板语法合法，文档写明 15 分钟的实际边界。

```bash
systemd-analyze calendar '*-*-* *:00/15:00'
```

### PS11：最终验证与真实环境验收

全部代码改完后**统一执行一次**：

```bash
npm run typecheck
npm test
npm run build
npm run cloudfunction:build
```

验证要点：

- 隔离 PostgreSQL 下任务状态跨 tick 持久化（不依赖进程内 Map）。
- 同一轮或连续 tick 中全部已启用赛程联赛可推进，而非仅英超。
- 首次发现、同联赛重放、部分失败补偿、配额延后、次要源缺映射均有明确结果。
- PS06/PS09 经实际应用调用链证明：无赛季但可确认身份可采纳，错误映射/明确赛季冲突不可采纳；共享直播一次 HTTP，不新增逐联赛赛季核验请求。不能仅用 mapper 单测或 HTTP 成功关闭节点。
- 分别记录主源完成、次要源有效关联、未关联/歧义、目标数据失败与预算延后；计数与业务成功时间一致。PS09 完整测试的构建阻塞必须解除。
- 小程序未改动则不需构建；如改动传输或展示代码，用 `npx vitest run miniprogram` 补验，不用 `node --test`。

真实环境按需分步记录：受控执行后检查比赛数量、状态分布、任务完成时间、失败数与映射覆盖，不只看 HTTP 200；CloudBase 缺凭据或未实际覆盖的部分标“未验收”。真实同步前先确认没有 timer 或另一次 tick 在跑，VPS 与 CloudBase 不同时处理同一账本。

**运行环境与历史影响闭环：**

1. 保持已授权的 timer 暂停及禁用开机启动，实施前只读复查 timer、jobs、API 状态与实际运行路径；文档修订不授权恢复服务。
2. 只读核查失败构建后 5 轮任务的时间、日志及可用账本/快照，按联赛、比赛 ID、实际字段变化与结算记录列出影响。写入操作次数、退出码 0、结算尝试为零都不能证明无影响；缺少前后证据时明确哪些变化无法追溯。
3. 从隔离工作树通过验收的同一版本生成可追溯产物，列出运行目录备份、替换、回退及验证步骤。恢复产物、重启服务、重新启用 timer 均须另行授权，不直接覆盖现有运行目录。
4. 结合 PS02 旧来源权限确认及修复后的任务状态，列出需补跑的具体联赛/任务/比赛、理由、幂等保障和执行后核对项；不清空状态、不全库回滚、不自动重复结算。方案准备和只读核查是本期收尾工作，运行写入及补偿执行另行授权。
5. PS11 报告分别列代码验证、隔离数据库验证、真实来源关联覆盖、历史影响核查及运行恢复/补偿是否执行；等待授权或证据不足的项保持未完成/未验收，不并入通过结论。

## 5. 验收矩阵

| 编号 | 场景 | 必须观察到的结果 | 状态 |
|---|---|---|---|
| A01 | 英超后紧接西甲 | 西甲可进入加载，不被英超日志挡住 | 定向通过（内存仓库） |
| A02 | 同联赛同周期重复任务 | 按周期跳过，不重复产生业务效果 | 定向通过（内存仓库） |
| A03 | 联赛 A deferred、B 到期 | B 不继承 A 的退避状态 | 定向通过（内存仓库） |
| A04 | 主源首次发现各状态 | 建档并按原规则应用，不因 MATCH 缺失报错 | 定向通过（内存仓库） |
| A05 | 首次已结束比赛与重复输入 | 赛果采纳规则有效，不重复结算或虚构预测 | 定向通过（内存仓库） |
| A06 | 球队成功、比赛失败 | 业务完成时间不提前推进，可补偿 | 定向通过（内存仓库） |
| A07 | 部分 fixture 失败 | 摘要、日志与重试资格一致 | 定向通过（内存仓库） |
| A08 | 配额耗尽 / 真实零比赛 | 前者延后，后者为合法空结果 | 定向通过（内存仓库） |
| A09 | 同轮 5d 多联赛直播 | 一次请求，逐联赛完整分发；本地身份核验不额外请求赛季目录 | 待联合验收 |
| A10 | 旧赛季或其他联赛混入 | 不改标目标赛季，不混入目标联赛；明确冲突不被账本值覆盖 | 待联合验收 |
| A11 | 自定义源联赛 ID 与 OpenFoot 赛季 | 映射一致或配置阶段拒绝；源参数正确 | 定向通过（内存仓库） |
| A12 | 次要源有/无球队映射 | 清单人工确认、隔离演练、同场正确关联；缺映射不猜测采纳 | 待联合验收（脚本离线已验，真实清单缺失） |
| A13 | timer 模板与说明 | 统一 15 分钟并写明刷新限制 | 已修改，`systemd-analyze calendar` 通过 |
| A14 | 无赛季但已有比赛映射 | 核对身份后以账本赛季处理；保留原始响应与解析依据 | 定向通过（内存仓库） |
| A15 | 无赛季、无比赛映射 | 人工球队映射及既有容差唯一命中后关联；零/多候选不采纳 | 定向通过（内存仓库） |
| A16 | 错误映射、失败行与真实空数据 | 错映射拒绝；目标数据失败不变成零条成功；缺映射原因可见 | 定向通过（内存仓库） |
| A17 | 工具脚本完整测试与间接构建 | 原构建错误查明且完整指定测试通过；运行 dist 未被改写 | 待修复（`provider-tools.test.ts` 未执行） |
| A18 | 历史影响与运行恢复准备 | 5 轮影响及证据缺口、恢复产物和补偿清单可审查；执行权限单列 | 待核查 |

“定向通过（内存仓库）”指本节 §7.1 列出的定向测试在内存仓库上通过，未覆盖隔离数据库、真实接口与运行产物，不能替代 PS11。

每节点记录：修改文件、复现测试的失败结果、修复后结果、未验收项。不得预填通过数量。

## 6. 待确认边界

- PS02 不改变权威赛果采纳和结算规则；规范不支持某状态首次建档表示时，先给出具体冲突。
- PS09 的映射清单需人工确认，不自动写运行库。
- PS02 的旧 `api_football` 首次建档权限先依据现行规范、配置与历史实现核对；仍有冲突时给出具体证据供用户决策，不擅自移除或提升权限。
- 旧历史任务是否重置、补跑哪些联赛，按修复后的状态模型给出补偿计划，不清空同步状态或比赛记录。
- 5d 缺少赛季字段时按 PS06 以已确认比赛身份确定赛季，不将“一律拒绝”或“每轮新增五个赛季查询”作为交付方案；仍需新接口证据时先列最小查询与额度成本。

## 7. 实施进度与证据（2026-11-14 回填）

本节记录实际发生的开发与测试结果。除本节明确列出的命令输出外，其余内容仍为待验收计划，不得视为已完成。

### 7.1 定向验证（实际执行）

工作树 `/home/football-provider-dev`，HEAD `e2868d8` 加未提交改动，2026-11-14 执行：

```bash
npx vitest run src/provider/extended-adapters.test.ts src/provider/fixture-mapper.test.ts \
  src/application/provider-cross-source.test.ts src/application/provider-fixture-sync.test.ts \
  src/application/provider-sync-job.test.ts src/application/provider-sync-job.deferral.test.ts \
  src/provider/registry.test.ts src/provider/budget.test.ts src/application/provider-window-loader.test.ts \
  src/application/provider-sync-job.lock-eligibility.test.ts src/application/provider-sync-dispatcher.test.ts \
  src/provider/sources.test.ts src/provider/registry-league-cache.test.ts
```

结果：**13 个文件、193 项全部通过**（0 失败）。

| 测试文件 | 项数 | 对应节点 |
|---|---|---|
| `src/provider/extended-adapters.test.ts` | 15 | PS06、PS08 |
| `src/provider/fixture-mapper.test.ts` | 24 | PS06、PS07 |
| `src/application/provider-cross-source.test.ts` | 20 | PS06、PS07、PS09 |
| `src/application/provider-fixture-sync.test.ts` | 40 | PS02、PS06、PS09 |
| `src/application/provider-sync-job.test.ts` | 32 | PS03、PS06 |
| `src/application/provider-sync-job.deferral.test.ts` | 6 | PS04、PS05 |
| `src/provider/registry.test.ts` | 17 | PS03、PS05 |
| `src/provider/budget.test.ts` | 6 | PS04 |
| `src/application/provider-window-loader.test.ts` | 4 | PS03、PS06 |
| `src/application/provider-sync-job.lock-eligibility.test.ts` | 12 | PS01 |
| `src/application/provider-sync-dispatcher.test.ts` | 3 | PS01 |
| `src/provider/sources.test.ts` | 9 | PS07、PS08 |
| `src/provider/registry-league-cache.test.ts` | 5 | PS05 |

这不是全量验收：未执行 `typecheck`、`npm test`、`build`、`cloudfunction:build`，未连接真实数据库、真实接口或运行目录。`src/scripts/provider-tools.test.ts` 未纳入本次执行（原因见 §7.4）。

开发过程中修掉的一处测试自身缺陷：`provider-window-loader.test.ts` 原有两条断言把新增字段 `candidateMatchIds` 写成 `Set`，而 `ProviderFixtureBatchItem.candidateMatchIds` 的类型是 `readonly string[]`；已按类型改为数组，未放宽其他断言。

### 7.2 各节点实施状态

| 节点 | 代码状态 | 定向证据 | 尚未验收 / 缺口 |
|---|---|---|---|
| PS01 | 已实现：资格判断、运行日志与退避按 `(job_type, league_id)` 统一维度；锁仍为任务级互斥 | lock-eligibility 12、dispatcher 3 | 隔离 PostgreSQL 跨 tick 持久化未验证 |
| PS02 | 已实现：主源首次发现即建档，覆盖 scheduled/live/finished 等状态；重复输入复用 `match_id`；次要源不建档 | fixture-sync 40（含首次发现已结束、live、重复输入用例） | 旧 `api_football` 首次建档权限未确认（见 §7.5 Q1） |
| PS03 | 已实现：请求级时间只用于节流，业务完成时间在批次满足条件后推进；批次失败不持久化为全量成功；新增 `items_window_input`/`items_window_filtered`，`items_read` 原口径未改 | sync-job 32、registry 17、window-loader 4 | 真实库状态时间戳与补偿联动未验证 |
| PS04 | 已实现：预算拒绝走既有 `deferred` 并带原因，不再被吞为空数组成功 | budget 6、deferral 6 | 真实日额度耗尽场景未验证 |
| PS05 | 已实现：同 tick 优先复用共享直播结果，只有新建请求才检查源级频率与配额；请求间隔单独作为延后原因，缺失时不再误判来源不可用并触发额外回退请求 | registry 17、league-cache 5 | 真实 5d 多联赛同时在线的分发未验证 |
| PS06 | 已实现：修复 5d `mapFixture` 未定义 `home`；身份预判只读（不写映射）；候选在全局范围内判定唯一；不同来源同 ID 不碰撞；窗口内失败行不再静默丢弃 | 上述 6 个相关文件 | 与 PS09 联合验收未做 |
| PS07 | 已实现：`providerLeagueRefs` 贯通请求、归一化与跨源关联，不再各自读环境变量 | sources 9、cross-source 20 | 覆盖配置的端到端未验证 |
| PS08 | 已实现：分离内部 `season_id` 与源查询赛季值，自然年与跨年写法分别输出 | extended-adapters 15 | 真实 OpenFoot 请求未验证 |
| PS09 | 脚本增强：`missing_target`、`conflict`、`league_mismatch` 独立报告；中文队名不再被清空后产生错误建议；同一确认同时出现在两种输入字段时按冲突处理 | 4 个虚构样例离线执行（§7.3） | 真实映射清单缺失；`provider-tools.test.ts` 未执行 |
| PS10 | 已实现：模板改 `OnCalendar=*-*-* *:00/15:00`，README 补调度边界说明 | `systemd-analyze calendar '*-*-* *:00/15:00'` 通过 | 实际安装 unit 未改（符合约束） |
| PS11 | 未执行 | 无 | 见 §7.4 |

### 7.3 PS09 离线校验记录（全部为虚构数据）

四个样例由脚本 `scripts/providers-map-teams.mjs --input <file>` 直接执行，均退出码 0：

| 样例场景 | 期望行为 | 实际输出要点 |
|---|---|---|
| 已确认映射指向不存在的本地球队 | 报 `missing_target`，不崩溃、不计为 confirmed | `missing_target: 1`，`team_id: null`，`mapping_team_ids: ["missing-id"]` |
| 同一来源 ID 被确认到两个本地球队 | 报 `conflict`，不取最后一条 | `conflict: 1`，`mapping_team_ids: ["test-a","test-b"]` |
| 中文队名（`上海申花`） | 不产生错误建议匹配 | `unmatched: 1`，`suggested_team_id: null` |
| 同一确认同时出现在 `confirmed_mappings` 与另一输入字段 | 按冲突处理，不静默确认 | `conflict: 1`，两个目标 ID 均列出 |

这些样例只证明脚本报告的判定逻辑，不构成 PS09 验收：仍未使用真实球队数据，也未做隔离库 dry-run/导入演练与同场关联。样例输入为临时文件，未纳入版本库。

### 7.4 未完成与阻塞

1. **`src/scripts/provider-tools.test.ts` 未执行。** 该文件已有新增用例（+178 行），但此前运行会经 `cloudbase:schema` 间接触发构建并改写 `/home/football/dist`，构建失败根因尚未查明。PS09 第 8 步与 PS11 均要求解除此阻塞，当前状态为未修复。
2. **PS09 真实映射清单缺失。** 无经人工确认的“外部球队 ID → 内部 `team_id`”清单，未做隔离环境 dry-run/导入演练，未用受控比赛验证主源与次要源落到同一 `match_id`。
3. **PS11 未执行。** `npm run typecheck`、`npm test`、`npm run build`、`npm run cloudfunction:build` 及隔离 PostgreSQL 下跨 tick 持久化验证全部未运行。
4. **PS06/PS09 未联合关闭。** A09、A10、A12 仍为待联合验收。
5. **运行环境未恢复。** 2026-11-14 只读复查：`football-jobs.timer` 为 `inactive` / `disabled`，`football-jobs.service` 为 `inactive`；`/home/football/dist` 仍为 11-12 的产物，未被本轮改写。恢复 timer、替换运行产物、重启服务均未获得授权。
6. **历史影响未核查。** 失败构建后 5 轮任务（17,327 次写入操作）按联赛/比赛/结算的实际影响尚未核实，A18 仍为待核查。

### 7.5 待用户确认

| 编号 | 问题 | 现状 | 需要决定 |
|---|---|---|---|
| Q1 | 旧 `api_football` 是否保留首次建档权限 | 代码中 `SCHEDULE_AUTHORITY_PROVIDERS` 仍含 `ApiFootball`、`FootballData`、`Bsd`；现行文档只明确五大联赛用 football-data、中超用 bsd | 保留现状 / 仅保留 football-data 与 bsd / 按联赛白名单 |
| Q2 | PS09 真实映射数据来源 | 无真实清单，只有虚构样例 | 由用户提供可审阅数据，或授权一次限定范围的只读查询 |
| Q3 | `provider-tools.test.ts` 的构建阻塞 | 未查明，且可能改写运行目录产物 | 是否授权在隔离工作树运行 `npm run cloudbase:schema` 定位根因（不写 `/home/football/dist`） |
| Q4 | 运行环境恢复 | timer 停用、运行产物状态待确认 | 何时授权恢复 timer、替换产物与历史影响核查 |

## 8. 完成定义

PS01～PS11 验收项完成，节点记录与最终全量验证有实际输出，VPS/CloudBase 验证层级如实标注；多联赛可初始化、合法状态可首次发现、失败可补偿、多源可区分有数据与有效采纳，才标记本期功能完成。

PS06 与 PS09 必须联合关闭；无赛季直播正常更新、旧数据/错误关联拒绝、失败结果可见、共享请求不增加核验成本均需实际验证。历史影响核查及恢复/补偿方案必须可审查；尚未授权执行或真实环境未验收的部分单列，不能用文档更新、部分测试通过或降级停用功能宣布整体完成。
