# 第 49 节抽查修复单（SEC49_DIFF_REVIEW）

依据：`SEC49_DIFF_REVIEW__v1.0.md`（NEEDS_FIX）
范围：只修审查报告中的 **高 + 中**；低优先级可顺手做 #4。
不做：H3/H4/H5/U、新业务、commit/push、真实外部 API。

## 切片顺序

### F1 — 49.1 对外鉴权 code 统一为 `UNAUTHORIZED`（高）

**目标**：缺可信身份时，用户侧 Auth required 接口响应 `code=UNAUTHORIZED`（HTTP 401），与 49.1 / S6 冻结一致。

**改什么**：

| 位置 | 动作 |
|---|---|
| `src/api/v1/session.ts` | `AUTH_REQUIRED` → `UNAUTHORIZED`（缺 trusted_openid） |
| `src/api/v1/profile.ts` | 同上 |
| `src/api/v1/levels.ts` | `requireAuthenticatedUserId` → `UNAUTHORIZED` |
| `src/api/v1/unlocks.ts` | 同上 |
| `src/api/v1/share-card.ts` | 同上 |
| `src/api/v1/predictions.ts` | GET 读路径 `requireAuthenticatedUserIdForRead` → `UNAUTHORIZED`（与 POST 一致） |
| 对应 `*.test.ts` | 断言从 `AUTH_REQUIRED` 改为 `UNAUTHORIZED` |
| OpenAPI（若有相关描述） | 401 描述对齐 `UNAUTHORIZED` |

**明确保留**：

- `can_predict_reason` / domain `predictRejectReason` 仍返回 **`AUTH_REQUIRED`**（字段语义，不是 HTTP envelope.code）
- `predictRejectCode("AUTH_REQUIRED")` → `"UNAUTHORIZED"` 已有，勿改
- 管理端 `application/admin.ts` 的 `AUTH_REQUIRED`：**本切片不强制改**（审查点在用户侧 Auth required；若一并改管理端缺身份码为 UNAUTHORIZED 且不破坏 49.1 亦可，但优先用户 API）
- `validation.ts` 里 `AUTH_REQUIRED: 401` 可保留作兼容映射，但业务入口应不再抛该 code 给用户侧缺登录场景

**验收**：

- 缺登录：session / profile / levels / unlocks / share-card / predictions GET+POST 均 `code: "UNAUTHORIZED"`
- domain 单测：`predictRejectReason` 仍为 `AUTH_REQUIRED`；`predictRejectCode` 仍映射 `UNAUTHORIZED`
- typecheck + 全量 test + build + git diff --check 全绿

### F2 — 结算起态统一走 `transitionMatchSettlementStatus`（中）

**目标**：match `settlement_status` 进入 settling/correcting 的写路径不再 raw `matches.update` 旁路。

**改什么**：

| 文件 | 动作 |
|---|---|
| `first-settlement-service.ts` | waiting→settling 起态改为 `await transitionMatchSettlementStatus(tx, matchId, Settling, serverNow)`（不要再拼整个 match 对象只改 status 再 update） |
| `retry-settlement-service.ts` | →settling 起态同上；去掉“先 validate 再 raw update”的半统一 |
| `correction-settlement-service.ts` | →correcting 起态同上 |

**注意**：

- finalize 路径里先 `matches.update` 写 `settled_result_version` / `settled_at` 再 `transitionMatchSettlementStatus` 到 settled/correcting 的顺序 **保持不变**（15.9 / 49.3）
- `transitionMatchSettlementStatus` 内部已 validate + `updateSettlementStatus`；起态调用即可
- 若起态还需要同时写其他字段，可：先 transition 状态，再 update 非 status 字段；或扩展单一入口（优先最小改动：先 transition）

**验收**：

- 起态路径无 `settlement_status: Settling/Correcting` 的 raw update（可用搜索确认业务层）
- 相关 first/retry/correction 单测仍绿；必要时补“非法边 Fail Closed”回归
- 全量验证绿

### F3 — session 再 init 不同 nickname 回归（低，可同轮）

- 在 `session.test.ts`（application 或 api）补：active 用户 nickname=`Bob`，再 init body nickname=`Alice`，响应仍 `Bob`，且不更新资料
- 实现已符合 49.1 则只加测试

## 完成定义

F1 + F2 完成且独立验证全绿 → `SUPERVISOR_STATUS=MVP_COMPLETE`
仅完成其中一轮切片 → `SUPERVISOR_STATUS=PASS`
被规范缺口堵住且无其他可做 → `SUPERVISOR_STATUS=BLOCKED_SPEC`

## 不做清单

- 不扩 H3/H4/H5/U
- 不改 49.2 reason 字段语义（`AUTH_REQUIRED` 作为 can_predict_reason 保留）
- 不 commit / 不 push
- 不连真实微信 / Provider / CloudBase
