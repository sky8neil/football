# 赛事预言家（football）

六大联赛（英超、西甲、意甲、德甲、法甲、中超）2026_2027 赛季比分预测：后端核心 + 微信小程序。

## 项目现状

- **后端核心（业务规范 v2.0）已完成**：等级 v3.0（周评估 / 赛季冻结 / 修正重评）、四榜（周榜 / 生涯榜 / 实力榜 / 赛季榜）与赛季终榜、等级赛季、群组与群榜、分享卡、结算账本、统计与榜单重建、每日一致性对账、Provider 同步与调度、管理端接口。
- **验证基线（2026-10-09）**：142 个测试文件、1413 项用例全绿；`typecheck` / 全量测试 / `build` / `git diff --check` 均通过。逐项修复和未实测范围见 [review 修复交付记录](docs/MVP2.0__COMPLIANCE_FIX_DELIVERY__v1.0.md)。
- **小程序**：10 个页面 + 3 个 tabBar 栏目（比赛 / 排行榜 / 我的）；最近预测是「我的」中的子页面；视觉系统已 token 化（Design System V1）；服务层按 OpenAPI 契约经网关访问。
- **现状边界**：真实 CloudBase、微信运行时与 Provider 生产 key 的接线与验证不在本地实现范围内；当前验证由内存参照仓储 + 单元/契约测试完成。

## 文档入口

- **业务唯一规范**：[`docs/MVP__v2.0.md`](docs/MVP__v2.0.md)（v1.0 归档只读：[`docs/MVP__v1.0.md`](docs/MVP__v1.0.md)）
- **文档索引**：[`docs/INDEX.md`](docs/INDEX.md)；需求、决策、开发计划与过程记录统一收录于 [`docs/`](docs/)
- **API 合同**：[`src/api/v1/openapi.yaml`](src/api/v1/openapi.yaml)（接口字段、状态码与 envelope 的唯一实现依据）
- **小程序代码**：[`miniprogram/`](miniprogram/)
- **视觉事实来源（V1 起）**：**小程序实现本身**——`miniprogram/pages/matches/`（母版页）＋ `miniprogram/styles/design-tokens.wxss`（tokens）；设计稿 HTML 为参考稿。Design System 文档：[`docs/UI_DESIGN_SYSTEM.md`](docs/UI_DESIGN_SYSTEM.md)
- **首页视觉参考稿（参考非事实）**：[`docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html`](docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html)
- **视觉回归工具与基线**：`docs/design/scripts/`（`verify-home-migration.py`、`home-view-model.mjs`、`extract-home-visuals.py`、`diff-home-visuals.py`），基线在 `docs/design/baselines/`

## 已完成功能（后端）

### 领域与核心规则

- TypeScript strict、ESM、Vitest；固定 `schema_version=1` 的配置与领域模型。
- 时间与周期（Asia/Shanghai）、等级赛季边界（`level_season_of`，8 月切换）、比分推导、计分（s / S / n / B 四项）、排行榜比较器。
- 等级 **v3.0**：每周一 10:00 截面周评估（任务 10:10 启动）、首期保护期、赛季冻结、`best_level` 只增不减、非 rebuild 变更 `|Δ|≤1` 等不变量；生涯与等级赛季双 scope。
- 比赛状态机、预测提交服务端校验（截止时间、两层幂等、UUID v4 幂等键）、结算状态机。
- `finished` 且无正式比分时保持 `waiting`：比分与结算字段为 `null`，不把缺失比分当 0。

### 结算账本

- 不可变 `match_results`（版本严格递增、禁止回退）、`settlements`、`settlement_items`。
- item 级原子性（savepoint 隔离：失败项写入不落库、失败记录独立提交）、`applied` 幂等、`pending/failed` 恢复。
- 首次结算、失败重试、赛果修正；相位流转 ApplyItems → RebuildRanks → Finalize → Done；finalize 按 §15.9 顺序重读 `result_version` 追平后续版本。
- 修正重评（`level_correction_reeval`，as_of = `settled_at`，周评估前后双向消化待处理修正）。

### 重建与对账

- 用户统计 / 等级 / 排行榜 / 榜单快照重建，维护锁去重（并发冲突返回 409）。
- 每日一致性对账：从 applied 账本重算并比对，只报警、不自动改账本；跳过 settling/correcting 比赛及其受影响用户与周期。
- 榜单快照：career 每 60 分钟、strength 每 24 小时 + 周评估完成后刷新一次；career/strength 榜单按最新快照读取，week 榜直接读 rankings。

### 群组与分享卡

- 群组：创建、邀请码加入、退出、解散；上限：拥有 5、加入 20、单群成员 500；群榜仅成员可见、独立重排。
- 分享卡：生涯积分 + 指定联赛/赛季/轮次四项战绩。

### Provider 同步与调度

- 五类同步任务：`future_schedule`（6h）、`full_schedule_verify`（24h）、`near_match`（30min）、`live_match`（3min，窗口「T-2h ～ finished」）、`post_finish_verify`（3min）。
- 调度任务：`period_finalize`（1h）、`daily_consistency`（24h）、`weekly_level_eval`（周一 10:10）、`level_correction_reeval`（事件触发）、榜单快照（60min / 24h）。
- 状态机保护（禁止状态回退）、异常快照、anomaly、job lock + lease、retry、`sync_logs`、注入式 `server_now` 语义；Provider 批次逐条容错（非法条目实体级留证，不弃整包）。

### API 一览（v1：22 条路径 / 25 个操作）

- 会话与身份：`POST /v1/session/init`（身份由运行时注入可信 `openid`，不使用 Bearer/JWT/Cookie/session token）。
- 比赛：`GET /v1/matches`、`GET /v1/matches/{match_id}`。
- 预测：`POST /v1/predictions`、`GET /v1/predictions/me`、`GET /v1/predictions/me/{prediction_id}`。
- 资料：`GET|PATCH|DELETE /v1/profile/me`、`GET /v1/profiles/{user_id}`。
- 等级/解锁/分享卡：`GET /v1/levels/me`、`GET /v1/unlocks/me`、`GET /v1/share-card/me`。
- 排行榜：`GET /v1/rankings`（week / career / strength；scope=global / group）。
- 群组：`POST /v1/groups`、`POST /v1/groups/join`、`GET /v1/groups/me`、`GET /v1/groups/{group_id}`、`POST /v1/groups/{group_id}/leave`、`DELETE /v1/groups/{group_id}`。
- 管理端：`GET /v1/admin/anomalies`、`POST /v1/admin/matches/{match_id}/result-corrections`、`POST /v1/admin/matches/{match_id}/retry-settlement`、`POST /v1/admin/rebuild/users/{user_id}`、`POST /v1/admin/rebuild/rankings`（变更写审计）。
- 成功 envelope：`data + request_id`；分页 `items + page.next_cursor + page.has_more`；错误 envelope：`code + message + request_id + details`。

### 数据模型与仓储

- 集合（23 个）：`users`、`teams`、`matches`、`predictions`、`match_results`、`settlements`、`settlement_items`、`rankings`、`level_history`、`user_season_stats`、`unlocks`、`board_snapshots`、`groups`、`group_members`、`anomalies`、`provider_snapshots`、`sync_logs`、`job_locks`、`admins`、`admin_audit_logs`、`deleted_openid_mappings`、`team_provider_mappings`、`match_provider_mappings`。
- 内存参照实现（测试与本地开发）+ CloudBase 适配器（同一仓储契约）；Schema 与索引定义见 `src/schema/`。

### 小程序（微信）

- 页面：`session`、`matches`（视觉母版页）、`match-detail`、`my-predictions`、`profile`、`unlocks`、`rankings`、`groups/groups`、`groups/join`、`groups/detail`；tabBar：比赛、排行榜、我的。
- 服务层 `miniprogram/services/` 按 OpenAPI 契约经网关访问（`config.gatewayOrigin`）；比赛页读取网关接口，本地调试数据由网关种子提供。
- 排行榜页支持四榜切换（周榜 / 生涯榜 / 实力榜 / 赛季榜），按 `available_boards` 显隐，并展示「我的排行」块（ranked / not_participated / below_threshold / not_eligible）。
- Logo 资源经 `logo-registry.js` 查询：`getTeamLogo(leagueId, teamId)` / `getLeagueLogo(leagueId)`；资源规格见下文。

## 前端开发规范

1. **先读业务和 UI 范围**：`docs/MVP__v2.0.md`、`docs/C0_H5_MINIMUM_USER_SCOPE_DECISION__v1.0.md`、`docs/C1_PLATFORM_NEUTRAL_WIREFRAME_ACCEPTANCE__v1.0.md`。
2. **接口只认 OpenAPI**：以 `src/api/v1/openapi.yaml` 为字段、状态码与 envelope 的唯一依据；不凭 UI 需要扩展 API。
3. **先平台无关，后平台实现**：先页面信息架构与状态矩阵，再微信实现。
4. **状态由后端合同驱动**：`can_predict` + `can_predict_reason` 直接控制预测入口；前端不重复计算截止时间与可预测性。
5. **null 保留语义**：比分 / `match_score` / `wdl_hit` / `exact_hit` 为 `null` 时显示「待结算 / 暂无比分」，不用 0 代替。
6. **分页 cursor 是 opaque**：只原样回传 `next_cursor`，不解析、不拼接、不自行构造。
7. **错误处理**：程序分支用 HTTP 状态码 + `code`；`message` 只用于展示；覆盖 loading、empty、422/500/网络错误、401、409 `USER_DELETED`、429、延期、取消、待结算与已提交状态。
8. **身份边界**：前端不保存/生成 JWT，不传 `openid`/`user_id` 作为身份；可信身份由运行时注入。
9. **字段缺口不猜测**：队名取不到时跳转比赛详情；unlock 名称/图标用前端静态映射；anomaly 详情不在首版范围。
10. **开发顺序**：导航壳 → 比赛列表 → 比赛详情/预测提交 → 我的预测 → 资料/等级/解锁 → 排行榜 → 全局状态与错误回归 → 真机/模拟器验收；每个切片先写可验证测试再实现，再跑 typecheck、相关测试与全量测试。

首版页面范围：会话初始化、比赛列表、比赛详情 + 预测提交、我的预测、我的资料/等级、解锁、排行榜；资料编辑、账号注销、公开他人资料、分享卡为二次切片；管理端不做 UI。

## 前端视觉与交互规则（已冻结）

### 1. 视觉基线

- 按 **390px** 宽度设计，兼容 375–430px；设计稿与实现同源（单文件 HTML + Design System V1）。
- 颜色一律使用语义 token（`styles/design-tokens.wxss`），不直接写 primitive HEX。
- 页面布局、配色、卡片结构、Logo 位置为冻结基线：不重做页面、不改布局配色、不新增页面结构。
- 背景三层配方（radial glow × 2 + 垂直渐变）、半透明联赛托盘、状态色左侧竖条为首页视觉签名。

### 2. 比赛卡片与预测状态机

- 卡片结构：`match-top`（时间/联赛 + 状态徽章）→ `faceoff`（主客队 + 比分区）→ `foot`（预测入口/结果）→ `pred-wrap`（展开预测区）。
- 预测 UI 状态仅四种：`collapsed | editing | submitting | submitted_locked`；业务状态独立：`open | lock | live | done`，两者不互相推导。
- **状态隔离 key 为 `联赛:日期:比赛ID`**（如 `epl:17:a`）；`drafts`、`uiStates`、`submittedMap` 均按该 key 存储。
- 同一时间最多一张卡处于 `editing`/`submitted_locked`；点另一张「去预测」先收回旧卡。
- 提交成功进入 `submitted_locked`（「✓ 预测已提交」），点页面任意位置收回；提交失败保留草稿并回到 `editing`。
- 已提交的卡在切换联赛/日期重绘后仍显示「我的预测 X:X · 已锁定」。

### 3. 动画（时长已定稿）

| 场景 | 时长 | 实现 |
|---|---|---|
| 卡片展开/收回（editing ↔ collapsed） | 320ms | `grid-template-rows 0fr↔1fr` + opacity + 位移 |
| 提交成功后编辑区 → 反馈区收缩 | 900ms | `max-height` 可插值过渡 |
| 点击页面收回（submitted_locked → collapsed） | 320ms | 走基类展开/收回过渡 |
| 联赛/日期切换 | 淡出 180ms + 淡入 240ms | `view-exit` / `view-enter` |
| 最后一张卡展开后自动滚动 | 900ms | `requestAnimationFrame` 缓动 |
| 展开卡片滚动对齐 | — | 卡片底部对齐 feed 可视区底部 + 12px 余量 |

- 收回使用平滑过渡（`0fr` + 负 margin 补偿）；编辑控件隐藏用 `opacity + pointer-events`（保证高度可插值）。
- 成功反馈文字相对反馈框垂直居中（绝对定位 `inset:0` + flex）。
- 尊重 `prefers-reduced-motion: reduce`：动画全部关闭。

### 4. 交互边界

- 「去预测」由 feed 事件委托处理（先收回再展开）；页面级点击监听跳过它。
- 编辑中卡片内部（stepper、提交按钮）点击不触发页面收回；页面其他位置点击收回所有非 collapsed 卡片。
- 比分 stepper：非负、立即更新并判定主胜/平局/客胜；重新展开草稿归零（0:0）。
- 切换联赛/日期先收回展开卡，再淡出 → 重绘 → 淡入。

### 5. 首页日期条

- 开放 `今天 … 今天+10`（共 11 天）；常量 `DATE_SPAN_DAYS` 定义在 `miniprogram/pages/matches/matches.js`，`verify-home-migration.py` 校验其等于 11。
- 日期条独占整行宽度；日期项 112rpx 宽 + 12rpx 间距 + 两侧 32rpx 内边距（一屏约 5.5 个，右缘露半格提示可横滑）。
- 日期项为「星期 + 号码」两行，跨周同名星期不加月份区分。

### 6. 首页第一行昵称

- 文案一行连写：`昵称，今天看哪场？`（逗号 U+FF0C、问号 U+FF1F，全角）；`view.brand-name` 容器 + 两个 `<text>`（昵称段 / 后半句），两段不设 `display`/宽度/`vertical-align`（保持单一文本流，`verify-home-migration.py` 有对应不变式守卫）。
- 昵称来源：「头像昵称填写能力」（基础库 2.21.2+，`pages/session` 的 `<input type="nickname"/>`，用户确认一次）。
- 链路：会话页确认 → `POST /v1/session/init`（服务端校验并 trim）→ 本地缓存 → 首页 `onLoad` 读取。
- 缓存 key、兜底文案（`球友`）与读写归一化统一在 `miniprogram/utils/nickname.js`；昵称显示超过 12 字截断为「前 11 字…」（`truncateNickname()`，保证后半句一定显示得下）。
- 跳转首页 tabBar 页使用 `wx.switchTab`（源码含对应测试守卫）。

### 7. 首页顶栏 Logo 与间距

- `.mark`：`--mark-size`（64rpx）绿底圆角方块 + `--mark-gradient`、`--mark-radius`；`.mark-ball`：36rpx 白色足球位图（`assets/icons/icon-ball.png`，108×108 RGBA）。
- 品牌行与联赛行之间净空 8px：实现为 `.leagues-wrap` 的 `margin-top: var(--home-tray-offset)`（20rpx）；校验脚本按 2rpx = 1px 比对设计稿（`.leagues-wrap { margin-top: 10px }`）并校验净空。
- 顶栏为绝对定位 + `.topbar-spacer` 占位模型；改动只盯「联赛行上外边距」这一个值。

### 8. 首页背景与玻璃卡

- 结构：`<image class="page-bg" mode="aspectFill">` 绝对定位铺满 + 内容层抬 `z-index`；新增背景上的容器需显式 `position: relative; z-index: 1`。
- 素材：`miniprogram/assets/images/home-pitch-bg.webp`（780×1386，86 KB）；参数：白蒙层 65% + 素材降饱和 15%（已烘进素材）；重新生成：`python3 docs/design/scripts/build-bg-assets.py`。
- 玻璃档位（V1 起由 token 承载）：`.match` 54% / `.match.is-open` 58% / `.pred-area` 50% / 联赛托盘 48%；日期选中态实心白。
- blur：卡片 36rpx（`--blur-card`）、托盘 14rpx（`--blur-tray`）；`.bug`（vs 框）为实色渐变、`backdrop-filter: none`，与雾白卡面形成层级。
- 文字对比度：落在背景图/玻璃卡上的文字实测 ≥4.5:1（`--text-secondary` `#3b4f43`、`--text-muted` `#42564a`、`--text-positive` `#1a5c26`）。
- `backdrop-filter` 不可用时退化为纯半透明面板（对比度仍达标）。

## 图像与资源规格

图像资源优先 SVG 或 PNG；图标统一线宽、圆角与品牌色，不含文字；资源放 `miniprogram/assets/`（`icons/`、`tabbar/`、`illustrations/`、`brand/`），不把二进制资源放源码根目录或文档目录。

### 首批规格

| 资源 | 数量 | 设计稿尺寸 | 交付尺寸/格式 | 用途 |
|---|---:|---:|---:|---|
| TabBar 图标（含选中态） | 各 4 个 | 48×48 px | PNG 96×96 px（2x，透明）或 SVG | 比赛、我的预测、排行榜、我的 |
| 空状态插图 | 3 个 | 160×160 px | PNG 320×320 px（2x）或 SVG | 无比赛、无预测、无解锁 |
| 通用错误/断网插图 | 2 个 | 200×160 px | PNG 400×320 px（2x）或 SVG | 网络错误、服务暂不可用 |
| 注销/不可用插图 | 1 个 | 200×160 px | PNG 400×320 px（2x）或 SVG | `USER_DELETED` / 无可信身份 |
| 品牌 Logo | 1 个 | 160×48 px | PNG 320×96 px（2x）或 SVG | 启动/会话初始化页 |

### 规格与工具链

- 队徽/联赛 Logo：五大联赛队徽 128×128、联赛 Logo 256×256、中超队徽 256×256（PNG 透明底、sRGB）；由 `logo-registry.js` 的 `getTeamLogo` / `getLeagueLogo` 查询（队徽自带 `leagueId`，缺图回退 `placeholders/team-placeholder.png`）；源 `/root/football_logos`，运行时资源 `docs/design/assets/logos/`，生成脚本 `generate-logo-manifest.js`、`inline-logo-assets.py`。
- 线性图标：几何真相在设计稿内联 SVG；由 `python3 docs/design/scripts/build-icon-assets.py` 烘成 @6x 位图（96×96、透明底）；矢量源产出到 `docs/design/assets/icons/`；缩放用面积平均（BOX）。
- 交付要求：PNG 透明底（启动背景除外）、sRGB；文件名小写 kebab-case；不得包含 openid/JWT/头像等动态或敏感信息；源文件不放 `miniprogram/assets/`。
- 测试文件不进包：`miniprogram/project.config.json` 的 `packOptions.ignore` 以 `suffix` 规则排除 `.test.mjs`/`.test.ts`（校验脚本检查覆盖）。

## 常用命令

### 在微信开发者工具里调试

1. 在项目根目录启动本地网关：

   ```sh
   npm run gateway:dev
   ```

   网关使用内存数据，默认场景为 `normal`，本地测试身份为 `local-dev-openid`。
2. 确认 [miniprogram/config.js](miniprogram/config.js) 中的 `gatewayOrigin` 为 `http://127.0.0.1:8787`，用微信开发者工具打开 `miniprogram/`，并在项目设置中勾选「不校验合法域名」。项目使用游客 appid，不需要云开发。
3. 切换种子场景时，先停止网关，再用对应变量重新启动，例如：

   ```sh
   FOOTBALL_SEED_SCENARIO=thin2 npm run gateway:dev
   ```

   可用值：`normal`、`empty`、`thin1`、`thin2`、`thin5`、`no-group`、`first-season`、`new-season`、`new-season-final`、`predictions-long`。其中 `new-season` 演示上赛季临时榜（R11），`new-season-final` 演示上赛季终榜（R10）。
4. 查看游客状态时，清空本地可信身份后启动；排行榜会收到未登录响应并显示游客视图：

   ```sh
   FOOTBALL_MOCK_TRUSTED_OPENID= FOOTBALL_SEED_SCENARIO=normal npm run gateway:dev
   ```

   默认身份用于本地功能调试，不对应真实 openid。更换场景或身份后需重启网关。

```sh
npm run typecheck   # tsc --noEmit 全量类型检查
npm test            # vitest run（全量测试）
npm run build       # tsc -p tsconfig.build.json 产出 dist/

# 首页视觉（Design System 母版页）—— 改 token / WXSS 后必须跑
python3 docs/design/scripts/verify-home-migration.py                 # 结构 + 不变式 + 取值（无需浏览器）
node    docs/design/scripts/home-view-model.mjs --out /tmp/hv        # 用真实页面代码生成各状态 data
python3 docs/design/scripts/extract-home-visuals.py --views /tmp/hv --out /tmp/hv/after.json
python3 docs/design/scripts/diff-home-visuals.py /tmp/hv/before.json /tmp/hv/after.json
```

## Git 约定

- 开发前检查并保留现有工作区变更；不覆盖或 reset 未提交工作。
- 不提交 `.env`、Provider key、CloudBase 凭证、日志、真实数据库或监督器输出。
- 完成功能后必须运行 typecheck、相关测试、全量测试、build 和 `git diff --check`。
- 真实环境验证结果与未完成项需明确记录，不把本地骨架宣称为生产完成。
