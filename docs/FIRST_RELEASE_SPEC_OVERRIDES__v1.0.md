# 赛事预言家：首版现行口径变更与例外清单（v1.0 裁决版）

> 更新日期：2026-11-28（含 2026-11-28 账号注销前端口径修订）  
> 依据：[FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md](review/FIRST_RELEASE_CODE_REVIEW_PLAN__v1.0.md) §2.3  
> 统计（41 条去重表 B 差异，原 `D-S1-05` 已按 Q3 升级为 P0 `A-S6-02`）：
> - **✅ 已全部拍板完成**：**41 条**（其中 **33 条** 认代码纳入首版新口径，**8 条** 判为 Bug / 需求改造移入修复清单）
> - **⏳ 待产品拍板**：**0 条**

---

## 1. ⏳ 待产品拍板清单（已全部拍板完成，共 0 条）

| 编号 | 所在报告 | 待拍板问题与选项 |
|---|---|---|
| *(无)* | — | 全部 41 条口径差异已由产品拍板完毕。 |

---

## 2. ✅ 已裁决：判为 Bug 移入修复清单（共 4 条）

| 编号 | 所在报告 | 裁决结论与理由 |
|---|---|---|
| **D-S1-01** | [Wave 1](review/CODE_REVIEW_WAVE1_S1_S4__v1.0.md) | **改 SHA-256 摘要落库**：避免 DB 快照/只读泄漏直接暴露明文 `auth_sessions.token`，零 UX 影响、改造成本极低。 |
| **D-S1-03** | [Wave 1](review/CODE_REVIEW_WAVE1_S1_S4__v1.0.md) | **改 `200 + "已注销用户"` 脱敏展示**：与公开主页 `GET /v1/profiles/{user_id}` 及 MVP §24.3 保持一致，旧分享卡片点开不报错。 |
| **D-S1-06** | [Wave 1](review/CODE_REVIEW_WAVE1_S1_S4__v1.0.md) | **默认直接进比赛首页（游客优先）**：将 `pages/matches/matches` 设为第 0 号启动页，老用户自动恢复会话、新用户直接逛赛程，互动时再登录。 |
| **D-S2-04** | [Wave 2](review/CODE_REVIEW_WAVE2_S2_S3__v1.0.md) | **首页补齐“已截止未开球”大家怎么选入口 + 日期条往前扩展 11 天**：已过截止时间但未开球的比赛卡片也展示“大家怎么选 ›”；首页日期条支持往前选择 11 天。 |
| **D-S4-06** | [Wave 1](review/CODE_REVIEW_WAVE1_S1_S4__v1.0.md) | **每日一致性差异同步写非阻塞 `anomalies`**：配合 Q3 管理 UI，让运营在异常列表直接可见对账差异，避免只藏在 VPS 日志里。 |
| **D-S5-03** | [Wave 3](review/CODE_REVIEW_WAVE3_S5_S7__v1.0.md) | **周榜历史周文案去掉“已封榜”，改为“历史周”**：遵守 `MVP__v2.0.md` §19.10.3，避免晚场未结或赛果修正时误导用户。 |
| **D-S5-04** | [Wave 3](review/CODE_REVIEW_WAVE3_S5_S7__v1.0.md) | **游客态补灰色条纹模糊占位并隐藏顶部 Tab**：按 `MVP__v2.0.md` §19.10.9 渲染 `guestBars` 骨架模糊占位，居中显示“请登录查看榜单”。 |
| **D-S6-01** | [Wave 4](review/CODE_REVIEW_WAVE4_S6_S8__v1.0.md) | **分享卡群聊照抄改造**：1）以 `已结算场次 > 3` 为界：≤ 3 场顶部仅显身份与等级/生涯总积分、转发标题为“晒出了{联赛}第{X}轮预测”；> 3 场顶部显完整汇总、转发标题为“{联赛}第{X}轮战绩：已拿 {N} 分”，并去掉“还有 X 场未结算”提示；2）下方全程展示**单场预测真实明细**（已结算不标状态，进行中/结算中标 `未完赛`，未开赛未截止标 `未开赛` 并支持跳转跟单，已截止标 `已截止`，延期/取消/腰斩按实标注）；3）分享链接附 HMAC `share_token` 防陌生人无授权扒取未截止预测；4）页面背景图改为与首页一致的 `/assets/images/baseline-pitch.webp`。 |
| **D-S7-02** | [Wave 3](review/CODE_REVIEW_WAVE3_S5_S7__v1.0.md) | **`FootballDataAdapter` 补 `REGULAR_SEASON` 阶段过滤**（同修 `A-S7-02`）：防止德甲/法甲升降级附加赛第 19 队污染 `season_teams` 永久卡死自动收官。 |

> 另注（2026-11-28 产品拍板变更）：原 Wave 1 **`D-S1-05`**（小程序端缺失账号注销入口）曾于 2026-11-24 按 `Q3` 升级为 `A-S6-02（P0）`；**2026-11-28 产品最终拍板改按方案 B 执行：首版小程序前端移除账号注销入口及所有面向用户的「注销」界面文案**（前端统一以「当前账号不可用」「仅保留历史公开统计」「历史用户」「该用户暂不可用」「当前不可预测」等中性文案呈现，并保留 `409 USER_DELETED` / `isDeleted` 状态机保护逻辑）；**后端 `DELETE /v1/profile/me` 接口与注销联动能力保持保留**，供后续版本或后台运维使用。

---

## 3. ✅ 已裁决：认代码并纳入首版新口径（共 29 条）

### 3.1 认证、网关与存储基础（S1 / S4 / S8）
- **`D-S1-02`**：VPS 首版限定单 API 进程，保留 `InMemoryRateLimiter`（覆盖 PG 限流表设想，符合 `VPS_SELF_HOSTED_DEPLOYMENT_DEV_PLAN` §286）。
- **`D-S1-04`**：保留 `POST /v1/profile/me` 作为 `PATCH /v1/profile/me` 兼容别名（适配小程序 `wx.request`）。
- **`D-S4-01`**：修正重评与重建回放统一按 `MVP__v2.0.md` §17.9.2 + `is_level_frozen !== true` 执行（同步修复 `A-S4-05`）。
- **`D-S4-02`**：确认 `settlements` / `matches` / `predictions` / `match_results` 扩展字段与索引（`level_reeval_*`、`canonical_match_id`、`superseded_by`、`result_provider`、`compared_providers`）。
- **`D-S4-03`**：接受 `FirstSettlementService` 抛异常 vs `Retry`/`Correction` 返回 `{ kind: "failed" }` 的内部契约。
- **`D-S4-04`**：任务锁租约统一采用系统墙钟 `Math.max(serverNow, Date.now())`（同步修 `A-S4-08` 对齐剩余 5 处）。
- **`D-S4-05`**：周榜重建保留历史行（不物理删除，仅修 `A-S4-04` 消除注销清零崩溃）；已注销与已冻结赛季重建不回放等级。
- **`D-S8-01`**：`admin-retry-settlement` 允许通过 `jobLocks` 接管无锁的僵死 `status=running` 结算（优于原 §30.4 硬返 409）。
- **`D-S8-02`**：确认 `rebuild_user_stats` / `rebuild_rankings` 现行审计日志扩展快照字段（`season_stats`、`board` 等）。
- **`D-S8-03`**：确认 `AnomalyType` 13 项枚举（含 3 项 `DIAG_*` 诊断异常，同步补 `A-S8-03` 管理员 resolve 接口）。
- **`D-S8-04`**：确认通过 `scripts/vps-admin.mjs` 管理管理员授权及 VPS 双 timer（`realtime 3m` + `periodic 15m`），收口时更新 `ops/vps/README.md`。

### 3.2 赛程、预测、数据同步与调度（S2 / S3）
- **`D-S2-01`**：`GET /v1/matches` 列表与详情扩展返回 `settlement_status`、`my_prediction`、`is_prediction_closed`。
- **`D-S2-02`**：`GET /v1/predictions/me` 增返 `home_team`/`away_team` 并开放查询全部已接入历史赛季（按 UX DATA-01）。
- **`D-S2-03`**：未知球队缺少中文映射时，回退显示上游英文原名（不显示“球队资料待补全”），保障用户可识别对阵。
- **`D-S2-05`**：我的预测保留“首屏 20 条 + 按钮加载更多”，撤销“8 周自动续翻”（按 2026-11-18 UX 决定）。
- **`D-S2-06`**：延期/取消/腰斩（`unavailable`）时前端隐藏“大家怎么选”卡片。
- **`D-S3-01`（Q7 核心）**：首版 VPS 线上全开 5 个数据源（`FOOTBALL_PROVIDER_SOURCES=fd,5d,of,bsd,sp`），中超夜间对账继续使用 `sp`，并同步更新 `ops/vps/football.env.example` 默认值。
- **`D-S3-02`**：中超跨源开球容差定为 **90 分钟**（兼容 `openfoot` 夏令时偏移），其余联赛 30 分钟。
- **`D-S3-03`**：`fd` 按北京时间零点切日桶，并保持各源实况最小节流间隔（`bsd/sp` 2m、`5d` 3m、`fd/of` 5m）。
- **`D-S3-04`**：首版非权威双源互证保持仅支持五大联赛 `5d + of`。
- **`D-S3-05`**：换季采用纯 UTC 日期自动推导（不建外部手工覆盖开关，同步通过 `A-S7-01` 补相邻季赛程探测）。
- **`D-S3-06`**：`sync_logs` 留存周期统一为 **60 天**（覆盖原 §37 30 天）。
- **`D-S3-07`**：确认 VPS `realtime(3m)` + `periodic(15m)` 拆分、高频任务共用 `sync_logs` 与跨 tick `deferred` 持久化退避。
- **`D-S3-08`**：确认 `post_finish_verify` 定量 `105m` 兜底入窗与 `24h` 后转每日复核。

### 3.3 成长等级、排行榜、解锁与休赛期收官（S5 / S6 / S7）
- **`D-S5-01`（Q8 首次排行周）**：确认 `FOOTBALL_RANKING_FIRST_PERIOD_KEY`（prod 必填、dev 默认 `"2026-W31"`）、每次返 `first_period_key`/`server_now` 及上线前默认周榜返 `200` 空列表契约。
- **`D-S5-02`**：确认 `GET /v1/levels/me` 返回 `b_points`/`season_points`/`exact_hits` 及前端“评估积分 X/Y、还差 Z 分”进度条（以 UX-06 覆盖 MVP §19.8/§28.1）。
- **`D-S5-05`**：确认排行榜顶部 Tab 顺序为 `本周榜 → 赛季榜 → 实力榜 → 生涯榜`（点击进公开主页另按 P0 `A-S6-01` 修复）。
- **`D-S5-06`**：历史周按 `periodEndAt <= server_now` 生效（不等 `is_final`）；`me` 增返各榜指标；复用 `RANKING_TOP_LIMIT = 20`。
- **`D-S1-05`（2026-11-28 产品拍板修订）**：首版小程序前端移除账号注销入口与面向用户的「注销」界面文案（含公开主页、分享卡及各页 `USER_DELETED` 兜底提示均改用中性文案，保留前端状态机保护）；后端 `DELETE /v1/profile/me` 接口及会话吊销/群组/榜单注销联动能力保留，供后续版本或后台运维使用。
- **`D-S6-02`（Q4 解锁页）**：确认小程序保留解锁记录页并消费 `/v1/unlocks/me`（使用现行 3 项中文名与 UI-02 空态，不引入装扮穿戴能力）。
- **`D-S7-01`（Q8 收官口径）**：确认 `LeagueSeason` / `leagues/status` / `predictions/summary` 三层收官字段契约，且收官重开时 `schedule_status` 保持 `"locked"`、仅 `completion_status` 回退 `"open"`。
- **`D-S7-03`**：休赛期主卡片以公开 `GET /v1/leagues/status` 的 `completed`/`between_seasons` 为主态（保障游客可见，另修 `A-S7-06` 游客小结态）。
- **`D-S7-04`**：收口时同步更新滞后的 `docs/OFFSEASON_OPERATIONS_CHECKLIST__v1.0.md`。
