# MVP 2.0 自动化测试缺口补齐记录 v1.0

日期：2026-10-13
依据：`docs/MVP2.0__AI_TESTING_PLAN__v1.0.md` §8.1

## 范围与结论

已为 §8.1 列出的 Provider 自动化测试缺口补充本地 Vitest 用例，并完成类型检查和全量测试。本轮全部使用固定、脱敏的内存 fixture；没有请求真实 Provider API、连接 cloud1、读写云端数据库或读取 `.env.cloud1.local`。

## 覆盖清单

| 缺口 | 新增覆盖 | 测试文件 |
|---|---|---|
| 5d 适配器 | 分页、24 小时窗口、赛果/球队/联赛字段映射 | `src/provider/extended-adapters.test.ts` |
| OpenFoot 适配器 | `next_cursor` 分页、赛果与赛程状态、partial 页面拒绝、额度周期重置时间 | `src/provider/extended-adapters.test.ts` |
| sportapi.ai 适配器 | 联赛过滤、ETag 条件请求、304 时复用缓存结果 | `src/provider/extended-adapters.test.ts` |
| BSD 适配器 | `notstarted` 映射、忽略非 regular-season 赛事 | `src/provider/extended-adapters.test.ts` |
| 跨源比赛映射 | 已映射复用、球队缺映射、多个候选、英超 30 分钟与中超 5 分钟边界（含超出 1 ms） | `src/application/provider-cross-source.test.ts` |
| Provider 赛果采信 | 权威源采信、两个非权威源一致、单源等待、无最终比分、比分冲突、状态冲突及异常状态 | `src/application/provider-result-adoption.test.ts` |
| CloudBase Provider 状态 | 用量预算预留/释放、key 冷却与多实例可读、按来源/联赛/任务记录成功时间、字段契约和唯一索引 | `src/infrastructure/cloudbase-provider-state.test.ts` |
| 请求计划与轮转 | 任务优先级、最久未成功联赛优先、额度不可用时回退、FD 双 key 独立分钟额度与冷却 | `src/provider/strategy-key-pool.test.ts` |
| 5d live 请求 | 两个联赛并发读取时共享一次全联赛 live 请求，并按联赛过滤结果 | `src/provider/strategy-key-pool.test.ts` |
| Timer 赛程调度 | 每个 Timer 节拍中，赛程与全赛季校验任务各只派发一个排在最前的到期联赛 | `src/cloud-function/runtime.test.ts` |
| Provider 诊断数据 | 五源额度响应头、联赛角色/最近成功时间/请求数；sportapi 403 或错误码 1010 的 Cloudflare 标记 | `src/provider/strategy-key-pool.test.ts`、`src/cloud-function/runtime.test.ts` |
| 球队映射命令 | 已确认、待复核、歧义、未匹配候选；确认映射优先；输入 fixture 不被改写 | `src/scripts/provider-tools.test.ts` |
| 队徽检查命令 | 别名命中与缺图报告；输入 fixture 不被改写 | `src/scripts/provider-tools.test.ts` |
| CloudBase schema 命令 | 检查 Provider 集合和唯一索引出现在生成输出中 | `src/scripts/provider-tools.test.ts` |

CloudBase 字段由仓储 fixture 对照 `COLLECTION_DEFINITIONS` 检查；`npm run cloudbase:schema` 当前输出集合名和索引清单，不输出字段定义，因此字段契约检查直接针对 schema 定义完成。

## 测试中发现并处理的问题

- `logos:check` 原先通过 `require()` 加载小程序的 CommonJS `.js` 文件，但仓库声明为 ESM；当前 Node 下命令会因 `module is not defined` 失败。脚本改为在隔离的 VM 上加载该静态 CommonJS 注册表，新测试会执行命令并检查报告。
- CloudBase 测试内存数据库原先把 `update` 实现成整条文档替换，与 `CloudBaseDb.update` 的字段合并契约不符。测试夹具已调整为合并更新，并验证 `created_at` 在后续更新时保留。
- 其余失败断言经对照实现和边界规则校准：OpenFoot 的 `2026-10` 额度周期于 2026-11-01 重置；设置 60 分钟间隔时，近期成功的联赛不属于到期联赛；FD 测试额度来自 fixture 配置的日上限。

## 验证结果

- `npm run typecheck`：通过。
- `npm test`：通过；170 个测试文件、1592 项测试通过，0 失败。包含全部 20 个小程序测试文件。
- 新增的六个专项测试文件：37 项用例通过；Timer/诊断测试补充后已再次纳入上述全量测试。
- `npm run cloudbase:schema -- --namespace football_test`：由测试执行并检查 Provider 集合及唯一索引输出，通过。
- `git diff --check`：通过。

## 仍需分别验收

测试代码存在且本地执行通过，只证明 mock/fixture 场景符合断言。cloud1 的集合与索引实况、跨云函数实例的实际计数与节奏、真实 Provider 响应头和 sportapi 出口访问、比赛日比分延迟仍未由本轮验证；这些仍按测试计划标记为云端或真实比赛环境验收项。
