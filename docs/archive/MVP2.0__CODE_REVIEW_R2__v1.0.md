# 赛事预言家 MVP 2.0 代码审查报告 · 第二轮（复审，v1.0）

- 生成时间：2026-09-29 20:05（Asia/Shanghai）
- 审查对象：修复轮完成后的全量代码（含 FIX1–FIX6 全部整改）
- 审查依据：`docs/MVP__v2.0.md`（含本轮前的 3 处文本修订）
- 审查口径：同第一轮（业务逻辑/规范冲突/边界/状态机/一致性；排除防御性/安全性/风格等）
- 执行方式：24 批（第一轮 21 批同构 + 新增 3 批覆盖修复轮新触及的 9 个文件），Codex CLI + cc-switch → sub2api → grok-latest，单次喂料模式
- 过程证据：`/root/claude-review/`（progress.log、findings/、logs/；第一轮产出存档于 findings-r1/）

## 一、总览

**24/24 批全部完成（0 失败，用时 16:23–20:01）· 共 59 条发现：严重 16 / 重要 34 / 优化 9**

| 批次 | 主题 | 发现（严/重/优） |
|---|---|---|
| 01 | 等级核心规则 | 1（0/1/0） |
| 02 | 时间/周期/枚举/配置 | 0（0/0/0） |
| 03 | 类型与数据库 Schema/索引 | 3（1/1/1） |
| 04 | 排行榜比较器与周期重建 | 1（0/1/0） |
| 05 | 周评估/修正重评/等级应用服务 | 2（0/2/0） |
| 06 | 结算账本应用与编排 | 3（1/1/1） |
| 07 | 统计重建 | 3（1/1/1） |
| 08 | 每日一致性快照与对账 | 2（1/1/0） |
| 09 | 排行榜查询/快照/封存/管理员重排 | 3（0/2/1） |
| 10 | 群组 | 2（1/1/0） |
| 11 | 比赛与预测查询 | 2（0/2/0） |
| 12 | 个人资料/会话/分享卡/用户统计重建 | 2（0/2/0） |
| 13 | API 层（admin/校验/限流/等级/分享卡） | 2（0/2/0） |
| 14 | API 层（预测/比赛/资料/排行） | 2（1/1/0） |
| 15 | 网关装配与种子 | 3（0/2/1） |
| 16 | Provider 映射/装载/赛程与球队同步 | 1（1/0/0） |
| 17 | Provider 状态核对/同步配置/触发器 | 3（1/1/1） |
| 18 | 内存仓储实现 | 5（1/3/1） |
| 19 | CloudBase 适配与重建支撑 | 2（1/1/0） |
| 20 | OpenAPI 合同文件（全量） | 6（2/3/1） |
| 21 | 小程序前端适配（R15） | 1（0/1/0） |
| 22 | 结算生命周期服务（首结算/重试/修正/后置） | 4（2/2/0） |
| 23 | Provider 巡检（live/post-finish）与 HTTP 客户端 | 4（1/2/1） |
| 24 | 管理操作服务（admin/赛果修正/重试结算） | 2（1/1/0） |

## 二、与第一轮对比（主审）

- **覆盖面扩展**：新增第 22–24 批覆盖结算生命周期服务（first/retry/correction/post-finish）、Provider 巡检（live/post-finish/http）、管理操作服务（admin/赛果修正/重试结算）——这些文件第一轮未审。**本轮新发现集中在这些区域**（b22–b24 共 10 条）。
- **修复验证**：第一轮的主体验证通过——等级核心（b01 断言）、排行重建/快照（b04/b09）、修正重评时序（b05）、对账跳过（b08）、仓储校验（b18）、API 顺序/合同（b13/b14 多数）等修复项在复审中未被再次点名（batch-02 再次零发现）。
- **重复出现项（均已在前轮复核，非新问题）**：b06F1（§15.5 措辞引发的等级原子性误读——建议规范文本澄清）、b07F1（replay 初态——主论点不成立，边缘残留）、b14F1（401/409——误报，双重实证）。
- **前轮修复被复审从另一角度挑战**：哨兵行（b03F1，规范未登记扩展）、groups/me 全量返回（b20F2/b10F2，规范明说分页）、expected.best_level 下限口径（b08F2）——属规范文本不明确处，收口方式建议见各条复核。

## 三、严重问题（16 条，逐条主审复核）

### 严重-1　`board_snapshots` 混入非规范 head 元数据行

> 来源：batch-03（类型与数据库 Schema/索引）

- 位置：`src/domain/types.ts:284`、`src/domain/types.ts:291`、`src/schema/collections.ts:510`、`src/schema/indexes.ts:93`、`src/schema/indexes.ts:204`
- 现状：集合被加上 `snapshot_kind?: "head"`，并用哨兵 `BOARD_SNAPSHOT_HEAD_USER_ID` 占 `user_id`；同时 `rank` 仍 `required + min 1`。`UNIQUE(board, snapshot_at, user_id)` 与 `INDEX(board, snapshot_at DESC, rank)` 会把该行当成榜上用户。
- 规范依据：§21.20「`user_id` 为上榜用户 UUID，`rank int >=1`；排序键为原始整数，不另存元数据行」；§22.2「`INDEX(board, snapshot_at DESC, rank)`」按名次读榜。
- 影响：生涯/实力榜查询会读出虚假用户（nil UUID，常与 rank=1 并列），最新版快照语义被污染。
- 建议修复：删除 `snapshot_kind` 与哨兵 user 文档；最新版用已有 `(board, snapshot_at DESC)` 判定。head 若必须保留，应另表，不得写入 `board_snapshots`。

**【主审复核】** 部分属实（实现层面）：board_snapshots 的全部内部消费方（ranking-query / daily-consistency-snapshot / admin-rebuild-rankings / board-snapshot 自身）均已过滤 head 行，查询不会读出虚假用户；但 head 哨兵行为规范未登记的扩展（§21/§22 未定义 snapshot_kind 与哨兵 user），属 SPEC_GAP。裁决建议：保留机制 + 在规范登记 head 约定（最小改动），或另行设计版本标记——建议前者。

### 严重-2　单项账本应用未纳入 level / level_history，与 15.5 原子单元冲突

> 来源：batch-06（结算账本应用与编排）

- 位置：`src/application/settlement-item-application-service.ts:432`、`src/application/settlement-item-application-service.ts:479`、`src/application/settlement-item-application-service.ts:548`；`src/application/settlement-orchestration-service.ts:113`、`src/application/settlement-orchestration-service.ts:134`
- 现状：`applyInTransaction` 同一事务只写 prediction、career 四点与 `last_scoring`、season 四点、week 聚合、unlock、item→applied；`career_level` / `season.level` / `level_state` / `level_history` 原样带过。编排仅在 correction 的 settled/correcting/already_settled 上跑 `LevelCorrectionReeval`；`startFirst` / `retry` 在 match 直接 settled 时不 reeval。
- 规范依据：§15.5「应用单个 item 时……level 当前值变化、必要的 level_history……必须位于同一数据库事务」；§16.1 `users` 保存 `career_level` / `career_level_state`；§15.4 已 applied 不得回滚。
- 影响：item 是一人一场，等级本可随该 item 提交。部分失败（487 applied / 488 失败）或首次结算/纯 retry 成功后，积分已变、等级缓存仍旧；correction 若 failed 也不 reeval。
- 建议修复：在同一 item 事务内按更新后的 career/season 聚合重算 level（冻结赛季只动四点，§16.2），写 `level_history`；不要拖到 settlement 结束后的另一事务。

**【主审复核】** 规范歧义（两轮重复项，不修代码）：v3 时点模型下等级变更仅发生于「周评估 / 修正重评任务」（§17.7.7：非修正首次结算不触发即时评估；§17.7：修正完成 settlement 后生成重评任务），item 应用本就不写等级。r1 已按此解释处置（FIX3 明确未把等级加入 item 事务）；两轮审阅者均被 §15.5「level 当前值变化」的未限定措辞误导。**建议：规范 §15.5 澄清该条仅适用于含等级写入的流程（周评估/重评）**，消除后续复审反复误报。

### 严重-3　等级回放以待纠错缓存为初态，rebuild 无法独立纠错

> 来源：batch-07（统计重建）

- 位置：`src/application/stats-rebuild-service.ts:186`、`src/application/stats-rebuild-service.ts:149`、`src/application/stats-rebuild-service.ts:348`、`src/application/stats-rebuild-service.ts:432`
- 现状：`replayScope` 把缓存的 `currentLevel` / `below_count` 传入 `replayLevel.initialState`；无评估时 `storedLevelState` 还直接保留 `existing`。缓存错到 level=5、从未评估时，回放会原样吐回 5。
- 规范依据：§35.1「career 与各未冻结等级赛季的等级状态按 `replay_level` 回放；回放结果与缓存不同 ⇒ 覆盖缓存，并写 `level_history(reason=rebuild)`（允许跨多级，这是纠错）」
- 影响：rebuild 的等级/below_count/`level_state` 依赖脏缓存，错误等级会被固化，无法完成账本纠错。
- 建议修复：回放初态固定为 `{ level: 1, best_level: bestFloor, below_count: 0 }`；无 `last_eval` 时写入 `defaultLevelState()`，再与缓存比较后覆盖并记账。

**【主审复核】** 部分属实（边缘，两轮重复）：回放 fold 实际从创世态 {1,1,0} 起步（initialState 仅影响「无评估」早退分支），主论点「从脏缓存起步回放」不成立；真实残留=「无评估且 firstEval 已登记」用户缓存不被清零（低影响边缘）。可低优先级小修（caller 侧区分 Q1=null 与「用户无事件」两种情形）。

### 严重-4　用当前账本重跑 `evaluateLevel` 当 expected，把按规定不该变的等级报成差异

> 来源：batch-08（每日一致性快照与对账）

- 位置：`src/application/daily-consistency-snapshot.ts:325`、`src/application/daily-consistency-snapshot.ts:339`、`src/application/daily-consistency-snapshot.ts:398`、`src/application/daily-consistency-snapshot.ts:442`；比较字段 `src/application/daily-consistency.ts:136`、`src/application/daily-consistency.ts:152`
- 现状：`expectedLevelValues` 在 `last_eval_as_of` 上用**当前**账本重算 `n/S/b`，再 `evaluateLevel` 覆盖 expected 的 `level/below_count`，并抬高 `best_level`。赛果修正后窗口内分数会变，但周中等级与冻结赛季等级按规定保持缓存不变。
- 规范依据：§34.5「周中『缓存等级 ≠ 按当前账本即时计算的结果』不是差异」；§16.2「若该等级赛季已冻结：只更新 points/valid_predictions/wdl_hits/exact_hits，不改变该赛季的 level/best_level」
- 影响：历史修正后每日对账会系统性误报 `career_level`/`level`/`below_count`/`best_level`。只报警虽不写库，但会推动错误 rebuild，冻季/周中等级被改掉。
- 建议修复：等级位以缓存/history 回放为准：仅当重算的 `last_eval_n/S/b` 与缓存 `last_inputs` 一致时才比对 `evaluateLevel` 结果；inputs 因修正漂移时不要把新算出的 level 当 expected，等级差异留给 §35 rebuild。

**【主审复核】** 存疑（需实证）：expected 的等级重算使用 last_eval_as_of 截面构造 inputs；若 buildLevelInputs 严格按 applied_at < as_of 取每 prediction 最新已应用项，修正后 inputs 与缓存截面一致、不漂移——需构造「修正后窗口内分数变化」用例实证是否真误报。建议修复轮先补测试再定。

### 严重-5　解散不终止成员身份，加入名额被已解散群永久占用

> 来源：batch-10（群组）

- 位置：`src/application/groups.ts:309`、`src/application/groups.ts:144`、`src/application/groups.ts:181`、`src/application/groups.ts:275`、`src/application/groups.ts:318`
- 现状：`dissolveGroup` 只把 `groups.status` 置为 `dissolved`，`group_members` 仍为 `active`；`leaveGroup` 对群主一律 `GROUP_OWNER_CANNOT_LEAVE`；`assertJoinLimitNotReached` / `listMyGroups` 只看成员 `active`。因此「创建 5 个 → 解散 → 再创建」会留下僵尸成员。约 4 轮后加入数达到 20，即便 `active` 拥有数已为 0，`createGroup` 仍 409 `GROUP_JOIN_LIMIT_REACHED`，群主也无法 leave 清名额。
- 规范依据：§27.2「前置校验：当前用户已拥有的群数 `< USER_MAX_GROUPS_OWNED(5)`」；「成功：`groups.status -> dissolved`；群继续存在于历史数据中」；「群主只能解散」；「已加入群数 `>= USER_MAX_GROUPS_JOINED(20)`」；「返回当前用户 active 加入的全部群」
- 影响：解散本应回收拥有名额并进入历史，实际把加入上限锁死，创建/加入最终全部失败；「我的群」也会一直返回已解散群。
- 建议修复：解散事务内将该群所有 `active` 成员改为 `left`（`left_at=server_now`），`member_count=0`；加入计数与 `GET /groups/me` 只统计 `group.status=active` 的成员。不要在创建接口用加入上限替代拥有上限。

**【主审复核】** **属实（严重，真实残留）**：dissolveGroup 仅改群状态，不终止成员关系；成员仍为 active 并占用加入名额（约 20 轮创建-解散后创建被 409 锁死，群主亦无法 leave），listMyGroups 也会持续返回已解散群。r1（FIX5）只修了「拥有上限仅计 Active」，未处理成员侧。修复：解散事务内全体成员置 left + member_count=0；加入计数与「我的群」按 group.status=active 口径。

### 严重-6　缺登录走 `conflictError`，HTTP 会变成 409 而非 401

> 来源：batch-14（API 层（预测/比赛/资料/排行））

- 位置：`src/api/v1/predictions.ts:63`、`src/api/v1/predictions.ts:130`、`src/api/v1/profile.ts:80`
- 现状：`throw conflictError("UNAUTHORIZED", "需要登录后提交预测")`（读预测/资料同理）。本文件只有 `validationError`（422）与 `conflictError`（按 23.5 对应 409 业务冲突）两条通道。
- 规范依据：§23.5「`UNAUTHORIZED` 是『缺少可信身份』这一条件唯一的 HTTP 错误 `code`」且该条件 HTTP 为 `401`；§26.2 失败映射「缺少可信身份 → 401 `UNAUTHORIZED`」（409 留给 `USER_DELETED` 等业务冲突）。
- 影响：未登录的 POST/GET 预测与资料接口会被客户端当成业务冲突；与注销用户 409 无法区分。
- 建议修复：新增/改用固定映射 HTTP 401 的错误工厂抛出 `code=UNAUTHORIZED`；禁止把鉴权失败送进 `conflictError`。

**【主审复核】** 误报（两轮重复，已有双重实证）：错误→HTTP 映射按 code 进行（STATUS_BY_CODE: UNAUTHORIZED→401），三入口（gateway/http、gateway/assemble、cloud-function）统一走 mapErrorToHttp，conflictError("UNAUTHORIZED") 实际返回 401。仅工厂函数命名不佳（风格类）。可忽略；如反复被报可考虑加注释说明。

### 严重-7　live_match 装载窗口把已开赛/待完赛场次全部丢掉

> 来源：batch-16（Provider 映射/装载/赛程与球队同步）

- 位置：`src/application/provider-fixture-loader.ts:153`、`src/application/provider-fixture-loader.ts:158`、`src/application/provider-fixture-loader.ts:170`
- 现状：`latestKickoff = serverNow+T-2h` 后只请求 `dateFrom=今天UTC`；本地又只保留 `kickoff===null || (kickoff∈[serverNow, latestKickoff])`。`kickoff < serverNow` 的 live/即将 FT 场次在过滤阶段被 `return []` 丢弃，跨日仍未完赛的场次在请求阶段就进不来。
- 规范依据：§32.4「T-2h ～ finished」；§31.9「若按同步窗口筛选 fixture，窗口起点、终点和本轮筛选也必须从传入的 server_now 计算」；§31.4/§32.5 依赖该窗口观察到 `FT` 才能抽正式比分并进入完赛后确认。
- 影响：高频 live 任务在开球后不再同步该场，无法把 `live→FT` 纳入本轮装载；正式比分与完赛后校验只能等日更 full verify，结算链路被推迟/漏触发。
- 建议修复：窗口改为「kickoff ≤ server_now+2h，且尚未 finished」（含 live 与刚 FT）。请求不要只按「今天～T-2h 日历日」；应对已开赛未完赛走已知 `provider_match_id` 或 live 状态接口，并删掉 `kickoff >= serverNow` 这个排除条件。

**【主审复核】** 部分属实（影响已被缓解）：该 loader 窗口自身确不含 kickoff < serverNow 的场次；但 FIX6 已在 provider-live-match 增加「已知未完成场次按 provider id 直查」补查（Live 全量 + 临近 Scheduled），已开赛场次仍会进入 live 批次——r2 未计入该路径，主影响声称偏重。建议低优先级：对齐 §32.4 将 loader 窗口改正为「≤ now+2h 且未 finished」。

### 严重-8　已 Abandoned 且结算已离开 Pending 时，重复 abandoned 被误判为状态冲突

> 来源：batch-17（Provider 状态核对/同步配置/触发器）

- 位置：`src/application/provider-status-sync.ts:966`、`src/application/provider-status-sync.ts:969`、`src/application/provider-status-sync.ts:970`
- 现状：`invalidSettlement` 未排除 `sameStatus`。本函数不 void，Abandoned 后官方结算/作废只能由管理员完成；此后 Provider 仍推送 abandoned 时 `settlement_status !== pending`，每次都会 `ProviderStateConflict` 且 `blocking=true`，即使 `match_status` 已是 abandoned。
- 规范依据：§33.5「禁止状态回退：blocking=true。不覆盖现有状态。」；§41「管理员正式结果 > Provider 后续不同结果」「Provider 仍继续同步状态/元数据」「差异只进入 anomaly + snapshot」
- 影响：管理员按 41 处理后，后续同步把已一致的 abandoned 当成回退并 blocking，可能卡住 correction/后续结算。
- 建议修复：仅在 `!sameStatus` 时校验 `settlement_status === pending` 与 transition；`sameStatus` 直接 `unchanged`（或只同步元数据），禁止对已 Abandoned 场次因结算已推进而开 blocking 冲突。

**【主审复核】** **属实（严重，新发现）**：sameStatus 未豁免 invalidSettlement 检查——已 abandoned 且结算已离开 pending 的场次，每次 Provider 推送 abandoned 都会 ProviderStateConflict + blocking=true，违反 §33.5/§41（同态非回退）。修复：仅 !sameStatus 时校验 settlement 门闩。

### 严重-9　`match_results` 唯一约束在写入路径上非原子，不可变账本可被覆盖

> 来源：batch-18（内存仓储实现）

- 位置：`src/infrastructure/repositories.ts:1338`、`src/infrastructure/repositories.ts:1340`、`src/infrastructure/repositories.ts:1348`
- 现状：先 `has(key)` 再 `await findLatestMatchResult(...)`，最后才 `set`。`async`+`await` 会把出检查窗口，`Promise.all` 两次同 `(match_id, result_version)` 都能通过校验，后写覆盖先写。
- 规范依据：§22.1「`match_results: UNIQUE(match_id, result_version)`」；§21.7「immutable」
- 影响：并发补写/纠错可静默覆盖已提交结果，账本不再 append-only，后续结算会读到错误比分版本。
- 建议修复：`findLatestMatchResult` 改为同步；`has(key)` 与 `set(key)` 之间禁止 `await`。更高版本拒绝用 `>=` 一并挡住同版本竞态。

**【主审复核】** **属实（原子性缺口）**：insertMatchResult 在 has(key) 校验与 set 之间存在 await（findLatestMatchResult），Promise.all 并发可双通过后写覆盖先写，破坏 §21.7 immutable/§22.1 UNIQUE 语义。修复便宜：去除 check→set 间 await（同步比较）或在 set 前复检。

### 严重-10　applied 账本加载用错比赛状态门闩

> 来源：batch-19（CloudBase 适配与重建支撑）

- 位置：`src/application/rebuild-service-support.ts:30`、`src/application/rebuild-service-support.ts:77`
- 现状：`activeSettlement()` 只认 `settling/correcting`，但 `loadAppliedSettlementFacts()` 未调用它，而是 `match_status !== "finished"` 直接 `INVALID_LEDGER`。
- 规范依据：§35.3「目标用户/目标周期不存在相关 settling/correcting match，否则 409 SETTLEMENT_ALREADY_RUNNING」；§35.1「期望值必须以 status=applied 的 settlement_items 为唯一事实源」，matches 只做归属与状态校验。
- 影响：`finished + correcting` 仍会把尚未完全 applied 的账本当最终事实 SUM 并回写生涯/赛季缓存；`cancelled/abandoned/voided` 若仍留 applied item，整次 rebuild 被误杀。
- 建议修复：加载到 match 后若 `activeSettlement(match)` 抛 `SETTLEMENT_ALREADY_RUNNING`；删除 `finished` 硬条件，归属失败只在 `period_anchor_at == null`（见 `buildReplayFacts`）时判定。

**【主审复核】** 部分属实：①「finished+correcting 误 SUM」不成立——服务层已有 activeSettlement 409 门（stats-rebuild-service:315；rebuild 前置拒绝）；②「cancelled/abandoned 仍留 applied item 时整次 rebuild 被误杀」成立（loadAppliedSettlementFacts 硬要求 match_status=finished）。建议按建议调整为 activeSettlement 抛 409、放宽非 finished 硬门（归属失败仅看 period_anchor_at）。

### 严重-11　`MatchDetailData` 的 `allOf` 会把合法的 `my_prediction` 判为非法

> 来源：batch-20（OpenAPI 合同文件（全量））

- 位置：`src/api/v1/openapi.yaml:1013`（`MatchListItem` 在 `src/api/v1/openapi.yaml:917`）
- 现状：`MatchDetailData` 对带 `additionalProperties: false` 的 `MatchListItem` 做 `allOf` 再追加 `my_prediction`。按 JSON Schema，详情对象必须先通过列表项 schema，因而 `my_prediction` 会被视为未定义字段。
- 规范依据：§25.3「除比赛字段外」必须返回 `my_prediction`（未登录/无预测时为 `null`）
- 影响：`GET /v1/matches/{match_id}` 的规范成功体无法通过本合同校验，详情合同实际不可执行。
- 建议修复：不要 `allOf` 扩展已关闭附加属性的列表项；改为独立 `MatchDetailData`（内联比赛字段 + `my_prediction`），或改用 `unevaluatedProperties: false` 的可扩展组合。

**【主审复核】** **属实（合同技术缺陷）**：MatchDetailData 对 additionalProperties:false 的 MatchListItem 做 allOf 再追加 my_prediction，按 JSON Schema 语义 my_prediction 会被判非法，详情契约自相矛盾（§25.3 要求必返回）。修复：独立 MatchDetailData schema（内联字段+my_prediction）或改用 unevaluatedProperties。

### 严重-12　`GET /v1/groups/me` 把分页合同冻结成一次全量返回

> 来源：batch-20（OpenAPI 合同文件（全量））

- 位置：`src/api/v1/openapi.yaml:578`
- 现状：description 写死「一次返回完整列表，`has_more` 恒为 `false`，`next_cursor` 恒为 `null`」，同时又暴露 `limit`/`cursor`。
- 规范依据：§27.2「Auth required，分页」；§23.8 `limit` default=20、min=1、max=100，cursor 为 opaque keyset，无效签名须 `422 VALIDATION_ERROR`
- 影响：`limit=5` 仍可能一次吐出全部群；cursor 被架空，分页窗口与 23.8 不一致。
- 建议修复：删除该冻结语句；按 23.8 兑现 `limit`/`cursor`，仅当确有下一页时 `has_more=true` 并给出 `next_cursor`。

**【主审复核】** **属实（规范要求分页）**：§27.2 明确「Auth required，分页」；当前实现（limit 校验后丢弃、cursor 一律 422、恒定 has_more=false）与合同冻结语均不符。与 batch-10 F2 同题。修复：实现 limit/cursor keyset 分页（缺省 20），或与规范确认改为单页语义——按现规范应实现分页。

### 严重-13　item 失败在同一事务内 catch 后提交，破坏 item 原子性

> 来源：batch-22（结算生命周期服务（首结算/重试/修正/后置））

- 位置：`src/application/first-settlement-service.ts:317`、`src/application/retry-settlement-service.ts:250`、`src/application/correction-settlement-service.ts:306`
- 现状：三个服务都把整场 item 循环放在同一个 `withTransaction` 里，`itemWorker` 共用该 `tx`；worker 抛错后 catch 把 item 标 `failed` 并 **return（提交事务）**，不中止事务。first 还会在事务提交后再 `throw workerError`。
- 规范依据：§15.5「应用单个 item 的 prediction/career/season/week/level/unlock 与 item→applied 必须在同一事务；事务失败则以上变化不得部分提交，item 保持未 applied，记录 last_error」；§15.4「重试只处理 pending/failed，applied 永不重复应用」
- 影响：worker 若在写入聚合后、标 applied 前失败，积分/命中已提交但 item 为 failed；重试会再应用同一 delta，账本重复记账。
- 建议修复：每个 item 独立事务（或 savepoint）。worker 失败必须回滚该 item 的聚合写入，再另启事务只写 `item=failed`、`last_error`、settlement/match=`failed`。

**【主审复核】** **属实（规范违背 §15.5）**：item worker 在共用的整场事务内运行，失败路径 catch 标 failed 后继续提交——若 worker 在部分写入后抛错（断言/仓储级异常），聚合写入将随事务提交而 item=failed，重试会重复记账。修复：逐 item 独立事务或 savepoint；失败先回滚该项写入，再单独事务记录失败。

### 严重-14　finalize 整对象写回 match，15.9 再读 result_version 被自己覆盖

> 来源：batch-22（结算生命周期服务（首结算/重试/修正/后置））

- 位置：`src/application/first-settlement-service.ts:407`、`src/application/retry-settlement-service.ts:343`、`src/application/correction-settlement-service.ts:401`
- 现状：`tx.matches.update({ ...finalMatch, settled_result_version, settled_at })` 把结算开始时读到的整份 match（含旧 `result_version`）写回，然后再 `findById` 判断是否 `result_version > v`。
- 规范依据：§15.9「先写 `settled_result_version=v` 与 `settled_at`，再重新读取 `matches.result_version`；若 `> v` 则 match→correcting 并启动下一 correction。不得先把 match 标为 settled 再遗漏后续版本」；§11.2 与此对齐
- 影响：结算期间（items/重算耗时长）并发正式赛果/管理员修正增加的 `result_version` 会被旧快照打回；再读看到 `== v`，match 被标 `settled`，后续版本永久漏结算。
- 建议修复：只更新 `settled_result_version`、`settled_at`（不要 spread 整文档）；再读 `result_version` 决定 `settled`/`correcting`。

**【主审复核】** 条件性（生产并发面，参照实现无窗口）：finalMatch 在写回前紧邻重读，且结算全程持有 match 锁；内存参照实现单线程微任务无覆盖窗口。风险面向 CloudBase 多实例（B1 接线）：届时按建议改「最小字段 patch」而非整文档 spread。

### 严重-15　单条 fixture 非法即整包 `ProviderDataError`，高频任务会反复 Fail Closed

> 来源：batch-23（Provider 巡检（live/post-finish）与 HTTP 客户端）

- 位置：`src/provider/http.ts:228`、`src/provider/http.ts:241`、`src/provider/http.ts:139`
- 现状：`getFixtures` / `getSeasonFixtures` 用 `env.response.every(isApiFootballFixture)`，任一缺 `round`/`timestamp`/`teams.*.id` 等就抛 `ProviderDataError`，整段 response 丢弃。
- 规范依据：§31.5「本轮同步该实体视为失败」；§32.8「`ProviderDataError` 否 retry」；§32.4 live 需持续推进。
- 影响：六联赛里一场脏数据即可让整次 loader 失败且不重试；live/post-finish 每次 scheduled run 同样死掉，赛况/完赛确认全停。
- 建议修复：逐条校验；合法项返回给 apply，非法项只让该实体失败并留 snapshot/anomaly，不要把整包打成不可 retry 的 `ProviderDataError`。

**【主审复核】** 部分属实（设计权衡）：http 层对整包做 schema 校验，任一 fixture 缺字段即整批 ProviderDataError（不可重试）——建议按 §31.5 逐条校验、非法项仅该实体失败。注意与 fail-closed 精神权衡，属可改进项。

### 严重-16　后续 correction 结果覆盖本次 retry 的 outcome

> 来源：batch-24（管理操作服务（admin/赛果修正/重试结算））

- 位置：`src/application/admin-retry-settlement.ts:201`、`src/application/admin-retry-settlement.ts:209`、`src/application/admin-retry-settlement.ts:216`
- 现状：目标 failed settlement 已成功（`kind === "correcting"`）后，仍 `continuePendingCorrections()`；若后续版本把 match 打成 `failed`，用**原** `settlement_id` / `processed_count` / `skipped_applied_count` 改写成 `kind: "failed"`。
- 规范依据：§30.4「复用原 settlement 与 items…使用该 settlement 自己的 immutable result_version」；成功 Envelope 的 `outcome`/`processed_count` 描述**本次** reuse 处理；「正常处理完成或处理后失败都返回本节 200」。§15.9 允许随后启动下一 correction，但不允许把下一 version 的失败算成本次已 settled settlement 失败。
- 影响：账本已 applied，API 却报本次 retry 失败；客户端会拿已成功的 `settlement_id` 再重试，和 `skipped_applied_count` 语义冲突。
- 建议修复：本次响应只反映 `target` 那一次 reuse 的结果。`continuePendingCorrections` 若保留作 §15.9 消化，不得回写 `outcome`/计数；后续失败应体现在 match 状态/下一 failed target，而不是本次 Envelope。

**【主审复核】** **属实（响应语义）**：目标 settlement 成功后如续跑时更高版本失败，会用原 settlement_id/计数改写 outcome=failed——把「下一版本」的失败算到本次 retry 头上。修复：本次响应只反映 target 的 reuse 结果，后续版本状态体现在 match/下一个 failed target。


## 四、重要问题（34 条，按批次）

### batch-01　等级核心规则

#### F1 [重要] 修正改判的 history 断言与「改判本周结论」冲突
- 位置：`src/domain/invariants.ts:143`；关联 `src/domain/levels.ts:469`、`src/domain/levels.ts:479`
- 现状：`assertLevelHistoryInvariants` 对非 `rebuild` 要求 `|to_level-from_level|<=1`。`replayLevel` 的修正路径从 `week_base` 重跑并**替换**本周结论：周评估可先 `3→2`（`bc=1` 且低于保级线），同周修正再从 `week_base.level=3` 升到 `4`。按 §17.9.5，`correction_reeval` 的 from=改判前缓存（2）、to=改判后（4），级差为 2。
- 规范依据：§17.7「以 week_base 为起点重跑，结果替换本周周评估结论」；§17.9.5「from=改判前、to=改判后，不删除原 weekly_eval」；§40「同一评估周内 level <= week_base_level+1」（允许 2→4），与「相邻两次 |Δ|<=1」若落在 history 行上则互斥
- 影响：合法改判写入 history 会被当成数据损坏；若写入侧为通过断言而改 from 或吞掉记录，则回放/审计与 §17.9.5 不一致
- 建议修复：非 rebuild 的级差约束改为「单次 `evaluateLevel` 相对输入 state 最多 ±1」，并断言 `to_level <= week_base.level+1`；history 仍用改判前/后真实缓存，允许同周 2 级差

### batch-03　类型与数据库 Schema/索引

#### F2 [重要] `groups.invite_code` 未冻结长度 8
- 位置：`src/schema/collections.ts:528`、`src/domain/types.ts:305`
- 现状：`invite_code: { type: "string", required: true, unique: true }`，无 `min/max`。同文件对 `reason` 已用 `min: 1, max: 500` 表达字符串长度。
- 规范依据：§21.21「`invite_code` 长度固定 `GROUP_INVITE_CODE_LENGTH=8`，字符集 `GROUP_INVITE_CODE_ALPHABET`」。
- 影响：非 8 位码可入库；唯一索引仍通过，加入群将按错误码匹配/失败。
- 建议修复：schema 增加 `min: 8, max: 8`（字符集在写入路径按第 3 节校验）。

### batch-04　排行榜比较器与周期重建

#### F1 [重要] 周榜 `global_rank` 按「含未达门槛用户」的全量下标编号
- 位置：`src/application/ranking-rebuild.ts:255`、`src/application/ranking-rebuild.ts:259`、`src/domain/ranking.ts:143`
- 现状：`rebuildPeriodRankings` 把账本里所有用户（含 `valid_predictions=0`）放进同一数组，`sort` 后再 `rankForPosition(valid, index+1)`。比较器第三键是 `valid_predictions ASC`，0 场用户在同分（尤其 0 分/0 精确）时排在 1 场用户前面；前者 `global_rank=null`，后者拿到 2、3… 而非 1、2、3。
- 规范依据：§19.5「符合最低场次的用户按完整排序得到 1, 2, 3, ...；不符合最低场次：`global_rank = null`」；§19.1/§19.2 入榜门槛是 `valid_predictions ≥ 1`，ASC 场次只是入榜后的效率 tie-break。
- 影响：未达门槛行会挤占排序位置，造成名次空洞；周初上榜人数少时，0 分有效用户的名次会整体偏移。
- 建议修复：先用 `isRankEligible` 分成入榜/未入榜；只对入榜集合 `compareRankingEntry` 后赋 `1..n`；未入榜一律 `global_rank=null`（统计仍可落库）。

### batch-05　周评估/修正重评/等级应用服务

#### F1 [重要] 周评估未开始也被当成已完成，修正重评抢先写 week_base 后本周周评估被跳过
- 位置：`src/application/level-correction-reeval.ts:66`、`src/application/level-correction-reeval.ts:91`、`src/application/weekly-level-eval.ts:304`
- 现状：`weeklyEvaluationIsIncomplete` 只在「仍在 10 分钟宽限内」或「全局周评估锁仍持有」时为 true；锁尚未拿到（任务晚于 `as_of+10min` 才启动）即视为本周已完成。`stateForCorrection` 因而用当前状态当 `week_base` 并写入 `week_base_as_of=本周一`。随后周评估把 `week_base_as_of===as_of` 当成「本 as_of 已评」直接 skip。
- 规范依据：§17.7.6「周评估任务未完成前产生的修正重评任务延后到周评估完成后执行」；§17.6.2「已存在该 as_of 的评估结果则跳过」
- 影响：修正重评在周评估之前落地；本周不再产生 `weekly_eval`。回放序列是「周一 as_of → 再改判」，实况缺周一事件，history 对不齐（改判撤回升级时缺原 `weekly_eval` 行）。
- 建议修复：未出现 `last_eval_as_of==本周 as_of` 的周评估结果前一律 defer；周评估幂等只认 `last_eval_as_of===该周一 as_of`，不要用 `week_base_as_of` 代替。

#### F2 [重要] 每次周评估会按 settled_at 重放上周全部修正，较旧截面能覆盖较新改判并重复写 history
- 位置：`src/application/level-correction-reeval.ts:97`、`src/application/level-correction-reeval.ts:319`、`src/application/weekly-level-eval.ts:250`
- 现状：`runPendingBefore(本周一)` 取出所有 `settled_at<本周一` 的 correction 再跑一遍。上周已处理过的改判此时 `week_base_as_of` 仍是上周一，`useStoredBase=true`，于是 `last_eval_as_of>as_of` 的 stale 短路被关掉。同一周多次修正（如 2:1→1:1→1:0）会按旧 as_of 再 `evaluate_level`：等级先被旧结论改掉，并再插一条 `correction_reeval`。
- 规范依据：§17.7.2「用该 as_of 的最新输入重跑，结果替换本周结论」；§17.7.6「按 as_of 顺序串行」；§17.9.5「仅 from≠to 写一条，不删不改原行」
- 影响：一周内 ≥2 次改判时，下周一任务会重复写 history；若在两条重放之间中断，缓存会停在较旧改判，直到重跑后半段。
- 建议修复：按 settlement 幂等（已处理过的 `settlement_id` 跳过）；同一 scope 若 `last_eval_as_of>=本次 as_of` 直接 skip，不要因 `useStoredBase` 关闭过期保护。`runPendingBefore` 只补「从未成功改判」的任务。

### batch-06　结算账本应用与编排

#### F2 [重要] `correct()` 在 settled 时不按 match 续跑版本队列
- 位置：`src/application/settlement-orchestration-service.ts:168`；对照 `src/application/settlement-orchestration-service.ts:119`、`src/application/settlement-orchestration-service.ts:139`、`src/application/settlement-orchestration-service.ts:84`
- 现状：`startFirst`/`retry` 成功后一律 `continuePendingCorrections`（看 `settlement_status===correcting` 且 `settled_result_version < result_version`）。`correct()` 在 `kind==="settled"|"already_settled"` 时 reeval 后直接返回；仅 `kind==="correcting"` 才续跑。`continuePendingCorrections` 亦把 `settled`/`already_settled` 当终点，不再回读 match。
- 规范依据：§15.9「`settlement.status=settled` 且 `result_version>v` → match=`correcting`，随后按最小未处理 version 启动下一 correction；不得遗漏后续版本」；§15.3「不得从 v1 跳到 v3」。
- 影响：若下层用 kind=`settled` 表示「本 version 的 settlement 已 settled」（与 §15.9 字段一致），v2 完成后 v3 不会启动，match 停在 correcting，积分停在旧赛果。
- 建议修复：与 `startFirst`/`retry` 对齐——任何 version 成功后都按 match 状态续跑；`already_settled` 在仍有未处理 version 时不得终止队列。`targetResultVersion` 必须等于最小未处理 version。

### batch-07　统计重建

#### F2 [重要] 历史赛季冻结态只信旧缓存，缺失文档会按未冻结回放
- 位置：`src/application/stats-rebuild-service.ts:183`、`src/application/stats-rebuild-service.ts:212`、`src/application/stats-rebuild-service.ts:400`、`src/application/stats-rebuild-service.ts:466`
- 现状：仅当 `oldStats.is_level_frozen` 才把 `untilAsOf` 封顶到 `seasonFinalEvalAsOf`。缺失的 `user_season_stats` 走 `emptySeasonStats()`，`is_level_frozen: false`，回放到 `serverNow`，且写回时不重算冻结标记。
- 规范依据：§35.1「已冻结赛季同样回放到其最终评估为止」；§16.2「若该等级赛季已冻结：只更新 points/valid_predictions/wdl_hits/exact_hits，不改变该赛季的 level/best_level」
- 影响：丢失的历史赛季被建成未冻结文档，回放可能越过最终评估；后续赛果修正也会改其 `level/best_level`。
- 建议修复：按 §17.8 / `seasonFinalEvalAsOf` 重算冻结；冻结则 `untilAsOf` 封顶到最终评估，并写回 `is_level_frozen=true`（已有 true 不得改回 false）。

### batch-08　每日一致性快照与对账

#### F2 [重要] expected `best_level` 把被校验缓存当下限，虚高永远对不上
- 位置：`src/application/daily-consistency-snapshot.ts:360`；调用点 `src/application/daily-consistency-snapshot.ts:399`、`src/application/daily-consistency-snapshot.ts:443`
- 现状：`best_level: Math.max(params.bestLevel, level, maximumHistoryLevel)`，`params.bestLevel` 来自 `user.career_best_level` / `stats.best_level`（正在比对的 actual）。缓存虚高时 expected 被抬到同一值，`compareValues` 无差异。
- 规范依据：§34.5「从事实数据重算并比较」`users` career cache（含 `career_best_level`）与 `user_season_stats`（含等级状态）
- 影响：`best_level` 只能发现偏低，不能发现偏高；与「从事实重算」矛盾。
- 建议修复：expected `best_level` 只取事实：`max(history.to_level, 回放得到的 level)`，不要 `max` 进缓存。冻季则 expected 固定为冻结时 history/缓存，不随当前账本抬升。

**【主审复核】** 部分属实（弱检查）：§17.9.4-3 对 best_level 只要求「≥ level 且 ≥ history 最大值」（下界约束）；当前 expected 并入被校验缓存作下限导致该检查恒真（无法检出下界违约）。建议 expected 改为下界口径（max(level, historyMax)）使检查可触发——「缓存虚高」本身非违规但无法检出。

### batch-09　排行榜查询/快照/封存/管理员重排

#### F1 [重要] 周榜省略 `period_key` 时被 cursor 继承，缺省不再是当前 ISO 周
- 位置：`src/application/ranking-query.ts:310`、`src/application/ranking-query.ts:313`
- 现状：`periodKey = input.period_key ?? cursorPosition?.period_key ?? calculatePeriodKey(...)`，先继承 cursor 再做冲突校验，导致省略 `period_key` 时 `cursor.period_key !== periodKey` 永假。
- 规范依据：§27.1「`period_key` 缺省（`board=week`）：服务端按当前 `server_now` 转北京时间计算当前周期」
- 影响：跨周翻页或不带 `period_key` 的历史 cursor 会继续返回旧周，响应 `period_key` 也变成旧周，本周榜缺省语义失效。
- 建议修复：周榜在请求未带 `period_key` 时始终用 `server_now` 算当前周，再与 cursor 绑定的 `period_key` 比较，不一致则 `422 VALIDATION_ERROR`。

#### F2 [重要] 实力榜 `me` 会出现规范未定义的 `not_participated`
- 位置：`src/application/ranking-query.ts:421`
- 现状：用户不在 `ranked` 时，若 `last_eval_n >= STRENGTH_BOARD_MIN_WINDOW_N` 则 `me = { status: "not_participated" }`。
- 规范依据：§19.3「`not_participated`：本周/生涯无有效预测」；「`below_threshold`：仅实力榜，窗口 `n < 50`」；已入榜为 `ranked`
- 影响：快照尚未生成或滞后时，已达 `n≥50` 的用户会被展示成「未参与」，与实力榜状态机（只有 `ranked` / `below_threshold`）冲突。
- 建议修复：实力榜不要返回 `not_participated`。`n<50` 仍走 `below_threshold`；`n≥50` 却不在最新快照中按 §27.1 快照不一致处理（有快照则 `500 INTERNAL_ERROR`，无快照则空榜边界单独定义，而不是「未参与」）。

### batch-10　群组

#### F2 [重要] `GET /v1/groups/me` 声明分页但 limit 不生效、cursor 一律 422
- 位置：`src/api/v1/groups.ts:56`、`src/api/v1/groups.ts:70`、`src/api/v1/groups.ts:149`、`src/application/groups.ts:315`
- 现状：`limit` 按 1..100 校验后被丢弃，`listMyGroups` 始终返回全量；任意非空 `cursor` 直接 `VALIDATION_ERROR`（「一次返回全部项目」）；响应固定 `next_cursor=null, has_more=false`。
- 规范依据：§27.2「`GET /v1/groups/me` Auth required，分页」，响应含 `page.next_cursor` / `has_more`
- 影响：客户端传 `limit=1` 仍拿到全部群；合法 cursor 协议无法使用。
- 建议修复：按 `joined_at+group_id` 排序后应用 `limit`（缺省可取 20），切片并签发 `next_cursor`；`has_more` 与是否还有下一页一致。若 MVP 强制单页返回，则 `limit` 也应拒绝，不能只拒 cursor。

**【主审复核】** 属实（与 batch-20 F2 同题）：limit 被丢弃、cursor 一律 422；应实现分页或与规范确认单页语义。

### batch-11　比赛与预测查询

#### F1 [重要] 比赛详情 `my_prediction` 未按取消/无正式比分清空结算字段
- 位置：`src/application/match-query.ts:283`、`src/application/match-query.ts:454`；对照 `src/application/prediction-query.ts:179`、`src/application/prediction-query.ts:312`
- 现状：`mapMyPrediction` 原样回传存储的 `match_score`/`wdl_hit`/`exact_hit`。预测列表/详情则用 `hasFormalScore && match_status !== "cancelled"` 决定是否暴露结算字段。
- 规范依据：§26.2「正式比分缺失时，`regular_home_score`、`regular_away_score`、`match_score`、`wdl_hit`、`exact_hit` 均返回 `null`」；「取消比赛也保持预测结算字段为 `null`（第 9.4/21.8 节）」。§25.3 的 `my_prediction` 含同一组结算字段，应遵循同一领域规则。
- 影响：比赛已取消或正式比分已清空时，`GET /v1/matches/:match_id` 仍可能显示 0/3/12 命中，与 `GET /v1/predictions/me` 不一致。
- 建议修复：`mapMyPrediction` 与预测查询共用同一显示规则：无成对比分或 `match_status === cancelled` 时，三个结算字段强制 `null`。

#### F2 [重要] 注销用户在比赛详情被抹掉已存在的 `my_prediction`
- 位置：`src/application/match-query.ts:447`、`src/application/match-query.ts:454`
- 现状：`user.status === Deleted` 时不查预测，并令 `my_prediction = null`；同时 `toItem` 仍按已登录用户计算 `can_predict_reason=USER_DELETED`。
- 规范依据：§25.3「已登录且存在 prediction 时返回」`my_prediction` 对象。§25.1/§8.4 将 `USER_DELETED` 列为该公开接口的已登录拒绝原因，并未授权隐藏已提交预测。§26.2 的 `409 USER_DELETED` 只约束预测查询 API，不覆盖比赛详情。
- 影响：注销用户看比赛详情时 UI 辅助原因是「已注销」，但看不出自己已提交的比分；与 §25.3 合同及「已登录上下文」语义冲突。
- 建议修复：注销用户仍按 `user_id+match_id` 读取并返回 `my_prediction`（可继续对结算字段做 F1 的置空）；仅 `can_predict` 走 `USER_DELETED`。

### batch-12　个人资料/会话/分享卡/用户统计重建

#### F1 [重要] 分享卡把 `season_id` 做成必填且锁死当前赛季
- 位置：`src/application/share-card.ts:37`、`src/application/share-card.ts:58`、`src/application/share-card.ts:71`
- 现状：`SHARE_CARD_QUERY_FIELDS` 含 `season_id`；缺省或与 `league.season_id` 不等即 422。注释写明「API 与 application 共用」。
- 规范依据：§20「前端必须显式传 `league_id` 与 `round_id`，后端不猜『当前联赛/当前轮』」；round 统计按指定 `league_id` + `round_id`，未要求、也未授权用配置里的当前赛季覆盖。
- 影响：按规范只传两项会 422；配置切赛季后，历史 round 分享卡无法再取，等于后端指定当前赛季。
- 建议修复：查询契约只强制 `league_id`+`round_id`；`season_id` 若保留须允许该联赛合法历史赛季，不得写死 `=== league.season_id`。

#### F2 [重要] 分享卡 `season_level` 用墙钟，与资料口径可能分叉
- 位置：`src/application/share-card.ts:166`（对照 `src/application/profile.ts:67`）
- 现状：`getShareCard` 无 `serverNow`，`levelSeasonOf(new Date())`；`getMyProfile`/`getPublicProfile` 用调用方 `serverNow`。
- 规范依据：§20 / §24.2「`season_level` = 当前等级赛季的 `user_season_stats.level`，读缓存，禁止现场计算」；§24.2 要求与等级接口同一账户口径。
- 影响：请求时钟与墙钟跨赛季边界时，分享卡与 `/profile/me`、公开资料、levels 可能给出不同 `season_level`。
- 建议修复：与 Profile 一样注入 `serverNow`，`levelSeasonOf(serverNow)` 再读 `userSeasonStats`。

### batch-13　API 层（admin/校验/限流/等级/分享卡）

#### F1 [重要] retry-settlement 把 30.4 多类拒绝折叠成同一 409
- 位置：`src/api/v1/admin.ts:318`
- 现状：`already_running` 正确映射为 `SETTLEMENT_ALREADY_RUNNING`；但 `already_settled` 与 `not_retryable` 一律 `SETTLEMENT_NOT_READY`。本函数不再区分 `MATCH_STATE_CONFLICT` / Fail Closed 500，成功路径才认 `settled|failed`。
- 规范依据：§30.4「本节冻结……错误映射」：无 failed 且 `settlement_status != failed` → 409 `SETTLEMENT_NOT_READY`；有 failed target 但状态机不能转移（如 `pending`）→ 409 `MATCH_STATE_CONFLICT`；`status=failed` 找不到 failed settlement、版本序列/`is_correction` 冲突、或 `settled` 且 failed target 已在已结算版本范围 → 500 `INTERNAL_ERROR`，不得回退。
- 影响：本层对 retry 采用「返回 kind、由 API 映射」（`already_running` 即此契约）。pending / 已结算版本冲突会被说成「没有可重试 failed settlement」，客户端按 `code` 无法走对分支。
- 建议修复：按决策表拆 kind（或让 service 抛对应 `DomainError`）：无 failed target → `SETTLEMENT_NOT_READY`；状态机不能转移 → `MATCH_STATE_CONFLICT`；数据/版本 Fail Closed → `INTERNAL_ERROR`；禁止用 `details.kind` 代替 `code`。

#### F2 [重要] 无 query 的接口未拒绝未定义 query，非法请求会 200
- 位置：`src/api/v1/levels.ts:8`；`src/api/v1/admin.ts:207`；`src/api/v1/admin.ts:264`；`src/api/v1/admin.ts:359`；`src/api/v1/admin.ts:420`
- 现状：`getShareCardMe` 对 query 做 `assertUnknownFields`；`getMyLevels` 与四个 admin 写接口的 input 无 `query`，多出来的 `?foo=` 仍走成功路径。
- 规范依据：§23.4「未定义 query 参数：422 `VALIDATION_ERROR`」。§28.1 `GET /v1/levels/me` 无 query；§30.3–30.6 写接口只定义 path/body。
- 影响：同属 `/v1` 时，分享卡多参数 422，等级/admin 多参数 200/201，契约不一致。
- 建议修复：与分享卡相同，接收 `query` 并对空允许集 `assertUnknownFields`；或在进入这些 handler 前统一拦截未定义 query。

### batch-14　API 层（预测/比赛/资料/排行）

#### F2 [重要] 带 `cursor` 时允许只传 `season_id`、不传 `league_id`
- 位置：`src/api/v1/predictions.ts:208-210`
- 现状：`if (seasonId !== null && leagueId === null && query.cursor === undefined) { throw validationError(...) }` —— 只要带了 `cursor`，`season_id` 无 `league_id` 会放行。
- 规范依据：§26.2「提供 `season_id` 但缺少 `league_id` …：`422 VALIDATION_ERROR`」；「未知参数、类型错误由 handler 返回 422」；带 cursor 时显式参数与绑定筛选冲突也是 422，规范未给该组合开例外。
- 影响：`?cursor=…&season_id=其他赛季` 可绕过 handler 组合校验；若下游把「无 league_id 则 season_id 不生效」，会吃掉与 cursor 绑定 `season_id` 的冲突，分页窗口被静默改写。
- 建议修复：去掉 `&& query.cursor === undefined`。`season_id` 无 `league_id` 一律 422；cursor 绑定冲突仍交给 application，但不要在 handler 放行非法显式组合。

### batch-15　网关装配与种子

#### F1 [重要] 大量接口未把 query 交给校验，未定义参数会被静默忽略
- 位置：`src/gateway/assemble.ts:237`、`src/gateway/assemble.ts:265`、`src/gateway/assemble.ts:282`、`src/gateway/assemble.ts:337`、`src/gateway/assemble.ts:366`、`src/gateway/assemble.ts:379`、`src/gateway/assemble.ts:394`、`src/gateway/assemble.ts:469`、`src/gateway/assemble.ts:525`、`src/gateway/assemble.ts:551`、`src/gateway/assemble.ts:577`
- 现状：`handleGatewayRequest` 只把 `input.query` 传给少数列表/筛选 GET；`POST/PATCH/DELETE` 以及 `GET /v1/matches/:id`、`GET /v1/profile/me`、`GET /v1/profiles/:id`、`GET /v1/levels/me`、`GET /v1/groups/:id` 等均不传 `query`。网关入口也没有统一拒绝未知 query。
- 规范依据：§23.4「未定义 query 参数：422 `VALIDATION_ERROR`」
- 影响：`/v1/profile/me?foo=1`、`POST /v1/predictions?limit=20` 会成功落业务，而列表接口同类 typo 会 422；同一 `/v1` 校验语义分叉。
- 建议修复：在路由分发前对「无 query 契约」的方法做空集校验（有任意 key 即 422）；有 query 契约的继续交给原 validator，且写接口也要传入 `query`。

#### F2 [重要] 排行榜公开读写死 `LOCAL_PUBLIC_SOURCE`，与比赛/资料事实源分叉
- 位置：`src/gateway/assemble.ts:248`、`src/gateway/assemble.ts:266`、`src/gateway/assemble.ts:381`、`src/gateway/assemble.ts:426`
- 现状：`GET /v1/matches`、`GET /v1/matches/:id`、`GET /v1/profiles/:id` 使用 `input.config.public_source`；`GET /v1/rankings` 固定 `public_source: LOCAL_PUBLIC_SOURCE`。
- 规范依据：§0.5「发现缓存与事实不一致时，以事实数据重建」；公开读若比赛走非 LOCAL 源、榜单仍读本地 `rankings/users`，缓存窗口与比赛事实不再同一套。
- 影响：切换 `public_source` 后，比赛页与排行榜的球队/用户展示和可预测窗口会静默不一致。
- 建议修复：与其它公开读一样传入 `input.config.public_source`；若榜单依法只能读本地缓存，应在 `RankingQueryService` 内明确拒绝非 LOCAL，而不是在网关偷换数据源。

### batch-17　Provider 状态核对/同步配置/触发器

#### F2 [重要] live 状态应用未实现 LIVE_TOO_LONG
- 位置：`src/application/provider-status-sync.ts:767`、`src/application/provider-status-sync.ts:776`、`src/application/provider-status-sync.ts:784`
- 现状：首次 live 会写入 `period_anchor_at`，但无论 `applied` 还是 `unchanged` 都不检查 `server_now >= period_anchor_at + 150min && match_status == live`。长时间卡在 live 且其它字段不变时走 776 早退，永远不会开 anomaly。
- 规范依据：§33.2「`server_now >= period_anchor_at + 150min AND match_status == live` → open anomaly」
- 影响：超时仍 live 的场次无确定性告警，只能靠人工发现。
- 建议修复：在 `applyLiveFixture` 于 unchanged/applied 之前用注入的 `serverNow` 与 `nextPeriodAnchorAt` 判定；满足则 `persistAnomalyInTransaction(LIVE_TOO_LONG)`，条件消失再按 §33.6 关闭。不要放在 `if (!changed) return` 之后。

### batch-18　内存仓储实现

#### F2 [重要] 过期 `job_locks` 接管后事务回滚会删掉已提交锁行
- 位置：`src/infrastructure/repositories.ts:2094`、`src/infrastructure/repositories.ts:2111`
- 现状：lease 过期时直接 `set` 新 owner，undo 固定 `jobLocks.delete(lockKey)`，不恢复被接管的原文档。
- 规范依据：§21.19「`UNIQUE(lock_key)`；获取锁必须使用原子 compare-and-set；过期 lease 可被新 owner 接管」
- 影响：接管事务失败后锁行消失，CAS 回退语义被破坏；其他 job 会把“无锁”当成可立即抢占。
- 建议修复：undo 按写入前快照恢复：无旧锁才 `delete`，有旧锁则 `set(lockKey, existing)`。

#### F3 [重要] `users.created_at` 更新时可被改写
- 位置：`src/infrastructure/repositories.ts:930`
- 现状：`updateUser` 只拦 `career_best_level` 回退和 `openid` 唯一索引，未比较 `created_at`（以及其它 immutable 身份字段除 `user_id` 查找键外）。
- 规范依据：§21.1「`created_at date, immutable`」
- 影响：重建/纠偏/注销路径若带回错误 `created_at`，会改写用户事实时间，生涯榜并列键与审计截面失真。
- 建议修复：与 `updatePrediction` 一样，拒绝 `created_at`（及 `user_id`）任何变化。

#### F4 [重要] `TeamRepository` 只有 insert，无法维护“当前所属联赛/状态”
- 位置：`src/infrastructure/repositories.ts:139`、`src/infrastructure/repositories.ts:975`
- 现状：port 仅 `findById`/`insert`；同 `team_id` 再写会 `UniqueConstraintError`，没有 `update`。
- 规范依据：§21.3「`league_id` … 球队当前所属联赛」；`status enum(active, inactive)`；`updated_at`
- 影响：升降级、更名、停用无法落库；公开赛程仍可能展示过期联盟/队名，与 provider 同步契约断裂。
- 建议修复：补 `update(team)`：`team_id` 不可变，允许更新 `league_id/status/name/colors/updated_at`，并走 undo log。

### batch-19　CloudBase 适配与重建支撑

#### F2 [重要] 纠错链校验排了序，回放输入仍按乱序提交
- 位置：`src/application/rebuild-service-support.ts:164`、`src/application/rebuild-service-support.ts:220`、`src/application/rebuild-service-support.ts:236`
- 现状：按 `source_result_version` 排序的只是校验用副本；返回的 `facts`、`applied_items.push(...)`、`correctionSettledAts` 仍是调用方原始顺序。
- 规范依据：§35.1「career 与各未冻结等级赛季按 replay_level 回放；回放结果与缓存不同 ⇒ 覆盖缓存并写 `level_history(reason=rebuild)`」。
- 影响：纠错多版本时窗口 `n/S` 可能用错“当前分”，错误等级被当成 rebuild 结果落库。
- 建议修复：校验后写回该顺序；`buildReplayFacts` 对 `applied_items` 按 `source_result_version`（并列 `applied_at`）排序，`correctionSettledAts` 按时间排序再交给 replay。

**【主审复核】** 存疑（需实证）：校验副本排序而回放输入保持原序；若 buildLevelInputs 内部按 source_result_version 择优则无影响，否则多版本纠错时窗口 n/S 可能取错——建议修复轮补用例验证。

### batch-20　OpenAPI 合同文件（全量）

#### F3 [重要] `RankingData` 未按 `board` 约束 `period_key` 与 `items` 形状
- 位置：`src/api/v1/openapi.yaml:1185`；同类：`src/api/v1/openapi.yaml:1972`
- 现状：`board`、可空 `period_key`、`items: RankingItem`（三型 `oneOf`）彼此独立。合法响应可以是 `board=week` 且 `period_key=null`，或 `board=career` 却混入 week/strength item。
- 规范依据：§27.1 `period_key` 仅 `board=week` 有效，week 响应必须带周期键；career/strength item 字段集与 week 不同。§30.6 `board != week` 时响应 `period_key` 为 `null`
- 影响：客户端无法按 `board` 做穷尽解析；实现也可在合同内返回错误榜型字段。
- 建议修复：将 `RankingData`（及 rebuild 响应）拆成 week/career/strength 三个 `oneOf` 分支，分别冻结 `period_key` 与对应 item schema。

#### F4 [重要] `StrengthRankingItem` 丢掉了 §27.1 的基字段
- 位置：`src/api/v1/openapi.yaml:1158`
- 现状：仅有 `rank/user_id/display_name/favorite_team_id/career_level/strength_index/window_n`，没有 `valid_predictions`、`exact_hits`、`last_scoring_match_at`。
- 规范依据：§27.1 week item 为基形；`board=strength`「额外包含 `strength_index` 与 `window_n`；不返回 `period_score`/`career_points`」
- 影响：实力榜合同比规范少 3 个公开字段，与 week/career 条目无法按差量对齐。
- 建议修复：在去掉 `period_score`/`career_points` 后保留上述三字段，并继续 `additionalProperties: false`。

#### F5 [重要] 排行榜 `me` 不允许 `null`，与未登录语义冲突
- 位置：`src/api/v1/openapi.yaml:1209`
- 现状：`me` 不在 `required` 中，但类型只是 `RankingMe` 三态对象，未 `nullable`。省略字段合法，`me: null` 不合法。
- 规范依据：§27.1「未登录请求不返回 `me`（或 `me=null`）」
- 影响：规范允许的 `me=null` 会被本合同判失败，实现只能靠缺字段表达，客户端分支不一致。
- 建议修复：`me` 改为 `RankingMe | null`（OAS 3.1 union），未登录可省略或显式 `null`。

### batch-21　小程序前端适配（R15）

#### F1 [重要] 榜单切换/翻页不丢弃过期响应，会按当前 board 错映射甚至混榜
- 位置：`miniprogram/pages/rankings/rankings.js:69`、`miniprogram/pages/rankings/rankings.js:85`、`miniprogram/pages/rankings/rankings.js:112`、`miniprogram/pages/rankings/rankings.js:142`
- 现状：`listRankings` 回包后一律 `applyListResult`；`presentItem(item, this.data.board)` 用的是回包当下的 tab，不是请求时的 `board`/`data.board`。`onMore` 以 `replace=false` concat。
- 规范依据：§27.1「`board` 为 `week|career|strength`；career 主字段为 `career_points`/`career_valid_predictions`；strength 为 `strength_index`/`window_n`，不返回 `period_score`/`career_points`」
- 影响：快速切「周榜/生涯榜/实力榜」或先翻页再切榜时，旧包可把生涯积分画成实力指数（值为 `undefined`），或把 A 榜第 2 页拼进 B 榜。
- 建议修复：请求时闭合 `board`（及自增 seq）；回包若 `board !== this.data.board` 则丢弃。`presentItem` 用请求 `board` 或响应 `data.board`；`onMore` 仅在 board/cursor 仍匹配时 concat。

### batch-22　结算生命周期服务（首结算/重试/修正/后置）

#### F3 [重要] 失败重试入口拒绝 correction，违反管理员重试决策表
- 位置：`src/application/retry-settlement-service.ts:116`、`src/application/retry-settlement-service.ts:163`、`src/application/retry-settlement-service.ts:232`
- 现状：`retry(settlementId)` 对 `is_correction` 直接 `not_retryable`；即便去掉该判断，match 也一律 `failed→settling`，不会 `failed→correcting`。
- 规范依据：§30.4「match=failed 且 failed target `is_correction=true`：复用原 correction settlement 与 items，使用其 immutable `result_version`，match `failed→correcting`；不得跳到当前最新 result_version」；§11.2 允许 `failed→correcting`
- 影响：按 settlement_id 走「唯一重试入口」时，修正结算失败无法恢复；已 applied 的 correction items 也无法按 30.4 续跑。
- 建议修复：`retry` 复用 failed correction settlement；`is_correction=true` 时 match `failed→correcting`，且只处理该 settlement 自己的 `result_version`。

#### F4 [重要] 已获得 match 租约仍把 `status=running` 当并发冲突，无法接管
- 位置：`src/application/first-settlement-service.ts:280`、`src/application/retry-settlement-service.ts:126`、`src/application/correction-settlement-service.ts:261`
- 现状：`jobLocks.acquire` 成功后，若该版本 settlement 仍是 `running`，三个服务都立即 `already_running` 并释放锁，不把其视为租约过期后的可恢复任务。
- 规范依据：§15.1「同一 match 同时最多一个 settlement，锁 `settlement:match:{match_id}`，lease 默认 10 分钟可续租」；§30.4「match 为 settling/correcting，或存在任意 `status=running` 的 settlement → 409，且优先于 failed target」——running 也不能被管理员 retry
- 影响：进程在标 running 后崩溃时，锁会过期但 status 仍 running；自动跑批与管理员 retry 都被挡掉，结算永久卡死。
- 建议修复：已持有该 match lease 时，将遗留 `running` 视为原持有者死亡，按 failed 恢复语义续跑（只处理 pending/failed items），而不是当并发冲突。

### batch-23　Provider 巡检（live/post-finish）与 HTTP 客户端

#### F2 [重要] 已知场次按 id 拉取被放进 loader，单场 IO 失败会锁死整批
- 位置：`src/application/provider-live-match.ts:65`、`src/application/provider-live-match.ts:135`、`src/application/provider-post-finish.ts:116`
- 现状：`loadKnownUnfinishedFixtures` / post-finish 对每场 `getFixtures({fixtureId})` 且 `Promise.all`；任一次 5xx/408/网络错误使整个 `load` 失败，走 32.8 loader retry，期间 job lock 仍被占用。
- 规范依据：§32.8「单 fixture 应用阶段的失败不进入 loader retry」；§32.7 锁未释放则其他同类 job `skipped(lock_held)`；§33.1 连续 10 分钟无法成功同步。
- 影响：一场坏 id/暂时错误会拖住全部 live/完赛确认（retry 等待最长约 1+2+5+10+30 分钟），且本轮可能根本走不到 `patrolLiveMatches`。
- 建议修复：loader 只按 `league_id`+`season`（加 T-2h 窗口/live）批量取数；单场补充拉取失败记该实体失败，不升级为 loader retry，也不阻断同批其它场。

#### F3 [重要] 全量 `teamSync` 放在 live/post-finish loader 的成功前置路径
- 位置：`src/application/provider-live-match.ts:64`、`src/application/provider-post-finish.ts:82`
- 现状：`teams ??= await this.teamSync.sync(loadNow)` 先于任何 fixture 拉取；球队侧 429/`ProviderQuotaExceededError`/`ProviderDataError` 会直接让 32.4/32.5 任务失败。
- 规范依据：§32.4/§32.5 任务对象是 T-2h～finished / 完赛确认；§32.8 quota 须停高频 retry，不得用密集请求撞额度；§31.9 入口 Fail Closed 应限于本任务必要 IO。
- 影响：与赛况无关的球队全量同步失败/打满 quota 后，live 状态、完赛比分确认、33.1/33.3 巡检都不会发生。
- 建议修复：球队同步移出这两个高频 loader 的关键路径（独立 job 或失败降级）；本任务在已有 team mapping 上仍必须能拉/应用 fixture。

### batch-24　管理操作服务（admin/赛果修正/重试结算）

#### F2 [重要] 目标 settlement 成功时 outcome 出现非冻结值 `correcting`
- 位置：`src/application/admin-retry-settlement.ts:194`、`src/application/admin-retry-settlement.ts:231`、`src/application/admin-retry-settlement.ts:236`
- 现状：`kind === "correcting"` 原样返回；仅当后续把 match 洗成 `settled` 才改成 `settled`。规范成功体只有 `outcome: settled|failed`。
- 规范依据：§30.4「`outcome` 枚举：`settled` / `failed`」；correction retry「成功后若仍有更高未处理 result_version，match 保持 `correcting`，否则 `settled`」。§15.9：`result_version > v` 时 **settlement 仍为 settled**，只是 match 保持 `correcting`。
- 影响：match 仍为 `correcting` 时会把非冻结 `correcting` 当 outcome；或把 match 状态误当成本次 settlement 结果。
- 建议修复：目标 settlement 正常完成 → 固定 `outcome=settled`（即使 match 仍为 `correcting`）；仅当**该** reuse settlement 自身进入 `failed` 时才 `outcome=failed`。

**【主审复核】** 属实（同主题）：match 仍 correcting 时会返回非冻结枚举 correcting 作为 outcome；§30.4 成功体枚举为 settled/failed（§15.9：settlement 仍为 settled、match 保持 correcting）。修复：目标 settlement 正常完成→固定 settled。

## 五、优化建议（9 条）

### batch-03　类型与数据库 Schema/索引

#### F3 [优化] 规范 `fixed` 字段未在 schema 冻结
- 位置：`src/domain/types.ts:38`、`src/schema/collections.ts:67`、`src/schema/collections.ts:173`
- 现状：`schema_version` 仅为 `int default 1`；`matches.scoring_rule_version` 仅为 `default: "scoring_v1"`，均可写成其他值。
- 规范依据：§21「所有核心文档 `schema_version = 1`」；§21.5「`scoring_rule_version` string, fixed `scoring_v1`」。
- 影响：存储契约允许非 v1 文档/计分规则版本，唯一键 `settlements(match_id, result_version, rule_version)` 可能被平行版本切开。
- 建议修复：`schema_version` 用 `enum: [1]`（或 min=max=1）；`scoring_rule_version` 用 `enum: ["scoring_v1"]`。

### batch-06　结算账本应用与编排

#### F3 [优化] 零分修正重算 last_scoring 对每条 prediction 再查 match
- 位置：`src/application/settlement-item-application-service.ts:166`、`src/application/settlement-item-application-service.ts:195`
- 现状：`findByUser` 全量预测后循环 `matches.findById`，item 热路径放大为 O(预测数) 次查询。
- 规范依据：§15.7 / §16.1 要求重算最大 `period_anchor_at`，未要求该 IO 形状。
- 影响：生涯预测多的用户，12→0 修正会显著拉长单项事务。
- 建议修复：一次查出该用户已结算且 `match_score>0` 的 prediction+`period_anchor_at`（周榜再按 `period_key` 过滤）在内存取 max。

### batch-07　统计重建

#### F3 [优化] 单用户 rebuild 全量加载全站 applied 账本
- 位置：`src/application/stats-rebuild-service.ts:324`
- 现状：`findByStatus(Applied)` 后再 `filter(user_id)`，每次重建扫描全部用户的 applied items。
- 规范依据：§35.1「Source：`status=applied` 的 settlement_items」——事实源是该用户账本，不是全站账本。
- 影响：用户量上升后 rebuild 会线性变慢，并拉长与结算的锁窗口。
- 建议修复：改为按 `user_id + status=applied` 查询（或 prediction_id 集合查询）。

### batch-09　排行榜查询/快照/封存/管理员重排

#### F3 [优化] 快照任务锁冲突直接失败，和封存任务的跳过策略不一致
- 位置：`src/application/board-snapshot.ts:210`；对照 `src/application/period-finalize-service.ts:86`
- 现状：`BoardSnapshotService.generate` 抢锁失败抛 `SETTLEMENT_ALREADY_RUNNING`；`PeriodFinalizeService` 抢锁失败返回 `skipped: true`。
- 规范依据：§19.1 / §34.4「实力榜……每次周评估任务完成后 + 每日 1 次（吸收修正重评）」；「`strength` 榜：……在每次 `weekly_level_eval` 完成后与每日定时生成快照」
- 影响：周评估后的实力快照若撞上每日快照/重建锁会被记为失败，可能丢掉「评估完成后必须出一张快照」这次更新。
- 建议修复：与 `period_finalize` 对齐：锁占用则 skip/延期，不要用结算中的冲突码把快照 job 打成失败。

### batch-15　网关装配与种子

#### F3 [优化] 排行榜种子写入不存在的 `favorite_team_id`
- 位置：`src/gateway/seed.ts:143`、`src/gateway/seed.ts:181`
- 现状：`RankAlice` 的 `favoriteTeamId: newUuid()` 只写进 `users.favorite_team_id`，未 `insert` 对应 `teams`（且该种子按注释还不能并入已有球队的 `seedGatewayRepository`）。
- 规范依据：§0.3「读取接口可以返回已有数据，但不得制造缺失业务事实」
- 影响：排行榜公开读一旦展开主队，会出现悬空引用（失败或给出不存在的球队）。
- 建议修复：先插入真实 `teams` 再引用其 `team_id`，或对该用户保持 `favorite_team_id: null`。

### batch-17　Provider 状态核对/同步配置/触发器

#### F3 [优化] `live_match` 窗口只编码了 T-2h 起点，未编码「～ finished」
- 位置：`src/sync/config.ts:45`、`src/sync/config.ts:40`、`src/sync/config.ts:49`
- 现状：`near_match` 有起止小时；`post_finish_verify` 有 `highFrequencyUntilFirstSettlement`；`live_match` 仅 `windowStartHoursBeforeKickoff: 2`，没有「直到 finished」的合同字段。
- 规范依据：§32.4「T-2h ～ finished：每 3 分钟」；§32.5 完赛后高频改由 `post_finish_verify` 接到首次 settlement
- 影响：runner 若只读该配置，可能把已 finished 场次继续按 3 分钟拉取，与 32.4/32.5 切分重叠、多耗 quota。
- 建议修复：为 `live_match` 增加明确终点（如 `untilFinished: true` / `windowEndOnFinished: true`），并让 runner 只消费该字段，finished 后交给 `post_finish_verify`。

### batch-18　内存仓储实现

#### F5 [优化] `anomaly_key` 未按 match+type 派生，唯一索引保不住“同一异常一条”
- 位置：`src/infrastructure/repositories.ts:2006`、`src/infrastructure/repositories.ts:2013`
- 现状：只保证 `anomaly_id`/`anomaly_key` 唯一，不校验 `anomaly_key === match_id + ":" + type`。
- 规范依据：§21.18「`anomaly_key = match_id + ":" + type`」；「重复出现更新同一记录」
- 影响：错误 key 可插入多条同一 `match_id+type`，巡检会当成新异常而非更新 `occurrence_count`。
- 建议修复：insert/update 强制派生 key；重复应走 `update`，不要再 `insert`。

### batch-20　OpenAPI 合同文件（全量）

#### F6 [优化] 通用 `Page` 未冻结 `has_more` 与 `next_cursor` 成对规则
- 位置：`src/api/v1/openapi.yaml:2074`（预测/比赛/异常/群列表均引用）
- 现状：`has_more=true` 且 `next_cursor=null`、或 `has_more=false` 且仍给 cursor，均为合法。
- 规范依据：§23.8 / §26.2「`next_cursor` 仅在 `has_more=true` 时返回」；「`has_more=false` 时 `next_cursor=null`」
- 影响：分页结束条件可被合同内不一致响应绕过，后续页窗口不稳定。
- 建议修复：`Page` 用 `oneOf`：`{has_more: true, next_cursor: string}` 与 `{has_more: false, next_cursor: null}`。

### batch-23　Provider 巡检（live/post-finish）与 HTTP 客户端

#### F4 [优化] T-2h/完赛确认用 N 路按 id 打点，而不是按联赛窗口批量
- 位置：`src/application/provider-live-match.ts:98`、`src/application/provider-live-match.ts:135`、`src/application/provider-post-finish.ts:116`；`src/provider/http.ts:218`
- 现状：已有 `league`+`season`+`from`/`to`/`timezone=UTC` 的批量契约，却对每个 candidate 再打一次 `id`；live 还与 `liveMatchLoader` 结果按 `fixture.id` 去重。
- 规范依据：§31.1「每个 Provider 请求按 `api_football_league_id` + `api_football_season` 分别发起」；§32.8 quota 超限后停止高频自动重试。
- 影响：3 分钟 live 叠加全量 teams + 逐场 fixtures，容易先撞 429，再放大 F2/F3。
- 建议修复：每联赛一次窗口查询（T-2h～now 的 scheduled + live）；仅对批量遗漏且确需核对的 id 做有限补拉。

## 六、各批次「已核查无问题」摘录

### batch-01　等级核心规则

- `evaluateLevel` 与 §17.6.4 一致：Lv1 只看累计 `valid_total≥20`、一次最多 ±1、升级优先、Lv2 不降、保级用整数交叉乘、保护期不降且 `below_count` 清零、`best_level` 只增
- `buildLevelInputs` 与 §17.5 一致：`applied_at<as_of`、白名单、730 天开区间、season 显式 `level_season_id`、`period_anchor_at DESC, match_id ASC` 取 300、得分取最大 `source_result_version` 的 `new_score`；B/`valid_total` 为累计而非窗口
- `replayLevel` 周评估先写入 `week_base` 再 fold；修正从 `week_base.level/below_count` 重跑且不改 `week_base`，`best_level` 取当前值只增，符合 §17.7 / §17.9.2

### batch-02　时间/周期/枚举/配置

- `computePredictionDeadline` 与 §6.2 一致：`kickoff_confirmed=true` 时 `kickoff_at - PREDICTION_LOCK_MINUTES(10)`，否则 `null`；纯函数不擅自改写已关闭 deadline。
- `weekPeriodKey` / `periodEndAt` / `isValidPeriodKey` 与 §7.1 一致：先把 `period_anchor_at` 转为北京日期再算 ISO week-year（含 12/1 月跨年与 W53）；周期右开为下一北京周一 `00:00` UTC instant，`server_now >= periodEndAt` 即属下一周。
- `FIXED_CONFIG_V1` 与 §3 冻结值对齐（锁分、计分、同步、等级阈值/窗口、榜单与群上限、邀请码字符集）；`levelSeasonOf` 按北京 `07-01 00:00` 切年（§3 `LEVEL_SEASON_BOUNDARY`）；`LEVEL_FIRST_EVAL_AS_OF=null` 不在工具内发明上线日，与「只追加登记」一致。

### batch-03　类型与数据库 Schema/索引

- §22.1 全部必须 UNIQUE（含 predictions 双唯一、board_snapshots/groups/group_members）均已定义。
- §22.2 全部「至少创建」查询索引的字段组合与 DESC 方向对齐。
- §21.1–21.19 / §21.21–21.22 核心字段名、可空性、枚举取值与默认值与规范一致。

### batch-04　排行榜比较器与周期重建

- week/career 五键顺序与 `last_scoring` 非 null 优先、实力榜 `s`→`n DESC`→`user_id` 与 §19.5 一致。
- 周期重建只累加 `applied` `settlement_items` 的 delta，`last_scoring` 取每预测最高 `source_result_version` 且 `new_score>0` 的 max `period_anchor_at`，`period_score=0` 强制 null，符合 §35.2/§19.5。
- 当前周过滤 `Deleted`、历史周保留并 `is_final` 只升不降，符合 §19.6/§19.7；不以旧 `rankings` 分数为输入。

### batch-05　周评估/修正重评/等级应用服务

- §17.6.2/§17.5.1：周评估与修正重评都用 `findAppliedByUserBefore(as_of)`，截止只看账本时刻，与任务实际运行时间脱钩。
- §17.7.1/§17.8.4：仅 `is_correction && phase=done && score_delta≠0` 触发；career 必评；`is_level_frozen` 的赛季不改判；赛季最终周评估后才打冻结。
- §17.9.5/§17.11：history 只在 `from≠to` 时追加且修正不删 `weekly_eval`；`GET levels` 读缓存；`is_former_top` 由 `best==6 && level<6` 派生。

### batch-06　结算账本应用与编排

- §14.4–14.6：`assertItemMatchesPrediction` + `assertDeltaMatchesItem` 强制 old 为当前已 applied，禁止从 v1 重放 delta。
- §15.4 / §15.6：Applied 短路不重放；career/season/week 均用事务内当前值+账本 delta，首次/修正 hit 公式等价 `new-old`。
- §15.7 / §16.2：新分>0 走 max；零分修正且锚点等于当前 last_scoring 则全量重算；season 按 `levelSeasonOf(period_anchor_at)` 创建/更新，本服务不改冻结赛季 level。

### batch-07　统计重建

- career/season 的 points、valid_predictions、wdl/exact 均按 applied item 的 `score_delta` / `valid_prediction_delta` / bool delta 求和，赛季按 `period_anchor_at → level_season_of` 分组，未用 prediction 缓存字段。
- `career_best_level` / `season.best_level` 取 max(现有, history.to_level, 回放轨迹)，普通 rebuild 不下降；unlock 只插入不删除。
- 维护锁 `maintenance:rebuild:user:{id}` + 用户相关 settling/correcting 比赛返回 `409 SETTLEMENT_ALREADY_RUNNING`，符合 §35.3。

### batch-08　每日一致性快照与对账

- 在途 `settling/correcting` 跳过受影响用户/season/user-period，period 级不判 `global_rank`，并记录 `skipped_active_settlement`（§34.5）。
- `loadDailyConsistencySnapshot` / `checkDailyConsistency` 只产出 differences，不写回业务数据（§34.5「只报警，不自动静默修复」）。
- week 榜从 applied 账本重算分数/`last_scoring_match_at`/`global_rank`；board expected 走 `users` 缓存而非扫描 `predictions`（§34.4/§34.5/§42.1）。

### batch-09　排行榜查询/快照/封存/管理员重排

- 周榜只出 `global_rank != null`；生涯/实力入榜门槛在快照生成时过滤 Active + 场次/窗口 n，且不扫 predictions（§19.1/§19.2/§27.1/§34.4）。
- 群榜按当前 active 成员过滤后独立重排；群不存在/已解散 `GROUP_NOT_FOUND`，非 active 成员 `FORBIDDEN`（§19.4.1/§27.1/§27.2）。
- 封存只把 week 的 `is_final` 置 true 且不回开；管理员重建校验 `board`/`period_key`/`reason` 并在同一事务写 `admin_audit_logs`（§19.6/§30.1/§30.6）。

### batch-10　群组

- 加入判定顺序与 §27.2 优先级表一致（格式 → 不存在 → 已解散 → 已是成员 → 群人数 → 加入上限）。
- 邀请码唯一冲突在事务外重试再生，不把冲突返回客户端（§27.2 POST `/v1/groups`）。
- 空对象建群、群主不可退出、非群主解散拒绝、POST 走 `groups` 限流 / GET 走 `authenticated_reads`（§27.2 / §36.4）。

### batch-11　比赛与预测查询

- §25.1 默认窗 `now-24h..now+30d`、90 天上限、`kickoff_at ASC, match_id ASC` 及 cursor 半开翻页一致。
- §26.2 `submitted_at DESC, prediction_id DESC`、cursor 绑定 `league_id`/`season_id`、显式参数冲突 `422`、`has_more=false` 时 `next_cursor=null` 正确。
- §26.3 非本人/`null` 统一 `404 PREDICTION`；§8.4 列表对注销用户不查预测，避免 `USER_DELETED` 被 `ALREADY_SUBMITTED` 抢先。

### batch-12　个人资料/会话/分享卡/用户统计重建

- `SessionService.init`：active 同 openid 返回已有用户且不覆盖 nickname；无 active 则新建；unique 冲突回读胜者（§4.2 / §4.6 / §24.1）。
- `deleteMyProfile`：同事务 upsert `deleted_openid_mappings` 后按 §4.5 墓碑化（`deleted:<user_id>`、openid 移除、unionid/nickname/主队清空）。
- `AdminRebuildUserStatsService`：无客户端 reason，审计固定「管理员用户统计重建」，与重建同事务写 `admin_audit_logs`（§30.1 / §30.5）。

### batch-13　API 层（admin/校验/限流/等级/分享卡）

- 四个 admin 写接口：空 body 拒 `reason`、`career/strength` 禁 `period_key`、成功 Envelope 含 `audit_id` 且不回传 `admin_id`/完整 `audit_log`，符合 §30.1/§30.3–30.6。
- `admin_apis` 60/min、`RATE_LIMITED`→429；缺可信身份抛 `UNAUTHORIZED`（401），符合 §23.5/§30.2/§30.4。
- `mapErrorToHttp` 将 `AUTH_REQUIRED` 改写为 `UNAUTHORIZED`；分享卡成功体按 §23.2 包裹 §29.1 字段，未把 `request_id` 当业务幂等键。

### batch-14　API 层（预测/比赛/资料/排行）

- `POST /v1/predictions` 成功 envelope 与 `idempotency_key`/`request_id` 分离，符合 §26.1 / §23.3。
- `GET /v1/rankings` 对 `board`/`period_key`/`scope`/`group_id` 组合校验符合 §27.1。
- `PATCH /v1/profile/me` 字段白名单+至少一项、`DELETE` 返回 204 无 body，符合 §24.3 / §24.4 / §23.5。

### batch-15　网关装配与种子

- 公开读用 `publicReadUserId`（deleted → `can_predict_reason=USER_DELETED`），认证读用 `authenticatedReadUserId`（deleted → HTTP `USER_DELETED`），未把 `UNAUTHORIZED` 与 `AUTH_REQUIRED` 混用，符合 §23.5/§23.7。
- `request_id` 仅作链路 trace 注入 handler，预测幂等仍走 body 里的 `idempotency_key`，符合 §23.3。
- 周榜种子的 `period_key` 调用 `calculatePeriodKey(PeriodType.Week, serverNow)`，未在网关复制周期公式，符合 §0.4。

### batch-16　Provider 映射/装载/赛程与球队同步

- `loadFixturesForSupportedLeagues` 按 `api_football_league_id + api_football_season` 分联赛请求后合并，符合 §31.1，未跨联赛复用同一响应。
- `normalizeFixture` 仅在 `FT` 抽取 `score.fulltime` 且校验 0..99（§31.4）；ET/AET/PEN 走 `UNEXPECTED_PROVIDER_STATUS` 且不猜分（§31.3）；kickoff 偏差记 `PROVIDER_DATA_INVALID` 并 `entityFailed`（§31.2/§31.5）；`round_id` 按 `round_max` 校验（§5.3）。
- 球队/赛程发现用内部 UUID + `team_provider_mappings`/`match_provider_mappings` 的 `(provider, external id)` 查找后插入（§5.1/§5.2），入口均先校验 `server_now` 再 IO/写入（§31.9）。

### batch-17　Provider 状态核对/同步配置/触发器

- §32.1–32.6 / 32.9 / 32.11–32.12：`SYNC_TASKS_V1` 间隔与 `jobLockKey`=`sync:{job_type}`、周评 `10 2 * * 1` 按 UTC 对应北京 10:10 的换算，与触发器清单一致。
- §33.5：scheduled/live/postponed/cancelled 在 `validateMatchTransition` 失败时 `blocking=true` 且不写回 `match_status`。
- §41：本文件只改状态/开球/球队/结算 void（取消），不覆盖 regular score、不创建正式 `result_version`。

### batch-18　内存仓储实现

- `predictions` 的 `UNIQUE(user_id,match_id)` / `UNIQUE(user_id,idempotency_key)` 与提交事实字段不可变，和 §21.8/§22.1 一致。
- `settlements`/`settlement_items`/`board_snapshots`/`groups`/`group_members` 唯一键写入时同步维护，回滚按 LIFO。
- `users.openid` 唯一、`career_best_level` 只增不减，以及 match 的 `prediction_closed_at`/`period_anchor_at`/`finish_detected_at` once-set 不可变，符合 §21.1/§21.2/§21.5。

### batch-19　CloudBase 适配与重建支撑

- §35.1：loader 只用预测身份/原始比分与 `match_results` 核对 item，不以 `predictions.match_score/wdl_hit/exact_hit` 做聚合。
- §21.11：`score_delta = new-old`、`source_result_version = settlements.result_version`，以及首笔 `valid_prediction_delta=1`、后续链 `old=prev.new` 均有校验。
- §21.1：CloudBase `users` 字段与强制 `schema_version=1` 对齐；骨架未接线方法 Fail Closed，未静默当成空数据。

### batch-20　OpenAPI 合同文件（全量）

- §23.9 身份模型：根级 `x-trusted-runtime-openid`，需登录操作标 `x-requires-trusted-openid`，未声明 Bearer/Cookie。
- §26.1–26.4：预测 201/200 幂等信封、历史预测 19 字段白名单、无 PATCH/PUT/DELETE。
- §30.1–30.6：四个写操作 `audit_id` 摘要、reason 来源（校正/重建榜有 body，重试结算/重建用户空对象且可选 body）与错误码入口一致。

### batch-21　小程序前端适配（R15）

- 三榜主字段映射与 §27.1 一致（week=`period_score`/`valid_predictions`，career=`career_points`/`career_valid_predictions`，strength=`strength_index`/`window_n`），且未展示准确率（§16.3/§27.1）。
- 资料页使用 §24.2 字段，未输出已删除的 `career_wdl_accuracy_percent`；`409 USER_DELETED` 按 §28.1 处理。
- 未登录不渲染 `me`；客户端只发 `week|career|strength`，且不传 `period_key`/`group_id`，避免 §27.1 非法组合 422。

### batch-22　结算生命周期服务（首结算/重试/修正/后置）

- §11.2/§15.9：finalize 用状态机合法表做 `settling→correcting`，未先标 `settled` 再立刻 correcting。
- §15.4：三处 item 循环都跳过 `applied`，失败路径不把已提交 applied 改回未发生。
- §15.3/§14.7：修正按 `settled_result_version+1` 推进；0 条 items 仍可把 settlement 落到 `settled/done`。

### batch-23　Provider 巡检（live/post-finish）与 HTTP 客户端

- `getFixtures`/`getSeasonFixtures` 显式 `timezone: "UTC"`，符合 §31.2；白名单 + 禁止 odds/bookmaker/bet，符合 §31.1。
- HTTP 429 与 envelope `errors.quota` 转为 `ProviderQuotaExceededError` 且不在客户端重试，符合 §32.8。
- live 窗口含 live 与 `kickoff_at <= serverNow+T-2h` 的 scheduled，完成后 `patrolLiveMatches(serverNow)`；post-finish 高频仅 `finished/finish_detected` 且 `pending|waiting`，符合 §32.4/§32.5/§31.9/§33.1。

### batch-24　管理操作服务（admin/赛果修正/重试结算）

- §30.1 reason：赛果修正原样写入 `input.reason`；retry 固定 `管理员重试结算`，无 request reason。
- §30.4 前置拒绝：`MATCH_NOT_FOUND`、match=`settling|correcting`、任意 `running` settlement 均优先于 `selectFailedSettlementTarget`；本层不直接改积分/items。
- §30.3：`expected_result_version` CAS、`match_results` 不可变插入、`result_source=admin`、审计与赛果变更同事务。

## 七、附录

- 第一轮报告：`docs/MVP2.0__CODE_REVIEW__v1.0.md`；修复轮报告：`docs/MVP2.0__FIX_ROUND__v1.0.md`。
- 原始产出：`/root/claude-review/findings/batch-01..24.md`；第一轮存档 `findings-r1/`；事件日志 `logs/`。
- 审查过程校验：24 批零失败、零仓库副作用（repo-status before/after 一致）。
- 说明：重要/优化级发现未逐条复核（除注明者），保留原文与证据位置供修复时按条核对。
