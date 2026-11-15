# 赛事预言家 MVP 2.0 代码审查报告（v1.0）

- 生成时间：2026-09-29 12:16（Asia/Shanghai）
- 审查对象：本次 MVP2.0 改造中修改过的源代码（生产代码 57 个文件 + 小程序 5 个文件，共 62 个）
- 审查依据：`docs/MVP__v2.0.md`（唯一业务基线）；辅助 `docs/MVP2.0_DEV_PLAN__v1.0.md`
- 审查口径：只查业务逻辑错误/规范冲突/边界与状态机问题/重大可优化点；**明确排除**防御性、安全性、健壮性、风格、命名、测试覆盖
- 执行方式：分 21 批，每批把「规范相关章节摘录 + 该批代码全文（带行号）」内嵌为单次任务书，模型单轮直出结论（不做无障碍探索）
  - batch-01~02：Claude Code 链路（cc-switch → sub2api → grok-latest）
  - batch-03~21：Codex CLI 链路（cc-switch → sub2api → grok-latest）
- 过程证据：`/root/claude-review/`（progress.log、findings/batch-*.md、logs/）

## 一、总览

**21/21 批全部完成（0 失败）· 共 62 条发现：严重 14 / 重要 43 / 优化 5**

| 批次 | 主题 | 发现（严/重/优） |
|---|---|---|
| 01 | 等级核心规则 | 2（0/2/0） |
| 02 | 时间/周期/枚举/配置 | 0（0/0/0） |
| 03 | 类型与数据库 Schema/索引 | 4（0/4/0） |
| 04 | 排行榜比较器与周期重建 | 3（1/2/0） |
| 05 | 周评估/修正重评/等级应用服务 | 4（2/1/1） |
| 06 | 结算账本应用与编排 | 5（1/3/1） |
| 07 | 统计重建 | 2（1/1/0） |
| 08 | 每日一致性快照与对账 | 4（2/1/1） |
| 09 | 排行榜查询/快照/封存/管理员重排 | 4（2/2/0） |
| 10 | 群组 | 3（1/2/0） |
| 11 | 比赛与预测查询 | 3（0/3/0） |
| 12 | 个人资料/会话/分享卡/用户统计重建 | 3（1/2/0） |
| 13 | API 层（admin/校验/限流/等级/分享卡） | 2（0/2/0） |
| 14 | API 层（预测/比赛/资料/排行） | 2（1/1/0） |
| 15 | 网关装配与种子 | 2（0/2/0） |
| 16 | Provider 映射/装载/赛程与球队同步 | 2（0/2/0） |
| 17 | Provider 状态核对/同步配置/触发器 | 3（0/2/1） |
| 18 | 内存仓储实现 | 4（1/3/0） |
| 19 | CloudBase 适配与重建支撑 | 2（1/1/0） |
| 20 | OpenAPI 合同文件（全量） | 6（0/5/1） |
| 21 | 小程序前端适配（R15） | 2（0/2/0） |

**主审说明**：全部 14 条「严重」已由主 agent 逐条对照规范原文与源码复核（结论见第二章各条末【主审复核】）；
其中 11 条属实、3 条存在异议（1 条误报、1 条部分不成立、1 条实为规范文本遗留）。
「重要/优化」级发现未逐条复核（保留原文与证据位置，供修复时按条核对；个别已复核者已注明）。

## 二、严重问题（14 条，逐条主审复核）

### 严重-1　历史周 rebuild 新建条目把 `is_final` 写成 false

> 来源：batch-04（排行榜比较器与周期重建）

- 位置：`src/application/ranking-rebuild-service.ts:234`、`src/application/ranking-rebuild-service.ts:245`
- 现状：`existing === null` 时固定 `is_final: false`；update 虽能保留旧标记，但空表/补洞 insert 不会按周期是否已结束赋值。
- 规范依据：§19.6「周期边界结束后 `is_final = true`……历史赛果修正仍允许修改历史聚合、重算历史 `global_rank`，`is_final` 保持 `true`」；§K88 历史周 `is_final=true` 后 correction 仍可改 rank。
- 影响：对已结束周做 35.2 重建（含空表全量回填）会得到整榜或混榜 `is_final=false`；历史周不会再走周期封存，错误状态会粘住。
- 建议修复：rebuild 写库前用 `serverNow` 与该 `period_key` 结束边界（或已有行的 `is_final`）判定；已结束周 insert/update 一律 `is_final=true`，未结束周才为 false。

**【主审复核】** 属实。insert 路径（新行/空表回填）硬编码 is_final:false，update 与清零路径保留旧标记（作者注释亦表明意图），因此历史周重建的「补洞」会留下 false 并粘住。建议按原修复方案：按 serverNow 与周期结束边界判定。

### 严重-2　无本周周评估时修正重评被永久延后

> 来源：batch-05（周评估/修正重评/等级应用服务）

- 位置：`src/application/level-correction-reeval.ts:77`、`src/application/level-correction-reeval.ts:277`、`src/application/weekly-level-eval.ts:252`
- 现状：`stateForCorrection` 在 `cycleAsOf <= asOf && !weeklyDone`（`week_base_as_of !== 本周周一 as_of`）时一律 `deferred=true`。`runPending(afterAsOf)` 只捞 `settled_at >= 本周 as_of` 的修正。
- 规范依据：§17.7.5「若本周该用户尚无周评估……则以当前状态为 week_base 执行」；§17.7.6 延后的是「周评估**任务**未完成」，不是「该用户没有本周周评估记录」。
- 影响：周一后才出现首场有效预测、随后发生 `score_delta≠0` 修正的用户会一直 defer；下周 `runPending` 也捞不到（`settled_at` 已小于新 `as_of`），生涯/赛季等级相对 `replay_level` 永久偏离。
- 建议修复：仅当本周周评估任务仍应对该 user/scope 执行且尚未落账时 defer；否则按 §17.7.5 用当前状态写入 `week_base` 并立即 `evaluate_level`。延后队列按 user/scope 重试，不要用「本周 as_of」截掉更早的 `settled_at`。

**【主审复核】** 属实。对照 §17.7 第 5/6 条：该用户本周尚无周评估时应「以当前状态为 week_base 执行」，延后仅针对「周评估任务未完成」。代码把两类情形混同（!weeklyDone 即 defer），且 runPending 的重试窗口会漏掉更早的 settled_at → 永久漏评。

### 严重-3　修正重评的「本周」划到了尚未发生的周一，变成额外评估而非改判

> 来源：batch-05（周评估/修正重评/等级应用服务）

- 位置：`src/application/level-correction-reeval.ts:56`、`src/application/level-correction-reeval.ts:84`、`src/application/level-correction-reeval.ts:80`
- 现状：`currentWeeklyCycleAsOf` 在 `(weekday===0 && hour<10) || weekday===6` 时返回**下一**个周一 10:00（此时 `cycleAsOf > asOf`，不 defer）。`useStoredBase` 为 false，从**当前等级**再跑一遍 `evaluate_level`。若该修正在周一评估之后才跑，`last_eval_as_of > asOf` 被标 `stale` 直接丢弃。
- 规范依据：§17.7.2「以 week_base（本周周评估之前的状态）为起点……结果替换本周周评估结论。week_base 不变」；§17.6.4「一次评估最多升/降一级」；§17.7.6「按 as_of 顺序串行」。
- 影响：周日/周一 10:00 前的修正会额外 +1 次升降/below_count（连续 2 周降级被提前触发，或一周升两级）；周一后再处理则改判丢失，与 `replay_level` 不一致。
- 建议修复：本周 `as_of` = 最近一个 `<= correction.as_of` 的周一 10:00。该周周评估已落账（或同周已有改判）则始终从存储的 `week_base` 重跑；不要把评估点之前的时间划进「下一周」。

**【主审复核】** 属实。周六/周日(10:00 前)被划到「下一个周一」（未来 cycle），useStoredBase=false 从当前等级重跑 → 变成额外评估（违反 §17.7.3「不会因修正额外 +1」）；周一后再处理又被 stale 丢弃。「本周」应取最近一个 ≤ asOf 的周一 10:00。

### 严重-4　item 应用完全缺失 month ranking 聚合与重算

> 来源：batch-06（结算账本应用与编排）

- 位置：`src/application/settlement-item-application-service.ts:452`、`144`、`167`、`220`、`228`、`521`
- 现状：`periodRefs` 只含 `PeriodType.Week`；`emptyRanking` / `lastScoringAt` / `rankingPeriodLockKey` / `rebuildGlobalRanks` 的 period 类型被写死为 Week。month 用户聚合与 `ranking:month:{period_key}` 重算均未发生。
- 规范依据：§15.5「week ranking 用户聚合增量 / month ranking 用户聚合增量必须位于同一原子工作单元」；§15.8「重算受影响 week rank 与 month rank，两者完成后才能进入 finalize」
- 影响：月榜 `period_score/valid_predictions/hits/last_scoring_match_at/global_rank` 永不随结算变化，月榜与 week/career 永久性分叉。
- 建议修复：对 `Week` 与 `Month` 各算 `period_key`，在同一 item 事务内对该用户两条 ranking 做当前值+delta；全部 item 完成后再分别持锁重算两个周期的 global_rank。

**【主审复核】** 复核有异议——对代码不成立：v2.0 多处明确「取消月榜」（§19.2/§27/§32/§34），实现仅做 week 是既定决策（S10 已专门清零月榜写路径）。但本条确凿暴露【规范文本遗留】：§15.5/§15.8 仍写「month ranking / 重算 month rank」，与 §19 矛盾。建议修订规范文本，不要按本条改代码。

### 严重-5　等级回放把当前缓存当作 initialState，rebuild 无法独立纠错

> 来源：batch-07（统计重建）

- 位置：`src/application/stats-rebuild-service.ts:159`、`src/application/stats-rebuild-service.ts:174`、`src/application/stats-rebuild-service.ts:321`、`src/application/stats-rebuild-service.ts:404`
- 现状：`replayScope` 用缓存的 `level` / `below_count` 作为 `replayLevel.initialState`，再从 `firstEvalAsOf` 回放到 `untilAsOf`；无评估时 `storedLevelState` 直接 `return existing`。
- 规范依据：§35.1「career 与各未冻结等级赛季的等级状态按 `replay_level` 回放……回放结果与缓存不同 ⇒ 覆盖缓存」；`career_best_level` 才是「现有值 / history / 回放轨迹」三者事后取 max。
- 影响：等级有保护期与 `below_count` 滞后，路径依赖。从错误的「当前等级」当周 1 起点回放，会得到错误轨迹；损坏的 `level_state` 在无评估时也不会被清掉。Rebuild 失去纠错能力。
- 建议修复：回放起点固定为创世态 `{level:1, best_level:1, below_count:0}`；`best_level` 仅在回放结束后按 `max(现有, history.to_level 最大, 回放最大)` 封顶。无评估则写 `defaultLevelState()`，不要回落旧缓存。

**【主审复核】** 复核部分不成立：replayLevel 的事件 fold 实际硬编码从创世态 {level:1, best_level:1, below_count:0} 起步（initialState 只影响「无评估」早退分支），主论点「从缓存等级起步回放得到错误轨迹」不成立；残留真实边缘问题=无评估 scope 时不清零缓存（低影响）。建议低优先级处理。

### 严重-6　活跃结算只跳过用户行，未跳过受影响周周期的 `global_rank`

> 来源：batch-08（每日一致性快照与对账）

- 位置：`src/application/daily-consistency.ts:250`、`src/application/daily-consistency.ts:298`；`src/application/daily-consistency-snapshot.ts:505`
- 现状：`activeUserPeriods` 按 `period+user` 跳过；同周其他用户的 `global_rank` 仍做终态比较。`activeSettlementScopes` 在 `period_anchor_at == null` 时 `periods=[]`，连该 user-period 都不跳过。
- 规范依据：§34.5「不得对正在 settling/correcting 的 match 及其受影响用户/**周期**做最终一致性判断」；§34.3「受影响 week **全量重新排序**并写 `global_rank`」
- 影响：结算/纠错进行中，整周名次都在重排，日常对账会对未预测该场的用户误报 `global_rank`。
- 建议修复：活跃 match 的 week `period_key` 整周期跳过 rankings（至少跳过 `global_rank`）；`period_anchor_at` 缺失时也要能定位并跳过受影响周。

**【主审复核】** 属实。跳过范围只到 (period,user)，同一受影响周其他用户的 global_rank 仍参与比对；结算中全周重排 → 稳定误报。注：后果是「对账误报」（只报警不改账），非数据损坏。

### 严重-7　board snapshot 用「未更新用户」子集重放 Top 榜，名次/入榜集合 expected 错误

> 来源：batch-08（每日一致性快照与对账）

- 位置：`src/application/daily-consistency-snapshot.ts:204`、`src/application/daily-consistency-snapshot.ts:219`；`src/application/daily-consistency.ts:318`
- 现状：`expected` 由 `stableUsers`（`updated_at <= snapshot_at`）调用 `buildBoardSnapshotEntries` 生成；任一用户变更则把交集行的 `expected.rank` 改成 `actual.rank`；活跃结算用户在比较阶段才 `continue`，load 时仍参与排序。
- 规范依据：§34.5「`board_snapshots`（career/strength）…从事实数据重算并比较」；§34.4「排序与入榜门槛见第 19.1/19.5 节」（Top 榜是全量排序的函数，不能用子集重放）
- 影响：快照后任意用户更新（常见）会改变入榜集合，对「本不应出现/消失」的用户误报；`rank` 实际不再校验；活跃结算用户会带动其他用户名次误报。
- 建议修复：payload 字段只比对 `updated_at <= snapshot_at` 且非活跃结算的用户；全站排序未闭合时整张快照 `rank`/入榜集合记 skip，下一轮再比，禁止子集重放 TopN。

**【主审复核】** 属实。expected 用 stableUsers 子集调用 buildBoardSnapshotEntries 生成（子集排序≠全量 TopN），且一旦有用户变更就把 expected.rank 覆盖为 actual.rank（等于关闭 rank 校验）→ 名次/入榜集合比对失真。

### 严重-8　生涯/实力「我的名次」把快照滞后当成 500

> 来源：batch-09（排行榜查询/快照/封存/管理员重排）

- 位置：`src/application/ranking-query.ts:417`
- 现状：用户不在最新快照时，用 **live** `career_valid_predictions` / `last_eval_n` 判定「快照缺人」并 `internalError`。
- 规范依据：§19.1/§34.4「生涯榜每 60 分钟快照、实力榜评估后/每日快照」；§19.7「我的名次必须来自快照」；§19.3 `not_participated`/`below_threshold`；§27.1 的 500 仅用于事实/快照 **损坏**，不是设计内延迟。
- 影响：用户首次有效预测后最多 60 分钟内，生涯榜 `GET /v1/rankings` 对本人稳定 500；实力榜在评估已写入 `last_eval_n`、快照未落地的窗口同样 500。
- 建议修复：`me` 只按 **本份快照是否入榜** 判定。不在快照：实力且 `n<50` → `below_threshold`，否则 `not_participated`。禁止用 live 达标去打 500。

**【主审复核】** 属实。用户不在最新快照时用 live 字段判「快照缺人」并 internalError(500)；§27.1 的 500 仅指事实/快照损坏，设计内滞后窗口应返回 below_threshold / not_participated。

### 严重-9　空快照不落新版本，旧榜会永久卡住

> 来源：batch-09（排行榜查询/快照/封存/管理员重排）

- 位置：`src/application/board-snapshot.ts:158`
- 现状：`buildBoardSnapshotEntries` 为空时不 `insert`，直接返回 `[]`；查询走 `findLatestByBoard`。
- 规范依据：§19.1/§27.1「只返回符合入榜门槛的用户」；§34.4 定期全量生成 `board_snapshots` 最新版本。
- 影响：入榜人数从 N→0（全员注销、实力窗口掉到 `<50`）时不产生新 `snapshot_at`，最新快照仍是旧 TopN，门槛失效且无法自愈。
- 建议修复：每次生成必须推进版本（快照头/哨兵行，或先作废旧 `snapshot_at` 再写入，允许 0 行也更新 `updated_at`）。

**【主审复核】** 属实。空快照（入榜人数归零）不插入任何行 → 不产生新版本，findLatestByBoard 仍返回旧 TopN，旧榜永久驻留。边缘场景，修复成本低（哨兵行或版本头）。

### 严重-10　创建群把已解散群计入拥有上限，变成终身只能建 5 个群

> 来源：batch-10（群组）

- 位置：`src/application/groups.ts:165`
- 现状：`owned = findByOwner(userId)` 后直接 `owned.length >= USER_MAX_GROUPS_OWNED` 即拒绝；同文件加入上限会对 membership 过滤 `status === Active`，此处未过滤 `GroupStatus.Active`。解散只改 `groups.status`，群主记录仍在。
- 规范依据：§27.2「当前用户已拥有的群数 `< USER_MAX_GROUPS_OWNED(5)`，否则 `409 GROUP_OWNED_LIMIT_REACHED`」；解散为软删除「`groups.status -> dissolved`；群继续存在于历史数据中，不物理删除」。
- 影响：解散 5 个群后无法再创建；拥有上限从并发约束变成终身配额。
- 建议修复：事务内只统计 `status === Active` 的拥有群；解散群不得占创建名额。

**【主审复核】** 属实。findGroupsByOwner 不过滤 status，已解散群占用创建上限。规范 §27.2 文本未明确「已拥有」是否含解散群，建议按 Active 口径修复并顺手澄清措辞（与加入上限的过滤口径一致）。

### 严重-11　分享卡 `career_points` 现场累加，未用用户缓存

> 来源：batch-12（个人资料/会话/分享卡/用户统计重建）

- 位置：`src/application/share-card.ts:145`、`src/application/share-card.ts:154`、`src/application/share-card.ts:184`
- 现状：先把用户全部「当前已结算」预测的 `match_score` 加总进 `careerPoints`，响应里用该和作为 `career_points`，完全不读 `user.career_points`。
- 规范依据：§20「分享卡所需：…生涯积分」；round 统计才允许「从 predictions + matches + 当前已结算结果计算」；§24.2/24.5 生涯积分口径是用户缓存字段，须与资料接口自洽。
- 影响：资料卡与分享卡积分分裂。比赛处于 `correcting`/版本未对齐时，该场分从分享卡生涯积分中消失，但 `users.career_points` 仍保留上次已 applied 分。
- 建议修复：`career_points` 直接取 `user.career_points`。现场计算仅保留指定 `league_id+round_id` 的 round 四项。

**【主审复核】** 属实，主审建议降级为「重要」：分享卡 career_points 用现场求和而非用户缓存；正常态两值一致，仅 correcting/版本未对齐窗口产生分歧。修复方向（读缓存）与 §24 口径一致，采纳。

### 严重-12　缺少可信身份走 conflictError，HTTP 会落成 409 而非 401

> 来源：batch-14（API 层（预测/比赛/资料/排行））

- 位置：`src/api/v1/predictions.ts:61`、`src/api/v1/predictions.ts:128`、`src/api/v1/profile.ts:78`
- 现状：`requireAuthenticatedUserId` / `requireAuthenticatedUserIdForRead` 在 `authenticated_user_id` 缺失或空串时 `throw conflictError("UNAUTHORIZED", ...)`。同层 `validationError` 绑定 422，`conflictError` 按命名与 §23.5 对应 409 业务冲突。
- 规范依据：§23.5「`UNAUTHORIZED` 是『缺少可信身份』这一条件唯一的 HTTP 错误 `code`」且 HTTP 为 401、409 仅用于业务/版本冲突；§26.2 失败表「缺少可信身份 | 401 | `UNAUTHORIZED`」，与同表「已注销 | 409 | `USER_DELETED`」必须分开。
- 影响：登录缺失可能被客户端当成业务冲突；按 401 跳转登录会失效，并与注销冲突码挤在同一 HTTP 类。
- 建议修复：改用固定 HTTP 401、`code=UNAUTHORIZED` 的错误工厂；`conflictError` 只留给 `USER_DELETED` / `PREDICTION_LOCKED` 等 409。

**【主审复核】** 复核：误报。错误→HTTP 映射按 code 进行（STATUS_BY_CODE: UNAUTHORIZED→401），gateway/http.ts、gateway/assemble.ts、cloud-function 三个入口统一走 mapErrorToHttp；conflictError("UNAUTHORIZED") 实际返回 HTTP 401 + code UNAUTHORIZED，符合 §23.5。仅工厂函数命名不佳（属风格，不在审查范围）。可忽略。

### 严重-13　用户/赛季等级增量不变量未在 update 强制

> 来源：batch-18（内存仓储实现）

- 位置：`src/infrastructure/repositories.ts:916`、`src/infrastructure/repositories.ts:1603`
- 现状：`updateUser` / `updateUserSeasonStats` 只对**新文档**调用 `assertUserCareerInvariants` / `assertSeasonStatsInvariants`，不对比旧行。`career_best_level` / `best_level` 可被改小；`is_level_frozen=true` 时仍可改 `level`/`best_level`。
- 规范依据：§21.1「`career_best_level >= career_level` 必须始终成立，且只增不减。」；§21.2「Invariant：同 `users` 对应项；另加 `is_level_frozen = true` 的赛季 `level`/`best_level` 不再变化。」
- 影响：定级回放、生涯/赛季榜、重建统计会把已封存等级改掉或把历史最高等级打回，账本不可逆污染。
- 建议修复：与 `match.result_version` 一样做旧→新校验：`best_level` 不得变小；若 `old.is_level_frozen===true`，拒绝任何 `level`/`best_level` 变化（允许改 points 等非冻结字段）。

**【主审复核】** 属实。updateUser / updateUserSeasonStats 只校验「新文档」，未做旧→新对比：career_best_level 可被改小、is_level_frozen=true 的赛季 level/best_level 可被改动。内存仓储是对外语义的参照实现，建议补齐（§21.1/§21.2/§40）。

### 严重-14　读用户时丢弃 `career_level_state`，回写会覆盖定级缓存

> 来源：batch-19（CloudBase 适配与重建支撑）

- 位置：`src/infrastructure/cloudbase-repository.ts:326`；对照写入侧 `src/infrastructure/cloudbase-repository.ts:291`
- 现状：`toDocument` 会持久化 `user.career_level_state`，但 `fromDocument` 固定 `career_level_state: defaultLevelState()`，不读取文档中的 `below_count` / `week_base_*` / `last_eval_*`。`findByOpenid` 已接线；随后 `update()` 是整文档 `set`。
- 规范依据：§21.1「`career_level_state` 为持久化 object（含 `last_eval_n`/`last_eval_score_sum` 等）」；§35.1「career 与各未冻结等级赛季的等级状态按 `replay_level` 回放；回放结果与缓存不同 ⇒ 覆盖缓存」——缓存必须能被读出，不能在仓储层被重置。
- 影响：读出的 `career_level` 与空定级状态脱节；任何 load→update 会把真实定级缓存打回默认，实力榜输入（§35.4）和后续 rebuild/周评都会错。
- 建议修复：`fromDocument` 按 §21.1 解析并回填 `raw.career_level_state`（缺字段再 default）；禁止用 `defaultLevelState()` 覆盖已持久化状态。`update` 不得把读损的默认状态写回。

**【主审复核】** 属实。fromDocument 丢弃已持久化的 career_level_state（固定 defaultLevelState()），load→update（整文档 set）会把真实定级缓存打回默认。CloudBase 适配当前尚未接线（B1 待办），上线前必修。


## 三、重要问题（43 条，按批次）

### batch-01　等级核心规则

#### F1 [重要] 赛季 invariant 遗漏「Lv≥2 ⇒ 有效预测累计 ≥ 20」
- 位置：src/domain/invariants.ts:95-113（对照 src/domain/invariants.ts:81-84）
- 现状：`assertUserCareerInvariants` 有 `career_level < 2 || career_valid_predictions >= LEVEL_RATED_MIN_VALID`；`assertSeasonStatsInvariants` 只校验 `1..6` 与 `best_level >= level`，未校验赛季 `valid_predictions`。
- 规范依据：§40「`level >= 2 => 对应 scope 有效预测累计 >= 20`」；§17.3「season scope 用该赛季 `valid_predictions`（均为累计）」
- 影响：赛季文档被写成 `level>=2` 且 `valid_predictions<20` 时不会在事务前后被拦下，与生涯 scope 不对称。
- 建议修复：在 `assertSeasonStatsInvariants` 增加与生涯同构断言：`stats.level < 2 || stats.valid_predictions >= FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID`。

#### F2 [重要] level_history 未校验非 rebuild 单步 |Δlevel|≤1
- 位置：src/domain/invariants.ts:128-139
- 现状：只断言 `from_level !== to_level` 与 `reason ∈ {weekly_eval, correction_reeval, rebuild}`，未按 reason 限制跨级幅度。
- 规范依据：§40「非 rebuild 的相邻两次状态：`|to_level - from_level| <= 1`」；§17.9.3「写一条 `level_history(reason=rebuild)`（允许跨多级）」
- 影响：`weekly_eval` / `correction_reeval` 若被写成跨多级（如 2→5），本模块不会视为数据损坏；与 `evaluateLevel` 一次最多一级的状态机脱节。
- 建议修复：`reason !== "rebuild"` 时断言 `Math.abs(entry.to_level - entry.from_level) <= 1`；`rebuild` 保持允许跨多级。

### batch-03　类型与数据库 Schema/索引

#### F1 [重要] 领域类型把 §21 必填字段标成 optional，与 Collection 契约不一致
- 位置：`src/domain/types.ts:92`、`src/domain/types.ts:95`、`src/domain/types.ts:110`、`src/domain/types.ts:111`、`src/domain/types.ts:118`
- 现状：`User.career_last_scoring_match_at?` / `career_level_state?`、`UserSeasonStats.level_state?` / `is_level_frozen?`、`Team.league_id?` 均可缺省；`collections.ts` 对应字段均为 `required: true`（`career_last_scoring_match_at` 为必填可空）。
- 规范依据：§21.1「`career_level_state object`（非可选）」；§21.2「`level_state` 同结构、`is_level_frozen bool, default false`」及「`is_level_frozen = true` 的赛季 `level`/`best_level` 不再变化」；§21.3「`league_id` required」
- 影响：写入方可省略定级状态/冻结标记/所属联赛；缺字段时 `is_level_frozen` 被当成 false，冻结赛季仍可改级；生涯并列键缺席与 `null` 排序不一致。
- 建议修复：与 `collections.ts` 对齐：必填字段去掉 `?`；可空仅用 `| null`。`is_level_frozen`/`career_level_state`/`league_id` 必须始终存在。

#### F2 [重要] `LevelHistoryEntry` 将 v3 定级截面做成可选，无法作为回放事实
- 位置：`src/domain/types.ts:271`、`src/domain/types.ts:275`、`src/domain/types.ts:276`、`src/domain/types.ts:277`、`src/domain/types.ts:278`、`src/domain/types.ts:279`、`src/domain/types.ts:280`
- 现状：`eval_as_of` / `window_n` / `window_score_sum` / `b_points` / `level_rule_version` 均为 `?`；`level_season_id`/`settlement_id` 也是 `?`。`collections.ts` 中前五项 `required: true`，后两项为必填可空。
- 规范依据：§21.13「`eval_as_of`/`window_n`/`window_score_sum`/`b_points`/`level_rule_version` 必填；`scope=season` 时 `level_season_id` required，`scope=career` 必须 null；`reason=correction_reeval` 时 `settlement_id` 必填；删除 v1 的 `wdl_hits`/`valid_predictions` 快照，改为记录 v3 定级输入截面」
- 影响：可写入缺截面的 history，weekly_eval / correction_reeval 无法按 `n/S/B` 回放，与「仅 `from_level != to_level` 时写入」的事实表定位冲突。
- 建议修复：v3 截面改为必填；`level_season_id`/`settlement_id` 用 `string | null`（不要 `?`），由写入方按 scope/reason 填值或显式 null。

#### F3 [重要] `matches.season_id` 未标 immutable，还套了全局 default
- 位置：`src/schema/collections.ts:132`
- 现状：`season_id: { type: "string", required: true, default: "2026_2027" }`；同表 `league_id`/`round_id` 已 `immutable: true`，`season_id` 没有。
- 规范依据：§21.5「`season_id` 必须等于该 `league_id` 在第 1.4 节表中当前登记的 `season_id`, immutable」
- 影响：赛程写入漏填时会落到单一默认赛季，且事后可改 `season_id`，周榜 period、等级赛季口径会串季。
- 建议修复：加 `immutable: true`；去掉全局 default，创建时按联赛当前登记 `season_id` 写入。

#### F4 [重要] `level_state` 只声明 `object`，嵌套取值域与不变式未进入 schema
- 位置：`src/schema/collections.ts:50`、`src/schema/collections.ts:69`；对照 `src/domain/types.ts:55`
- 现状：`career_level_state`/`level_state` 均为 `{ type: "object", required: true }`，无 `below_count`/`last_eval_n`/`last_eval_score_sum` 等子字段；`LevelState` 也全是无界 `number`。
- 规范依据：§21.1「`below_count` int 0..1；`week_base_level` 1..6|null；`last_eval_n` int >=0 default 0；`last_eval_score_sum`/`last_eval_b_points` int >=0」及 Invariant「`0 <= last_eval_score_sum <= 12 * last_eval_n`；`last_eval_n <= 300`」；§21.2「Invariant 同 `users` 对应项」
- 影响：可持久化 `below_count>1`、`n>300`、`S>12n` 的定级状态，周评估/纠回放会读到非法截面。
- 建议修复：为 `FieldDef` 增加嵌套 `fields`，按 21.1 写出 `level_state` 子字段（含 min/max/nullable/default）；`last_eval_n` max=300。

### batch-04　排行榜比较器与周期重建

#### F2 [重要] 当前周 rebuild 未在重排时剔除已注销用户
- 位置：`src/application/ranking-rebuild-service.ts:221`、`src/application/ranking-rebuild.ts:229`
- 现状：账本用户全部进入 `compareRankingEntry` 并分配 `global_rank`；服务层不读 `users.status`，当前周与历史周无分支。
- 规范依据：§19.7「已注销用户：不进入本周榜/生涯榜/实力榜的当前排序（重排与快照时过滤）；已 `is_final` 的历史周榜保持原样」。
- 影响：当前周 admin rebuild 会让已注销用户占名次，在榜用户名次整体后移；若展示层再滤掉，会出现 1,2,4… 空洞。历史周若误滤则会违反「保持原样」。
- 建议修复：仅当目标周未封存/为当前周时，重建结果去掉已注销用户后重编号；`is_final=true` 的历史周保留注销用户并照常重算 rank。

#### F3 [重要] `rebuild_board_snapshot` 未检查 settling/correcting
- 位置：`src/application/ranking-rebuild-service.ts:296`、`src/application/ranking-rebuild-service.ts:327`（对照同文件 `:194` 周期路径有检查）
- 现状：career/strength 快照 rebuild 只拿 maintenance lock 后直接 `writeBoardSnapshotInTransaction`；周期 rebuild 会对目标周比赛调用 `activeSettlement` 并 409。
- 规范依据：§35.3「目标用户/目标周期不存在相关 `settling/correcting` match。否则返回 `409 SETTLEMENT_ALREADY_RUNNING`」；§35.4 快照以 `users` / 等级缓存为源，结算过程中这些字段会被改写。
- 影响：结算未完成时覆盖「当前版本」快照，Top20 / 我的名次会出现半结算截面，且不保留被覆盖前的当前版本（§35.4）。
- 建议修复：与 35.2 对齐——存在任一 `settling/correcting` 比赛则 409；通过后再拍 career/strength 快照。

### batch-05　周评估/修正重评/等级应用服务

#### F3 [重要] 修正重评窗口截止时刻与 `last_inputs.as_of` 不是同一截面
- 位置：`src/application/level-correction-reeval.ts:331`、`src/application/level-correction-reeval.ts:418`、`src/application/level-correction-reeval.ts:470`
- 现状：构图用 `buildLevelInputs(..., new Date(asOf.getTime()+1))`，但 `last_eval_as_of` / history `eval_as_of` 仍存 `settlements.settled_at`。周评估则用裸 `asOf`。
- 规范依据：§17.5.1「`applied_at < as_of`」；§17.7.1「`as_of = settlements.settled_at`」；§17.9.4「`last_inputs`（n、S、B）与账本在 `last_inputs.as_of` 截面的重算值一致」。
- 影响：`applied_at == settled_at` 的 item 会进修正窗口却进不了按 `last_inputs.as_of` 的一致性重算；daily consistency 必报假差，或反过来漏掉本次修正。
- 建议修复：构图 cutoff 与持久化 `last_inputs.as_of` 用同一时刻。若必须包含当日 applied 的 correction item，应保证 `applied_at < settled_at`，而不是 +1ms 却仍把 as_of 写成 `settled_at`。

### batch-06　结算账本应用与编排

#### F2 [重要] global_rank 在每个 item 事务内全表重算，相位与锁语义都错
- 位置：`src/application/settlement-item-application-service.ts:228`、`521`；`src/application/settlement-orchestration-service.ts:1`
- 现状：每个 item 写入该用户聚合后立刻 `rebuildGlobalRanks`，扫描并更新该 week 下**所有用户**的 `global_rank`，锁失败还抛 `SETTLEMENT_ALREADY_RUNNING`。编排层没有 `apply_items → rebuild_ranks → finalize` 分相。
- 规范依据：§14.2 phase=`prepare/apply_items/rebuild_ranks/finalize/done`；§15.5 item 原子单元只含**该用户** week/month 聚合增量，不含全局名次；§15.8「完成全部 item 后」用 `ranking:{period_type}:{period_key}` 重算，完成后才能 finalize
- 影响：未完成 settlement 就会改写全周期名次；item 与全表 rank 锁耦合，一次 rank 锁冲突即可把当前 item 打成失败；错误码会让编排误判「本场 settlement 已在跑」。
- 建议修复：item 事务只更新对应用户聚合并把 `global_rank` 留空/保持；settlement 全部 item 成功后再按 week、month 各加一次 rank 锁重算，成功才 finalize。rank 锁冲突用独立错误码。

#### F3 [重要] item 原子单元未包含 level / level_history，且重评阻断版本队列
- 位置：`src/application/settlement-item-application-service.ts:410`、`445`、`508`；`src/application/settlement-orchestration-service.ts:47`、`87`、`173`、`180`
- 现状：item 事务只改 career/season 的 points/hits 与 unlock，不改 `career_level`/`season.level`/`level_history`。`correct()` / `continuePendingCorrections` 在启动下一 `result_version` 前先跑 `LevelCorrectionReeval`，`kind !== completed` 直接抛错中断循环。
- 规范依据：§15.5「level 当前值变化、必要的 level_history 必须与 prediction/聚合/item applied 同一事务」；§15.3/§15.9「v2 完成后才能执行 v3，按最小未处理 result_version 启动下一 correction，不得遗漏后续版本」
- 影响：等级缓存与账本增量非原子；更严重的是 vN 已 `settled/correcting` 后，重评 defer 会阻止 vN+1 入队执行，赛果版本队列被等级任务卡住。
- 建议修复：item 事务内按 §16.2 处理未冻结赛季的 level/level_history（冻结则只改四点计数）；版本队列推进与等级重评解耦，先按升序应用完未处理 version，再异步重评。

#### F4 [重要] `startFirst` 丢弃后续 correction 结果，失败场次会被当成首次成功
- 位置：`src/application/settlement-orchestration-service.ts:121`、`139`、`167`
- 现状：`startFirst` 在 `kind==="started"` 后调用 `continuePendingCorrections` 但忽略返回值；同文件 `retry` 会把后续 `failed` 映射出去，`correct` 会 `return continued ?? first`。
- 规范依据：§15.9「若 `result_version > v`：settlement 标 settled，match 标 correcting，随后按最小未处理版本启动下一 correction」；§11.2 `settling→correcting`、`correcting→failed` 必须走同一套转移，不得把后续版本遗漏成「首次已成功」
- 影响：首次 finalize 时已出现 v2/v3，correction 失败后调用方仍拿到 first 成功；match 已 `failed` 却无人按失败重试，版本队列停住。
- 建议修复：与 `retry`/`correct` 对齐：后续 `failed`/`already_running` 必须返回给调用方；`started` 且仍 `correcting` 时至少返回可观测的 correcting/failed，而不是吞掉。

### batch-07　统计重建

#### F2 [重要] 未重建 `career_last_scoring_match_at`，生涯并列键与账本脱节
- 位置：`src/application/stats-rebuild.ts:30`、`src/application/stats-rebuild-service.ts:353`
- 现状：`RebuiltCareerStats` 只有 points/valid/wdl/exact；`updatedUser` 用 `...user` 原样保留旧 `career_last_scoring_match_at`。
- 规范依据：§16.1「`career_last_scoring_match_at`（……取当前有效预测中 `match_score > 0` 的 `period_anchor_at` 最大值）」；§35.1 期望值必须以 `status=applied` 的 `settlement_items` + `period_anchor_at` 为唯一事实源；§35.4 career 快照从该字段重算排序。
- 影响：赛果修正/坏账修复后积分已按账本重算，并列键仍是旧缓存。随后 `rebuild_board_snapshot(career)` 会按错误并列键排序。
- 建议修复：按 §35.2 同款规则：每个 prediction 取最高 `source_result_version` 的 applied item，`new_score > 0` 时对其 `match.period_anchor_at` 取 max，写入 `users.career_last_scoring_match_at`（无得分则为空/epoch，与 15.7 一致）。

### batch-08　每日一致性快照与对账

#### F3 [重要] 等级重算后的 expected.best_level 未覆盖新 level，expected 自相矛盾
- 位置：`src/application/daily-consistency-snapshot.ts:333`、`src/application/daily-consistency-snapshot.ts:345`
- 现状：`evaluateLevel` 后只写 `level/below_count`；`best_level = max(缓存 best, 缓存 level, history)`，不含本次重算 `level`。缓存 3/3、重算升到 4 时，expected 变成 `level=4, best_level=3`。
- 规范依据：§16.1「`career_level` / `career_best_level` / `career_level_state`（取值域 1..6）」；§34.5 要求 career / `user_season_stats` 含等级状态一并比较
- 影响：升档场景下 expected 内部不合法，可能只报 `level`、漏报 `best_level`，或与真实缓存（best 会随升档更新）对不齐。
- 建议修复：`best_level = max(缓存 best, 重算 level, historyMax)`；若 `evaluateLevel` 返回 `best_level` 则直接采用。

### batch-09　排行榜查询/快照/封存/管理员重排

#### F3 [重要] 封存改写 `updated_at`，本周榜更新时间变成封榜时刻
- 位置：`src/application/period-finalize.ts:24`；`src/application/ranking-query.ts:365`
- 现状：`finalizeRankingEntry` 在置 `is_final` 时把 `updated_at=serverNow`；查询用全表 `max(updated_at)`。
- 规范依据：§19.3「本周榜 `updated_at` = 该周期最近一次 **重排完成** 时刻」；§19.6 封存只把 `is_final=true`，修正仍可重算 rank。
- 影响：周期结束后无新结算时，顶部更新时间被拨到封存任务时间，不是最后一次 `global_rank` 重排。
- 建议修复：封存只改 `is_final`，不动 `updated_at`；查询仍取重排写入的时间。

#### F4 [重要] 「历史周」按行 `is_final` 判断，能打乱封榜语义并产生重复名次
- 位置：`src/application/ranking-query.ts:388`
- 现状：`historicalWeek` / `keepHistoricalRank` 看 **单条** `is_final`。周期已结束但任务未跑完：已注销用户被剔除并 `index+1` 重排。封存后又写入 `is_final=false` 的新行时：部分用 `global_rank`、部分用 `index+1`。
- 规范依据：§19.6「周期边界结束后 `is_final=true`，整周不再当当前榜」；§19.7「已 `is_final` 的历史周榜保持原样」；§19.5「不存在相同 rank」。
- 影响：已结束周在封存前会被改写；混旗下周榜可出现两个 `rank=1`。
- 建议修复：用 `periodEndAt(period_key) <= server_now` 作为周期已结束；已结束 + `scope=global` 一律保留 `global_rank` 与已注销用户，不要按行切换两套名次。

### batch-10　群组

#### F2 [重要] 创建群不校验加入上限，可把已加入群数做到 21–25
- 位置：`src/application/groups.ts:154`；对比 `src/application/groups.ts:223`
- 现状：`createGroup` 只拦拥有数；成功路径会 `insert` 群主 `Active` 成员。`joinGroup` 才拦 `activeMemberships.length >= USER_MAX_GROUPS_JOINED`。已加入 20 且拥有 `< 5` 时仍可建群。
- 规范依据：§27.2 加入判定「当前用户已加入群数 `>= USER_MAX_GROUPS_JOINED(20)` → `409 GROUP_JOIN_LIMIT_REACHED`」；创建成功后群主计入 `member_count`，属于已加入。
- 影响：加入上限可被创建口绕过，实际成员身份数超过 20。
- 建议修复：创建前与加入共用同一套 active 成员数校验，命中则 `GROUP_JOIN_LIMIT_REACHED`（拥有上限仍另判）。

#### F3 [重要] GET 群接口走写操作限流桶，读请求会打满创建/加入配额
- 位置：`src/api/v1/groups.ts:65`、`src/api/v1/groups.ts:111`、`src/api/v1/groups.ts:127`
- 现状：`getMyGroups` / `getGroup` 与创建/加入/退出/解散一样调用 `check("groups", userId)`。
- 规范依据：§36.4「`POST /groups*` 10 requests/min/user # 创建/加入/退出/解散群」；「`authenticated reads` 120 requests/min/user」。
- 影响：列群/看群 10 次即用尽写配额；读限流从 120/min 被压成 10/min。
- 建议修复：写接口保留 `groups` 桶；`GET /v1/groups/me` 与 `GET /v1/groups/:group_id` 改走 authenticated reads 桶。

### batch-11　比赛与预测查询

#### F1 [重要] 预测历史分页未继续使用 cursor 绑定筛选
- 位置：`src/application/prediction-query.ts:250`、`src/application/prediction-query.ts:253`
- 现状：`league_id`/`season_id` 先按缺省收成 `null`，再与 cursor 绑定值做全等；后续页只带 `cursor`（或不带原筛选）会 422。对比 `src/application/match-query.ts:220` 是 `input ?? cursor`，仅显式参数冲突才 422。
- 规范依据：§26.2「带 cursor 的请求必须继续使用 cursor 绑定的 `league_id`/`season_id`；显式参数与其冲突返回 `422`。`limit` 不属于筛选条件」
- 影响：按规范用 opaque cursor 翻页时，带联赛/赛季筛选的第二页会被拒绝，分页中断。
- 建议修复：与比赛列表相同：省略时用 cursor 绑定值；仅当请求显式给出且与绑定值不同时 422。

#### F2 [重要] 取消比赛的历史预测未清空结算字段
- 位置：`src/application/prediction-query.ts:306`
- 现状：只在双方正式比分都非 null 时回传 `match_score`/`wdl_hit`/`exact_hit`，未看 `match_status === cancelled`。
- 规范依据：§26.2「取消比赛也保持预测结算字段为 `null`（第 9.4/21.8 节）」
- 影响：若取消赛仍留有正式比分或预测上已有结算值，历史列表会展示 0/3/12 与命中，与取消不结算冲突。
- 建议修复：`cancelled` 时这三项固定 `null`；正式比分缺失时维持现有置 null。

#### F3 [重要] 预测详情未按「无正式比分则结算为 null」输出
- 位置：`src/application/prediction-query.ts:189`；对比 `src/application/prediction-query.ts:306`
- 现状：`getMyPrediction` 直接返回 `prediction.match_score`/`wdl_hit`/`exact_hit`；列表在 `regular_*` 缺失时已强制 `null`。
- 规范依据：§26.2「正式比分缺失时，`regular_home_score`、`regular_away_score`、`match_score`、`wdl_hit`、`exact_hit` 均返回 `null`；不得用 `0` 表达缺失」
- 影响：同一预测在 `/predictions/me` 与 `/predictions/me/:id` 结算不一致；无赛果时详情可能打出 `0` 分。
- 建议修复：详情与列表共用同一投影：无完整正式比分（及 F2 的取消赛）时结算三字段为 `null`。

### batch-12　个人资料/会话/分享卡/用户统计重建

#### F2 [重要] round 统计未按 `user_id+league_id` 索引筛选
- 位置：`src/application/share-card.ts:131`、`src/application/share-card.ts:133`、`src/application/share-card.ts:156`
- 现状：`predictions.findByUser(userId)` 拉齐该用户全部预测，再对每条 `matches.findById`，最后才在内存里按联赛/轮次过滤。
- 规范依据：§20「按 `user_id + league_id` 通过索引筛选，禁止全库扫描（第 42.1 节）」；「不同联赛的 `round_id` 互不可比、不得合并统计」。
- 影响：查询契约被破坏；用户预测一多即放大为全量+N+1。虽 round 循环有联赛过滤，读取阶段已跨联赛合并。
- 建议修复：仓储按 `user_id+league_id`（及 round/season 若有覆盖索引）取数，只加载目标联赛比赛后再算 round 统计。

#### F3 [重要] 用户统计重建并发冲突误用结算错误码
- 位置：`src/application/admin-rebuild-user-stats.ts:112`
- 现状：未抢到 `userStatsRebuildLockKey` 时 `throw conflictError("SETTLEMENT_ALREADY_RUNNING", "目标用户存在并发 rebuild")`。
- 规范依据：§30.4 决策表将 `409 SETTLEMENT_ALREADY_RUNNING` 专用于 match `settling/correcting` 或存在 `status=running` 的 settlement；§30.5 用户重建是另一写操作，不得复用结算状态机码。
- 影响：客户端/运维会当成「该用户有结算在跑」；与真正的重试结算 409 无法区分，可能误走结算排障。
- 建议修复：换与 rebuild 语义一致的 409 码（若规范未单列，至少不要用 `SETTLEMENT_ALREADY_RUNNING`），且勿暗示 match settlement。

### batch-13　API 层（admin/校验/限流/等级/分享卡）

#### F1 [重要] 管理员写接口前置拒绝顺序与决策表不符
- 位置：`src/api/v1/admin.ts:136`、`src/api/v1/admin.ts:215`、`src/api/v1/admin.ts:286`、`src/api/v1/admin.ts:360`、`src/api/v1/admin.ts:418`
- 现状：四个写接口都先做 `match_id`/`user_id`/body 校验，再对任意非空 `trusted_openid` 做 `admin_apis` 限流；鉴权完全下放到 application。无 openid 时直接跳过限流。
- 规范依据：§30.4「未提供可信管理员身份… → 401/403」先于「`match_id` 非法 UUID → 422；不调用 application」先于「限流命中 → 429；不调用 application」；§30.2 失败映射同样是 401/403 → 422 → 429。
- 影响：无身份 + 非法 UUID/body 返回 422 而非 401；非 active admin 的可信 openid 会先消耗 60/min 配额，超限返回 429 而非 403。
- 建议修复：API 层先判可信身份（空 → 401，交 application 判 active admin → 403），再校验 path/body（422），再限流（429，且仅对已确认的 admin 计次），最后才调 application。

#### F2 [重要] 无 body 的管理员写接口未拒绝未定义字段
- 位置：`src/api/v1/admin.ts:282`（`postAdminRetrySettlement`）、`src/api/v1/admin.ts:356`（`postAdminRebuildUserStats`）
- 现状：两接口 Input 无 `body`，也未做空对象/`assertUnknownFields`。同文件的 result-corrections / rebuild rankings 有白名单；这两处会把客户端传入的 `reason`/`admin_id` 等字段静默丢弃。
- 规范依据：§23.4「未定义字段：422 `VALIDATION_ERROR`」；§30.1/§30.4/§30.5 retry-settlement 与 rebuild/users「不得添加 body/request reason 字段」，审计 reason 为固定系统文案；§30.1「客户端传入的 admin_id 一律忽略/拒绝」。
- 影响：客户端以为自定义 `reason` 已入审计，实际仍写「管理员重试结算」/「管理员用户统计重建」；`admin_id` 也不会被拒绝。
- 建议修复：与另外两个写接口对齐，接收 `body` 并对空字段集做 `assertUnknownFields`（非对象或任何键均 422）。

### batch-14　API 层（预测/比赛/资料/排行）

#### F2 [重要] 比赛列表未校验 90 天最大查询区间
- 位置：`src/api/v1/matches.ts:103`
- 现状：`validateMatchesQuery` 只校验 `from`/`to` 为 ISO8601 UTC，缺省置 `null` 后原样交给 `service.list`，未比较区间长度。两端都提供且跨度 > 90 天时，本层仍放行。
- 规范依据：§25.1「最大查询区间：90 days」；§23.4/§23.8 非法查询（含超出已解析窗口）为 422 `VALIDATION_ERROR`。cursor 还要绑定「解析后的 `from/to`」，超窗结果不能进入同一分页窗口。
- 影响：客户端可一次拉取超过 90 天的比赛，默认 `server_now-24h`～`+30d` 与 cursor 窗口稳定性被绕开。
- 建议修复：`from`/`to` 均提供时，若 `to - from > 90d` 立即 422；只提供一端时，先按 §25.1 补默认再做同样校验。

### batch-15　网关装配与种子

#### F1 [重要] 同一比赛集合 list/detail 数据源装配不一致
- 位置：`src/gateway/assemble.ts:248`、`src/gateway/assemble.ts:263`
- 现状：`GET /v1/matches` 传 `public_source: input.config.public_source`；`GET /v1/matches/:id` 写死 `LOCAL_PUBLIC_SOURCE`。
- 规范依据：§23.1「同一 `/v1` 字段语义不得静默改变」；§39 Provider 与 application 契约分离，API 读模型应走同一 application 数据源。
- 影响：配置非 local 时，列表可出现 detail 在本地不存在或比分/状态不同的比赛，分页窗口与单场事实分裂。
- 建议修复：list/detail 使用同一 `public_source`。若单场必须本地（含预测/结算字段），列表也固定本地，禁止同一集合双源。

#### F2 [重要] 状态矩阵种子用未来开球伪造 Live/Finished/Abandoned
- 位置：`src/gateway/seed.ts:220`
- 现状：额外种子 `kickoffAt` 均为 `serverNow + 8h~16h`，却写入 `Live`（且 `prediction_closed_at=serverNow`）、`Finished`（已有比分）、`Abandoned`。
- 规范依据：§0.3「未被明确允许的状态组合默认 Fail Closed…不得制造缺失业务事实」；读取可返回已有数据，但不得制造假事实。
- 影响：这些场次会进入默认未来窗，公开赛程把未开球写成进行中/已结束，`can_predict_reason` 与时间轴被污染。
- 建议修复：`Live`/`Finished`/`Abandoned` 的 `kickoff_at` 放到 `serverNow` 之前；未来窗只留 Scheduled（含未确认开球）。Postponed/Cancelled 可保留未来开球。

### batch-16　Provider 映射/装载/赛程与球队同步

#### F1 [重要] live_match 用 kickoff 过去 24h 截断，覆盖不到「直到 finished」
- 位置：`src/application/provider-fixture-loader.ts:158`（筛选 `src/application/provider-fixture-loader.ts:174`）
- 现状：`createLiveMatchLoader` 把窗口做成 `[server_now-24h, server_now+T-2h]`（`earliestKickoff = serverNow - DAY_MS`），开球超过 24h 仍 `live`/`SUSP`/`INT` 的比赛直接丢弃。
- 规范依据：§32.4「T-2h ～ finished：每 3 分钟」；§31.9「若按同步窗口筛选 fixture，窗口起点、终点和本轮筛选也必须从传入的 server_now 计算」（窗口语义仍须覆盖到 finished，不能改成 T+24h）。
- 影响：中断/延期恢复等超长 live 会退出 3 分钟同步，状态与完赛发现最多落到 §32.2 日更；注释中的 `LIVE_TOO_LONG` 无法在从未被本任务加载的实体上评估。
- 建议修复：去掉 kickoff 硬下界；按 Provider live/未结束状态 + T-2h 窗口拉数（或先查内部未 finished 再按 id 拉）。`post_finish_verify` 的 24h 下界（`:191`）也应对齐「直到首次 settlement 开始」（§32.5），不要只按 kickoff 年龄切。

#### F2 [重要] round 越界未按实体级 `PROVIDER_DATA_INVALID` 处理
- 位置：`src/provider/fixture-mapper.ts:162`；`src/application/provider-schedule-sync.ts:67`、`src/application/provider-schedule-sync.ts:116`
- 现状：mapper 只要求 `league.round` 非空字符串，不按 `league_id` 解析/校验 `01..round_max`；`discover`/`buildMatch` 再 `parseRoundId`，失败抛 `ProviderDataError`（无 anomaly、无错误快照）。
- 规范依据：§5.3「创建比赛时由 Provider round 解析，按 league_id 校验落在对应上限内；超出上限视为 PROVIDER_DATA_INVALID」；§31.5「记录 anomaly……本轮同步该实体视为失败」。
- 影响：附加赛/不可解析 round 会绕过 mapper 的 `entityFailed` 通道；若应用层未按单 fixture 捕获，一次 `full_schedule_verify` 可能整批 Fail Closed，其它合法赛程无法落库。
- 建议修复：在 `normalizeFixture` 内用已注册联赛 `round_max` 解析 round；失败则 `PROVIDER_DATA_INVALID` + `entityFailed=true`。`discover` 只消费已解析 `round_id`，不要把 round 数据错误升级成 loader/job 级 `ProviderDataError`。

### batch-17　Provider 状态核对/同步配置/触发器

#### F1 [重要] 周评估触发时刻写成 10:10，不是规范的 10:05
- 位置：`src/sync/config.ts:60`、`src/scheduler/triggers.md:27`
- 现状：`weekly_level_eval` 的 `cronExpression = "10 2 * * 1"`，触发器合同写死「每周一 02:10 UTC 启动」（即北京时间 10:10）。
- 规范依据：§32.9「每周一 10:05（Asia/Shanghai，即 `LEVEL_EVAL_SCHEDULE + LEVEL_EVAL_START_DELAY_MINUTES`）触发一次」
- 影响：周评估比合同晚 5 分钟；`as_of` 仍可能按 10:00，但触发时刻与冻结 delay 不再对齐。
- 建议修复：按 UTC 解释时改为 `5 2 * * 1`（02:05 UTC = 周一 10:05 上海）；与 `LEVEL_EVAL_START_DELAY_MINUTES=5` 及触发器表同时改。

#### F2 [重要] 实力榜快照只有每日一次，缺少周评估完成后的触发
- 位置：`src/sync/config.ts:66`、`src/scheduler/triggers.md:27`、`src/scheduler/triggers.md:30`
- 现状：`board_snapshot_strength` 仅 `intervalHours: 24`；`weekly_level_eval` 行只写评估，不接实力榜；11 类任务表也无「周评估完成后触发」。
- 规范依据：§32.12「每次 `weekly_level_eval` 完成后触发一次，另每日固定执行 1 次」
- 影响：周一等级重评后，实力榜最多可旧 24 小时；每日任务只能吸收修正重评，不能覆盖「评完即刷榜」。
- 建议修复：`weekly_level_eval` 成功结束后立刻跑 `board_snapshot_strength`（锁 `sync:board_snapshot_strength` 或同进程 `generate`）；每日 24h 保留；触发器表写明该事件路径。

### batch-18　内存仓储实现

#### F2 [重要] settlements 更新可改写唯一业务键，破坏结算幂等
- 位置：`src/infrastructure/repositories.ts:1404`
- 现状：`updateSettlement` 允许 `match_id`/`result_version`/`rule_version` 变化并迁移 `settlementsByKey`。同一 `settlement_id` 可被改成另一版本键，原 `(match, version, rule)` 空位可再 `insert`。
- 规范依据：§22.1「`settlements: UNIQUE(match_id, result_version, rule_version)`」；§21.10 该三元组是结算单身份（`settlement_id` immutable）。
- 影响：结算创建幂等被绕过，一场比赛同一结果版本可对应被改写的旧单 + 新单，结算账本对不齐。
- 建议修复：对齐 `updatePrediction`：`settlement_id`/`match_id`/`result_version`/`rule_version` 任一变化直接拒绝；update 只允许 status/phase/时间戳/错误字段。

#### F3 [重要] level_history 未落实写入规则
- 位置：`src/infrastructure/repositories.ts:1690`
- 现状：`insertLevelHistory` 仅 `assertSchemaVersion` + PK 唯一，可写入 `from_level==to_level`；`scope=career` 仍可带 `level_season_id`；`reason=correction_reeval` 可缺 `settlement_id`。
- 规范依据：§21.13「仅当 `from_level != to_level` 时写入本表」；「`scope=season` 时 `level_season_id` required；`scope=career` 时必须 null」；「`reason=correction_reeval` 时必填 `settlement_id`」。
- 影响：历史表出现空变化与不可回放截面，纠正重评无法追溯到结算单。
- 建议修复：插入前拒绝 `from_level===to_level`；按 scope 校验 `level_season_id` 空/非空；`correction_reeval` 无 `settlement_id` 拒绝。

#### F4 [重要] anomalies 更新可改 `anomaly_key`，破坏“同 match+type 一行”
- 位置：`src/infrastructure/repositories.ts:1965`
- 现状：`updateAnomaly` 在唯一冲突检查后允许 `anomaly_key`（及隐含的 match/type 身份）改写并删旧键，等于把“更新同一记录”变成“换键搬家”。
- 规范依据：§21.18「同一 match + anomaly type 使用 `anomaly_key = match_id + ":" + type`」；「重复出现更新同一记录。」；§22.1「`anomalies: UNIQUE(anomaly_key)`」。
- 影响：同一异常可分裂成多行或把 A 类型记录改写成 B 类型，open blocking 巡检与幂等 upsert 失真。
- 建议修复：update 时锁定 `anomaly_id`/`anomaly_key`/`match_id`/`type`；只允许 status、last_seen_at、occurrence_count、resolved_*、details 变化。

### batch-19　CloudBase 适配与重建支撑

#### F2 [重要] applied ledger 强制 `result_version` 连续 +1，超出重建公式
- 位置：`src/application/rebuild-service-support.ts:173-177`
- 现状：同一 `prediction_id` 要求 `source_result_version === previousVersion + 1`（首笔还必须是 1）。`old_*` 衔接、`valid_prediction_delta` 首 1 后 0 一并绑在这个条件上，失败即 `INVALID_LEDGER`，rebuild 中止。
- 规范依据：§35.1「精确重建公式」只对 `status=applied` 的 `settlement_items` 做 `SUM(score_delta/valid_prediction_delta/bool delta)`，未要求 applied 版本号无缺口；§35.5 普通 retry 是恢复未 applied item，失败版本可以没有 applied 记录；§21.5 允许 `settled_result_version <= result_version`（中间版本可未结算成功）。
- 影响：首个落地结算已是 v2、或 v2 未 applied 而 v3 更正已 applied 时，合法账本无法重建，用户积分/赛季/等级会被整单拒绝。
- 建议修复：按 `source_result_version` 排序后只校验：首笔 `old_score/wdl/exact` 为未结算（0/false/false）且 `valid_prediction_delta=1`；后续 `old_* == 上一笔 new_*` 且 `valid_prediction_delta=0`；允许版本号缺口，禁止同一 version 两笔 applied。

### batch-20　OpenAPI 合同文件（全量）

#### F1 [重要] `GET /groups/me` 分页合同未落地
- 位置：`src/api/v1/openapi.yaml:576`
- 现状：响应使用 `items + page.next_cursor/has_more`，但该 operation 无 `limit`/`cursor`，也无 `422`。
- 规范依据：§27.2「Auth required，分页」；§23.8「`limit` default=20、min=1、max=100；cursor 无有效签名返回 422」；§23.4「未定义 query 参数：422」。
- 影响：客户端无法按通用分页契约取下一页或缩页；任意未定义 query 在合同上不是 422。
- 建议修复：补 `limit`/`cursor`（同 `Limit`/`Cursor`）；补 `422 VALIDATION_ERROR`。若 MVP 恒返回全量，也需写明 `has_more` 恒为 false，并仍拒绝未知 query。

#### F2 [重要] 两个 Auth 读接口漏冻结注销/用户失败码
- 位置：`src/api/v1/openapi.yaml:225`；`src/api/v1/openapi.yaml:576`
- 现状：`GET /predictions/me/{prediction_id}` 仅有 401/404/429/422；`GET /groups/me` 仅有 401/429/500。同文件 `GET /predictions/me`、`GET /profile/me`、`GET /levels/me`、`GET /unlocks/me` 均有 409/404。
- 规范依据：§26.2「可信身份对应用户已注销 → 409 `USER_DELETED`；无法解析为现有用户 → 404 `USER_NOT_FOUND`」；§28.1/§28.2 同一映射；§26.3/§27.2 均为 Auth required。
- 影响：同一注销用户读「列表」与「单条/群列表」合同失败码不一致，客户端状态机无法共用。
- 建议修复：两接口均补 `409 USER_DELETED`；`GET /groups/me` 再补 `404 USER_NOT_FOUND`（及 F1 的 422）。

#### F3 [重要] 无 body 的管理员写接口未拒绝未定义字段
- 位置：`src/api/v1/openapi.yaml:738`；`src/api/v1/openapi.yaml:771`
- 现状：`POST /admin/matches/{match_id}/retry-settlement`、`POST /admin/rebuild/users/{user_id}` 无 `requestBody`。对比 `CreateGroupRequest` 已用空对象 + `additionalProperties: false`。
- 规范依据：§30.1「retry-settlement / rebuild users 不得添加 body/request reason 字段；审计 reason 为固定系统文案」；§23.4「未定义字段：422 `VALIDATION_ERROR`」。
- 影响：合同允许客户端传 `reason` 或其他字段；网关若不额外拒体会静默丢弃，与「reason 来源固定」冲突。
- 建议修复：两接口增加可省略的空对象 body（`maxProperties: 0`、`additionalProperties: false`），多余字段 422。

#### F4 [重要] `nickname` 长度按 JSON 字符而非 grapheme
- 位置：`src/api/v1/openapi.yaml:1344`；`src/api/v1/openapi.yaml:1665`
- 现状：`SessionInitRequest`/`ProfilePatchRequest` 使用 `minLength: 1`、`maxLength: 32`。
- 规范依据：§24.1「`nickname` required，1～32 grapheme」；§24.3 允许改 `nickname`，同一取值域。
- 影响：含组合字符/emoji 的 32 grapheme 会被 422；不足 32 grapheme 但占满 32 code point 的字符串会被放行。
- 建议修复：合同注明按 grapheme 计数；不要用 `maxLength: 32` 冻结错误边界，校验放到 grapheme 规则（超限仍 422）。

#### F5 [重要] 赛果修正成功态 `settlement_status` 过宽
- 位置：`src/api/v1/openapi.yaml:1837`
- 现状：`AdminResultCorrectionData.settlement_status` 引用完整 `SettlementStatus`（`pending|waiting|settling|settled|correcting|failed|voided`）。
- 规范依据：§30.3「`settled_result_version > 0` → `correcting`；`== 0` → 保持/进入 `waiting`」；成功 201 示例为 `correcting`。
- 影响：201 成功 Envelope 被允许出现 `settled`/`failed`/`pending` 等，与修正写入后的状态机不一致。
- 建议修复：成功体改为 `enum: [waiting, correcting]`。

### batch-21　小程序前端适配（R15）

#### F1 [重要] 排行榜按周榜写死，未适配三榜字段契约
- 位置：`miniprogram/pages/rankings/rankings.js:29`；`miniprogram/pages/rankings/rankings.js:10`；`miniprogram/pages/rankings/rankings.js:50`；`miniprogram/pages/rankings/rankings.wxml:23`
- 现状：`board` 固定 `"week"`，无切换；`presentItem` 只映射 `period_score`/`valid_predictions`；WXML 也只渲染这两个周榜字段。
- 规范依据：§27.1「`board` 为 `week|career|strength`」；「`board=career` 时主排序字段为 `career_points`……改为 `career_points`、`career_valid_predictions`……」；「`board=strength` 时 item 额外包含 `strength_index` 与 `window_n`；不返回 `period_score`/`career_points`」。
- 影响：生涯榜/实力榜无法进入前端；即便把 `board` 改成 `career`/`strength`，主排序值会显示成空/`undefined`，实力指数完全丢失。
- 建议修复：按 `board` 分支映射 item（week: `period_score`+`valid_predictions`；career: `career_points`+`career_valid_predictions`；strength: `strength_index`+`window_n`，不要渲染 `period_score`），并提供三榜切换（切换时重置分页）。

#### F2 [重要] 登录排行响应的 `me` 块被丢弃
- 位置：`miniprogram/pages/rankings/rankings.js:80`；`miniprogram/pages/rankings/rankings.wxml:13`
- 现状：`applyListResult` 只读 `items`/`page`，不读 `payload.me`；列表 UI 也没有当前用户 `status`/`rank`/`top_percent`。
- 规范依据：§27.1「公开，可带可选登录上下文（用于 `me` 块）」；「`me` 块状态机与字段见第 19.3 节；未登录请求不返回 `me`（或 `me=null`）」。
- 影响：`RANKING_TOP_LIMIT=20` 之外的登录用户在列表里看不到自己；`me.status` 非 `ranked` 时也无法区分未入榜/未达门槛等状态。
- 建议修复：登录成功响应读取 `me`；`me` 缺失/`null` 当未登录；已登录则按 `status` 展示自身排名或未入榜态，且不把 `me` 误插入 `items`。

## 四、优化建议（5 条）

### batch-05　周评估/修正重评/等级应用服务

#### F4 [优化] 每个 user/scope 全表拉取所有 applied item
- 位置：`src/application/weekly-level-eval.ts:195`、`src/application/level-correction-reeval.ts:168`
- 现状：`findByStatus(Applied)` 后再 `filter(user_id)`，周评估 × 修正重评 × career/season 重复加载。
- 规范依据：§17.5.1 窗口最多 300 条且 `applied_at < as_of`；§17.6.2 全量用户每周一评估。
- 影响：用户数 × 历史 applied 行数的重复扫描，周评估无法在合理时间内跑完，放大 F1 的中断/漏评窗口。
- 建议修复：按 `user_id`（及 `applied_at < as_of`）查询；同一事务内 career/season 共享一次 facts。

### batch-06　结算账本应用与编排

#### F5 [优化] 每个 item 全量拉用户预测并反查 match 重算 last_scoring
- 位置：`src/application/settlement-item-application-service.ts:167`、`196`、`420`、`469`
- 现状：每个 item 都 `findByUser`，再对每条 `match_score>0` 的 prediction `matches.findById`，career 与 week 各扫一遍。
- 规范依据：§15.7「正常新得分>0：`last_scoring_match_at = max(existing, match.period_anchor_at)`；仅当该场曾是当前 last 且新得分变为 0 时才全量重算」；§16.1 career 并列键同语义
- 影响：千级 item 时读放大，拉长 item 事务，放大 F2 的锁窗口；结果与增量公式等价，但是错误的热点路径。
- 建议修复：默认 `max(existing, period_anchor_at)`；仅修正到 0 且 `existing === 本场 period_anchor_at` 时才按该周期/生涯全量重算，没有则 `null`。

### batch-08　每日一致性快照与对账

#### F4 [优化] 仅为构造 skip 范围而全量拉取所有用户 predictions
- 位置：`src/application/daily-consistency-snapshot.ts:551`、`src/application/daily-consistency-snapshot.ts:674`
- 现状：对每个 user `findByUser` 拉全量预测，却只用于 `activeSettlementScopes` 反查 `match_id → user_ids`。账本重算已走 `settlementItems`。
- 规范依据：§42.1「不允许每次从所有 predictions 实时全量扫描」；§34.4「不得实时全量扫描 predictions」
- 影响：日对账成本随预测总数线性膨胀，与「窗口有界 / 预聚合」口径冲突，不改变比较语义。
- 建议修复：只查 `activeSettlement(match)` 的 `match_id` 下预测（或未完成 settlement items）得到受影响用户。

### batch-17　Provider 状态核对/同步配置/触发器

#### F3 [优化] 触发器合同把墙钟排除出 lease，和续租规则打架
- 位置：`src/scheduler/triggers.md:10`
- 现状：「`now()` 只用于日志 `duration_ms`，不得写入账本、状态机或 lease」；同时又写初次 lease=`server_now+10min`。
- 规范依据：§32.7「续租使用 `lease_until = 续租时刻 wall-clock now + 10 分钟`。该 wall-clock 只用于定时触发和计算锁的操作性到期边界」
- 影响：按字面实现时续租只能写同一注入 `server_now`，lease 不会从墙钟顺延；任务超过 10 分钟可能被新 owner 接管并双写。
- 建议修复：合同改为：墙钟仅用于续租/lease 操作性到期；`load` / fixture / `sync_logs` 仍只用注入 `server_now`。

### batch-20　OpenAPI 合同文件（全量）

#### F6 [优化] anomaly 的 open/resolved 可与 nullable 字段组合矛盾
- 位置：`src/api/v1/openapi.yaml:1974`
- 现状：`status` 与 `resolved_at`/`resolution` 彼此独立；`open` 可带非空 `resolution`，`resolved` 可两者皆 null。
- 规范依据：§30.2「open 的 `resolved_at`、`resolution` 均为 null；resolved 的 `resolved_at` 必须为 UTC 字符串，`resolution` 必须为非空字符串」。
- 影响：合同不能表达该状态机，生成客户端/契约测试会放过非法 item（运行时反而应 500 Fail Closed）。
- 建议修复：用 `oneOf` 拆 open/resolved 两种 item。

## 五、各批次「已核查无问题」摘录

### batch-01　等级核心规则

- `evaluateLevel`（levels.ts:325-380）与 §17.6.4 一致：Lv1 只看累计场次、升级优先且一次一级、Lv2 无保级、保级用 `s<HOLD` 连续 2 次、保护期清零不累计、`best_level` 只增、过线用整数交叉乘法。
- `buildLevelInputs`（levels.ts:127-205）与 §17.5 一致：候选=valid∧白名单∧（season 再滤赛季）∧ `period_anchor_at > as_of-730d`，排序 `anchor DESC, match_id ASC` 取 ≤300，S 取 `applied_at<as_of` 中最大 `source_result_version` 的 `new_score`，B/valid_total 为累计而非窗口 n。
- `replayLevel`（levels.ts:409-513）与 §17.7 / §17.9.2 一致：周评估+修正按 as_of 升序（同时刻 weekly 在前），修正以冻结的 `week_base` 重跑且 `week_base` 不变，`best_level` 取当前值以免回退。

### batch-02　时间/周期/枚举/配置

- §6.2 `computePredictionDeadline`：`kickoff_confirmed=true` → `kickoff_at - PREDICTION_LOCK_MINUTES(10)`，否则 `null`，与冻结配置一致。
- §7.1 / §7.2 `weekPeriodKey` / `periodEndAt`：按 `period_anchor_at` 的北京日期算 ISO week-year（含年末年初、W53）；结束边界为下一北京周一 00:00 exclusive（`server_now >= end` 封榜），与周一 00:00 inclusive 周期对齐。
- §3 / §2.2 冻结配置与枚举对齐：锁/结算等待 10 分钟、计分 3/12、等级阈值与 `level_v3.0`、赛季切点 7/1、邀请码字符集、六联赛 `LEVEL_ELIGIBLE_LEAGUES`、`MatchStatus`/`RankingBoard` 取值均与规范一致；`levelSeasonOf` / `nextMondayEvalAt` 分别落实 §3 赛季边界与周一 10:00 评估时刻。

### batch-03　类型与数据库 Schema/索引

- §22.1 全部 UNIQUE 与 §22.2 全部查询索引均已在 `src/schema/indexes.ts` 落地（含 week 榜、board_snapshots、groups）。
- `collections.ts` 对各集合字段名、枚举、可空性、预测分 `0|3|12`、未结算 `applied_result_version` default 0 与 §21 主体一致。
- v2 新增 `board_snapshots`/`groups`/`group_members` 及 `rankings.period_type` 收敛为 `week` 的存储契约正确。

### batch-04　排行榜比较器与周期重建

- `src/domain/ranking.ts` week/career 与 strength 比较器键序、null 后置、`user_id` 决胜与 §19.5 一致，非法 board 拒绝。
- `lastScoringForPeriodScore` 在 `period_score=0` 强制 `last_scoring_match_at=null`，符合 §19.5。
- `rebuildPeriodRankings` 用 applied item 的 `score_delta` / `valid_prediction_delta` / hit bool delta，且 last_scoring 取每 prediction 最高 `source_result_version`、`new_score>0` 的 max `period_anchor_at`，符合 §35.2。

### batch-05　周评估/修正重评/等级应用服务

- 周评估 `as_of` 为周一 10:00、启动延迟 10 分钟、job lock `sync:weekly_level_eval`、同 `as_of` 幂等跳过，符合 §17.6.2。
- 赛季结束后第一次跨季周评估后 `is_level_frozen=true`，冻结赛季修正不改 `level/best_level`，符合 §17.8.4 / §17.7.1。
- `level_history` 仅 `from≠to` 才写；修正重评 `reason=correction_reeval` 且不删原 `weekly_eval`；`is_former_top` 为派生值，符合 §17.9.5 / §17.11。

### batch-06　结算账本应用与编排

- §14.6 / §14.5：`assertItemMatchesPrediction` 强制 `old_*` 等于 prediction 当前已 applied 结果，禁止从 v1 重算 delta。
- §15.4：`status===applied` 直接 `already_applied` 返回，不重复加聚合。
- §15.6 / §16.2：career/season/week 均用事务内当前值 + `score_delta`/`hitDelta`/`valid_prediction_delta`；仅首次 `valid_prediction_delta===1` 才插入新的 `user_season_stats`。

### batch-07　统计重建

- 积分/命中按 applied `score_delta` / `valid_prediction_delta` / hit bool delta 求和；season 经 `period_anchor_at → levelSeasonOf` 分组，不按联赛 `season_id`。
- `best_level` 只升不降；unlock 只补发、不删除；冻结赛季回放到赛季终评并允许纠错写 `level_history(reason=rebuild)`。
- 维护锁 `maintenance:rebuild:user:{id}` + 用户相关 `settling/correcting` 比赛返回 `409 SETTLEMENT_ALREADY_RUNNING`。

### batch-08　每日一致性快照与对账

- `checkDailyConsistency` 只汇总 `differences` / `skipped_active_settlement`，快照 load 不写业务数据，符合 §34.5「只报警、不自动静默修复」。
- week 榜 expected 由账本按 week 重算 `period_score/valid/wdl/exact/last_scoring/global_rank`，且实际 rankings 过滤掉 month，符合 §34.1/§34.5。
- `expectedCareerLastScoringAt` 取当前有效且 `score>0` 的 `period_anchor_at` 最大，符合 §16.1。

### batch-09　排行榜查询/快照/封存/管理员重排

- `GET /v1/rankings` 的 `board`/`period_key`/`scope`/`group_id` 组合校验，以及解散群 404、非成员 403 的判定顺序符合 §27.1。
- 生涯/实力快照只读 `users` 生涯字段与 `last_eval_*`，按 §19.5 比较器全量排序后写入，不扫 `predictions`（§19.2/§34.4）。
- 列表截断 Top20、每页 10 条；`me.top_percent` 用整数 ceil 再 clamp 到 [1,99] 符合 §19.3。

### batch-10　群组

- `joinGroup` 判定顺序与 §27.2 表一致：格式非法 → 不存在 → 已解散 → 已是 active 成员 → 群人数上限 → 个人加入上限。
- `invite_code` 唯一冲突在事务外重生成，不把唯一约束错误回传客户端，符合 §27.2。
- 群主退出、非群主解散、非成员查看的业务码分别为 `GROUP_OWNER_CANNOT_LEAVE` / `FORBIDDEN` / `GROUP_NOT_MEMBER`（群不存在 `GROUP_NOT_FOUND`），与 §27.2 一致。

### batch-11　比赛与预测查询

- §25.1 默认窗 `now-24h`/`now+30d`、90 天上限、`kickoff_at ASC, match_id ASC` 已落实。
- §8.4/§25.2 `can_predict` 与 `predictRejectReason` 同源；未登录 `can_predict=false`。
- §26.2/§26.3 历史序 `submitted_at DESC, prediction_id DESC`，注销 409、他人预测 404。

### batch-12　个人资料/会话/分享卡/用户统计重建

- `SessionService.init`：active 命中忽略 nickname 返回已有用户；无 active 则新建且不复用 mapping 中的 `deleted_user_id`；唯一冲突回读 active 胜者——符合 §4.2/§4.5.1/§4.6/§24.1。
- `ProfileMutationService.deleteMyProfile`：先 upsert `deleted_openid_mappings`，再写墓碑 `openid=deleted:<user_id>`、`unionid/nickname/favorite_team_id` 置空、`status=deleted`——符合 §4.5/§4.5.1。
- `ProfileQueryService`：`/me` 对非 active 返回 `USER_DELETED`；公开资料 deleted 固定「已注销用户」且 `favorite_team_id=null`；`season_level` 读 `user_season_stats` 缓存、无记录为 1——符合 §24.2/§24.5/§4.5.1。

### batch-13　API 层（admin/校验/限流/等级/分享卡）

- 赛果修正/重建排行榜 body 白名单、比分 0..99、reason 1..500、`career`/`strength` 禁止携带 `period_key`，符合 §23.4/§30.3/§30.6。
- retry 成功固定 200，`outcome` 仅 `settled|failed`，`data` 只回目标标识/摘要/`audit_id`，符合 §30.1/§30.4。
- `admin_apis` 默认 60/min，levels/share-card 走 `authenticated_reads`，`RATE_LIMITED` 映射 429，成功 Envelope 含 `data`+`request_id`，符合 §23.2/§23.5/§28.2/§30.2。

### batch-14　API 层（预测/比赛/资料/排行）

- `POST /v1/predictions` 成功 Envelope 字段完整，首次/重放经 `submitPredictionStatus` 区分 201/200，幂等字段名为 `idempotency_key`，未与 `request_id` 混用（§23.3/§26.1）。
- `GET /v1/predictions/me` 使用 §23.2 分页 Envelope；`season_id` 必须搭配 `league_id` 且等于当前登记值，否则 422（§26.2）。
- `GET /v1/rankings` 对 `board` 必填、`period_key` 仅 `week`、`scope=global` 禁带 `group_id`、`scope=group` 必带 UUID `group_id` 的组合校验符合 §27.1。

### batch-15　网关装配与种子

- 身份四态 active 优先于 mapping；认证读对 deleted 用 HTTP `USER_DELETED`(409)，公开赛程读传 `user_id` 以填 `can_predict_reason`，未与 `UNAUTHORIZED`/`AUTH_REQUIRED` 混用（§23.5/§23.7）。
- `request_id` 由网关/运行时注入生成，预测写路径未把它当幂等键（§23.3）。
- 排行榜种子 `period_key` 走 `calculatePeriodKey` 单一入口，且与默认种子隔离、不预置登录用户（§0.4）。

### batch-16　Provider 映射/装载/赛程与球队同步

- §31.1：六联赛按 `api_football_league_id` + `api_football_season` 分请求，写回用 fixture 自身 league 映射，无跨联赛复用响应。
- §5.1/§5.2：`team_id`/`match_id` 为内部 UUID，映射走独立 collection，按 `(provider, external_id)` 查找后首次插入。
- §31.4/§31.9：仅 `FT` 取 `score.fulltime` 且 0..99；loader/discover/team sync 均校验 `server_now`，窗口与 `created_at` 不用墙钟。

### batch-17　Provider 状态核对/同步配置/触发器

- `SYNC_TASKS_V1` 中 future/full/near/live/post_finish/period_finalize 的间隔与 T-24h/T-2h 窗口与 §32.1–32.6 一致；`jobLockKey` 为 `sync:{job_type}`，未按联赛拆锁（§32.7）。
- 非法状态回退均 `ProviderStateConflict` + `blocking=true` 且不 `matches.update`；cancelled/abandoned 在结算不能 void/非 pending 时同样 conflict（§33.5 / §41）。
- 本文件不改 regular score、不新建正式 `result_version`；管理员已结算后的 Provider 冲突只进 anomaly + snapshot（§41）。

### batch-18　内存仓储实现

- `job_locks`：空闲或 lease 过期才 CAS 写入，仅 owner 可续租/释放，符合 §21.19。
- `predictions`：`UNIQUE(user_id,match_id)` 与 `UNIQUE(user_id,idempotency_key)` 同时维护，提交事实字段不可改，符合 §21.8/§22.1。
- `match_results` 仅 insert、按 `(match_id,result_version)` 唯一，旧版本走 `StaleResultVersionError`，符合 §21.7 不可变账本。

### batch-19　CloudBase 适配与重建支撑

- `loadAppliedSettlementFacts` 聚合不读 `predictions.match_score/wdl_hit/exact_hit` 缓存，只用 item + 原始比分/赛果对账（§35.1）。
- `score_delta = new_score - old_score`、`source_result_version = settlements.result_version` 与 §21.11 invariant 一致。
- `activeSettlement` 仅拦截 `settling/correcting`，与 §35.3 并发前提一致。

### batch-20　OpenAPI 合同文件（全量）

- §23.9 认证：根级 `x-trusted-runtime-openid` + 需登录操作 `x-requires-trusted-openid`，未声明 Bearer/Cookie/身份 Header。
- §26.1/§26.4：预测提交区分 201 创建与 200 幂等重放；无 PATCH/PUT/DELETE `/predictions`。
- §30.1：`result-corrections`/`rebuild/rankings` 必填 `reason`（1..500）；成功 data 仅摘要 + `audit_id`，无 `admin_id`/完整审计对象。

### batch-21　小程序前端适配（R15）

- 周榜不传 `period_key`，符合 §27.1 缺省由服务端按 `server_now` 转北京时间算当前周期。
- 排行/资料均未渲染准确率字段，符合 §27.1 / §24.2（及 §16.3）禁止对外输出准确率。
- 资料页将 `409 USER_DELETED` 独立成态，符合 §28.1 已注销访问 `GET /v1/levels/me` 的映射。

## 六、附录

- 覆盖文件清单：batch 任务书（`/root/claude-review/batches/batch-*.prompt.txt`）内嵌了每批的代码全文（带行号），共覆盖生产代码 57 个 + 小程序 5 个。
- 批次完成记录与时间线：`/root/claude-review/progress.log`。
- 各批原始产出：`/root/claude-review/findings/batch-01..21.md`；事件日志：`/root/claude-review/logs/`。
- 审查过程校验：全流程零仓库副作用（repo-status.before/after 一致）。
- 遗留说明：测试文件（85 个）不在本次审查范围（全量 1248 测试已绿）；如需可追加一轮。
