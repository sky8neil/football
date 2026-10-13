# MVP 2.0 Cloud1 验收记录 v1.0

日期：2026-10-13  
环境：`cloud1-d4ga6fvm0c6d4ec01` / `ap-shanghai` / `football_test`  
函数：`api`  
状态：**未完成；赛程同步阶段遇到云端预算计数失败，后续步骤暂停**

本记录按《MVP2.0__AI_TESTING_PLAN__v1.0.md》§8.2 执行。所有凭据值和用户身份均未写入本报告。

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

第四步目前**部分完成，不能判定验收通过**。后续联赛、Timer 和五源真实响应检查均应在先定位 `provider budget denied` / 分钟计数器行为并确认超时任务锁可安全接管后继续。不要通过手动删除锁来掩盖未完成的同步任务。

当前处理决定：保留本报告，等待远程 AI 完成代码修复；本地不改代码，也不继续触发同步或创建 Timer。收到修复完成通知后，先只读核对锁和任务状态、预算计数器及云端 Provider 额度参数，再从首个联赛重新验收。
