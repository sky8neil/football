# C1 平台无关低保真原型与 UI 状态验收 v1.0

> 状态：C1 验收输入（平台无关）。  
> 基线：`b115180`（受保护）。  
> 范围来源：`C0_H5_MINIMUM_USER_SCOPE_DECISION__v1.0.md`。  
> 业务规则：`MVP__v1.0.md` §49.1–§49.16；API：`src/api/v1/openapi.yaml`。  
> 本文**不修改** API/字段/业务规则，**不选择** Web / 微信小程序，**不实现**前端或 B/C 代码，**不宣称**后端实现完成。

---

## 0. 冻结前提

1. **首版仅用户端 UI**；管理端 API 保留，**无管理端页面**。
2. unlock 展示只消费 `unlock_code` / `threshold_points` / `unlocked_at`；其余字段不作为首版展示依赖；**前端静态映射**，不新增后端元数据。
3. 客户端形态未选；登录/网关协议属 **B3**。本文只描述“是否具备可信 openid 运行时上下文”。
4. 不得新增字段、接口、错误码或业务规则；不得猜测球队名来源、unlock 文案/图标、JWT。

---

## 1. 信息架构与主导航

### 1.1 页面树（必做）

```text
进入 / 会话初始化
└─ 主导航壳
   ├─ 比赛（默认落地）
   │  ├─ 比赛列表
   │  └─ 比赛详情 + 预测提交
   ├─ 我的预测
   │  └─（可选同页展开）单条预测摘要 → 跳转比赛详情补队名
   ├─ 排行榜
   └─ 我的
      ├─ 资料 / 战绩
      ├─ 等级（可同屏分区）
      └─ 解锁
```

### 1.2 主导航（平台无关）

| 导航项 | 目标页 | 身份 |
|---|---|---|
| 比赛 | 比赛列表 | 公开可读 |
| 我的预测 | 我的预测列表 | Auth required |
| 排行榜 | 周/月榜 | 公开可读 |
| 我的 | 资料/等级/解锁入口 | Auth required |

- 公开页在无可信身份时可浏览。  
- Auth 页触发 `401` → 进入“需运行时身份”态（机制 B3，不写平台登录控件）。  
- 不设管理端入口。

### 1.3 明确不做（首版 UI 关闭）

| 页/能力 | 状态 |
|---|---|
| 资料编辑（`PATCH /profile/me`） | 可选二次切片，**不做** |
| 账号注销（`DELETE /profile/me`） | 可选二次切片，**不做** |
| 公开他人资料（`GET /profiles/{user_id}`） | 可选二次切片，**不做** |
| 分享卡（`GET /share-card/me`） | 可选二次切片，**不做** |
| 管理端 anomaly / 赛果修正 / retry / rebuild | **不做** |
| unlock 后端 name/icon/url/description/category | **不做**（静态映射） |

---

## 2. 全局交互规则

### 2.1 错误 Envelope 使用

- 程序分支只用 `code` + HTTP。  
- `message` 仅展示，不解析结构。  
- `details` 首版用户端不依赖。  
- 分页：`items=[]` 为空；`page.next_cursor` 无下一页为 `null`；cursor **原样回传**，不得解析/构造。

### 2.2 全局状态语义

| 状态 | UI 动作 |
|---|---|
| loading | 占位，不闪空；提交按钮禁用防重复 |
| empty | “无数据”，非错误 |
| error `422`/`500`/网络 | 展示 `message`；提供手动重试 |
| `401 UNAUTHORIZED` | 标记缺可信身份；引导重新获得运行时身份（B3）；不伪造 openid |
| `429 RATE_LIMITED` | 提示稍后重试；禁止自动连打 |
| `409 USER_DELETED` | 全 Auth 路径统一注销态；禁止继续写操作 |
| `404 USER_NOT_FOUND` | 与未登录区分；提示会话失效/需重新 init |

### 2.3 时间与 null

- 时间字段按 ISO8601 UTC 原样消费；展示时区属实现细节，不得改语义。  
- 结算/正式比分字段为 `null` 时显示“待结算/暂无比分”，**禁止用 0 伪装缺失**。  
- 已结算时 `match_score` 可为 `0|3|12`；`0` 是真实得分，不是缺失。

---

## 3. 比赛态与预测入口显示规则

> 列表/详情的 `can_predict` + `can_predict_reason` 与 `POST /predictions` 错误码同源（§49.2）。UI 以服务端返回为准，不本地重算截止逻辑。

### 3.1 `match_status` 展示

| `match_status` | 状态标签 | 正式比分 | 预测入口 |
|---|---|---|---|
| `scheduled` | 未开赛 | 通常 null | 仅当 `can_predict=true` 且 reason=`null` 可提交 |
| `live` | 进行中 | 可有/可 null | 不可预测（reason 应为 `NOT_SCHEDULED`） |
| `finished` | 已结束 | 可有/可 null（待落正式比分） | 不可预测 |
| `postponed` | 延期 | 通常 null | 不可预测（`NOT_SCHEDULED`）；**不得**因旧 deadline 显示可投 |
| `cancelled` | 取消 | 可 null | 不可预测；结算字段可 null |
| `abandoned` | 废弃/腰斩 | 可 null | 不可预测；结算字段可 null |

### 3.2 `can_predict_reason` → 入口与文案键（只用 code，不发明后端文案）

| reason | 提交控件 | UI 语义键（本地文案） |
|---|---|---|
| `null` 且 `can_predict=true` | 启用 | 可提交 |
| `AUTH_REQUIRED` | 禁用/引导身份 | 需登录态 |
| `USER_DELETED` | 禁用 | 账号已注销 |
| `ALREADY_SUBMITTED` | 禁用；展示已有预测 | 已提交 |
| `KICKOFF_UNCONFIRMED` | 禁用 | 开球未确认 |
| `NOT_SCHEDULED` | 禁用 | 非可预测赛程态（含 live/finished/postponed/cancelled/abandoned） |
| `CLOSED` | 禁用 | 预测已截止 |

说明：`CLOSED` 覆盖“已写 `prediction_closed_at`”与“墙钟已过 deadline”两种后端情况；UI 不区分。

### 3.3 结算 null 显示

| 字段 | null | 非 null |
|---|---|---|
| `regular_home_score` / `regular_away_score` | 暂无比分 | 显示整数比分 |
| `match_score` | 待结算 | 显示 0/3/12 |
| `wdl_hit` / `exact_hit` | 待结算 | 显示布尔命中 |

取消/废弃/未结算：结算字段保持 null 语义，不显示“0 分命中”。

---

## 4. 预测提交：幂等、二次提交、失败 code

### 4.1 提交输入（合同字段）

- `idempotency_key`：客户端生成 **UUID v4**  
- `match_id`：UUID  
- `home_score` / `away_score`：整数 `0..20`

### 4.2 幂等 key 生命周期（UI）

1. 用户进入可提交态并开始填写：为**本次意图**生成一个 `idempotency_key`。  
2. 网络超时/未知结果重试：**同一 key + 同一 payload** 重放。  
3. 用户修改比分后再次点击提交：生成**新** key（旧 key 不得配新 payload）。  
4. 提交成功（`201` 新建或 `200` 幂等重放）后：控件切到已提交态；刷新详情。

### 4.3 成功

| HTTP | UI |
|---|---|
| `201` | 展示返回预测摘要：`pred_*`、`derived_result`、`submitted_at` |
| `200` | 同成功摘要（幂等重放，不提示“失败”） |

成功后：`my_prediction` 非 null；`can_predict_reason` 期望为 `ALREADY_SUBMITTED`。

### 4.4 二次提交

| 场景 | 期望 | UI |
|---|---|---|
| 同 key + 同 payload | `200` 首次结果 | 当成功 |
| 同 key + 不同 payload | `409 IDEMPOTENCY_KEY_REUSED` | 提示键冲突；用新 key 或恢复原 payload（实现任选，语义不变） |
| 不同 key + 同 match 已有预测 | `409 PREDICTION_ALREADY_SUBMITTED` | 已提交；刷新详情，禁止再交 |
| 并发双点 | 最多一条成功 | 按钮 loading 互斥；失败方按 code 处理 |

### 4.5 POST 失败 code → UI 动作

| HTTP | code | UI 动作 |
|---|---|---|
| 401 | `UNAUTHORIZED` | 身份缺失态；不提交伪造身份 |
| 409 | `USER_DELETED` | 注销态 |
| 409 | `PREDICTION_ALREADY_SUBMITTED` | 已提交态；拉详情 |
| 409 | `MATCH_NOT_PREDICTABLE` | 不可预测；刷新 match（覆盖未确认开球/非 scheduled） |
| 409 | `PREDICTION_LOCKED` | 截止关闭；禁用提交 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 见 4.4 |
| 422 | `VALIDATION_ERROR` | 校验提示；可改输入后新 key 重提 |
| 429 | `RATE_LIMITED` | 限流提示；手动稍后重试 |

---

## 5. 页面规格（低保真）

> 区域用“块”描述，不指定组件库/路由/像素。字段仅列合同已有项。

### 5.1 会话进入 / 初始化

| 项 | 规格 |
|---|---|
| 目的 | 在具备可信 openid 时建立/恢复用户会话 |
| 主区域 | 产品说明区；昵称输入（首次）；主行动“进入”；状态区 |
| 用户动作 | 填写 `nickname`（1..32）→ 初始化；或仅公开浏览比赛/排行榜 |
| API | `POST /v1/session/init` body: `{ nickname }`（Auth required） |
| 成功 | `201` 新建 / `200` 既有（再 init **忽略**新 nickname）；消费 `user_id,nickname,favorite_team_id?,status=active,career_points,career_level` → 进比赛列表 |
| loading | 按钮锁定 |
| empty | 不适用 |
| error | `422` 昵称校验；`500`/网络错误可重试 |
| 401 | 无可信身份；可继续公开浏览 |
| 429 | 限流提示 |
| 409 `USER_DELETED` | 注销态，不进入 Auth 功能 |

### 5.2 比赛列表

| 项 | 规格 |
|---|---|
| 主区域 | 筛选条（时间窗 `from`/`to`、可选 `status`）；比赛卡片列表；分页“更多” |
| 卡片字段 | `home_team.name` / `away_team.name`；`kickoff_at`；`match_status`；`regular_*`（null 规则见 §3）；`can_predict`/`can_predict_reason` 入口提示 |
| 用户动作 | 浏览、筛选、分页、点进详情 |
| API | `GET /v1/matches` query: `from?,to?,status?,limit?,cursor?` |
| 成功 | 渲染 items；`has_more` 时用服务端 `next_cursor` 请求下一页 |
| loading | 列表骨架/占位 |
| empty | `items=[]` → 无比赛 |
| error | `422` 参数；网络/`500` 重试 |
| 401 | 不适用（公开读）；若带身份，reason 可反映登录相关 |
| 429 | 限流 |

### 5.3 比赛详情 + 预测提交

| 项 | 规格 |
|---|---|
| 主区域 | 对阵与状态；截止相关只读时间字段（`prediction_deadline_at?`,`prediction_closed_at?` 有则显示）；正式比分；`my_prediction` 区；比分输入+提交；禁用原因区 |
| 用户动作 | 查看；在可提交时输入主客比分并提交；查看已提交摘要与结算 |
| API | `GET /v1/matches/{match_id}`；`POST /v1/predictions` |
| 成功读 | 列表字段 + `my_prediction`（null 或完整对象） |
| 成功写 | §4.3；刷新详情 |
| loading | 详情加载；提交中禁用 |
| empty | 不适用（404 见下） |
| error | `404` 比赛不存在；`422`；网络 |
| 401 | 提交路径；读仍可公开（无 `my_prediction` 或 reason=`AUTH_REQUIRED`） |
| 429 | 读/写限流 |
| 状态矩阵 | 必须覆盖 §3 全部 `match_status` 与 reason |

### 5.4 我的预测

| 项 | 规格 |
|---|---|
| 主区域 | 预测列表（`submitted_at` 新到旧）；分页；条目结算区 |
| 条目字段（仅合同） | `round_id`；`home_team_id`/`away_team_id`（**无队名**）；`kickoff_at`；预测比分；`derived_result`；`match_status`；`regular_*?`；`match_score?`；`wdl_hit?`；`exact_hit?` |
| 用户动作 | 分页浏览；点条目可进 `GET /predictions/me/{prediction_id}` 或 **跳转** `GET /matches/{match_id}` 取 `home_team.name`/`away_team.name` |
| API | `GET /v1/predictions/me`；可选 detail |
| **展示约束** | **禁止**假设 predictions/me 含球队名嵌套；需要队名必须走 match 详情 |
| 成功 | items + page |
| loading / empty / error | 标准；empty=`[]` |
| 401 / 409 USER_DELETED / 404 USER_NOT_FOUND / 429 / 422 / 500 | 按全局规则 |

### 5.5 我的资料 / 等级

| 项 | 规格 |
|---|---|
| 主区域 | 资料块 + 等级块（可同页分区，不必两 URL） |
| 资料字段 | `nickname`；`favorite_team_id?`（只显示 ID 或“未设置”，**不**发明队名表）；`career_points`；`career_valid_predictions`；`career_wdl_hits`；`career_exact_hits`；`career_wdl_accuracy_percent?`；`career_level`；`career_best_level` |
| 等级字段 | `season{season_id,valid_predictions,wdl_hits,wdl_accuracy_percent?,level,best_level}`；`career{...}` |
| 用户动作 | 查看；入口到解锁 |
| API | `GET /v1/profile/me`；`GET /v1/levels/me` |
| 状态 | loading/error/401/409/404/429；无 empty 列表语义 |
| 编辑/注销 | **首版不做** |

### 5.6 解锁

| 项 | 规格 |
|---|---|
| 主区域 | 历史 unlock 列表；可选进度对照 |
| API | `GET /v1/unlocks/me` |
| 成功字段 | `unlocked[]` 每项仅依赖展示：`unlock_code`,`threshold_points`,`unlocked_at`；响应中其他既有字段不作为首版展示依赖 |
| 排序 | 后端 `threshold_points ASC, unlock_id ASC`；UI 保持顺序 |
| 历史保留 | 全部历史展示；**不因**积分下降隐藏 |
| 进度 | 可用 `profile.career_points` 与 `threshold_points` 对比；**不**新增后端进度字段 |
| 状态 | empty=`unlocked=[]` 显示“暂无解锁记录”；401/404/409/422/429/500 按合同 |

#### 静态映射边界（硬约束）

允许（前端本地资源，**非 API 合同**）：

- 以 `unlock_code` 为键的本地展示标识（例如资源 token / 占位标签）。  
- 以已知阈值 `30|100|200` 做进度条分档（阈值来自响应或与 §18.2 一致的本地表，**展示仍以响应 `threshold_points` 为准**）。

禁止：

- 请求或假定 name / icon URL / description / category 等未定义字段。  
- 把本地文案写进后端错误或 API 文档。  
- 因本地映射缺失而调用不存在的接口。  
- 映射不到的 `unlock_code`：显示 **code 原文 + threshold + 时间**，Fail Visible，不崩溃。

已知 code 枚举（合同）：`profile_card_style_1` | `favorite_team_name_accent` | `favorite_team_avatar_frame_1`。

### 5.7 排行榜

| 项 | 规格 |
|---|---|
| 主区域 | `period_type` 切换 week|month；可选 `period_key`；排名列表；分页 |
| 条目字段 | `global_rank`；`display_name`；`favorite_team_id?`；`period_score`；`valid_predictions`；`wdl_hits`；`exact_hits`；`wdl_accuracy_percent`；`last_scoring_match_at?` |
| 用户动作 | 切换周期类型；分页 |
| API | `GET /v1/rankings?period_type=week|month&period_key?&limit?&cursor?` |
| 成功 / empty / loading | 标准；入榜口径由后端保证（`valid_predictions≥3`） |
| error | `422`（缺 period_type/非法参数）；429 |
| 401 | 不适用（公开读） |
| 公开主页跳转 | **首版不做** |

---

## 6. 低保真验收场景清单

> 通过标准：路径可走通；控件启用/禁用与 `can_predict_reason` 及 POST code 一致；null 不伪装；无未冻结字段。

### 6.1 会话与身份

- [ ] S1 无可信身份：可打开比赛列表/排行榜；Auth 动作 → 401 态  
- [ ] S2 有身份首次 init → 201 → 进列表  
- [ ] S3 再次 init → 200，昵称不被覆盖  
- [ ] S4 注销用户 init/Auth → 409 USER_DELETED 统一态  
- [ ] S5 init 429 / 422 可识别

### 6.2 比赛与预测

- [ ] M1 列表 loading / empty / 分页 cursor 原样  
- [ ] M2 卡片展示队名、状态、比分 null 规则  
- [ ] M3 `scheduled` + 可预测：可输入提交 → 201  
- [ ] M4 幂等重放同 key 同 payload → 200 当成功  
- [ ] M5 已提交：reason=`ALREADY_SUBMITTED`，禁止再交  
- [ ] M6 不同 key 再交同 match → 409 PREDICTION_ALREADY_SUBMITTED  
- [ ] M7 同 key 不同 payload → 409 IDEMPOTENCY_KEY_REUSED  
- [ ] M8 reason=`CLOSED` / POST `PREDICTION_LOCKED`：禁用一致  
- [ ] M9 `postponed`：不可预测，不因旧 deadline 显示可投  
- [ ] M10 `live`/`finished`/`cancelled`/`abandoned`：不可预测  
- [ ] M11 `KICKOFF_UNCONFIRMED`：不可预测  
- [ ] M12 `AUTH_REQUIRED`：引导身份，不本地假提交  
- [ ] M13 结算 null：待结算；非 null：0/3/12 与命中布尔  
- [ ] M14 提交中防重复点击；429 不连刷

### 6.3 我的预测 / 资料 / 解锁 / 榜

- [ ] P1 我的预测分页；队名仅能经 match 详情补全  
- [ ] P2 取消/未结算条目结算字段 null 显示正确  
- [ ] U1 profile + levels 字段只读展示  
- [ ] U2 unlock 历史仅用 code/threshold/时间展示；积分下降仍显示历史  
- [ ] U3 静态映射缺失时 fallback 到 code 原文  
- [ ] R1 周/月榜切换；empty；cursor 分页  
- [ ] X1 首版无编辑资料/注销/他人主页/分享卡/管理端入口

---

## 7. C2 前必须由产品决定的平台事项

下列**不在 C1 定稿**；未决定前禁止写入平台专有 API/路由/组件实现。

| # | 事项 | 为何阻塞 C2 | 备注 |
|---|---|---|---|
| 1 | 客户端形态：Web **或** 微信小程序 | 运行时、构建、发布通道不同 | C0 已冻结“未选择” |
| 2 | 可信 openid 如何进入运行时（B3） | Auth 页从 401 恢复的真实路径 | 不发明 JWT/Cookie 登录体系 |
| 3 | 本地 mock contract vs 测试环境接线顺序 | 垂直切片方式 | 仍不得改合同 |
| 4 | 静态 unlock 映射的**本地资源包**内容 | 仅影响展示资源，不改 API | 映射键仍是 `unlock_code` |
| 5 | 是否把资料/等级/解锁做成单页多区或子页 | 信息架构变体 | 字段集不变 |
| 6 | 是否把“可选二次切片”纳入某次 C2 增量 | 范围 | 默认仍关闭 |
| 7 | 时间展示时区/格式偏好 | 纯展示 | 存储/传输仍 UTC |

**C2 入口条件（摘要）：** C0 范围 + 本文状态矩阵可验收；用户端 API 冻结检查通过；平台形态与 B3 身份注入方案已选定。本文**不**替代 A5 机械判据结论。

---

## 8. 变更纪律

- 需要新可见字段/接口：先改 `MVP__v1.0.md` + OpenAPI + 测试，再改本验收。  
- unlock 若改服务端文案/图标：另冻合同；此前只允许前端静态映射。  
- 管理端 UI：另做产品决策。  
- 文件名固定：`C1_PLATFORM_NEUTRAL_WIREFRAME_ACCEPTANCE__v1.0.md`。  
- 下一步实现门禁属 **C2**；认证接线属 **B3**；二者均不得反向修改已冻 API。
