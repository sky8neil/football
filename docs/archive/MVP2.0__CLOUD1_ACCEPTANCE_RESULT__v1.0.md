# MVP 2.0 Cloud1 验收记录 v1.0

> **本文件为历史证据，环境已退役（2026-11-06）。** 当前测试环境为 `footballfree-d2gzh9xzve789c41a`，AppID 为 `wxc94f506820248a52`。旧环境 `cloud1-d4ga6fvm0c6d4ec01` 不再部署、不再验收；本文所有结论只对该旧环境成立，**不能直接套用到新环境**。新环境的集合/索引已可用 `npm run cloudbase:provision` 幂等补齐，体检用 `npm run cloudbase:verify`。

日期：2026-10-13  
环境：`cloud1-d4ga6fvm0c6d4ec01` / `ap-shanghai` / `football_test`  
函数：`api`  
状态：**未完成；预算计数及同值更新修复已在云端验证；英超两轮同步各有 22 次逐条失败，完整验收暂停**

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

## 2026-10-13 最新修复部署与复验（16:36 起）

用户授权部署、复验。部署版本：`5615788`。本轮未修改业务代码、未手动清锁、未创建 Timer；历史两条 `running` 日志作为旧失败证据保留。

### 部署与原缺陷验证

- `npm run cloudfunction:build` 成功，构建时间 `2026-10-13T08:36:25.632Z`。
- 云函数在北京时间 `16:36:57` 更新，读回 `Active`、`CodeResult=success`、`Timeout=120`、Node.js 20.19。部署请求 ID：`2325f88c-b1a2-4390-a791-6cb6d778ff58`。
- 部署前确认旧锁自然过期、配置仍为 test / football_test、六个 Provider key 已配置、无 mock 身份、无 Timer。未覆盖环境变量或更换游标密钥。
- 新版本同步前后 `diag` 均为 HTTP 200；28/28 集合、环境、namespace、读写及事务探针通过。同步前诊断调用 ID：`865d9631-6d1a-4f80-9565-8647443c39a5`；同步后：`e665a0f8-b354-4f3b-a143-8b56fbd3daef`。
- 两次真实同步均约 26 秒结束，`attempt_count=1`，没有再次出现预算拒绝或同值更新误判；任务锁均由程序正常释放（`lease_until=1970-01-01T00:00:00.000Z`）。原来的两个阻塞已通过本轮云端复验。

### 新阻塞：逐条失败导致赛程不完整

| 英超 `future_schedule` | 第一轮 | 第二轮（受控重跑） |
|---|---|---|
| 开始时间（北京时间） | 16:37:49 | 16:40:07 |
| 调用耗时 | 25,577 ms | 26,975 ms |
| HTTP / 同步结果 | 200 / completed | 200 / completed |
| `items_read` | 40 | 40 |
| `items_changed` | 18 | 9 |
| `items_failed` | 22 | 22 |
| `sync_logs.status` / `attempt_count` | success / 1 | success / 1 |
| `last_error_code` / `last_error_message` | null / null | null / null |
| 累计比赛 / 比赛 mapping / snapshot | 18 / 18 / 36 | 27 / 27 / 63 |
| 调用请求 ID | `6420718f-2379-4853-a246-9d58da51f5b9` | `b514b73a-ae81-4c75-9b19-198882c88a1e` |
| 同步任务 ID | `8ba800af-b06c-4205-ac13-8b46603e5514` | `bace0998-20dd-4893-bdca-faea0dfce803` |

第二轮仍有 22 次逐条失败，且新增了 9 场比赛，不能把两轮的“22”理解成相同的 22 场；缺少逐条 ID 和错误信息，无法确认失败对象。第二轮变更数以外的其它条目也不能全判失败，其中包含未变更记录。

第二轮后的只读完整性检查：20 支球队、20 条球队 mapping；27 场比赛均有主客队引用、比赛 mapping 和 snapshot，三项缺失计数均为 0；`anomalies=0`。这只证明已入库部分的一致性，不证明 40 场全部同步成功，也不足以宣称完整幂等验收通过。

预算计数：部署前 `fd` 日桶及英超日桶各 4，第一轮后各 6，第二轮后各 8。每轮源分钟桶各 2、两个 key 的分钟桶各 1，两个 key 均 healthy，未人为耗尽额度。同步后的 `diag` 中 `last_request`、远端剩余额度仍为空；本地预算计数不能代替上游额度头或其它四源的可用性证据。

队徽检查：以已入库比赛及球队 mapping 派生样本运行 `npm run logos:check -- --input <sample>`，最终涉及的 20 支英超球队全部匹配、无缺图。仅覆盖当前英超样本，不覆盖另外五个联赛。

### 诊断缺口及交接要求

`src/application/provider-sync-job.ts:274` 的逐条 `catch` 只增加 `items_failed`，不保存 fixture ID、错误码或错误消息；非抛错的 `failed/conflict` 返回也没有逐条摘要。批次结束在 `:283` 写 `status=success`，故本轮的 `success` 仅表示批次执行结束，验收必须同时看 `items_failed`。当前无法从失败计数确定根因，不能猜测是 Provider 字段、CloudBase 事务、限流或其它原因。

另尝试只读 SCF 日志查询，返回 `TotalCount=0`（请求 ID `101a92e5-f864-4fab-8fe9-0636fa8b79f1`），没有可用逐条错误；此前 CLS 缺少日志 topic 的记录仍有效，未为此扩大权限或开通资源。

交远程 AI 的下一项工作：为逐条异常和返回型失败补齐有界、脱敏的诊断信息（任务 ID、Provider fixture ID、错误类别/码、必要的错误摘要及失败阶段），保持其它 fixture 可继续执行；不得打印认证头、key、SecretKey 或完整用户身份。部署后用这些证据定位并修复实际失败原因，再复验英超完整批次和重复同步。仅补日志不等于修复了这 22 次失败。

其余五联赛、Timer、五源响应/回退/额度头仍未执行；首个联赛需先满足逐条失败已解释且不存在未解决的数据缺失，才继续扩大验收范围。完整第四步仍未通过。

## 2026-10-13 逐条失败诊断补齐与 Cloud1 状态（17:23）

### 本地诊断补齐

- `ProviderFixtureSyncJobService` 现在为逐条 `failed`、`conflict` 和抛错结果记录诊断：`sync_job_id`、Provider、fixture ID、失败阶段、结果类别、错误码/错误名/错误摘要、异常类别及关联 `match_id`。
- 诊断写入对应的 `sync_logs.failure_diagnostics`，同时随同步结果返回；云函数对手动同步和 Timer 同步都输出 `provider_fixture_failure` 结构化日志。每条文本均有长度限制并脱敏；每次最多保存 100 条，超出量写入 `failure_diagnostics_omitted`。UUID 格式的 fixture ID 保留，便于逐条定位。
- `SyncLog` 类型和 `sync_logs` 集合契约已补充这两个可选字段。
- 本地验证：`npm run typecheck`、`npm run cloudfunction:build`、`git diff --check` 均通过。本轮未运行测试套件。

### 实际失败的根因仍待云端诊断

最新可确认的旧云端记录仍是同步任务 `c202eca1-0081-418c-a3d0-fef8a3658d39`：`items_read=40`、`items_changed=0`、`items_failed=24`、`status=success`。该版本没有持久化逐条诊断，现有数据库记录不能还原这 24 条的 fixture ID 或错误码，因此不能据此判断并修复其业务根因。

随后尝试通过微信开发者工具更新已有 `api` 云函数，上传入口仍返回 `ResourceInUse.FunctionName`（提示云函数已存在）；没有获得新代码已部署的成功证据。腾讯云 CloudBase 网页控制台当前停在首次启用页，必须先勾选并接受《腾讯云服务协议》和《云开发等级服务协议》，才能继续进入函数代码管理。本轮没有接受这些协议，也没有把新诊断代码算作已部署。

### 当前结论及恢复条件

逐条诊断能力已在本地补齐，但此前 24 条逐项失败的真实原因**尚未查明，亦未修复**；第四步仍未通过。恢复时先取得协议接受授权并通过现有函数的代码更新入口部署，然后在锁自然过期后只运行一轮英超 `future_schedule`，读取新 `sync_logs.failure_diagnostics`，按具体 fixture 和错误分类修复实际失败，再复验完整批次与重复同步。不要创建 Timer 或扩大到其余联赛，直到英超失败均已解释且数据完整性复验通过。
