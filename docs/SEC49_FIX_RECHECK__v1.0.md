# 第 49 节抽查修复复查报告（F1+F2+F3）

依据：`SEC49_DIFF_REVIEW__v1.0.md`、`DEV_PLAN_SEC49_FIX__v1.0.md`、`MVP__v1.0.md` §49
方法：只读搜索/读文件核实实现与测试；未改业务代码、未 commit。

## 1. 总评

F1/F2/F3 均已按修复单闭环：用户侧 Auth required 缺登录统一抛 `UNAUTHORIZED`（HTTP 仍 401），domain 侧 `can_predict_reason`/`predictRejectReason` 保留 `AUTH_REQUIRED` 且 `predictRejectCode` 映射 `UNAUTHORIZED`；first/retry/correction 三服务进入 settling/correcting 的起态已改为 `transitionMatchSettlementStatus`，finalize 仍保持「先写 `settled_result_version`/`settled_at` 再 transition」；session 再 init 不同 nickname 有回归用例且实现仍是 existing active 直接 return。原审查 5 条 finding 中，高/中全部 FIXED；低优先级 #4 FIXED，#5/#6 仍为可接受 OPEN（本切片未要求改）。管理端 `admin.ts` 仍抛 `AUTH_REQUIRED`，与修复单「本切片不强制改」一致，可接受但存在文档/运维分叉风险。

## 2. 逐条对照原 findings

### Finding #1 【高】49.1 缺可信身份对外 code 未对齐 `UNAUTHORIZED` → **FIXED**

| 检查项 | 结论 | 证据 |
|---|---|---|
| session 缺 trusted_openid | `UNAUTHORIZED` | `src/api/v1/session.ts:45` |
| profile / levels / unlocks / share-card | `UNAUTHORIZED` | `profile.ts:80`、`levels.ts:25`、`unlocks.ts:25`、`share-card.ts:42` |
| predictions GET + POST | 均 `UNAUTHORIZED` | `predictions.ts:58`（POST）、`predictions.ts:125`（GET read helper） |
| 测试不再锁死 `AUTH_REQUIRED` | 用户侧 API 测试均断言 `UNAUTHORIZED` | `session.test.ts:108`、`profile.test.ts:90/282/346`、`levels.test.ts:17`、`unlocks.test.ts:18`、`share-card.test.ts:88`、`prediction-list.test.ts:96`、`prediction-detail.test.ts:52`、`predictions.test.ts:115/125` |
| OpenAPI 401 描述 | 对齐 `UNAUTHORIZED` | `openapi.yaml:1588-1589`；`openapi-predictions.test.ts:44` |
| domain reason 保留 | 仍为 `AUTH_REQUIRED` | `prediction-policy.ts:101,122`；测试 `prediction-policy.test.ts:177-180` |
| reason→POST code 映射 | `AUTH_REQUIRED` → `UNAUTHORIZED` | `prediction-policy.ts:148-149`；测试 `prediction-policy.test.ts:256-257` |
| 用户侧业务入口是否仍抛 `AUTH_REQUIRED` | **否**（仅兼容映射/管理端） | 全库 `conflictError("AUTH_REQUIRED")` 仅剩 `application/admin.ts:15`；`validation.ts:49` 保留 `AUTH_REQUIRED: 401` 兼容映射 |

规范对照：MVP §49.1「缺少可信身份 → 401 `UNAUTHORIZED`」；§49.2 表「reason=`AUTH_REQUIRED` → POST code=`UNAUTHORIZED`」均满足。

**管理端备注（可接受）**：`src/application/admin.ts:15` 仍 `conflictError("AUTH_REQUIRED", ...)`。修复单明确「本切片不强制改」。HTTP 仍经 `validation.ts` 映射为 401，但 envelope.code 与用户侧不一致；若后续要彻底统一 49.1 语义，建议单独立项改管理端 + admin 测试。

### Finding #2 【中】match `settlement_status` 起态未全部经 `transitionMatchSettlementStatus` → **FIXED**

| 服务 | 起态 | 证据 |
|---|---|---|
| first-settlement | waiting→settling | `first-settlement-service.ts:285-290` `transitionMatchSettlementStatus(..., Settling, ...)` |
| retry-settlement | →settling | `retry-settlement-service.ts:231-236` |
| correction-settlement | →correcting | `correction-settlement-service.ts:275-280` |
| fail 路径 | →failed | first `342-347`；retry `273-278`；correction `329-334` |
| finalize 顺序 | 先写 version 再 transition | first `390-410`；retry `326-346`；correction `384-402`（注释明确 49.3/15.9） |
| 起态无 raw `settlement_status: Settling/Correcting` update | 三服务业务路径无 | 起态写均走 `updateSettlementStatus`（经 `transitionMatchSettlementStatus` @ `first-settlement-service.ts:122-141`） |
| 防回归测试 | 有 | first `first-settlement-service.test.ts:416+`；retry `retry-settlement-service.test.ts:352+`；correction `correction-settlement-service.test.ts:481+`（断言 `updateSettlementStatus`，排除仅改状态的 raw update） |

`transitionMatchSettlementStatus` 内部：同态 no-op、`validateSettlementTransition` Fail Closed、再 `updateSettlementStatus`（`first-settlement-service.ts:122-141`）。

**范围外残留（不回退 F2）**：`provider-status-sync.ts`、`provider-result-sync.ts`、`admin-result-correction.ts` 等仍可能用 `matches.update({ settlement_status })` 写 pending/voided/correcting 等（部分带 `validateSettlementTransition`）。原 finding #2 与 F2 切片仅要求 first/retry/correction 起态收口，故标 FIXED；全局「禁止业务层 raw update settlement_status」若要做，属后续 hardening，非本轮回归缺口。

### Finding #3 【中】Auth 错误码写/读接口分裂 → **FIXED**

- POST：`requireAuthenticatedUserId` → `UNAUTHORIZED`（`predictions.ts:56-58`）
- GET list/detail：`requireAuthenticatedUserIdForRead` → `UNAUTHORIZED`（`predictions.ts:123-125`）
- 对应测试：`predictions.test.ts`、`prediction-list.test.ts`、`prediction-detail.test.ts` 均断言 `UNAUTHORIZED`

与 finding #1 一并收敛，读写不再分裂。

### Finding #4 【低】session 再 init 不同 nickname 缺显式用例 → **FIXED**

- 实现：existing active 直接 `return { user: existing, created: false }`，不更新 nickname（`session.ts:117-122`）
- 回归：`session.test.ts:128-139` — Bob 再 init body `Alice`，响应与存储均为 `Bob`，`created=false`

### Finding #5 【低】墙钟到点写 `closed_at` 仅挂 provider sync → **OPEN（可接受）**

本切片未要求改；原审查已标可接受。中间窗口靠 49.2 `CLOSED`（`now >= deadline`）拒绝预测。无新证据恶化。

### Finding #6 【低】rebuild 读 prediction 仅校验非聚合缓存 → **OPEN（无缺陷）**

原审查明确「无需改逻辑」；本轮未触及。仍记 OPEN/无缺陷。

## 3. 新发现

### 【低】管理端缺身份 code 仍为 `AUTH_REQUIRED`，与用户侧 49.1 冻结表分叉

- **位置**：`src/application/admin.ts:15`
- **现象**：管理端 envelope.code=`AUTH_REQUIRED`，用户侧为 `UNAUTHORIZED`；HTTP 同为 401。
- **为何记低**：修复单明确不强制；不影响用户 API 契约。风险在运维/客户端若复用同一错误分支会漏处理。
- **建议**：后续统一管理端为 `UNAUTHORIZED`，并改 admin 相关测试。

### 【低】全局 settlement_status 写入入口仍非 100% 单一

- **位置**：`provider-status-sync.ts`、`provider-result-sync.ts`、`admin-result-correction.ts` 等
- **现象**：F2 三服务起态已统一；其他路径仍可能 raw `matches.update` 改 `settlement_status`（部分已 validate）。
- **为何记低**：超出 F2 验收范围；非半统一回潮（目标路径已修）。
- **建议**：若要对齐 49.3「编排层与状态机同一套合法表」的全局表述，可另开 hardening：业务层一律 `transitionMatchSettlementStatus`，仅新建 match 初始 pending 例外。

### 未发现的高/中回归

- 无用户侧缺登录仍抛 `AUTH_REQUIRED` 的 API 入口
- 无 first/retry/correction 起态 raw `settlement_status: Settling/Correcting`
- 无 finalize 顺序被破坏（先 settled 再 correcting 且漏写 version）的迹象
- 无测试把旧 `AUTH_REQUIRED` 鉴权 envelope 锁死为绿（用户侧）
- OpenAPI Unauthorized 描述已对齐，未见明显契约漂移

## 4. 亮点

1. **鉴权分层正确**：HTTP envelope 用 `UNAUTHORIZED`，领域 reason 字段保留 `AUTH_REQUIRED`，映射表单测完整（49.1 + 49.2 双语义不混）。
2. **起态收口有防回归测试**：三服务均用 write-spy 断言 `updateSettlementStatus`，并排除「仅改 status 的 raw update」。
3. **finalize 顺序与注释保留**：先 `settled_result_version`/`settled_at` 再 re-read 决定 settled/correcting，与 15.9/49.3 一致。

## 5. 结论

原审查阻塞项（高 #1、中 #2/#3）与同轮低项 #4 均已闭环；剩余为管理端码分叉与全局状态写入 hardening（低）、以及原 #5/#6 可接受 OPEN。

**RECHECK_STATUS=PASS**

findings=2 severity_max=低
（新发现 2 条低；原高/中 findings 计 FIXED，不计入未闭环计数）
