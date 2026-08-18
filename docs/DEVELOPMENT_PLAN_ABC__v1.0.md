# 赛事预言家 A/B/C 开发计划 v1.0

> **目标：** 按核心后端冻结、非核心后端、前端 UI 的顺序推进项目。
>
> **依据：** `MVP__v1.0.md` 是业务规则唯一来源；`PROJECT_REQUIREMENTS__v1.0.md` 是阶段需求与门禁；`REVERSE_REVIEW__v1.0.md` 是未冻结项来源。
>
> **范围纪律：** 每个切片只做本计划指定事项。遇到未定义行为，停止并记录 `SPEC_GAP`，不得自行扩展。

## 通用完成标准

### 测试与安全范围

- 原则上**不需要防御性、健壮性测试**。
- 数据脱敏和安全性只做**最小必要要求**：不得提交凭证、`.env`、真实数据库、运行日志或 Agent 监督器输出。
- 测试以**最基本的功能性测试**为准：验证本切片明确要求的正常业务结果和必要的已定义失败结果；不为假设性极端场景、未要求的攻击面或未来扩展补测试。
- 若冻结业务规范明确要求 Fail Closed、幂等、状态机或账本一致性，相关测试属于基本功能验证，应保留；不得据此扩张为泛化的防御性测试体系。

每个代码切片：

1. 先补与本切片业务需求直接对应的失败测试，再写最小实现。
2. 运行关联功能测试。
3. 独立执行以下检查：

```sh
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

4. 复核 diff 仅包含该切片所需变更；不提交 `.env`、凭证、数据库和运行日志。

---

# 阶段 A：核心后端冻结

## A0：建立当前冻结基线

**目的：** 在继续开发前确认当前后端基线和已知未完成项。

**文件：**
- 阅读：`MVP__v1.0.md`、`REVERSE_REVIEW__v1.0.md`、`SEC49_FIX_RECHECK__v1.0.md`
- 更新：`DEVELOPMENT_PLAN.md`（仅补简短入口/状态时）

**步骤：**
1. 记录当前提交、测试数量与已冻结的第 49 节范围。
2. 将 H3、H5、U 类和其余状态写入审查列为后续工作，不混入第 49 节完成声明。
3. 验证四项通用检查均通过。

**完成条件：** 当前完成项与未完成项可追溯，且没有把规划工作写成已实现。

## A1：冻结管理端 reason / retry 决策表（H3）

**当前状态：A1.3、A2.1、A2.2 第一垂直切片、A2.3、A3.1、A3.2、A3.3 已完成；A2.2 其余接口、A4 保持未开始。**

### A1.1 管理端 reason 来源与审计规则（已完成）

- `result-corrections`、`rebuild/rankings` 使用管理员 HTTP body 的必填 `reason`。
- `retry-settlement`、`rebuild/users` 不接收 body/request reason，分别使用固定系统 reason `管理员重试结算`、`管理员用户统计重建`。
- 四个写操作均写入 `admin_audit_logs`，reason 非空；成功响应保持有限 data 与 `audit_id`。
- 相关 application/API/OpenAPI 测试已覆盖上述来源与 body 形状。

### A1.2 retry 决策表（已完成）

已在 `MVP__v1.0.md` 49.8 冻结并实现 waiting/settling/correcting/failed/settled 相关 retry 允许性、目标 settlement 选择、HTTP/code、部分成功 outcome 与计数口径。

- 优先拒绝 match `settling/correcting` 或任意 running settlement：`409 SETTLEMENT_ALREADY_RUNNING`。
- 结构合法 failed target 按最小未处理 `result_version` 选择，复用原 settlement/items；普通进入 settling，correction 进入 correcting。
- 无目标、match failed 数据不一致、目标数据冲突分别按 49.8 返回 `SETTLEMENT_NOT_READY` 或 `INTERNAL_ERROR`；不新建 settlement 或积分。
- 200 响应只返回 `settled|failed`，计数为本次 retry 的 `processed_count` / `skipped_applied_count`，并始终带 `audit_id`。
- 已补齐 application/API/OpenAPI 与最小分支测试；A1.1 的固定 reason 与审计规则保持不变。

**目的：** 让管理员 retry 的授权、目标、账本复用、错误响应与结果摘要不存在猜测空间。

**主要文件：**
- 修改：`MVP__v1.0.md`（新增或修订冻结决策）
- 修改：`src/application/admin-retry-settlement.ts`
- 修改：`src/application/admin-result-correction.ts`
- 修改：`src/application/admin-rebuild-user-stats.ts`
- 修改：`src/application/admin-rebuild-rankings.ts`
- 修改：`src/api/v1/admin.ts`、`src/api/v1/openapi.yaml`
- 测试：对应 `*.test.ts`

**完成情况：**
1. 已写入 retry 状态 × 前置条件 × 目标 × HTTP/code × 响应表。
2. 已覆盖 running、settling/correcting 优先错误、无目标、部分成功、锁冲突与目标冲突的基本行为。
3. application 入口负责决策，API 只映射既有 application 结果并声明 500 响应。
4. 相关测试与通用检查按当前环境执行；未提交、未 push。

**完成条件：** 任一管理员写操作都有确定的输入、审计原因、结果和错误响应。

### A1.3 四个 admin 写操作错误/响应合同交叉复核（已完成）

已对以下四个写入口完成错误码、HTTP 状态、成功 Envelope、错误 Envelope、OpenAPI 与 application 结果的交叉复核：

- `POST /v1/admin/matches/:match_id/result-corrections`
- `POST /v1/admin/matches/:match_id/retry-settlement`
- `POST /v1/admin/rebuild/users/:user_id`
- `POST /v1/admin/rebuild/rankings`

复核与最小修复：

- 四个入口均覆盖缺可信身份 `401 UNAUTHORIZED`、非 active admin `403 FORBIDDEN`；统一错误 mapper 保留既有 `AUTH_REQUIRED -> UNAUTHORIZED` 映射。
- 四个入口的参数、not found、状态/锁冲突继续使用既有错误码；数据一致性失败统一对外为 `500 INTERNAL_ERROR`，不新增业务错误码。
- 四个入口均在 OpenAPI 声明 `500 InternalError`；成功响应继续是第 48.2 节有限 `data` 与 `audit_id`，不泄露 `admin_id`、完整审计或内部排行榜。
- 增加最小交叉合同测试；已发现 `SPEC_GAP/H4`：`src/api/v1/openapi.yaml` 的 `BearerAuth` / `bearerFormat: JWT` 表达与 `MVP__v1.0.md` §49.1 的网关/运行环境注入可信 `openid` 模型冲突。本次不修改 `openapi.yaml`，等待 H4 的产品裁决/机械化方案；该项阻塞 Backend API Freeze Review，但不阻塞与认证表达无关的 A2 response schema 盘点。

### A1 下一步：进入 A2（已完成）

A1.3 已完成；A2.1、A2.2 第一垂直切片和 A2.3 已完成。随后完成 A3.1、A3.2、A3.3；A2.2 其余接口、A4 保持未开始，本切片不实施其中任何内容。

## A2：冻结前端所需响应 Schema（H5）

本轮完成 A2.3 `GET /v1/admin/anomalies`；A2.2 其余接口、A3/A4 不在本切片范围内。

**目的：** 让前端可依赖 API，不需要从实现代码猜字段。

**主要文件：**
- 修改：`MVP__v1.0.md`
- 修改：`src/api/v1/openapi.yaml`
- 修改：`src/api/v1/predictions.ts`、`unlocks.ts`、`admin-anomalies.ts`、`admin.ts`
- 测试：`src/api/v1/openapi-*.test.ts` 与相应接口测试

**步骤：**
1. 为每个目标接口确定完整 response：字段、类型、nullable、数组、排序、cursor、UTC 时间格式。
2. 先写 OpenAPI contract 测试：缺字段、错误 nullable、排序错误和 cursor 不匹配均应失败。
3. 让 handler 返回值与 OpenAPI schema 逐项一致。
4. 为典型成功、空列表、已删除用户、异常详情和分页边界补接口测试。
5. 跑通用检查。

**完成条件：** 用户端与首版管理端需要的接口有可机器校验的完整 contract。

### A2.1 `GET /v1/predictions/me`（已完成）

- 在 `MVP__v1.0.md` 49.9 冻结分页成功 Envelope、19 个扁平 item 字段、字段类型与 nullable、正式比分缺失的 `null` 表达、稳定排序、season 绑定 cursor、`season_id/limit/cursor` 输入校验和失败映射。
- handler 显式投影冻结字段；application query 对正式比分缺失时的结算字段返回 `null`，保持 `submitted_at DESC, prediction_id DESC` keyset 分页。
- OpenAPI `PredictionHistoryItem`、分页 Envelope、query 参数与 401/404/409/422/429/500 响应已对齐。
- 已标记 `SPEC_GAP`：球队展示名及 `home_team`/`away_team` 嵌套对象的公开形状未由现有规范唯一确定，本切片不扩展字段。
- 关联 handler/application/OpenAPI 合同测试通过；A2.2 第一垂直切片随后完成，A3.1/A3.2/A3.3 已完成，A4 保持未开始。

### A2.2 第一垂直切片：`GET /v1/unlocks/me`（已完成）

- 在 `MVP__v1.0.md` 49.10 冻结非分页成功 Envelope、固定默认资源顺序、五个 unlock item 字段及类型/nullable、全部历史记录、`threshold_points ASC, unlock_id ASC` 稳定排序、空列表和失败映射。
- handler 显式投影冻结的五个 item 字段；application 保留 active 用户校验、全部历史 unlock、UTC 时间序列化和既有稳定排序。
- OpenAPI 对齐默认资源 `const`、unlock code/threshold/source version、item required/non-nullable、无参数、200/401/404/409/422/429/500 响应；未修改 `BearerAuth` security scheme。
- 已标记 `SPEC_GAP`：资源展示名称、图标、URL、描述、展示分类及其他 UI 元数据没有由当前规范和实现唯一确定，本切片不增加字段。
- 关联 handler/application/OpenAPI 合同测试通过；A2.3、A3、A4 状态见下方对应小节。

### A2.3 `GET /v1/admin/anomalies`（已完成）

- 在 `MVP__v1.0.md` 49.11 冻结分页成功 Envelope、12 个 anomaly item 字段、resolved 记录呈现、`status/blocking/limit/cursor` 输入、`last_seen_at DESC, anomaly_id DESC` 稳定排序、keyset cursor 绑定和失败映射。
- handler 显式投影冻结字段；`details` 只返回受控空 object，不透传内部 Provider payload、密钥或运维字段。
- application 校验 active admin、cursor 筛选继承/冲突、`anomaly_key=match_id:type` 及 anomaly 事实字段；事实不一致对外为 `500 INTERNAL_ERROR`。
- OpenAPI 声明固定分页 schema、`details` 空 object 边界和 401/403/422/429/500 响应；未修改 `BearerAuth` security scheme。
- 已记录 `SPEC_GAP/H5`：现有规范只冻结 `details` 为 object，未唯一冻结其公开成员；本切片固定最小受控投影 `{}`，未来公开诊断字段需另行冻结白名单和脱敏边界。
- 关联 API/application/OpenAPI 合同测试通过；随后完成 A3.1、A3.2、A3.3，A4 保持未开始。

## A3：冻结时间、重试与锁行为（U 类）

**当前状态：A3.1、A3.2、A3.3、A4 已完成；B/C 保持未开始。**

**目的：** 消除依赖墙钟、随机数和模糊 lease 规则造成的不可重复测试。

**主要文件：**
- 修改：`MVP__v1.0.md`
- 修改：`src/application/provider-fixture-sync.ts`
- 修改：`src/application/daily-consistency-service.ts`
- 修改：`src/application/period-finalize-service.ts`
- 修改：相关 sync/config 文件
- 测试：上述模块的 `*.test.ts`

**步骤：**
1. 明确所有业务入口的 `server_now` 注入与无效时间 Fail Closed 行为。
2. 明确 retry 的随机源、等待函数和断言范围；测试中不真实等待。
3. 明确 lease 续租节点、续租失败后的停止点和日志结果。
4. 将“应不应该执行”的业务谓词与“多久调一次”的调度频率分开。
5. 为边界时间、续租失败、重复执行、jitter 区间写测试。
6. 跑通用检查。

**完成条件：** 关键任务在固定 clock/random 下可重复验证，且续租失败不会继续写入。

### A3.1 `provider-fixture-sync` 业务时钟契约（已完成）

- 在 `MVP__v1.0.md` 49.12 冻结 `applyFixture(..., server_now)` 的唯一服务端业务时钟、直接 job/loader 的时间传递、已定义时间判断和事实时间写入边界。
- 入口及直接下游已有无效 `server_now` Fail Closed；本切片补充固定进程墙钟与注入时间不一致时的最小合同测试，确认 FT 关闭判断、match/result/snapshot 时间均使用注入值。
- 检索确认 `provider-fixture-sync` 业务事实路径没有需要修复的无参 `new Date()`/`Date.now()`；`provider-sync-job` lease 续租墙钟留在后续 A3，不在本切片修改。
- 未修改 OpenAPI 认证 security scheme；`SPEC_GAP/H4` 保持不变。A3.3 随后完成；A4、B/C 未开始。

**A3.1 完成条件：** 关联 fixture sync 合同测试通过，且规范明确哪些时间由 `server_now` 决定、哪些调度/IO/重试/锁内容未冻结。

### A3.2 `provider-sync-job` loader retry / jitter / 等待边界（已完成）

- 在 `MVP__v1.0.md` 49.13 冻结 loader 的 retryable/non-retryable 错误分类、1/2/5/10/30 分钟等待序列、最多 5 次 retry（最多 6 次 loader 调用）、jitter 毫秒边界、可注入 `random` 和 `sleep` 以及 retry 过程的最小 `sync_logs` 语义。
- 严格按 TDD 先补真实合同测试并确认 RED：`DomainError` 曾被现有普通 `Error` 分支误判为可 retry；最小实现只将已有 `DomainError` 纳入不可 retry，未扩大 retry 集合或修改算法。
- 关联测试覆盖 5 次 retry 边界、最终第 6 次尝试、完整等待参数、jitter 下/中/上界、HTTP/Provider/domain 错误分类、quota 停止和 `sync_logs` running/success/failed 观察；`sleep` 使用注入 Promise，不真实等待。
- 明确 `SPEC_GAP`：新增 Provider error/status 的分类、quota reset 与 scheduler 交接、生产 jitter seed/跨进程重放未在本切片猜测或实现。
- 未修改 OpenAPI 认证 security scheme；`SPEC_GAP/H4` 保持不变。A3.3 已随后完成；A4、B/C 未开始。

**A3.2 完成条件：** 固定 random/sleep 注入时，loader retry、等待边界、尝试次数和最小 sync log 观察可重复验证；未定义分类不被自动扩展。

### A3.3 lease 续租（已完成）

已完成 `provider-sync-job` 的最小 job lease 合同：

- 在 `MVP__v1.0.md` 49.14 冻结同类 job key `sync:{job_type}`、有效 `server_now` 前置校验、基于 `server_now` 的 10 分钟初次 lease、未获取锁时 skip/no log、半 lease（5 分钟）续租节点、仅 owner 续租/释放和 lease 到期后的 CAS 接管。
- 严格按 TDD 先增加“首次续租失败后不得继续续租”的真实 RED 测试并确认当前实现会在第二个续租节点再次调用；最小实现只在续租返回 `false` 或异常时清除 renewal timer，保留既有业务边界检查、failed log 和 finally release 路径。
- 关联测试覆盖初次 lease 输入、续租 wall-clock 到期值、续租失败/异常后的停止与 failed log、同类 key 和 owner 透传；现有 repository 测试继续覆盖非 owner release、owner-only renew 与 lease 到期接管。
- 业务事实时间继续使用注入 `server_now`；wall-clock 仅用于续租定时与操作性 `lease_until` 计算。未新增分布式锁抽象、scheduler 或其他任务 lease 语义。
- 已记录 `SPEC_GAP`：跨节点 wall-clock/存储 server time 竞态、scheduler 触发与接管交接、其他任务或 settlement lease 规则仍未冻结。
- 未修改 OpenAPI 认证 security scheme；`SPEC_GAP/H4` 保持不变。A4、B/C 未开始，未 commit/push。

**A3.3 完成条件：** `provider-sync-job` 的获取、续租、失败停止、释放和接管均有可重复的最小合同测试；续租失败后不再开始新的 loader/fixture/success log 边界，且失败日志与自身 owner release 保持既有语义。

## A4：审查并收口剩余 settlement 状态写入（已完成）

**目的：** 保证非初始状态变更符合冻结状态机。

**主要文件：**
- 检索：`src/**/*.ts` 中 `settlement_status`
- 可能修改：Provider/admin 相关 application service 与 repository
- 测试：每个实际修改路径的回归测试

**步骤：**
1. 列出所有直接更新 `settlement_status` 的写入点及调用路径。
2. 分类：新建初始 `pending`、合法状态机转移、需修复的绕过写入、非业务初始化。
3. 仅对违反状态机的写入改用既有 transition 入口。
4. 为每条修复路径写“允许转移”和“禁止转移不写入”的测试。
5. 输出审查清单：保留项及理由、修复项及测试位置。
6. 跑通用检查。

**完成条件：** 没有未经说明的业务状态绕过写入；不做无关重构。

**完成情况：**

1. 已全量检索 `src/**/*.ts` 的 `settlement_status`、状态机 helper、repository 与 invariant 测试，并在 `MVP__v1.0.md` 49.15 固化逐点审查清单。
2. 确认 3 条真实绕过路径：Provider FT 赛果、Provider cancelled、管理员赛果修正。
3. 三条路径均严格按 RED→GREEN 收口到既有 `transitionMatchSettlementStatus`；`pending` 初始创建、ABD 保持 pending、测试 fixture 与读/约束代码保留并分类说明。
4. 未重写状态机，未新增状态或 settlement/retry 规则，未修改 A 阶段 API/OpenAPI 认证 scheme；B/C 未开始，未 commit/push。

## A5：Backend API Freeze Review

**当前状态：H4 已按合同层关闭；A5 待最终复核，未宣称 PASS；B/C 未开始。**

**目的：** 决定是否允许开始前端设计。

**检查项：**
- 用户端页面所需接口均有 OpenAPI schema 与响应测试。
- 成功/失败 HTTP、code、cursor、排序、时间和 nullable 语义固定。
- 页面需要的用户、比赛、预测、结算状态均有明确映射。
- 未完成的真实 Provider、数据库和部署工作不改变 API 语义。

**完成条件：** 输出 `PASS` 或明确 blocker；只有 `PASS` 才能进入阶段 C 的 UI 设计与实现。

**H4 关闭记录：** OpenAPI 已移除 `BearerAuth`/JWT 表达，改为根级 `x-trusted-runtime-openid` 与所有现有 Auth required operation（含 `POST /session/init`）的 `x-requires-trusted-openid: true`。该项不再阻塞 A5；具体网关注入协议、平台登录流程和本地模拟方式留给 B3。本记录不构成 A5 `PASS`，也不授权开始 B/C。

---

# 阶段 B：非核心后端与生产接线

> 阶段 B 可与阶段 C 的纯 UI 设计并行，但不得改变阶段 A 已冻结 API 语义。

## B1：真实数据库 / CloudBase repository

**目标：** 用真实持久化实现现有 repository ports。

**步骤：**
1. 根据 `src/schema/collections.ts`、`src/schema/indexes.ts` 建立目标环境 schema 与索引迁移。
2. 为 repository ports 实现 CloudBase adapter；不改领域层。
3. 使用隔离测试环境验证唯一约束、事务、锁、回滚与迁移幂等。
4. 保留内存 repository 作为单元测试适配器。

**完成条件：** 真实数据库可通过 repository/application 集成测试，且没有凭证进入仓库。

## B2：真实 API-Football client

**目标：** 替换注入式 fixture loader 的生产实现，不改变 mapper 和同步业务规则。

**步骤：**
1. 只读取配置变量名，不读取或提交真实凭证。
2. 实现 HTTP client 的超时、配额、暂时错误和不可恢复 Provider 数据错误分类。
3. 用 mock HTTP 测试请求参数、分页、错误分类和原始 payload 保留。
4. 在非生产环境以 dry-run/只读方式做端到端同步演练。

**完成条件：** 真实 client 满足既有 loader contract，业务层无需为 API-Football 特例改规则。

## B3：云函数、路由与环境

**目标：** 将 API handler 接到目标运行环境。

**步骤：**
1. 固定 dev/test/prod 的配置键和资源命名空间。
2. 接入网关注入 trusted openid 的边界；不增加 JWT。
3. 部署前验证环境隔离、错误 envelope、日志脱敏和回滚路径。
4. 编写最小部署与本地运行说明。

**完成条件：** 目标环境可部署并调用冻结 API，凭证只在部署平台保存。

## B4：生产调度、异常与可观测性

**目标：** 为同步、结算和一致性检查提供可运行的调度和可定位故障信息。

**步骤：**
1. 为 future/full/near/live/post-finish/daily consistency/period finalize 配置触发器。
2. 将调度频率保持在基础设施层，业务判断仍由 `server_now` 决定。
3. 在规范先冻结后，设计 daily consistency anomaly 的 type、schema、幂等键与 resolve 规则。
4. 增加结构化日志、告警信号和管理员审计查询所需字段。
5. 在测试环境进行故障演练：锁冲突、Provider 失败、账本 worker 失败和重试。

**完成条件：** 运行故障可观察、可重试、可审计，且不会绕过账本或状态机。

## B5：共享限流存储

**目标：** 让多实例部署时的限流语义保持一致。

**步骤：**
1. 选定与运行环境匹配的共享计数/锁存储。
2. 保持现有端点、额度、429/code 和身份 key 语义。
3. 增加并发与窗口边界测试。

**完成条件：** 多实例下不会因内存分片绕过限流。

---

# 阶段 C：前端 UI

## C0：用户路径与信息架构

**目标：** 不直接画视觉稿，先固定页面、信息和状态。

**输出：** `UI_REQUIREMENTS__v1.0.md`（后续创建）

**步骤：**
1. 写首次进入、比赛列表、详情、预测提交、我的预测、等级/解锁、排行榜的用户路径。
2. 为每页列出加载、空数据、未登录、注销、不可预测、截止、延期、结算中、错误状态。
3. 单独确认管理端是否进入首版 UI。
4. 将每个页面绑定到阶段 A 冻结 API 和字段。

**完成条件：** 不存在无后端来源的页面数据或无法表达的业务状态。

## C1：低保真原型与 UI 状态验收

**目标：** 验证信息层级与交互，不先投入视觉细节。

**步骤：**
1. 为用户端核心页面制作低保真布局。
2. 依据 API 状态设计提交预测、禁用原因和结果展示。
3. 评审空态、错误态和移动端阅读顺序。
4. 将确认的页面状态写入 UI 需求文档。

**完成条件：** 用户路径可走通，状态反馈与后端 code/reason 一致。

## C2：视觉系统与前端实现

**目标：** 在已确认的信息架构上实现首版前端。

**步骤：**
1. 选择并固定前端运行形态（微信小程序或 Web）及组件方案。
2. 建立最小设计 token 和可复用组件；不提前做复杂组件库。
3. 按页面垂直切片接入冻结 API，先 mock contract，再接测试环境。
4. 为 API 错误映射、关键交互和页面状态写测试。
5. 通过真机/目标浏览器验收核心用户路径。

**完成条件：** 用户端核心路径完整、错误可理解、没有依赖未冻结字段；管理端 UI 仅在已确认范围内实现。
