# 赛事预言家：首版全面 Code Review 实施计划（v1.0）

> 状态：**Wave 1–4 审查已全部完成，范围与口径已定稿**  
> 基线依据：[FIRST_RELEASE_FEATURE_SCOPE__v1.0.md](../FIRST_RELEASE_FEATURE_SCOPE__v1.0.md) + [FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md](../FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md)  
> 核心策略：**双轨制 Review（缺陷排查 + 文档/代码口径对齐一次完成）**

---

## 1. 目标与已确认的首版范围基线

本次全面 Code Review 旨在首版上线前完成两件事：
1. **拦截上线风险**：系统性排查后端领域层、应用层、API 网关、PostgreSQL 存储、定时任务、VPS 部署配置与小程序前端中的工程缺陷与逻辑漏洞。
2. **解决文档与代码脱节问题**：在不盲目“以代码反写旧文档（避免把 Bug 洗白为设定）”的前提下，同步抽出所有“代码实现与文档不同，或代码有但文档未写”的条目，交由产品一次性批量裁决并做轻量收口。

### 1.1 已拍板的产品决策（覆盖原草稿 Q2–Q6）

| 原编号 | 事项 | 已确认结论 | 对本次 Review 的影响 |
|---|---|---|---|
| **Q2** | 发布路径 | **首板上 VPS** | VPS 路径（HTTP 网关、PostgreSQL、systemd/timer、Caddy、VPS 运维脚本）为**上线门禁**；CloudBase 专属代码不作为首版门禁，但若与 VPS 共享抽象层（如 Repository/Codec），共享部分必须审查。 |
| **Q3** | 页面与入口完整范围 | **全部纳入首版**（含资料编辑、账号注销、公开主页、分享卡、管理 UI） | 逐项审查前后端完整闭环；**重点核查管理 UI 当前是否存在前端实现**（目前代码树仅见后端 `admin` API 与 `vps-admin.mjs` CLI，需在 S8 明确缺口）。 |
| **Q4** | 解锁记录页 | **纳入首版** | 按“保留解锁记录页并补齐空态、且不引入违规装扮能力”的口径审查，记录与 MVP v2.0 原始条款的例外关系。 |
| **Q5** | 自动换季与休赛期 | **作为首版上线门禁** | 休赛期展示、自动换季流程、跨季赛程与收官判定按 P0/P1 严格审查，不接受纯手工绕过。 |
| **Q6** | “大家怎么选” | **纳入首版** | 完整审查后端统计接口、防泄露/截止时间口径、缓存与小程序端展示（赛程页/比赛详情页）。 |

### 1.2 审查过程中需顺带核实的历史未决项（Q1 / Q7 / Q8）

- **Q1（PRD v2.2 原文缺失）**：若后续未补充原文，则以 [MVP__v2.0.md](../MVP__v2.0.md) + 各专项方案 + 本次产品裁决结果共同形成首版最终事实基线。
- **Q7（数据源口径）**：在 S3 审查时直接核对代码中实际启用的 Provider 列表、优先级、降级与交叉核验逻辑，列入表 B 由产品确认。
- **Q8（首次排行周与收官口径）**：在 S5、S7 审查时核对代码中的具体实现与字段契约，列入表 B 由产品确认。

---

## 2. 双轨制 Review 方法论与交付规范

每个审查切片（S1–S8）**严禁把所有“代码与文档不一致”一概判为缺陷**，必须严格分栏输出两张清单：

### 2.1 表 A：确定性工程与逻辑缺陷（Code Defects）
仅记录**无论文档口径如何调整都属于错误**的问题，按严重级别分类：
- **P0（上线阻断）**：资金/积分账本错误、重复结算或漏结算、越权访问/数据泄露（如泄露他人未截止预测）、数据损坏、VPS 无法启动/调度失效、主链路不可用、已确认必做功能完全缺失（如管理 UI 缺失）。
- **P1（高风险，原则上线前修复）**：状态机边界漏洞、并发竞态、异常未恢复、前后端字段/错误码契约不匹配、限流/重试缺陷、关键空态/错误态体验断裂。
- **P2（中低风险，可排期优化）**：性能隐患、冗余查询、日志/可观测性不足、死代码、测试覆盖盲区。

### 2.2 表 B：代码与文档口径差异清单（Spec-Code Drift）
记录“代码行为清晰且自洽，但与原文档不一致，或文档未记载”的所有设定。每条必须包含：
1. **差异编号**（如 `D-S2-01`）
2. **涉及模块与精确代码位置**（文件 + 行号）
3. **代码实际实现的行为**
4. **原文档描述与来源**（或注明“文档未写”）
5. **产品裁决栏（待填）**：`[ ] 认代码（纳入新口径）` / `[ ] 判为 Bug（移入表 A 修复）` / `[ ] 首版移除/隐藏`

### 2.3 轻量文档收口原则（Review 结束后执行）
- **不翻修**历史过程文档（如 `PRE_LAUNCH_FIX_DEV_PLAN__v1.0~v3.2`、旧审查报告、`archive/`）。
- 仅做两处收口：
  1. 将原草稿升级为 [FIRST_RELEASE_FEATURE_SCOPE__v1.0.md](../FIRST_RELEASE_FEATURE_SCOPE__v1.0.md)（首版确认稿）；
  2. 新建一份精简的 [FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md](../FIRST_RELEASE_SPEC_OVERRIDES__v1.0.md)（《首版现行口径变更与例外清单》），集中记录表 B 中所有“认代码”的裁决结果，注明覆盖的旧条款。

---

## 3. 全面 Code Review 切片拆解（S1–S8）

以下 8 个切片完整覆盖 [FIRST_RELEASE_FEATURE_SCOPE__v1.0.md](../FIRST_RELEASE_FEATURE_SCOPE__v1.0.md) 中的 `F01–F14`、`B01–B08` 及 `MVP v2.0 §1.2` 全部 37 项条款。

---

### S1：身份认证、会话管理、权限边界与 HTTP 网关

- **覆盖范围**：`F01`、游客/登录/管理员权限边界、限流与 OpenAPI 契约
- **对照文档**：[MVP__v2.0.md](../MVP__v2.0.md)、[H4_AUTH_OPENAPI_DEV_PLAN__v1.0.md](../H4_AUTH_OPENAPI_DEV_PLAN__v1.0.md)、[VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md](../VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md)
- **代码范围**：
  - 后端网关与鉴权：`src/gateway/http.ts`、`src/gateway/auth.ts`、`src/gateway/identity.ts`、`src/gateway/wechat-login.ts`、`src/gateway/wechat-http.ts`、`src/gateway/config.ts`、`src/gateway/assemble.ts`
  - 会话与应用层：`src/api/v1/session.ts`、`src/api/v1/validation.ts`、`src/api/v1/rate-limit.ts`、`src/api/v1/rate-limit-store.ts`、`src/api/v1/openapi.yaml`、`src/application/session.ts`
  - 存储层：`src/infrastructure/postgres-auth-sessions.ts`、`src/infrastructure/deleted-openid-mapping-migration.ts`
  - 小程序端：`miniprogram/app.js`、`miniprogram/config.js`、`miniprogram/services/api.js`、`miniprogram/services/auth.js`、`miniprogram/services/session.js`、`miniprogram/utils/auth-storage.js`、`miniprogram/pages/session/*`
- **重点审查点**：
  - 微信 `code2session` 流程、稳定内部用户 ID 映射、账号注销后重新登录的身份隔离（`deleted-openid-mapping`）。
  - 会话 Token 签发、过期、刷新、吊销，以及小程序端 401/失效重登是否会出现死循环或并发竞态。
  - 游客权限矩阵：未登录能否误访问排行榜、他人未截止预测、个人接口或管理接口。
  - VPS 场景下的限流实现（进程内存 vs 数据库持久化，重启/多实例行为）与请求体校验是否与 `openapi.yaml` 一致。

---

### S2：六联赛赛程、球队识别、比分预测、我的预测与“大家怎么选”

- **覆盖范围**：`F02`、`F03`、`F04`、`F05`、`Q6（大家怎么选）`
- **对照文档**：[MVP__v2.0.md](../MVP__v2.0.md)、[MINIPROGRAM_UX_REQUIREMENTS__v1.0.md](../MINIPROGRAM_UX_REQUIREMENTS__v1.0.md)、[MINIPROGRAM_UX_DEV_PLAN__v1.0.md](../MINIPROGRAM_UX_DEV_PLAN__v1.0.md)、[TEAM_NAME_EVIDENCE__v1.0.md](../TEAM_NAME_EVIDENCE__v1.0.md)
- **代码范围**：
  - 领域层：`src/domain/match-state-machine.ts`、`src/domain/prediction-deadline.ts`、`src/domain/prediction-policy.ts`、`src/domain/crowd-distribution.ts`、`src/domain/time.ts`
  - 应用与 API：`src/application/match-query.ts`、`src/application/predictions.ts`、`src/application/prediction-query.ts`、`src/application/crowd-query.ts`、`src/api/v1/matches.ts`、`src/api/v1/predictions.ts`、`src/api/v1/crowd.ts`
  - 小程序端：`miniprogram/pages/matches/*`、`miniprogram/pages/match-detail/*`、`miniprogram/pages/my-predictions/*`、`miniprogram/services/matches.js`、`miniprogram/services/predictions.js`、`miniprogram/services/leagues.js`、`miniprogram/utils/match-*.js`、`miniprogram/utils/team-*.js`、`miniprogram/utils/logo-registry.js`、`miniprogram/utils/crowd-*.js`、`miniprogram/utils/prediction-history.js`、`miniprogram/assets/logos/*`
- **重点审查点**：
  - 预测提交硬约束：0–20 整数、每人每场仅一次、提交后不可修改/删除、开球前 10 分钟截止（**恰到截止时刻不可提交**）、延期后已关闭不重开、服务端推导胜平负。
  - 并发重复提交（双击/弱网重试）在 PostgreSQL 层的唯一性约束与幂等错误码。
  - 北京时间日期切分、六联赛赛程筛选、队名中文映射与缺资料兜底（禁止用“主队/客队”冒充队名）、队徽资源完整性。
  - “我的预测”历史分页（按钮加载更多，而非已撤销的两段式）与完整队名数据链。
  - **Q6 专项**：“大家怎么选”的统计口径、最小样本门槛、展示时机（是否会造成跟风或泄露未截止个体预测）、前后端字段对齐。

---

### S3：比赛数据同步、数据源策略、身份连续性与定时调度

- **覆盖范围**：`B01`、`B02`、`B05`、`Q7（数据源口径）`
- **对照文档**：[MVP__v2.0.md](../MVP__v2.0.md)、[PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md](../PROVIDER_SYNC_RELIABILITY_DEV_PLAN__v1.0.md)、[SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md](../SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md)、[SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md](../SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md)
- **代码范围**：
  - Provider 适配层：`src/provider/*`（所有 adapter、`registry.ts`、`strategy.ts`、`key-pool.ts`、`budget.ts`、`fixture-mapper.ts`、`status.ts`、`kickoff.ts`、`transport.ts`、`http.ts`、`sources.ts`）
  - 同步编排：`src/application/provider-*.ts`、`src/application/match-identity.ts`、`src/application/match-identity-migration.ts`、`src/application/anomaly-*.ts`、`src/sync/*`
  - 定时任务与调度：`src/jobs/tick.ts`、`src/scheduler/tick.ts`、`src/runtime/scheduled-jobs.ts`、`src/application/maintenance-cleanup.ts`
- **重点审查点**：
  - 实际启用的数据源组合、Key 池轮换、配额预算控制、单联赛隔离（一个联赛失败是否拖垮其他联赛）。
  - 比赛改期、外部 ID 变更时的逻辑比赛身份连续性（已提交预测是否会脱钩或允许二次提交）。
  - 状态机转换合法性：数据源返回异常状态、缺失比分、取消/腰斩/加时点球时，是否严格只取 90 分钟+补时且不猜测赛果。
  - 跨源核验（`provider-cross-source.ts`）与结果采纳（`provider-result-adoption.ts`）的判定规则；异常检测与漏项恢复（`provider-stale-recovery.ts`）。
  - 定时任务重入锁/防并发重叠执行（systemd timer 触发周期与单次执行耗时冲突风险）。

---

### S4：预测计分、幂等结算、赛果修正与一致性/重建

- **覆盖范围**：`F06`、`B03`、`B04（数据基础）`、`B07（修正与校验核心）`
- **对照文档**：[MVP__v2.0.md](../MVP__v2.0.md)（计分、结算状态机、账本、赛果修正、重建、每日一致性校验）
- **代码范围**：
  - 领域层：`src/domain/scoring.ts`、`src/domain/settlement-state-machine.ts`、`src/domain/invariants.ts`
  - 结算与应用层：`src/application/settlement*.ts`、`src/application/first-settlement*.ts`、`src/application/post-finish-settlement-service.ts`、`src/application/retry-settlement*.ts`、`src/application/correction-settlement-service.ts`、`src/application/result-correction-plan.ts`、`src/application/level-correction-reeval.ts`
  - 一致性与重建：`src/application/daily-consistency*.ts`、`src/application/stats-rebuild*.ts`、`src/application/rebuild-service-support.ts`
  - 数据库层：`src/infrastructure/postgres-document-db.ts`、`src/infrastructure/settlement-todo-query.ts`、`src/infrastructure/repositories.ts`
- **重点审查点**：
  - 计分规则：精确命中 12 分、仅胜平负 3 分、其余 0 分（不叠加）；取消/腰斩按规范处理；计分规则版本与正式赛果版本记录。
  - **幂等与并发安全（P0 核心）**：结算并发重入、部分失败中断后重试（`retry-settlement`），是否绝不重复入账、不丢账。
  - 赛果修正与自动重结算：差额账本（ledger）回滚/补差是否正确，是否联动触发生涯积分、榜单、等级重评估，且**不回收既有解锁记录**。
  - 事实数据与可重建聚合分离：从账本/事实全量重建用户统计与榜单后，结果是否与增量路径严格一致。

---

### S5：成长等级、各类排行榜、群组与群榜

- **覆盖范围**：`F08`、`F09`、`F10`、`B04`、`Q8（首次排行周）`
- **对照文档**：[MVP__v2.0.md](../MVP__v2.0.md)（§17–§19、群机制）、[MINIPROGRAM_UX_REQUIREMENTS__v1.0.md](../MINIPROGRAM_UX_REQUIREMENTS__v1.0.md)、[archive/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md](../archive/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md)
- **代码范围**：
  - 领域层：`src/domain/levels.ts`、`src/domain/ranking.ts`、`src/domain/season-label.ts`
  - 应用与 API：`src/application/levels.ts`、`src/application/weekly-level-eval.ts`、`src/application/ranking-query.ts`、`src/application/ranking-rebuild*.ts`、`src/application/board-snapshot.ts`、`src/application/period-finalize*.ts`、`src/application/groups.ts`、`src/api/v1/levels.ts`、`src/api/v1/rankings.ts`、`src/api/v1/groups.ts`
  - 小程序端：`miniprogram/pages/rankings/*`、`miniprogram/pages/groups/*`、`miniprogram/services/rankings.js`、`miniprogram/services/levels.js`、`miniprogram/services/groups.js`、`miniprogram/utils/level-*.js`、`miniprogram/utils/rankings-*.js`
- **重点审查点**：
  - 等级系统：六级体系、表现与积分共同定级（不得仅按积分推导）、北京时间每周一 10:00 评估、每次最多升降一级、保护期与校准逻辑、生涯等级与赛季等级区分。
  - 排行榜：周榜、历史周榜、生涯榜、实力榜、当前等级赛季榜、已结束等级赛季终榜的资格门槛、同分排序、冷启动/低流量展示、本人名次展示。
  - 周期封板（`period-finalize`）与历史榜单查询在赛果修正后的行为。
  - 群组机制：建群/加群/退群/群主解散、群上限与成员上限、群失效（解散/被移出）后群榜页的真实表现与防越权。

---

### S6：个人资料/主队/注销、分享卡、解锁记录与小程序体验闭环

- **覆盖范围**：`F07`、`F11`、`F12`、`Q3（页面边界）`、`Q4（解锁页）`
- **对照文档**：[MVP__v2.0.md](../MVP__v2.0.md)（§18、§19.3）、[MINIPROGRAM_UX_REQUIREMENTS__v1.0.md](../MINIPROGRAM_UX_REQUIREMENTS__v1.0.md)
- **代码范围**：
  - 后端：`src/application/profile.ts`、`src/application/profile-mutation.ts`、`src/application/share-card.ts`、`src/application/unlocks.ts`、`src/application/unlock-decision.ts`、`src/application/unlock-persistence.ts`、`src/api/v1/profile.ts`、`src/api/v1/share-card.ts`、`src/api/v1/unlocks.ts`
  - 小程序端：`miniprogram/pages/profile/*`、`miniprogram/pages/settings/*`、`miniprogram/pages/share-card/*`、`miniprogram/pages/unlocks/*`、`miniprogram/custom-tab-bar/*`、`miniprogram/services/profile.js`、`miniprogram/services/share-card.js`、`miniprogram/services/unlocks.js`、`miniprogram/utils/nickname.js`、`miniprogram/utils/ui-layout.js`
- **重点审查点**：
  - **公开主页隐私边界（P0）**：访问他人公开主页时，严禁返回其尚未过截止时间比赛的预测内容。
  - 资料编辑（昵称合规/长度校验、主队选择与切换）、账号注销完整链路（数据脱敏/清理、会话失效、榜单/群组残留处理、重新注册不串号）。
  - 分享卡：后端数据生成、前端页面渲染、真实微信分享参数（`onShareAppMessage` 等）及落地回流路径。
  - 解锁记录：30/100/200 生涯积分门槛触发、不因赛果修正回收、解锁记录页空态与不越界展示装扮能力。

---

### S7：休赛期、自动换季与联赛个人小结（首版门禁专项）

- **覆盖范围**：`F13`、`F14`、`B06`、`Q5（门禁）`、`Q8（收官口径）`
- **对照文档**：[SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md](../SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md)、[SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md](../SYNC_RELIABILITY_AND_OFFSEASON_DEV_PLAN__v1.0.md)、[PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md](../PERSONAL_LEAGUE_SUMMARY_DEV_PLAN__v1.0.md)、[OFFSEASON_OPERATIONS_CHECKLIST__v1.0.md](../OFFSEASON_OPERATIONS_CHECKLIST__v1.0.md)
- **代码范围**：
  - 领域与服务：`src/domain/league-season-status.ts`、`src/domain/league-season-summary.ts`、`src/application/league-season-maintenance.ts`、`src/application/league-season-validation.ts`、`src/application/league-status-service.ts`、`src/application/personal-league-summary-service.ts`
  - API 与小程序：`src/api/v1/league-seasons.ts`、`src/api/v1/league-status.ts`、`src/api/v1/personal-league-summary.ts`、`miniprogram/services/league-seasons.js`、`miniprogram/pages/matches/*`（休赛期分支与默认联赛切换）、`miniprogram/utils/matches-default-league.js`
- **重点审查点**：
  - **自动化程度核查（因 Q5 已定为首版门禁）**：逐项核对换季检测、跨季赛程拉取、升班马映射、收官判定是否已代码自动化，还是仍依赖人工操作清单；若存在半自动/手工缺口，按门禁缺陷记录。
  - 联赛赛季与平台等级赛季的严格隔离（两者不得混淆）。
  - 联赛收官后的个人小结：仅展示该联赛预测场次、赛果命中、精确命中，不与生涯/等级赛季积分混算；跨季空窗期和默认联赛/旧赛季榜展示逻辑。

---

### S8：管理运维（含管理 UI 核查）、VPS 生产部署与发布门禁

- **覆盖范围**：`B07`、`B08`、`Q2（VPS 首发）`、`Q3（管理 UI）`
- **对照文档**：[VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md](../VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN__v1.0.md)、[MVP__v2.0.md](../MVP__v2.0.md)（§38 环境隔离、管理员与审计）
- **代码范围**：
  - 管理后端与脚本：`src/api/v1/admin.ts`、`src/api/v1/admin-anomalies.ts`、`src/application/admin*.ts`、`scripts/vps-admin.mjs`
  - VPS 运行时与数据库：`src/runtime/vps-runtime.ts`、`src/runtime/application-runtime.ts`、`src/gateway/repository-factory.ts`、`src/infrastructure/postgres-schema.ts`、`src/infrastructure/postgres-document-db.ts`、`src/infrastructure/schema-migration.ts`、`src/infrastructure/environment-config.ts`、`src/schema/*`、`scripts/vps-db.mjs`、`scripts/deploy-preflight.mjs`
  - 运维与部署配置：`ops/vps/*`（`Caddyfile`、`football-api.service`、`football-jobs.service/.timer`、`football-periodic.service/.timer`、`football.env.example`、`README.md`）
- **重点审查点**：
  - **管理 UI 核查（P0 关注）**：用户已拍板首版包含管理 UI，需核实仓库中是否存在独立管理前端或小程序内管理页；若目前仅有后端 Admin API + `vps-admin.mjs` CLI，则明确记录为首版范围缺口（P0），并给出最小管理 UI 补齐范围建议。
  - 管理员权限校验、操作审计日志完整性（赛果修正、重结算、重建、异常处置、授权）。
  - PostgreSQL 连接池、事务边界、索引覆盖（`src/schema/indexes.ts` vs `postgres-schema.ts`）、Schema 迁移幂等性。
  - VPS 部署安全性与可靠性：systemd 重启策略、日志、环境变量校验、dev/test/prod 严格隔离（防测试连生产库）、Caddy HTTPS 与反代配置、健康检查接口。

---

## 4. 建议执行顺序（分 4 个波次）

按“先主干、后枝叶；先高危资金/账本/安全，后体验与运维”的顺序推进，每完成一个波次即可交付对应切片的 **表 A + 表 B**，你可以边审边裁决，无需等全部结束：

| 波次 | 包含切片 | 核心目的 |
|---|---|---|
| **Wave 1（主干与安全）** | **S1**（鉴权/网关） + **S4**（计分/结算/修正） | 最先锁定系统最核心的权限安全与积分账本正确性 |
| **Wave 2（核心交易与数据链）** | **S2**（赛程/预测/大家怎么选） + **S3**（同步/改期/调度） | 打通“数据进入 → 用户预测 → 完场触发结算”全链路 |
| **Wave 3（成长、社交与换季门禁）** | **S5**（等级/榜单/群组） + **S7**（休赛期/自动换季/小结） | 审查复杂聚合逻辑与刚定为门禁的自动换季闭环 |
| **Wave 4（用户外围与 VPS 上线门禁）** | **S6**（资料/注销/分享/解锁） + **S8**（管理 UI/VPS 部署） | 完成全量页面边界、管理能力与 VPS 生产发布前总检 |

---

## 5. 自动化验证基线（配合静态 Code Review 执行）

在静态代码审查的同时，每个波次/总检阶段需运行并记录以下实测证据（不采信旧文档里的历史结果）：

1. **类型与构建**：`npm run typecheck`、`npm run build`
2. **全量单元测试与契约测试**：`npm test`（关注是否有 skipped/弱断言测试，以及 PostgreSQL 集成测试 `*.pg.test.ts` 的实际覆盖与运行条件）
3. **资产与配置预检**：`npm run logos:check`、`npm run vps:preflight`
4. **端到端与真机验证清单**（作为 Review 之后的验收门禁，本阶段核对用例是否覆盖）：
   - 完整主链路：微信登录 → 看六联赛赛程 → 提交预测 → 杀进程重进回显 → 模拟完场结算 → 查看我的预测/个人资料/排行榜/解锁记录 → 赛果修正重结算。
   - VPS 实机验证：systemd 服务与 timer 触发、PostgreSQL 持久化重启恢复、Caddy HTTPS 访问。

---

## 6. 单切片审查报告标准模板（后续执行时复用）

每个切片输出固定结构，方便汇总与追踪：

```markdown
## 切片 Sx：<模块名称>

### 1. 审查结论摘要
- 总体风险评级：高 / 中 / 低
- 表 A 缺陷统计：P0 x 条 / P1 x 条 / P2 x 条
- 表 B 口径差异统计：x 条（待产品裁决）

### 2. 表 A：确定性工程与逻辑缺陷
| ID | 级别 | 位置 | 问题描述与复现路径 | 修复建议 |
|---|---|---|---|---|

### 3. 表 B：代码与文档口径差异（待拍板）
| ID | 代码位置 | 代码实际行为 | 文档原设定（含来源） | 产品裁决 |
|---|---|---|---|---|

### 4. 测试与验证覆盖缺口
- 列出当前缺少自动化测试保护的高风险分支
```

---

## 7. 下一步动作

计划确认后，建议按 **Wave 1（S1 + S4）** 启动第一轮 Code Review，输出第一批表 A 与表 B。你可以直接回复：
- **“按计划启动 Wave 1”**：我将开始审查 S1 和 S4 并生成首份审查报告；
- 或告知需要调整的优先级/切片顺序。
