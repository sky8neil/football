# 第 49 节落地计划 v1.0

> 范围：仅落地 `MVP__v1.0.md` **第 49 节 补充冻结决策 v1.2**（F1/F2/F3/H1/H2）。
> 来源确认：`REVERSE_REVIEW__v1.0.md` 第七节产品确认记录（2026-08-11）。
> 与正文冲突时以第 49 节为准。

## 1. 目标 / 非目标

### 目标
- 鉴权失败语义与 session 边界对齐 49.1（仅补缺口）。
- 预测拒绝：`can_predict_reason` 与 `POST /v1/predictions` **同源同序**（49.2）。
- 结算状态机允许 `settling → correcting`，编排层与 15.9/49.3 一致。
- 延期关闭真值表落地（49.4）。
- rebuild / daily consistency 期望值以 applied ledger 为唯一事实源（49.5）。

### 非目标（本版明确不做）
- **H3** 管理端 reason / retry 决策表统一
- **H4** 第 48 节与 0.1 冲突裁决机械化
- **H5** 部分 API 响应 schema 补全
- **全部 U 类**（时钟注入、jitter 确定性、SLO 非门禁等）
- 不扩新业务功能、新状态语义、新错误码族（仅按 49 节既定码对齐）
- 不连真实微信 / Provider；不读凭证；不 commit / push

## 2. 约束

| 项 | 要求 |
|---|---|
| 开发方式 | **TDD**：每个切片先写失败测试，再改最小实现 |
| 语言 | TypeScript strict |
| 外部依赖 | 不连真实微信 / Provider；测试可注入 `server_now` |
| 凭证 | 不读取、不打印、不落盘 |
| Git | **禁止** commit / push |
| 防御性代码 | 只保留规范要求的 Fail Closed；不堆“体验向”容错 |
| 单一入口 | 状态转移走 `validateSettlementTransition`；可预测判定与拒绝映射同源 |

## 3. 现状缺口速记（编码前对照）

| 49 节 | 现状要点 | 主要文件 |
|---|---|---|
| 49.3 | `ALLOWED_TRANSITIONS` **无** `settling→correcting`；first/retry finalize 在有更高 `result_version` 时直接写 `correcting` | `src/domain/settlement-state-machine.ts`、`first-settlement-service.ts`、`retry-settlement-service.ts` |
| 49.3 / 15.9 | 编排已有 correction 队列推进，需与状态机合法表一致 | `settlement-orchestration-service.ts`、`correction-settlement-service.ts`、`admin-retry-settlement.ts` |
| 49.2 | `match-query.reasonFor` 顺序已接近；POST 仍多抛 `MATCH_NOT_OPEN_FOR_PREDICTION` / `USER_NOT_ACTIVE` / `AUTH_REQUIRED`，未按表拆到 `MATCH_NOT_PREDICTABLE` / `PREDICTION_LOCKED` / `UNAUTHORIZED` | `prediction-policy.ts`、`predictions.ts`、`match-query.ts`、`api/v1/predictions.ts`、`openapi.yaml` |
| 49.4 | `decidePredictionClosedAt` 到点关闭未强制 `match_status==scheduled`；postponed 路径需对照真值表 | `prediction-deadline.ts`、`provider-status-sync.ts` |
| 49.5 | rebuild/snapshot 已偏 applied items；需锁死“不得以 prediction 缓存字段为唯一输入”，并修订验收解释 | `stats-rebuild.ts`、`ranking-rebuild.ts`、`daily-consistency-snapshot.ts`、admin rebuild |
| 49.1 | session 缺身份用 `AUTH_REQUIRED`；49.1 要求 `UNAUTHORIZED`；body 伪造 `user_id` / 再 init 忽略 nickname 仅补缺口 | `api/v1/session.ts`、`application/session.ts`、相关 auth required 入口 |

## 4. 切片顺序 S1～S6

每个切片完成标准：

```text
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

`SUPERVISOR_STATUS` 取值：

| 值 | 含义 |
|---|---|
| `PASS` | 本切片验收通过，可进下一切片 |
| `BLOCKED_SPEC` | 规范仍含糊到无法编码（第 49 节已冻结，默认不应出现） |
| `MVP_COMPLETE` | **仅当 S1～S6 全部 PASS** 后由最后一切片报告 |

---

### S1 — 状态机 `settling → correcting`（49.3）

**改哪些文件**
- `src/domain/settlement-state-machine.ts`
- `src/domain/settlement-state-machine.test.ts`

**先写失败测试（建议名）**
- `settlement-state-machine.test.ts`
  - `allows settling -> correcting`
  - `still rejects settling -> pending|waiting|voided|correcting 以外非法边`（保持原拒绝集，仅新增合法边）
  - 合法表快照/枚举：确认与 11.2+49.3 一致，**含** `settling→correcting`

**实现要点**
- `ALLOWED_TRANSITIONS` 增加 `` `${Settling}->${Correcting}` ``
- 不改其它边语义

**验收**
- 上述四条命令全绿
- `SUPERVISOR_STATUS=PASS`（仅 S1）

---

### S2 — 编排层与 15.9 / 49.3 对齐

**改哪些文件**
- `src/application/first-settlement-service.ts`（+ `.test.ts`）
- `src/application/retry-settlement-service.ts`（+ `.test.ts`）
- `src/application/correction-settlement-service.ts`（+ `.test.ts` 如需）
- `src/application/settlement-orchestration-service.ts`（+ `.test.ts`）
- 必要时：`src/application/admin-retry-settlement.ts` / `admin-retry-settlement.test.ts`

**先写失败测试**
- `first-settlement-service.test.ts` / `retry-settlement-service.test.ts`
  - `finalize version v writes settled_result_version=v and settled_at before status branch`
  - `when result_version == v after re-read → settlement_status=settled`
  - `when result_version > v after re-read → settling→correcting (via validateSettlementTransition) then queue next correction`
  - `must not mark settled then correcting without writing settled_result_version=v`
- `settlement-orchestration-service.test.ts`
  - `after finalize with higher result_version, advances min unprocessed correction version in order`
  - admin retry 与编排共用同一合法转移（非法 from→to Fail Closed）

**实现要点**
- finalize 顺序固定：写 `settled_result_version=v` + `settled_at` → 再读 `result_version` → `settled` 或 `settling→correcting`
- 所有 match `settlement_status` 变更先 `validateSettlementTransition`
- 禁止“先 settled 再立刻 correcting 却省略 settled_result_version=v”

**验收**
- 四条命令全绿 → `SUPERVISOR_STATUS=PASS`

---

### S3 — 预测拒绝映射 49.2（domain + API + 必要 OpenAPI）

**改哪些文件**
- `src/domain/prediction-policy.ts`（+ `.test.ts`）— 建议抽出与 `canSubmitPrediction` 同源的 **有序 reason/reject** 入口（避免 list/POST 各写一套）
- `src/application/match-query.ts`（+ `.test.ts`）— `can_predict_reason` 调用同源
- `src/application/predictions.ts`（+ `.test.ts`）— POST 按表抛码
- `src/api/v1/predictions.ts`（+ `predictions.test.ts` / 既有 API 测试）
- `src/api/v1/validation.ts`（+ `.test.ts`）— HTTP 映射：`UNAUTHORIZED`→401，`MATCH_NOT_PREDICTABLE`/`PREDICTION_LOCKED`→409 等
- `src/api/v1/openapi.yaml` + `openapi-predictions.test.ts`（仅必要字段/错误码）

**先写失败测试**
- `prediction-policy.test.ts`：优先级 1→6 命中即停矩阵（含 postponed→`NOT_SCHEDULED`，CLOSED 覆盖 closed_at 与墙钟过期）
- `match-query.test.ts`：`can_predict_reason` 与上表一致
- `predictions.test.ts`（application + api）：
  | 条件 | reason | POST HTTP | POST code |
  |---|---|---|---|
  | 无可信登录 | `AUTH_REQUIRED` | 401 | `UNAUTHORIZED` |
  | 用户已注销 | `USER_DELETED` | 409 | `USER_DELETED` |
  | 已有预测 | `ALREADY_SUBMITTED` | 409 | `PREDICTION_ALREADY_SUBMITTED` |
  | 非 scheduled | `NOT_SCHEDULED` | 409 | `MATCH_NOT_PREDICTABLE` |
  | kickoff 未确认 / deadline null | `KICKOFF_UNCONFIRMED` | 409 | `MATCH_NOT_PREDICTABLE` |
  | closed 或 now≥deadline | `CLOSED` | 409 | `PREDICTION_LOCKED` |
- 幂等重放（同 key+同 payload）仍走成功/首次结果，不进失败表

**实现要点**
- list/detail 的 reason 与 POST code **同一判定函数、同一顺序**
- 删除/收窄粗粒度 `MATCH_NOT_OPEN_FOR_PREDICTION` 在可映射路径上的使用
- OpenAPI 只补 49.2 相关错误码，不扩 H5

**验收**
- 四条命令全绿 → `SUPERVISOR_STATUS=PASS`

---

### S4 — 延期关闭真值表 49.4

**改哪些文件**
- `src/domain/prediction-deadline.ts`（+ `.test.ts`）
- `src/application/provider-status-sync.ts`（+ `.test.ts`）
- 若关闭逻辑另有 job/读路径：仅改实际写 `prediction_closed_at` 的调用点

**先写失败测试（真值表）**
- `prediction-deadline.test.ts` / `provider-status-sync.test.ts`：

| match_status | closed_at | now vs deadline | 期望 |
|---|---|---|---|
| scheduled | null | now < deadline | 不写 closed；可预测（其它条件满足） |
| scheduled | null | now ≥ deadline | 写 `closed_at=deadline` |
| scheduled | 非 null | 任意 | 保持；不可预测 |
| postponed | null | 任意 | **不因旧 deadline 写 closed_at**；预测 `NOT_SCHEDULED` |
| postponed | 非 null | 任意 | 保持；永不重开 |
| 其它非 scheduled | 任意 | 任意 | 不可预测 |

- 截止前延期：可更新 kickoff/重算 deadline；恢复 scheduled 且新 deadline 未到可再预测
- 截止后才延期：先按旧 deadline 永久关闭，之后永不因延期重开

**实现要点**
- 墙钟到点关闭条件 **同时** 满足：
  `match_status==scheduled AND prediction_deadline_at!=null AND server_now>=deadline`
- postponed 不得仅因越过旧 deadline 写 `closed_at`
- `prediction_closed_at` 一旦非 null 不得恢复 null（既有 6.4.2）

**验收**
- 四条命令全绿 → `SUPERVISOR_STATUS=PASS`

---

### S5 — rebuild / 验收 oracle 49.5

**改哪些文件**
- `src/application/stats-rebuild.ts`（+ `.test.ts`）
- `src/application/ranking-rebuild.ts`（+ `.test.ts`）
- `src/application/daily-consistency-snapshot.ts`（+ `.test.ts`）
- `src/application/admin-rebuild-user-stats.ts` / `admin-rebuild-rankings.ts`（+ 测试，若入口旁路事实源）
- 验收/可追踪：`src/application/acceptance-*.test.ts` 或 `src/acceptance/matrix-44-coverage.test.ts`（解释 44.108 / 44.109）

**先写失败测试**
- `stats-rebuild` / `ranking-rebuild`：期望值 **仅** 来自
  `status=applied` 的 `settlement_items` + `match.period_anchor_at` 归属 + unlock/level_history 只增不减
  — 故意污染 prediction 缓存命中字段时 rebuild 结果仍与 applied items 一致
- `daily-consistency-snapshot`：prediction 缓存与 applied item 冲突时 **以 item 为准**；只报警、不改账本
- 验收文案/断言：
  - 108：与 applied ledger 一致（非未结算 prediction 猜测）
  - 109：`rebuild_period_rankings` 后与 applied items + period 归属完全一致

**实现要点**
- 禁止以 raw `predictions` 缓存字段作为 rebuild **唯一**输入
- 允许 predictions 辅助对账；冲突时 item 胜出
- daily consistency 不自动改账本

**验收**
- 四条命令全绿 → `SUPERVISOR_STATUS=PASS`

---

### S6 — 鉴权 Fail Closed 边界补齐 49.1（仅缺口）

**改哪些文件（按缺口，勿整库重写）**
- `src/api/v1/session.ts`、`src/application/session.ts`（+ 既有 `.test.ts`）
- `src/api/v1/validation.ts`（`UNAUTHORIZED`→401；与既有 `AUTH_REQUIRED` 收敛策略：对外码按 49.1 为 `UNAUTHORIZED`）
- 写/读 Auth required 入口中 **确认的缺口**（body/query 伪造 `user_id`、缺可信身份）：如 `profile.ts`、`predictions.ts` 等仅改不符合 49.1 的点
- 必要 OpenAPI 错误码一行级对齐

**先写失败测试**
- `session.test.ts`（api + application）
  - 缺可信 openid → **401 `UNAUTHORIZED`**
  - 已注销 openid → **409 `USER_DELETED`**（不复活）
  - 同 active openid 再 init → **200** 既有用户，**忽略** body 新 `nickname`
  - openid 不存在 → **201** 创建
  - body 含 `user_id` / 客户端 openid → 拒绝（未知字段或既有不得冒充规则）；不得静默切用户
- 任选 1～2 个 Auth required 写接口：缺可信身份 401 `UNAUTHORIZED`；伪造他人 `user_id` → 403/404（按接口既有），不静默切换

**实现要点**
- 身份只来自网关注入可信 openid；不发明 JWT/Cookie
- 不信任 body/query 的 openid/user_id 作鉴权
- **只补缺口**，不借机重做全站 auth 中间件

**验收**
- 四条命令全绿
- 若 S1～S5 均已 PASS：**`SUPERVISOR_STATUS=MVP_COMPLETE`**
  否则本切片仅 `PASS`，并列出未完成切片号

## 5. 明确不做清单

指向 `REVERSE_REVIEW__v1.0.md` 未冻结项：

1. **H3** — 管理端 reason / retry 决策表统一
2. **H4** — 第 48 节与 0.1 冲突裁决机械化
3. **H5** — 部分 API 响应 schema 补全
4. **全部 U 类** — 时钟注入、jitter 确定性、SLO 非门禁等

编码 Agent 遇到上述项：**不得**标成第 49 节范围，不得借 49 节顺手实现。

## 6. 建议执行节奏

```text
S1 状态机边  →  S2 编排 finalize  →  S3 预测映射
     →  S4 延期真值表  →  S5 rebuild oracle  →  S6 鉴权缺口
```

- 严格串行：后一切片依赖前序合法转移/同源映射时不要并行改同一文件。
- 每切片独立可回滚；保持 diff 最小。
- 每切片结束输出：`SUPERVISOR_STATUS=...` + 本切片测试要点一句。

## 7. 完成定义（第 49 节）

- [ ] S1～S6 测试与实现均落地
- [ ] `npm run typecheck` / `npm test -- --run` / `npm run build` / `git diff --check` 全绿
- [ ] 无 H3/H4/H5/U 范围代码
- [ ] 无真实微信/Provider、无凭证、无 commit/push
- [ ] 最终：`SUPERVISOR_STATUS=MVP_COMPLETE`
