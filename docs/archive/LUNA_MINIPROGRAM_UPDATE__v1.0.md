# 小程序更新任务书（给 Luna）v1.0

> 目标：在**已有的** `miniprogram/`（微信小程序工程）和 `src/`（后端）基础上**更新**，不是从头重写；做完后能在**微信开发者工具**里连本地网关调试。
> 业务基线：`docs/MVP__v2.0.md`（唯一业务依据）。接口依据：`src/api/v1/openapi.yaml`（字段、状态码、envelope 的唯一依据，**不凭 UI 需要扩展接口**）。
> 设计依据：`docs/design/current-baseline-gpt/v0.41-cc/`（`index.html` 可选状态预览；`gallery.html` 带说明）+ `docs/UI_DESIGN_SYSTEM.md`。
> 开发计划依据：`docs/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md` 的 §7（冷启动）、§8（终榜）、§10（前端占位策略与 S12 替换）。

## 0. 已定的决定（不要再改）

| 项 | 决定 |
|---|---|
| 调试连接 | **本地 HTTP 网关 + 内存数据**（`src/gateway/http.ts`，端口 8787）；开发者工具勾选「不校验合法域名」 |
| appid | 游客模式 `touristappid`（现有配置不变）；**不用云开发**，不改 `src/cloud-function/` |
| UI | 用 v0.41-cc 设计稿**替换** §10 的最简占位（对应开发计划 S12） |
| 「大家怎么选」 | **本次小程序前端不做**：后端与规范已在 S14 完成；前端接入另开切片。详情页保留由 `SHOW_CROWD = false` 控制的占位块，带 `TODO(crowd)` 注释 |
| 首页比赛卡的「大家怎么选 ›」小入口 | 不做（同上） |
| 相对更新时间 | 按用户此前决定保留，用 `server_now` 与 `updated_at` 计算；不采用设计稿 R18 的隐藏规则。现有接口没有最近提交预测时间，本轮不新增字段 |

## 1. 已有基础（先读，再动手）

- 小程序：`miniprogram/`（页面：`session / matches / match-detail / my-predictions / profile / unlocks / rankings / groups(groups,join,detail)`；服务层 `services/*.js`；工具 `utils/rankings-view-model.js`、`rankings-copy.js`、`prediction-history.js`；tokens `styles/design-tokens.wxss`；配置 `config.js`）。
- 后端：`src/`（TypeScript）；本地网关入口 `src/gateway/http.ts`，`InMemoryRepository` 下会调用 `seedGatewayRepository` / `seedRankingLeaderboard`（`src/gateway/seed.ts`）。
- 现状事实：比赛页目前**以本地夹具驱动**，不是真实接口；`app.json` 的 tabBar 有 **4 项**（比赛 / 我的预测 / 排行榜 / 我的），设计稿是 **3 项**（比赛 / 排行榜 / 我的）。
- 视觉事实来源：小程序实现本身（首页母版）。设计稿 HTML 是**参考稿**，与 UI_DESIGN_SYSTEM.md 冲突时以后者与首页实现为准。

## 2. 任务

### A. 调试链路（后端侧，只做开发工具，不改业务逻辑）

1. 在 `package.json` 增加脚本，一条命令构建并启动本地网关，例如 `gateway:dev`：
   - 环境变量：`FOOTBALL_ENVIRONMENT=dev`、`FOOTBALL_MATCH_CURSOR_SECRET=<本地占位值>`、`FOOTBALL_REPOSITORY_BACKEND=memory`、`FOOTBALL_MOCK_TRUSTED_OPENID=<本地占位 openid>`（后者仅 dev/test 生效，见 `src/gateway/config.ts`）。
   - 占位值只写在脚本里，**不写入任何真实密钥或 appid**。
2. 扩展种子数据（只改 `src/gateway/seed.ts` 一类开发工具文件），用环境变量 `FOOTBALL_SEED_SCENARIO` 选择场景，让开发者工具里能复现设计稿状态：

   | 场景 | 对应设计稿状态 |
   |---|---|
   | `normal`（默认） | 20 人以上常态、有群、≥2 个赛季（R06、M01） |
   | `empty` | 上线初期无任何结算（R01） |
   | `thin1` / `thin2` / `thin5` | 入榜 1 / 2 / 5 人（R03–R05） |
   | `no-group` | 没有任何群（R16、M03、G01） |
   | `first-season` | 首个赛季用户（R08） |
   | `new-season` | 新赛季交接：上赛季临时榜、当前赛季无人入榜（R11、M02） |
   | `new-season-final` | 新赛季交接：上赛季终榜、当前赛季无人入榜（R10、M02） |
   | `predictions-long` | 至少 9 周的预测历史（P01–P03） |

   游客状态：不带可信身份即可（`FOOTBALL_MOCK_TRUSTED_OPENID` 为空时按游客处理，具体以 `src/gateway/identity.ts` 为准）；排行榜接口需登录，游客应得到 401。
3. 在 `README.md` 增加「在微信开发者工具里调试」小节：启动命令、`miniprogram/config.js` 的 `gatewayOrigin`、勾选「不校验合法域名」、如何切换 `FOOTBALL_SEED_SCENARIO`、如何看游客状态。
4. **不要**修改：业务 handler、领域规则、`openapi.yaml` 的既有合同、`src/cloud-function/`、已通过的测试断言。后端改动必须严谨完整并带测试。

### B. 小程序 UI 对齐设计稿 v0.41-cc

按页面落地，每页先对照设计稿的对应状态，再替换 §10 的占位（搜索 `ui-placeholder`、`TODO(UI-v2)`）：

| 页面 | 设计稿 | 要点 |
|---|---|---|
| 排行榜 `pages/rankings` | `rankings-states.html` R01–R18 | 空榜、少人（1–2 人无领奖台，3–19 人标题「全部 N 位预言家」）、游客灰色占位、标签按 `available_boards` 显隐、周选择器（最近 4 周）、赛季选择器与「等待最终确认」、首赛季/赛季初提示、更新时间、范围弹层（无群时「我的群」未解锁行）。**视图模型层 `rankings-view-model.js` 保留**，只换 `wxml` / `wxss` 与文案文件 |
| 比赛详情 `pages/match-detail` | `match-detail-states.html` D01–D12 | 头部比赛卡、预测编辑区（步进器、即时判定、提交）、已提交锁定、进行中、完场（+12 / +3 / +0）、未预测、延期、取消。**「大家怎么选」不做**（见 §0） |
| 我的 `pages/profile` | `my-states.html` M01–M03 | 上赛季回顾卡（数据来自资料接口的 `previous_season`）、无群空状态 |
| 最近预测 `pages/my-predictions` | `predictions-states.html` P01–P04 | 按比赛所在周分组、「加载更多」持续用 `next_cursor` 翻页至少覆盖 8 周、空状态 |
| 群 `pages/groups/*` | `group-states.html` G01–G03 | 无群引导、输入邀请码、创建成功；与已有 `groups / join / detail` 对齐，**不新建重复页面** |
| tabBar | 三项：比赛 / 排行榜 / 我的 | 把 `my-predictions` 降为子页面（从「我的」的「全部预测」进入）；这是对 `app.json` 的结构性调整，**动手前先向我确认** |

通用约束：

- 样式只用 `styles/design-tokens.wxss` 里的 token；需要新 token 就在同一处定义并同步更新 `docs/UI_DESIGN_SYSTEM.md`；禁止页面级重复定义（该文档 §4.1、§13）。
- **常态页面（人数 ≥ 20、有群、有数据）必须与改动前一致**；新增块只在新状态下出现，不得删除或改名现有元素与数据绑定。
- 不使用博彩词汇与赌场式配色；「大家怎么选」之外也不出现任何赔率、推荐类措辞。
- 测试文件不进包（`project.config.json` 的 `packOptions.ignore` 保持）。
- 小程序没有的能力（如游客登录入口）不为占位新建完整页面，保留 `TODO` 即可。

### C. 契约缺口处理

设计稿需要的字段如果接口没有（先查 `openapi.yaml`），**不要自行扩展接口或在前端造数据**：把缺口写进交付说明，由我决定是否改规范。

## 3. 验证与交付

1. 必跑：`npm run typecheck`、`npm test`（含 `miniprogram/**/*.test.mjs`）、`npm run build`、`git diff --check`；改了首页或 token 时再跑 `python3 docs/design/scripts/verify-home-migration.py`。
2. 在开发者工具里按场景逐个走查（你无法打开工具时，请明确写「未实测」，不要声称已验证）：每个 `FOOTBALL_SEED_SCENARIO` × 对应页面，列出已核对 / 未核对的设计稿状态编号。
3. 交付说明包含：改动文件清单、启动与切换场景的命令、与设计稿的偏差、接口缺口、未实测项。
4. 不提交，除非我要求；不写任何真实 appid、openid、密钥。

## 4. 需要先问我的情况

- 要改 tabBar（§2.B 末行）。
- 要新增或修改后端接口、字段、规范条目。
- 设计稿与 UI_DESIGN_SYSTEM.md / 首页实现冲突且无法判断以谁为准。
- 发现现有测试与本任务要求矛盾。
