# 云函数定时触发器配置（B4）

本文只说明生产调度的触发器合同，不包含部署代码。

实际触发器部署、cron 表达式落地、环境键绑定，需用户提供云开发环境后完成（待配置项）。

## 原则

- **频率属于基础设施层。** 取值引用已冻结的 `SYNC_TASKS_V1`（`src/sync/config.ts`）与 `FIXED_CONFIG_V1`。`SchedulerTick` 不内置定时循环：被触发一次就执行一次。
- **业务判断不读墙钟。** `server_now` 由触发器运行时注入（云函数入口读取系统时间或调用方传入时间），再交给 tick / runner。`now()` 只用于日志 `duration_ms`，不得写入账本、状态机或 lease。
- **同类任务互斥。** 锁 key 为已冻结的 `jobLockKey(jobType)`，格式 `sync:{job_type}`。同 `job_type` 的不同实例靠该锁互斥；lease 超时可接管。初次 lease = `server_now + FIXED_CONFIG_V1.JOB_LEASE_MINUTES`（当前 10 分钟，与 A3.3 一致）。
- **调度器只调业务入口。** Provider 五类经 tick 接线时 runner 调无锁入口 `ProviderFixtureSyncJobService.executeHeldByCaller`（P1-2 方案 A，见下文最终接线）；不套 tick 时仍可走 `ProviderSyncDispatcher` / `*Service.run(serverNow)`（自带锁）。`period_finalize` / `daily_consistency` 走已有 Service 公开入口。不得在触发器里重写账本或状态机。

## 7 类任务清单

频率列只引用 `SYNC_TASKS_V1` 已冻结字段，不在本文发明新间隔。

| job_type | 频率（`SYNC_TASKS_V1`） | 执行说明 | lease 互斥 |
| --- | --- | --- | --- |
| `future_schedule` | `intervalHours = FIXED_CONFIG_V1.SYNC_NORMAL_INTERVAL_HOURS`（当前 **6**） | 按可信 `server_now` 拉取未来赛程窗口并同步。触发器按该间隔调用 tick，一次调用一次 `run`。 | `sync:future_schedule`；他实例持有未过期 lease 时本实例 `skipped` |
| `full_schedule_verify` | `intervalHours = 24` | 全量赛程核对。每天至少触发一次。 | `sync:full_schedule_verify` |
| `near_match` | `intervalMinutes = FIXED_CONFIG_V1.SYNC_NEAR_24H_TO_2H_INTERVAL_MINUTES`（当前 **30**） | T-24h～T-2h 窗口。触发器按 FIXED 分钟触发，窗口判断仍用注入 `server_now`。 | `sync:near_match` |
| `live_match` | `intervalMinutes = FIXED_CONFIG_V1.SYNC_NEAR_2H_TO_FINISH_INTERVAL_MINUTES`（当前 **3**） | T-2h～finished。触发器按 FIXED 分钟触发。 | `sync:live_match` |
| `post_finish_verify` | `intervalMinutes = 3`（`highFrequencyUntilFirstSettlement = true`） | 完赛后高频核对直至首次结算开始。是否仍需处理由业务入口按 `server_now` 判断。 | `sync:post_finish_verify` |
| `period_finalize` | `intervalHours = 1` | 每小时触发。对 `period_end <= server_now` 的 week/month rankings 封存。周期枚举与封存决策在业务入口内用注入时间完成。 | `sync:period_finalize` |
| `daily_consistency` | `intervalHours = 24` | 每日一致性核对；发现缓存差异只报警/记摘要，不在调度层静默修账本。 | `sync:daily_consistency` |

建议每个 `job_type` 对应一个云函数定时触发器（或同一入口按事件字段分发），cron/间隔与上表一致。不要在 tick 内 `setInterval` / sleep 等待下一轮。

## `server_now` 注入

1. 云函数被定时触发。
2. 入口读取本次运行时时间（平台系统时间，或测试/回放传入的时间），构造 `Date`。
3. 调用 `new SchedulerTick(deps).run(job_type, serverNow)`。
4. runner / dispatcher / Service 只消费该 `serverNow`，不调用 `Date.now()` 做业务判断。

非法 `server_now`（非 `Date` 或 `NaN`）在 acquire 之前 Fail Closed，抛 `VALIDATION_ERROR`。

## 失败与重试边界

- **Loader / Provider 暂时错误：** 重试规则已冻结在 `SYNC_RETRY_V1`（`retryDelaysMinutes = 1/2/5/10/30`，最多 5 次，±20% jitter；quota 超限停止高频自动重试）。该规则属于 loader / `provider-sync-job` 层，tick **不**重复实现退避。
- **触发器级失败：** 由云平台重试策略决定（是否重投整个云函数）。tick 把 runner 抛错包装为 `{ outcome: "failed", error }`，并写结构化失败日志；入口若需要让平台记为调用失败，应检查 `outcome` 后再决定是否抛出。tick 不发明第二次重试表。
- **锁冲突 `skipped`：** 不是失败，不建议平台重试；等待当前 owner 完成或 lease 过期后再由下一轮定时触发接管。
- **账本 / 状态机错误：** runner 抛出后 tick 只记日志并释放锁，**不** catch 后继续写账本。

## 日志脱敏

每条 tick 日志字段：

```text
job_type, outcome, started_at, finished_at, duration_ms, lock_key, owner_id,
[runner 数值计数], [failed 时的 error 摘要]
```

要求：

- 不记录凭证、API key、`.env`、授权头。
- 不记录 raw Provider payload / fixture JSON。
- `error` 摘要只允许 `name` / `code` / `message` / `status`，不含 `details`、`payload`、`apiKey` 等敏感字段。
- 不得打印完整 OPENID。

## 组装说明

云函数入口负责组装 `SchedulerTickDeps`：

- `ownerId`：实例身份，建议 `instance-<host>-<pid>`。
- `jobLocks`：生产 JobLock repository（B1 真实库未接线前不可在本环境验证）。
- `runners`：七类业务入口，签名均为 `(serverNow: Date) => Promise<...>`。
  - Provider 五类：`ProviderSyncDispatcher.run(jobType, serverNow)` 或对应 `*Service.run(serverNow)`。
  - `period_finalize`：调用 `PeriodFinalizeService.finalize(periodType, periodKey, serverNow)`；由入口按小时枚举到期周期。
  - `daily_consistency`：调用 `DailyConsistencyService.run(serverNow)`。

### 最终接线（P1-2 方案 A）：tick 持锁，runner 走无锁业务入口

Provider 五类任务的 `ProviderFixtureSyncJobService` 已拆分两层入口：

- `run(jobType, load, serverNow)`：自持锁入口（acquire → `executeHeldByCaller` → release）。独立调用方（未套 tick 的云函数入口、本地演练）继续使用它，签名不变。
- `executeHeldByCaller(jobType, load, serverNow, ownerId)`：无锁批次核心（loader + apply + sync_logs + lease 续租）。**只**供已持有 `sync:{job_type}` 锁的调用方复用，禁止再 acquire 同一 key。

云函数 tick 接线：

1. 云函数定时触发 → 调 `SchedulerTick.run(jobType, serverNow)`。
2. `SchedulerTick` acquire `sync:{job_type}`（owner = 入口的 `ownerId`）。
3. tick runner 注册为 `executeHeldByCaller`，且把**同一个** `ownerId` 传入，保证 lease 续租 owner 与 acquire owner 一致：
   ```ts
   const ownerId = `instance-<host>-<pid>`;
   runners[SyncJobType.LiveMatch] = (now) =>
     liveMatchService.fixtureJob.executeHeldByCaller(SyncJobType.LiveMatch, load, now, ownerId);
   ```
4. `period_finalize` / `daily_consistency` 同样禁止在同一 `sync:{job_type}` key 上叠锁；二者 service 内部不再重复 acquire 时才能挂 tick，否则维持「只调 Service 自带锁」方案 B。

禁止：tick 与任意 Service 对同一 key 双 acquire（内层必 `skipped`）。本地回归见 `tick.test.ts` 双层锁用例与 `provider-sync-job.test.ts` `executeHeldByCaller` 用例。

## 待配置项（需要用户环境）

- 云开发环境 id / 资源命名空间确认（dev / test / prod 隔离）。
- 七类定时触发器的 cron / 间隔在控制台或配置中落地。
- 生产 `job_locks` 与 `sync_logs` 所在数据库绑定。
- 云函数入口与 tick 的组装（含 `ownerId`、日志汇出）。
- 平台级失败重试策略确认（与 `SYNC_RETRY_V1` 分层，不重复）。

不提交 `.env`、Provider 密钥或其它凭证。
