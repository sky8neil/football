# 赛事预言家（football）

六大联赛（英超、西甲、意甲、德甲、法甲、中超）比分预测：后端核心 + 微信小程序，支持 VPS（PostgreSQL）与 CloudBase 双部署。

## 项目现状

- **后端核心（业务规范 v2.0）已完成**：等级 v3.0（周评估 / 赛季冻结 / 修正重评）、四榜（周榜 / 生涯榜 / 实力榜 / 赛季榜）与赛季终榜、等级赛季、群组与群榜、分享卡、结算账本、统计与榜单重建、每日一致性对账、管理端接口。
- **同步可靠性 + 休赛期收官（第二批）已完成**：逻辑比赛身份持续归并、目标竞技赛季贯穿、实时窗口与超时恢复、OpenFoot 三池额度、每日对账跨日续查、竞技赛季状态机与统一阶段接口、个人本联赛小结、排行榜休赛期回退。详见「已完成功能」。
- **验证基线（2026-11-17）**：231 个测试文件通过 / 6 跳过，**2254 项通过 / 23 跳过**；`typecheck`、`tsconfig.build.json`、`tsconfig.cloudfunction.json` 三套 `--noEmit` 与 `git diff --check` 均通过。
- **小程序**：11 个页面 + 3 个 tabBar 栏目（比赛 / 排行榜 / 我的）。

### 现状边界（不要当成已验收）

| 项 | 状态 |
|---|---|
| VPS PostgreSQL | 已在真实库完成建表、存量身份迁移与中超 2026 收官验证（2026-11-17） |
| CloudBase | **未核验**。本机无 `.env.cloudbase.local` 与腾讯云凭据，`cloudbase:verify` 未执行；`uk_user_canonical_match` 索引与双部署一致性待发布前补齐 |
| 微信开发者工具 | **未执行**。窄屏布局、收官卡三个数字、0 值文案与重试态仍需人工过一遍 |
| Provider 生产 key | 本地未跑真实 provider 请求；同步行为由单测与受控 tick 验证 |
| `RANKING_FIRST_PERIOD_KEY` | 仍为占位 `2026-W31`；等小程序正式发布后按发布周登记 |

## 文档入口

- **业务唯一规范**：[`docs/MVP__v2.0.md`](docs/MVP__v2.0.md)
- **文档索引**：[`docs/INDEX.md`](docs/INDEX.md)
- **同步可靠性 / 休赛期**：[`docs/SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md`](docs/SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md)（总计划）、[`docs/PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md`](docs/PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md)（收官与小结，唯一权威）、[`docs/PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md`](docs/PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md)（多源同步基线）
- **双部署模板**：[`ops/vps/`](ops/vps/)；步骤见 [`docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md`](docs/VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md)。CloudBase 说明：[`src/cloud-function/DEPLOY.md`](src/cloud-function/DEPLOY.md)
- **API 合同**：[`src/api/v1/openapi.yaml`](src/api/v1/openapi.yaml)（字段、状态码与 envelope 的唯一实现依据）
- **小程序代码**：[`miniprogram/`](miniprogram/)
- **视觉事实来源**：小程序实现本身 —— `miniprogram/pages/matches/`（母版页）＋ `miniprogram/styles/design-tokens.wxss`

## 已完成功能

### 领域与核心规则

- TypeScript strict、ESM、Vitest；固定 `schema_version=1`。
- 时间与周期（`Asia/Shanghai`）、等级赛季边界（7 月 1 日切换）、比分推导、计分（s / S / n / B 四项）、排行榜比较器。
- 等级 **v3.0**：每周一 10:00 截面周评估、首期保护期、赛季冻结、`best_level` 只增不减、周评估变更 `|Δ|≤1`、同周改判按周基线重评；生涯与等级赛季双 scope。
- 比赛状态机、预测提交服务端校验（截止时间、两层幂等、UUID v4 幂等键）、结算状态机。
- `finished` 且无正式比分时保持 `waiting`：比分与结算字段为 `null`，不把缺失比分当 0。

### 比赛逻辑身份（S0）

- `canonical_match_id` 标识**逻辑比赛**，`superseded_by` 指向取代记录；改期、更换来源 ID 不再产生新的预测资格。
- 同一用户对同一逻辑比赛**只能提交一份预测**；幂等重放返回原结果，新重复提交拒绝。
- 读取时对历史数据兜底：缺失 `canonical_match_id` 补为 `match_id`，缺失 `superseded_by` 补 `null`（`document-codec.ts`），旧数据不需要先迁移即可正确解码。
- 持续归并：新来源赛程先查已有逻辑比赛；确认同场后沿用逻辑身份；连续改期用指针重定向，不链式、不回滚；候选冲突保持待复核，不自动选择。
- 存量迁移脚本见「常用命令」`identity-migration`。

### 同步、窗口与额度（S1 / S2）

- **实时窗口**：`live_match` 使用 `[kickoff - 2h, kickoff + 6h]` 下界，`Live` 不再无期限滞留；按各联赛实际比赛日期计算窗口。
- **超时恢复**（`stale_recovery`）：开球后 6 小时仍非终态的比赛独占候选，退出 `post_finish_verify`；优先主源、必要时查 `of`；每自然小时最多一轮、单轮最多 10 场；未解决跨日保留，耗尽预算即停并告警 `provider_stale_recovery_exhausted`。
- **OpenFoot 三池额度**：窗口赛果核对 **60%** / 超时恢复 **10%** / 每日对账与历史漏查续查 **30%**（`budget.ts` 用 `floor` 分配，余数归对账池）。生产 120 次/日为 72 / 12 / 36，测试 40 次/日为 24 / 4 / 12。三池共享 `of` 真实日/月总限额；池预留失败回滚。
- **每日对账**（`provider_reconcile`）：待办持久化（`provider_reconcile_todos`），按 `match_id` + 目标渠道 + 目标赛果版本幂等；额度不足、请求失败、缺目标比赛、身份映射未完成均保留待办并跨日续查；按完场日 `finish_detected_at`（缺失回落 `kickoff_at`）生成，避免补成完场的旧比赛永远不进待办。
- 异步批次：每批 apply 后重算未解决比赛，再决定下一副源；副源按顺序查询，两源一致即停止。
- 五类同步任务（下表为**当前 VPS test profile 的实际生效值**，来自 `npm run vps:preflight`）：

  | 任务 | 窗口 / 说明 | 实际间隔 |
  |---|---|---|
  | `future_schedule` | 前瞻 30 天，赛程变更 | 12 小时（test）；prod 6 小时 |
  | `full_schedule_verify` | 全量核对 | 24 小时 |
  | `near_match` | T-24h ～ T-2h | 30 分钟 |
  | `live_match` | T-2h 起，`[kickoff-2h, kickoff+6h]` | 3 分钟 |
  | `post_finish_verify` | 完场确认，首次结算前高频 | **5 分钟**（test）；prod 3 分钟 |
  | `stale_recovery` | 开球 6h 后仍非终态，每自然小时最多一轮 | 60 分钟 |

  配置源：`src/sync/config.ts`（`intervalMinutesByProfile` 覆盖 test profile），常量在 `src/domain/config.ts`。

- 调度任务：`period_finalize`（1h）、`daily_consistency`（24h）、`weekly_level_eval`（周一 10:10）、`level_correction_reeval`（事件触发）、榜单快照 career/season 各 60min、strength 24h。
- 状态机保护（禁止回退）、异常快照、anomaly、job lock + lease、retry、`sync_logs`、注入式 `server_now`；Provider 批次逐条容错。

### 换季与竞技赛季（S3 / P0 / P1 / P2）

- **目标竞技赛季贯穿**：每次同步任务携带目标赛季，由它生成渠道 `season_ref`，映射、发现、入库全程同一目标季。日常任务按 `serverNow` 选当前季；历史对账用待办 `season_id`；超时恢复/临赛/完赛按比赛自身 `season_id` 分组。
- 删除「按开球日期反推赛季」：开球在赛季窗口外只产生非阻塞诊断 `league.season.out_of_buffer`（±180 天缓冲），不再整条拒绝；跨年补赛（12 月延期到次年 1 月）可正常入库。
- `league_seasons` + `season_teams` 双后端落库：赛季状态机 `open / locked / completed / reopened`，`schedule_status`（`uninitialized / partial / locked`）与 `completion_status`。
- **参赛名单只来自** `team-sync` / `providers:map-teams` / 人工写入，维护任务只读不写；名单为空给 `uninitialized` 并打 `league_season_roster_missing`。队数下限 `round_max / 2 + 1`。
- `completion_confirmed_at` 首次写入后不可覆盖；重开补录时 `reopen_count` 递增、`ended_at` 保留。
- **收官动态集合规则**：`当前集合 = 赛制要求的对阵 ∪ 该竞技赛季全部已确认逻辑比赛`；须赛制对阵齐全、当前集合全部完场/明确取消、无未归并重复记录；不再要求总数等于 240。已标记 `superseded_by` 的旧改期记录不影响收官。

### 个人本联赛小结

- 四阶段统一对外：`in_season / break / completed / between_seasons`（`LeaguePhaseValue`）；实时窗口为 `[kickoff - 2h, kickoff + 6h]`，`next_matchday` 按 `Asia/Shanghai` 归日。
- 「实际开赛」只认 `finished` / `live`：计划开球已过但未开打不算开赛。
- 小结按 `canonical_match_id` 去重；同一逻辑比赛多份预测返回 `data_conflict`，**不自动挑最好/最新**。
- 默认省略 `season_id` 返回刚收官赛季，新季开赛后自动退出，显式查旧季仍有效。
- 三数字：预测场次 / 胜平负命中 / 精确比分命中；`predicted_matches === 0` 不显示三个 0；部分未结算时标 `is_provisional`。

### 结算账本

- 不可变 `match_results`（版本严格递增、禁止回退）、`settlements`、`settlement_items`。
- item 级原子性（savepoint 隔离）、`applied` 幂等、`pending/failed` 恢复。
- 首次结算、失败重试、赛果修正；相位 ApplyItems → RebuildRanks → Finalize → Done。
- 修正重评（`level_correction_reeval`，as_of = `settled_at`）。

### 重建与对账

- 用户统计 / 等级 / 排行榜 / 榜单快照重建，维护锁去重（并发冲突 409）。
- 每日一致性对账：从 applied 账本重算比对，只报警不改账本；跳过 settling/correcting 比赛及受影响用户与周期。

### 群组与分享卡

- 群组：创建、邀请码加入、退出、解散；上限：拥有 5、加入 20、单群成员 500；群榜仅成员可见、独立重排。
- 分享卡：生涯积分 + 指定联赛/赛季/轮次四项战绩。

### API 一览（v1：26 条路径 / 30 个操作）

Base path `/v1`。成功 envelope `data + request_id`；分页 `items + page.next_cursor + page.has_more`；错误 envelope `code + message + request_id + details`。

- 会话与身份：`POST /auth/wechat`、`POST /session/init`（身份由运行时注入可信 `openid`，不用 Bearer / JWT / Cookie）。
- **联赛状态**：`GET /leagues/status`（游客可读，拒绝任何查询参数；返回 6 联赛 `phase` / `active_season_id` / `has_live_match` / `next_kickoff_at` / `next_matchday` / `next_season_kickoff_at`）。
- 比赛：`GET /matches`、`GET /matches/{match_id}`、`GET /matches/{match_id}/crowd`。
- 预测：`POST /predictions`、`GET /predictions/me`、`GET /predictions/me/{prediction_id}`、**`GET /predictions/summary`**（必须登录，只接受 `league_id` / `season_id`）。
- 资料：`GET|PATCH|POST|DELETE /profile/me`、`GET /profiles/{user_id}`。
- 等级/解锁/分享卡：`GET /levels/me`、`GET /unlocks/me`、`GET /share-card/me`。
- 排行榜：`GET /rankings`（week / season / career / strength；scope = global / group）。
- 群组：`POST /groups`、`POST /groups/join`、`GET /groups/me`、`GET /groups/{group_id}`、`POST /groups/{group_id}/leave`、`DELETE /groups/{group_id}`。
- 管理端：`GET /admin/anomalies`、`POST /admin/matches/{match_id}/result-corrections`、`POST /admin/matches/{match_id}/retry-settlement`、`POST /admin/rebuild/users/{user_id}`、`POST /admin/rebuild/rankings`（变更写审计）。

### 数据模型与仓储

- 集合（**30 个**）：`users`、`teams`、`matches`、`predictions`、`match_results`、`settlements`、`settlement_items`、`rankings`、`level_history`、`user_season_stats`、`unlocks`、`board_snapshots`、`groups`、`group_members`、`anomalies`、`provider_snapshots`、`sync_logs`、`job_locks`、`admins`、`admin_audit_logs`、`deleted_openid_mappings`、`team_provider_mappings`、`match_provider_mappings`、**`league_seasons`**、**`season_teams`**、**`provider_reconcile_todos`**、`provider_key_state`、`provider_league_state`、`provider_usage`、`scheduler_state`。
- PostgreSQL 文档式存储（每集合一表，`_id` + `document jsonb`）与 CloudBase 适配器共用同一仓储契约；内存参照实现用于测试与本地开发。Schema 与索引见 `src/schema/`。

### 小程序

- 页面（11）：`session`、`matches`（视觉母版页）、`match-detail`、`my-predictions`、`profile`、`settings`、`unlocks`、`rankings`、`groups/groups`、`groups/join`、`groups/detail`；tabBar：比赛、排行榜、我的。
- 比赛页只消费后端 `phase`：`completed` / `between_seasons` 才显示休赛角标与收官卡，`in_season` / `break` 无比赛时显示「无比赛」或「联赛间歇中」并给下一比赛日跳转。
- 默认联赛按后端阶段选择：优先直播中，其次最早 `next_kickoff_at`，无候选回退 `premier_league`。
- 收官卡展示真实 `season_id`、三数字与等级赛季榜入口；小结 `loading / ready / error` 生命周期，失败保留收官卡并可局部重试，不以 0 冒充。
- 排行榜页四榜切换（周榜 / 生涯榜 / 实力榜 / 赛季榜），按 `available_boards` 显隐；赛季榜当前季无有效入榜数据时自动回退上一赛季终榜（仅全站视图），并保留切回新赛季的入口。
- Logo 经 `logo-registry.js` 查询（`getTeamLogo` / `getLeagueLogo`）。

## 前端开发规范

1. **先读业务和 UI 范围**：`docs/MVP__v2.0.md` 与相关开发计划。
2. **接口只认 OpenAPI**：`src/api/v1/openapi.yaml` 是字段、状态码与 envelope 的唯一依据；不凭 UI 需要扩展 API。
3. **状态由后端合同驱动**：`can_predict` + `can_predict_reason` 控制预测入口；联赛阶段只消费 `/v1/leagues/status` 的 `phase`，前端不推断休赛期。
4. **null 保留语义**：比分 / `match_score` / `wdl_hit` / `exact_hit` 为 `null` 时显示「待结算 / 暂无比分」，不用 0 代替。
5. **分页 cursor 是 opaque**：只原样回传 `next_cursor`。
6. **错误处理**：分支用 HTTP 状态码 + `code`；覆盖 loading、empty、422/500/网络错误、401、409 `USER_DELETED`、429。
7. **身份边界**：前端不保存 JWT，不传 `openid` / `user_id` 作为身份。
8. **每个切片先写失败测试再实现**，再跑 typecheck、相关测试与全量测试。

## 前端视觉与交互规则（已冻结）

### 1. 视觉基线

- 按 **390px** 宽度设计，兼容 375–430px；设计稿与实现同源。
- 颜色一律使用语义 token（`styles/design-tokens.wxss`），不写 primitive HEX。
- 页面布局、配色、卡片结构、Logo 位置为冻结基线：不重做页面、不改布局配色、不新增页面结构。
- 背景三层配方（radial glow × 2 + 垂直渐变）、半透明联赛托盘、状态色左侧竖条为首页视觉签名。

### 2. 比赛卡片与预测状态机

- 卡片结构：`match-top` → `faceoff` → `foot` → `pred-wrap`。
- 预测 UI 状态四种：`collapsed | editing | submitting | submitted_locked`；业务状态独立：`open | lock | live | done`。
- **状态隔离 key 为 `联赛:日期:比赛ID`**；`drafts`、`uiStates`、`submittedMap` 按该 key 存储。
- 同一时间最多一张卡处于 `editing` / `submitted_locked`。
- 提交成功进入 `submitted_locked`，点页面任意位置收回；失败保留草稿并回到 `editing`。

### 3. 动画（时长已定稿）

| 场景 | 时长 | 实现 |
|---|---|---|
| 卡片展开/收回 | 320ms | `grid-template-rows 0fr↔1fr` + opacity + 位移 |
| 提交成功后收缩 | 900ms | `max-height` 插值过渡 |
| 点击页面收回 | 320ms | 走基类过渡 |
| 联赛/日期切换 | 淡出 180ms + 淡入 240ms | `view-exit` / `view-enter` |
| 最后一张卡展开后自动滚动 | 900ms | `requestAnimationFrame` 缓动 |

- 尊重 `prefers-reduced-motion: reduce`：动画全部关闭。

### 4. 交互边界

- 「去预测」由 feed 事件委托处理；编辑中卡片内部点击不触发页面收回。
- 比分 stepper：非负、立即判定主胜/平局/客胜；重新展开草稿归零。
- 切换联赛/日期先收回展开卡，再淡出 → 重绘 → 淡入。

### 5. 首页日期条

- 开放 `今天 … 今天+10`（11 天）；`DATE_SPAN_DAYS` 在 `matches.js`，`verify-home-migration.py` 校验等于 11。
- 日期项 112rpx 宽 + 12rpx 间距 + 两侧 32rpx 内边距。

### 6. 首页第一行昵称

- 文案一行连写：`昵称，今天看哪场？`（全角标点）；`view.brand-name` 容器 + 两个 `<text>`，不设 `display` / 宽度。
- 昵称来源：「头像昵称填写能力」（基础库 2.21.2+）。链路：会话页确认 → `POST /v1/session/init` → 本地缓存 → 首页 `onLoad` 读取。
- 缓存 key、兜底文案（`球友`）与归一化在 `miniprogram/utils/nickname.js`；超 12 字截断为「前 11 字…」。

### 7. 首页顶栏与背景

- `.mark` 64rpx 绿底圆角方块；品牌行与联赛行净空 8px（`margin-top: var(--home-tray-offset)`）。
- 背景素材 `miniprogram/assets/images/home-pitch-bg.webp`（780×1386）；重新生成 `python3 docs/design/scripts/build-bg-assets.py`。
- 玻璃档位：`.match` 54% / `.is-open` 58% / `.pred-area` 50% / 托盘 48%；blur 卡片 36rpx、托盘 14rpx。
- 落在背景/玻璃卡上的文字对比度实测 ≥4.5:1；`backdrop-filter` 不可用时退化为纯半透明面板。

## 图像与资源规格

资源放 `miniprogram/assets/`（`icons/`、`tabbar/`、`illustrations/`、`brand/`），优先 SVG 或 PNG，不含文字。

| 资源 | 交付尺寸/格式 | 用途 |
|---|---|---|
| TabBar 图标（含选中态） | PNG 96×96（2x）或 SVG | 比赛、排行榜、我的 |
| 空状态插图 | PNG 320×320（2x）或 SVG | 无比赛、无预测、无解锁 |
| 通用错误/断网插图 | PNG 400×320（2x）或 SVG | 网络错误、服务不可用 |
| 品牌 Logo | PNG 320×96（2x）或 SVG | 启动/会话页 |

- 队徽：五大联赛 128×128、中超 256×256（PNG 透明底、sRGB）；联赛 Logo 256×256。源 `/root/football_logos`，运行时资源 `docs/design/assets/logos/`。
- 线性图标：`python3 docs/design/scripts/build-icon-assets.py` 烘成 @6x 位图。
- 测试文件不进包：`miniprogram/project.config.json` 的 `packOptions.ignore` 按 `suffix` 排除 `.test.mjs` / `.test.ts`。

## 启动方式

### 方式一：本地开发（内存仓储，无需数据库）

```sh
npm install
npm run gateway:dev          # 先 build 再启动，默认 127.0.0.1:8787
```

网关使用内存数据，默认场景 `normal`，本地测试身份 `local-dev-openid`。

用微信开发者工具打开 `miniprogram/`，确认 `miniprogram/config.js` 的 `transport` 为 `"http"`、`gatewayOrigin` 指向网关，并在项目设置中勾选「不校验合法域名」。项目使用游客 appid，不需要云开发。

切换种子场景（先停网关再改环境变量启动）：

```sh
FOOTBALL_SEED_SCENARIO=thin2 npm run gateway:dev
```

可用值：`normal`、`empty`、`thin1`、`thin2`、`thin5`、`no-group`、`first-season`、`new-season`、`new-season-final`、`predictions-long`。其中 `new-season` 演示上赛季临时榜，`new-season-final` 演示上赛季终榜。

查看游客状态：

```sh
FOOTBALL_MOCK_TRUSTED_OPENID= FOOTBALL_SEED_SCENARIO=normal npm run gateway:dev
```

### 方式二：VPS（PostgreSQL + systemd + Caddy）

产物与入口：

| 角色 | 源码 | 构建产物 | systemd ExecStart |
|---|---|---|---|
| API | `src/gateway/http.ts` | `dist/gateway/http.js` | `node dist/gateway/http.js` |
| 单轮任务 | `src/jobs/tick.ts` | `dist/jobs/tick.js` | `node dist/jobs/tick.js` |

模板在 `ops/vps/`：`football-api.service`、`football-jobs.service`、`football-jobs.timer`（**每 3 分钟**，`OnCalendar=*-*-* *:00/3:00`）、`Caddyfile`、`football.env.example`。

API 固定监听 `127.0.0.1:8787`（`GATEWAY_LISTEN_HOST` / `GATEWAY_LISTEN_PORT`），进程不读 `PORT`；SIGTERM 时 `server.close()` 并关闭 PostgreSQL 连接池。

首次部署顺序：

```sh
npm ci
npm run build
npm run vps:preflight                        # 按目标打印每个任务的配置间隔与实际生效间隔
npm run vps:db -- --plan                     # 建表建索引计划（全部 IF NOT EXISTS，无破坏性）
npm run vps:db -- --apply
npm run vps:admin -- --openid <wechat-openid>  # 登记管理员
# 安装 ops/vps/ 下的 unit 到 /etc/systemd/system，替换路径/用户/域名
systemctl daemon-reload
systemctl enable --now football-gateway.service football-gateway-bridge.service
systemctl enable --now football-jobs.timer
```

环境变量（`/etc/football/gateway.env`，键名见 `ops/vps/football.env.example`）：`FOOTBALL_REPOSITORY_BACKEND=postgres`、`FOOTBALL_DATABASE_URL`、`FOOTBALL_DATABASE_SCHEMA`、`FOOTBALL_RESOURCE_NAMESPACE`、`FOOTBALL_MATCH_CURSOR_SECRET`、`FOOTBALL_WECHAT_APP_ID/SECRET`、`FOOTBALL_PROVIDER_SOURCES`、`FOOTBALL_PROVIDER_KEY_*`。凭据一律不进仓库。

> `SCHEDULER_TICK_MINUTES = { vps: 3, cloudbase: 15 }`。VPS 的 3 分钟是 systemd timer 粒度；CloudBase 平台最小 15 分钟，同一份代码在云上 `live_match` 会退化为 15 分钟 —— 这是平台限制，不是配置错误。刷新频率 = `max(任务配置间隔, 调度粒度)`。

### 方式三：CloudBase（云函数）

编译入口：`npm run cloudfunction:build` → `cloudfunctions/api/dist/cloud-function/runtime.js`，由 `cloudfunctions/api/index.js` 加载。

```sh
npm run cloudfunction:build
npm run cloudbase:provision                  # 打印集合/索引计划，不连网
npm run cloudbase:verify                     # 只读体检，缺失即退出码 1
npm run cloudbase:provision -- --apply       # 补齐缺失集合与索引（不删任何东西）
npm run cloudbase:function                   # 只读看函数配置差异
npm run cloudbase:function -- --apply        # 收敛超时 120s 并补 Timer
npm run cloudbase:deploy                     # 构建并上传云函数代码（COS 通道）
```

- 云函数默认超时只有 **3 秒**（同步会瞬间失败），timer 缺失则定时任务永远不跑 —— 这两项由 `cloudbase:function -- --apply` 收敛。
- `cloudbase:deploy` 已把预检串在命令链第一位；云端 `live_match` 降级会在部署前打印。
- 凭据运行前需在仓库根放 `.env.cloudbase.local`（`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`），该文件 gitignore，不入库。
- 小程序侧把 `miniprogram/config.js` 的 `transport` 改为 `"cloud"`，并填 `cloudEnvId` 与 `cloudFunctionName`。
- 详细说明与三类凭据边界见 [`src/cloud-function/DEPLOY.md`](src/cloud-function/DEPLOY.md)。

## 常用维护命令

### 开发与验证

```sh
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm test             # vitest run（全量）
npm run build        # tsc -p tsconfig.build.json → dist/

npx tsc -p tsconfig.build.json --noEmit          # 构建配置单独类型检查
npx tsc -p tsconfig.cloudfunction.json --noEmit  # 云函数入口单独类型检查
git diff --check                                 # 提交前必查空白错误
```

> 全量测试会调用 `cloudbase:schema`，该命令会执行 `npm run build`。测试侧已改为在**临时目录**编译校验，不再覆盖线上 `dist/`；但**人工**执行 `npm run cloudbase:schema` 仍会重建 `dist/`，请在受控时机操作。

### 数据库（VPS PostgreSQL）

```sh
npm run vps:db -- --plan          # 只读计划
npm run vps:db -- --apply         # 建表建索引（幂等，全部 IF NOT EXISTS）
npm run vps:db -- --dry-run       # 只读检查
npm run vps:admin -- --openid <wechat-openid>          # 计划
npm run vps:admin -- --openid <wechat-openid> --apply  # 登记管理员
```

可用参数：`--database-url`、`--schema`、`--namespace`；缺省读 `FOOTBALL_DATABASE_URL` / `FOOTBALL_DATABASE_SCHEMA` / `FOOTBALL_RESOURCE_NAMESPACE`。

直连查询（容器部署时）：

```sh
docker exec postgres-hotsearch psql -U <user> -d <db> \
  -c 'SELECT count(*) FROM "<schema>"."<schema>_matches";'
```

注意：每个集合一张表（`_id text` + `document jsonb`），字段要用 `document->>'field'` 取，不是独立列；表名带 schema 前缀，需要用双引号。

### 存量比赛身份迁移（一次性，默认只读）

```sh
node scripts/identity-migration.mjs                         # 默认 --dry-run，只读预览
node scripts/identity-migration.mjs --apply \
  --backup /var/backups/football/identity-<ts>.json \
  --manifest /var/backups/football/identity-<ts>.manifest.json
node scripts/identity-migration.mjs --rollback --manifest <manifest 路径>
```

- 默认 `--dry-run` 在 `REPEATABLE READ READ ONLY` 事务内预览，输出缺字段统计与逐组归并清单。
- `--apply` 前先复核；`review` 非空直接拒绝写入，**不静默处理、不自动挑最好结果**。复核类型只有三种：`ambiguous_identity`（多身份无法唯一确定、取代目标缺失/身份不一致/形成链式）、`duplicate_prediction`（同一用户同一逻辑比赛多条预测）、`dangling_prediction_match`（预测关联的比赛不存在）。
- 执行流程：复核 → 备份 → 事务内 `LOCK TABLE` → 更新 → 写清单。
- 重复执行幂等（回填只补缺失字段，不覆盖已有归并关系）。
- 读配置：`FOOTBALL_DATABASE_URL`、`FOOTBALL_DATABASE_SCHEMA`、`FOOTBALL_RESOURCE_NAMESPACE`（可来自 `/etc/football/gateway.env`）。需先 `npm run build`。

### Provider 工具

```sh
npm run providers:map-teams -- --input <teams-and-provider-samples.json>   # 生成/核对球队映射提案
npm run jobs:tick -- --dry-run      # 单轮任务预览（会先 build）
npm run deploy:preflight           # 按 FOOTBALL_DEPLOY_TARGET 推断目标
npm run vps:preflight              # 目标 VPS
```

### 服务运维（VPS）

```sh
systemctl status football-gateway.service football-gateway-bridge.service
systemctl restart football-gateway.service     # 新接口上线后需重启才生效
systemctl is-active football-gateway.service
systemctl list-timers football-jobs.timer --no-pager
journalctl -u football-gateway.service --since "-10min" --no-pager
journalctl -u football-jobs.service --since "-30min" --no-pager
```

排查要点：

- 每轮 `timer_summary` 的 `outcome` 应为 `ok`，`failed` 为空，`error_categories` 为空对象。
- `db_ops_by_collection` 里 `football_dev_season_teams` 应为 `read > 0 / write 0`（维护任务只读名单）。
- 出现 `42P01`（relation does not exist）说明库里缺表，跑 `npm run vps:db -- --plan` 核对后 `--apply`。
- 赛季收官日志：`league_season_transition`（`open → completed`）与 `league_season_maintenance_result`。

### 首页视觉（改 token / WXSS 后必须跑）

```sh
python3 docs/design/scripts/verify-home-migration.py              # 结构 + 不变式 + 取值
node    docs/design/scripts/home-view-model.mjs --out /tmp/hv
python3 docs/design/scripts/extract-home-visuals.py --views /tmp/hv --out /tmp/hv/after.json
python3 docs/design/scripts/diff-home-visuals.py /tmp/hv/before.json /tmp/hv/after.json
```

## Git 约定

- 开发前检查并保留现有工作区变更；不覆盖或 reset 未提交工作。
- 不提交 `.env`、Provider key、CloudBase 凭据、日志、真实数据库或监督器输出。
- 完成功能后必须运行 typecheck、相关测试、全量测试、build 和 `git diff --check`。
- 真实环境验证结果与未完成项需明确记录，不把本地骨架宣称为生产完成。
