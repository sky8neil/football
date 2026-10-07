# CloudBase 仓储端口覆盖表（S13 A 段）

src/infrastructure/cloudbase-app-repository.ts 实现全部 AppRepository / UnitOfWork 仓储端口；字段使用 src/schema/collections.ts 定义的 snake_case，文档 _id 规则在下表备注。仓储只依赖 CloudBaseDb，端口定义位于 src/infrastructure/cloudbase-db.ts。

| 仓储端口 | 方法 | 状态 |
|---|---|---|
| UserRepository | findByOpenid, findById, findAll, insert, update | 已实现；_id = user_id |
| DeletedOpenidMappingRepository | findByOriginalOpenid, findByDeletedUserId, upsert | 已实现；upsert 使用 original_openid 确定性 _id |
| TeamRepository | findById, insert | 已实现；_id = team_id |
| TeamProviderMappingRepository | findByProviderAndExternalId, findByTeamId, insert | 已实现；_id = (provider, provider_team_id) |
| MatchProviderMappingRepository | findByProviderAndExternalId, findByMatchId, insert | 已实现；_id = (provider, provider_match_id) |
| ProviderSnapshotRepository | findByEntity, findLatestSuccessByEntity, insert | 已实现；_id = snapshot_id |
| AdminRepository | findByOpenid, insert | 已实现；_id = admin_id |
| AdminAuditLogRepository | findByEntity, insert | 已实现；_id = audit_id |
| AnomalyRepository | findByKey, findOpenBlockingByMatch, findPage, insert, update | 已实现；_id = anomaly_id |
| SyncLogRepository | insert, update | 已实现；_id = sync_job_id |
| MatchRepository | findById, findBySeason, findByLeagueSeasonRound, findLive, insert, update, updateSettlementStatus | 已实现；_id = match_id |
| PredictionRepository | findById, findByUserAndMatch, findByUserAndIdempotencyKey, findByUser, findByMatch, insert, update | 已实现；_id = prediction_id，两项业务唯一键由索引约束 |
| JobLockRepository | acquire, isHeld, renew, release | 已实现；_id = lock_key，操作经事务执行 |
| MatchResultRepository | findByMatchAndVersion, findLatestByMatch, insert | 已实现；_id = (match_id, result_version) |
| SettlementRepository | findById, findByMatch, findByMatchAndVersionAndRule, findByStatus, insert, update | 已实现；_id = settlement_id |
| SettlementItemRepository | findBySettlementAndPrediction, findBySettlement, findBySettlementAndStatus, findByStatus, findAppliedByUserBefore, insert, update | 已实现；_id = (settlement_id, prediction_id) |
| UnlockRepository | findByUser, findByUserAndCode, insert | 已实现；_id = unlock_id |
| UserSeasonStatsRepository | findByUserAndSeason, findByUser, findByLevelSeason, insert, update | 已实现；_id = (user_id, level_season_id)，包含 last_scoring_match_at |
| BoardSnapshotRepository | findLatestByBoard, findLatestBySeason, findFinalBySeason, listFinalSeasonIds, findByBoardAndSnapshotAt, insert | 已实现；_id = (board, snapshot_at, user_id)，包含 level_season_id、season_*、is_final |
| GroupRepository | findById, findByOwner, findByInviteCode, insert, update | 已实现；_id = group_id，邀请码唯一键由 uk_invite_code 约束 |
| GroupMemberRepository | findByGroupAndUser, findByGroup, findByUser, insert, update | 已实现；_id = (group_id, user_id) |
| RankingRepository | findByPeriodAndUser, findByPeriod, findAll, insert, update | 已实现；_id = (period_type, period_key, user_id) |
| LevelHistoryRepository | findByUser, insert | 已实现；_id = level_history_id |
| AppRepository / UnitOfWork | withTransaction, savepoint | 已实现；通过 CloudBaseDb.transaction 执行 |

## 数据库端口

CloudBaseDb 提供 get、原子 add、update、query、count 和 transaction。确定性 _id 用于可用自然键表达的唯一关系；其余复合业务唯一键由 schema 索引约束，并将冲突映射为 UniqueConstraintError。

src/infrastructure/cloudbase-repository.test.ts 中的 MemoryCloudBaseDb 用于本地契约验证，覆盖唯一冲突、用户软删除记录、群分页、成员数、终榜过滤、事务回滚和 savepoint。没有 CloudBase SDK 适配器，也没有真实 CloudBase 环境；本表不代表真实库已完成集成验证。网关使用 FOOTBALL_REPOSITORY_BACKEND=memory|cloudbase 选择仓储；CloudBase 模式需要 FOOTBALL_CLOUD_ENVIRONMENT_ID、FOOTBALL_RESOURCE_NAMESPACE 和显式注入的 CloudBaseDb 适配器，不会自动回退内存仓储。
