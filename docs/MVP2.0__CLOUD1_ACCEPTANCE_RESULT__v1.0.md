# MVP 2.0 Cloud1 验收记录 v1.0

日期：2026-10-13  
环境：`cloud1-d4ga6fvm0c6d4ec01` / `ap-shanghai` / `football_test`  
函数：`api`  
状态：**未完成；预算计数修复已在云端验证，同值更新误判已在本地修复，待重新部署复验**

本记录按《MVP2.0__AI_TESTING_PLAN__v1.0.md》§8.2 执行。所有凭据值和用户身份均未写入本报告。

以下“已通过”和“未通过 / 未完成”保留首次验收记录；最新复验结论见文末。

## 已通过

| 检查项 | 结果 | 证据 |
|---|---|---|
| 本地云函数构建 | 通过 | `npm run cloudfunction:build` 成功 |
| 数据库预期结构 | 通过 | 28/28 集合存在；47 个预期索引均存在且配置匹配；集合权限均为 `ADMINONLY` |
| 缺失集合/索引补齐 | 通过 | 补齐 3 个集合及 4 个索引，复核后结构完整 |
| `api` 环境配置 | 通过 | `FOOTBALL_ENVIRONMENT=test`、CloudBase ID、namespace、Provider source/key 配置均核对；原有游标密钥保留 |
| 函数部署 | 通过 | 云端函数状态 `Active`、代码部署成功、Node.js 20.19 |
| 函数超时 | 通过 | 经用户确认设为 120 秒，云端回读为 120 秒 |
| 云端 `diag` | 通过 | CloudBase Node SDK 调用返回 HTTP 200；环境 ID 与 namespace 匹配；28/28 集合可见；读写探针和事务探针成功；诊断输出脱敏 |

`diag` 调用请求 ID：`c1bf09db-cf18-43f2-a868-7582b7f4a261`。诊断调用是服务端调用，未携带用户身份，因此 `identity_available=false`；这不影响本次环境、数据库和 Provider 配置诊断。

## 未通过 / 未完成

| 检查项 | 结果 | 观察到的证据 |
|---|---|---|
| `premier_league` 的 `future_schedule` | 未通过 | 云端 `sync_logs` 中任务仍为 `running`，`attempt_count=2`，`items_read=0`、`items_failed=0`；脱敏错误提示为 `provider budget denied`。同步未在 120 秒超时内完成 |
| 后续同步调用 | 被锁跳过 | 后两次 `premier_league` 调用均返回 `reason=lock_held`。锁记录在 `2026-10-13T07:53:38Z` 到期；没有手动清除锁 |
| Provider 预算计数 | 异常待查 | `football_test_provider_usage` 只读到 `fd` 的分钟计数器（`2026-10-13T07:43`）计数 4；本次诊断时每日和各联赛计数仍为 0。尚不能据此确认上游是否收到请求，也没有可核验的 Provider 响应或额度头 |
| 其余五个联赛 | 未执行 | 首个联赛同步未成功，不继续触发后续请求 |
| Timer 创建及至少一轮观察 | 未执行 | 在赛程同步和预算计数未通过前暂停，以免每分钟触发重复失败 |
| 五源真实响应核对 | 未完成 | 尚无可核验的本次真实 Provider 响应、额度头、回退或 `sp` 可达性证据 |
| 队徽覆盖检查 | 未执行 | `npm run logos:check` 需要规范化 Provider fixture 样本；本轮未得到可用样本 |

第一次直连 SCF 的 `diag` 因缺少 CloudBase 环境调用上下文而不作为验收结果；之后改用官方 CloudBase Node SDK 调用，`diag` 已通过。同步失败不是该直连调用造成的。

## 结论与恢复条件

第四步目前**部分完成，不能判定验收通过**。后续联赛、Timer 和五源真实响应检查仍待 Cloud1 首个联赛复验通过后继续。不要通过手动删除锁来掩盖未完成的同步任务。

## 代码修复后复验状态

本地已修复 CloudBase 更新结果读取：wx-server-sdk 将更新数放在 `stats.updated`，此前计数器适配层只读顶层 `updated`，导致分钟计数实际增加却被判为预留失败，日桶和联赛桶未执行。预算拒绝也已改为不可重试的 Provider 错误，避免同步任务在长退避等待中被云函数超时中断并遗留 `running` 日志。

上述首次云端观察是修复前结果。用户通知修复完成后，已按下述过程部署并复验；Timer 与其它联赛仍待首个联赛复验通过后执行。

## 2026-10-13 修复后 Cloud1 复验

复验版本：`bebd60b582ac42e4118e5c6c19d16a4cb71772b7`。本轮仅更新本报告，没有修改业务代码。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 本地类型检查及针对性回归 | 通过 | `npm run typecheck`；CloudBase DB、Provider state、budget、registry、sync job 共 5 文件、33 用例通过 |
| 云函数构建与部署 | 通过 | `npm run cloudfunction:build`；代码更新后状态 `Active`、`CodeResult=success`、超时保持 120 秒；构建时间 `2026-10-13T08:14:44.483Z` |
| 部署前只读检查 | 完成 | 旧锁已自然过期；旧 `running` 日志及旧计数保留；六个 Provider key 均配置，测试 namespace 正确，无 mock 身份，无 Timer |
| 修复后 `diag` | 通过 | HTTP 200；28/28 集合可见，环境、namespace、读写、事务探针均通过；SDK `4.0.2` |
| 预算计数缺陷 | 云端复验通过 | `fd` 本轮源分钟桶、日桶、英超日桶均为 4；`fd#1` 分钟桶 3、`fd#2` 分钟桶 1；不再只增加源分钟桶 |
| 球队同步 | 部分链路通过 | 英超 20 支球队和 20 条 `football_data` 球队 mapping 已写入 |
| 英超完整赛程同步 | 未通过 | 新日志误报联赛状态文档不存在并进入重试，客户端最终返回 `SERVER_TIMEOUT` / `ESOCKETTIMEDOUT`；比赛、比赛 mapping、snapshot 均为 0 |
| 云端日志查询 | 无可用结果 | CLS 查询返回 `ResourceNotFound.TopicNotExist`；本轮证据来自函数返回、数据库只读查询和诊断探针，没有开通额外日志服务 |
| 其余五联赛、Timer、五源真实响应、队徽覆盖 | 未继续 | 首个联赛仍未完成，暂不扩大同步范围 |

部署请求 ID：`c1db49c1-596b-4cec-b295-1b51b453b168`。修复后诊断调用请求 ID：`a6133c98-bec4-4ad5-a1fd-b4b34c651144`；诊断函数请求 ID：`4a2cc0e4-8a7b-4db1-ab41-9947cbe03c90`。

### 新阻塞：同值更新被误判为文档不存在

失败位置：`src/infrastructure/cloudbase-wx-db.ts:117`。当前 `update()` 直接将 `stats.updated === 0`（或顶层 `updated === 0`）解释为文档不存在。

CloudBase 在文档存在、但更新字段与已有内容完全相同时也返回更新数 0。本轮对 `football_test_diag` 临时文档进行了隔离探针：先把 `value=1` 改成 `2`，得到 `updated=1`；再次写 `value=2`，得到 `updated=0`，随后读取确认文档仍存在。探针已删除，清理成功。这一探针使用 CloudBase Node SDK，故结果字段位于顶层；云函数 wx-server-sdk 的对应字段位于 `stats.updated`。

实际触发路径：`ProviderRegistry.withRequest()`（`src/provider/registry.ts:573`）在球队请求和赛程请求后，使用同一个 `serverNow` 调用 `CloudBaseProviderLeagueStateStore.markSuccess()`（`src/infrastructure/cloudbase-provider-league-state.ts:32`）。第一次写入状态文档，后一次写入完全相同的成功时间和其它字段，触发更新数 0；DB 适配器抛出 `CloudBaseDocumentNotFoundError`。只读查询已确认该状态文档实际存在，`last_success_at=2026-10-13T08:15:58.153Z`。

新任务证据：

- 同步任务 ID：`863d8ece-28e5-4675-81c1-f15aebe74053`。
- 开始时间：`2026-10-13T08:15:58.153Z`（北京时间 16:15:58）。
- 超时后的只读结果：`status=running`、`attempt_count=2`、`items_read=0`、`items_changed=0`、`items_failed=0`、`finished_at=null`。
- `last_error_code=INTERNAL_ERROR`。
- `last_error_message=CloudBase document not found: football_test_provider_league_state/provider_league_state_fd_future_schedule_premier_league`。
- 锁到期时间：`2026-10-13T08:25:58.153Z`（北京时间 16:25:58），未手动清理。

建议交远程 AI 修复：普通文档 `update()` 遇到更新数 0 时应进一步确认文档是否存在；已存在的同值更新应正常成功，真正不存在才抛错。不要把此规则套到 `reserveCounter()`：计数器条件更新数 0 仍应表示没有成功预留。回归需覆盖嵌套/顶层返回格式下的“已有文档同值更新”和“文档确实缺失”，以及同一任务时间下连续两次 `markSuccess()`。现有 fake 对任何已存在文档都返回更新数 1，未覆盖真实云端同值更新行为。

当前继续保留失败证据；新阻塞修复后，先只读检查锁和任务状态，再从英超完整赛程开始复验。`diag` 通过、预算修复通过或球队入库均不能代替完整同步通过。

### 2026-10-13 同值更新误判的本地修复

`CloudBaseWxDb.update()` 现在仅在更新数为 0 且重新读取确认文档不存在时抛出 `CloudBaseDocumentNotFoundError`。已有文档的同值更新正常成功。此修改没有应用到 `reserveCounter()`，其条件更新数为 0 仍表示预留失败。

SDK fake 已按实际同值更新返回 0 的行为修正。嵌套 `stats.updated` 和顶层 `updated` 两种格式均覆盖：已有文档同值更新、真实缺失、同一任务时间连续两次 `markSuccess()`、计数器成功预留及额度耗尽拒绝。

本地验证：CloudBase DB、Provider state、budget、registry、sync job、future schedule 共 6 文件、40 用例通过；`npm run typecheck` 和 `npm run cloudfunction:build` 通过。本轮没有部署或调用 Cloud1；上述云端失败证据保留，英超完整赛程与后续验收仍待修复版本部署后复验。
