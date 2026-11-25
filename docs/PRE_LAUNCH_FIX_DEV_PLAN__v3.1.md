# 上线前复核修复可执行开发文档（精简版 v3.1）

> 给执行 AI：本文为精简执行版。目标是在最小改动下**跑通功能、保证逻辑不出错**，忽略防御性/安全性加固，不做多余测试与流程仪式。直接按 Slice 1 → Slice 2 → 一次验证 执行；不要自动提交或推送。

- **版本**：v3.1（精简版），2026-11-24。
- **状态**：待开发；本文交付不代表两组修复已经完成。
- **目标**：修复个人页普通请求失败后的身份误清空及最近预测恢复问题；修复群列表刷新提前解除创建锁、旧请求覆盖新结果的问题。
- **架构**：沿用小程序页面现有状态、请求序号与服务接口。仅调整错误恢复边界与请求序号/锁生命周期。
- **技术栈**：微信小程序原生 JavaScript、CommonJS 页面模块、Vitest 2.x、Node.js；本轮不改后端、TS 代码、API、数据库及依赖。
- **仓库**：本机 `/home/football`；所有相对路径、命令均以仓库根目录为基准。
- **来源**：基于 [v3.0](PRE_LAUNCH_FIX_DEV_PLAN__v3.0.md) 落地工作区复核整理，已剔除第 4 节误报/暂缓项及不必要的测试与门禁流程。

---

## 0. 任务边界与工作区纪律

### 0.1 本轮唯一开发范围

| ID | 切片 | 用户可见问题 | 实现文件 | 测试文件 |
| --- | --- | --- | --- | --- |
| P31-01 | Slice 1 | 普通错误误清身份；重试后最近预测可能永久 loading 或停在错误态 | `miniprogram/pages/profile/profile.js` | `miniprogram/pages/profile/profile.recent-identity.test.mjs` |
| G31-01 | Slice 2 | 创建未返回时刷新列表会提前解锁，可再次发创建请求 | `miniprogram/pages/groups/groups.js` | `miniprogram/pages/groups/groups.test.mjs` |
| G31-02 | Slice 2 | 旧列表请求晚到的成功、非 200 或异常覆盖新结果 | 同上 | 同上 |

**仅修改以上 4 个文件。** 为注入测试 mock 可小幅扩展已有测试 helper；不引入新依赖、不改 WXML/WXSS、群详情、个人页收藏队/建群逻辑、后端、OpenAPI、数据库、认证或限流策略。

### 0.2 工作区与生产红线

1. **当前本地脏工作区就是开发基线**：保留现有修改与未跟踪文件，禁止 `git reset/stash/restore/checkout`，禁止自动 `git add/commit/push`。
2. **`dist/` 是本机线上服务运行产物**：禁止运行 `npm run build`、`npm run vps:db`、`npm run vps:admin`、`npm run jobs:tick`、部署及 preflight 脚本。
3. **不重启服务、不写线上库、不跑真实请求**：全部使用已有测试 mock。
4. **不新增防御性/安全性改造**：第 4 节已撤回/暂缓项不予实施。

### 0.3 现有测试基线

第 5 节的小程序相关测试命令已实测通过：**7 个文件、65 项测试全部通过**（耗时约 1 秒）。本轮只需在原有 65 项用例基础上补充关键逻辑回归测试。

---

## 1. Slice 1：个人页普通错误与最近预测恢复（P31-01）

### 1.1 根因定位

`miniprogram/pages/profile/profile.js`：

- `clearIdentityPatch`（23–32 行）会清空 `userId/nickname/recentPredictions`、递增 `recentRequestSerial`，并将 `recentState` 设为 `loading`。
- `applyErrorState`（34–84 行）在 `429`、`500` 及其他非 `200` 响应时也调用了 `clearIdentityPatch`；`loadPage` 的群列表分页异常出口（184–191 行）和 `.catch()`（262–269 行）也调用了它。
- `onShow` 同时启动 `loadPage()` 和 `loadRecentPredictions()`，普通错误递增序号会导致仍在途的最近预测结果被作废。
- `onRetry`（457–462 行）只调用 `loadPage()`，未重新拉取最近预测（且 `profile.wxml` 中最近预测卡片本身无独立重试按钮）。

### 1.2 核心行为要求

| 场景 | 必须保证的逻辑 |
| --- | --- |
| `401 + UNAUTHORIZED` / `409 + USER_DELETED` / `404 + USER_NOT_FOUND` | 保留既有身份失效状态，继续调用 `clearIdentityPatch` 清空身份与最近预测，并作废在途最近预测 |
| 登录 generation 变化 | 保持现有 `onShow` 立即清空上个账号数据的逻辑，旧账号晚到响应不覆盖新账号 |
| 普通错误（`429`、`500`、其他非 `200`、分页异常、Promise `catch`） | 保留既有 `state` 和 `errorMessage`，**不得**调用 `clearIdentityPatch`（不清身份、不清已有预测、不递增 `recentRequestSerial`） |
| 有效重试 `onRetry` | 同时触发 `loadPage()` 与 `loadRecentPredictions()`（`rateLimited` 状态下仍保持不发请求）；可返回组合 Promise 便于测试等待 |

### 1.3 改动步骤与精简验收用例

1. 在 `profile.js` 中：
   - `applyErrorState` 仅在 `401`/`409`/`404` 身份错误分支保留 `clearIdentityPatch`，去掉 `429`、`500`、其他非 `200` 分支的 `...clearIdentityPatch(page)`；
   - `loadPage` 的分页异常出口与 `.catch()` 去掉 `...clearIdentityPatch(this)`；
   - `onRetry` 在非 `rateLimited` 时同时调用 `this.loadPage()` 和 `this.loadRecentPredictions()`（建议 `return Promise.all([this.loadPage(), this.loadRecentPredictions()])`）。
2. 在 `profile.recent-identity.test.mjs` 扩展 `loadProfilePage` helper 以支持注入 `getMyLevels` / `listMyGroups` mock，并补充以下 **4 个核心回归用例**（原有 `401` 和换号隔离用例保留）：
   - **P-1（普通错误不清身份与预测）**：先加载 A 身份和预测，再分别触发 `loadPage` 返回 500、429、Promise reject、分页错误，确认状态/文案正确，且 `userId/nickname/recentPredictions` 不被清空、`recentRequestSerial` 不递增。
   - **P-2（并发普通错误不作废最近预测）**：`onShow` 启动 `loadRecentPredictions` deferred；主请求先返回 500；随后最近预测成功，确认 `recentState` 正常落到 `ready`（主页面仍保持 `error`）。
   - **P-3（`onRetry` 恢复主页面与最近预测）**：首次加载 500 后调用 `onRetry`，覆盖「最近预测一起成功落到 `ready`」和「主请求成功但最近预测失败落到 `error`（不卡 `loading`）」两种结果。
   - **P-4（`rateLimited` 重试不发请求）**：`state === "rateLimited"` 时调用 `onRetry`，所有加载服务调用次数不增加。

---

## 2. Slice 2：群列表创建锁与请求顺序（G31-01 / G31-02）

### 2.1 根因定位

`miniprogram/pages/groups/groups.js`：

- `loadGroups` 开始时（36 行）与 `.catch()`（62 行）都会写入 `loadingAction: false`。当 `onCreateTap` 发起创建尚未返回时，若触发 `onShow` / `loadGroups`，会提前解除创建锁，导致用户可重复触发 `createGroup`。
- `loadGroups` 没有请求序号校验，并发请求的旧响应（成功、非 200 或 reject）晚到时会覆盖最新列表与状态。

### 2.2 核心行为要求

1. `loadingAction` 仅由 `onCreateTap` 负责置 `true` 和复位 `false`（成功、业务失败、reject 均复位）；**`loadGroups` 任何出口均不得修改 `loadingAction`**。
2. `loadGroups` 每次发起递增实例上的 `groupsRequestSerial`，在 `.then()` 和 `.catch()` 开头检查序号，仅最新请求可写入页面状态、列表、数量与错误文案。
3. 保留现有上限（加入 20、拥有 5）、创建失败文案及导航参数。

### 2.3 改动步骤与精简验收用例

1. 在 `groups.js` 中：
   - 从 `loadGroups` 开头与 `.catch()` 移除 `loadingAction: false`；
   - 增加 `groupsRequestSerial: 0`，`loadGroups` 保存本地 `requestSerial`，在 `.then()` 第一行和 `.catch()` 第一行校验 `if (this.groupsRequestSerial !== requestSerial) return;`。
2. 在 `groups.test.mjs` 补充以下 **3 个核心回归用例**（原有创建成功、reject 复位、第二次正常建群用例保留）：
   - **G-1（列表刷新不提前解除创建锁）**：`createGroup` deferred 未返回时，再次触发 `onShow`（分别覆盖列表成功和列表失败/reject），`loadingAction` 保持 `true`，再次调用 `onCreateTap` 仍只发 1 次 `createGroup`。
   - **G-2（创建业务失败也复位创建锁）**：`createGroup` 返回非 201（如 409 `GROUP_OWNED_LIMIT_REACHED` 或 500）时，`loadingAction` 复位为 `false` 且展示对应错误文案。
   - **G-3（列表请求乱序不覆盖新结果）**：使用不同 `group_id` / `ownedCount` fixture 验证「A 先发、B 后发先成功，A 随后成功或 reject 不覆盖 B」与「A 先发、B 后发先失败，A 随后成功不覆盖 B」，并确认最新请求失败后 `onRetry` 可恢复。

---

## 3. 已撤回与暂缓事项（不在本轮范围）

| 原审查意见 | 独立调查结果 | 本轮处理 |
| --- | --- | --- |
| 收藏队换队残留旧名字、查不到队时显示旧队 | 完整调用入口已先按新队设置名字和图标；见 `profile.js:215–235` | 撤回，不改 |
| 延期/腰斩且 voided 时仍显示积分 | 未建立正常触发链；取消场次已有不计分处理。见 `src/domain/settlement-state-machine.ts:60` | 撤回，不改 |
| 分享卡批量 canonical 键不一致 | 读写保持同一身份且有回退。见 `src/application/share-card.ts:150–174`、`src/infrastructure/document-codec.ts:102` | 误报，撤回 |
| 历史 SQL 对 canonical NULL 直接比较 | 生成器已生成 `COALESCE(canonical_match_id, match_id)`。见 `src/infrastructure/postgres-schema.ts:31–39` | 误报，撤回 |
| 当前等级季直接对账会用缺失事实误报 | 读取当前＋上一竞技赛季，未建立误报触发链。见 `src/domain/time.ts:192`、`src/domain/config.ts:427` | 不改 |
| CloudBase 有旧 false 快照时忽略较新缺 is_final 快照 | 正常写入要求布尔值；当时运行库统计 2414 条均无缺失 `is_final`。见 `src/infrastructure/cloudbase-app-repository.ts:1071` | 暂缓，不改 |
| match-identity 批量 lenient 成环丢 lastReachable | 正常写入约束禁止该环；属异常脏数据防御。见 `src/application/match-identity.ts:71`、`src/domain/invariants.ts:317` | 暂缓，不改 |
| 群详情加请求序号 | `detail.js` 仅在 `onLoad`/`onRetry` 加载，无 `onShow` 重叠路径 | 暂缓，不改 |

---

## 4. 验证命令与完成条件（精简门禁）

本轮仅修改小程序两个独立页面文件，**不碰 `src/` 下任何 TypeScript 代码与后端逻辑**；且 `tsconfig.json`、`tsconfig.build.json`、`tsconfig.cloudfunction.json` 均不包含 `miniprogram/`，因此**无需重复运行 `tsc --noEmit`，也无需按切片反复跑全量测试**。

两片全部改完后，执行以下 **1 次** 集中验证即可：

```bash
cd /home/football
./node_modules/.bin/vitest run miniprogram/pages/profile/profile.recent-identity.test.mjs miniprogram/pages/profile/profile.season-count.test.mjs miniprogram/pages/profile/profile.team-logo.test.mjs miniprogram/pages/groups/groups.test.mjs miniprogram/pages/groups/detail.test.mjs miniprogram/custom-tab-bar/index.test.mjs miniprogram/pages/compliance.workflow.test.mjs
git diff --check -- miniprogram/pages/profile miniprogram/pages/groups
```

- **通过条件**：上述 7 个小程序测试文件全部通过（退出码 0），`git diff --check` 无输出且退出码 0。
- **关于全量测试**：因本次未修改后端、公共模块及数据库代码，默认不重复跑全量 `vitest run`（v3.0 已有全量记录）；仅当你在改动过程中意外修改了公共工具或希望最终兜底时，再额外补跑 1 次全量测试。
- **关于 v3.0 遗留项**：`EXPLAIN ANALYZE` 专项验证、真机/微信开发者工具人工验证、首页迁移检查 `.brand-name` / `.mark-ball` 既有失败属于 v3.0 既知遗留，不纳入本轮验收阻塞。

---

## 5. 可直接转交执行 AI 的任务文本

```text
请在 /home/football 工作区按精简版 docs/PRE_LAUNCH_FIX_DEV_PLAN__v3.1.md 实施修复：
1. 只修改 miniprogram/pages/profile/profile.js、profile.recent-identity.test.mjs、miniprogram/pages/groups/groups.js、groups.test.mjs 这 4 个文件。
2. Slice 1（profile.js）：仅 401/409/404 身份错误保留 clearIdentityPatch，去掉普通错误（429/500/其他非200/分页异常/catch）的清身份副作用；onRetry 补上 this.loadRecentPredictions()（rateLimited 保持不发请求）。在 profile.recent-identity.test.mjs 补 P-1~P-4 用例。
3. Slice 2（groups.js）：从 loadGroups 移除对 loadingAction 的修改；为 loadGroups 增加 groupsRequestSerial，在 then 和 catch 开头校验序号。在 groups.test.mjs 补 G-1~G-3 用例。
4. 保留当前脏工作区，禁止 git reset/stash/restore/checkout、自动 commit/push、运行 build/部署/写线上库；不实施第 3 节已撤回/暂缓项。
5. 改完后仅运行一次文档第 4 节的 7 个小程序测试文件及 git diff --check（无需跑 tsc 和后端全量测试），确认全部通过后汇报修改内容与测试结果。
```
