# B3 / C2 开发计划 v1.0

> 状态：开发规划（**未授权实现**）。  
> 基线：`b115180`（受保护，不得 reset/stash/restore/checkout）。  
> 业务规则：`MVP__v1.0.md` §49.1–§49.16；API：`src/api/v1/openapi.yaml`。  
> 范围输入：`C0_H5_MINIMUM_USER_SCOPE_DECISION__v1.0.md`、`C1_PLATFORM_NEUTRAL_WIREFRAME_ACCEPTANCE__v1.0.md`、`DEVELOPMENT_PLAN_ABC__v1.0.md`（A5/B1–B5/C0–C2）。  
> 本文只规划 **B3 网关接线** 与 **C2 微信小程序用户端**；**不**改 API 合同、**不**写实现代码、**不**选型云托管/云函数以外的运行时（运行时最终由主审确认）。

---

## 0. 已冻结输入（不得改变）

| 项 | 冻结结论 |
|---|---|
| A5 | **PASS**：首版用户端范围冻结 |
| 客户端形态 | **微信小程序** |
| 首版 UI | 会话、比赛列表/详情、预测提交、我的预测、资料/等级、解锁、排行榜 |
| 明确不做 | 管理端 UI；资料编辑/注销/公开主页/分享卡 |
| unlock 展示 | 仅 `unlock_code` / `threshold_points` / `unlocked_at` + 前端静态映射 |
| 身份模型 | 网关/运行时注入可信 openid；**不**发明 JWT/Cookie/session；客户端**不得**传 openid/user_id |
| B3 方向 | 微信云开发 **云函数** 薄网关；`cloud.getWXContext().OPENID` → `trusted_openid`；业务 handler **零改动** |
| B1 / B2 | 尚未实施；**不得**阻塞 B3/C2 垂直切片与 UI 验收 |
| 预测幂等 | 按 C1 §4：意图 key、同 key 同 payload 重放、改分换新 key |
| 比赛态/拒绝 | 按 C1 §3 与 §49.2；UI 以服务端 `can_predict`/`can_predict_reason` 为准 |

---

## 1. 目标 / 非目标

### 1.1 目标

1. **B3**：把已冻 `src/api/v1/*` handler 接到微信云函数薄网关；注入 `trusted_openid`、映射 HTTP 语义与错误 envelope，使小程序可调用冻结 API。
2. **C2**：在微信小程序上实现 C0/C1 七个必做页与状态矩阵，消费既有用户端 endpoint，完成 C1 §6 验收场景。
3. 用 **内存 repository + 本地 mock 网关** 先跑通全部已冻结用户端 API，不把 B1/B2 当作 UI 门禁。

### 1.2 非目标（硬边界）

- 不改 OpenAPI、handler 输入输出、领域规则、错误码、字段。
- 不实现 B1（CloudBase DB）、B2（真实 API-Football）、B4 调度、B5 共享限流。
- 不做管理端 UI；不做资料编辑/注销/公开主页/分享卡。
- 不发明 unlock 服务端文案/图标 API；不发明 predictions/me 球队名。
- 不发明 JWT/Cookie/session 登录体系；生产禁止前端传身份。
- 不写具体组件库/框架样板代码；不猜测未冻结 UI 文案。
- 不读取 `.env`/凭证/真实库/日志；不 commit/push。

---

## 2. 前置依赖与顺序

### 2.1 已完成

| 前置 | 状态 | 含义 |
|---|---|---|
| A5 用户端 API 冻结 | PASS | C2 可绑定 C0/C1 页面与 endpoint |
| C0 最小用户范围 | 冻结 | 七页必做 + 明确关闭项 |
| C1 状态/验收 | 冻结 | §3/§4/§6 为 C2 验收源 |
| 平台选型 | 微信小程序 | C2 实现形态确定 |
| H4 / §49.16 | 合同层关闭 | 身份 = 运行时 openid，无 JWT |

### 2.2 B1/B2 未做的影响与缓解

| 缺口 | 对 B3/C2 的影响 | 缓解（本计划允许） |
|---|---|---|
| B1 真实 CloudBase repository | 无持久化生产数据 | C2 开发期用 **内存 repository**；handler 输入不变 |
| B2 真实 API-Football | 无真实赛程同步 | 内存预置/fixture 比赛数据；不改 match 合同 |
| 生产调度 (B4) | 无自动同步/结算 | UI 验收用静态/手工种子数据 |
| 共享限流 (B5) | 多实例限流未统一 | 保持现有内存限流语义；不改 429 合同 |

**结论：** B1/B2 **并行或后置**；B3 mock 网关 + 内存 repo 必须能独立跑通：session / matches / predictions / predictions/me / profile/me / levels/me / unlocks/me / rankings。

### 2.3 建议顺序（不互相阻塞）

```text
主审通过本计划
  → V0：本地 mock 网关 + 内存 repo 可调通 session + matches
  → B3 切片与 C2 垂直切片并行（见 §5）
  → B1 / B2 另轨，替换适配器时 API 语义不变
```

---

## 3. B3 切片（小、可验收）

> 原则：薄网关只做 **路由 / 身份注入 / envelope / 日志脱敏**；`postSessionInit`、`getMatches`、`postPrediction` 等 handler **签名与语义零改动**。

### B3-1 云函数入口与路由骨架

- **做：** 单一（或最小）HTTP 云函数入口；按 method+path 分发到既有 `src/api/v1/*`；生成 `request_id`；统一 `mapErrorToHttp`。
- **不做：** 改 handler 业务；挂管理端 UI。
- **验收：** 本地/测试可对 `/v1/matches` 返回 200 envelope（`data` + `request_id`）；未知 path → 既有错误映射；无 JWT 中间件。

### B3-2 OPENID 注入（生产路径）

- **做：** 云函数内 `cloud.getWXContext().OPENID` → 内部 `trusted_openid`；仅网关层持有；传给 session/admin 等需要 openid 的入口。
- **不做：** 客户端 header/body/query 身份；JWT/Cookie。
- **验收：** 有 OPENID 时 Auth 路径可达；无 OPENID → handler 侧 `401 UNAUTHORIZED`；请求体含 `openid`/`user_id` 仍按合同拒绝（未知字段/不得冒充）。

### B3-3 身份解析复用（openid → user）

- **做：** 对需要 `authenticated_user_id` 的 handler（predictions/profile/levels/unlocks 等）：网关用 repository `findByOpenid(trusted_openid)` 解析；active → 传 `user_id`；deleted → 保持 application/handler 的 `409 USER_DELETED`；无用户且非 init → 按既有 401/404 合同（**不**新造码）。
- **session/init：** 只传 `trusted_openid` + body `nickname`，由 application 创建/幂等。
- **公开读：** matches/rankings 可不解析用户；若有可信身份，可解析后传可选 `authenticated_user_id` 以返回 `my_prediction` / reason。
- **验收：** 与现有 handler 测试一致：缺身份 401；注销 409；init 201/200/409。

### B3-4 401 / 409 边界与错误 envelope

- **做：** 全部出口经 `mapErrorToHttp`；HTTP + `code`/`message`/`request_id`/`details` 与 OpenAPI 一致；程序分支用 `code`。
- **验收矩阵：**
  - 缺 OPENID → 401 `UNAUTHORIZED`
  - 注销用户 Auth → 409 `USER_DELETED`
  - 预测拒绝码与 §49.2 / C1 §4.5 一致
  - 422/429/500 可区分

### B3-5 本地 / 测试 mock 身份（仅 dev/test）

- **做：** 环境变量（键名规划级，**不**写真实值）仅在 `environment ∈ {dev,test}` 注入 mock `trusted_openid`；用于 vitest/本地 HTTP 夹具。
- **硬约束：** `prod` **禁止** mock；**禁止**任何环境接受前端提交身份覆盖 OPENID。
- **验收：** dev/test 可固定 openid 跑集成；切 prod 配置后 mock 失效；无凭证入库。

### B3-6 环境配置键与隔离

- **做：** 复用 `EnvironmentConfig` 思路：`environment`、`cloud_environment_id`、`resource_namespace` 在 dev/test/prod **唯一**；配置键清单（无密钥值）：云环境 ID、函数名、mock openid 开关（非 prod）、日志级别。
- **验收：** `assertEnvironmentIsolation` 语义保留；三环境资源不共用。

### B3-7 部署 / 回滚最小步骤（文档级）

1. 部署目标环境云函数（同版本包）。
2. 烟测：公开 `GET /v1/matches`；带运行时身份 `POST /v1/session/init`。
3. 失败：回滚上一云函数版本；不改库 schema（B1 未接时无迁移）。
4. 凭证只存部署平台；仓库仅键名。

### B3-8 日志脱敏

- **做：** 日志可含 `request_id`、path、HTTP status、error `code`；**不得**打印完整 OPENID、凭证、Provider 密钥、原始授权头。
- **验收：** 代码审阅清单通过；无 `.env`/密钥提交。

### B3-9 明确禁止

- 不新增 security scheme / Bearer / Cookie。
- 不改 `x-trusted-runtime-openid` / `x-requires-trusted-openid` 合同含义。
- 不在网关重算 `can_predict` 或结算。

---

## 4. C2 切片（按 C1 页面与状态）

> 形态：微信小程序。导航与字段严格对齐 C1 §1/§5；验收场景编号引用 C1 §6。

### C2-0 小程序工程与 API 调用层

- **做：** 最小工程结构（页/服务分层即可）；API 客户端解析成功 envelope 与错误 envelope；cursor **原样回传**；时间按 ISO8601 UTC 消费。
- **验收：** 可对 mock 网关发请求；分支只看 HTTP + `code`；`message` 仅展示。场景：支撑后续全部 S/M/P/U/R/X。

### C2-1 主导航壳 + 公开浏览

- **做：** 四导航：比赛 / 我的预测 / 排行榜 / 我的；默认落地比赛列表；无管理端入口。
- **验收：** **X1**；无身份可进比赛/排行榜（**S1** 前半）。

### C2-2 会话初始化

- **页：** 进入/会话（C1 §5.1）
- **API：** `POST /v1/session/init`
- **状态：** loading 锁按钮；422/429/5xx；401 可继续公开浏览；409 注销态。
- **验收：** **S1–S5**

### C2-3 比赛列表

- **页：** C1 §5.2
- **API：** `GET /v1/matches`
- **规则：** 队名用 `home_team.name`/`away_team.name`；比分/结算 null 不伪装 0；入口提示跟 `can_predict_reason`。
- **验收：** **M1, M2**；status 展示基础覆盖 **M9–M11** 列表侧。

### C2-4 比赛详情 + 预测提交

- **页：** C1 §5.3
- **API：** `GET /v1/matches/{match_id}`，`POST /v1/predictions`
- **幂等（C1 §4）：** 意图生成 UUID v4；超时同 key+同 payload；改分新 key；提交中防双点。
- **状态矩阵：** C1 §3 全部 `match_status` + reason；POST code 表 C1 §4.5。
- **验收：** **M3–M14**

### C2-5 我的预测

- **页：** C1 §5.4
- **API：** `GET /v1/predictions/me`（可选 detail）
- **约束：** **无**球队名嵌套；需队名 → 跳转 match 详情。
- **验收：** **P1, P2**；401/409/404/429 按全局。

### C2-6 资料 / 等级

- **页：** C1 §5.5（可同页分区）
- **API：** `GET /v1/profile/me`，`GET /v1/levels/me`
- **约束：** `favorite_team_id` 只显示 ID/未设置；无编辑/注销入口。
- **验收：** **U1**；**X1**

### C2-7 解锁

- **页：** C1 §5.6
- **API：** `GET /v1/unlocks/me`
- **静态映射：** 键 = 合同 code：`profile_card_style_1` | `favorite_team_name_accent` | `favorite_team_avatar_frame_1`；仅依赖三字段；映射缺失 → code 原文 + threshold + 时间（Fail Visible）。
- **验收：** **U2, U3**

### C2-8 排行榜

- **页：** C1 §5.7
- **API：** `GET /v1/rankings?period_type=week|month`
- **验收：** **R1**；无跳转他人主页（**X1**）

### C2-9 全局状态收口

- **做：** loading / empty / error / 401 / 429 / 注销态 全页一致；null 结算显示“待结算/暂无比分”。
- **验收：** 复扫 C1 §6 全表；重点 **S4, M13, M14, P2, U3, X1**。

---

## 5. 垂直切片与完成判据

> 每一垂直切片 = 可独立运行的 mock 网关 + 内存数据 + 小程序页（或 API 级验收）。B1/B2 替换不得改变下列判据。

| 切片 | 后端（B3+内存） | 前端（C2） | 独立验收 |
|---|---|---|---|
| **V0** | mock 网关；OPENID mock；`POST /session/init`；`GET /matches` | 工程 + API 层 + 列表骨架 | 公开列表 200；缺身份 Auth→401；有 mock 身份 init→201/200。场景 **S1–S3, M1** |
| **V1** | `GET /matches/{id}`；`POST /predictions`；内存幂等 | 详情+提交+幂等 UI | **M3–M8, M12–M14**；handler 既有测试保持绿 |
| **V2** | 预置多 `match_status` 种子 | 列表/详情状态矩阵 | **M9–M11, M2, M13** |
| **V3** | `GET /predictions/me` | 我的预测 + 跳转补队名 | **P1, P2** |
| **V4** | `GET /profile/me`；`GET /levels/me`；`GET /unlocks/me` | 我的区 + 静态映射 | **U1–U3** |
| **V5** | `GET /rankings` | 周/月榜+分页 | **R1** |
| **V6** | 注销用户种子；限流夹具 | 全局 409/429/401 | **S4, S5, M14**；**X1** 终检 |

### 5.1 每切片最低质量门（实现阶段执行，本计划不执行）

```sh
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

另加：本切片相关 C1 场景勾选；diff 不含 `.env`/凭证/真实库/日志。

### 5.2 整体完成判据（B3+C2）

1. 七个必做页可在小程序 + mock/测试网关走通。  
2. C1 §6 **S/M/P/U/R/X** 全部可演示或自动化。  
3. 生产路径身份仅来自 `getWXContext().OPENID`；无 JWT；无前端传身份。  
4. 业务 handler/OpenAPI **无合同变更**。  
5. B1/B2 未完成不否决本判据（需在发布说明标明内存/fixture 数据边界）。

---

## 6. 风险与需主审 / 产品确认的决策点

| # | 决策点 | 为何需要确认 | 本计划默认（待主审） |
|---|---|---|---|
| D1 | **云函数 vs 云托管** | 运行时与部署面不同 | **云函数薄网关**（已定方向）；若改云托管须重写 B3 注入点，仍禁止 JWT |
| D2 | CloudBase 数据库选型 / B1 排期 | 持久化与体验版联调 | B1 **不阻塞** C2；上线持久化前标明数据易失 |
| D3 | B2 真实 Provider 排期 | 真实赛程 | C2 用种子数据；上线前需 B2 或运营灌数策略 |
| D4 | 小程序 appid / 体验版 / request 合法域名 | 真机调用云函数 | 产品提供 appid 与域名白名单；规划不写密钥 |
| D5 | 本地 mock 身份边界 | 防 prod 误开 | 仅 dev/test 环境变量；prod Fail Closed |
| D6 | 资料/等级/解锁单页 vs 子页 | 信息架构变体 | 字段集不变；实现任选，验收同 U1–U3 |
| D7 | unlock 本地资源包具体素材 | 仅展示 | 键仍为 `unlock_code`；缺映射 fallback |
| D8 | 时间展示时区 | 纯展示 | 传输仍 UTC |

---

## 7. STOP 边界（强制）

1. **本文件是规划，不是开工令。**  
2. **未经主审通过并明确告知用户，不得开始任何 B3/C2 实现编码**（含云函数、小程序页、mock 网关代码、配置落地）。  
3. 不得修改 `b115180` 基线历史；不得 commit/push。  
4. 不得以“先写一点网关/页面”绕过主审。  
5. 实现启动后仍不得：改冻结合同、发明认证协议、把 B1/B2 未完成伪装为 API 未就绪而倒逼改字段。  
6. 若实现中发现 SPEC_GAP：停止扩展，记录缺口，回到规范/主审，不猜测补字段。

---

## 8. 实现阶段文件触点（预告，本计划不修改）

| 区域 | 预期触点（实现时） | 约束 |
|---|---|---|
| 网关 | 新建云函数入口（路径待主审确认） | 只装配，不改业务规则 |
| Handler | `src/api/v1/*.ts` | **零合同改动**；优先只被调用 |
| 错误 | `src/api/v1/validation.ts` `mapErrorToHttp` | 复用 |
| 持久化 | `src/infrastructure/repositories.ts` 内存实现 | B1 前默认 |
| 环境 | `src/infrastructure/environment-config.ts` | 键隔离，无密钥 |
| 小程序 | 新建小程序目录（路径待主审） | 只消费已冻 endpoint |
| 测试 | 既有 `src/api/v1/*.test.ts` + 网关装配测试 | 直接注入 `trusted_openid` 的合同测试保持 |

---

## 9. 变更纪律

- 需要新 API 字段/错误码：先改 `MVP__v1.0.md` + OpenAPI + 测试，再改本计划与 UI。  
- 客户端形态若从微信小程序变更：废止本 C2 平台假设，另开计划。  
- B3 若不用云函数：须主审改写 §0/§3/§6 D1，仍遵守 §49.1/§49.16。  
- 文件名固定：`DEV_PLAN_B3_C2__v1.0.md`。

---

## 10. 一页摘要

| 项 | 内容 |
|---|---|
| 做 | 云函数薄网关注入 OPENID；小程序七页用户路径 |
| 不做 | 管理端 UI、二次切片账号能力、JWT、改合同、B1/B2 实现 |
| 解耦 | 内存 repo + mock 身份先验收 UI；B1/B2 后换皮 |
| 验收源 | C1 §6 场景编号 + 既有 API 测试 |
| 门禁 | **主审通过前 STOP；禁止实现编码** |
