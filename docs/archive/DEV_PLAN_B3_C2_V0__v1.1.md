# B3 / C2 V0 切片计划 v1.1

> 状态：**完整版开发文档**（**未授权实现**）。总计划：`DEV_PLAN_B3_C2__v1.0.md` §4/§5。  
> 基线：`b115180`（受保护）。验收源：C1 §6 **S1–S3、M1**；合同：`openapi.yaml` + §49.1/§49.16。  
> 相对 v1.0：纳入主审 A/B 类修正与 C/D 类确认。只规划本地 mock 网关 + 内存 repo + 小程序最小工程。不改合同、不写实现、不部署云函数。

---

## 1. V0 目标与逐条验收判据

**目标：** 本地/测试可对 mock 网关调用 `POST /v1/session/init`、`GET /v1/matches`；小程序解析完整 envelope、展示列表骨架、发起会话初始化。handler **零改动**。

**不做：** 真实云函数/云托管、B1/B2/B4/B5、JWT、详情/预测/我的/榜、改 OpenAPI/handler、前端传 openid、四 Tab。

| 场景 | 通过判据（V0） |
|---|---|
| **S1** | 无可信身份：比赛列表可打开且 `GET /v1/matches` → **200** + `data.items`/`page`；`POST /v1/session/init` → **401 `UNAUTHORIZED`**。列表页**可不经成功 init** 直达（会话页 401 或跳过可进 `pages/matches`），保证手工可达。C1 S1 排行榜半段属 **V5**，本切片不验收。 |
| **S2** | dev/test 注入 mock openid 后首次 init（body 仅 `{ nickname }`）→ **201** + `SessionInitData`（无 `openid`）→ 进入列表。 |
| **S3** | **同一网关进程内**同 mock openid 再 init（可换 nickname）→ **200**；`data.nickname` 仍为首次值（§49.1 忽略新昵称）。重启后再打会变 **201**，故手工/自动验收中途不得重启进程。 |
| **M1** | 列表 **loading**（请求未回不闪空）；`items=[]` → **empty**（非错误）；`has_more=true` 时把服务端 `page.next_cursor` **原样**作下一页 `cursor`，不解析/不手造。 |
| **M1+A5** | 非法 `cursor` → HTTP **422** + `code=VALIDATION_ERROR`；错误体含 `code` 与顶层 `request_id`；列表按 error 态，不把 422 当空列表。 |

总计划独立验收同时成立：公开列表 200；缺身份 Auth→401；有 mock 身份 init→201/200。既有 handler 测试保持绿。

---

## 2. 后端切片

### 2.1 文件清单（路径级）

**新建：**

| 路径 | 职责 |
|---|---|
| `src/gateway/config.ts` | 读规划级环境键 → `GatewayRuntimeConfig`；Fail Closed 规则见 §2.2 / §2.3 |
| `src/gateway/identity.ts` | `resolveTrustedOpenid(config)`；禁止读客户端身份 |
| `src/gateway/seed.ts` | 向 `InMemoryRepository` 预置 team/match（不预置用户） |
| `src/gateway/assemble.ts` | 路由 + 调 handler + `makeRequestId` + `mapErrorToHttp` + 显式 `rate_limiter` |
| `src/gateway/http.ts` | Node `http` 本地入口（无新运行时依赖）；listen 前校验配置 |
| `src/gateway/assemble.test.ts` | 装配/身份隔离/S1–S3/M1/非法 cursor/query 原样转发 |
| `src/gateway/identity.test.ts` | prod 丢弃 mock；dev/test 注入；与 cursor Fail Closed **分开** |
| `src/gateway/config.test.ts` | `FOOTBALL_ENVIRONMENT` 缺失/非法、cursor secret 空 → Fail Closed（B7） |

**修改：** **无**。不改 `session.ts` / `matches.ts` / `validation.ts` / session 与 match-query application / `repositories.ts` / `environment-config.ts` / `openapi.yaml` / `package.json` / `tsconfig*.json`。

**复用：** `postSessionInit`、`getMatches`、`SessionService`、`MatchQueryService`、`InMemoryRepository`、`makeRequestId`、`mapErrorToHttp`、`validationError`、`InMemoryRateLimiter`（**不用**共享 `defaultApiRateLimiter` 跑 V0 用例）、`MVP_SEASON`、`EnvironmentName`。

`src/gateway/` 位于 `src/` 下，既有 `tsconfig.json` / `tsconfig.build.json` 的 `include: ["src"]` 会带上 typecheck/build，**无需改 tsconfig**。

### 2.2 网关装配与函数签名

```text
GatewayRuntimeConfig {
  environment: "dev" | "test" | "prod"
  mock_trusted_openid: string | null   // 仅 dev/test 生效；空串必须已落成 null
  match_cursor_secret: string          // 非空；交给 MatchQueryService，非 API 字段
  public_source: "local_v0"            // 常量，见下
}

LOCAL_PUBLIC_SOURCE = "local_v0"       // getMatches 公开读取限流键

loadGatewayRuntimeConfig(env): GatewayRuntimeConfig
  // 供 http.ts 在 listen 前调用；测试直接构造 GatewayRuntimeConfig，不读真实环境文件

handleGatewayRequest(input: {
  method: string                       // 入参后统一大写
  path: string                         // 去 query、去尾斜杠后的路径
  query: Record<string, string>        // HTTP 层原样；可赋给 handler 的 Record<string, unknown>
  body: unknown
  server_now: Date
  config: GatewayRuntimeConfig
  services: { session, matches }
  repo: AppRepository
  rate_limiter: RateLimiter            // 调用方显式传入的独立实例
}): Promise<{ status: number; body: unknown }>
```

**`public_source`（A2）：** 本地值钉死常量 `local_v0`。`http.ts` 装配与 `assemble.test.ts` **用同一常量**。它是网关内部限流键，**不进 API**、**不让小程序传**、不出现在 query/body/header。

**cursor secret（A3 / A8）：**

- 测试：经 `GatewayRuntimeConfig` 注入**固定非空测试值**（不读环境、不入库）。
- `http.ts`：读 `FOOTBALL_MATCH_CURSOR_SECRET`；未设或空白 → **拒绝 listen**，打**不含密钥值**的错误后退出。
- 开发者在 shell `export` 任意非空串；**源码与仓库不放默认密钥**。
- `MatchQueryService` 构造必须用**同一** `config.match_cursor_secret`：`new MatchQueryService(repo, config.match_cursor_secret)`。listen 进程与测试夹具各自持有自己的 config 副本，但单进程内 codec 与配置同源。

**`FOOTBALL_ENVIRONMENT`（A10）：** 缺失或非法（非 `dev`/`test`/`prod`）→ Fail Closed，**不启动**。

**`FOOTBALL_CLOUD_ENVIRONMENT_ID` / `FOOTBALL_RESOURCE_NAMESPACE`（A10）：** **本切片占位不读**。V0 `http.ts` / `loadGatewayRuntimeConfig` 不解析这两键，不调用 `assertEnvironmentIsolation` 凑三套值。键名留给后续云隔离切片；本切片不得半接线、不得发明占位值。

装配步骤：

1. `request_id = makeRequestId()`；`try/catch` 一律 `mapErrorToHttp(err, request_id)`。成功/失败 `request_id` 都在 **body 顶层**。
2. `trusted_openid = resolveTrustedOpenid(config)`。**永不**从 header/query/body 取 `openid`/`user_id`/JWT。
3. method 统一大写；path 去掉 query 与尾斜杠。只认 `POST /v1/session/init`、`GET /v1/matches`。其它 method/path → 既有 `validationError` → **422 `VALIDATION_ERROR`**。
4. `POST /v1/session/init` → `postSessionInit(session, { trusted_openid, body, server_now, request_id, rate_limiter })`；原样返回 `{ status, body }`（200/201 envelope）。缺可信 openid **仍调用** handler，由 handler 抛错，网关不短路自造 401。
5. `GET /v1/matches` → 可选 `repo.users.findByOpenid(trusted_openid)`：仅当 mock 身份存在且用户 **active** 才传 `authenticated_user_id`，否则 `null`（公开读仍 200；未 init 时 item 上 `can_predict_reason` 可为 `AUTH_REQUIRED`，属合同已有**列表字段枚举**）。调用 `getMatches(matches, { authenticated_user_id, public_source: config.public_source, query, server_now, request_id, rate_limiter })`。
6. 日志只打 `request_id`、path、HTTP status、`code`；不打完整 openid/密钥。

**HTTP 层（B2 / B4 / B5 / A6 / A8）：**

- `http.createServer`；`listen` 绑 **本机 loopback `127.0.0.1`**（禁止 `0.0.0.0`）。端口实现时选定；`miniprogram/config.js` 必须与之同一 origin：`http://127.0.0.1:<port>`。
- 启动命令写死：`npm run build && node dist/gateway/http.js`（不改 `package.json` / tsconfig，不加 start script）。
- query：解析为 `Record<string, string>` **原样转发**；不做 Number 转换；不代填 `from`/`to`；重复 key **取第一个**。装配测试 `limit` 用字符串 `"2"`，与 URL 解析一致。
- POST 空 body（无字节 / 仅空白）当作 `{}`。仅非法 JSON 或 JSON 非对象（数组/标量）→ `validationError` → 422。
- V0 **不**写云函数 `exports.main`。

**限流实例（B1）：** 网关进程与每个测试套件各 `new InMemoryRateLimiter()`，经 `rate_limiter` **显式传入** handler。禁止网关与测试共用 `defaultApiRateLimiter`，以免把 S1–S3/M1 打到 429。

### 2.3 mock 身份键与隔离

| 键 | V0 处理 |
|---|---|
| `FOOTBALL_ENVIRONMENT` | 必读；`dev` \| `test` \| `prod`；缺失/非法 → Fail Closed 不 listen |
| `FOOTBALL_MOCK_TRUSTED_OPENID` | 仅 `environment ∈ {dev,test}` 且 trim 后非空才注入 |
| `FOOTBALL_MATCH_CURSOR_SECRET` | `http.ts` 必读；未设/空白 → 拒绝 listen；测试走 config 注入 |
| `FOOTBALL_CLOUD_ENVIRONMENT_ID` | **本切片占位不读** |
| `FOOTBALL_RESOURCE_NAMESPACE` | **本切片占位不读** |

判据：

- `dev`/`test`：键非空 → `trusted_openid`；未设或 **`""` 必须落成 `null`**（不得把空串传给 `postSessionInit`，否则会被当成“有身份”）。此即 S1。
- `prod`：**忽略** mock 键，恒为 `null`（V0 无 `getWXContext`；prod 下 init 恒 401 是刻意的）。
- 任何环境：客户端提交身份不得覆盖。body 含 `openid`/`user_id` → handler 已有 **422**（未知字段）。
- 进程内 `GatewayRuntimeConfig` 注入，便于 vitest 不碰真实环境文件。

### 2.4 种子规格（A4）

启动时 `new InMemoryRepository()`，形状对齐 `src/application/match-query.test.ts` 的 `makeTeam`/`makeMatch`（**不**预置用户）：

| 种子 | 规格 |
|---|---|
| teams | ≥2 支，含 `name`；`league_id=premier_league` |
| 默认比赛 | **至少 3 场** `match_status=scheduled`，`season_id=2026_2027`，`kickoff_at` 落在默认窗 `server_now-24h … +30d` 内，使 `limit=2` 第一页 `has_more=true` |
| 每场必带字段 | `prediction_deadline_at`、`prediction_closed_at`（后者可为 `null`，但键必须存在；对齐既有 `makeMatch`：deadline 可用 kickoff−10min，closed 默认 `null`） |
| 空库模式 | 测试夹具不预置 match，验 M1 empty |
| 用户 | **不**预置与 mock openid 绑定的用户（S2 走 201；S3 依赖同进程再 init）；**不**预置 deleted 用户（S4 属 V6） |

队名只存在 `teams.name`，经既有 `MatchListItem.home_team.name` 露出；不新增字段。

### 2.5 `request_id` 与错误映射（A1）

只复用 `src/api/v1/validation.ts`：`makeRequestId`、`mapErrorToHttp`。成功 `{ data, request_id }`；失败 `{ code, message, request_id, details }`。网关不改 status/code 表。

**401 唯一来源（V0）：** handler 内部 `conflictError("UNAUTHORIZED")`（缺可信 openid 时由 `postSessionInit` → `requireTrustedOpenid` 抛出），再经 `mapErrorToHttp` 映射为 HTTP 401 + `code=UNAUTHORIZED`。

- **`AUTH_REQUIRED` 只是** `MatchListItem.can_predict_reason` **枚举值**，不是 HTTP 错误码，也不是 V0 网关的 401 来源。
- 网关**不得**自造 401，**不得**把缺身份映射成 HTTP `AUTH_REQUIRED`，**不得**在未调用 handler 前短路写 401。
- mock 键为空字符串必须落成 `null` 而非 `""`，否则 handler 会把空串当“已注入身份”。

---

## 3. 前端切片

### 3.1 目录

仓库根 **`miniprogram/`**（微信开发者工具项目根）：

```text
miniprogram/
  app.js / app.json / app.wxss / project.config.json / sitemap.json
  config.js                 # 仅 mock 网关 origin，无密钥
  services/api.js           # 请求 + 完整 envelope
  services/session.js       # POST /v1/session/init
  services/matches.js       # GET /v1/matches
  pages/session/            # 会话初始化入口
  pages/matches/            # 列表骨架
```

理由：与 Node `src/` 隔离；DevTools 需要独立 `app.json`；V1+ 可在同根加页。V0 **不做**四 Tab（C2-1）。

`config.js`（B3）：origin 用 **`127.0.0.1`**，不用 `localhost`。形如 `http://127.0.0.1:<port>`，与网关 listen **同源**。

`project.config.json`（A6 / B6）：

- 设 `urlCheck: false`（或文档注明须在开发者工具勾「不校验合法域名」）。
- AppID 用**测试号 / 游客 AppID**（如工具 `touristappid`）。diff **不含真实 AppID**。

V0 **只验收模拟器**。真机上的 `127.0.0.1` 是手机自身，连不到开发机，不作为本切片验收。

### 3.2 API 客户端（A7 / B2 / B4）

- 只调已冻 path：`POST /v1/session/init`、`GET /v1/matches`。body/query **仅**合同字段：`nickname`；`from?`/`to?`/`status?`/`limit?`/`cursor?`。
- `api.js` 返回**完整 envelope** `{ data, request_id }`（或显式含这两键的对象），**不得只返回 `data`**。
- 分支判断用 **`statusCode` + `code`**；`message` **只展示**；`details` 首版不依赖。
- **`wx.request` 里 401/422/409/429 仍走 `success` 回调**，不能把 `success` 当 2xx。必须先看 `statusCode`，再读 body 的 `code`。
- 建议分支：`401 UNAUTHORIZED`；`409 USER_DELETED`（解析即可，注销 UI 属 V6）；`422 VALIDATION_ERROR`；`429 RATE_LIMITED`；其它 5xx/无 `code`/网络 → error。
- `page.next_cursor` **原样**回传；时间字段按 ISO8601 UTC 消费，不改语义。
- **禁止**传 openid/user_id/Authorization/JWT；**禁止**传 `public_source`。

### 3.3 页面状态（A9；不写未冻文案）

**会话页（C1 §5.1）：** 昵称输入 + 主行动；loading 锁按钮；error 展示 `message` + 手动重试；**401** 可去公开列表（或提供跳过）；**429** 稍后手动重试；empty 不适用。201/200 → 进列表。

**列表页（C1 §5.2）：** **可不经成功 init 直达**（保证 S1 手工可达）。loading 骨架；empty=`items=[]`；error=`422`/网络/`500`；**429** 不连刷；**401 不适用**（公开读）。卡片只用合同字段：`home_team.name`/`away_team.name`、`kickoff_at`、`match_status`、`regular_*`（null 不装 0）、`can_predict`/`can_predict_reason`。V0 可不进详情（M3 属 V1）。`has_more` 时“更多”带原样 cursor。

---

## 4. 测试策略

### 4.1 vitest（必须绿）

全部既有 `src/api/v1/*.test.ts` 与全量 `npm test`。V0 **新增**（各测自备 `InMemoryRateLimiter`，B1）：

- 无 mock / mock=`""` → init **401 `UNAUTHORIZED`**，且不调用“会写用户”的旁路；错误体含顶层 `request_id`。
- dev/test + mock → init **201** 再 **200**（**同 assemble 实例 / 同 repo**），第二次 `nickname` 不变；响应无 `openid`。
- prod + 同 mock 键 → 仍 **401**（`identity.test.ts`）。
- body 带 `openid` → **422**。
- `GET /v1/matches` **200**；空库 `items=[]`、`next_cursor=null`、`has_more=false`。
- 默认种子 + query `{ limit: "2" }`（字符串，B2）：第一页 `has_more=true`；第二页 `cursor` 等于第一页 `next_cursor`。
- **非法 `cursor` → 422 `VALIDATION_ERROR`，错误体含 `code` 与 `request_id`（A5）。**
- 未知 path → **422**；错误体含 `code`/`request_id`。
- POST 空 body 当作 `{}` 进入 handler（非法 JSON / 非对象才在网关层 422）。
- **cursor secret 空 → Fail Closed**（`config.test.ts`，与 identity 的 prod 测分开，B7）。
- `FOOTBALL_ENVIRONMENT` 缺失或非法 → Fail Closed 不给出可 listen 的 config（A10）。

### 4.2 手工验收（A6 / A9）

顺序（**中途不重启**网关进程）：起进程 → 设/不设 mock → S1 / S2 / S3 → 翻页。

1. shell 导出非空 `FOOTBALL_MATCH_CURSOR_SECRET` 与合法 `FOOTBALL_ENVIRONMENT`；**不设** mock。
2. `npm run build && node dist/gateway/http.js`，确认绑在 `127.0.0.1`。
3. 开发者工具打开 `miniprogram/`，模拟器访问：不经 init 进 `pages/matches` → 列表 200（S1）；会话页 init → 401，仍可去列表。
4. **同一进程**设 mock 后（或带着 mock 的配置重启**一次**后保持）：S2 首次 201；**同进程**再 init → S3 的 200。
5. 列表 loading / empty（可用空库测试夹具或另进程）/ `limit` 翻页 cursor 原样。非法 cursor 见 error 态。

只验模拟器。不连真实库、不读 `.env` 凭证文件。

---

## 5. 完成判据与质量门

实现阶段（**本文件通过前不执行**）：

```sh
npm run typecheck
npm test -- --run
npm run build
git diff --check
```

本地联调启动（A8）：

```sh
npm run build && node dist/gateway/http.js
```

另：diff 无 `.env`/凭证/真实库/日志/真实 AppID；无 OpenAPI/handler 合同 diff；无 `package.json`/`tsconfig*` diff；S1–S3、M1、A5 非法 cursor、A9 同进程 S3 勾选。

**进 V1：** 主审确认 V0 通过并告知用户后，才做 `GET /v1/matches/{match_id}` + `POST /v1/predictions` 与详情/提交（总计划 V1）。不得把 V1 页提前塞进本切片。

---

## 6. 风险 / 决策表

v1.0 §6 中已落实项收为正文，不再开放：

| # | 点 | 状态 |
|---|---|---|
| V0-D4 | 本地 listen | **已收正文**：`127.0.0.1` loopback；origin 与 `config.js` 同源；只验模拟器 |
| V0-D5 | HTTP 框架 | **已收正文**：Node `http`，不加依赖 |
| V0-D3 | S1 排行榜 | **已确认**：V0 只验列表 + init 401；半段归 V5 |
| V0-D6 | 列表是否解析 user | **已确认**：有 mock 且 active 用户才传 `authenticated_user_id` |

仍保留（语义已钉、仅实现时对齐文件名/端口数字）：

| # | 点 | 本切片默认 |
|---|---|---|
| V0-D1 | 小程序根路径 | `miniprogram/` |
| V0-D2 | mock 键名 | §2.3；可改名，语义与 Fail Closed 规则不变 |
| V0-D7 | listen 端口数字 | 实现时选定；必须与 `config.js` 同一 `<port>` |

---

## 7. 已确认无需改动（C 类，防过度设计）

1. **不预置 deleted 用户**；S4 属 V6。
2. **prod 丢弃 mock**；客户端身份永不覆盖；body 带 `openid`/`user_id` → 422（未知字段）。
3. **query 类型与 handler 一致**：HTTP 层 `Record<string, string>` 原样前传，handler 仍收 `Record<string, unknown>`；网关不改 `validateMatchesQuery`。
4. **handler 零改**；**不改 OpenAPI**；**不做**四 Tab / 详情 / 预测 / 榜。
5. **S1 排行榜半段归 V5**。
6. **V0-D6** 仅 mock 且 active 用户才传 `authenticated_user_id`。
7. 错误/成功 **`request_id` 都在 body 顶层**。
8. 未知 path 用既有 `validationError`（422），不新造码。
9. 质量门与 STOP 保留（见 §5 / §9）。

---

## 8. 操作注意（D 类）

1. **prod 下 V0 恒 401 是刻意的**（未接 `getWXContext`）。不要为此“补”客户端身份或网关自造 openid。
2. **手工验收顺序** = 起进程 → 设/不设 mock → S1 / S2 / S3 → 翻页；**中途不重启**。S3 依赖同进程内存用户；重启后二次 init 会变 201。
3. 公开列表限流键 `public_source=local_v0`、scope `public_reads` **120/min**；init 限流键 scope `authenticated_reads` **120/min**。手工勿脚本连打，以免误判 429。
4. `src/gateway/` 在 `src/` 下会被既有 typecheck/build 带上，无需改 tsconfig。
5. 真机无法用 `127.0.0.1` 打到开发机；V0 不把真机联调列入完成判据。

---

## 9. STOP

1. 本文是 V0 **完整版规划**，**不是开工令**。  
2. **未经主审通过并明确告知用户，不得开始任何 V0 编码**（含网关、种子、小程序页、配置落地）。  
3. 不得改 `b115180` 历史；不得 commit/push；不得读 `.env`/凭证/真实库/日志。  
4. 不得以“先写一点本地服务”绕过主审。  
5. 发现 SPEC_GAP：停、记录、回规范/主审，不猜字段/文案/错误码。
