# 赛事预言家 MVP 2.0 全量业务 Review

## 1. 元信息

| 项 | 内容 |
|---|---|
| HEAD | `1be8b6fee5d93390f4b6d1b5ceff8bc703cc20b8`（`main`，工作树干净） |
| 审查日期 | 2026-10-12 |
| 工作目录 | `/home/football` |
| 业务基线 | `docs/MVP__v2.0.md`（已通读） |
| API 合同 | `src/api/v1/openapi.yaml`（已通读，2468 行） |
| 旧报告（仅线索） | `docs/MVP2.0__CODE_REVIEW_R2__v1.0.md`、`docs/MVP2.0__FIX_ROUND_R2__v1.0.md`、`docs/MVP2.0__COMPLIANCE_FIX_DELIVERY__v1.0.md` |
| 范围 | 只读业务逻辑：规范符合性、OpenAPI↔后端、R2 复核、交付核实、小程序合同使用。不改仓库任何文件。 |
| 不在范围 | 防御性/安全/性能/风格/测试覆盖率本身；CloudBase 真实接线；微信开发者工具/真机。 |
| 未覆盖 / 无法核实 | R2 仓储 undo（job_locks 接管回滚）、`users.created_at` 可变、`TeamRepository` 无 update、历史赛季冻结回放细节；微信未实测（与交付记录一致）。 |
| 口径 | 只列有 `文件:行号` 的业务问题。不确定写「不确定」，不编行号。准确优先于穷尽。 |

---

## ① 业务规范缺陷

对照 `docs/MVP__v2.0.md` 当前 HEAD 实现。只列问题。

| ID | 规范位置 | 类型 | 严重度 | 问题 | 证据 |
|---|---|---|---|---|---|
| B-01 | §1.4 / §5.2 / §31.1 / §31.10 | 规范待澄清 | 严重 | 联赛主 Provider 四处互相矛盾。§1.4 表：英超 `football_data`、中超 `bsd`、西甲/意甲/德甲/法甲 `api_football`。§5.2 写「MVP 只实现 `api_football`」。§31.1/§31.10 写五大联赛以 `fd` 为主。代码 `SUPPORTED_LEAGUES` 五大联赛全部 `provider: "football_data"`。上线后采信源以哪份为准未冻结。 | `docs/MVP__v2.0.md:224-235`、`:649`、`:4408`、`:4575`；`src/domain/config.ts:91-186` |
| B-02 | §3；README | 不一致 | 重要 | 规范与代码的等级赛季边界是北京时间 **07-01**；README 写成「8 月切换」。小程序 `currentSeasonId` 按 JS `getUTCMonth() >= 6`（即 7 月）切年，与代码一致、与 README 不一致。 | `docs/MVP__v2.0.md:384`；`src/domain/config.ts:70`；`src/domain/time.ts:184-188`；`README.md:27`；`miniprogram/utils/rankings-view-model.js:69-74` |
| B-03 | §19.4.2 / §21.22 / §40 | 规范待澄清 | 严重 | 解散事务把**包括群主在内**的全部 `active` 成员改为 `left`、`member_count=0`（名额可回收）。§40 明文「群主的 group_members 不得进入 `status=left`，只能 `groups.status=dissolved`」。§21.22 只禁止对群主做普通退出。实现与不变量表冲突，需要产品拍板。 | `src/application/groups.ts:420-436`；`docs/MVP__v2.0.md:2188`、`:3041`、`:5222` |
| B-04 | §21.20 | 规范待澄清 | 重要 | `board_snapshots` 仍写入 `snapshot_kind=head` 哨兵行（nil UUID、`rank=1`）。§21.20 无此字段。查询侧已跳过 head，不会当作用户展示，但是规范未登记的扩展。 | `src/domain/types.ts:289,298`；`src/schema/collections.ts:561`；`src/domain/invariants.ts:167-211`；`src/application/ranking-query.ts:572`；`docs/MVP__v2.0.md:2976-3009` |
| B-05 | §17.7 / §40 | 规范待澄清 | 重要 | 不变量断言：非 rebuild 的 `level_history` 必须 `\|Δ\|≤1`。§40 同时要求「同一评估周 `level ≤ week_base_level+1`」。同周 correction 从 `week_base-1` 回到 `week_base+1` 会跨 2 级，与 history 断言互斥。 | `src/domain/invariants.ts:144-147`；`docs/MVP__v2.0.md:5208-5209` |
| B-06 | §7 / §32.6 | 不一致 | 优化 | `PeriodType` 仍含 `month`；§32.6 已声明月榜取消。`calculatePeriodKey` 对非 week 直接 422。 | `src/domain/enums.ts:54-57`；`src/domain/time.ts:75-82`；`docs/MVP__v2.0.md:4650` |
| B-07 | §3 / §35.1 | 逻辑错误 | 严重 | `LEVEL_FIRST_EVAL_AS_OF = null`（开发占位）时，`replayLevel` **不构造评估事件、原样返回 initialState**。rebuild 把当前缓存当 initialState，无评估用户的错误等级无法被账本纠错。同时 `RANKING_FIRST_PERIOD_KEY="2026-W31"` 已占位，榜与等级首评不同步。规范要求上线后首个周一只追加登记。 | `src/domain/config.ts:13,68`；`src/domain/levels.ts:421-430`；`src/application/stats-rebuild-service.ts:145-147,182-197`；`docs/MVP__v2.0.md:382` |
| B-08 | §21.21 | 不一致 | 优化 | 生成/校验按长度 8 + 字母表；schema 只标 `string unique`，无 min/max=8。 | `src/application/groups.ts:179-193`；`src/schema/collections.ts:583`；`docs/MVP__v2.0.md:3024` |
| B-09 | §19.2 / §19.5 / §40 | 逻辑错误 | 重要 | 周榜重建与结算 `rebuildGlobalRanks` 都对**全表**排序后 `rankForPosition(valid, index+1)`。`valid<1` 得 `null` 但仍占下标；比较器 `valid ASC` 把 0 场排在同分入榜者之前，入榜者会得到 2,3,… 空号。门槛已是 1 后，残留主要是 stale 清零行 + 注销行。当前周查询会滤 `global_rank!=null` 后按 `index+1` 展示（掩盖）；**历史全站周榜** `keepHistoricalRank` 使用存库名次，空号会暴露。 | `src/application/ranking-rebuild.ts:255-261`；`src/application/settlement-item-application-service.ts:284-300`；`src/application/ranking-query.ts:528,716-721`；`docs/MVP__v2.0.md:5218` |
| B-10 | §20 / §24.2 / §29.1 | 逻辑错误 | 重要 | `getShareCard` 无 `serverNow`；handler 有 `input.server_now` 但不下传。`season_level` 用 `levelSeasonOf(new Date())` 墙钟读缓存，跨赛季边界可与 `/profile/me`、`/levels/me` 分叉。`season_id` 必须等于该联赛当前登记值——现行 §29.1 已收口，不再列为缺陷。 | `src/application/share-card.ts:111,166-168`；`src/api/v1/share-card.ts:50-51`；`docs/MVP__v2.0.md:4110-4136` |
| B-11 | §25.3 | 逻辑错误 | 重要 | 详情 `mapMyPrediction` 原样回传 `match_score/wdl_hit/exact_hit`，不按当前结算态清空。注销用户（`Deleted`）不查预测，`my_prediction=null`（未登录才应是 null）。 | `src/application/match-query.ts:283-300,447-457` |
| B-13 | §15.9 | 逻辑错误 | 严重 | finalize 用 `{...finalMatch, settled_result_version, settled_at}` 整对象写回。同事务再 `findById` 看不到并发新 `result_version`；CloudBase `matches.update` 是整文档替换。版本回退校验会让**整场事务失败**，从而把已 applied item 一并回滚（叠加 B-24）。retry/correction 同样写法。 | `src/application/first-settlement-service.ts:407-427`；`src/application/retry-settlement-service.ts:339-363`；`src/application/correction-settlement-service.ts:397-419` |
| B-14 | §15.1 / §30.4 | 逻辑错误 | 严重 | 拿到 settlement 锁之后，若文档仍是 `running`，first/retry/correction 仍返回 `already_running`，不续跑。admin retry 对任意 `running` 文档 409。租约过期后新 owner 无法接管卡死场次。 | `src/application/first-settlement-service.ts:280-281`；`src/application/retry-settlement-service.ts:126-131,173-178`；`src/application/correction-settlement-service.ts:261-266`；`src/application/admin-retry-settlement.ts:138-146` |
| B-15 | §17.9 | 逻辑错误 | 重要 | `weeklyEvaluationIsIncomplete`：过了 10 分钟宽限且锁未持有即视为周评估已完成，**不看** `last_eval_as_of` 是否等于本周 `as_of`。周评估失败/跳过后，correction 可能按「本周已评估」继续。 | `src/application/level-correction-reeval.ts:66-82` |
| B-16 | §32.3 | 逻辑错误 | 严重 | 生产 `ProviderNearMatchService` 走 `loadActiveWindowFixtures` → `activeWindow`：只在开球前 120 分钟、30 分钟各 **1 分钟检查点** 且状态为 `scheduled`。不是规范的「T-24h～T-2h 每 30 分钟」。`createNearMatchLoader` 仍按规范窗口写，但生产入口不用它。 | `src/application/provider-active-window.ts:16-22`；`src/application/provider-near-match.ts:48-50`；`src/application/provider-window-loader.ts:31`；`docs/MVP__v2.0.md:4621-4624` |
| B-17 | §32.4 | 逻辑错误 | 严重 | 生产 live 窗口：`scheduled\|live` 且 `kickoff ∈ [now-3h, now+10min]`。开赛超过 3h 仍 live 的场次不再拉；T-2h～T-10min 不进 live job；未「直到 finished」。`createLiveMatchLoader` 已去掉下界，但生产不调用。HTTP 窗口另写死 `now±24h`。 | `src/application/provider-active-window.ts:24-26`；`src/application/provider-live-match.ts:50-52`；`src/application/provider-window-loader.ts:44-45`；`docs/MVP__v2.0.md:4626-4631` |
| B-18 | §11.2 / §11.3 | 规范待澄清 | 重要 | 状态机实现额外允许 `settling→voided`、`failed→voided`（注释引 11.3/49.15）。§11.2 合法转移表没有这两条；§11.3 只写「尚未 settled → voided」。`VOIDABLE_ON_CANCEL` 含 `Failed`，**不看** `settled_result_version`：correction 失败后 `failed && settled_result_version>0` 仍可被 cancelled 标 voided，与「已结算禁止自动作废历史积分」冲突。正文无「49.15」。 | `src/domain/settlement-state-machine.ts:15-44,66-72`；`docs/MVP__v2.0.md:1212-1244` |
| B-19 | §31.10 | 不一致 | 重要 | 规范要求缺映射记 `DIAG_PROVIDER_MATCH_UNLINKED`。领域枚举无此码；另有 `DIAG_PROVIDER_RESULT_CONFLICT` / `DIAG_PROVIDER_RESULT_PENDING`，OpenAPI `Anomaly.type` 两者都不列。 | `docs/MVP__v2.0.md:4592`；`src/domain/enums.ts:181-194`；`src/api/v1/openapi.yaml:2269` |
| B-20 | §30.4 | 逻辑错误 | 重要 | `RetrySettlementService.retry()` 对 `is_correction` 直接 `not_retryable`。管理端入口会改走 `correctionService`，但 retry 服务本身不能恢复失败的 correction settlement。 | `src/application/retry-settlement-service.ts:116-121,163-168`；`src/application/admin-retry-settlement.ts:190-192` |
| B-21 | §17.7 / §17.9 | 逻辑错误 | 重要 | 每次周评估先 `runPendingBefore(本周一)`，捞出全部 `settled_at < 本周一` 的 correction 再跑。上周已处理改判的 `week_base_as_of` 仍是上周一 → `useStoredBase=true`，关掉 `last_eval_as_of > as_of` 的 stale 短路。同一周多次修正会被旧截面再 `evaluate_level`，并可能再插 `correction_reeval`。 | `src/application/weekly-level-eval.ts:265`；`src/application/level-correction-reeval.ts:97-108,319-344` |
| B-22 | §13.2 / §14.7 / §15.9 | 逻辑错误 | 严重 | `PostFinishSettlementService.start()` / `SettlementOrchestrationService.startFirst` **全库仅测试引用**。生产 Timer 只跑 Provider dispatcher（`PostFinishVerify` 只同步 fixture）。`ProviderResultSyncService` 注释写明「不启动结算」，完赛只把 `pending→waiting`。管理员 §30.3 把已结算场次标 `correcting` 后，既无自动 correction worker，admin retry 又对 `correcting` 409。**完赛场次会停在 waiting，积分永不入账。** | `src/application/post-finish-settlement-service.ts:16-30`；`src/application/provider-post-finish.ts:75-92`；`src/application/provider-result-sync.ts:176-189`；`src/cloud-function/runtime.ts:191-203`；`src/application/admin-retry-settlement.ts:131-136`；`src/application/admin-result-correction.ts:186-206` |
| B-23 | §15.5 | 逻辑错误 | 严重 | 应用层 item 包在 `tx.savepoint` 里；失败 catch 后在**外层事务**写 `item=failed` 并提交。内存仓储用 undo 分段回滚。生产 `CloudBaseAppRepository.savepoint` 再调 `db.transaction`；`CloudBaseWxDb.transaction` 已在事务内时 `return work(this)`，**零隔离**。item 部分写入（prediction/career/season/week/unlock）与随后的 `item=failed` 同事务提交。重试再应用同一 delta → 重复记账。 | `src/application/first-settlement-service.ts:316-347`；`src/infrastructure/cloudbase-app-repository.ts:452-453`；`src/infrastructure/cloudbase-wx-db.ts:185-186` |
| B-24 | §15.4 / §15.8 | 逻辑错误 | 严重 | 全部 item（含 savepoint 成功项）与 `rebuildSettlementWeekRanks` 在**同一个** `withTransaction`。榜锁冲突/重算异常会把本场已成功 item 连同聚合一起撤销，随后重试再记账。§15.4 要求已 applied 不得回滚。 | `src/application/first-settlement-service.ts:309-387`；`src/application/retry-settlement-service.ts:242-323`；`src/application/correction-settlement-service.ts:298-380` |
| B-25 | §15.9 / §14.7 | 逻辑错误 | 重要 | settlement 文档已 `settled` 时 first/correction 直接 `already_settled`，不补写 match 的 `settled_result_version`/`settled_at`，也不启动后续 correction。settlement 完成而 match 仍 waiting（或版本未追上）时，幂等路径把脏态当终点。 | `src/application/first-settlement-service.ts:273-279`；`src/application/correction-settlement-service.ts:255-260`；`src/application/settlement-orchestration-service.ts:30-36,118-131` |
| B-26 | §13.3 | 逻辑错误 | 重要 | 首次结算检查 open blocking anomaly。重试（`retry-settlement-service.ts:188-237`）与修正（`correction-settlement-service.ts:230-235`）以及 admin retry **都不查** anomaly。blocking 未关闭时仍可改积分。 | `src/application/first-settlement-service.ts:226-235`；`src/application/retry-settlement-service.ts:188-237`；`src/application/correction-settlement-service.ts:138-198,230-235` |

---

## ② API 合同一致性

OpenAPI `paths:` 共 **23 条路径 / 26 个操作**（`servers.url` 已含 `/v1`）。全部 **无 `operationId`**。网关 `handleGatewayRequest` 覆盖这 26 个操作，并多出一个未入合同的别名。

| ID | 操作/字段 | 类型 | 严重度 | 合同 | 实现 | 判定 |
|---|---|---|---|---|---|---|
| A-01 | 路径计数 | 不一致 | 重要 | README「22 条路径 / 25 个操作」，比赛段未列 crowd，排行榜文案未写 season | OpenAPI `/matches/{match_id}/crowd`；assemble 已挂 GET crowd | README 与合同/实现差 1 条路径（crowd）。排行榜实现含 season。 |
| A-02 | `POST /v1/profile/me` | 不一致 | 重要 | OpenAPI `/profile/me` 仅 get/patch/delete | `(PATCH \|\| POST) && path === "/v1/profile/me"` 走同一套 patch | 实现超合同（微信别名未登记） |
| A-03 | `GET /rankings` → `RankingData.me` | 不一致 | 重要 | `required` 含 `me`；`RankingMe` 四态 oneOf，非 nullable | 查询结果 `me` 为 optional；序列化 `me === undefined` 时省略 | 登录成功路径通常有 me（deleted 在网关 409）；合同不允许缺字段 |
| A-04 | `Anomaly.type` | 不一致 | 重要 | OpenAPI enum 无 `DIAG_*` | `AnomalyType` 含 `DIAG_PROVIDER_RESULT_CONFLICT`、`DIAG_PROVIDER_RESULT_PENDING` | 管理端异常合同无法表达实现码 |
| A-05 | `GET /predictions/me` query | 不一致 | 重要 | OpenAPI：`season_id`「仅可与 league_id 同时提供」 | 仅当 **无 cursor** 时拒绝「有 season_id 无 league_id」 | 带 cursor 可绕过联赛约束 |
| A-06 | 未知 query → 422（§23.4） | 不一致 | 优化 | 未定义 query 参数应 422 | 列表/榜单/crowd/unlocks/groups/me 有白名单；`GET /levels/me`、比赛详情、`profile/me` 不收 query、不拒绝多余参数 | 部分接口静默忽略 |
| A-07 | `GET /rankings` 响应码 | 不一致 | 优化 | 每个 status 一次 | `'404'` 写了两次（527-528 与 537-538） | 合同文件瑕疵，不影响运行 |
| A-08 | `RankingData` 按 board 收口 | 不一致 | 优化 | §27.1：`period_key` 仅 week；season 才有 `level_season_id` 等 | 实现按 board 校验/裁剪；OpenAPI 扁平 schema，`period_key` 任意 board 可 null | 实现严、合同松 |
| A-09 | 成功/分页/错误 envelope | 一致 | — | `data+request_id`；`items+page.next_cursor+page.has_more`；`code+message+request_id+details` | handler / `mapErrorToHttp` 对齐；`UNAUTHORIZED→401` | 主路径一致 |
| A-10 | `MatchDetailData` | 一致 | — | 详情含 `my_prediction` | 独立 schema，不再 `allOf MatchListItem` | 旧严重-11 已不在 |
| A-11 | `GET /groups/me` 分页 | 一致 | — | §27.2 分页；OpenAPI description 已改为 keyset | `listMyGroups` limit 1..100 + HMAC cursor | 旧严重-12 已不在 |
| A-12 | crowd | OpenAPI/实现一致；README 缺 | — | §25.4 有 crowd | OpenAPI `:141`；assemble `:275-289`；`src/api/v1/crowd.ts` | 见 A-01 |

证据：`README.md:56-65`；`src/api/v1/openapi.yaml:35-170,202-224,307-356,525-538,622-627,1057-1108,1356-1410,2269`；`src/gateway/assemble.ts:248-376,420-428,449-460`；`src/api/v1/predictions.ts:208-210`；`src/api/v1/rankings.ts:166`；`src/api/v1/levels.ts:8-12,30-47`；`src/api/v1/validation.ts:47-50`。

---

## ③ 旧问题复核

R2 原文只作线索。下表以当前 HEAD 为准。

### 严重（R2 16 条）

| R2 ID | 原题 | 判定 | 当前证据 |
|---|---|---|---|
| 严重-1 | `board_snapshots` head 哨兵 | **仍存在**（查询已过滤，属 SPEC_GAP） | `types.ts:289,298`；`collections.ts:561`；`ranking-query.ts:572` |
| 严重-2 | item 事务不含 level | **已变化**（规范已澄清，不修代码） | `docs/MVP__v2.0.md:1549` 已注明普通 item 不写等级 |
| 严重-3 | replay 初态用脏缓存 | **仍存在**（Q1=null 后成主路径） | `levels.ts:421-430`；`stats-rebuild-service.ts:145-147,182-197`；`config.ts:68` |
| 严重-4 | 对账用当前账本 `evaluateLevel` 当 expected | **已变化** | `daily-consistency-snapshot.ts:381-396` 要求 `firstEvalAsOf !== null` 才覆盖 level；现配置为 null，该误报路径不执行。`best_level` 已改为 `Math.max(level, historyMax)`（`:406`）。登记 Q1 后原路径会复活 |
| 严重-5 | 解散不终止成员、名额被占 | **已修复 / 已变化** | `groups.ts:420-436` 全体 active→left、`member_count=0`；`listMyGroups` 跳过 dissolved（`:464-466`）；拥有上限只计 Active（`:287-290`）。新冲突见 B-03 |
| 严重-6 | UNAUTHORIZED 变成 409 | **已修复**（按 code 映射） | `validation.ts:47-50` `UNAUTHORIZED: 401` |
| 严重-7 | live loader 丢掉已开赛 | **已变化** | loader 已去掉 `kickoff>=now`（`provider-fixture-loader.ts:207-214`）；**生产**改走 `activeWindow`，窗口合同仍错（B-17） |
| 严重-8 | abandoned 同态误冲突 | **已修复** | `provider-status-sync.ts:965-971` 仅 `!sameStatus` 才校验结算门闩 |
| 严重-9 | `match_results` 插入非原子 | **已修复** | `repositories.ts:1370-1389` `has` 与 `set` 之间无 `await` |
| 严重-10 | rebuild 账本用 finished 硬门 | **已修复** | `rebuild-service-support.ts:82-91` 改为 `activeSettlement` → 409 |
| 严重-11 | MatchDetailData allOf | **已修复** | `openapi.yaml:1057-1108` 独立 schema |
| 严重-12 | groups/me 假分页 | **已修复** | `groups.ts:441-492`；OpenAPI `:627` |
| 严重-13 | item 失败 catch 后提交 | **已变化 / 生产仍存在** | 应用三服务已包 `tx.savepoint`（`first-settlement-service.ts:319-335`）。内存 savepoint 落地。CloudBase savepoint 为嵌套事务空操作（B-23），生产路径仍是「部分写入 + item=failed 一并提交」 |
| 严重-14 | finalize 整对象写回 | **仍存在** | `first-settlement-service.ts:409-414`；retry/correction 同样 |
| 严重-15 | 单条非法整包 ProviderDataError | **已变化** | fixtures 原样返回（`http.ts:185-210`）；`getTeams`/`getFixtureRounds` 仍 `every` 整包抛错（`:217-230`） |
| 严重-16 | retry 后续 correction 覆盖 outcome | **已变化** | **已修复（管理入口）**：`admin-retry-settlement.ts:201-219`。**仍存在（编排入口）**：`settlement-orchestration-service.ts:118-156` 的 `startFirst`/`retry` 仍用后续 correction 失败改写本次结果 |

### 重要（已在本轮重新取证的子集）

| R2 ID | 判定 | 证据 |
|---|---|---|
| b01F1 history \|Δ\|≤1 | **仍存在** | `invariants.ts:144-147` |
| b03F2 invite_code 长度 | **仍存在** | `collections.ts:583` |
| b04F1 周榜 0 场占位 | **仍存在** | `ranking-rebuild.ts:255-261` |
| b05F1 周评估未完成判定 | **仍存在** | `level-correction-reeval.ts:66-82` |
| b06F2 correct() 不续跑 | **已修复** | `settlement-orchestration-service.ts:168-178` |
| b08F2 expected best_level | **已修复** | `daily-consistency-snapshot.ts:406` |
| b09F1 period_key 被 cursor 继承 | **已变化 / 符合 §23.8** | `ranking-query.ts:466-471,476-481`：省略 `period_key` 时继承 cursor 绑定周；显式冲突 422。walkback 仅无 `period_key` 且无 cursor。§23.8 要求 cursor 绑定已解析筛选，分页窗口不随 `server_now` 变 |
| b09F2 实力榜 not_participated | **已变化** | `n<50` 先 `below_threshold`（`ranking-query.ts:737-743`）。`n≥50` 但不在快照仍 `not_participated`（`:744-745`）属快照滞后；§19.7 要求实力榜名次来自快照，不单列缺陷 |
| b10F2 groups/me 分页 | **已修复** | 同严重-12 |
| b11F1 详情结算字段 | **仍存在** | `match-query.ts:283-300` |
| b11F2 注销抹掉 my_prediction | **仍存在** | `match-query.ts:447-450` |
| b12F1 share-card season_id | **已变化**（规范已收口，实现与 §29.1 一致） | `share-card.ts:58-59`；`docs/MVP__v2.0.md:4110-4116` |
| b12F2 season_level 墙钟 | **仍存在** | `share-card.ts:111,166-168`；`src/api/v1/share-card.ts:50-51` |
| b05F2 周评估重放上周全部修正 | **仍存在** | `weekly-level-eval.ts:265`；`level-correction-reeval.ts:97-108,319-344` |
| b13F2 / b15F1 未知 query | **仍存在** | `levels.ts` 无 query；assemble `:420-428` |
| b14F2 cursor+season_id 无 league | **仍存在** | `predictions.ts:208-210` |
| b21F1 小程序过期包混榜 | **仍存在** | `rankings.js:281-332` 无请求序号 |
| b22F3 retry 拒绝 correction | **已变化** | **已修复（§30.4 管理入口）**：`admin-retry-settlement.ts:156-191`。**仍存在（通用 retry 服务）**：`retry-settlement-service.ts:116-122` |
| b22F4 持锁仍 already_running | **仍存在** | `first-settlement-service.ts:280-281`；correction `:261-266`；admin retry `:138-146` |
| b17F2 LIVE_TOO_LONG | **已变化** | live job 结束后 `patrolLiveMatches`（`provider-live-match.ts:61-62`）。谓词本体本轮未逐行重读 `anomaly-evaluation.ts`，接线存在 |
| b20F4 StrengthRankingItem 缺 week 字段 | **已变化 / 现合同一致** | 现行 OpenAPI 实力榜只要 `strength_index`/`window_n`（`openapi.yaml:1295-1321`），与 §27.1 一致 |
| b20F5 me 非 nullable | **仍存在（合同侧）** | OpenAPI 必填；实现可省略（A-03） |
| b15F2 rankings 写死 LOCAL_PUBLIC_SOURCE | **已变化** | 排行榜 Auth required，不再传 `public_source`（assemble `:449-460`） |

### 本轮未重读、标为无法核实

`b07F2` 历史赛季冻结回放、`b18F2` job_locks undo、`b18F3` `created_at` 可改、`b18F4` TeamRepository 无 update、`b19F2` 回放输入序。不以旧结论当现状。

---

## ④ 交付记录核实

对照 `docs/MVP2.0__COMPLIANCE_FIX_DELIVERY__v1.0.md`（2026-10-09）。微信开发者工具未实测：环境声明 **属实**。

| Review ID | 交付主张 | 核实 | 证据 |
|---|---|---|---|
| Z09 | `available_level_seasons` 排除空榜/仅 head/当前榜仅注销用户；历史终榜保留已注销 | **属实** | `ranking-query.ts:572,763-773`：跳过 head；终榜赛季需非 head 快照 |
| Z09 / Z14 | 当前赛季由 `server_now` 推出，不用选择器第一项；历史赛季不显示群入口 | **属实** | `rankings-view-model.js:69-75,130`；`rankings.js:389-390` |
| B02 | 统一 `isSeasonRankEligible` | **属实** | `ranking-query.ts:697` |
| Z12 | 终榜不随之后统计修正/当前赛季重建改变 | **属实** | 常规重建 `writeBoardSnapshotInTransaction` 排除 `is_final`；`generateSeasonFinal` 已有终榜则直接返回。回归 `rebuild-service.test.ts:840-854`（改上赛季统计 + 重建当前赛季，终榜逐字段不变）。查询走 `findFinalBySeason`（`ranking-query.ts:561,584-586`） |
| M07 | 群文案全部读 `rankings-copy.js` | **部分** | 群列表/加入/详情与 `profile.js:158` 成员数走 copy。`profile.wxml:28-29` 群区标题/按钮仍硬编码「＋ 邀请码加入」「创建预言群」，未绑定已有的 `joinGroupText`/`createGroupText`（copy 为「输入邀请码加入」「创建我的预言群」） |
| B-README-tab | 10 页面 + 3 tabBar；四榜；比赛页走网关 | **部分** | `miniprogram/app.json:2-36` 10 pages / 3 tabs **属实**；README API 一览仍写 22/25 且漏 crowd、漏 season（`README.md:56-65`） |
| A2 / R10 | 种子 `new-season` + `new-season-final` | **属实** | `src/gateway/seed.ts:36,308,326` |
| R02 | 空群周榜「群里本周还没有人入榜」 | **属实** | `rankings-copy.js:9`；`rankings-view-model.js:123-142` |
| R13-hint | 周榜脚注「仅显示最近 4 周」 | **不属实** | 文案在 `rankings-copy.js:86` 且写入 page data（`rankings.js:92`），**`rankings.wxml` 未绑定该字段**。脚注实际是「已展示全部公开名次 · 最多前 20 名」（`rankings.wxml:21`）。用户看不到「仅显示最近 4 周」 |
| R17 | 实力榜已入榜「第 N 名 · 共 M 人」 | **不属实** | `rankings.js:362`：`standingLabel` 为「第 N 名」或「前 P%」；`entryCount` 在另一格（`rankings.wxml:14`）。没有「第 N 名 · 共 M 人」拼接 |
| Luna-M02 | 上赛季回顾含 `valid_predictions` | **属实** | `profile.js:152-154` `COPY.recapDetails(..., valid_predictions)` |
| Luna-M03 | 无群保留加入+创建；创建走 `POST /v1/groups` | **属实** | `profile.wxml:29`；`profile.js:242-254` |
| Luna-P03 | 翻尽后「没有更早的预测了」 | **属实** | `my-predictions.js:93`；`my-predictions.wxml:59` |
| Luna-P04 | 空状态「去预测」 | **属实** | `my-predictions.js:92`；`my-predictions.wxml:16` |
| X10 | n&lt;50 不返回 strength 标签 | **属实**（产品决定，与规范一致） | `ranking-query.ts:121-123` `STRENGTH_BOARD_MIN_WINDOW_N` |
| R18 | 保留相对更新时间 | **属实**（产品决定） | `rankings-view-model.js:51-60,145` |
| R03 / R04 | 无领奖台/少人分档已实现 | **属实** | `rankings-view-model.js:126-133` `showPodium: count >= 3` |
| CB-B03 / CB-B05 | CloudBase 聚合仍标未实现、本轮延期 | **部分** | 延期/未接真实环境与 README 边界一致。当前 `CloudBaseWxDb.reserveCounter/adjustCounter` **已有实现**（`cloudbase-wx-db.ts:152-178`）；本轮 **未找到** 交付所说的「明确未实现」字样 |
| 详情 crowd「前端另开切片」 | S14 后端完成、前端未接入 | **不属实** | `match-detail.js:220-258` 已调用 `getMatchCrowd`；`match-detail.wxml` 有 crowd 区块。交付文案过期 |
| 微信未实测 | 全部场景 × | **属实** | 本环境同样未跑微信开发者工具 |

---

## ⑤ 小程序前端业务逻辑

| ID | 页面/点 | 类型 | 严重度 | 问题 | 证据 |
|---|---|---|---|---|---|
| F-01 | 排行榜过期响应 | 逻辑错误 | 严重 | `applyListResult` 无请求序号；用**当下** `this.data.board` 解释回包。`onBoardTap` 切榜后立刻 `loadFirstPage`，先发出的周榜包可能按生涯/实力字段展示（`period_score` 当 `career_points`）。 | `miniprogram/pages/rankings/rankings.js:182-195,281-332`（对比比赛页 `matches.js:141` 有 `requestSerial`） |
| F-02 | 比赛列表误用详情字段 | 逻辑错误 | 重要 | `GET /v1/matches` 列表项**没有** `my_prediction`。`decorateItem` 仍读 `item.my_prediction`。本地 `submittedMap` 为空（冷启动）时，已提交场次 `predText` 会落到「未开赛」，与 `ALREADY_SUBMITTED` 芯片并存。 | `matches.js:155-175`；`match-query.ts:317-332`；`openapi.yaml:959-1006` |
| F-03 | 周榜 4 周脚注 | 未实现 | 重要 | copy 与 data 有 `weekWindowHint`，wxml 未渲染。用户看不到「仅显示最近 4 周」。 | `rankings-copy.js:86`；`rankings.js:92`；`rankings.wxml` 全文无 `weekWindowHint`（`:21` 脚注是「最多前 20 名」） |
| F-04 | 实力榜「我的排行」文案 | 不一致 | 优化 | 交付要求「第 N 名 · 共 M 人」；实现拆成排名格 + 入榜人数格。信息在，格式不是交付句式。 | `rankings.js:362-367`；`rankings.wxml:14` |
| F-05 | 个人页升级进度 | 逻辑错误 | 重要 | 圆环用 `profile.career_points` 对比 `{2:80,3:170,4:380,5:630}`。该阈值来自 **B 分** `LEVEL_B_POINTS`（下一等级），不是生涯积分。帮助文案称「累计积分门槛」，会把 s 积分进度显示成 B 分进度。 | `profile.js:117-120,203`；`src/domain/config.ts:64` |
| F-15 | 个人页/设置页比赛分页 | 逻辑错误 | 重要 | OpenAPI `MatchesData` 的 cursor 在 `data.page.next_cursor`。`profile.js` 解析主队、`settings.js` 拉球队列表都读 `payload.next_cursor`，永远拿不到下一页，翻页停在第一页。比赛首页用法正确（`matches.js:151-152`）。 | `profile.js:177-189`；`settings.js:34-46`；`openapi.yaml:1007-1017`；`src/api/v1/matches.ts:33-38` |
| F-16 | 个人页最近预测 null | 逻辑错误 | 重要 | `resultClass` 把 `exact_hit`/`wdl_hit` 的 null 当成 miss（class=`miss`）。`resultText` 才判断 `match_score == null`。待结算行会先套「未命中」样式。比分数字本身未用 0 代替。`my-predictions` 走 `match_score === null ? 'pending'`，口径不一致。 | `profile.js:226-229` |
| F-17 | 排行榜 `me` 合同外字段 | 逻辑错误 | 优化 | `RankingMe` ranked 只有 `status/rank/top_percent`（`additionalProperties: false`）。前端从 `payload.me` 读 `strength_index`/`career_points`/`season_points`/`period_score`；后端 `me` 也不写这些字段。未入榜非实力榜回落 `"0"`，不是 null/「—」。入榜时靠列表项 `ownItem.mainValue` 兜底，所以多数入榜路径仍对。 | `rankings.js:364-366`；`openapi.yaml:1411-1425`；`ranking-query.ts:733-748` |
| F-18 | 「我的」群区文案 | 不一致 | 优化 | `profile.js` 已准备 `joinGroupText`/`createGroupText`，wxml 未绑定，按钮写死「＋ 邀请码加入」「创建预言群」。 | `profile.js:81-82`；`profile.wxml:28-29`；`rankings-copy.js:34-35` |
| F-06 | crowd 已接入 | 与交付相反，当前正确 | — | 详情按后端 `can_predict` 决定提交；crowd 按计划 hidden/guest/locked/loading 拉 `GET .../crowd`；401 走游客。 | `match-detail.js:179-181,223-258,342-360` |
| F-07 | 身份边界 | 符合 | — | 客户端禁止在请求里带 `openid`/`user_id`/`token`。 | `miniprogram/services/api.js:34-46` |
| F-08 | `can_predict` 驱动 | 符合 | — | 列表 `showPredict = can_predict===true && reason===null`；详情 `canSubmit` 同口径，不在前端重算截止时间。 | `matches.js:167`；`match-detail.js:181` |
| F-09 | null 语义 | 符合（「我的预测」页）；个人页见 F-16 | — | `my-predictions` 的 `formatScore` 对 null 显示「待结算」，不用 0。 | `my-predictions.js:29-32,40-45` |
| F-10 | 四榜 / `available_boards` / me 四态 | 符合（有 F-01 竞态） | — | tab 按 `available_boards` 显隐；guest 401、注销 409；me：ranked / not_participated / below_threshold / not_eligible。 | `rankings.js:124-135,307-358` |
| F-11 | UI 状态 vs 业务状态 | 符合（产品分层） | — | 列表 UI：`collapsed\|editing\|submitting\|submitted_locked`；业务态来自 `match_status` + `can_predict_reason`。未在前端再实现截止状态机。 | `matches.js:61-69,163` |
| F-12 | 日期条 11 天 | 符合（产品决策） | — | `DATE_SPAN_DAYS=11`（今天起 n+10）。窄于 API 默认 `to=now+30d`，是前端开放范围，不是算错截止。 | `matches.js:37-40` |
| F-13 | 分页 cursor | 排行/预测符合；个人页/设置见 F-15 | — | 排行榜、我的预测只回传 `page.next_cursor`，不解析 HMAC。 | `rankings.js:407`；`my-predictions.js:113` |
| F-14 | 401 / 409 提交分支 | 符合 | — | 详情提交区分 `UNAUTHORIZED` 与 `USER_DELETED`。 | `match-detail.js:342-360` |

---

## 汇总

### 计数（本报告列出的问题条，不含「符合/已修复」）

| 章节 | 严重 | 重要 | 优化 | 规范待澄清（计入左列严重度） |
|---|---:|---:|---:|---:|
| ① 业务规范缺陷 | 10 | 13 | 2 | 5（B-01/03/04/05/18） |
| ② API 合同 | 0 | 5 | 3 | 0 |
| ③ 旧问题仍存在/已变化残留 | 见上表，不重复加总 |  |  |  |
| ⑤ 小程序缺陷 | 1 | 5 | 3 | 0 |

③ 中「仍存在」的严重项：严重-1、3、13（生产）、14（及 7/15/16 已变化但残留）。与 ① 的 B-04/B-07/B-13/B-16/B-17/B-22/B-23 是同一批事实，不要按两章加总。

### 最严重的 10 条（跨章去重）

1. **完赛后没有生产入口启动结算**（B-22）— `PostFinishSettlementService` 仅测试引用；Timer 只同步 fixture。场次停在 `waiting`，积分永不入账。管理员标 `correcting` 后也无 worker。
2. **CloudBase savepoint 零隔离，item 失败仍提交部分写入**（B-23 / 严重-13 生产）— 重试同一 delta 重复记账。
3. **已 applied item 与周榜重算同事务，失败整场回滚**（B-24）— 违反 §15.4。
4. **生产 live 窗口不是「T-2h～finished」**（B-17）— 开赛>3h 或未进 10min 窗口的 live 场次不再同步。
5. **生产 near_match 不是「T-24h～T-2h 每 30 分钟」**（B-16）。
6. **`LEVEL_FIRST_EVAL_AS_OF=null` 使 rebuild 不纠等级**（B-07 / 严重-3）。
7. **持锁后 running 仍 already_running**（B-14 / b22F4）— 崩溃后的结算无法接管，场次永久卡死。
8. **finalize 整对象写回 match**（B-13 / 严重-14）— 可覆盖并发状态/比分，版本冲突会连同已 applied 回滚。
9. **联赛主 Provider 规范自相矛盾**（B-01）— 上线采信源未冻结。
10. **排行榜无请求序号，切榜会混字段**（F-01 / b21F1）。

### 需要你拍板的规范歧义

1. **联赛主源**：跟 §1.4 表（西甲等 `api_football`）、§31.10（五大联赛 `fd`）、还是 `config.ts` 现状？§5.2「只实现 api_football」是否作废？
2. **群主解散**：允许 `group_members.status=left`（当前实现，名额可回收），还是 §40 禁止 left、只改 `groups.status`？
3. **`board_snapshots.head`**：写入规范，还是删哨兵改用 `(board, snapshot_at DESC)`？
4. **同周 correction 跨 2 级**：放宽 history `\|Δ\|≤1`，还是限制 correction 不得越过 `week_base±1` 的单步？
5. **`LEVEL_FIRST_EVAL_AS_OF` / `RANKING_FIRST_PERIOD_KEY`**：上线周是否仍为 `2026-W31`？Q1=null 时 rebuild「保持缓存」是否为有意行为？
6. **§11.2 vs 代码 extra voided 边**：把 `settling/failed→voided` 写进 11.2，还是改状态机删边、只从 pending/waiting void？
7. **README「8 月切换」**：改为 07-01，还是等级赛季其实要 8 月（与代码/§3 相反）？

---

*本报告由 Claude Code（provider `sub2api-grok-latest`，模型 `grok-latest`）于 2026-10-12 只读生成；生成期间未修改 `/home/football` 任何文件。归档路径：`docs/MVP2.0__REVIEW_R3__v1.0.md`。*
