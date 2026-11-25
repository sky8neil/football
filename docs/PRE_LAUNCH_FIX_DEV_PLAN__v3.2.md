# 上线前复核修复可执行开发文档（AI 落地指南 v3.2）

> 给执行 AI：本文基于 [v3.0](PRE_LAUNCH_FIX_DEV_PLAN__v3.0.md) 落地代码复审整理，仅包含经调用链核实的 **6 项功能性、逻辑性与长运行/并发隐患**。按 Slice 1 → Slice 2 → Slice 3 → 一次集中验证 执行；聚焦跑通功能与逻辑正确，不做无关防御性重构与多余全量测试，不要自动提交或推送。

- **版本**：v3.2，2026-11-24。
- **状态**：待开发；本文交付不代表修复已完成。
- **目标**：修复活跃赛季常规快照全年不清理、长耗时结算/周评/改判下锁租约按固定时间计算导致提前过期、同周并发结算撞锁直接中断、失效群切回全站榜跨周锁死旧周，以及换季临时窗口重复查榜问题。
- **技术栈**：TypeScript（`src/`）、微信小程序原生 JavaScript（`miniprogram/`）、Vitest 2.x。
- **仓库**：本机 `/home/football`；所有相对路径、命令均以仓库根目录为基准。

---

## 0. 任务边界与工作区纪律

### 0.1 本轮开发范围

| ID | 级别 | 切片 | 问题摘要 | 实现文件 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| `#1` | P1 | Slice 1 | 清理任务无差别跳过未出终榜赛季，导致当前活跃赛季常规快照全年无限膨胀 | `src/application/maintenance-cleanup.ts` | `src/application/maintenance-cleanup.test.ts` |
| `#6` | P2 | Slice 1 | 换季后终榜未出期间显式查询上赛季榜重复查 2 次 DB | `src/application/ranking-query.ts` | `src/application/ranking-query.test.ts` |
| `#2` | P1 | Slice 2 | `rebuildGlobalRanks` 用固定 `now` 计算锁租约，长耗时结算后周期锁出生即过期 | `src/application/settlement-item-application-service.ts` | `src/application/settlement-item-application-service.test.ts` |
| `#3` | P2 | Slice 2 | `rebuildGlobalRanks` 撞锁未做短退避重试，同周多场同时完场直接报错中断 | 同上（及适配假时钟单测） | 同上、`src/application/first-settlement-service.test.ts` |
| `#4` | P2 | Slice 2 | 长耗时周评与大改判单中，内层锁租约基于固定 `serverNow` 且单改判单循环内无续租 | `src/application/weekly-level-eval.ts`、`src/application/level-correction-reeval.ts` | `src/application/weekly-level-eval.test.ts`、`src/application/level-correction-reeval.test.ts` |
| `#5` | P2 | Slice 3 | 排行榜从失效群切回全站榜未复位 `userSelectedWeek`，跨周后停在旧周 | `miniprogram/pages/rankings/rankings.js` | `miniprogram/pages/rankings/rankings.group-invalid.test.mjs` |

### 0.2 工作区与生产红线

1. **当前本地脏工作区就是开发基线**：保留所有已有改动与未跟踪文件；禁止 `git reset/stash/restore/checkout`，禁止自动 `git add/commit/push`。
2. **`dist/` 是本机线上服务运行产物**：禁止运行 `npm run build`、`npm run vps:db`、`npm run vps:admin`、`npm run jobs:tick`、部署及 preflight 脚本；类型检查必须带 `--noEmit`。
3. **不重启服务、不写线上库、不依赖真实 PG 实例**：全部使用已有单测 mock / `InMemoryRepository`。

---

## 1. Slice 1：活跃赛季快照清理与榜单冗余查询消除（`#1`、`#6`）

### 1.1 修复 `#1`：放开当前活跃赛季常规快照的 24 版本滚动清理

- **位置**：`src/application/maintenance-cleanup.ts:259-313`（`cleanupBoardSnapshots`）
- **根因**：
  - 第 296 行 `if (!finalSeasonIds.has(seasonId)) continue;` 跳过所有未生成 `is_final: true` 终榜的赛季。
  - 当前活跃赛季在整个赛季（长达 365 天）内必然没有 `is_final: true` 终榜，导致其 `is_final: false` 常规快照全年 0 清理，按 24 版/天 × 365 天 = 8,760 个版本无限膨胀（并导致 CloudBase `distinctQuery` 很快触及 10 万行截断上限）。
  - 实际上，第 297–308 行已经按 `level_season_id` 分组并各自保留最新 `keepVersions`（24 份）常规快照，按赛季独立裁剪本身就不会删空 7 月初尚未出终榜的上赛季（`findLatestBySeason` 与 `available_level_seasons` 仅依赖最新快照，保留 24 份已完全安全）。
- **改动方案**：
  1. 在 `cleanupBoardSnapshots`（`src/application/maintenance-cleanup.ts:259-313`）移除 `finalSeasonIds` 查询和第 296 行 `if (!finalSeasonIds.has(seasonId)) continue;`，让所有 `level_season_id` 统一按各自最近 `keepVersions = 24` 份进行滚动清理（注释同步更新说明）。
  2. 更新 `src/application/maintenance-cleanup.test.ts:195-252`：
     - 将原用例中断言未终榜 `oldSeason` 保留 30 份、`currentSeason` 保留 25 份，改为均按各自最近 **24 份** 滚动保留（验证 `oldSeason` 删掉最旧 6 份后仍剩最新 24 份不误删空、`currentSeason` 删掉最旧 1 份剩 24 份、`finalizedSeason` 剩 24 份且 `finalized-head` 保留）。

### 1.2 修复 `#6`：显式查询上一赛季临时榜时复用已查询结果

- **位置**：`src/application/ranking-query.ts:722-739`（对照 L663、L668–670、L691–693）
- **根因**：第 663、668–670 行已经查出 `previousSeasonFinalVersion` 与 `previousSeasonRegularVersion` 并组装为 `previousSeasonVersion`；第 723 行仅在 `previousSeasonFinalVersion.length > 0` 时复用，导致终榜未出期间显式传 `board=season&level_season_id=<previousSeasonId>` 时落入 `else` 再次执行 `findFinalBySeason` 与 `findLatestBySeason`。
- **改动方案**：
  - 将 `src/application/ranking-query.ts:723-735` 调整为：
    ```ts
    if (selectedSeasonId === previousSeasonId) {
      selectedSeasonVersion = previousSeasonVersion;
      isProvisional =
        previousSeasonFinalVersion.length === 0 &&
        selectedSeasonVersion.some((snapshot) => snapshot.snapshot_kind !== "head");
    } else {
      const finalVersion = await this.repo.boardSnapshots.findFinalBySeason(selectedSeasonId);
      selectedSeasonVersion = finalVersion.length > 0 ? finalVersion : [];
    }
    ```
  - 在 `src/application/ranking-query.test.ts` 补充 1 个用例：上赛季无终榜、显式传 `board=season&level_season_id=<previousSeasonId>` 时，返回 `is_provisional: true` 且 `findFinalBySeason(previousSeasonId)`、`findLatestBySeason(previousSeasonId)` 各仅调用 1 次。

---

## 2. Slice 2：长耗时锁租约与并发短退避（`#2`、`#3`、`#4`）

### 2.1 修复 `#2` 与 `#3`：`rebuildGlobalRanks` 墙钟锁租约与有界短退避

- **位置**：`src/application/settlement-item-application-service.ts:255-293`
- **根因**：
  1. 第 264 行 `const leaseUntil = new Date(now.getTime() + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000);` 使用入口传入的 `serverNow`（单场结算启动时间），而仓储 `jobLocks.acquire` 按 `Date.now()` 判过期。当热门比赛 `ApplyItems` 耗时超过 10 分钟后进入 `RebuildRanks` 时，周期排名锁写入即过期，并发结算可同时写 `global_rank`。
  2. 第 265–270 行撞锁即抛 `RANKING_REBUILD_ALREADY_RUNNING`，同周多场同时完场并发结算时易直接中断 `Finalize`。
- **改动方案**：
  1. 在 `rebuildGlobalRanks` 与 `rebuildSettlementWeekRanks` 增加可选参数 `options?: { retryDelaysMs?: readonly number[] }`（默认 `[50, 100, 200]`），仅用单次 `acquire` 包装短退避循环：
     - 每次尝试获取锁时重新计算租约：
       ```ts
       const leaseUntil = new Date(
         Math.max(now.getTime(), Date.now()) + FIXED_CONFIG_V1.JOB_LEASE_MINUTES * 60 * 1000,
       );
       ```
     - 若 `acquire` 返回 `false` 且仍有剩余退避步数，等待对应 `delayMs` 后重试；全部重试仍失败则抛 `conflictError("RANKING_REBUILD_ALREADY_RUNNING", ...)`。
  2. **假时钟单测兼容提醒（关键）**：
     - `src/application/first-settlement-service.test.ts:40` 开启了 `vi.useFakeTimers({ now: NOW })`，第 1151–1167 行测试 `"周榜锁冲突保留已入账积分，下一次定时任务仅补齐榜单和 finalize"` 直接调用 `new SettlementOrchestrationService(repo).startFirst(...)` 并期待抛 `RANKING_REBUILD_ALREADY_RUNNING`。
     - 若默认退避等待 `setTimeout`，假时钟测试会因未推进计时器而卡住超时。请在 `first-settlement-service.test.ts:1160` 改为先创建拒绝断言再推进假时钟（例如 `const run = expect(...).rejects.toMatchObject({ code: "RANKING_REBUILD_ALREADY_RUNNING" }); await vi.advanceTimersByTimeAsync(500); await run;`），或为编排链路透传配置。推荐直接在该测试推进假时钟，不给上层业务接口加无用测试参数。
  3. 在 `src/application/settlement-item-application-service.test.ts` 补充 2 个用例：
     - 传入过去时间 `now`（比 `Date.now()` 早 15 分钟）调用 `rebuildGlobalRanks`，验证 `acquire` 收到的 `leaseUntil > Date.now()`；
     - 第 1 次 `acquire` 返回 `false`、第 2 次返回 `true` 时，使用 `retryDelaysMs: [0, 0]` 成功完成重算并释放锁；全部返回 `false` 时抛 `RANKING_REBUILD_ALREADY_RUNNING`。

### 2.2 修复 `#4`：周评估与改判重评内层锁墙钟续租及单单循环内续租

- **位置**：
  - `src/application/weekly-level-eval.ts:465-566`
  - `src/application/level-correction-reeval.ts:192-310, 328-375, 448-464`
- **根因**：
  1. `weekly-level-eval.ts:475, 555`（`evaluateCareer` / `evaluateSeasons`）以及 `level-correction-reeval.ts:202, 372, 461` 获取内层锁时仍用固定 `changedAt` / `serverNow` 计算 `leaseUntil`，当外层任务运行超 10 分钟后新拿到的锁立即过期。
  2. `level-correction-reeval.ts:250-287`（`runForSettlementInternal` 遍历单个改判单的用户列表）没有任何锁续租；当单笔改判单用户量大、执行超 10 分钟时，`LEVEL_CORRECTION_REEVAL_LOCK_KEY` 与外层传入的 `WEEKLY_LEVEL_EVAL_LOCK_KEY`（`onStep` 只在改判单之间调用）均会超时过期。
- **改动方案**：
  1. 新增统一 helper（如 `levelLeaseDeadline(anchor: Date): Date`）：
     `new Date(Math.max(anchor.getTime(), Date.now()) + LEVEL_JOB_LEASE_MILLISECONDS)`，替换 `weekly-level-eval.ts:475, 555` 与 `level-correction-reeval.ts:202, 372, 461` 的锁截止时间计算。
  2. 在 `level-correction-reeval.ts` 为 `runForSettlementInternal` 与 `runPendingInWindow` 传入并透传 `onStep?: () => Promise<void>`：
     - 在 `runForSettlementInternal` 的 `for (const userId of users)` 循环内，参照 `weekly-level-eval.ts:404-438`（每处理 `20` 个用户或距上次续租超过 `2` 分钟）：
       1. 调用 `this.repo.jobLocks.renew(LEVEL_CORRECTION_REEVAL_LOCK_KEY, ownerId, levelLeaseDeadline(effectiveNow))`，若续租返回 `false`（或抛错）则置 `deferred = true` 并 `break` 中止循环（避免后续错误写入 `level_reeval_status: "completed"`）；
       2. 调用 `await onStep?.()` 顺带续租外层周评锁。
  3. 在 `src/application/weekly-level-eval.test.ts` 与 `src/application/level-correction-reeval.test.ts` 补充验证：
     - 传入落后当前墙钟 15 分钟的 `serverNow` 时，内层 `levelScopeLockKey` / `LEVEL_CORRECTION_REEVAL_LOCK_KEY` 的 `leaseUntil > Date.now()`；
     - 构造超过 20 个用户的改判单，验证 `runForSettlementInternal` 循环内会触发 `LEVEL_CORRECTION_REEVAL_LOCK_KEY` 续租及 `onStep` 回调，且在续租返回 `false` 时将 `outcome.kind` 置为 `"deferred"` 而不把改判单标为 `"completed"`。

---

## 3. Slice 3：排行榜切回全站榜跨周状态复位（`#5`）

### 3.1 修复 `#5`：`onSwitchToGlobal()` 复位 `userSelectedWeek`

- **位置**：`miniprogram/pages/rankings/rankings.js:810-818`
- **根因**：用户在群周榜手动切换过历史周（`this.userSelectedWeek = true`）后，因群失效点击“切回全站榜”调用 `onSwitchToGlobal()`；该方法清了 `selectedPeriodKey: null` 但漏了 `this.userSelectedWeek = false`。当前周加载完成后 `applyListResult` 会将 `selectedPeriodKey` 写回本周 key，导致下周进入 `onShow()` 时因 `this.userSelectedWeek` 仍为 `true` 而被锁定在旧周。
- **改动方案**：
  1. 在 `miniprogram/pages/rankings/rankings.js:810` 的 `onSwitchToGlobal()` 中增加 `this.userSelectedWeek = false;`（与 `onScopeTap` 第 489 行一致）。
  2. 在 `miniprogram/pages/rankings/rankings.group-invalid.test.mjs` 补充 1 个用例：在 `scope: "group"` 下调用 `onWeekChange` 选中历史周（`userSelectedWeek === true`）→ 触发群失效后调用 `onSwitchToGlobal()` → 再模拟跨周后触发 `onShow()`（第 1 次请求不带旧 `periodKey`、落入最新周），验证 `page.userSelectedWeek === false` 且 `listRankings` 入参 `periodKey` 为 `null`（不钉死旧周）。

---

## 4. 一次集中验证（精简门禁）

全部 3 个切片开发完成后，**只运行以下 1 组检查**（因修改了 `src/` 下的 `.ts` 文件，需执行 1 次 `tsc --noEmit`，不运行 `npm run build`、不连线上 PG 库、不重复跑与本轮无关的后端/小程序其他测试）：

```bash
cd /home/football
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run \
  src/application/maintenance-cleanup.test.ts \
  src/application/ranking-query.test.ts \
  src/application/settlement-item-application-service.test.ts \
  src/application/first-settlement-service.test.ts \
  src/application/weekly-level-eval.test.ts \
  src/application/level-correction-reeval.test.ts \
  miniprogram/pages/rankings/rankings.group-invalid.test.mjs
git diff --check -- src/application miniprogram/pages/rankings
```

- **通过条件**：`tsc` 无输出退出码 0；上述 7 个测试文件全部通过，退出码 0；`git diff --check` 无输出退出码 0。

---

## 5. 可直接转交执行 AI 的任务文本

```text
请在 /home/football 工作区实施 docs/PRE_LAUNCH_FIX_DEV_PLAN__v3.2.md：
1. 按 Slice 1（#1 放开活跃赛季 24 版本清理、#6 复用上赛季快照查询）→ Slice 2（#2/#3 rebuildGlobalRanks 墙钟锁租约与短退避、#4 周评/改判内层锁墙钟租约与循环内续租）→ Slice 3（#5 rankings.js onSwitchToGlobal 复位 userSelectedWeek）顺序实施。
2. 只修改文档表格列出的实现文件与对应测试文件；注意 first-settlement-service.test.ts 使用了 vi.useFakeTimers，需按文档第 2.1 节处理假时钟推进。
3. 保留当前脏工作区，禁止 git reset/stash/restore/checkout、自动 commit/push、npm run build/部署/写线上库。
4. 全部改完后运行一次文档第 4 节的 tsc --noEmit、7 个相关测试文件及 git diff --check，确认全部通过后汇报修改摘要与测试结果。
```
