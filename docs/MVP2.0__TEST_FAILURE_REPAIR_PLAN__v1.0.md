# MVP 2.0 自动化测试基线失败与修复记录 v1.0

日期：2026-10-12  
基线日志：`/Users/neilxu/football-test-evidence/2026-10-12-baseline/tests.log`  
基线报告：`/Users/neilxu/football-test-evidence/2026-10-12-baseline/baseline-report.md`

## 基线结果

- `npm run typecheck` 失败：`src/provider/sources.ts:135` 找不到 `SUPPORTED_LEAGUES`；该处的 `entry` 也因此被报告为隐式 `any`。
- `npm test`：151 个测试文件通过，13 个测试文件失败，共 164 个文件；已收集用例 1519 通过、13 失败（1532 个）。另有 4 个测试文件因加载异常未能收集用例。
- 20 个小程序测试文件通过。
- 失败尚未修复。本表记录的是测试实际结果，不预先断定每一项都是业务代码缺陷；修复时需对照接口契约和开发计划判断应改实现还是过期的 mock / 断言。

## 类型检查与文件加载

以下 4 个文件在模块加载时因 `SUPPORTED_LEAGUES is not defined` 失败；与类型检查报错同指向 `src/provider/sources.ts`：

- `src/cloud-function/runtime.test.ts`
- `src/provider/budget.test.ts`
- `src/provider/registry.test.ts`
- `src/provider/sources.test.ts`

建议先核对 `SUPPORTED_LEAGUES` 的来源及导入，再重跑类型检查和以上 4 个测试文件，确认它们是否随加载问题一并恢复。

## 失败用例

### 赛果和 fixture 同步

- `src/application/acceptance-44-g-provider-data.test.ts`：G43 合法 FT + fulltime 预期 `applied`，实际 `failed`。
- 同文件：G50 管理员赛果与 Provider 比分冲突时，预期 `conflict`，实际 `failed`。
- `src/application/provider-fixture-sync.test.ts`：3 个用例预期 fixture 被应用，实际均为 `failed`；分别涉及 FT 赛果应用、只使用注入的 `server_now`、finished 无比分后收到合法 FT。
- `src/application/provider-sync-job.test.ts`：预期 2 项变更且 0 项失败，实际 1 项变更、1 项失败。

### Live、dispatcher 与窗口加载

- `src/application/provider-live-match.test.ts`：批次含 1 条结构非法 fixture 时，实际读取 1 条且失败 0 条；断言预期读取 2 条且失败 1 条。
- `src/application/provider-sync-dispatcher.test.ts`：runner 实际收到 `(NOW, undefined)`，断言预期只收到 `NOW`。
- `src/application/provider-window-loader.test.ts`：英超和中超两个用例均因 mock 的 mapping 仓储缺少 `findByProviderAndExternalId` 而失败。

### Provider adapter 与 Schema

- `src/provider/adapters.test.ts`：BSD 分页映射用例预期 2 条 fixture，实际返回空数组。
- `src/schema/collections.test.ts`：实际 `sync_logs.job_type` 枚举含 `provider_reconcile`，现有断言的预期枚举未包含它；需先对照规范确认契约。
- `src/schema/indexes.test.ts`：`QUERY_INDEXES.every(item => item.unique === false)` 断言失败；需核对索引定义和测试意图。

## 建议修复顺序

1. 修复或确认 `SUPPORTED_LEAGUES` 的类型导入，恢复类型检查与 4 个测试文件的模块加载。
2. 排查 Provider 同步链路中 `failed` 的具体原因，再决定修业务实现还是补齐测试 mock。
3. 修复 dispatcher、window-loader 与 live-match 的参数和 mock / 统计差异。
4. 核对 BSD 响应映射、Schema 枚举和索引约定后再调整实现或断言。
5. 修复后重新运行 `npm run typecheck` 和 `npm test`，与本文件记录的基线比较，并在本文件追加修复结果。

## 基线记录说明

基线阶段仅记录失败和建议排查顺序，未修改业务代码、测试代码或云端配置。修复与验证结果见下文。

## 修复结果

日期：2026-10-12

- 修复 `SUPPORTED_LEAGUES` 缺少运行时导入的问题，恢复 Provider 来源模块的类型检查和测试加载。
- Provider fixture 同步测试改用与赛果映射一致的 Provider，并补全 Football-Data 的联赛标识；业务判断使用注入的 `server_now`，测试同步校准对应快照数量。
- 窗口加载器将缺少 fixture ID 的数据交给后续校验和失败统计，不再静默丢弃；补齐 loader 测试所需的 mapping 仓储接口和 match ID。
- Live Match 请求遵守来源配置的最小轮询间隔；相关 Registry 测试显式关闭间隔限制，以验证请求和额度行为。
- Provider 额度的远端配额与冷却状态按 FD key 分开记录，单 key 来源按 source 记录。
- BSD adapter 测试数据按其响应契约提供常规赛 stage、扁平队名及数字轮次，并断言规范化后的轮次格式。
- Schema 测试纳入已定义的 `provider_reconcile` job type；将两个唯一索引从查询索引列表移至唯一索引列表。
- 同步测试 mock 与 dispatcher 的实际参数保持一致。

## 修复后验证

- `npm run typecheck`：通过。
- `npm test`：164 个测试文件通过，1551 项测试通过，0 失败。
- `git diff --check`：通过。
