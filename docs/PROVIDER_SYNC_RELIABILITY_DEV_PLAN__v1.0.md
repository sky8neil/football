# Provider 同步完整性与多源接线优化开发文档 v1.0

> **For Hermes:** 逐节点实施，每节点只跑受影响文件的单测；全量测试、typecheck 与构建只在最后统一执行一次。
>
> 状态：待评审、待开发；本文落盘不代表授权修改服务、数据库或部署。
> 审计日期：2026-11-13。代码基线：`e2868d8`，分支 `feat/resource-point-opt`。
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
- 不默认提高当前 3 分钟 timer 频率。
- 不自动提交、推送、重启服务、运行真实写库同步或调整线上数据。

### 1.3 开发纪律

1. 从当前本地仓库继续，不重新克隆或覆盖已合并成果。
2. 改代码前确认没有正在运行的任务，并备份要改的文件。
3. 每节点先补能复现问题的测试，确认失败，再做最小实现。
4. **测试策略：**节点内只跑受影响测试文件（见各节点“相关测试”）；`typecheck`、`npm test`、`build` 只在 PS11 统一执行一次，节点内不跑全量。
5. 需要真实 PostgreSQL 时只用明确隔离的测试库；缺少连接就标“未验收”，不把跳过说成通过。
6. 真实接口请求、运行库写入、映射导入和服务变更另行安排；密钥不进入 Git、文档或日志。
7. 涉及历史赛果采纳、异常状态建档语义或旧失败任务迁移的歧义，先报告再实施。

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
| timer | 实际安装 3 分钟，仓库模板 3 分钟（`OnCalendar=*-*-* *:00/3:00`） | 3 分钟为用户确认值（2026-11-17 复核，取代早期 15 分钟口径） |

已有测试通过不能替代上述场景：审计中两组定向测试分别 54 项、28 项通过，独立复现仍揭示缺口。这些数字是历史记录，不是后续验收结果。

主要依据：`docs/MVP__v1.0.md` §32.2；`docs/MVP2.0__PROVIDER_VERIFICATION_RESULT__v1.0.md`（历史接口事实）；`docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md`；现有 `src/application/provider-*.ts`、`src/provider/*.ts` 与共享 runtime。

## 3. 任务表

| 编号 | 任务 | 优先级 | 依赖 | 属性 |
|---|---|---|---|---|
| PS01 | 按联赛隔离到期与重试状态 | P1 | 无 | 已证实缺陷 |
| PS02 | 主赛程源首次发现统一建档 | P1 | 无 | 已证实缺陷，部分语义待确认 |
| PS03 | 请求成功与同步完成分离 | P1 | PS01 | 已证实缺陷 |
| PS04 | 配额不足明确延后 | P1 | PS03 | 已证实缺陷 |
| PS05 | 5d 共享直播结果完整分发 | P1 | 无 | 已证实缺陷 |
| PS06 | 5d 联赛过滤与赛季核验 | P1 | 无 | 已证实适配器缺口 |
| PS07 | 生效联赛映射统一 | P1 | 无 | 特定配置下缺陷 |
| PS08 | OpenFoot 源赛季表达 | P2 | PS06、PS07 | 特定入口缺陷 |
| PS09 | 次要源映射准备与关联验收 | P1 | PS05～PS08 | 接线与验收缺口 |
| PS10 | timer 模板与运行边界说明 | P2 | PS01、PS03、PS04 | 模板修正 |
| PS11 | 最终验证与真实环境验收 | P1 | PS01～PS10 | 验收 |

节点可分别开发；同一 Registry 文件的修改串行整合。PS01 与 PS03 的持久化状态契约先统一再实现。

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

**验收：**一次 HTTP，多联赛各收自己的比赛；未到允许时间不新增请求。

**相关测试：**`src/provider/registry.test.ts`、`src/provider/registry-league-cache.test.ts`

### PS06：5d 联赛过滤与赛季核验

**问题：**全季入口无明确赛季约束，响应被直接赋予请求赛季；日期入口拉全联赛数据却未过滤。

**涉及文件：**`src/provider/fivedollar-adapter.ts`、`src/provider/fixture-mapper.ts`、`src/domain/config.ts`。

**步骤：**

1. 在 `extended-adapters.test.ts` 补旧赛季混入、日期窗口混合联赛、跨年边界测试。
2. 先查 `docs/MVP2.0__PROVIDER_VERIFICATION_RESULT__v1.0.md` 确认上游赛季字段与参数；需要新真实请求时另行安排。
3. 响应有可信赛季字段时保留并核验；没有时按登记的赛季边界判断，无法确认的记录不贴目标标签采纳。
4. 按联赛查询的返回值过滤目标 source_league_ref；全联赛 live 入口保留全量，由 PS05 分发。
5. 去掉 live 映射里的固定 2026 假设。

**验收：**2025 假比赛不被改标为 2026；西甲查询不返回英超；跨年与自然年联赛规则明确。

**相关测试：**`src/provider/extended-adapters.test.ts`、`src/provider/fixture-mapper.test.ts`

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

**验收：**至少一场受控比赛串通主源、次要源、结果采纳与冲突规则；真实覆盖另行记录。

**相关测试：**`src/application/provider-cross-source.test.ts`、`src/scripts/provider-tools.test.ts`

### PS10：timer 模板与运行边界

**涉及文件：**`ops/vps/football-jobs.timer`、`ops/vps/README.md`。

1. 调度周期为**已确认的 3 分钟**：`OnCalendar=*-*-* *:00/3:00`。模板与实际安装一致。（2026-11-17 复核确认；早期"10 分钟模板 / 15 分钟安装"的口径作废，不再作为运行边界依据。）
2. 保留原有 Persistent、随机延迟设置；不改实际安装的 unit。
3. README 说明：短退避与更短的比分轮询只在下次 tick 唤起时执行，3 分钟调度是刷新频率上限。
4. 提出频需另行重算各渠道预算（`of` 120 次/日、`5d` hourly_cap 40 等），不在本期启用。

**验收：**模板语法合法，文档与线上 timer 的 3 分钟边界一致。

```bash
systemd-analyze calendar '*-*-* *:00/3:00'
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
- 小程序未改动则不需构建；如改动传输或展示代码，用 `npx vitest run miniprogram` 补验，不用 `node --test`。

真实环境按需分步记录：受控执行后检查比赛数量、状态分布、任务完成时间、失败数与映射覆盖，不只看 HTTP 200；CloudBase 缺凭据或未实际覆盖的部分标“未验收”。真实同步前先确认没有 timer 或另一次 tick 在跑，VPS 与 CloudBase 不同时处理同一账本。

## 5. 验收矩阵

| 编号 | 场景 | 必须观察到的结果 | 状态 |
|---|---|---|---|
| A01 | 英超后紧接西甲 | 西甲可进入加载，不被英超日志挡住 | 已单测通过（内存仓储；隔离 PG 未验收） |
| A02 | 同联赛同周期重复任务 | 按周期跳过，不重复产生业务效果 | 已单测通过 |
| A03 | 联赛 A deferred、B 到期 | B 不继承 A 的退避状态 | 已单测通过 |
| A04 | 主源首次发现各状态 | 建档并按原规则应用，不因 MATCH 缺失报错 | 已单测通过 |
| A05 | 首次已结束比赛与重复输入 | 赛果采纳规则有效，不重复结算或虚构预测 | 已单测通过 |
| A06 | 球队成功、比赛失败 | 业务完成时间不提前推进，可补偿 | 已单测通过 |
| A07 | 部分 fixture 失败 | 摘要、日志与重试资格一致 | 已单测通过 |
| A08 | 配额耗尽 / 真实零比赛 | 前者延后，后者为合法空结果 | 已单测通过 |
| A09 | 同轮 5d 多联赛直播 | 一次请求，逐联赛完整分发 | 已单测通过 |
| A10 | 旧赛季或其他联赛混入 | 不改标目标赛季，不混入目标联赛 | 已单测通过（PS06 补充 4 项单测） |
| A11 | 自定义源联赛 ID 与 OpenFoot 赛季 | 映射一致或配置阶段拒绝；源参数正确 | 已单测通过 |
| A12 | 次要源有/无球队映射 | 同场正确关联；缺映射不猜测采纳 | 已单测通过（受控模拟；真实映射待人工确认） |
| A13 | timer 模板与说明 | 统一 3 分钟并写明刷新限制 | 已通过（`systemd-analyze calendar` 与模板单测；`ops/vps/football-jobs.timer` 为 `*:00/3:00`，线上 timer 一致） |

每节点记录：修改文件、复现测试的失败结果、修复后结果、未验收项。不得预填通过数量。

- PS06 节点记录：修改 `src/domain/config.ts`、`src/provider/fivedollar-adapter.ts`、`src/provider/fixture-mapper.ts`、`src/provider/registry.ts`、`src/provider/extended-adapters.test.ts`、`src/provider/fixture-mapper.test.ts`；复现 4 项失败，修复后 `extended-adapters.test.ts` + `fixture-mapper.test.ts` 29/29 通过。
- PS11 全量验证：2026-11-15 执行 `tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.build.json`、`tsc -p tsconfig.cloudfunction.json && node scripts/write-cloudfunction-build-info.mjs` 均通过；`./node_modules/.bin/vitest run` 209 个文件 1965 项通过、6 个文件 23 项跳过（PG 测试无库连接，标“未验收”）、1 项失败（`src/scripts/provider-tools.test.ts` 中 `cloudbase:schema` 调用 `spawnSync npm ENOENT`，沙箱内 `/opt/node-v24.21.0-linux-x64` 未挂载）。真实运行库同步、真实接口请求与 CloudBase 实环境未验收。

## 6. 待确认边界

- PS02 不改变权威赛果采纳和结算规则；规范不支持某状态首次建档表示时，先给出具体冲突。
- PS09 的映射清单需人工确认，不自动写运行库。
- 旧历史任务是否重置、补跑哪些联赛，按修复后的状态模型给出补偿计划，不清空同步状态或比赛记录。
- 5d 赛季与 OpenFoot 参数若需新接口证据，先列最小查询与额度成本。

## 7. 完成定义

PS01～PS11 验收项完成，节点记录与最终全量验证有实际输出，VPS/CloudBase 验证层级如实标注；多联赛可初始化、合法状态可首次发现、失败可补偿、多源可区分有数据与有效采纳，才标记本期功能完成。
