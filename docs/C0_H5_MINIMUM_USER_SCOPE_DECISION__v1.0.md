# C0 H5 最小用户端范围决策 v1.0

> 状态：产品决策冻结（C0 输入）。  
> 基线：`b115180`（受保护，不得 reset/stash/restore/checkout）。  
> 业务规则唯一来源：`MVP__v1.0.md`；API 合同：`src/api/v1/openapi.yaml`。  
> 本文**不修改**任何 API/字段/业务规则，**不实现**前端或 B/C 代码，**不选择** Web / 微信小程序。

---

## 0. 已授权产品决策（必须原样执行）

1. **首版仅用户端 UI**。管理员 anomaly / 赛果修正 / retry / rebuild **API 保留**，**不做管理端 UI**。
2. **unlock 首版**使用**前端本地静态映射**：展示与映射只消费既有 `unlock_code`、`threshold_points`、`unlocked_at`；响应中其他既有字段不作为首版展示依赖。**不**新增后端展示元数据、图标 URL、description/category API，**不**猜测其文案。
3. **客户端形态（Web 或微信小程序）尚未选择**；C0/C1 只产出**平台无关**的用户路径与状态/验收定义。具体登录/网关协议留 **B3**。
4. **anomaly `details` 保持服务端 `{}`**；首版不做管理端 UI，因此 **H5 不扩展 details 白名单**。

---

## 1. 目标 / 非目标

### 1.1 目标

- 冻结首版**用户端最小可见范围**：页面、用户动作、绑定 endpoint、可消费字段、必须验收的页面状态。
- 明确哪些 **H5** 可对首版 UI 关闭、哪些 **SPEC_GAP** 必须保留且不得用猜测填补。
- 给出 **A5 是否能 PASS** 的机械判据（本文**不**宣称 A5 PASS）。
- 固定后续切片顺序：A5 复核 → C1 原型 → C2 具体平台实现；B3 认证/网关接线独立。

### 1.2 非目标

- 不做视觉稿、组件库、平台选型、路由实现、真实登录。
- 不做管理端任何页面/交互。
- 不新增/不修改 OpenAPI、handler、领域规则、错误码、字段。
- 不发明球队展示名来源、unlock 文案/图标、anomaly details 成员、JWT/Cookie/session token。
- 不读取 `.env`/凭证、不连真实库、不启动 B/C 代码。

---

## 2. 首版范围总表

| 范围 | 首版用户端 UI | API |
|---|---|---|
| 会话初始化、比赛浏览、预测提交、我的预测、资料/等级/解锁、排行榜 | **做** | 消费既有用户端 API |
| 分享卡、公开他人资料、账号注销、资料编辑 | **可选二次切片**（API 已存在，不阻塞最小路径） | 保留 |
| 管理端 anomaly / 赛果修正 / retry / rebuild | **不做 UI** | **保留 API** |
| unlock 展示名/图标/URL/描述/分类 | **前端静态映射**（仅 `unlock_code` / `threshold_points` / `unlocked_at`） | **不新增字段** |
| anomaly details 白名单 | 不涉及 | 保持 `{}` |

---

## 3. 用户端 endpoint → 页面 / 动作 / 字段

> 字段**仅**来自 OpenAPI 与已冻结 §49；未列出字段不得假设存在。  
> Auth required：运行时注入可信 `openid`（§49.1 / §49.16 / `x-requires-trusted-openid`）；客户端**不得**传 openid/user_id/JWT。  
> 公开读可不登录；若运行时带可信身份，matches 详情可返回当前用户 `my_prediction`。

### 3.1 首版核心路径 endpoint

#### `POST /v1/session/init`（Auth required）

| 项 | 定义 |
|---|---|
| 可见页面 | 首次进入 / 会话引导 |
| 用户动作 | 进入产品后初始化会话；可提交 `nickname` |
| 请求字段 | `nickname` string 1..32 |
| 成功 | `200` 既有用户 / `201` 新建；`data`: `user_id`, `nickname`, `favorite_team_id?`, `status=active`, `career_points`, `career_level` |
| 失败 | `401 UNAUTHORIZED`；`409`（含 `USER_DELETED`）；`422`；`429` |
| 规则要点 | 同 active openid 再 init 返回 200 且**忽略**新 nickname；已注销 409，不得复活语义（§49.1） |

#### `GET /v1/matches`（公开读）

| 项 | 定义 |
|---|---|
| 可见页面 | 比赛列表 |
| 用户动作 | 浏览/筛选时间窗与 `status`；分页加载 |
| Query | `from?`, `to?`（ISO8601 UTC）, `status?`（MatchStatus）, `limit?` 1..100 default 20, `cursor?` opaque |
| item 字段 | `match_id`, `league_id=premier_league`, `season_id=2026_2027`, `round_id`, `home_team{team_id,name}`, `away_team{team_id,name}`, `kickoff_at`, `prediction_deadline_at?`, `prediction_closed_at?`, `match_status`, `regular_home_score?`, `regular_away_score?`, `can_predict`, `can_predict_reason?` |
| `can_predict_reason` enum | `AUTH_REQUIRED` \| `USER_DELETED` \| `ALREADY_SUBMITTED` \| `KICKOFF_UNCONFIRMED` \| `NOT_SCHEDULED` \| `CLOSED` \| `null`（可预测） |
| 失败 | `422`；`429` |

#### `GET /v1/matches/{match_id}`（公开读）

| 项 | 定义 |
|---|---|
| 可见页面 | 比赛详情 / 预测提交页 |
| 用户动作 | 查看比赛与是否可预测；已登录时查看 `my_prediction` |
| 字段 | 列表 item 全部字段 + `my_prediction`（nullable）：`prediction_id`, `pred_home_score`, `pred_away_score`, `derived_result`, `submitted_at`, `match_score?`, `wdl_hit?`, `exact_hit?` |
| 失败 | `404`；`422`；`429` |

#### `POST /v1/predictions`（Auth required）

| 项 | 定义 |
|---|---|
| 可见页面 | 比赛详情上的提交动作 |
| 用户动作 | 提交主客队比分预测（幂等） |
| 请求 | `idempotency_key` UUID v4, `match_id` UUID, `home_score` 0..20, `away_score` 0..20 |
| 成功 | `201` 新建 / `200` 幂等重放；`data`: `prediction_id`, `match_id`, `pred_home_score`, `pred_away_score`, `derived_result`, `submitted_at`, `scoring_rule_version=scoring_v1` |
| 失败 | `401 UNAUTHORIZED`；`409`（`USER_DELETED` / `PREDICTION_ALREADY_SUBMITTED` / `MATCH_NOT_PREDICTABLE` / `PREDICTION_LOCKED`，与列表 `can_predict_reason` 同源 §49.2）；`422`；`429` |

#### `GET /v1/predictions/me`（Auth required，§49.9）

| 项 | 定义 |
|---|---|
| 可见页面 | 我的预测列表 |
| 用户动作 | 分页查看历史预测与结算字段 |
| Query | `season_id?` const `2026_2027`, `limit?`, `cursor?` |
| item 字段 | `prediction_id`, `match_id`, `league_id`, `season_id`, `round_id`, `home_team_id`, `away_team_id`, `kickoff_at`, `pred_home_score`, `pred_away_score`, `derived_result`, `submitted_at`, `scoring_rule_version`, `match_status`, `regular_home_score?`, `regular_away_score?`, `match_score?`, `wdl_hit?`, `exact_hit?` |
| 排序 | `submitted_at DESC, prediction_id DESC`；cursor opaque，客户端不得解析/构造 |
| **展示约束** | **无**球队名称嵌套对象（§49.9 `SPEC_GAP`）。UI 只能显示已有 ID/时间/比分，或导航到 `GET /matches/{match_id}` 使用其 `home_team.name` / `away_team.name`；**不得**发明 predictions/me 球队名字段 |
| 失败 | `401`；`404 USER_NOT_FOUND`；`409 USER_DELETED`；`422`；`429`；`500` |

#### `GET /v1/predictions/me/{prediction_id}`（Auth required）

| 项 | 定义 |
|---|---|
| 可见页面 | 我的单条预测详情（可由列表进入） |
| 用户动作 | 查看单条预测与赛果字段 |
| 字段 | `prediction_id`, `match_id`, `pred_home_score`, `pred_away_score`, `derived_result`, `submitted_at`, `scoring_rule_version`, `match_status`, `regular_*?`, `match_score?`, `wdl_hit?`, `exact_hit?` |
| 失败 | `401`；`404`；`422`；`429` |

#### `GET /v1/profile/me`（Auth required）

| 项 | 定义 |
|---|---|
| 可见页面 | 我的资料 / 战绩汇总 |
| 字段 | `user_id`, `nickname`, `favorite_team_id?`, `career_points`, `career_valid_predictions`, `career_wdl_hits`, `career_exact_hits`, `career_wdl_accuracy_percent?`, `career_level`, `career_best_level` |
| 失败 | `401`；`404`；`409`；`422`；`429` |

#### `GET /v1/levels/me`（Auth required）

| 项 | 定义 |
|---|---|
| 可见页面 | 等级页（可与资料/解锁同区） |
| 字段 | `season{season_id=2026_2027, valid_predictions, wdl_hits, wdl_accuracy_percent?, level, best_level}`；`career{valid_predictions, wdl_hits, wdl_accuracy_percent?, level, best_level}` |
| 失败 | `401`；`404`；`409`；`422`；`429` |

#### `GET /v1/unlocks/me`（Auth required，§49.10）

| 项 | 定义 |
|---|---|
| 可见页面 | 解锁页 |
| 用户动作 | 查看默认资源与历史解锁；**不**依赖后端文案 |
| 展示依赖 | 只用 `unlock_code`、`threshold_points`、`unlocked_at`；全部历史记录均可展示；不因积分下降隐藏 |
| **前端静态映射（首版）** | 仅用三个授权字段做本地对照；映射内容属于 UI 资源，**不是** API 合同。**禁止**请求未定义的 name/icon/url/description/category |
| 失败 | `401`；`404 USER_NOT_FOUND`；`409 USER_DELETED`；`422`；`429`；`500` |

#### `GET /v1/rankings`（公开读）

| 项 | 定义 |
|---|---|
| 可见页面 | 周榜/月榜 |
| 用户动作 | 选择 `period_type`（及可选 `period_key`），分页浏览 |
| Query | `period_type` required `week|month`；`period_key?`；`limit?`；`cursor?` |
| item 字段 | `global_rank`, `user_id`, `display_name`, `favorite_team_id?`, `period_score`, `valid_predictions`（≥3 入榜口径由后端保证）, `wdl_hits`, `exact_hits`, `wdl_accuracy_percent`, `last_scoring_match_at?` |
| 失败 | `422`；`429` |

### 3.2 首版可选（API 可用，不阻塞最小路径）

| Endpoint | 页面/动作 | 仅可用字段（摘要） |
|---|---|---|
| `PATCH /v1/profile/me` | 编辑昵称/主队 | body: `nickname?`, `favorite_team_id?`（至少一项）；成功同 MyProfile |
| `DELETE /v1/profile/me` | 注销账号 | `204` 无 body；之后会话路径按 `USER_DELETED` |
| `GET /v1/profiles/{user_id}` | 公开他人战绩 | `user_id`, `display_name`, `favorite_team_id?`, `career_points`, `career_valid_predictions`, `career_wdl_accuracy_percent?`, `career_level`, `career_best_level` |
| `GET /v1/share-card/me` | 分享卡数据 | query 必填 `season_id=2026_2027`, `round_id` 01..38；`user_id`, `display_name`, `favorite_team_id?`, `season_level`, `round_id`, round 计数与 `career_points` |

### 3.3 明确不进首版 UI 的 endpoint（API 保留）

| Endpoint | 首版 UI |
|---|---|
| `GET /v1/admin/anomalies` | 不做 |
| `POST /v1/admin/matches/{match_id}/result-corrections` | 不做 |
| `POST /v1/admin/matches/{match_id}/retry-settlement` | 不做 |
| `POST /v1/admin/rebuild/users/{user_id}` | 不做 |
| `POST /v1/admin/rebuild/rankings` | 不做 |

说明：`details` 公开值固定 `{}`（§49.11）。因无管理端 UI，**不**为 H5 扩展 details 白名单。

---

## 4. 用户路径（平台无关）

> 路径用“页面状态机”描述；登录控件、网关 header、小程序 `wx.login` 等属 **B3**，此处只要求“是否具备可信 openid 运行时上下文”。

### 4.1 首次初始化

1. 客户端启动 → 若无可信 openid 上下文：公开页可浏览（matches/rankings）；任何 Auth required 调用按 `401` 处理。  
2. 具备可信 openid → `POST /session/init`（`nickname` 必填于合同；再 init 忽略新 nickname）。  
3. `201/200` → 进入比赛列表；`409 USER_DELETED` → 注销态；`429/422/5xx` → 对应错误态。

### 4.2 比赛浏览

1. `GET /matches`（可带 `from/to/status/cursor`）。  
2. 渲染 `home_team.name` / `away_team.name`、`kickoff_at`、`match_status`、比分（可 null）、`can_predict` / `can_predict_reason`。  
3. 空列表 → empty；加载中 → loading；`429/422` → error。

### 4.3 预测提交

1. 进入 `GET /matches/{match_id}`。  
2. 以 `can_predict` + `can_predict_reason` 控制提交入口（与 POST 错误同源 §49.2）。  
3. 可提交时：用户输入比分 → `POST /predictions`（客户端生成 UUID v4 `idempotency_key`；重试同 key+同 payload）。  
4. 成功：展示返回的预测摘要；刷新详情使 `my_prediction` 非 null、`can_predict_reason=ALREADY_SUBMITTED`。  
5. 失败：按 code 映射（未登录/注销/已提交/不可预测/已截止/校验/限流）。

### 4.4 我的预测

1. Auth 下 `GET /predictions/me` 分页。  
2. 列表用已有字段展示预测与结算（比分/得分/命中均可 null = 未结算或取消等，§49.9）。  
3. 需要队名时：**跳转** `GET /matches/{match_id}`，**不**扩展 predictions/me schema。  
4. 可选：`GET /predictions/me/{prediction_id}` 看单条。

### 4.5 等级 / 解锁

1. `GET /profile/me` 与/或 `GET /levels/me` 展示积分与等级。  
2. `GET /unlocks/me`：展示历史 unlock 的三个授权字段。  
3. 对每个 `unlock_code` 使用**前端静态映射**显示本地资源标识；进度可用 `career_points`（profile）与 `threshold_points` 对比，**不**新增后端字段。

### 4.6 排行榜

1. `GET /rankings?period_type=week|month`（`period_key` 可选）。  
2. 展示 `display_name`、分数、命中与排名；空榜 empty；分页 cursor 原样回传。

---

## 5. 必须设计并验收的页面状态

所有核心页至少覆盖：

| 状态 | 触发（合同侧） | 验收要点 |
|---|---|---|
| loading | 请求未返回 | 不闪空、不重复提交 |
| empty | `items=[]` 或 unlocked=`[]` 且无历史 | 明确“无数据”，非错误 |
| error | `422`/`500` 或网络失败 | 展示 `message` 可读；程序分支用 `code` |
| 401 | 缺可信身份 | 引导重新获得运行时身份（机制属 B3）；不伪造 openid |
| 429 | `RATE_LIMITED` | 可重试提示；不刷屏重试 |
| 截止 CLOSED | `can_predict_reason=CLOSED` 或 POST `PREDICTION_LOCKED` | 提交禁用；原因与 POST 一致 |
| 延期 postponed | `match_status=postponed` → `NOT_SCHEDULED` / `MATCH_NOT_PREDICTABLE` | 不可预测；不因旧 deadline 显示可投（§49.4） |
| 取消/废弃 | `cancelled`/`abandoned` | 不可预测；结算字段可 null |
| 未确认开球 | `KICKOFF_UNCONFIRMED` | 不可预测 |
| 已提交 | `ALREADY_SUBMITTED` | 展示已有预测，禁止再交 |
| 结算中/未出分 | `match_score`/`wdl_hit`/`exact_hit`/正式比分为 `null` | 显示“待结算/暂无比分”，**不用 0 伪装** |
| 已结算 | 分数字段非 null | 展示 0/3/12 与命中布尔 |
| 注销 | `409 USER_DELETED` | 全 Auth 路径一致拦截 |
| 用户不存在 | `404 USER_NOT_FOUND`（部分 me 接口） | 与未登录区分 |

比赛列表/详情额外按 `match_status` 验收：`scheduled|live|finished|postponed|cancelled|abandoned`。

---

## 6. H5 可关闭项 vs 必须保留的 SPEC_GAP

### 6.1 首版用户 UI 可关闭 / 可收口的 H5 项

| 项 | 结论 |
|---|---|
| 用户端核心路径所需 OpenAPI schema 是否“够做首版 UI” | **对最小用户路径足够**：matches / predictions / session / profile / levels / unlocks / rankings 均有 schema 与测试锚点；A2 已冻 `predictions/me`、`unlocks/me` |
| unlock 展示元数据 API（名称/图标/URL/描述/分类） | **首版不开放为后端工作**；以**前端静态映射**收口 UI 需求，**不**关闭“后端元数据形状”本身的 SPEC_GAP 记录，但**不阻塞**首版用户 UI |
| admin anomalies `details` 白名单（原 H5） | **首版 UI 范围关闭**（无管理端）；合同保持 `{}`，**不**扩展白名单 |
| 管理端写操作 UI | **首版关闭**（API 保留） |

### 6.2 必须保留、禁止用猜测填补的 SPEC_GAP

| SPEC_GAP | 保留原因 | 首版 UI 处理 |
|---|---|---|
| `GET /predictions/me` 球队展示名 / `home_team` 嵌套形状（§49.9） | 规范未唯一冻结 | 只显示已有字段或跳转 match 详情 |
| unlock 后端公开 name/icon/url/description/category（§49.10） | 未唯一冻结 | 前端静态映射；不新增 API |
| anomaly `details` 成员白名单（§49.11 H5） | 未唯一冻结 | 无管理端 UI；保持 `{}` |
| 网关具体字段映射 / 平台登录（§49.16 → B3） | H4 仅关闭 OpenAPI 诚实表达 | C0/C1 不绑定平台登录实现 |
| A3 调度频率、真实 Provider 等 U 类 | 非前端合同 | 不进入用户 UI 范围 |
| 客户端形态 Web vs 小程序 | 产品未选 | C2 再定 |

### 6.3 H4 状态（供 A5，不构成 PASS）

- OpenAPI 已去掉 Bearer/JWT；根级 `x-trusted-runtime-openid` + 各 Auth operation `x-requires-trusted-openid: true`（§49.16）。  
- **不再**以 H4 合同表达阻塞 A5；**仍不**等于 A5 PASS。

---

## 7. A5 是否能 PASS 的机械判据

> 本文**不得**擅自标 `PASS`。以下供后续 **A5 复核**逐项打勾；**全部满足**才可输出 `PASS` 并进入 C1 视觉/实现门禁。

### 7.1 用户端合同完整性

- [ ] 首版核心用户路径每个 endpoint 在 `openapi.yaml` 有 path + 成功 schema + 失败响应引用。  
- [ ] Auth required 集合与 `openapi-auth-h4.test.ts` 一致；公开读无强制身份标记。  
- [ ] 成功 envelope：`data` + `request_id`；分页含 `page.next_cursor`/`has_more`；空列表为 `[]`，无下一页 `next_cursor=null`。  
- [ ] 时间字段为 ISO8601 UTC；nullable 结算/比分字段缺失时为 `null`（非省略、非用 0 代替）。  
- [ ] cursor 语义：opaque，客户端不解析/构造；非法 cursor → `422`。

### 7.2 错误与状态可映射到页面

- [ ] §49.2 预测拒绝：`can_predict_reason` 与 POST code 同源可测。  
- [ ] 401/403/404/409/422/429/500 的 `code` 可驱动 UI 分支；`message` 仅展示。  
- [ ] 比赛态、预测态、结算字段 null/非 null 能覆盖 §5 状态表。

### 7.3 测试锚点（至少存在，且与 schema 对齐）

- [ ] OpenAPI 合同测试：auth H4、predictions、unlocks、levels 等。  
- [ ] Handler/应用测试覆盖用户端主路径关键失败码（session/matches/predictions/profile/levels/unlocks/rankings）。  
- [ ] 管理端 API 测试可存在，但**不**要求管理端 UI。

### 7.4 明确不阻塞 / 不误阻塞

- [ ] 真实 DB / 真实 Provider / 生产调度未完成 **不**单独否决 A5，只要**不改变**已冻 API 语义。  
- [ ] unlock UI 元数据 SPEC_GAP **不**否决 A5 用户端最小范围（已决策静态映射）。  
- [ ] anomaly details 白名单未扩 **不**否决 A5（首版无管理端 UI）。  
- [ ] 客户端平台未选择 **不**否决 A5；否决条件是用户端 API/状态不可映射。

### 7.5 输出要求

- A5 只能输出：`PASS` **或** 带证据的 **blocker 列表**。  
- 无 blocker 清单却宣称可做前端实现 → 无效。  
- 存在 blocker 时：C1 低保真可准备信息架构，但 **C2 实现门禁不放行**。

---

## 8. 后续切片顺序（冻结）

```text
A5 复核（机械判据 §7）
  → 仅 PASS 后：C1 低保真原型 + 页面状态验收（仍平台无关）
    → C2 选择具体平台（Web 或微信小程序）并实现用户端
B3 认证/网关注入/本地模拟（独立并行可做接线，不得反向改 API 合同）
管理端 UI：不在首版；若未来需要，另开产品决策 + 再评估 details 白名单
```

约束：

- C0 本文完成后，**下一步产品动作是 A5 复核**，不是直接写页面代码。  
- C1 不得依赖未冻结字段。  
- C2 才允许平台选型；在此之前禁止把路径写成某一端专有 API。  
- B3 负责可信 openid 注入与部署边界，**不**发明 JWT 登录体系。

---

## 9. 最小页面清单（C1 输入）

| 页面 | 绑定主 API | 首版必做 |
|---|---|---|
| 会话初始化/进入 | `POST /session/init` | 是 |
| 比赛列表 | `GET /matches` | 是 |
| 比赛详情 + 提交预测 | `GET /matches/{id}`, `POST /predictions` | 是 |
| 我的预测 | `GET /predictions/me`（可选 detail） | 是 |
| 我的资料/等级 | `GET /profile/me`, `GET /levels/me` | 是 |
| 解锁 | `GET /unlocks/me` + 前端静态映射 | 是 |
| 排行榜 | `GET /rankings` | 是 |
| 资料编辑 / 注销 / 公开主页 / 分享卡 | 对应可选 API | 否（二次） |
| 管理端任意页 | admin/* | **否** |

---

## 10. 变更纪律

- 若需新增用户可见字段：先改 `MVP__v1.0.md` + OpenAPI + 测试，再改 UI 需求；禁止 UI 倒逼。  
- 若需管理端 UI：另做产品决策，并单独处理 anomaly details 白名单。  
- 若需 unlock 服务端文案/图标：另冻结合同；在此之前只允许前端静态映射。  
- 本文文件名固定：`C0_H5_MINIMUM_USER_SCOPE_DECISION__v1.0.md`；不替代未来的 `UI_REQUIREMENTS__v1.0.md`（C0/C1 正式 UI 需求可在 A5 PASS 后撰写，且必须服从本文范围）。
