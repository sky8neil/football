# 第 49 节关键 Diff 抽查报告

## 总评（一段话）

第 49 节核心业务（`settling→correcting`、finalize 先写 `settled_result_version`、预测拒绝 1→6 同源、延期 closed_at 真值表、rebuild 以 applied ledger 为准）整体已落地且有针对性测试，未发现“先 settled 再 correcting 却漏写 `settled_result_version`”的路径。主要缺口在 **49.1 对外错误码未收敛到 `UNAUTHORIZED`**（session/多数 Auth required 仍抛 `AUTH_REQUIRED`，测试还锁死了旧码），以及结算状态写入 **未全部统一走 `transitionMatchSettlementStatus`**。结论偏“核心 49.3/49.2/49.4/49.5 可用，鉴权契约与 Fail Closed 统一入口仍需补”。

## 阻塞/高

### 1. 【高】49.1 缺可信身份对外 code 未对齐 `UNAUTHORIZED`（含测试假绿）
- **文件**：`src/api/v1/session.ts`、`src/api/v1/profile.ts`、`src/api/v1/levels.ts`、`src/api/v1/unlocks.ts`、`src/api/v1/share-card.ts`、`src/api/v1/predictions.ts`（GET 路径）、对应 `*.test.ts`
- **现象**：
  - 规范 49.1 明确：缺少可信身份 → HTTP **401** + code **`UNAUTHORIZED`**。
  - 实现上：`session` 缺 `trusted_openid` 仍 `conflictError("AUTH_REQUIRED", ...)`；profile/levels/unlocks/share-card/预测读接口同理。
  - 仅 `POST /v1/predictions` 的 `requireAuthenticatedUserId` 已改为 `UNAUTHORIZED`。
  - `validation.ts` 虽把 `AUTH_REQUIRED` 与 `UNAUTHORIZED` 都映射 401，但**响应 body.code 仍是旧码**。
  - `session.test.ts` / `profile.test.ts` 等断言 `code: "AUTH_REQUIRED"`，把未收敛行为锁成绿。
- **为何有问题**：客户端/网关按冻结表判码会失败；与 49.2 表中“reason=`AUTH_REQUIRED` → POST code=`UNAUTHORIZED`”的对外语义也不一致；计划 S6 要求“对外码按 49.1 为 `UNAUTHORIZED`”。
- **建议**：Auth required 入口统一抛 `UNAUTHORIZED`；保留 `AUTH_REQUIRED` 仅作 `can_predict_reason` 字段值；同步改 OpenAPI 与测试断言。

## 中

### 2. 【中】match `settlement_status` 变更未全部经 `transitionMatchSettlementStatus`
- **文件**：
  - `src/application/first-settlement-service.ts`（约 285–290：直接 `matches.update` 写 `Settling`）
  - `src/application/retry-settlement-service.ts`（约 239–244：校验后仍 raw update）
  - `src/application/correction-settlement-service.ts`（约 275–280：校验后 raw update）
- **现象**：已抽出 49.3 单一入口 `transitionMatchSettlementStatus`（finalize/fail 路径在用），但**进入 settling/correcting 的起始写**仍绕开该入口；first 起始路径甚至未调用 `validateSettlementTransition`（只靠 `decideFirstSettlement` 要求 `waiting`）。
- **为何有问题**：49.3 / S2 要求“所有 match settlement_status 变更先 validate、编排层与状态机同一套合法表”。当前是“半统一”：终态/失败走入口，起态旁路。竞态或未来改 decision 时容易再引入非法边，Fail Closed 不完整。
- **建议**：起态也改为 `await transitionMatchSettlementStatus(...)`；禁止业务层直接 `update({settlement_status})`（除新建 match 初始 pending）。

### 3. 【中】Auth 错误码在写/读接口间分裂，增加集成歧义
- **文件**：`src/api/v1/predictions.ts`（POST=`UNAUTHORIZED`，GET=`AUTH_REQUIRED`）
- **现象**：同一资源域鉴权失败 code 不一致；HTTP 都是 401，但 envelope.code 不同。
- **为何有问题**：49.1 按接口类型统一“缺可信身份”语义，不是“写接口一套、读接口一套”。运维/客户端错误处理易漏分支。
- **建议**：与 finding #1 一并收敛。

## 低 / 建议

### 4. 【低】session 再 init 忽略 nickname 行为正确，但缺少“新旧 nickname 不同”显式用例
- **文件**：`src/application/session.ts`（existing active 直接返回，不更新）、`src/application/session.test.ts`
- **现象**：实现符合 49.1（再 init 忽略 body nickname）；测试多为同 nickname 幂等，未断言 `nickname: "Bob"` 再 init `"Alice"` 仍返回 `"Bob"`。
- **建议**：补一条差异 nickname 回归，防止后续“顺手更新资料”回潮。

### 5. 【低】墙钟到点写 `closed_at` 仅挂在 provider sync 路径，无独立 closer
- **文件**：`src/domain/prediction-deadline.ts`、`src/application/provider-status-sync.ts`、`src/application/provider-schedule-sync.ts`
- **现象**：`decidePredictionClosedAt` 的 scheduled 到点条件完整；postponed 不会因旧 deadline 写 closed_at。但落库关闭依赖 sync 观察；中间窗口靠 49.2 `CLOSED`（`now >= deadline`）拒绝预测。
- **建议**：可接受；若要强一致落表，可加只读扫描 job，仍必须走 `decidePredictionClosedAt`（含 `match_status==scheduled`）。

### 6. 【低】rebuild 读 prediction 仅作身份/比分校验，非缓存命中聚合（无缺陷，记一笔）
- **文件**：`src/application/rebuild-service-support.ts`、`stats-rebuild-service.ts`
- **说明**：会 `findById(prediction)` 校验 user/match/原始比分并重算与 item 一致性，**聚合输入仍是 applied items**；`acceptance-44-n-rebuild.test.ts` 污染 `match_score/wdl_hit/exact_hit` 仍以 ledger 为准。无需改逻辑。

## 已对齐的亮点（最多 5 条）

1. **49.3 状态机**：`ALLOWED_TRANSITIONS` 含 `settling→correcting`，单测覆盖合法/非法边。
2. **15.9/49.3 finalize 顺序**：first/retry/correction 均先写 `settled_result_version=v` + `settled_at`，再 re-read 后 `settled` 或 `settling→correcting`；有顺序断言测试。
3. **49.2 同源同序**：`predictRejectReason`/`predictRejectCode` 1→6 命中即停；`match-query` 与 `predictions.submit` 共用；幂等重放在失败表之前，不误入拒绝分支。
4. **49.4 延期真值表**：`decidePredictionClosedAt` 墙钟关闭强制当前 `match_status==scheduled`；postponed 重复观察不因旧 deadline 写 `closed_at`；截止后才延期可先关死。
5. **49.5 rebuild oracle**：stats/ranking rebuild 与 N108/N109 验收以 applied ledger 为唯一事实源，故意污染 prediction 缓存不影响结果。

## 结论：NEEDS_FIX

核心结算/预测/延期/rebuild 方向正确，但 **49.1 对外错误码未按冻结表收敛到 `UNAUTHORIZED`（高）**，且结算状态写入入口未完全统一（中）。建议先修鉴权 code + 测试，再收口 `transitionMatchSettlementStatus`。

REVIEW_STATUS=DONE findings=5 severity_max=高