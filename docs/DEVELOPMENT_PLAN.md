# 赛事预言家 MVP 开发计划

依据 `/home/football/MVP__v1.0.md`，按冻结规范实施，前端 UI 暂不开发。

## 阶段 1：项目骨架与纯领域层
- TypeScript strict、Vitest、ESM
- schema_version=1、固定配置、枚举与领域类型
- 时间/周期、比分推导、计分、等级、排名比较、状态机、预测策略
- OpenAPI 初始骨架、Schema/索引定义
- 第 44 节 A/B/E/K/L 核心纯函数测试

## 阶段 2：基础设施与预测
- repository ports、事务/锁抽象与内存测试适配器
- session、用户、球队/比赛读取
- prediction 创建、服务端校验、两层幂等
- API validators/error mapper
- 本轮补齐第 40 节 prediction invariant 持久化边界：`predictions` repository 的 insert/update 均执行既有 `exact_hit => wdl_hit` 断言，非法命中事实 Fail Closed 且不会留下部分更新。
- 本轮补齐第 40 节 rankings invariant 持久化边界：`rankings` repository 的 insert/update 均执行既有命中关系与非负 `period_score` 断言，非法聚合 Fail Closed 且不会替换原缓存。
- 本轮补齐：预测提交在幂等重放前校验 `user.status=active`；已注销用户即使复用历史 `idempotency_key` 也拒绝提交。
- 本轮完成：`GET /v1/matches` 公开比赛列表，固定 MVP 赛季、默认时间窗口与 90 天上限、状态筛选、HMAC keyset cursor、球队展示和 `can_predict` 原因映射；缺失球队或非法比赛事实 Fail Closed。
- 本轮完成：`GET /v1/matches/:match_id` 公开比赛详情，复用比赛列表字段、可选登录上下文下返回当前用户 prediction 摘要，并补齐 API/OpenAPI contract。
- 本轮完成：`PATCH /v1/profile/me` 严格限制 nickname/favorite_team_id 字段，在事务内校验 active 用户与 active team，并补齐 API/OpenAPI contract。
- 本轮完成：Provider 身份映射仓储补齐 `team_provider_mappings` 与 `match_provider_mappings` ports/内存适配器，按规范唯一索引查询并支持事务回滚；未接入真实 Provider。
- 本轮完成：`GET /v1/predictions/me` 按固定 MVP 赛季提供历史预测分页，使用 `submitted_at DESC, prediction_id DESC` 稳定排序与绑定赛季的 HMAC cursor，并返回当前比赛状态、正式比分和结算字段；API/OpenAPI contract 已覆盖。

## 阶段 3：Provider 同步
- API-Football adapter/client contract
- fixture mapper、状态/比分校验、snapshot/anomaly
- schedule/live/post-finish sync 与 retry 配置
- 本轮完成：Provider 合法 `scheduled -> postponed` 状态落库；截止前保留 `prediction_closed_at=null`，截止后先写入原 `prediction_deadline_at`，重复 `PST` 观察幂等且不重复状态快照。
- 本轮完成：对已存在 `match_provider_mappings` 的合法 `FT + fulltime` 观察写入 immutable `match_results`，按状态机推进首次 `waiting` 或修正 `correcting`，重复比分幂等；管理员结果冲突只写 `provider_snapshots` 与 `ADMIN_PROVIDER_RESULT_CONFLICT` anomaly。
- 本轮补齐：Provider 轮询错过 `live` 而直接发现合法 `FT` 时，首次结果同步按既有 `kickoff_at` 初始化 immutable `period_anchor_at`，不覆盖已有锚点。
- 本轮补齐：Provider 合法 `ABD` 状态按状态机写入 `abandoned`，保持 `settlement_status=pending`、不写正式赛果；重复观察幂等，非法状态/结算组合保存 blocking conflict snapshot/anomaly。
- 本轮补齐：Provider 主客队变更按第 31.7 节处理；无 prediction 且仍 scheduled 时按球队 mapping 更新，已有 prediction 或已开赛时保持原比赛事实并写入 `TEAM_CHANGE_AFTER_PREDICTION` blocking anomaly 与冲突 snapshot。
- 本轮补齐：Provider `TBD/NS` scheduled 观察按第 6.2/6.5/6.6 处理 kickoff、确认标记与 deadline；支持 `postponed -> scheduled`，已关闭比赛保留旧 deadline，anchor 冻结后的 kickoff 变化 Fail Closed 并记录 blocking conflict snapshot/anomaly。
- 本轮补齐：Provider 首次进入 `live` 且 period anchor 尚未冻结时采用 Provider kickoff，按未关闭规则重算 deadline 并以该 kickoff 冻结 period anchor；已有 anchor 仍按第 6.6 记录冲突，不覆盖比赛事实。
- 本轮完成：`ProviderFixtureSyncJobService` 执行注入 fixture 批次，按 `sync:{job_type}` 获取并续租 lease，持久化 `sync_logs` running/success/failed 摘要，并对单 fixture 的 conflict/failure 做 Fail Closed 计数；不连接真实 Provider。
- 本轮补齐：`ProviderFixtureSyncJobService` 对 loader 层暂时错误按 32.8 执行 1/2/5/10/30 分钟退避与 ±20% jitter，quota/data 错误 Fail Closed 不自动重试，并在 `sync_logs.attempt_count` 保留尝试次数；等待与随机数可注入测试。
- 本轮补齐：`ProviderFixtureSyncJobService` 在获取 `sync:{job_type}` 锁、写入 `sync_logs` 和调用 loader 前校验合法 `server_now`；无效时间直接 Fail Closed，不推进 Provider 任务。
- 本轮完成：`createFutureScheduleLoader` 为 `future_schedule` 提供注入式 API-Football fixture loader，按可信 `server_now` 查询固定英超 2026 赛季未来 30 天，保留原始 fixture payload；不连接真实 Provider。
- 本轮完成：`createFullScheduleVerifyLoader` 为 `full_schedule_verify` 提供固定英超 2026 赛季的完整 fixtures 查询，使用注入式 `getSeasonFixtures` contract 并保留原始 fixture payload；不连接真实 Provider。
- 本轮完成：`ProviderFutureScheduleService` 贯通 `future_schedule` 的注入式球队同步、Provider mapping、未来 30 天 fixture loader、单 fixture 状态同步、`sync:future_schedule` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮完成：`ProviderFullScheduleVerifyService` 贯通 `full_schedule_verify` 的注入式球队同步、完整赛季 fixture loader、单 fixture 状态同步、`sync:full_schedule_verify` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮完成：`ProviderNearMatchService` 贯通 `near_match` 的注入式球队同步、T-24h 到 T-2h fixture loader、单 fixture 状态同步、`sync:near_match` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮完成：`createNearMatchLoader` 为 `near_match` 请求 T-24h 到 T-2h 的固定英超 fixtures，按 kickoff 精确筛选窗口并保留非法时间数据供下游 Fail Closed；不连接真实 Provider。
- 本轮补齐：`ProviderFixtureSyncService` 主入口在 Provider 球队 mapping 可用时复用 `applyTeamChange`；scheduled 且无 prediction 的球队变更更新内部比赛事实，已存在 prediction 或 Provider 已开赛的变更保持原事实并记录 blocking anomaly，不继续推进状态/赛果。
- 本轮完成：`createLiveMatchLoader` 为 `live_match` 任务读取 T-2h 内及已开始比赛的 Provider fixtures，按精确 kickoff 截断日期查询的额外未来数据，并保留非法 kickoff 交给下游 Fail Closed；不连接真实 Provider。
- 本轮完成：`ProviderLiveMatchService` 贯通 `live_match` 的固定赛季球队同步、T-2h 到 finished fixture loader、单 fixture 同步、`sync:live_match` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮完成：`createPostFinishVerifyLoader` 为 `post_finish_verify` 读取最近 24 小时至可信 `server_now` 的 fixtures，精确过滤时间窗口并保留非法 kickoff 供下游 Fail Closed；不连接真实 Provider。
- 本轮完成：`ProviderPostFinishVerifyService` 贯通 `post_finish_verify` 的固定赛季球队同步、post-finish loader、单 fixture 同步、`sync:post_finish_verify` lease 与 `sync_logs`；不连接真实 Provider。
- 本轮补齐：首次发现合法 scheduled Provider fixture 时创建固定 MVP 赛季的内部 `matches` 与 `match_provider_mappings`，写入 prediction deadline 和 discovered snapshot；round 无法解析或球队 mapping 缺失时 Fail Closed，不落库。
- 本轮补齐：Provider fixture 主入口对成功或幂等观察调用既有异常评估服务，按第 33.1～33.3 持久化/确定性 resolve `LIVE_SYNC_STALE`、`LIVE_TOO_LONG`、`FINISHED_NO_SCORE`；failed/conflict outcome 不视为成功同步。
- 本轮补齐：Provider scheduled 状态同步收到缺失或非法 kickoff 时按第 31.5/44.113 保留比赛可信字段，在事务内追加 `provider_error` snapshot 与 `PROVIDER_DATA_INVALID` anomaly，并返回可计数失败结果。
- 本轮补齐：Provider `scheduled/postponed` 在 `period_anchor_at=null` 时应用新的 kickoff；延期仍未关闭时重算 prediction deadline，已关闭 deadline 保留原事实，anchor 已冻结的 kickoff 变化按 blocking anomaly 处理。
- 本轮完成：`ProviderSyncDispatcher` 按固定五类 Provider `job_type` 统一分发既有 future/full/near/live/post-finish 端到端 runner，校验可信 `server_now`；不连接真实 Provider。

## 阶段 4：结算与赛果修正
- settlements/items 账本
- item 原子幂等、失败恢复、match lease
- 已完成：settlement item 与 prediction、career/season、week/month ranking、level_history、unlock 的事务内应用；First/Retry/Correction worker 具备事务上下文接线
- 本轮完成：`post_finish_verify` 首次结算入口从 anomaly repository 读取 open blocking anomaly，满足保护期与既有首次结算状态机后复用 settlement orchestration；异常或条件不足时 Fail Closed。
- 本轮补齐：`PostFinishSettlementService` 在读取 blocking anomaly 前校验可信 `server_now`，无效时间 Fail Closed。
- result_version、immutable results、correction queue

## 阶段 5：统计、等级、排行榜、解锁
- career/season ledger rebuild
- period aggregates/rank rebuild
- unlock/level history
- 本轮完成：`GET /v1/levels/me` 读取当前 MVP 赛季与生涯等级统计，active 用户鉴权、缺失赛季文档零值视图、准确率显示和 OpenAPI contract 已覆盖
- 本轮完成：`GET /v1/unlocks/me` 返回固定默认资源与全部历史 unlock 记录，active 用户鉴权、UTC 时间序列化和 OpenAPI contract 已覆盖
- 已完成：增量 settlement item 聚合应用与受影响周期 global_rank 重算；`RebuildUserStatsService` / `RebuildPeriodRankingsService` 从事实账本重建聚合、等级、历史、解锁与周期排名，含 repository/application 集成测试
- 本轮补齐分享卡查询的事实边界：已结算 prediction 在计入分享卡前执行第 40 节 `exact_hit => wdl_hit` invariant，损坏账本事实 Fail Closed。
- 本轮完成：`GET /v1/rankings` 公开周/月榜查询，按可信 `server_now` 解析默认周期，过滤 `global_rank=null` 条目，使用签名且绑定周期的 keyset cursor，并映射 active/deleted 用户展示字段；应用层对缺失用户和非法聚合数据 Fail Closed，OpenAPI contract 已覆盖。

## 阶段 6：管理员、运维与最终验收
- admin correction/retry/rebuild/audit
- 已完成最小切片：可信 openid active 管理员授权、`GET /v1/admin/anomalies`（status/blocking 筛选、签名 cursor、稳定 keyset 排序）、赛果修正 request validator/application command、immutable result version、状态机排队和 admin_audit_logs 原子写入；`POST /v1/admin/matches/:match_id/result-corrections` 已按第 48.2 对齐 `201` 成功 envelope、有限 data 与 OpenAPI；`POST /v1/admin/matches/:match_id/retry-settlement` 已接入第 48.5 的 failed settlement 目标选择、match lock、普通/修正结算 retry、原子账本 worker、`200` 成功 envelope 和有限 retry 审计快照；`POST /v1/admin/rebuild/users/:user_id` 已接入 trusted openid、active admin、maintenance lock、active settlement 冲突保护、事实账本重建、有限前后统计审计摘要和原子审计；`POST /v1/admin/rebuild/rankings` 已对齐第 48.2 成功 envelope 与有限审计摘要；`PeriodFinalizeService` 已按第 32.6/19.7 在 `sync:period_finalize` 锁和事务内封存到期 week/month rankings，重复执行与已封存记录幂等；`DailyConsistencyService` 已按 daily_consistency 锁持久化 `sync_logs` 的 running/success/failed 摘要；新增 repository-backed daily consistency 事实快照加载，按 applied ledger 重建 career/season/week/month expected 并记录 active settlement 跳过范围；新增既定 match anomaly 的按 `match_id:type` 幂等持久化、确定性 resolve 与重开；新增 `provider_snapshots` append-only repository port 与内存事务适配器，支持按实体读取、`snapshot_id` 唯一约束和回滚。daily consistency anomaly 落库仍待后续切片；第 48 节已冻结的定义不再视为 SPEC_GAP。
- 本轮补齐第 48.5 的账本一致性边界：若 `settled_result_version` 之前仍存在非 settled settlement，管理员 retry 目标选择 Fail Closed，不继续处理更高版本。
- 本轮补齐第 48.5 的 settlement 类型一致性边界：管理员 retry 选择前校验同一比赛 settlement 版本序列的 `is_correction` 标记，冲突时 Fail Closed。
- 本轮补齐 correction retry 的残留 `running` settlement 边界：复用已有 running 文档时返回 `SETTLEMENT_ALREADY_RUNNING`，不重复处理 item 或推进账本状态。
- 本轮补齐 correction retry 的 settlement 类型边界：复用已有文档若 `is_correction` 非 `true` 则 Fail Closed，不推进状态或账本。
- 本轮补齐 correction retry 的结果版本不变量边界：`settlement_status=settled` 但 `settled_result_version != result_version` 时 Fail Closed，不创建或推进 correction settlement。
- 本轮补齐 daily consistency expected 快照的 best level 下限：career/season 重建保留现有 best_level，并合并 level_history 与当前计算等级，符合第 17.6/35.1 的只增不减规则。
- 本轮完成环境隔离配置最小切片：固定 dev/test/prod，校验云环境 ID 与资源命名空间唯一；不读取或保存 Provider 凭证值。
- 本轮补齐 daily_consistency 长运行任务的 lease 半周期续租；续租失败在事实快照返回后的检查点 Fail Closed，并记录失败 sync log。
- 本轮补齐普通 retry 的结果版本单调性边界：低于或等于 `match.settled_result_version` 的 failed settlement Fail Closed，不回退比赛已结算版本或重复处理账本。
- 本轮补齐第 48.5 的 retry 目标输入一致性边界：`failedSettlements` 与完整 settlement 列表不一致时 Fail Closed，不猜测管理员 retry 目标。
- 本轮补齐 `matches` repository 的事实保护边界：`round_id`、固定赛季/计分规则及已写入的关闭时间、周期锚点、完成检测时间不可篡改；`result_version` 与 `settled_result_version` 不得回退；允许规范规定的首次 `null -> timestamp` 写入。
- 本轮补齐 `period_finalize` 的可信时间边界：无效 `server_now` 在获取锁和写入 ranking 前 Fail Closed，避免用 `Invalid Date` 封存周期。
- 本轮补齐 `period_finalize` 的 `sync_logs` 生命周期：取得锁后记录 running，封存成功记录 success，事务失败记录 failed；缺少日志 port 时在获取锁前 Fail Closed。
- 本轮补齐管理员赛果修正的可信时间边界：无效 `server_now` 在事务和审计写入前 Fail Closed，保持结果账本与比赛事实不变。
- 本轮补齐普通 retry 的可信时间边界：无效 `server_now` 在读取 settlement、获取比赛锁和推进账本前 Fail Closed。
- 本轮补齐 Provider 状态同步的可信时间边界：无效 `server_now` 在 scheduled/postponed/live/cancelled/abandoned 状态与球队变更事务前 Fail Closed。
- 本轮补齐用户统计 rebuild 的可信时间边界：`RebuildUserStatsService` 在获取 maintenance lock 前拒绝无效 `server_now`，避免写入无效 lease 或缓存时间。
- 本轮补齐第 22 节 settlements `(match_id, result_version)` 查询 port；管理员 retry 按比赛读取完整 settlement 版本序列，不再按状态扫描后过滤，目标选择与账本语义保持不变。
- 本轮补齐管理员周期排行榜 rebuild 的授权边界：在获取周期 maintenance lock 前先校验 trusted active admin，避免未授权身份通过锁状态获知内部执行信息。
- 本轮完成：daily consistency 发现缓存差异时复用现有 `daily_consistency` `sync_logs` 的 `last_error_code` / `last_error_message` 持久化可定位报警摘要，任务仍为 `success` 且不自动修改缓存；未新增规范未定义的 anomaly type 或 Collection。
- 本轮补齐：daily consistency 对 `settling/correcting` match 的跳过范围在成功 `sync_logs.last_error_message` 中持久化 `skipped_active_settlement` 摘要，保留任务 `success` 和下一轮重校验语义。
- 本轮补齐第 40 节 settlement item invariant 持久化边界：`settlement_items` repository 的 insert/update 拒绝非法单场分值、`exact_hit => wdl_hit` 破坏和非 `0/1` 的 `valid_prediction_delta`。
- 本轮补齐第 40 节 settlements 文档 invariant 持久化边界：`settlements` repository 的 insert/update 拒绝非整数或小于 1 的 `result_version`、非整数或小于 0 的 `attempt_count`，以及未定义的 status/phase；非法更新不替换原文档。
- consistency/anomaly jobs
- OpenAPI 对齐、索引/schema 文档
- 第 44 节 113 项验收测试或明确可追踪覆盖
- 本轮补齐第 48.2 retry 成功响应的身份字段边界：`settlement_id` 与 `audit_id` 必须为 UUID，application 返回非法标识时 API Fail Closed，不生成 200 响应。
- 本轮补齐第 48.2 管理员赛果修正响应一致性边界：application 返回的 `match` 与 `match_result` 必须保持 result_version、正式比分和 result_source 一致，否则 API Fail Closed。
- 本轮完成第 36.4 最小限流切片：新增可替换的固定一分钟 RateLimiter 与五类冻结默认额度，`POST /v1/predictions` 按 authenticated `user_id` 执行 10 requests/min，超限返回 `RATE_LIMITED`/429；profile、authenticated read、admin、public read 的 middleware 接线待后续切片。
- 本轮补齐第 36.4 profile 写接口限流：`PATCH /v1/profile/me` 按 authenticated `user_id` 执行 20 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract；其它读接口与管理接口限流接线仍待后续切片。
- 本轮补齐第 36.4 authenticated read 限流：`GET /v1/predictions/me/:prediction_id` 按 authenticated `user_id` 执行 120 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。
- 本轮补齐第 36.4 authenticated read 限流：`GET /v1/predictions/me` 按 authenticated `user_id` 执行 120 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。
- 本轮补齐第 36.4 管理员读取限流：`GET /v1/admin/anomalies` 按可信管理员身份执行 60 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract；其余管理员、公开读取入口仍待接线。
- 本轮补齐第 36.4 管理员 API 限流：四个管理员写入口按可信管理员身份执行 60 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract；公开读取入口仍待接线。
- 本轮完成第 36.4 公开读取限流的最小切片：`GET /v1/matches` 与 `GET /v1/matches/:match_id` 按可信网关来源执行 120 requests/min，缺少来源标识时 Fail Closed，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。
- 本轮补齐第 36.4 公开 profile 限流：`GET /v1/profiles/:user_id` 按可信网关来源执行 120 requests/min，缺少来源标识或超限时 Fail Closed，并同步 OpenAPI contract；公开 rankings 读取限流已由现有实现覆盖。
- 本轮补齐第 36.4 authenticated read 限流：`GET /v1/profile/me` 按 authenticated `user_id` 执行 120 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。
- 本轮补齐第 36.4 authenticated read 限流：`GET /v1/unlocks/me` 按 authenticated `user_id` 执行 120 requests/min，超限返回 `RATE_LIMITED`/429，并同步 OpenAPI contract。
- 本轮补齐第 48.2 管理员 user stats rebuild 响应边界：`season_stats` 必须是数组，`rebuilt_season_count` 必须为非负整数；伪 length 对象不得生成 200 成功 envelope。

- 本轮补齐第 48.2/30.4 管理员 retry 并发结果映射：`already_running` 返回 `SETTLEMENT_ALREADY_RUNNING`，`already_settled`/`not_retryable` 返回 `SETTLEMENT_NOT_READY`，不生成 200 成功 envelope。

- 本轮补齐第 36.4 剩余 API 限流接线：`DELETE /v1/profile/me` 按 authenticated `user_id` 复用 profile 写额度 20 requests/min，`POST /v1/session/init` 按可信 openid 执行 authenticated read 额度 120 requests/min，超限返回 `RATE_LIMITED`/429，并与既有 OpenAPI contract 对齐。

- 本轮补齐第 15.8 节 settlement item 应用后的 global rank 重算锁：按 `ranking:{period_type}:{period_key}` 获取/释放 job lock，占用时 Fail Closed 并回滚账本写入；成功路径释放 week/month 锁。
- 本轮补齐第 15.8 节 period rankings rebuild 的 ranking 周期锁：`RebuildPeriodRankingsService` 在重写目标周期 rankings/`global_rank` 前获取 `ranking:{period_type}:{period_key}`，占用则 Fail Closed，成功后释放；与 settlement 重算串行。

- 本轮补齐第 15.9 节 settlement finalize 后的 correction 队列推进：`SettlementOrchestrationService` 与管理员 retry 在 version finalize 后若仍有更高 `result_version`，按最小未处理版本自动启动下一 correction settlement，顺序追平到 `settled` 或失败停止；不得在中间版本停住。

- 本轮补齐第 5.3/C23 节 round_id 不可变边界：既有 match 收到 Provider 后续不同 round 时保留原 `round_id`，写入非阻塞 `PROVIDER_DATA_INVALID` anomaly 与冲突 snapshot，并继续应用其它合法状态字段。
- 本轮完成第 2.5/43.21 节 schema migration/version 基础设施：固定 `CURRENT_SCHEMA_VERSION=1`、空 migration 注册表、`resolveMigrationPath`/`listPendingMigrations` Fail Closed；核心 invariant 与 repository 写入拒绝非 1 的 `schema_version`，不猜测旧结构。

- 本轮完成第 44 节 G. Provider 数据验收矩阵 G43-G52：覆盖 FT 正式比分落库、无/非法 fulltime blocking anomaly、live goals 不入正式比分、未知状态/AET/PEN Fail Closed、finished→live 不回退、admin 赛果优先、有/无 prediction 的主客队变更保护；并扩展 matrix-44-coverage 可追踪扫描。
- 本轮完成第 44 节可追踪验收切片：C17-C22 延期（截止前/后重开、跨周/跨月 period_anchor）、F38-F42 无效比赛（cancelled/abandoned/AWD/WO）、M100-M104 注销（openid 墓碑、历史 prediction/rankings 保留、公开显示名、同 openid 再注册新 user_id）；为 D24-D28 补齐标题 ID；新增 `src/acceptance/matrix-44-coverage.test.ts` 与 `src/schema/indexes.test.ts`（第 22 节索引冻结集合）。
- 本轮完成第 44 节可追踪验收切片：H53-H59 result_version（初始 0、首次 v1、重复比分不增版本、变化增版本、v1/v2/v3 不可变账本、waiting 内直接结算最新版本、已结算后按版本顺序处理 correction）；扩展 matrix-44-coverage 可追踪扫描。
- 本轮完成第 44 节可追踪验收切片：I60-I65 结算幂等（同 settlement 两次执行只变化一次、applied item 重放无业务变化、1000 人第 488 条失败前 487 条不重复、retry 从 failed/pending 继续、无预测比赛最终 settled、running 时第二个同 match worker 无法取得锁）；复用真实 First/Retry/Correction settlement 服务与原子 item 应用，扩展 matrix-44-coverage 可追踪扫描。
每阶段由 OpenCode 编码，主 Agent 独立运行 typecheck、测试、必要健壮性测试后自动进入下一阶段。禁止提交、推送、读取或修改凭证文件。

## 第 49 节落地
- 见 DEV_PLAN_SEC49__v1.0.md（鉴权/预测映射/状态机/延期关闭/rebuild 事实源）
