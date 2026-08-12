# 赛事预言家（football）

英超 2026_2027 赛事比分预测 MVP。

业务唯一规范：`MVP__v1.0.md`（项目根目录）。

## 当前阶段

阶段 1（项目骨架与纯领域层）、阶段 2（基础设施与预测）与阶段 3（Provider 同步）已完成：

- 阶段 1：TypeScript strict + Vitest + ESM；schema_version=1 固定配置、枚举与领域类型；时间/周期、比分推导、计分、等级、排名比较、状态机、预测策略；OpenAPI 初始骨架与 Schema/索引定义。
- 阶段 2：repository ports、事务/锁抽象与内存测试适配器（共享 store + undo log 失败回滚，回滚按写入逆序执行）；session、用户读取；prediction 创建、服务端校验、两层幂等；API validators/error mapper。
- 本轮补齐预测提交权限边界：幂等重放前校验 active 用户，已注销用户不能通过历史 `idempotency_key` 重放预测。
- 阶段 3：API-Football adapter/client 契约（只读白名单，禁止 odds/bookmaker/bet）；fixture mapper 与状态/比分校验（fail-closed）、kickoff 容差、fixture 工厂；同步任务配置（未来 30 天、T-24h~T-2h、T-2h~finished、post-finish、period_finalize 等），重试退避 1/2/5/10/30 分钟 + ±20% jitter、quota 超限停止高频重试、`sync:{job_type}` 锁；anomaly 检测/分类决策（LIVE_SYNC_STALE、LIVE_TOO_LONG、FINISHED_NO_SCORE，含 33.6 确定性 resolve）。
- 本轮补齐 Provider 合法 `ABD` 状态落库：遵循 `scheduled/postponed/live -> abandoned` 状态机，保持 `settlement_status=pending` 且不写正式比分；重复观察幂等，非法组合保存 blocking conflict snapshot/anomaly。
- 本轮补齐 Provider 主客队变更保护：仅无 prediction 且仍 scheduled 的比赛允许按 Provider team mapping 更新；已有 prediction 或已开赛时保持原事实并记录 `TEAM_CHANGE_AFTER_PREDICTION` blocking anomaly 与冲突 snapshot。
- 本轮补齐 Provider 身份映射仓储：`team_provider_mappings` / `match_provider_mappings` 按 `(provider, provider_*_id)` 唯一约束读取，内存事务适配器支持回滚；完整 Provider 端到端同步仍未实现。
- 本轮补齐 Provider `TBD/NS` scheduled 观察：支持 `scheduled/postponed -> scheduled` 更新未开赛 kickoff、确认标记和 deadline；已关闭比赛保留旧 deadline，period anchor 已冻结后的 kickoff 变化记录 blocking conflict snapshot/anomaly。
- 本轮新增 Provider fixture 批次同步任务：注入 fixture loader，在可续租的 `sync:{job_type}` lease 内复用单 fixture 同步，持久化 `sync_logs` 摘要并对单实体失败 Fail Closed 计数；不连接真实 Provider。
- 本轮补齐 Provider fixture 批次 loader 重试：暂时错误按 32.8 的 1/2/5/10/30 分钟退避与 ±20% jitter 重试，quota/provider data 错误不自动重试，`sync_logs` 保留实际尝试次数；等待与随机数通过依赖注入测试，不连接真实 Provider。
- 本轮补齐 Provider fixture 批次任务的 `server_now` Fail Closed 边界：无效时间在获取 `sync:{job_type}` 锁、写入 `sync_logs` 和调用 loader 前拒绝，不连接真实 Provider。
- 本轮新增 `createFutureScheduleLoader`：为 `future_schedule` 任务按可信 `server_now` 查询固定英超 2026 赛季未来 30 天，并将原始 fixture 保留为批次 payload；Provider client 通过依赖注入提供，不连接真实 Provider。
- 本轮新增 `createFullScheduleVerifyLoader`：为 `full_schedule_verify` 按固定英超 2026 赛季读取完整 fixtures，并将原始 fixture 保留为批次 payload；Provider client 通过依赖注入提供，不连接真实 Provider。
- 本轮新增 `ProviderFutureScheduleService`：串联固定赛季球队同步、Provider mapping、future schedule loader、fixture job、`sync:future_schedule` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮新增 `ProviderFullScheduleVerifyService`：串联固定赛季球队同步、完整赛季 fixture loader、fixture job、`sync:full_schedule_verify` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮新增 `ProviderNearMatchService`：串联固定赛季球队同步、T-24h 到 T-2h fixture loader、fixture job、`sync:near_match` lease 与 `sync_logs`；不连接真实 Provider。
- 阶段 4（最小可验证切片 A）：结算账本 Repository 与内存适配器（`infrastructure/repositories.ts`），新增 `matchResults` / `settlements` / `settlementItems` ports 并接入 `InMemoryRepository` 与 `UnitOfWork`（undo log 失败回滚沿用现有事务机制）：
  - `match_results` 不可变 append-only：`UNIQUE(match_id, result_version)`，重复版本抛 `uk_match_result_version` 唯一冲突；result_version 只允许严格递增，旧版本写入抛 `StaleResultVersionError`（不可覆盖账本）。
  - `settlements`：`UNIQUE(match_id, result_version, rule_version)`（`uk_match_version_rule`），按 id / 键 / status 查询，insert + update 支持 status/phase 基础读写；update 不存在的文档抛 `DocumentNotFoundError`。
  - `settlement_items`：`UNIQUE(settlement_id, prediction_id)`（`uk_settlement_prediction`），pending/applied/failed 状态，按 status（某 settlement 内或全局）查询，insert + update 支持 item 更新（applied 后读回）。
  - 之前阶段已完成结算应用纯函数（`computeSettlementItemDelta` / `applySettlementItemDelta` / `assertResultVersionOrder`）。
  - 阶段 4 追加纯决策切片 `application/first-settlement.ts`：`decideFirstSettlement` 首次结算 orchestration 状态决策（不接 repository）。规则实测：finished + waiting + 无阻塞异常 + finish 已检测 + result_version>=1 + 比分整数 0..99 + server_now >= finish+10 分钟（恰好 10 分钟含边界）-> `FIRST_SETTLEMENT_START`；settled -> `SETTLEMENT_ALREADY_SETTLED`；settling/running 及其他非 waiting -> `SETTLEMENT_ALREADY_RUNNING`；其余任一未满足 -> `SETTLEMENT_NOT_READY`。14 项测试通过。
  - 阶段 4 追加切片 C：首次结算 orchestration 服务 `application/first-settlement-service.ts`。`FirstSettlementService.start(matchId, serverNow, hasBlockingAnomaly)`：读取 match → `decideFirstSettlement`，仅 kind=start 继续；读取 match_results 最新版本；按 (match_id, result_version, rule_version) 创建或复用 settlement（已 settled 的 settlement 重复调用不新建、返回已完成）；match waiting→settling；处理 settlement_items 中 pending/failed（applied 跳过），经可注入 `itemWorker(item, result)` 成功后 item→applied；全部成功 settlement→settled/done、match→settled（settled_result_version/settled_at），无 items 同样成功；worker 失败时 settlement→failed/apply_items（记录 last_error）、match 回退 waiting、抛出原错误（已 applied 不回滚）。10 项服务测试通过。
  - 阶段 4 追加切片 D：结算重试服务 `application/retry-settlement-service.ts`。`RetrySettlementService.retry(settlementId, serverNow)` 仅允许 `settlement.status=failed` 参与：settled→already_settled（重复 retry 不重复积分/worker）、running→already_running、其余→not_retryable、不存在→SETTLEMENT_NOT_FOUND；按 `settlement:match:{match_id}` 获取 job lock（lease 复用现有 jobLocks、owner 为新 UUID、finally 释放），无法获取→SETTLEMENT_ALREADY_RUNNING；settlement failed→running/apply_items、match→settling；仅处理 pending/failed items，applied 永不调用 worker；item worker 成功立即 item→applied（attempt_count+1），失败立即 item→failed（attempt_count+1、last_error）、settlement→failed/apply_items 并保留已 applied、match 回退 waiting、返回 kind=failed（不伪造事务回滚）；全部成功（含无 items）settlement→settled/done、match→settled。10 项服务测试通过；管理员按 match_id 的 retry 最小 API/application 切片已完成；前端、provider 端到端仍未实现。
  - 阶段 4 追加切片 E：赛果修正版本计划纯切片 `application/result-correction-plan.ts`（不接 repository）。`planResultCorrection` 严格拒绝非 finished（MATCH_NOT_FINISHED）、比分非整数 0..99（INVALID_SCORE）、新比分与当前相同（RESULT_UNCHANGED）、result_version 为负（INVALID_RESULT_VERSION）；成功返回 next_result_version=current+1、is_correction=current>0、needs_correction_settlement=settlement 已 settled、source；provider/admin 仅记录计划、不覆盖旧版本（版本严格递增）。`nextSettlementVersion` 无 result 或已追平返回 null，否则返回 settled+1，禁止跳过中间版本直达最新。17 项纯函数测试通过。
  - 阶段 4 追加切片 F：赛果修正结算 orchestration 服务 `application/correction-settlement-service.ts`。`CorrectionSettlementService.correct(matchId, serverNow, targetResultVersion?)`：读取 match，要求 finished、result_version>=1、settled_result_version>0 且 current>settled；通过 `nextSettlementVersion` 只选择 settled_result_version+1（targetResultVersion 必须等于该下一版本，否则 RESULT_VERSION_SKIPPED，禁止跳到最新）；读取该版本 match_results 与已有唯一 settlement，创建或复用（is_correction=true，绝不重复创建，已 settled 返回 already_settled）；按 `settlement:match:{match_id}` 获取 job lock（finally 释放），冲突返回 SETTLEMENT_ALREADY_RUNNING；match→correcting，处理 pending/failed items、applied 永不调用 worker；worker 失败 item→failed、settlement→failed/apply_items、保留已 applied、match 回退 failed、返回 kind=failed；全部成功（含无 items）settlement→settled/done、match settled_result_version=targetVersion，若还有后续 result_version 保持 correcting 否则 settled。10 项服务测试通过。
- 阶段 5 追加切片 G：统计纯重建函数 `application/stats-rebuild.ts`（不接 repository、不使用任何旧聚合缓存）。`rebuildStatsFromLedger(items, seasonByPrediction)` 从 applied settlement_items 账本重建统计：career_points=sum(score_delta)、career_valid_predictions=sum(valid_prediction_delta)、career_wdl_hits=sum(new_wdl_hit-old_wdl_hit)、career_exact_hits=sum(new_exact_hit-old_exact_hit)，按调用方提供的 prediction->season 映射分组生成 season stats（按 season_id 排序）。账本完整性校验：items 必须同 user 且 status=applied、score_delta=(new_score-old_score)、valid_prediction_delta∈{0,1}、exact_hit 命中必须同时 wdl_hit、每个 prediction 必须有 season 映射、聚合结果满足 points>=0/counts>=0/exact<=wdl<=valid，非法 ledger 抛 INVALID_LEDGER；空 ledger 返回全零。16 项纯函数测试通过。
  - 阶段 5 追加切片 H：等级纯重建函数 `application/level-rebuild.ts`（不接 repository、不自行创建 level_history）。`rebuildLevelState(scope, validPredictions, wdlHits, currentLevel, bestLevel, reason?)` 复用唯一 domain `calculateLevel` 重算 current_level（可升可降）、best_level 只增不减（17.6）、`should_record_history` 仅在等级变化时为 true（17.7）并返回 from/to；等级不变时 from/to 为 null。reason（含 season_start）仅输入/输出透传、不参与记录决策。非法统计（负值/wdl>valid/非整数）与越界 current/best 等级抛明确 VALIDATION_ERROR。10 项纯函数测试通过。
  - 阶段 5 追加切片 I：排行榜周期纯重建函数 `application/ranking-rebuild.ts`（不接 repository、不使用任何旧 rankings 缓存）。`rebuildPeriodRankings(items, periodByPrediction, anchorByPrediction)` 从 applied settlement_items 账本与 prediction->period / prediction->period_anchor_at 映射重建指定 week/month 周期 rankings：按 score_delta、valid_prediction_delta、wdl/exact delta 聚合 period_score/valid_predictions/wdl_hits/exact_hits；last_scoring_match_at 按每条 prediction 最高 source_result_version 且 new_score>0 的 applied item 取其 match period_anchor_at 最大值（period_score=0 时按 domain `lastScoringForPeriodScore` 强制 null）。排序唯一入口为 domain `compareRankingEntry`（period_score DESC、准确率交叉乘法、exact DESC、last_scoring ASC null 排后、user_id ASC）；global_rank 用 `rankForPosition`：valid_predictions<3 为 null，>=3 为排序位置。账本校验与 stats-rebuild 同套规则 + period 映射/anchor 映射必须齐全 + 全部 item 必须同一 (period_type, period_key)，非法 ledger 抛 INVALID_LEDGER，非法 period_type 抛 INVALID_PERIOD_TYPE；空 ledger 返回空数组。26 项纯函数测试通过。
  - 阶段 5 追加切片 J：`application/unlock-decision.ts` 实现 `unlock_v1` 阈值解锁纯决策。按 30/100/200 阈值顺序返回尚未授予的 grants，已存在解锁跳过，积分下降不产生回收动作；不接 repository、结算或 API。6 项纯函数测试通过。
  - 阶段 5 追加最小切片 K：`application/unlock-persistence.ts` 读取用户当前 `career_points`，在事务中按 `unlock_v1` 创建未授予解锁；`unlocks` repository 使用 `UNIQUE(user_id, unlock_code)` 并支持查询、回滚与重复调用幂等。5 项应用测试与 3 项 repository 测试通过。
  - 阶段 5 追加结算集成切片：`application/settlement-item-application-service.ts` 在单一事务中应用 settlement item 到 prediction、career、season、week/month ranking、career/season level、level_history、unlock，并按 `compareRankingEntry` 重算受影响周期的 global_rank；`settlement-orchestration-service.ts` 默认将 atomic worker 接入 First/Retry/Correction。支持 pending/failed 恢复、目标版本已写入时补记 item、applied 重放幂等和 ledger fail-closed。`predictions`、`user_season_stats`、`rankings`、`level_history` repository ports 与内存事务适配器已补齐。新增 6 项集成测试。

## 常用命令

```sh
npm run typecheck   # tsc --noEmit 全量类型检查
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json 产出 dist/
```

阶段 5 已完成切片 G/H/I/J/K、结算 item 原子应用集成及事实账本 rebuild 应用服务（见上）。`RebuildUserStatsService` 从 applied settlement_items、match_results、matches 重建 career/season stats、等级、level_history 和 unlock；`RebuildPeriodRankingsService` 从目标周期事实重建 rankings、last_scoring_match_at 和 global_rank，并使用 maintenance lock 和 active settlement 冲突保护。阶段 6 已完成管理员异常查询、赛果修正成功响应、retry 成功响应/审计和用户统计 rebuild 最小垂直切片：`GET /v1/admin/anomalies` 支持 status/blocking 筛选、签名 cursor 和稳定 keyset 分页；`POST /v1/admin/matches/:match_id/result-corrections` 已按第 48.2 返回 `201` 成功 envelope 和有限 data；`POST /v1/admin/matches/:match_id/retry-settlement` 已按第 48.2 返回 `200` 有限 data，并在 retry 结算事务内写入第 48.4 的有限审计快照；`POST /v1/admin/rebuild/users/:user_id` 复用上述服务并追加有限前后统计审计摘要；管理员 retry 已按第 48.5 选择最小可重试 failed settlement、对缺版本/冲突 fail closed，并校验 settlement 版本序列的 `is_correction` 标记；支持 correction settlement retry；本轮补充已追平版本残留非 settled settlement 与 correction retry 残留 running settlement 时 Fail Closed；`POST /v1/admin/rebuild/rankings` 已按第 48.2 返回有限 data 并写入有限审计摘要；`PeriodFinalizeService` 按第 32.6/19.7 使用 `sync:period_finalize` 锁和事务封存到期 week/month rankings，重复执行与已封存记录幂等；`DailyConsistencyService` 已按 daily_consistency 锁运行并持久化 `sync_logs` 的 running/success/failed 摘要，发现缓存差异时追加固定报警码与定位摘要，并持久化 `skipped_active_settlement` 跳过范围；新增 repository-backed daily consistency 事实快照加载，按 applied ledger 重建 career/season/week/month expected 并记录 active settlement 跳过范围；新增 `ProviderSyncDispatcher` 统一分发五类 Provider 任务；新增 `provider_snapshots` append-only repository port 与内存事务适配器，支持按实体读取、`snapshot_id` 唯一约束和回滚。规范未定义 daily consistency 专用 anomaly type/Collection，因此不擅自扩展 anomalies schema；第 44 节全部验收覆盖仍未实现；前端 UI 暂不开发。

本轮补齐 `GET /v1/levels/me` 当前 MVP 赛季与生涯等级查询、`GET /v1/unlocks/me` 默认资源与历史解锁查询及 OpenAPI contract；本轮新增 `GET /v1/rankings` 公开周/月榜查询、签名周期 cursor、最低场次过滤、active/deleted 用户展示映射及 OpenAPI contract；本轮新增 `ProviderFutureScheduleService` 的 `future_schedule` 端到端组合流程；daily consistency 已通过现有 `sync_logs` 持久化差异报警摘要，第 44 节全部验收覆盖仍未完成。

本轮新增 `GET /v1/matches` 公开比赛列表查询：固定 MVP 赛季、默认 `server_now - 24h` 到 `server_now + 30d` 窗口、90 天上限、状态筛选、HMAC keyset cursor、球队名称映射及 `can_predict` 原因；缺失球队或非法比赛事实按 Fail Closed 处理。

本轮新增 `PATCH /v1/profile/me` 资料更新：只允许 nickname/favorite_team_id，复用昵称 grapheme 校验，主队只接受 active team 或 null，并在事务内更新。

本轮新增 `GET /v1/predictions/me` 历史预测列表：固定 MVP 赛季、`submitted_at DESC, prediction_id DESC` 稳定排序、绑定赛季的 HMAC keyset cursor，以及当前比赛状态、正式比分和结算字段。

本轮补齐分享卡查询的事实边界：已结算 prediction 在统计前执行 `exact_hit => wdl_hit` invariant，损坏事实 Fail Closed，不把非法命中计入分享卡。

本轮新增 Provider 合法 `FT + fulltime` 赛果落库：按 Provider match mapping 写入 immutable `match_results`、推进比赛状态和首次/修正结算状态，重复比分幂等；管理员正式结果优先时只保存冲突 snapshot/anomaly，不覆盖业务事实。完整 Provider 端到端状态/赛程同步仍未实现。

本轮新增 `createNearMatchLoader`：按可信 `server_now` 请求固定英超 2026 赛季 T-24h 到 T-2h 的 fixtures，应用层精确筛选 kickoff 窗口并保留非法时间数据供下游 Fail Closed。

本轮补齐 Provider fixture 主入口的球队变更接线：在 mapping 可用时复用既有 `applyTeamChange`，scheduled 且无 prediction 可更新主客队；已有 prediction 或已开赛变更按第 31.7 节保持原事实并记录 blocking anomaly。

本轮新增 `createLiveMatchLoader`：为 `live_match` 任务读取 T-2h 内及已开始的固定英超 fixtures，精确过滤 Provider 日期查询带来的额外未来比赛，并保留非法 kickoff 供下游 Fail Closed；不连接真实 Provider。

本轮新增 `ProviderLiveMatchService`：贯通固定赛季球队同步、`live_match` fixture loader、单 fixture 同步、`sync:live_match` lease 与 `sync_logs`；不连接真实 Provider。

本轮新增 `createPostFinishVerifyLoader`：为 `post_finish_verify` 读取最近 24 小时至可信 `server_now` 的 fixtures，精确过滤时间窗口并保留非法 kickoff 供下游 Fail Closed；不连接真实 Provider。

本轮新增 `ProviderPostFinishVerifyService`：贯通固定赛季球队同步、`post_finish_verify` fixture loader、单 fixture 同步、`sync:post_finish_verify` lease 与 `sync_logs`；不连接真实 Provider。

本轮补齐 Provider 首次 scheduled fixture discovery：在球队 mapping 可用时创建固定 MVP 赛季的 match 与 match mapping，写入 prediction deadline 和 discovered snapshot；非法 round 或缺少球队 mapping 时 Fail Closed。

本轮补齐 daily consistency expected 快照的 career/season `best_level` 保留规则：重建时保留现有历史最高等级，并合并 level history 与当前等级，避免将合法的只增不减缓存误报为差异。

本轮补齐 Provider fixture 主入口异常评估接线：成功或幂等观察按第 33.1～33.3 评估并持久化/确定性 resolve `LIVE_SYNC_STALE`、`LIVE_TOO_LONG`、`FINISHED_NO_SCORE`；失败或冲突不被当作成功同步。

本轮补齐 Provider scheduled 状态同步的缺失 kickoff 边界：按第 31.5/44.113 保留已有比赛事实，在同一事务内记录 `provider_error` snapshot 与 `PROVIDER_DATA_INVALID` anomaly，并返回可计数的失败结果。

本轮新增 `ProviderSyncDispatcher`：按固定五类 Provider job_type 统一分发既有 future/full/near/live/post-finish 端到端 runner，校验可信 `server_now`；不连接真实 Provider。

本轮补齐 correction retry 的 settlement 类型边界：复用已有文档若 `is_correction` 非 `true` 则 Fail Closed，不推进状态或账本。

本轮补齐 correction retry 的结果版本不变量边界：`settlement_status=settled` 但 `settled_result_version != result_version` 时 Fail Closed，不创建或推进 correction settlement。

本轮补齐普通 retry 的结果版本单调性边界：低于或等于 `match.settled_result_version` 的 failed settlement Fail Closed，不回退比赛已结算版本或重复处理账本。

本轮补齐第 48.5 的 retry 目标输入一致性边界：failed settlement 不在完整 settlement 列表中时 Fail Closed，不猜测管理员 retry 目标。

本轮补齐 `period_finalize` 的可信时间边界：无效 `server_now` 在获取锁和写入 ranking 前 Fail Closed，避免用 `Invalid Date` 封存周期。

本轮补齐 `period_finalize` 的 `sync_logs` 生命周期：记录 running/success/failed 摘要，缺少日志 port 时在获取锁前 Fail Closed。

本轮补齐 `matches` repository 的事实保护边界：固定身份字段、已写入的 prediction close/period anchor/finish detected 时间不可篡改，结果版本只允许单调前进，并保留首次时间事实写入路径。

本轮补齐管理员赛果修正的可信时间边界：无效 `server_now` 在事务和审计写入前 Fail Closed，保持结果账本与比赛事实不变。

本轮补齐普通 retry 的可信时间边界：无效 `server_now` 在读取 settlement、获取比赛锁和推进账本前 Fail Closed。

本轮补齐 Provider 状态同步的可信时间边界：无效 `server_now` 在 scheduled、postponed、live、cancelled、abandoned 状态与球队变更事务前 Fail Closed。

本轮补齐用户统计 rebuild 的可信时间边界：`RebuildUserStatsService` 在获取 maintenance lock 前拒绝无效 `server_now`，避免写入无效 lease 或缓存时间。

本轮补齐第 40 节 rankings invariant 持久化边界：`rankings` repository 的 insert/update 均执行既有命中关系与非负 `period_score` 断言，非法聚合 Fail Closed 且不会替换原缓存。

本轮补齐第 40 节 settlement item invariant 持久化边界：`settlement_items` repository 的 insert/update 拒绝非法单场分值、`exact_hit => wdl_hit` 破坏和非 `0/1` 的 `valid_prediction_delta`。

本轮补齐第 48.2 retry 成功响应的身份字段边界：`settlement_id` 与 `audit_id` 必须为 UUID，application 返回非法标识时 API Fail Closed，不生成 200 响应。

本轮补齐管理员 API 限流：`GET /v1/admin/anomalies` 与四个管理员写入口按可信管理员身份执行 60 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract；公开读取入口仍未接线。

本轮补齐公开比赛详情限流：`GET /v1/matches/:match_id` 按可信网关来源执行 120 requests/min，缺少来源标识或超限时 Fail Closed，并同步 OpenAPI contract；公开 rankings 读取限流已由现有实现覆盖。

本轮补齐公开 profile 限流：`GET /v1/profiles/:user_id` 按可信网关来源执行 120 requests/min，缺少来源标识或超限时 Fail Closed，并同步 OpenAPI contract；公开 rankings 读取限流已由现有实现覆盖。

本轮补齐 `GET /v1/profile/me` 的 authenticated read 限流：按 authenticated `user_id` 执行 120 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。

本轮补齐 `post_finish_verify` 首次结算入口的可信时间边界：在读取 blocking anomaly 前拒绝无效 `server_now`，不启动结算编排。

本轮补齐 `GET /v1/unlocks/me` 的 authenticated read 限流：按 authenticated `user_id` 执行 120 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。

本轮补齐第 48.2 管理员 user stats rebuild 响应边界：`season_stats` 必须为数组且 `rebuilt_season_count` 为非负整数，伪 length 对象 Fail Closed，不生成 200。

本轮补齐管理员 retry 并发结果映射：`already_running` 映射为 `SETTLEMENT_ALREADY_RUNNING`，`already_settled`/`not_retryable` 映射为 `SETTLEMENT_NOT_READY`，不生成 200。

本轮补齐 `DELETE /v1/profile/me` 与 `POST /v1/session/init` 限流：注销写操作按用户 20 requests/min，session init 按可信 openid 120 requests/min，超限返回 `RATE_LIMITED`/429，并与 OpenAPI 429 声明对齐。

本轮补齐第 15.8 节 settlement global rank 重算锁：`SettlementItemApplicationService` 在重算 week/month `global_rank` 时获取 `ranking:{period_type}:{period_key}` 锁，占用则 Fail Closed 回滚；成功后释放锁。

本轮补齐第 15.8 节 period rankings rebuild 的 ranking 周期锁：`RebuildPeriodRankingsService` 在重写 rankings/`global_rank` 前获取同一 `ranking:{period_type}:{period_key}` 锁，占用则 Fail Closed，成功后释放。


本轮补齐第 15.9 节 settlement finalize 后的 correction 队列推进：orchestration 与管理员 retry 在 finalize 后自动按最小未处理 result_version 启动 correction，顺序追平到 settled 或失败停止。

本轮补齐第 5.3/C23 节：既有 match 同步时若 Provider round 与内部 `round_id` 冲突，保留原 round、记录非阻塞 `PROVIDER_DATA_INVALID` anomaly 与冲突 snapshot，不自动覆盖。

本轮完成第 2.5/43.21 节 schema migration/version 基础设施：`schema-migration` 固定当前版本=1 与空 migration 注册表，未知版本 Fail Closed；核心 invariant 与 repository 写入强制 `schema_version=1`。
本轮补齐第 44 节可追踪验收：延期 C17-C22、无效比赛 F38-F42、注销 M100-M104 与并发幂等 D24-D28 标题 ID；新增验收矩阵覆盖扫描与第 22 节索引契约测试。

## 关键实现约定

- `users.openid` 为事实身份，唯一索引 `uk_openid`；普通业务不得更新 openid，仅注销流程改写为墓碑值（`"deleted:" + user_id`），仓储层保证变更时旧索引移除、新 openid 唯一。
- 预测唯一约束 `UNIQUE(user_id, match_id)` 与 `UNIQUE(user_id, idempotency_key)`；`job_locks` 按 lease 过期可接管。
- 不提交、不推送、不读取或修改任何凭证文件。

本轮完成第 44 节 G43-G52 Provider 数据验收矩阵（fixture 主入口端到端）：合法 FT 创建 result v1；无/非法 fulltime 与未知状态/AET/PEN 记 blocking anomaly 且不结算；live goals 不入账；finished→live 不回退；admin 结果优先；有 prediction 时主客队变更 Fail Closed，无 prediction 且 scheduled 可更新。

本轮补齐第 44 节 H53-H59 result_version 验收矩阵：初始 result_version=0；首次正式比分创建 v1；重复相同比分不新增版本；2:1→1:1 增到 v2；v1/v2/v3 不可变账本均永久保存且不可覆盖；waiting 内 v1→v2→v3 时首次结算直接以 v3 结算；v1 结算后 v2/v3 按 settled_result_version+1 顺序处理，禁止跳版本；并扩展 `matrix-44-coverage` 可追踪扫描。

本轮补齐第 44 节 I60-I65 结算幂等验收矩阵：同 settlement 执行两次积分只变化一次；同 settlement_item applied 后再次处理无业务变化；1000 人结算第 488 条失败时前 487 条不重复且 retry 只处理 failed/pending；retry 从 failed/pending item 继续并跳过已 applied；无预测比赛也能最终 settled；settlement running 时第二个同 match worker 无法取得锁并返回 SETTLEMENT_ALREADY_RUNNING；复用真实 First/Retry settlement 服务与原子 settlement item 应用验证账本、状态机与锁语义，并扩展 `matrix-44-coverage` 可追踪扫描。
