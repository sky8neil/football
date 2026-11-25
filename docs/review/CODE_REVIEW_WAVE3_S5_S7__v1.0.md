# 赛事预言家：首版全面 Code Review 报告 — Wave 3（S5 + S7）

> 审查日期：2026-11-24  
> 对应计划：[FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md](FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md)  
> 交叉基准：[CODE_REVIEW_WAVE1_S1_S4__v1.0.md](CODE_REVIEW_WAVE1_S1_S4__v1.0.md)、[CODE_REVIEW_WAVE2_S2_S3__v1.0.md](CODE_REVIEW_WAVE2_S2_S3__v1.0.md)（已登记问题不重复计数，仅做交叉引用）  
> 审查范围：**S5（成长等级、各类排行榜、群组与群榜 + Q8 首次排行周）** + **S7（休赛期、自动换季与联赛个人小结 — 首版门禁专项 + Q5/Q8）**

---

## 0. Wave 3 审查总览

### 0.1 结论摘要

| 切片 | 总体风险 | 表 A：P0（阻断） | 表 A：P1（高危） | 表 A：P2（优化） | 表 B：口径差异（待裁决） |
|---|---|---:|---:|---:|---:|
| **S5（等级/榜单/群组）** | **高** | 1 | 9 | 4 | 6 |
| **S7（休赛期/自动换季/小结）** | **高** | 1 | 7 | 3 | 4 |
| **Wave 3 合计** | **高** | **2** | **16** | **7** | **10** |

**两个上线阻断级 P0 摘要**：
1. **`A-S5-01`（PostgreSQL 群组写并发竞态：击穿人数/群数上限、已解散群复活、并发重复加群报 500）**：`src/application/groups.ts:282-438` 在 PostgreSQL 默认 `READ COMMITTED` 无行锁事务下先读后整文档覆写 `groups`，并发加群可击穿 500 人上限并丢失 `member_count` 更新；解散与加群/退群并发可将 `status: "dissolved"` 覆盖回 `"active"` 令已解散群复活；同用户并发重复加同一群未捕获 `uk_group_user` 抛 500。
2. **`A-S7-01`（Q5 自动换季首版门禁未闭环：升班马副源映射/中文名/队徽及跨季赛程探测仍为纯手工或需重发小程序）**：Q5 已明确自动换季为首版上线门禁（不接受纯手工绕过），但目前升班马副源映射无持久化异常与自动入库工具、中文名/队徽强依赖小程序包内硬编码 UUID 静态表与本地 PNG（换季必发小程序新版本），且全量/未来赛程同步仅查当前赛季、无法提前探测 7/1 前公布的新赛季赛程或 7/1 后旧季补赛。

### 0.2 本次实测自动化验证基线

- **TypeScript 类型检查**：`./node_modules/.bin/tsc -p tsconfig.json --noEmit` 通过（exit 0）。
- **Wave 3 后端自动化测试套件**（S5 + S7，共 27 个测试文件）：**27 个文件全部通过（263 条用例，0 skipped）**。
- **Wave 3 小程序端自动化测试套件**（S5 + S7，共 17 个测试文件）：**17 个文件全部通过（173 条用例，0 skipped）**。
- **合计**：**44 个测试文件、436 条用例全部通过**；但需特别指出，**S5 与 S7 目前均没有任何真实 PostgreSQL 集成测试（`*.pg.test.ts`）或 WXML 模板绑定测试**，这是 `A-S5-01`（PG 群并发）、`A-S5-06`（`rankings.wxml` 绑定错误）与 `A-S7-04`（`CloudBaseAppRepository` 吞重复预测）全部穿透现有单测的根本原因。

---

## 第一部分：切片 S5（成长等级、各类排行榜、群组与群榜）

### S5.1 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S5-01** | **P0** | `src/application/groups.ts:282-313, 331-373, 380-404, 411-438`<br>`src/infrastructure/postgres-document-db.ts:1173` | **PostgreSQL `READ COMMITTED` 下群组写操作无行锁与条件更新，存在 4 类并发数据损坏**：<br>1) **击穿 500 人上限与 `member_count` 丢更新**：两用户并发 `joinGroup` 时均读出 `member_count = 499`，各自插入 `group_members`（不同 user 不撞唯一键）并写回 `member_count = 500`，实际活跃成员变 501 人且计数永久漂移；<br>2) **已解散群复活**：群主 `dissolveGroup` 与成员 `joinGroup`/`leaveGroup` 并发，后者先读 `status: "active"`，前者提交 `status: "dissolved", member_count: 0`，后者再整文档 `groups.update({ ...group, member_count: old ± 1 })` 将群覆盖复活回 `"active"`；<br>3) **击穿 5 建群 / 20 加群上限**：同一用户并发建群/加群可同时通过上限检查；<br>4) **同用户并发加同一群报 500**：均看到 `existing === null` 后并发 `groupMembers.insert`，后到者撞 `uk_group_user` 抛未捕获 `UniqueConstraintError` 返回 `500` 而非 `409 GROUP_ALREADY_MEMBER`。 | 在事务内对 `groups`（`join`/`leave`/`dissolve`）与 `users`（`create`/`join` 上限检查）加 `SELECT ... FOR UPDATE` 行锁（或改原子条件更新 `WHERE status = 'active' AND member_count < 500`）；`joinGroup` 捕获 `group_members`/`uk_group_user` 唯一冲突转为 `409 GROUP_ALREADY_MEMBER`。 |
| **A-S5-02** | **P1** | `src/application/period-finalize-service.ts:81-85, 117-132` | **周期封板 `period_finalize` 未持 `ranking:week:*` 锁且整文档覆写 `rankings`，与并发结算/重排产生丢更新**：`finalize` 仅获取 `sync:period_finalize` 锁，未获取 `rankingPeriodLockKey("week", periodKey)`；在 PG `READ COMMITTED` 事务内读出整份 `RankingEntry` 后调用 `tx.rankings.update(finalized)`。<br>**复现**：周一凌晨欧战晚场结算或历史赛果修正与每小时 `period_finalize` 重叠时，`period_finalize` 在 `t0` 读出旧分，结算在 `t1` 提交新分/新名次，`period_finalize` 在 `t2` 回写 `{ ...staleEntry, is_final: true }`，静默擦除最新得分与排名。 | 在 `withTransaction` 外部获取 `rankingPeriodLockKey(periodType, periodKey)`（与 `rebuildGlobalRanks` 一致），并为 `rankings` 增加仅更新 `{ is_final: true }` 的局部字段更新原语。 |
| **A-S5-03** | **P1** | `src/application/ranking-rebuild-service.ts:153-182`<br>`src/application/admin-rebuild-rankings.ts:173-193` | **`rankingPeriodLockKey` 在 DB 事务内部（`tx.jobLocks`）获取与释放，违背锁契约且 PG 异常时二次炸毁**：与 `settlement-item-application-service.ts:261` 明确规定的“周期 ranking 锁必须在 `withTransaction` 之外 acquire/release”相悖。<br>**复现**：PG 事务内任一 SQL 报错进入 `25P02`（aborted transaction）后，`finally` 第 181 行仍向同一中止事务发 `tx.jobLocks.release`，抛出二次 `25P02` 掩盖原始错误；在非行锁后端上，事务内未提交的锁行无法阻塞并发 `rebuildGlobalRanks`。 | 将 `rankingPeriodLockKey` 的 `acquire`/`release` 移至 `withTransaction` 之外（`this.repo.jobLocks`），覆盖 `RebuildPeriodRankingsService` 与 `AdminRebuildRankingsService`。 |
| **A-S5-04** | **P1** | `src/application/ranking-rebuild-service.ts:222, 235-244`<br>（交叉补充 Wave 1 `A-S4-04`） | **历史周重建无条件复活周期结束前已注销的用户**：当 `isHistoricalPeriod === true`（`periodEndAt <= serverNow`）时，第 235 行硬编码 `deletedUserIds = new Set()`，未按 `user.deleted_at < periodEndAt` 区分“周期内注销”与“周期后注销”。在当周内早已注销的用户，一旦执行历史周榜重建会被重新算入并恢复名次，且与当周增量排名的注销处理口径分裂。 | 统一使用 `user.status === Deleted && (user.deleted_at === null || user.deleted_at < periodEndAt)` 作为周榜注销排除判定，同步修复 `rebuildGlobalRanksInTransaction`、`rebuildPeriodRankings` 与 `ranking-query.ts`。 |
| **A-S5-05** | **P1** | `src/application/profile-mutation.ts:120-179`<br>`src/application/groups.ts:224, 344` | **账号注销未清理 `group_members` 与 `groups.member_count`，永久泄漏群名额并虚增人数**：`deleteMyProfile` 仅将 `users` 置为 `deleted`，未将用户所在群的 `group_members` 置为 `left` 或扣减 `groups.member_count`。已注销用户被网关 `409 USER_DELETED` 拦截永远无法退群，幽灵成员永久占用 `GROUP_MAX_MEMBERS (500)` 名额并虚增群人数显示。 | 在 `deleteMyProfile` 事务内将该用户所有 `active` 的 `group_members` 置为 `left` 并原子扣减对应 `groups.member_count`（若为群主，按 MVP §19.4.2 保留群为 `active` 状态）。 |
| **A-S5-06** | **P1** | `miniprogram/pages/rankings/rankings.wxml:20-21`<br>`miniprogram/pages/rankings/rankings.js:746-755` | **排行榜 WXML 忽略 `view.listTitle` 与 `listItems`，领奖台前三名重复渲染且 1–19 人错显“前 20”**：<br>1) 第 20 行硬编码 `{{scope === 'group' ? '群内' : '全站'}}前 20`，完全未绑定 `rankings-view-model.js:151-153` 已算好的 `view.listTitle`（`"全部 N 位预言家"`）；<br>2) `rankings.js:747` 已算好 `listItems: view.showPodium ? merged.slice(3) : merged`，但 WXML 第 21 行仍遍历 `wx:for="{{items}}"`，导致入榜 ≥3 人时第 1–3 名同时出现在领奖台和列表前 3 行。 | 第 20 行改为 `{{view.listTitle}}`；第 21 行改为 `wx:for="{{listItems}}"`，并在 `listItems.length === 0`（恰好 3 人全在领奖台）时隐藏下方列表卡片。 |
| **A-S5-07** | **P1** | `miniprogram/pages/groups/join.js:98-108, 143-169`<br>`src/application/groups.ts:340-343` | **`GROUP_ALREADY_MEMBER` 缺少 `details.group_id`，导致前端必触发 N+1 扇出（最多 22 次请求）**：`join.js:99` 期待 `result.details.group_id` 直跳目标群，但后端第 342 行抛出 `details = null`。前端每次必然落入 `openExistingGroup`，发 `listMyGroups` + `Promise.all(groups.map(getGroup))`（最多 20 并发）+ `openGroup` 再次 `listMyGroups`，易撞限流或单条报错导致恢复失败。 | 后端 `groups.ts:342` 在 `GROUP_ALREADY_MEMBER` 携带 `{ group_id: group.group_id }`；前端 `openGroup` 在已知 `group_id` 时免去冗余回查。 |
| **A-S5-08** | **P1** | `miniprogram/pages/groups/detail.js:77`<br>`miniprogram/pages/groups/join.js:33-36, 58-72`<br>`miniprogram/pages/groups/join.wxml:13, 17` | **邀请码粘贴截断、未规范化链接参数及非法字符静默禁用**：<br>1) `detail.js:77` 展示带空格 9 位 `"AB23 CD45"`，但 `join.wxml:13` 设 `maxlength="8"` 且 `join.js:59` 未剥离空格，用户粘贴带空格码直接截断末位；<br>2) `join.js:33` 未对 `options.code` 做 `.trim().toUpperCase()`，小写/带空格深链直接判无效；<br>3) 输入 8 位含排除字符（`0/1/O/I`）的邀请码时显示 `"邀请码已填完整"` 且 `errorMessage: ""`，但静默禁用确认按钮，用户无任何报错反馈。 | `onInviteInput` 与 `onLoad` 均先剥离空白并转大写（`maxlength` 放宽至 12 后截前 8 位）；长度满 8 位但 `!isValidInviteCode` 时立即展示 `COPY.groupInvalidInvite`。 |
| **A-S5-09** | **P1** | `miniprogram/pages/groups/detail.js:43-86, 119-144`<br>`miniprogram/pages/groups/groups.js:33-102`<br>`miniprogram/pages/groups/join.js:93-97` | **群组页缺少单页栈兜底（卡死）、请求序号、`loginGeneration` 与 401/409 处理**：<br>1) `detail.js:128-130` 退群/解散返回 `204` 后仅调 `wx.navigateBack({ delta: 1 })` 未复位 `loadingAction` 且无 `fail` 兜底，深链/单页栈进入时页面永久卡死 `loadingAction: true`；<br>2) `detail.js:57-86` 的 `loadGroup` 无请求序号、`onShow` 刷新与 `loginGeneration` 守卫，连续重试时旧 `200` 可覆盖新错误并重开分享菜单；<br>3) `groups.js`/`detail.js` 未处理 `401`/`409 USER_DELETED`；`join.js:94-95` 遇 401 跳转前未复位 `loading: false`。 | 为 `detail.js` 补 `navigateBack` 的 `fail` 兜底（`redirectTo("/pages/groups/groups")`）并复位 `loadingAction`；为 `detail.js`/`groups.js` 补请求序号、`loginGeneration` 与 401/409 登录/注销引导；`join.js` 跳转前复位 `loading: false`。 |
| **A-S5-10** | **P1** | `miniprogram/pages/rankings/rankings.js:198-200, 517-523, 798-800` | **周一显式选择“本周”在 `onShow`/`onRetry` 时被静默重置回上周**：周一服务端默认落上周（`selectedWeekIndex === 1`）；用户手动切到 `"本周"`（`index === 0`）时，第 521 行 `this.userSelectedWeek = index !== 0` 将其置为 `false`；切回 Tab 或点击重试时触发 `!this.userSelectedWeek`，清空 `selectedPeriodKey` 把用户弹回上周。 | `onWeekChange` 选中任意有效周选项时均无条件置 `this.userSelectedWeek = true`。 |
| **A-S5-11** | **P2** | `src/domain/levels.ts:421-426, 456-457`<br>`src/application/ranking-query.ts:226-227, 708-735`<br>`src/api/v1/rankings.ts:136-137` | **等级回放与榜单 API 三处边界瑕疵**：<br>1) `replayLevel` 在 `firstEvalAsOf === null` 或 `events.length > 0` 时硬编码 `{ level: 1, best_level: 1, below_count: 0 }`，静默忽略传入的 `params.initialState`；<br>2) `scope=group&board=season` 在 6/30 23:59 拿到的游标于 7/1 00:01 不传 `level_season_id` 翻页时，可绕过 `validateQuery` 读到历史赛季群榜；<br>3) `GET /v1/rankings` 先校验 query 后校验登录态，未登录缺参返回 `422` 而非 `401`。 | `replayLevel` 统一从 `{ ...initialState }` 初始化；`ranking-query.ts:708` 解析出 `requestedSeasonId` 后再次校验群榜不可查历史赛季；`rankings.ts` 将 `requireAuthenticatedUserId` 提前至 `validateRankingsQuery` 之前。 |
| **A-S5-12** | **P2** | `src/runtime/scheduled-jobs.ts:659-670, 761-779`<br>`src/application/board-snapshot.ts:284-289` | **多周期任务部分撞锁仍标记周期完成 + 同时间戳快照重建被短路**：`runPeriodFinalizeJob` 与 `runBoardSnapshotSeasonFinalJob` 在多个到期周期中只要有 1 个成功、其余 `lock_held`，仍会调用 `markPeriodicCycle` 抑制重试至下一大周期；`writeBoardSnapshotInTransaction` 遇同 `snapshot_at` 已存在直接返回旧行，管理员同毫秒重建损坏快照会被静默跳过。 | 仅在 `!skippedLock` 时调用 `markPeriodicCycle`；重建快照支持显式覆盖或拒绝同时间戳（409）。 |
| **A-S5-13** | **P2** | `src/application/groups.ts:279-324, 382-392, 457, 475`<br>`src/gateway/assemble.ts:680-755` | **群组后端防御性缺口**：<br>1) `leaveGroup` 未先校验 `group.status === Dissolved`，对已解散群的群主误报 `GROUP_OWNER_CANNOT_LEAVE`；<br>2) `createGroup` 邀请码碰撞 `for (;;)` 无最大重试次数限制；<br>3) `listMyGroups` 同时间戳排序用 `localeCompare`，游标过滤用码点序 `>`，存在跨 locale 翻页跳行风险；<br>4) 群接口路由未校验未知 `query`/`body` 字段。 | `leaveGroup` 前置 `Dissolved` 校验；邀请码重试设上限（如 10 次）；排序改码点比较；群接口补 `assertUnknownFields`。 |
| **A-S5-14** | **P2** | `miniprogram/pages/rankings/rankings.wxml:19, 21`<br>`miniprogram/pages/groups/groups.js:56-57`<br>`miniprogram/services/groups.js:32, 36, 40` | **小程序端展示与参数编码细节**：<br>1) `rankings.wxml` 用 `item.display_name[0]` 取头像首字，非 BMP Emoji 昵称会切出半个代理对乱码；<br>2) `groups.js:56` `canCreate` 仅查 `ownedCount < 5`，未检查 `groups.length < 20`，已加满 20 群用户仍见建群按钮点击必报 409；<br>3) `services/groups.js` 拼接 `groupId` 未用 `encodeURIComponent`。 | `presentItem` 预计算 `Array.from(display_name)[0]`；`canCreate` 增加 `groups.length < 20`；`services/groups.js` 对 `groupId` 使用 `encodeURIComponent`。 |

> **交叉引用 Wave 1 已登记问题（不重复计数）**：**`A-S4-01`（P0）**（`WeeklyLevelEvalService` 与 `LevelCorrectionReevalService` 在 PG 下整文档覆写 `users`/`user_season_stats` 与结算并发丢更新）、**`A-S4-04`（P1）**（注销用户周榜清零遇负分修正崩溃）、**`A-S4-05`（P1）**（7/1 冻结前窗口修正重评与 `score_delta === 0` 回放分裂）、**`A-S4-08`（P2）**（5 处重建锁租约未对齐墙钟及修正重评撞锁缺补偿）。

### S5.2 表 B：代码与文档口径差异（含 Q8 首次排行周，待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S5-01 (Q8)** | `src/domain/config.ts:13`<br>`src/gateway/config.ts:81-101`<br>`src/application/ranking-query.ts:123, 192-207, 537-558, 911`<br>`src/api/v1/openapi.yaml:1630, 1685-1695` | **Q8 首次排行周完整契约**：默认开发值 `"2026-W31"`，生产环境强制要求配置有效 ISO 周 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`（及 `FOOTBALL_LEVEL_FIRST_EVAL_AS_OF`）；每次 `GET /v1/rankings` 必返 `first_period_key` 与 `server_now`；近 4 周下拉严格截断于 `>= first_period_key`（更早返回 `422`）；上线前（`current < first`）默认 `board=week` 返回 `200` 空列表，显式传 `period_key` 返回 `422`；首周周一默认从上周回落到首周本身。 | `MVP__v2.0.md` §19.10（2268 行）定义了 `RANKING_FIRST_PERIOD_KEY` 与 4 周截断，但 §27.1 响应契约未收录 `first_period_key`/`server_now` 字段，也未规定上线前 `200` 空列表例外。 | `[x] 认代码（纳入首版 Q8 正式口径）`（✅ 已定：自洽且 fail-closed） |
| **D-S5-02** | `src/application/levels.ts:27, 38-39, 65-66, 121`<br>`miniprogram/utils/level-presentation.js:36-45` | `GET /v1/levels/me` 返回 `career.b_points`、`season.season_points`、`season.exact_hits`；前端展示“评估积分 X / Y”、“还差 Z 分”与进度条（严格按 `MINIPROGRAM_UX_REQUIREMENTS` UX-06 实现）。 | `MVP__v2.0.md` §19.8（2243 行）与 §28.1（4074 行）原禁止返回 `B` 值及展示“再拿 X 分升级”类进度，文档未标注被 UX-06 覆盖。 | `[x] 认代码（以 UX-06 覆盖 MVP §19.8/§28.1）`（✅ 已定：按 UX-06 需求实现） |
| **D-S5-03** | `miniprogram/pages/rankings/rankings.wxml:14` | 周榜卡片右上角直接渲染 `{{selectedWeekIndex ? '历史周 · 已封榜' : '预测进行中'}}`。 | `MVP__v2.0.md` §19.10.3（2299 行）明确禁止：“界面不显示‘已封榜 / 结算中’措辞（`is_final` 与‘全部结算完’不同步）”。 | `[x] 判为 Bug（改为“历史周”去掉“已封榜”）`（✅ 已定：避免晚场/修正时误导用户） |
| **D-S5-04** | `miniprogram/pages/rankings/rankings.wxml:11`<br>`miniprogram/pages/rankings/rankings.js:140, 252` | 游客态渲染普通提示面板（“请登录查看榜单 + 登录按钮”），`guestBars` 未在 WXML 渲染，且顶部欢迎区/榜单 Tab 栏仍可见可点。 | `MVP__v2.0.md` §19.10.9（2334 行）要求：“页面内容整体模糊成灰色条纹占位，居中一行‘请登录查看榜单’；不请求榜单数据”。 | `[x] 判为 Bug（补灰色条纹模糊占位并隐藏顶部 Tab）`（✅ 已拍板） |
| **D-S5-05** | `miniprogram/pages/rankings/rankings.wxml:7, 19, 21` | 1) 榜单 Tab 顺序为 `本周榜 -> 赛季榜 -> 实力榜 -> 生涯榜`；<br>2) 领奖台与列表行无 `bindtap`，未提供点击进入对方公开主页入口（已单独入 P0 `A-S6-01`）。 | 1) `MVP__v2.0.md` §19.10.8（2321 行）规定固定顺序 `week, career, strength, season`；<br>2) §19.3（2182 行）与 Q3 规定“点击行进入对方公开主页”。 | `[x] 认 Tab 顺序（周/季/实力/生涯）`（✅ 已拍板；公开主页入口已入 P0 `A-S6-01`） |
| **D-S5-06** | `src/application/ranking-query.ts:83-114, 622, 813-814`<br>`src/domain/config.ts:73-84` | 1) 历史周行为（保留已注销用户为“已注销用户”）按 `periodEndAt <= server_now` 生效，不等每小时 `is_final`；<br>2) `me`（`ranked`）增返各榜具体指标字段；<br>3) `FIXED_CONFIG_V1` 未单独定义 `RANKING_THIN_BOARD_THRESHOLD`（复用 `RANKING_TOP_LIMIT = 20`）。 | `MVP__v2.0.md` §19.7 写“已 `is_final` 历史周榜”、§27.1 `me` 仅列 `status/rank/top_percent`、§19.10 单独定义 `RANKING_THIN_BOARD_THRESHOLD = 20`。 | `[x] 认代码`（✅ 已定：消除封板前 1 小时闪烁并支撑顶部表现卡） |

### S5.3 正向合规核查确认
- **纯整数贝叶斯收缩与等级状态机严密**：`src/domain/levels.ts` 全程使用整数交叉乘法比较阈值（`100*(S+P0) >= T*(n+K)`）与向下取整展示，杜绝浮点误差；严格执行 6 级边界、Lv1→Lv2 需 20 场有效预测、表现 A + 积分 B 联合晋级、单次最多升降 1 级、Lv2 保底、连续 2 次不达标降级、13 次周评全局保护期及 `prod` 缺 `LEVEL_FIRST_EVAL_AS_OF` fail-closed 拦截。
- **群组防越权与游标签名合规**：`GroupsService.getGroup` 与 `RankingQueryService` 对不存在或已解散群返回 `404 GROUP_NOT_FOUND`、非成员返回 `403 FORBIDDEN`；`invite_code` 仅在群详情返回而不泄露于群列表；游标均经 HMAC-SHA256 + `timingSafeEqual` 校验且绑定查询参数。
- **赛季终榜与跨季交接逻辑扎实**：`RankingQueryService` 正确使用 `findLatestBySeason` 防止跨季快照污染，完整实现 7/1 后至首个周一终评前的临时上季榜（`is_provisional: true`）与终榜（`is_final: true`）交接，且 `board=season` 先校验 `not_eligible` 再判定 `ranked`，不泄露单季用户排名。

---

## 第二部分：切片 S7（休赛期、自动换季与联赛个人小结 — 首版门禁专项）

### S7.1 Q5 首版门禁自动化审计矩阵

> **Q5 门禁判定结论：当前未通过首版自动换季门禁。** 日历换季推导、`league_seasons` 记录建档与主源球队/赛程拉取已自动化，但 **3 项升班马关键环节仍为纯手工（其中 2 项需重新发版审核小程序）**、**跨季提前拉取/旧季补赛存在盲区**，且 **自动收官逻辑存在 2 个高危阻断缺陷（`A-S7-02` 附加赛污染、`A-S7-03` 腰斩误收官）**。

| 换季生命周期环节 | 当前自动化等级 | 代码实证与门禁缺口 |
|---|---|---|
| **1. 赛季 ID 与外部赛季号切换** | **半自动** | `src/domain/config.ts:339-410` 按 UTC 7/1（五大联赛）与 1/1（中超）自动推进（交叉引用 Wave 2 `D-S3-05`）。**缺口**：`ProviderFullScheduleVerifyService`（`provider-full-schedule.ts:66`）与 `ProviderFutureScheduleService`（`provider-sync-service.ts:71`）仅查询 `activeLeagueSeason(league, now)`，**不会在 7/1 前探测已发布的新赛季赛程（如英超 6 月中旬公布赛程），也不会在 7/1 或 1/1 后发现旧赛季新补赛**。 |
| **2. `league_seasons` 与 `season_teams` 建档** | **自动（存在 P1 阻塞）** | `LeagueSeasonMaintenanceService.run` 自动插入 `league_seasons`；`ProviderTeamSyncService.sync` 自动写入 `season_teams`。**阻塞**：`FootballDataAdapter` 未过滤 `RELEGATION` 附加赛（`A-S7-02`），次级联赛球队混入 `season_teams`。 |
| **3. 赛季收官判定（`completed` / `between_seasons`）** | **自动（存在 P1 阻塞）** | `evaluateLeagueSeason`（动态主客对完备校验）+ `evaluateLeaguePhase`（4 态休赛期模型）。**阻塞**：附加赛污染致德甲/法甲永不收官（`A-S7-02`）、`abandoned` 误判终态提前收官（`A-S7-03`）、`ended_at` 永为 `null`（`A-S7-09`）、缺分布式锁（Wave 2 `A-S3-10`）。 |
| **4. 升班马 — 主源（`fd`/`bsd`）建队** | **已自动** | `ProviderTeamSyncService.sync`（`provider-team-sync.ts:138-163`）可自动为升班马创建 `teams`、`team_provider_mappings` 与 `season_teams`。 |
| **5. 升班马 — 副源（`of`/`5d`/`sp`）映射** | **纯手工（Q5 门禁缺口）** | `provider-cross-source.ts:51-55, 84-99` 仅在进程内存 `Set` 打一次 `[team_mapping_missing]` 日志（不写 `anomalies` 告警表）即静默跳过；`scripts/providers-map-teams.mjs` 仅只读输出 JSON 不写库。未人工补映射前，升班马比赛丧失双源核验与夜间对账。 |
| **6. 升班马 — 中文队名展示** | **纯手工 + 需重发小程序（Q5 门禁缺口）** | `miniprogram/utils/team-registry.js` 硬编码 112 支老队快照 UUID（交叉引用 Wave 2 `D-S2-03`）。升班马自动建队生成新随机 UUID 必然失配，前端静默回退英文原名，必须人工改代码重新提审发版小程序。 |
| **7. 升班马 — 队徽展示** | **纯手工 + 需重发小程序（Q5 门禁缺口）** | `miniprogram/utils/logo-registry.js` 强绑定包内静态 PNG（`../../assets/logos/teams/...`），升班马必落占位图，必须人工补图改映射表并重新发版小程序。 |
| **8. 联赛赛季与平台等级赛季隔离** | **已自动合规（仅 1 处跳转 Bug）** | `PersonalLeagueSummaryService` 严格仅按 `(league_id, season_id)` 聚合 `matches`+`predictions`，零触碰 `UserSeasonStats`；仅休赛期卡片跳赛季榜传参破坏回退（`A-S7-05`）。 |

### S7.2 表 A：确定性工程与逻辑缺陷

| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|
| **A-S7-01** | **P0** | `src/application/provider-cross-source.ts:51-55, 84-99`<br>`src/application/provider-full-schedule.ts:66`<br>`src/application/provider-sync-service.ts:71`<br>`miniprogram/utils/team-registry.js`<br>`miniprogram/utils/logo-registry.js` | **Q5 自动换季门禁未闭环：跨季赛程探测缺失，且升班马副源映射/中文队名/队徽全依赖人工与重发小程序**：<br>1) 每年 6 月中旬英超/德甲公布新赛季赛程时，全量/未来同步仅查 `activeLeagueSeason`（要等到 7/1 00:00 UTC 才拉新季），跨季空窗期无法自动切入 `between_seasons` 倒计时；7/1 或 1/1 后亦不再发现旧季新增补赛；<br>2) 升班马无副源自动关联与 `anomalies` 告警入库；<br>3) 中文队名与队徽强绑小程序包内硬编码 UUID 静态表与本地 PNG，自动换季后升班马必现英文名与空白占位徽，必须发版小程序才能修复。 | 1) 全量/未来赛程同步在赛季末/年初窗口同时探测相邻赛季（`nextSeason` 提前探测 + 未收官 `previousSeason` 补赛保护）；<br>2) 副源球队缺映射持久化写入非阻塞 `anomalies` 告警并提供可落库的半自动/自动映射命令；<br>3) 队名中文映射与队徽元数据下沉至服务端 `teams` 集合（由接口返回 `name_zh`/`logo_url`，小程序静态表仅作兜底缓存），消除换季必须发版小程序的硬耦合。 |
| **A-S7-02** | **P1** | `src/provider/football-data-adapter.ts:98-105, 125-139`<br>`src/domain/league-season-status.ts:45-54` | **德甲/法甲未过滤 `RELEGATION` 附加赛，第 19 支球队污染 `season_teams` 致常规赛永久卡死无法自动收官**：`FootballDataAdapter.fetchSeasonFixtures` 请求 `competitions/{code}/matches?season={ref}` 未限定 `stage=REGULAR_SEASON`，`fetchTeams` 又从全部返回场次提取球队写入 `season_teams`。一旦包含升降级附加赛，第 19 支次级联赛球队入表，`evaluateLeagueSeason` 按 19 队要求 342 场对阵（实际仅 306 场），德甲/法甲永久停在 `schedule_status: "partial", completion_status: "open"`。 | 在 `FootballDataAdapter` 过滤 `stage === "REGULAR_SEASON"`（参考 `BsdAdapter` `src/provider/bsd-adapter.ts:127`）或在查询参数传 `stage: "REGULAR_SEASON"`。 |
| **A-S7-03** | **P1** | `src/domain/league-season-status.ts:5-13, 63-64` | **`abandoned`（腰斩）与无正规比分的 `finished` 场次被视为终态，导致联赛提前误收官（违反 Q8 收官规范）**：第 63 行将 `["finished", "cancelled", "abandoned"]` 全当终态，且 `StatusMatchInput` 未传 `regular_home_score`/`regular_away_score`。一旦某场腰斩（后续可能择日重赛或官方裁决）或 `finished` 尚无比分，系统即错误宣告整季 `completed`。 | 从终态白名单移除 `"abandoned"`；在 `StatusMatchInput` 传入 `regular_home_score`/`regular_away_score`，仅 `cancelled` 或“带非空常规比分的 `finished`”视为终态。 |
| **A-S7-04** | **P1** | `src/infrastructure/cloudbase-app-repository.ts:556-580` | **生产仓储 `findByUserAndCanonicalMatchIds` 按 `canonical_match_id` 去重静默吞掉重复预测，令 `data_conflict` 检测失效**：第 559、570、576 行用 `Map<canonical_match_id, Prediction>` 收集结果，若同一 `(user_id, canonical_match_id)` 存在 2 条脏预测（如历史未迁移记录），后一条静默覆盖前一条；上层 `summarizePersonalLeague:101-103` 永远看不到 `size !== length`，不会返回 `reason: "data_conflict"`，而单测使用的 `InMemoryRepository:1071-1076` 返回全量数组掩盖了此缺陷。 | 改为按 `prediction.prediction_id` 索引 `selected`，另用 `seenCanonical = new Set<string>()` 计算 `missing` 回退查询；补充 `CloudBaseAppRepository` 重复预测契约测试。 |
| **A-S7-05** | **P1** | `miniprogram/pages/matches/matches.js:299-305`<br>`miniprogram/pages/rankings/rankings.js:219-234, 681-691` | **休赛期卡片“查看赛季榜”传 `levelSeasonId` 破坏 S5 空窗期自动回退上季终榜**：`matches.js:300-303` 写入 `pending_ranking_target = { board: "season", levelSeasonId: currentSeasonId(...) }`；`rankings.js:226` 据此设置 `this.explicitTargetSeasonId`，导致第 687 行 `this.explicitTargetSeasonId == null` 为 `false`，彻底禁用了 7/1–8 月中旬新等级赛季 0 人时自动回退展示上赛季终榜的机制，用户点击后落入 0 人空榜。 | `matches.js:300-303` 仅写入 `{ board: "season" }`（省略 `levelSeasonId`），交由 `rankings.js` 保持 `explicitTargetSeasonId = null` 正常触发 S5 自动回退。 |
| **A-S7-06** | **P1** | `miniprogram/pages/matches/matches.js:367-388`<br>`miniprogram/pages/matches/matches.wxml:36-52` | **游客访问休赛期联赛必显“小结暂时加载失败，重试”报错，死循环不可恢复**：`GET /v1/leagues/status` 为公开接口，游客进入已收官联赛（如休赛期中超）后，`loadEmptyStateFollowup` 立即展示休赛期卡片并调用需登录的 `getMyLeagueSummary`；服务端返回 `401 UNAUTHORIZED`，第 380 行将所有非 200 均置为 `summaryState: "error"`，向所有游客展示损坏的报错与无效重试按钮。 | 单独识别 `401`（及 `409 USER_DELETED`）落入 `summaryState: "guest"`（提示“登录后查看本赛季个人小结”并引导登录），不再误报加载失败。 |
| **A-S7-07** | **P1** | `src/application/league-season-maintenance.ts:21-25`<br>`src/runtime/scheduled-jobs.ts:971-976` | **`LeagueSeasonMaintenanceService.run` 对五大联赛重复 5 次全季 `findBySeason` 扫描，且在每次 `periodic`/`all` tick 无门控无条件执行**：第 25 行在 6 联赛循环内调用 `matches.findBySeason(seasonId)` 再内存过滤 `league_id`，五大联赛共享 `2026_2027` 导致单次执行重复扫描全表 5 次（~8,750 行读）；且 `scheduled-jobs.ts:973` 未接入 `planDuePeriodicJobs` 周期门控，每 15 分钟（或 `--mode=all` 每 3 分钟）无条件全扫。 | 第 25 行改为 `this.repo.matches.findByLeagueSeason(league.league_id, seasonId)`；将 `leagueSeasons.run` 纳入 `planDuePeriodicJobs` 周期门控（如每小时或结算后触发），并补分布式锁（见 Wave 2 `A-S3-10`）。 |
| **A-S7-08** | **P1** | `src/application/league-status-service.ts:17-19, 44-46` | **`GET /v1/leagues/status` 每次首页请求对 6 联赛执行无边界全历史 `matches.findByLeague` 扫描**：首页冷启动、`onShow`、切联赛、切日期、下拉刷新均触发该接口，每次全量拉取 6 联赛自上线以来所有赛季的完整 `Match` 文档（无赛季窗口限制、无字段投影、无缓存），多赛季累积后查询开销线性膨胀拖慢首页。 | 仅查询相关赛季（`league_seasons` 最近 2–3 季 ∪ `activeLeagueSeason`）的轻量字段投影，并可对 6 联赛状态增加短 TTL 内存/聚合缓存。 |
| **A-S7-09** | **P2** | `src/application/league-season-maintenance.ts:36-57` | **`LeagueSeason.ended_at` 在自动收官时从未计算写入**：第 39 行初始化 `ended_at: null`，第 50–54 行转入 `completed` 时未填充，导致 `/v1/predictions/summary` 的 `ended_at` 对所有自动收官赛季恒为 `null`。 | 转入 `completed` 时取当季有效终态比赛最晚 `finish_detected_at ?? kickoff_at` 写入 `ended_at`。 |
| **A-S7-10** | **P2** | `src/application/personal-league-summary-service.ts:21, 24-27, 39` | **`season_id` 跨年校验宽松、错误码大小写不规范、不可用 `reason` 笼统折叠**：<br>1) 第 25 行正则 `/^\d{4}_\d{4}$/` 未校验 `year2 === year1 + 1`（`2026_2030` 放行返 200 而非 422）；<br>2) 第 21 行 `notFoundError("user")` 生成小写前缀 `"user_NOT_FOUND"`；<br>3) 第 39 行将缺失赛季与未收官赛季均折叠为 `"not_available"` 而非 `"no_eligible_season"` / `"season_not_completed"`。 | 复用 `isLeagueSeasonFormatValid`；错误码规范为 `"USER_NOT_FOUND"`；细化不可用 `reason` 枚举。 |
| **A-S7-11** | **P2** | `miniprogram/utils/matches-default-league.js:5-15`<br>`miniprogram/pages/matches/matches.js:323-342` | **默认联赛选择可能误选休赛期联赛，且首次状态拉取失败后永久放弃默认切换**：`live`/`next` 遍历全部 `list` 而非 `ACTIVE_PHASES`，`between_seasons` 带异常补赛 `next_kickoff_at` 可压过开赛中联赛；且 `matches.js:341` 在 `getLeagueStatus()` 失败时仍置 `this.needsDefaultLeague = false`，后续恢复刷新永不重选默认联赛。 | `live`/`next` 限定在 `ACTIVE_PHASES` 内筛选，兜底优先 `activeLeagueIds[0]`；仅当 `statusResult?.statusCode === 200` 时才置 `this.needsDefaultLeague = false`。 |

> **交叉引用 Wave 1 & Wave 2 已登记问题（不重复计数）**：**`A-S1-04`（P1）**（`GET /v1/league-seasons` 未接入 `public_reads` 限流）、**`A-S1-06`（P1）**（`miniprogram/services/leagues.js` 漏传 `auth: "optional"` 致过期凭证阻塞游客读联赛状态）、**`A-S3-10`（P1）**（`leagueSeasons.run` 缺少分布式锁）。

### S7.3 表 B：代码与文档口径差异（含 Q8 收官口径，待拍板）

| ID | 代码位置 | 代码实际行为 | 原文档描述（含来源） | 产品裁决 |
|---|---|---|---|---|
| **D-S7-01 (Q8)** | `src/domain/types.ts:53-66`<br>`src/domain/league-season-status.ts:64-69`<br>`src/application/league-status-service.ts:7-15`<br>`src/application/personal-league-summary-service.ts:7-15` | **Q8 收官完整字段契约与重开口径**：<br>1) 存储 `LeagueSeason` 含 `schedule_status`（`uninitialized/partial/locked`）、`completion_status`（`open/completed`）、`completion_confirmed_at`（首次确认后不可变）、`ended_at`、`reopened_at`/`reopen_count`、`manual_override`；<br>2) 公开 `GET /v1/leagues/status` 返 4 态 `phase`（`in_season/break/completed/between_seasons`，14 天窗口区分 `in_season`/`break`；新季仅在首场进入 `live`/`finished` 后接管 `active_season_id`）；<br>3) **差异点**：收官后若新增未终态场次触发重开，`schedule_status` 保持 `"locked"`，仅 `completion_status` 回退 `"open"`（且 `reopen_count + 1`）。 | `PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md` §4.2（109 行）写重开时“`schedule_status` 回退 `partial`、`completion_status` 回退 `open`”。 | `[x] 认代码（确认 Q8 三层契约与重开保持 locked）`（✅ 已定：对阵已齐，仅完成态重开更准确） |
| **D-S7-02** | `src/provider/football-data-adapter.ts:98-105, 125-139` | `FootballDataAdapter` 未做 `REGULAR_SEASON` 阶段过滤。 | 文档内部冲突：`PERSONAL_LEAGUE_SUMMARY_DEV_PLAN` §2（33 行）与 `SYNC_RELIABILITY`（134 行）写“不做常规赛/附加赛隔离专项”，但前者 §9 必测用例（314 行）又明确要求“德甲/法甲包含 `RELEGATION`/`PLAYOFFS` 时适配器过滤不影响 306 场判定”。（注：不过滤会触发 `A-S7-02` 阻塞收官。） | `[x] 判为 Bug（按 §9 补 REGULAR_SEASON 过滤，同修 A-S7-02）`（✅ 已定：不过滤将永久卡死德甲/法甲收官） |
| **D-S7-03** | `miniprogram/pages/matches/matches.js:367-382` | 只要 `GET /v1/leagues/status` 返回 `phase` 为 `completed`/`between_seasons`，前端立即展示“本赛季已收官”主卡片，不等待 `GET /v1/predictions/summary` 的 `availability === "available"`。 | `PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md` §7（246、249 行）写“仅当 `availability === 'available'` 时展示‘本赛季已收官’；请求失败不能保留未经确认的收官标题”。（注：游客无权限调登录态 summary，若严格按 §7 则游客永远看不到“本赛季已收官”。） | `[x] 认代码（以公开 leagues/status 为收官主态，另修 A-S7-06 游客小结态）`（✅ 已定：保证游客可见休赛期状态） |
| **D-S7-04** | `docs/OFFSEASON_OPERATIONS_CHECKLIST__v1.0.md:15-28, 94-98` | 代码已实现 R4（`activeLeagueSeason` 自动推导）与 R6（中超 `of` 为 `result: "secondary"`），但运维清单文档仍标注二者“尚未实现 / 尚未启用”。 | 历史运维清单文档滞后于代码实现。 | `[x] 认代码（收口时更新清单）`（✅ 已定） |

### S7.4 正向合规核查确认
- **联赛个人小结（F14）严格口径隔离**：`summarizePersonalLeague` 与 `PersonalLeagueSummaryService` 仅统计目标 `(league_id, season_id)` 的 `predicted_matches`、`wdl_hits`、`exact_hits`（严格满足 `exact_hits <= wdl_hits <= predicted_matches`，`null` 命中不误计，延期/取消/腰斩预测保留在 `predicted_matches` 中，修正中或未结算完正确置 `is_provisional: true`），完全不混算生涯积分或平台等级赛季积分。
- **接口安全与路由顺序正确**：`GET /v1/predictions/summary` 强制登录态、拒绝 `user_id` 未知参数、接入 `authenticated_reads` 限流，并在 `src/gateway/assemble.ts:408-421` 正确路由于 `/v1/predictions/me/:id` 之前。
- **前端 4 态休赛期模型与防竞态守卫**：已彻底移除旧版 30/120 天盲扫；`matches.js` 使用 `requestSerial`/`statusSerial`/`summarySerial` 与 `loginGeneration` 防止切联赛/切号串数据，并使用 `beijingParts` 避免 locale 依赖。

---

## 第三部分：Wave 3 测试与验证覆盖缺口汇总

1. **PostgreSQL 真库群组并发与封板并发测试完全缺失（最高优先级）**：缺少 PG 真并发下的 499 人并发加群、解散+加群/退群并发、5/20 上限并发、同用户重复加群并发（`A-S5-01`），以及 `PeriodFinalizeService` 与结算/重排并发（`A-S5-02`）、`RebuildPeriodRankingsService` 事务回滚释放锁测试（`A-S5-03`）。
2. **账号注销与群组成员联动缺测**：缺少“成员/群主注销账号 → `group_members` 与 `groups.member_count` 一致性”测试（`A-S5-05`）。
3. **小程序 WXML 模板绑定与跨页交互缺测**：现有 `rankings.*.test.mjs` 仅在 VM 中测 JS data 而不验 WXML，导致 `rankings.wxml` 忽略 `listTitle`/`listItems`/`guestBars` 且硬编码 `'历史周 · 已封榜'` 全部漏测（`A-S5-06`、`D-S5-03`、`D-S5-04`）；同时缺少休赛期卡片跳赛季榜联调测试（`A-S7-05`）、游客访问休赛期页测试（`A-S7-06`）、周一选“本周”后 `onShow` 测试（`A-S5-10`）及群组页单页栈/粘贴带空格邀请码测试（`A-S5-08`、`A-S5-09`）。
4. **S7 仓储一致性和附加赛/腰斩边界缺测**：缺少 `CloudBaseAppRepository.findByUserAndCanonicalMatchIds` 重复预测契约测试（`A-S7-04`）、`FootballDataAdapter` 含 `RELEGATION` 附加赛过滤测试（`A-S7-02`），且 `league-season-status.test.ts:24` 当前反而把 `abandoned` 允许收官写成了正向断言（固化了 `A-S7-03`）。

---

## 第四部分：产品快速裁决清单（表 B 共 10 条）

为了方便你集中拍板，以下汇总 Wave 3 的全部 10 条口径差异（每条只需回复编号 + 结论）：

1. **`D-S5-01`（Q8 首次排行周）**：`FOOTBALL_RANKING_FIRST_PERIOD_KEY`（默认 `"2026-W31"`）+ 每次返 `first_period_key`/`server_now` + 上线前默认周榜返 `200` 空列表 — 认代码纳入 Q8 正式口径？
2. **`D-S5-02`**：`GET /v1/levels/me` 返回 `b_points`/`season_points`/`exact_hits` 并展示“评估积分 X/Y、还差 Z 分”进度条 — 确认以 UX-06 覆盖 MVP §19.8/§28.1？
3. **`D-S5-03`**：周榜卡片渲染 `'历史周 · 已封榜'`（MVP §19.10.3 明确禁止“已封榜”措辞） — 判为 Bug 去掉“已封榜”，还是认代码？
4. **`D-S5-04`**：榜单页游客态用普通提示卡片（未做灰色条纹模糊占位且顶部 Tab 仍可见） — 认代码，还是判为 Bug 补灰色条纹占位？
5. **`D-S5-05`**：榜单 Tab 顺序 `week -> season -> strength -> career`（MVP 原写 `week, career, strength, season`）+ 榜单行无点击进公开主页入口 — Tab 顺序认代码还是改回？公开主页点击入口确认移入 S6 补齐？
6. **`D-S5-06`**：历史周按 `periodEndAt <= server_now` 生效（不等 `is_final`）+ `me` 增返指标 + 复用 `RANKING_TOP_LIMIT = 20` — 认代码？
7. **`D-S7-01`（Q8 收官口径）**：确认 Q8 三层收官字段契约，且收官重开时 `schedule_status` 保持 `"locked"` 仅 `completion_status` 回退 `"open"` — 认代码，还是重开同步回退 `"partial"`？
8. **`D-S7-02`**：德甲/法甲 `RELEGATION` 附加赛过滤（文档内部自相矛盾，不过滤会阻塞自动收官） — 确认判为 Bug 补 `REGULAR_SEASON` 过滤？
9. **`D-S7-03`**：休赛期主卡片仅凭公开 `leagues/status` 展示“本赛季已收官”（游客可见），不强等登录态 `summary` 的 `available` — 认代码（另修 `A-S7-06` 游客小结态）？
10. **`D-S7-04`**：更新滞后的 `OFFSEASON_OPERATIONS_CHECKLIST__v1.0.md`（同步已实现的 R4/R6 状态） — 确认收口时同步更新？
