# 赛事预言家（football）

英超 2026_2027 赛事比分预测 MVP。

## 文档入口

- **业务唯一规范**：[`docs/MVP__v1.0.md`](docs/MVP__v1.0.md)
- **需求、冻结决策、开发计划、迁移与复盘文档**：统一位于 [`docs/`](docs/)，索引见 [`docs/INDEX.md`](docs/INDEX.md)
- **API 合同**：[`src/api/v1/openapi.yaml`](src/api/v1/openapi.yaml)
- **小程序代码**：[`miniprogram/`](miniprogram/)
- **当前首页视觉稿**：[`docs/design/赛事预言家首页-高保真-v8.6-联赛无底.html`](docs/design/赛事预言家首页-高保真-v8.6-联赛无底.html)；小程序落地页为 `miniprogram/pages/matches/`
- **Global UI Design System**：[`docs/UI_DESIGN_SYSTEM.md`](docs/UI_DESIGN_SYSTEM.md)；WXSS tokens 为 `miniprogram/styles/design-tokens.wxss`

文档目录已经统一收纳当前需求文档、业务规范、开发计划、API 冻结审查、迁移说明和反向 Review 文档。后续新增项目文档也应放入 `docs/`，README 只保留项目入口和开发约定。

## 当前已完成的后端功能

当前代码已完成一套可由内存适配器和单元/契约测试验证的 MVP 后端核心。**真实 CloudBase、微信运行时和 Provider 生产接线仍需单独完成并验证**，不能把本地测试实现当成生产集成已完成。

### 领域与核心业务

- TypeScript strict、ESM、Vitest、固定 `schema_version=1` 配置、领域类型和枚举。
- 时间/周期、比分推导、计分、等级、排行榜比较、比赛状态机、预测策略和结算状态机。
- 预测提交服务端校验、截止时间判断、两层幂等及 UUID v4 幂等键。
- `finished` 但没有正式比分时保持待结算语义：状态进入 `waiting`，比分和结算字段保持 `null`，不把缺失比分当作 0。
- 结算账本：不可变 `match_results`、`settlements`、`settlement_items`，结果版本严格递增，item 应用支持 pending/failed 恢复和 applied 幂等。
- 首次结算、失败重试、赛果修正、按版本连续追平，以及从 applied ledger 重建统计、等级、排行榜和 unlock。
- Provider 结果/状态同步的状态机保护、异常快照、anomaly、锁、lease、retry、`sync_logs` 与可信 `server_now` 语义。

### API 与身份

- 用户端 API：会话初始化、比赛列表/详情、预测提交、我的预测/详情、公开排行榜、资料、等级、解锁、分享卡。
- 管理端 API：anomaly 查询、赛果修正、结算重试、用户统计重建、排行榜重建。
- 统一成功 envelope：`data + request_id`；分页使用 `items + page.next_cursor + page.has_more`。
- 统一错误 envelope：`code + message + request_id + details`；前端程序分支使用 HTTP 状态码和 `code`，不解析 `message`。
- H4 已关闭：不使用 Bearer/JWT、Cookie 或服务端 session token；身份由网关/运行时注入可信 `openid`，客户端禁止提交 `openid`、`user_id` 或 JWT。
- 已注销用户、未注册身份、缺失可信身份和 active 用户按冻结语义区分处理；旧身份映射不可直接登录或复活旧账号。
- Provider adapter、CloudBase adapter、调度入口和限流共享存储均已有本地契约/骨架与测试，但真实环境验证不在本地测试范围内。

### 当前边界

- **已完成不等于生产上线**：真实 CloudBase 数据库、唯一约束/事务/原子语义、微信 `OPENID` 生产注入、云函数触发器、API-Football key 和真实 Provider 同步仍需环境接线与验证。
- 第 44 节验收矩阵、完整 Provider 端到端同步和部分运维 anomaly 能力仍应以 `docs/DEVELOPMENT_PLAN.md` 的实际记录为准。
- 不在首版前端范围：管理端 UI、anomaly `details` 白名单扩展、unlock 后端展示元数据、JWT/Cookie/session token、客户端自带 openid。

## 前端开发规范

Backend API Freeze Review 已通过，H4 已关闭；可以开始用户端前端。但前端必须服从以下文档和顺序：

1. **先读业务和 UI 范围**：`docs/MVP__v1.0.md`、`docs/C0_H5_MINIMUM_USER_SCOPE_DECISION__v1.0.md`、`docs/C1_PLATFORM_NEUTRAL_WIREFRAME_ACCEPTANCE__v1.0.md`。
2. **接口只认 OpenAPI**：以 `src/api/v1/openapi.yaml` 为接口字段、成功/失败状态码和 envelope 唯一实现依据；不得凭 UI 需要扩展 API。
3. **先平台无关，后平台实现**：先完成页面信息架构、状态矩阵和低保真验收，再实现微信小程序页面；不得在页面中发明 Web/微信特有的后端身份协议。
4. **状态由后端合同驱动**：`can_predict` + `can_predict_reason` 直接控制预测入口；不要在前端重复计算截止时间或比赛可预测性。
5. **null 必须保留语义**：正式比分、`match_score`、`wdl_hit`、`exact_hit` 为 `null` 时显示“待结算/暂无比分”，禁止用 0 代替。
6. **分页 cursor 是 opaque**：只原样回传 `next_cursor`，不得解析、拼接或自行构造。
7. **错误处理**：程序逻辑用 HTTP 状态码和 `code`；`message` 只用于展示。至少覆盖 loading、empty、422/500/网络错误、401、409 `USER_DELETED`、429、延期、取消、无比分待结算和已提交状态。
8. **身份安全边界**：前端不保存/生成 JWT，不传 openid、user_id 作为身份，不添加自定义身份 Header；B3 负责可信运行时身份注入。
9. **已知字段缺口不猜测**：`predictions/me` 没有球队名称嵌套对象，需要队名时跳转比赛详情；unlock 只依赖 `unlock_code`、`threshold_points`、`unlocked_at`，名称/图标使用前端静态映射；anomaly 详情首版不做。
10. **开发顺序**：导航壳 → 比赛列表 → 比赛详情/预测提交 → 我的预测 → 资料/等级/解锁 → 排行榜 → 全局状态和错误回归 → 真机/模拟器验收。每个垂直切片都应先写可验证 UI/适配测试，再实现，再跑 typecheck、相关测试和全量测试。

首版页面范围固定为：会话初始化、比赛列表、比赛详情+预测提交、我的预测、我的资料/等级、解锁、排行榜。资料编辑、账号注销、公开他人资料、分享卡是可选二次切片；管理端页面不做。

## 前端视觉规则（已定稿）

以下规则以 `docs/design/赛事预言家首页-高保真-v8.6-联赛无底.html` 为唯一视觉基线，已经用户确认冻结。**后续任何前端开发必须遵守，不得擅自改变**；如需调整，先改首页视觉稿并重新确认。

### 1. 视觉基线

- 按 **390px** 宽度设计，兼容 375–430px；设计稿与实现必须同源（单文件 HTML 首页 + Global UI Design System）。
- 视觉 Source of Truth：`docs/UI_DESIGN_SYSTEM.md`（token、语义色、组件状态）；颜色一律使用语义 token，不直接写 primitive HEX。
- 页面布局、配色、卡片结构、Logo 位置是冻结基线：不重做页面、不改布局配色、不新增页面结构。
- 背景三层配方（radial glow × 2 + 垂直渐变）、半透明联赛托盘、状态色左侧竖条是当前首页视觉签名，可复用但不强制每个页面复制。

### 2. 比赛卡片与预测状态机（已冻结）

- 卡片包含：`match-top`（时间/联赛 + 状态徽章）→ `faceoff`（主客队 + 比分区）→ `foot`（预测入口/结果）→ `pred-wrap`（展开预测区）。
- 预测 UI 状态只允许四种，互不混用：

  ```text
  collapsed | editing | submitting | submitted_locked
  ```

- 业务状态独立：`open`（可预测）/ `lock`（已提交）/ `live` / `done`；UI 状态与业务状态分离，不互相推导。
- **状态隔离 key 必须是 `联赛:日期:比赛ID`**（如 `epl:17:a`），禁止用裸比赛 ID、卡片索引或联赛索引共享状态。`drafts`、`uiStates`、`submittedMap` 全部按该 key 存储。
- 同一时间最多一张卡处于 `editing`/`submitted_locked`；点另一张「去预测」时先收回旧卡再展开新卡。
- 提交成功后进入 `submitted_locked`，显示「✓ 预测已提交」；**不自动收回**，点页面任意位置才收回。
- 提交失败必须保留草稿比分并回到 `editing`，可重试。
- 已提交（`submittedMap`）的卡在切换联赛/日期重绘后仍显示「我的预测 X:X · 已锁定」，不重新出现「去预测」。

### 3. 动画规则（时长已定稿，不得自行改）

| 场景 | 时长 | 实现 |
|---|---|---|
| 卡片展开/收回（editing ↔ collapsed） | 320ms | `grid-template-rows 0fr↔1fr` + opacity + 位移 |
| 提交成功后编辑区 → 反馈区收缩 | **900ms** | `max-height` 可插值过渡 |
| 点击页面收回（submitted_locked → collapsed） | 320ms | 走基类展开/收回过渡 |
| 联赛/日期切换 | 淡出 180ms + 淡入 240ms | `view-exit` / `view-enter` |
| 最后一张卡展开后自动滚动 | **900ms** | `requestAnimationFrame` 缓动，不直接改 scrollTop |
| 展开卡片滚动对齐 | — | 卡片底部对齐 feed 可视区底部 + 12px 余量，考虑页面缩放比 |

- 收回动画必须平滑过渡，禁止 `display:none` 瞬间消失；折叠态用 `0fr` + 负 margin 补偿，不留空白。
- 编辑控件隐藏用 `opacity + pointer-events` 而不是 `display:none`，保证高度可插值。
- 成功反馈文字必须相对可见反馈框垂直居中（绝对定位 `inset:0` + flex）。
- 尊重 `prefers-reduced-motion: reduce`：动画全部关闭。

### 4. 交互边界（已定稿）

- 「去预测」按钮点击 → 由 feed 事件委托处理（先收回旧的再展开新的），页面级点击监听必须跳过它，避免误收。
- 编辑中卡片内部（stepper、提交按钮）点击不触发页面收回；页面其他位置点击收回所有非 collapsed 卡片。
- 点击 stepper 修改比分：非负、立即更新比分和主胜/平局/客胜判定；重新展开时草稿归零（0:0）。
- 预测默认比分 0:0；收回后重开恢复 0:0，不残留旧比分 DOM。
- 切换联赛/日期时先收回展开卡片，再淡出→重绘→淡入。

### 5. Logo 与图像规格（已定稿）

- Logo 源：`/root/football_logos`（只读）；运行时资源：`docs/design/assets/logos/`；生成脚本：`docs/design/scripts/generate-logo-manifest.js`、`inline-logo-assets.py`。
- 查询入口：`logo-registry.js` 的 `getTeamLogo(leagueId, teamId)` / `getLeagueLogo(leagueId)`；队徽自带 `leagueId`；找不到回退占位图 `placeholders/team-placeholder.png`。
- 尺寸：五大联赛球队队徽 128×128 px、联赛 Logo 256×256 px、中超队徽 512×512 px；全部 PNG 透明背景、sRGB。
- 队徽/联赛 Logo 由 `data-league-id` / `data-team-id` 注入，不在业务数据里写死路径。

## 前端图像与资源规格

图像资源应优先使用 SVG 或 PNG；图标保持统一线宽、圆角和品牌色，不使用带文字的图标，避免不同字号下出现重复文案。资源应放在 `miniprogram/assets/`，按 `icons/`、`tabbar/`、`illustrations/`、`brand/` 分类；不得把二进制资源提交到源码根目录或文档目录。

### 首批必须提供的图像

| 资源 | 数量 | 设计稿尺寸 | 交付尺寸/格式 | 用途 |
|---|---:|---:|---:|---|
| TabBar 图标 | 4 个 | 48×48 px | PNG 96×96 px（2x，透明背景）或 SVG | 比赛、我的预测、排行榜、我的 |
| TabBar 选中态 | 4 个 | 48×48 px | PNG 96×96 px（2x）或 SVG | 与未选中态一一对应 |
| 空状态插图 | 3 个 | 160×160 px | PNG 320×320 px（2x，透明背景）或 SVG | 无比赛、无预测、无解锁 |
| 通用错误/断网插图 | 2 个 | 200×160 px | PNG 400×320 px（2x）或 SVG | 网络错误、服务暂不可用 |
| 注销/不可用状态插图 | 1 个 | 200×160 px | PNG 400×320 px（2x）或 SVG | `USER_DELETED` / 无可信身份 |
| 品牌 Logo | 1 个 | 160×48 px | PNG 320×96 px（2x，透明背景）或 SVG | 启动/会话初始化页 |

### 可选资源

- 比赛详情页的轻量足球/球场装饰：设计稿 375×120 px，交付 PNG 750×240 px或 SVG；不得承载业务文字。
- 解锁资源预览：每种 64×64 px 设计稿，交付 PNG 128×128 px或 SVG；只对应既有静态 `unlock_code`，不新增 API 字段。
- 启动页背景：设计稿 375×812 px，交付 PNG 750×1624 px；只有在确认包体积可接受时再提供，优先 CSS/WXSS 实现。

### 图像交付要求

- 所有 PNG 使用透明背景（启动背景除外），色彩空间 sRGB。
- 提供 `@2x` 文件或 SVG；禁止把截图直接当图标。
- 文件名使用小写 kebab-case，例如 `tab-matches.png`、`tab-matches-active.png`、`empty-predictions.svg`。
- 每个图像同时提供 light/dark 版本的前提是 UI 需求明确要求；当前首版默认先交付单一主题。
- 图像资源不能包含 openid、JWT、用户头像等动态或敏感信息。
- 设计稿与源文件（SVG/Figma/AI 等）应与导出资源一起交付，源文件不放 `miniprogram/assets/`，可放项目外部设计交付目录。

## 常用命令

```sh
npm run typecheck   # tsc --noEmit 全量类型检查
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json 产出 dist/
npm test -- --run src/api/v1/openapi-auth-h4.test.ts  # H4/API 合同回归
```

## Git 约定

- 开发前检查并保留现有工作区变更；不覆盖或 reset 未提交工作。
- 不提交 `.env`、Provider key、CloudBase 凭证、日志、真实数据库或监督器输出。
- 完成功能后必须运行 typecheck、相关测试、全量测试、build 和 `git diff --check`。
- 当前项目仍需将真实环境验证结果与未完成项明确记录，不能把本地骨架宣称为生产完成。
