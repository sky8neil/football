# H4：Auth OpenAPI 诚实表达开发计划 v1.0

> 范围：只解决 A 阶段记录的 `SPEC_GAP/H4`——`src/api/v1/openapi.yaml` 中 `BearerAuth` / `bearerFormat: JWT` 与 `MVP__v1.0.md` §49.1 可信 openid 注入模型冲突。
> 角色：规范/合同层切片；本文件是执行说明书，不是实现提交。
> 基线：现有未提交 A1–A4 改动受保护，不得 stash/reset/restore/checkout。
> 禁止：启动 B/C；发明 Header / JWT / Cookie / session token / 登录 token / 新用户字段 / 新 endpoint；读取凭证与真实环境。

产品裁决（已授权，直接执行）：

1. 真实身份由部署网关/运行环境注入可信 `openid`。
2. 后端不签发 JWT / Cookie / session token。
3. 客户端不得传 `openid` / `user_id` / JWT 作为业务 API 身份。
4. OpenAPI 必须诚实表达“依赖可信运行时上下文”，不得继续使用 `BearerAuth`/`JWT`，也不得新增可由客户端伪造的 `X-Openid` 类 Header security scheme。
5. 具体网关协议留给 B3；本轮只冻结业务 API 合同层 vendor extension 与说明。

---

## 1. 目标与非目标

### 目标

- 消除 OpenAPI 对 JWT Bearer 的虚假承诺。
- 在业务 API 合同层固定：Auth required 接口（含 `POST /session/init`）依赖**可信运行时 openid**，而不是客户端凭证。
- 用可机械判定的 OpenAPI 表达与合同测试关闭 `SPEC_GAP/H4`，解除 A5 的该 blocker。
- 保持 handler 输入仍为既有 `trusted_openid`（或等价运行时注入字段），不改业务字段/错误码语义。

### 非目标

- 不实现真实网关/CloudBase/微信登录接线（B3）。
- 不新增、不改名任何业务 endpoint 或响应字段。
- 不定义客户端可提交的鉴权 Header/Cookie/query。
- 不改 401 以外既有错误码语义（如 `USER_DELETED=409`、`FORBIDDEN=403`）。
- 不处理 REVERSE_REVIEW 原文中“§48 vs §0.1 冲突裁决机械化”的另一条历史 H4 命名项；本切片仅处理 A 阶段阻塞 A5 的 Auth OpenAPI `SPEC_GAP/H4`。
- 不启动阶段 B/C。

---

## 2. 冻结后的 OpenAPI 表达

### 2.1 必须移除

从 `src/api/v1/openapi.yaml` 删除：

1. 全部 operation 级：

```yaml
security:
  - BearerAuth: []
```

2. `components.securitySchemes.BearerAuth` 整块（含 `type: http` / `scheme: bearer` / `bearerFormat: JWT`）。

3. 任何全局 `security: [BearerAuth]`（若存在）。

禁止替换为：

- `http bearer` / `apiKey` / `oauth2` / `openIdConnect` security scheme
- 任何客户端可直接填写的 Header/Cookie/query 身份 scheme（含 `X-Openid`、`Authorization`、自定义 token）

### 2.2 采用的 vendor extension

**文档级（`openapi.yaml` 根，与 `info`/`paths` 同级）固定：**

```yaml
x-trusted-runtime-openid:
  required_for: auth_required_operations
  identity_field: openid
  injection: gateway_or_runtime
  client_supply_forbidden: true
  notes: >
    身份由部署网关/运行环境注入可信 openid（或等价运行时字段）。
    后端不签发 JWT/Cookie/session token。
    客户端不得在 body/query/header 中提交 openid、user_id 或 JWT 作为业务身份。
    具体网关字段映射由 B3 实现，不改变本 API 合同。
```

**operation 级标记：**

| 接口类型 | OpenAPI 标记 |
|---|---|
| Auth required（含 `POST /session/init`） | `x-requires-trusted-openid: true` |
| 公开读（可不登录） | **不写**该 extension；也不写任何 security scheme |
| 公开读且可带可选登录上下文 | **不写**强制 extension；身份若存在仍只来自可信运行时，不得改成客户端凭证 |

说明：

- `x-requires-trusted-openid: true` 只表达合同依赖，**不是**可调用的客户端输入。
- 不把 `trusted_openid` 写成 request parameter / header / body 字段。
- `POST /session/init` 与其它 Auth required 接口同等要求：必须有可信 openid；body 仅允许既有 `nickname` 等已冻结字段。

### 2.3 当前必须打标的 Auth required 路径（以 openapi 现状为准）

下列 operation 当前带 `BearerAuth`，H4 后改为 `x-requires-trusted-openid: true`，并删除其 `security`：

- `POST /session/init`
- `POST /predictions`
- `GET /predictions/me`
- `GET /predictions/me/{prediction_id}`
- `GET /profile/me`
- `PATCH /profile/me`（或 openapi 中实际 method）
- `DELETE /profile/me`（或 openapi 中实际 method）
- `GET /levels/me`
- `GET /unlocks/me`
- `GET /share-card/me`
- `GET /admin/anomalies`
- `POST /admin/matches/{match_id}/result-corrections`
- `POST /admin/matches/{match_id}/retry-settlement`
- `POST /admin/rebuild/users/{user_id}`
- `POST /admin/rebuild/rankings`

公开路径（如 `GET /matches`、`GET /matches/{match_id}`、`GET /profiles/{user_id}`、`GET /rankings`）保持无 security、无 `x-requires-trusted-openid`。

### 2.4 `info.description` 最小补充（可选但推荐）

在既有 description 中增加一句，不扩写协议：

> 鉴权模型：依赖部署网关/运行环境注入的可信 openid；见根级 `x-trusted-runtime-openid`。客户端不得传身份凭证。

---

## 3. 401 `UNAUTHORIZED` 边界（冻结）

沿用 §49.1 / 既有 mapper，本切片只写清边界，不改码表。

| 条件 | HTTP | code | 说明 |
|---|---|---|---|
| 缺少可信 openid（null/空/未注入） | 401 | `UNAUTHORIZED` | Auth required 与 `session/init` 均适用 |
| 应用层 `AUTH_REQUIRED` | 401 | 对外映射为 `UNAUTHORIZED` | 保持现有 `mapErrorToHttp` |
| 可信 openid 对应用户已注销 | 409 | `USER_DELETED` | **不是** 401 |
| 可信 openid 非 active admin | 403 | `FORBIDDEN` | **不是** 401 |
| 客户端 body/query 夹带 `openid`/`user_id` 试图冒充 | 422 或 403/404 | 按既有接口规则 | 不得静默切换身份；不得把伪造值当可信身份 |
| 公开读接口无身份 | 200（或既有业务错误） | — | 不得因无身份对纯公开读返回 401 |

明确不存在的 401 原因（本项目无此模型）：

- JWT 过期 / 签名失败
- Cookie/session 失效
- Bearer token 缺失

`session/init`：

- 无可信 openid → **401 `UNAUTHORIZED`**
- 有可信 openid 且 active 用户存在 → 200
- 有可信 openid 且用户不存在 → 201
- 有可信 openid 且用户已注销 → 409 `USER_DELETED`

---

## 4. 需变更文件清单

### 必改

1. `src/api/v1/openapi.yaml`
   - 删全部 `BearerAuth` security 与 securitySchemes
   - 加根级 `x-trusted-runtime-openid`
   - Auth required operations 加 `x-requires-trusted-openid: true`

2. `src/api/v1/openapi-unlocks.test.ts`
   - 当前断言 `security: - BearerAuth: []`，改为断言 `x-requires-trusted-openid: true`，并断言不存在 BearerAuth

3. **新增** `src/api/v1/openapi-auth-h4.test.ts`（H4 合同验收，见 §5）

### 可能需同步（仅当现有测试硬编码 BearerAuth）

- 其它 `src/api/v1/openapi-*.test.ts` 中若匹配 `BearerAuth`，改为新 extension 断言
- 执行前用只读搜索确认：`rg -n "BearerAuth" src/api/v1`

### 明确不改

- 业务 handler 的对外 HTTP body/query schema
- application/domain 规则
- 仓库内未提交 A1–A4 基线行为（除为消除 BearerAuth 断言所必需的合同测试字面量）
- 不新增真实网关适配代码（B3）
- 不改 `.env`、部署配置、凭证

### 代码健壮性下限（够用即可，避免工程化）

若实现时触及运行时鉴权辅助：

- 仅保留：可信 openid 缺失 → `UNAUTHORIZED`；已有 `AUTH_REQUIRED → UNAUTHORIZED` 映射
- 不引入 token 解析、refresh、中间件框架、新抽象层
- handler 继续接收已注入的 `trusted_openid`；B3 之前测试继续直接传该字段

---

## 5. TDD：RED → GREEN

### 5.1 RED（先写失败测试）

新增 `src/api/v1/openapi-auth-h4.test.ts`，至少包含：

1. **禁止 JWT/Bearer 表达**
   - `openapi.yaml` 全文不匹配 `BearerAuth`
   - 不匹配 `bearerFormat: JWT`
   - 不匹配 `scheme: bearer`

2. **禁止可伪造客户端身份 scheme**
   - `components.securitySchemes` 若存在，不得声明 apiKey/header 形式的 openid/user_id/token
   - 全文不出现把 `openid` 作为 `in: header|query|cookie` 的 parameter（body 里业务字段除外；`session/init` body 仍禁止 openid）

3. **文档级 extension 存在且值正确**
   - 存在 `x-trusted-runtime-openid:`
   - 含 `identity_field: openid`
   - 含 `injection: gateway_or_runtime`
   - 含 `client_supply_forbidden: true`

4. **Auth required operations 打标**
   - §2.3 列表中每个 path+method 块内存在 `x-requires-trusted-openid: true`
   - 上述块内不存在 `security:`

5. **公开接口不加强制身份 extension**
   - `GET /matches`、`GET /rankings`（及现有其它公开读）不出现 `x-requires-trusted-openid: true`

6. **session/init 特例**
   - `POST /session/init` 必须 `x-requires-trusted-openid: true`
   - 仍声明 401 Unauthorized

7. **既有 401 行为回归（最小，不扩 scope）**
   - 复用/保留现有 API 测试：缺 `trusted_openid` 的 `session/init`、predictions、unlocks、admin 等返回 `UNAUTHORIZED`
   - 不要求本切片重写全部业务测试

同步修改 `openapi-unlocks.test.ts` 中 BearerAuth 断言，避免旧断言与 H4 目标打架。

### 5.2 GREEN

1. 按 §2 修改 `openapi.yaml`
2. 跑：

```bash
npx vitest run src/api/v1/openapi-auth-h4.test.ts src/api/v1/openapi-unlocks.test.ts src/api/v1/session.test.ts
```

3. 再跑受影响 OpenAPI 合同测试集合（`src/api/v1/openapi-*.test.ts`）全部通过
4. 确认无 `BearerAuth` 残留：

```bash
rg -n "BearerAuth|bearerFormat: JWT" src/api/v1
```

期望：仅测试中以“不得出现”形式提及，或零匹配。

### 5.3 完成定义（本切片 DONE）

- [ ] OpenAPI 无 Bearer/JWT security scheme
- [ ] 根级 `x-trusted-runtime-openid` 已固定
- [ ] Auth required（含 session/init）均有 `x-requires-trusted-openid: true`
- [ ] 公开读无该强制标记
- [ ] H4 合同测试与相关 OpenAPI 测试 GREEN
- [ ] 未改业务 endpoint/字段，未发明客户端身份传输
- [ ] 未启动 B/C，未 commit/push

---

## 6. A5 PASS 的机械判据（仅 H4 相关）

A5 整体另有前端 schema 检查；**就 H4 blocker**，以下全部为真才可记 `H4 closed`：

| # | 判据 | 检查方式 |
|---|---|---|
| H4-1 | `openapi.yaml` 无 `BearerAuth` / `bearerFormat: JWT` / `scheme: bearer` | `rg` + `openapi-auth-h4.test.ts` |
| H4-2 | 无客户端可伪造的 openid Header/query security scheme | 同上 |
| H4-3 | 存在根级 `x-trusted-runtime-openid`，且 `client_supply_forbidden: true` | 合同测试 |
| H4-4 | §2.3 Auth required 列表均 `x-requires-trusted-openid: true` 且无 `security:` | 合同测试 |
| H4-5 | `POST /session/init` 在 H4-4 内 | 合同测试 |
| H4-6 | 缺可信身份 → 401 `UNAUTHORIZED` 的既有 API 测试仍通过 | vitest |
| H4-7 | 业务成功/失败 envelope、字段、排序、cursor 未被本切片改动 | diff 仅限 openapi 鉴权表达与相关测试 |

A5 仍可因其它非 H4 项失败；但 **不得再因 BearerAuth/JWT 与 §49.1 冲突而 block**。

---

## 7. B3 对接方式（不改 API 合同）

B3（云函数/路由/环境）只做运行时适配：

```text
网关/平台可信上下文
  → 提取 openid（平台字段名仅 B3 知道）
  → 填入 handler 输入 trusted_openid
  → 调用既有 API handler
```

约束：

1. **不改变** OpenAPI 合同、extension 名、错误码、body/query schema。
2. **不**为了接线重新引入 BearerAuth/JWT/Cookie 登录协议。
3. **不**让客户端改传 `openid`/`user_id` 来“补”网关缺失；网关未注入则 401。
4. 本地/单测继续直接注入 `trusted_openid`，与生产网关路径同合同。
5. 若未来平台提供多种上下文字段，归一为单一可信 `openid` 后再进业务层；归一规则属 B3，不泄漏为 API 参数。

---

## 8. SPEC_GAP（本切片之后仍保留）

仅保留真实未定义项：

1. **具体网关/运行时协议**：CloudBase / 云函数 / 微信上下文中 openid 的平台字段名、注入点、本地模拟方式。
2. **平台登录流程**：小程序/宿主如何完成平台侧登录，使网关能够注入可信 openid。

以上不影响业务 API 合同，不阻塞 A5 的 H4 关闭条件；由 B3 实现时再写部署说明，不得反向修改本切片冻结的 extension 语义。

非本切片、勿在此发明：

- Header 名、token 格式、cookie 名
- 刷新令牌、会话 TTL、登出 endpoint
- 新的用户身份字段

---

## 9. 执行顺序（给实现 Agent）

1. 只读确认：`MVP__v1.0.md` §49.1、本文件、`openapi.yaml` security 现状、`rg BearerAuth src/api/v1`。
2. RED：写 `openapi-auth-h4.test.ts`，改掉 `openapi-unlocks.test.ts` 的 Bearer 断言；测试应失败。
3. GREEN：改 `openapi.yaml` 按 §2。
4. 跑 §5.2 命令；全绿。
5. 自检 §5.3 / §6 清单。
6. 停止。不 commit、不 push、不开始 B3。

---

## 10. 一句话验收

> OpenAPI 不再假装 JWT Bearer；它声明“可信运行时 openid”，`session/init` 与所有 Auth required 接口合同一致，401 仅表示缺可信身份，网关细节留给 B3 且不得回写 API 合同。
