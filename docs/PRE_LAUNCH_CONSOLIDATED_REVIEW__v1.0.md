# 上线前合并审查报告（功能核验 + 长期运行稳定性）

- **整理日期**：2026-11-19
- **合并来源**：
  1. [football-mvp-baogao-最终核验.md](football-mvp-baogao-最终核验.md)（基线 `a209232`，侧重业务功能、数据一致性、小程序展示与交互核验）
  2. [LONG_TERM_RELIABILITY_CODE_REVIEW__v1.0.md](LONG_TERM_RELIABILITY_CODE_REVIEW__v1.0.md)（基线 `8e37d49`，侧重长期运行隐患：时间换季、数据膨胀、N+1 性能、资源/连接管理、并发与清理）

---

## 一、两份报告的重复情况说明

两份报告审查视角不同，**绝大部分问题不重复（高度互补）**，仅存在 **1 项完全重叠** 和 **1 项部分重叠**：

| 序号 | 稳定性报告 | 最终核验报告 | 重叠判断与合并结论 |
| --- | --- | --- | --- |
| 1 | **F1**：`LEVEL_FIRST_EVAL_AS_OF` 为 `null` 导致周评估 `SPEC_GAP` 卡死 | **一.1**：等级评估、重建和核对未共用已登记的首评时间 | **高度重叠（同一根因，视角互补）**。核验报告补充了重建会将 Lv.5/6 账户降为 Lv.1 的事实；稳定性报告补充了触发 `SPEC_GAP` 后每 3 分钟 tick 持续卡死后续用户与实力榜/终榜的风险。 |
| 2 | **M2**：前端本地时钟判断会话过期，HTTP 模式失效 token / 偶发 401 | **二.3**：登录入口错跳设置页 & HTTP 登录态失效恢复 | **部分重叠**。均指向 HTTP 模式下本地会话与服务端 401 恢复机制；核验报告额外指出了 `profile.wxml:7` 登录入口跳错页面的 Bug。 |

其余 **19 项稳定性/运维隐患**（F2–F3、H1–H7、M1、M3–M6、L1–L6）与 **10 项功能/业务缺陷**（一.2、二.4–二.11、三、四）均为各自独有，互不重复。

---

## 二、合并后的问题总览（按上线优先级）

### P0：上线前必须解决（数据正确性 & 长期运行致命隐患）

#### 1. 【合并 F1 + 核验一.1】`LEVEL_FIRST_EVAL_AS_OF` 未登记，导致周评估卡死与重建降级
- **位置**：`src/domain/config.ts:69`（`LEVEL_FIRST_EVAL_AS_OF: null`）、`src/domain/levels.ts:422`、`src/application/weekly-level-eval.ts:109-149, 279-295`、`src/application/stats-rebuild-service.ts`
- **问题**：
  1. 重建路径在 `firstEvalAsOf === null` 时返回 1 级并回写，当前库中已有 Lv.5/6 账户，管理员一旦执行统计重建会将高等级账户错算回 Lv.1。
  2. 周评估路径在保护期与非保护期结果不一致（如首个 `L >= 3` 用户未达保级线）时直接抛出 `SPEC_GAP`；外层遍历未做单用户 `try/catch`，会直接中断整个周评估。
- **后果**：一旦触发，`weeklyDue` 持续为 `true`，每 3 分钟 tick 都会在同一个用户处再次抛错，导致后续用户停止评估、实力榜快照持续跳过、赛季终榜不生成。
- **建议修复**：查实并登记真实的首评日期 `LEVEL_FIRST_EVAL_AS_OF`，使周评、重评、重建、一致性检查共用同一时间轴；同时为周评估循环增加单用户异常捕获与隔离。

#### 2. 【稳定性 F2】比赛列表赛季写死 `2026_2027` / `2026`，换季后看不到新赛季比赛
- **位置**：`src/application/match-query.ts:363`、`src/application/daily-consistency-snapshot.ts:603`、`src/domain/config.ts`
- **问题**：同步端使用 `activeLeagueSeason(league, serverNow)` 动态换季入库，但比赛列表查询与对账默认分支仍读取 `SUPPORTED_LEAGUES` 里写死的静态 `season_id`。
- **触发时间**：中超 2027-01-01 换季（约 2027 年 3 月开赛暴露）；五大联赛 2027-07-01 换季（约 8 个月后暴露）。
- **后果**：`GET /v1/matches` 查不到新赛季比赛，首页与比赛页全空，无法提交预测。
- **建议修复**：两处均改用 `activeSeasonIds(league, serverNow)` 动态计算目标及过渡期赛季。

#### 3. 【稳定性 F3】`board_snapshots` 无限增长，排行榜请求全量读取
- **位置**：`src/application/board-snapshot.ts:332`、`src/infrastructure/cloudbase-app-repository.ts:633-645`、`src/application/ranking-query.ts:557-562`
- **问题**：career 与 season 榜每 60 分钟写一次全量用户快照且无任何清理；读取 `findLatestByBoard` / `findLatestBySeason` / `listFinalSeasonIds` 时会拉取该榜**全部历史快照**进内存再过滤。
- **后果**：单用户每年约 17,000+ 行快照；1 万用户一年约 1.7 亿行。数周至数月内排行榜接口超时甚至导致 API 进程 OOM，拖垮同库请求。
- **建议修复**：将 `max(snapshot_at)` 查询下推到数据库，再按 `snapshot_at` 等值查询；`listFinalSeasonIds` 仅读 `head` 行或独立索引；增加历史非终榜快照的定期清理/归档策略。

#### 4. 【核验一.2】供应商更换比赛 ID 后，旧预测与新比赛尚未贯通
- **位置**：`src/application/provider-schedule-sync.ts:203-248`、`src/application/settlement-item-preparation.ts:35`、`match-query` / 详情页
- **问题**：新比赛沿用 `canonical_match_id`、旧比赛标为 `superseded_by` 后，提交接口已按 canonical 查重，但详情页仍按新 `match_id` 查预测，结算准备也只按新 `match_id` 取预测。
- **后果**：若已预测比赛被换 ID，详情页显示 `can_predict=true`、`my_prediction=null`，点击提交却被拒绝（前后矛盾），且旧预测无法随新赛结果结算（漏结算）。
- **建议修复**：将列表、详情、提交、个人记录、结算全链路统一按 `canonical_match_id` 归属处理。

---

### P1：高优先级（性能/定时任务雪崩风险 & 核心功能缺失）

#### 5. 【稳定性 H1–H5】定时任务全量扫描、N+1、无租约续期且与实时同步串行
- **H1**（`scheduled-jobs.ts:267, 345` → `weekly-level-eval.ts:70-92`）：`weeklyDue=false` 时每 3 分钟全量扫描 `users.findAll()` 并对每个用户查 `userSeasonStats`（N+1）。
- **H2**（`scheduled-jobs.ts:262` → `period-finalize.ts:34`）：每小时全表读取 `rankings` 找未封榜周。
- **H3**（`daily-consistency-snapshot.ts:600-614` → `rebuild-service-support.ts:57`）：每日对账单事务内全量读取所有 `applied` 结算项并逐条做 N+1 查询，数月后易超 `TimeoutStartSec=1800` 被 systemd 强杀且死循环重试。
- **H4**（`weekly-level-eval.ts:222-229, 262`）：周评估同样逐用户重 N+1，且 10 分钟 `job_locks` 租约不续期，超 10 分钟可能被并发抢锁，超 30 分钟被 systemd 强杀。
- **H5**（`scheduled-jobs.ts:794-866`、`ops/vps/football-jobs.*`）：所有重周期任务与 `live_match` 实时同步串行在同一 `oneshot` 进程中，任一任务变慢即拖垮 3 分钟实时比分。
- **建议修复**：下推/缩小查询范围（按 `is_final=false`、按赛季/游标分批、批次内缓存）；周评估加租约续期；将重周期任务与实时同步拆分为独立的 timer/service。

#### 6. 【稳定性 H6】各类日志、监控与会话表无限增长，缺乏清理机制
- **位置**：`sync_logs`、`provider_snapshots`、`provider_usage`（含 minute/hour bucket）、`auth_sessions`、`admin_audit_logs`、`anomalies`（closed）、`provider_reconcile_todos`（done）。
- **后果**：运行 6–12 个月后表与索引显著膨胀，磁盘占满、PG 性能及备份速度退化。
- **建议修复**：新增每日清理任务，按合理保留期清理过期 session、短期 usage bucket、历史 `sync_logs` 与 `provider_snapshots`。

#### 7. 【稳定性 H7】PostgreSQL 连接池缺少 `error` 监听与超时配置
- **位置**：`src/runtime/vps-runtime.ts:32`
- **后果**：PG 重启或网络闪断时，空闲连接触发未捕获 `error` 事件直接导致 API 进程崩溃；缺少 `max` 与 `statement_timeout` 在慢查询时易耗尽连接。
- **建议修复**：添加 `pool.on("error", ...)`，配置 `max`、`connectionTimeoutMillis`、`idleTimeoutMillis` 和 `statement_timeout`。

#### 8. 【合并 M2 + 核验二.3】登录入口错跳 & HTTP 登录态失效恢复
- **位置**：`miniprogram/pages/profile/profile.wxml:7`、`profile.js:288`、`miniprogram/utils/auth-storage.js:21-27`、`miniprogram/services/auth.js:117-138`
- **问题**：
  1. “我的”页点击“登录”错误跳转到设置页，无法就地登录。
  2. HTTP 模式下前端用设备本地时钟判断 `expires_at`（时钟偏差会误判或漏判），且服务端会话失效后本地仍认为有效时可能反复收到 401。
- **建议修复**：分离登录与设置导航；收到服务端 `401` 时自动清缓存并触发静默重登重试，完成后返回原页面。

#### 9. 【核验二.4】首页无法稳定展示已预测比分和得分，完场说明耦合本地缓存
- **位置**：`miniprogram/pages/matches/matches.js:283`、`MatchListItem`
- **问题**：列表接口不返回 `my_prediction`，首页只读本地 `submittedMap`；跨页提交、重进页面或换设备后首页显示“未预测”，且无本地缓存的完场有比分场次会错标“待结算”。
- **建议修复**：首页列表接口返回当前用户预测回显；将全场比分、结算状态、个人预测状态解耦展示。

#### 10. 【核验二.5 & 二.6】排行榜个人指标缺失 & 退群/解散后重试卡死
- **位置**：`miniprogram/pages/rankings/rankings.js:195, 455`
- **问题**：
  1. `rankings.js:455` 从公开前 20 名分页结果中找自己，未加载到所在页或 20 名以外时“我的积分”显示“—”。
  2. `rankings.js:195` 所选群失效后报错但未清除选中群或提供恢复路径，点重试仍请求失效群。
- **建议修复**：排行榜接口独立返回当前用户该榜完整指标；群失效时刷新群列表并支持一键切回全站榜。

---

### P2：中优先级（功能缺项、并发边界、兼容性与配置）

#### 11. 【功能/交互缺项（核验二.7–二.11）】
- **二.7 队徽与选队**：`team-presentation.js:11` 仅传 `team_id` 导致预测记录页 112 队全占位（传 `source_name` 仍缺 45 队）；`profile.js` 与 `settings.js:41-54` 选主队依赖近期赛程而非全量注册表。
- **二.8 本赛季成绩单**：`profile.wxml:26` 本赛季积分与精确命中写死“—”，`SeasonLevelData` 缺对应字段。
- **二.9 Lv.1 升级误导**：`profile.js:128` 传 `nextThreshold=null`，部分已够 20 场但曾有数值型旧 `b_points` 的 Lv.1 用户在等待周评时会被 `buildLevelView` 误判为满格 100%。
- **二.10 截止后大家预测锁定**：截止后开球前（`scheduled`），已提交用户因 `ALREADY_SUBMITTED` 优先级高于 `CLOSED` 被锁住看不了分布，未提交用户反而能看。
- **二.11 加群失败恢复 & 创建数量**：`groups/join.wxml:19` 错误态缺重试/返回输入按钮；`profile.js:279` 创建群成功页 `owned_count=1` 写死。

#### 12. 【稳定性 M1 & M3–M6】并发锁、前端兼容性与全量查询
- **M1（`job_locks.acquire` 非原子）**：`cloudbase-app-repository.ts:528-542` 先读后写且无行锁，并发抢锁（API 管理端与 tick）可能同时成功或首次插入报唯一键冲突；建议改为 PG `INSERT ... ON CONFLICT DO UPDATE ... WHERE lease_until <= now()`。
- **M3（日期条 `toLocaleString("sv-SE")` 兼容性，待确认）**：`matches.js:29-37, 51-52` 依赖 `Intl` `sv-SE` 输出格式，需在目标最低微信基础库真机验证，建议改为纯 `Date.UTC` + `+8h` 算术。
- **M4（`RANKING_FIRST_PERIOD_KEY = "2026-W31"` 占位值）**：`src/domain/config.ts:13` 与 `miniprogram/config.js:11` 需上线前同步改为实际发布周。
- **M5（次级全量/大范围读取）**：`findAnomalyPage` 全量读 `anomalies`、`findSettlementFallbackPage` 扫描历史 `finished`、`findAppliedByUserBefore` 按用户全量读、`matches.findBySeason` 每次 `/matches` 拉 6 联赛全季上千行再内存过滤。
- **M6（单场结算阻塞周评估）**：`rebuild-service-support.ts:82-91` 遇到正在结算的比赛抛 `SETTLEMENT_ALREADY_RUNNING`，未按用户隔离会中断整批周评估。

---

### P3：低优先级 & 可选调整（低隐患 + 体验微调 + 待确认）

#### 13. 【稳定性 L1–L6】
- **L1**：`deriveSeasonId` / `activeLeagueSeason` 按 UTC 7/1 切季，而 `levelSeasonOf` 按北京时间 7/1 切季，每年 6/30 16:00–24:00 UTC 存在 8 小时边界差。
- **L2（待确认）**：`provider/budget.ts` 日桶按北京时间、月桶按 UTC，若上游 Provider 按 UTC 重置日额度，每日 00:00–08:00 北京时间可能有最多 8 小时偏差。
- **L3**：`postgres-document-db.ts:474-478` 中 `ROLLBACK` 失败时仍直接 `release()` 归还异常连接，建议改为 `release(error)`。
- **L4**：`CloudBaseWxDb.query` 未传 `order_by` 时仅靠 `skip` 分页（仅切换 CloudBase 时相关）。
- **L5**：`ops/vps/football-api.service` 与 `football-jobs.service` 硬编码 `User=neilxu` 及 `/home/neilxu/...`。
- **L6（待确认）**：仓库内未见 PostgreSQL 自动备份与恢复方案。

#### 14. 【核验三 & 四：体验微调与真机待复现项】
- **可顺手调整（非数据故障）**：领奖台与前 20 列表前三重复展示；周/赛季选择器遮住更新时间；解锁页 `profile` 缺入口绑定；`180ms` 切换防抖定时器未取消；详情比分下固定文案“开球时间”；本赛季标签直接显示 `2026_2027`；二级预测记录页自带底栏。
- **待微信环境复现（核验四）**：首页 `.feed` 底部 padding 是否被底栏遮挡（需真机/开发者工具实测后再定）。

---

## 三、上线前必须修复清单汇总

1. **【P0】登记 `LEVEL_FIRST_EVAL_AS_OF` + 周评估单用户异常隔离**（F1 + 核验一.1）
2. **【P0】`match-query` 与 `daily-consistency-snapshot` 改用动态赛季 `activeSeasonIds`**（F2）
3. **【P0】`board_snapshots` 查询下推数据库 + 增加历史快照清理/归档**（F3）
4. **【P0】打通改期/换 ID 比赛的 `canonical_match_id` 详情展示与结算归属**（核验一.2）
5. **【P1】优化 `listDueSeasonFinalIds`、`listDuePeriodKeys`、每日对账与周评估的 N+1/全量扫描，并补充租约续期**（H1–H4）
6. **【P1】将耗时周期任务与 3 分钟实时同步 `tick` 拆分隔离**（H5）
7. **【P1】新增日志、usage bucket、过期 `auth_sessions` 等表的定期清理任务**（H6）
8. **【P1】为 `pg.Pool` 增加 `pool.on("error")`、连接上限与查询超时**（H7）
9. **【P1】修复“我的”页登录入口错跳 & HTTP 401 自动清理并静默重登**（M2 + 核验二.3）
10. **【P1】首页比赛列表补充服务端 `my_prediction` 回显并解耦完场文案**（核验二.4）
11. **【P1】排行榜返回本人指标 + 群失效后提供切回全站路径**（核验二.5、二.6）
12. **【P2】同步修改前后端 `RANKING_FIRST_PERIOD_KEY` 占位值为正式发布周**（M4）

---

## 四、待补充确认事项

1. **预期用户规模与日活**：用于精确评估 H1–H4 的触发时间点。
2. **最低支持的微信基础库版本**及真机验证结果：确认 M3（`toLocaleString("sv-SE")`）与核验四（首页底栏遮挡）。
3. **服务器 PostgreSQL 备份方案**：确认是否已配置 `pg_dump` / WAL 归档（L6）。
4. **各 Provider 额度重置时区**：确认日额度按 UTC 还是北京时间重置（L2）。
