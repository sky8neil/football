# 上线前长期运行稳定性 Code Review 报告

- **审查日期**：2026-11-19
- **基线版本**：`8e37d49`（`8e37d492dda0f38c3e32c8ebb1f178425f9f7fba`）
- **审查方式**：静态代码阅读与逻辑推演（未运行代码、未创建测试账号）
- **审查目标**：排查「当前运行正常，但上线长期运行（1 个月 / 6 个月 / 12 个月及跨年/换季）后会暴露」的隐患与逻辑缺陷。
- **审查范围**：
  - 已覆盖：`src/runtime/scheduled-jobs.ts`、`src/domain/time.ts`、`src/domain/config.ts`、`src/domain/levels.ts`、`src/application/weekly-level-eval.ts`、`src/application/board-snapshot.ts`、`src/application/period-finalize.ts`、`src/application/match-query.ts`、`src/application/ranking-query.ts`、`src/application/daily-consistency-snapshot.ts`、`src/application/rebuild-service-support.ts`、`src/application/groups.ts`、`src/application/personal-league-summary-service.ts`、`src/infrastructure/cloudbase-app-repository.ts`、`src/infrastructure/cloudbase-wx-db.ts`、`src/infrastructure/postgres-document-db.ts`、`src/infrastructure/postgres-schema.ts`、`src/infrastructure/postgres-auth-sessions.ts`、`src/schema/indexes.ts`、`src/provider/budget.ts`、`src/gateway/auth.ts`、`src/gateway/wechat-login.ts`、`src/runtime/vps-runtime.ts`、`src/jobs/tick.ts`、`ops/vps/*`、以及 `miniprogram/`（`services/api.js`、`services/auth.js`、`utils/auth-storage.js`、`utils/rankings-view-model.js`、`pages/matches/matches.js`、`config.js` 等）。
  - 未深入：各 Provider adapter 的解析细节、结算三个 service 内部、`admin`、`cloud-function`（CloudBase 路径当前未核验，本次按 VPS 路径为主评估）。

---

## 概览

| 严重程度 | 数量 | 编号 |
| --- | --- | --- |
| 致命 | 3 | F1 – F3 |
| 高 | 7 | H1 – H7 |
| 中 | 6 | M1 – M6 |
| 低 | 6 | L1 – L6 |

---

## 致命

### F1. 周评估会被 `SPEC_GAP` 永久卡死，影响所有用户
- **位置**：`src/application/weekly-level-eval.ts` 的 `evaluateWithProtection`（L109-149）、`run` 循环（L279-295）；配置 `src/domain/config.ts:69`（`LEVEL_FIRST_EVAL_AS_OF: null`）。
- **问题**：当 `firstEvalAsOf` 为 `null` 时，只要存在任意一位 `L >= 3` 且本周未达到保级线的用户，受保护结果与不受保护结果的 `below_count` 不同，函数会直接抛出 `SPEC_GAP`。外层用户遍历未做单用户 `try/catch`，导致整个周评估任务中断。
- **触发条件与预计时间**：上线后第一个升到 3 级且出现掉线/未达标的用户产生时（通常数周至数月内）。
- **后果**：
  - `weeklyDue` 持续为 `true`，每 3 分钟 tick 都会重跑并在同一用户处再次抛错。
  - 队列中排在该用户之后的所有用户停止评估。
  - 实力榜快照因 `inline_weekly_refresh` 被持续跳过，赛季终榜也无法生成。
  - 全站等级评估停滞。
- **建议修复**：上线前必须登记 `LEVEL_FIRST_EVAL_AS_OF`（首个周一 10:00 Asia/Shanghai）；同时在周评估循环内增加单用户异常捕获，记录 anomaly 后继续评估其余用户。

### F2. 比赛列表的赛季写死 `2026_2027` / `2026`，换季后看不到新赛季比赛
- **位置**：`src/application/match-query.ts:363`（取 `SUPPORTED_LEAGUES.map((row) => row.season_id)`，来自 `src/domain/config.ts` 的静态配置）。
- **问题**：同步端使用 `activeLeagueSeason(league, serverNow)` 动态计算当前赛季入库，而查询端仍读取写死的静态 `season_id`，两端在换季后出现割裂。
- **触发条件与预计时间**：
  - 中超在 2027-01-01 切至 `2027`（约 2027 年 3 月开赛时暴露）。
  - 五大联赛在 2027-07-01 切至 `2027_2028`（约 8 个月后暴露）。
- **后果**：`GET /v1/matches` 查不到新赛季比赛，小程序首页与比赛页为空，用户无法提交新赛季预测。
- **建议修复**：参照 `ranking-rebuild-service.ts`，改用 `activeSeasonIds(league, server_now)` 查询当前与过渡期赛季。
- **关联点**：`src/application/daily-consistency-snapshot.ts:603` 在 `now` 缺省时也使用静态 `league.season_id`，建议一并统一为动态赛季。

### F3. `board_snapshots` 无限增长，排行榜请求全量读取
- **位置**：写入见 `src/application/board-snapshot.ts:332`（career 榜与 season 榜每 60 分钟各写全量用户快照）；读取见 `src/infrastructure/cloudbase-app-repository.ts:633-645`（`findLatestByBoard`、`findLatestBySeason`、`listFinalSeasonIds`）；调用入口见 `src/application/ranking-query.ts:557-562`。
- **问题**：
  - `findLatestByBoard` / `findLatestBySeason` 使用 `where({ board })` 拉取该榜单**全部历史快照**，再在内存中筛选最新 `snapshot_at`。
  - `listFinalSeasonIds` 拉取全部终榜记录仅为了提取 `level_season_id`。
  - 每次打开排行榜都会触发上述查询，且 `board_snapshots` 无任何清理或归档机制。
- **触发条件与预计时间**：单用户每年约产生 17,000+ 行快照（24 次/天 × 365 天 × 2 榜 + 实力榜）；1 万用户规模下一年可累积约 1.7 亿行。数周至数月内接口延迟将急剧上升并引发超时或 Node 进程 OOM。
- **后果**：排行榜页面打不开，API 进程 OOM 重启，并拖垮同库的其他业务请求。
- **建议修复**：
  - 将「取最新 `snapshot_at`」下推到数据库（先查最新 `snapshot_at`，再按 `board` + `snapshot_at` 等值查询）。
  - 对历史快照设置保留策略（如仅保留最近 N 份非终榜快照，定期清理或归档）。
  - 降低快照频率或仅对发生变化的榜单/行生成快照。
  - `listFinalSeasonIds` 改为仅查 `snapshot_kind: "head"` 或维护独立的终榜赛季索引记录。

---

## 高

### H1. 每次 tick 都对全体用户执行 N+1 查询（调度判定阶段）
- **位置**：`src/runtime/scheduled-jobs.ts:267-270`、`L345`，调用 `src/application/weekly-level-eval.ts:70-92` 的 `listDueSeasonFinalIds`。
- **问题**：`weeklyDue` 为 `false` 时，每 3 分钟 tick 都会执行 `users.findAll()`，随后对每个用户执行 `userSeasonStats.findByUser(user_id)`，形成典型 N+1 查询，之后还会进一步查询终榜与赛季统计。
- **触发条件与预计时间**：用户量达到数千级后明显恶化（每天执行约 480 轮）。
- **后果**：单轮 tick 耗时持续拉长，超过 3 分钟后导致 systemd timer 跳过调度，`live_match` 实时同步被延误。
- **建议修复**：避免遍历全体用户；改为按已知/最近 `level_season_id` 直接查询 `userSeasonStats.findByLevelSeason`，或维护待生成终榜的轻量状态记录。

### H2. 周期封榜每小时全表读取 `rankings`
- **位置**：`src/runtime/scheduled-jobs.ts:262-265`（`listDuePeriodKeys` 调用 `repo.rankings.findAll()`），`src/application/period-finalize.ts:34-46`。
- **问题**：每小时把 `rankings` 全表历史周榜记录读入内存，只为找出 `is_final=false` 的 `period_key`。
- **触发条件与预计时间**：数据量随「用户数 × 活跃周数」线性增长，上线数月后开销显著。
- **后果**：每小时封榜判定耗时和内存占用持续攀升。
- **建议修复**：仅查询 `period_type: "week"` 且 `is_final: false` 的记录，或按近期若干周的 `period_key` 精确查询。

### H3. 每日对账全量读取所有 `applied` 结算项，并逐条做 N+1 查询
- **位置**：`src/application/daily-consistency-snapshot.ts:600-614`（`settlementItems.findByStatus(SettlementItemStatus.Applied)`），`src/application/rebuild-service-support.ts:57-91`（每个 item 分别查询 `settlements`、`matches` 等）。
- **问题**：账本数据无时间边界限制，全量加载到内存后在单个事务内逐条关联查询。
- **触发条件与预计时间**：约 5,000 用户运行半年，累积数百万条 `settlement_items`，对应千万级单次查询。
- **后果**：每日对账任务超过 `TimeoutStartSec=1800`（30 分钟）被 systemd 强杀；因未更新周期完成标记，次日及后续每轮 tick 会重复触发并再次被杀，同时阻塞同一 tick 内的其他同步任务。
- **建议修复**：按赛季或日期分批扫描、增加用户/游标分片、对 `settlement` 与 `match` 做批次内缓存，或改为多轮断点续查。

### H4. 周评估同样存在按用户的重 N+1 查询，且单租约不续期
- **位置**：`src/application/weekly-level-eval.ts:222-229`（`userFacts` 对 `findAppliedByUserBefore` 返回的每个 item 走 `loadAppliedSettlementFacts`），租约在 L262-265 获取，`JOB_LEASE_MINUTES = 10`。
- **问题**：随着用户数与历史结算项增加，周一 10:10 的全量评估耗时线性增长，且执行期间不会对 `job_locks` 续租。
- **触发条件与预计时间**：用户量达到数千至上万、运行数月后，单次评估超过 10 分钟租约期，甚至超过 30 分钟 systemd 超时。
- **后果**：租约过期后 API 侧的 `retry` 或 `rebuild` 请求可并发抢锁；若超过 30 分钟被 systemd 杀掉，周评估将无法完成，阻塞实力榜与终榜。
- **建议修复**：改为分批/断点推进，执行过程中定期 `renew` 租约，并配合 F1 做单用户异常隔离。

### H5. 所有同步与周期重任务串行在同一次 tick 中执行，无时间预算控制
- **位置**：`src/runtime/scheduled-jobs.ts:794-866`（`runScheduledJobs`），`ops/vps/football-jobs.service` / `football-jobs.timer`。
- **问题**：Provider 同步、结算、赛季维护、周期封榜、每日对账、周评估、榜单快照都在同一个 `oneshot` 进程中顺序执行，任一重任务变慢或卡住都会拖延或阻塞实时比分更新。
- **触发条件与预计时间**：结合 H1/H3/H4，数据累积数月后逐步显现。
- **后果**：`live_match` 3 分钟实时同步退化甚至长时间中断。
- **建议修复**：将重周期任务（对账、周评估、快照、清理）拆出独立的 systemd timer/service，或为单轮 tick 设定时间预算与任务隔离。

### H6. 各类日志、监控与会话表无限增长，缺乏清理与归档机制
- **位置**：全仓未实现物理删除/清理任务（`src/schema/indexes.ts` 注释提到「0.6 仅允许清理运行日志」，但代码未落地）。涉及集合/表：
  - `sync_logs`（`provider-sync-job.ts:464`，每 3 分钟 tick 多条）
  - `provider_snapshots`
  - `provider_usage`（含 minute 与 hour 级 bucket，`src/provider/budget.ts`）
  - `auth_sessions`（`src/infrastructure/postgres-auth-sessions.ts`，只插入不清理过期会话）
  - `admin_audit_logs`、`anomalies`（closed 记录）、`job_locks`、`level_history`、`provider_reconcile_todos`（done 记录）
- **触发条件与预计时间**：运行 6–12 个月后表体积与索引显著膨胀（`sync_logs`、`provider_usage`、`auth_sessions` 增长最快）。
- **后果**：磁盘空间耗尽，PostgreSQL 查询与 VACUUM 性能退化，全库备份耗时暴涨。
- **建议修复**：新增每日定时清理任务：
  - `auth_sessions`：删除 `expires_at` 早于 N 天的记录。
  - `provider_usage`：minute / hour 级 bucket 保留约 2–7 天即可。
  - `sync_logs`、`provider_snapshots`：保留 30–90 天。
  - `provider_reconcile_todos`（已 `done`）与已关闭 `anomalies`：按保留期清理或归档。

### H7. PostgreSQL 连接池缺少 `error` 事件监听、连接数上限与超时配置
- **位置**：`src/runtime/vps-runtime.ts:32`（`new pg.Pool({ connectionString: input.postgres.database_url })`），全仓未见 `pool.on("error", ...)`。
- **问题**：当 PostgreSQL 重启、云厂商例行维护或网络闪断时，空闲连接触发 `error` 事件；未监听会导致 Node 进程直接崩溃退出。同时未设置 `max`、`connectionTimeoutMillis`、`idleTimeoutMillis` 和 `statement_timeout`。
- **触发条件与预计时间**：任意一次数据库重启或网络抖动即可触发。
- **后果**：API 进程异常退出（依赖 systemd `Restart=on-failure` 拉起，期间短暂不可用）；慢查询可能长期占满连接池导致雪崩。
- **建议修复**：补充 `pool.on("error", ...)` 日志监听，并显式配置连接池上限及 `connectionTimeoutMillis` / `statement_timeout`。

---

## 中

### M1. `job_locks.acquire` 非原子操作
- **位置**：`src/infrastructure/cloudbase-app-repository.ts:528-542`。
- **问题**：在事务内先 `byId` 读取再 `update` 或 `add`，PostgreSQL 默认 `READ COMMITTED` 且未使用 `FOR UPDATE` 行锁。两个并发调用可能同时读到已过期锁并各自写入成功；首次抢锁时若并发插入则会直接抛出唯一键冲突异常而非返回 `false`。
- **触发条件与预计时间**：API 侧管理端 `retry-settlement` / `rebuild` 与定时 `tick` 并发抢同一把锁时（tick 本身被 systemd `oneshot` 串行化，不自我并发）。
- **后果**：出现重复重建或并发写榜，虽有账本幂等兜底，但仍可能产生中间态错乱或无谓报错。
- **建议修复**：PostgreSQL 侧改为单条原子 SQL：`INSERT ... ON CONFLICT (_id) DO UPDATE ... WHERE lease_until <= now() RETURNING _id`。

### M2. 小程序端依赖设备本地时钟判断登录态是否过期
- **位置**：`miniprogram/utils/auth-storage.js:21-27`，`miniprogram/services/auth.js:117-138`。
- **问题**：`expires_at` 由服务端下发，前端用设备本地 `new Date()` 比对。若用户手机系统时间不准，会导致携带已过期 token 请求，或误判未过期 token 为失效从而反复重登。此外服务端会话固定 7 天且无续期机制，到期后老用户会在边界时刻统一触发重登。
- **后果**：偶发 401 或频繁静默重登。
- **建议修复**：在收到服务端 `401` 时自动清理本地缓存并触发一次静默重登重试，或结合响应时间校正时钟偏差。

### M3. 小程序日期条依赖 `toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })`（待确认）
- **位置**：`miniprogram/pages/matches/matches.js:29-37`、`L51-52`。
- **问题**：逻辑强依赖 `sv-SE` 输出为 `YYYY-MM-DD HH:MM:SS` 格式并按空格切分；部分旧版 iOS / Android 微信基础库的 JS 引擎对 `Intl` `timeZone` 及特定 locale 支持不完整。
- **后果**：日期条展示错乱、无法对齐「今天」甚至空白。**待确认**：需结合线上最低支持的微信基础库版本在真机验证。
- **建议修复**：改用纯 `Date.UTC` + 固定 `+8h` 毫秒偏移计算北京时间年月日，不依赖 `toLocaleString` 格式化解析。

### M4. `RANKING_FIRST_PERIOD_KEY = "2026-W31"` 仍是占位值（前后端各一份）
- **位置**：`src/domain/config.ts:13` 与 `miniprogram/config.js:11`（README 中已注明为占位值）。
- **问题**：当前时间已到 `2026-W47`，若上线前忘记同步修改，周榜下拉列表会列出上线前的大量空周，且前后端配置若未同步修改会产生不一致。
- **后果**：用户看到空白历史周榜或周榜选择器异常。
- **建议修复**：上线前同步更新为正式发布周，尽量改为由后端接口下发可选周起始边界以消除双端维护。

### M5. 其余随数据增长变慢的全量/大范围读取
- **位置**：
  - `findAnomalyPage`（`cloudbase-app-repository.ts:857`）：每次打开管理端异常列表都全量读取 `anomalies`。
  - `findSettlementFallbackPage`（`cloudbase-app-repository.ts:764-786`）：每 12 小时用 `offset` 扫描全部历史 `finished` 比赛。
  - `settlementItems.findAppliedByUserBefore`（`cloudbase-app-repository.ts:596`）：按用户全量读取所有历史 applied 项，周评估反复调用。
  - `matches.findBySeason`（`match-query.ts:366`）：每次请求 `GET /v1/matches` 都拉取 6 个联赛整个赛季的比赛（上千行）再在内存按时间窗过滤。
- **后果**：运行数个赛季后接口与任务延迟逐步升高。
- **建议修复**：将过滤条件（`kickoff_at` 范围、`applied_at` 上界、状态分页游标）下推到数据库查询与索引。

### M6. 周评估中单场比赛正在结算会导致整批周评估中断
- **位置**：`src/application/rebuild-service-support.ts:82-91`（未传 `skipActiveSettlement` 时遇到正在结算的比赛抛出 `SETTLEMENT_ALREADY_RUNNING`）。
- **问题**：若周一 10:10 附近恰好有延迟比赛正在结算，该用户触发的冲突异常会中断整个周评估任务。
- **后果**：虽可依赖下一轮 tick 重试恢复，但会导致该轮已评估前的大量工作重复执行。
- **建议修复**：结合 F1 做单用户异常隔离，跳过当前受影响的单个用户待下轮重试。

---

## 低

- **L1. 联赛换季与等级赛季切换存在 8 小时边界差**：`src/domain/config.ts` 的 `deriveSeasonId` / `activeLeagueSeason` 按 UTC 7/1 00:00 切季，而 `src/domain/time.ts:185` 的 `levelSeasonOf` 按北京时间 7/1 00:00（即 6/30 16:00 UTC）切季，每年 6/30 16:00–24:00 UTC 之间存在 8 小时窗口不一致。
- **L2. `provider/budget.ts` 日/月额度重置时区不一致（待确认）**：日桶按 `Asia/Shanghai` 切天，月桶按 UTC 切月（`monthBucket` / `nextMonthStart`）。若上游 Provider 按 UTC 重置日额度，每日 00:00–08:00 北京时间可能出现最多 8 小时的本地与远端额度统计偏差（待确认各 Provider 实际重置时区）。
- **L3. `runOuterTransaction` 回滚失败未销毁异常连接**：`src/infrastructure/postgres-document-db.ts:474-478` 中，若 `ROLLBACK` 自身抛错，仍会执行 `client.release()` 将可能处于异常事务状态的连接归还连接池，建议改为 `release(error)`。
- **L4. `CloudBaseWxDb.query` 翻页缺少稳定排序**：`src/infrastructure/cloudbase-wx-db.ts:134-155` 未传 `order_by` 时仅靠 `skip` 分页，数据变动时可能漏行或重复（CloudBase 路径当前未启用，仅切换云端时相关）。
- **L5. VPS 运维模板包含写死用户名与路径**：`ops/vps/football-api.service` 与 `football-jobs.service` 中包含 `User=neilxu` 及 `/home/neilxu/...`，换机或换部署用户时需同步替换。
- **L6. 仓库内未见数据库备份/恢复脚本（待确认）**：未看到 PostgreSQL 定期 `pg_dump` 或 WAL 归档配置，需确认服务器运维侧是否已配置独立备份方案。

---

## 上线前必须修复清单（致命与高）

1. **F1**：登记 `LEVEL_FIRST_EVAL_AS_OF`，并为 `WeeklyLevelEvalService` 增加单用户异常捕获隔离。
2. **F2**：将 `match-query.ts:363` 与 `daily-consistency-snapshot.ts:603` 的静态 `season_id` 改为动态 `activeSeasonIds`。
3. **F3**：将 `board_snapshots` 的最新快照查询与终榜赛季查询下推到数据库，并增加历史快照保留/清理策略。
4. **H1**：优化 `listDueSeasonFinalIds`，移除每 3 分钟全表读取 `users` 的 N+1 查询。
5. **H2**：优化 `listDuePeriodKeys`，避免每小时全表读取 `rankings`。
6. **H3**：改造每日一致性对账，支持分批/分片与缓存，避免单事务全量加载 `applied` 结算项超时。
7. **H4**：为周评估增加分批、断点及 `job_locks` 租约续期机制。
8. **H5**：将耗时周期任务（对账、周评估、快照、清理）与 3 分钟实时同步 `tick` 拆分隔离。
9. **H6**：新增日志与临时数据定期清理任务（覆盖 `auth_sessions`、`provider_usage`、`sync_logs`、`provider_snapshots` 等）。
10. **H7**：为 PostgreSQL `pg.Pool` 增加 `pool.on("error")` 监听及连接池上限与超时参数。

---

## 待确认项（需补充信息）

1. 预期日活与用户总规模（用于精确评估 H1–H4 的触发时间窗口）。
2. 小程序最低支持的微信基础库版本（用于确认 M3 的 `toLocaleString` 兼容性）。
3. 生产服务器是否已配置 PostgreSQL 自动备份与恢复演练（对应 L6）。
4. 各接入 Provider 实际按 UTC 还是本地时区重置日/月请求额度（对应 L2）。
