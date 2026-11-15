# 换季运维清单 v1.0

> 创建日期：2026-11-15
> 依据需求：[SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md](./SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md) 的 R5 第 2 条、R6
> 适用场景：中超每年 2 月底、五大联赛每年 7 月中旬，新赛季赛程公布后执行

---

## 0. 一句话版本

每个换季窗口按顺序做 5 件事：**确认赛季标识 → 跑一轮全量赛程同步 → 核对球队映射 → 补小程序队徽 → 验证副源角色**。

---

## 1. 确认赛季标识（当前仍为硬编码）

⚠️ **现状**：`src/domain/config.ts` 的 `SUPPORTED_LEAGUES` 里赛季写死为：
- 五大联赛：`season_id = "2026_2027"`、`provider_season_refs.of = "2026/27"`
- 中超：`season_id = "2026"`（跨自然年）

R4（赛季自动切换）**尚未实现**，因此每次换季仍需人工改代码并重新构建发布。

操作：
1. 打开 `src/domain/config.ts`，按联赛更新 `season_id`、`api_football_season`、`provider_season_refs`、`source_season_ref`。
2. `npm run typecheck && npm run build`。
3. VPS 侧重启 `football-gateway.service` / `football-gateway-bridge.service` 并确认作业进程已加载新构建。

> R4 落地后本节应改为"确认 `activeLeagueSeason()` 解析结果"，届时同步更新本文档。

---

## 2. 跑一轮全量赛程同步（让主源建出新赛季球队）

主渠道（`fd`）的 `full_schedule_verify` 会通过 `ProviderTeamSyncService` 自动为新赛季球队
创建 `teams` 记录与 `team_provider_mappings` 映射。

操作：
```bash
cd /home/apps/football_dev   # VPS 上的部署目录
node dist/jobs/tick.js       # 受控触发一轮调度
```
确认日志中没有 `DIAG_PROVIDER_NO_DATA`（该诊断通常意味着赛季参数已过期）。

---

## 3. 核对球队映射（重点：升班马）

`providers:map-teams` 是**离线比对报告工具**，只输出 JSON 报告，**不写数据库**：

```bash
npm run providers:map-teams -- --input ./teams-and-provider-samples.json > map-report.json
```

输入格式（脚本 `scripts/providers-map-teams.mjs` 头部有完整说明）：
```json
{
  "local_teams": [{ "team_id": "...", "league_id": "premier_league", "name": "Arsenal" }],
  "provider_teams": [{ "provider": "football_data", "provider_team_id": "57", "league_id": "premier_league", "name": "Arsenal FC" }],
  "confirmed_mappings": [{ "provider": "football_data", "provider_team_id": "57", "team_id": "..." }]
}
```

报告里每个球队的 `status`：
| status | 含义 | 处理 |
|---|---|---|
| `confirmed` | 已确认映射（`confirmed_mappings` 命中或 `confirmed_team_id` 指定） | 无需操作 |
| `review` | 仅凭名称唯一匹配，需人工确认 | 人工核对后确认 |
| `ambiguous` | 同名多支本地球队 | 必须人工指定 `team_id` |
| `unmatched` | 本地球队里没有任何同名候选 | **升班马典型状态**，需先建本地球队 |

同时看代码侧告警（R5 已实现）：日志中 `[team_mapping_missing]` 会给出
`league_id` / `provider` / `provider_team_id` / `team_name` / `side`，
据此列出需要补映射的球队清单。同一支球队在进程生命周期内只告警一次，不会刷屏。

---

## 4. 补齐小程序静态队徽

队徽是**静态资源映射**，不随数据库自动更新：

1. 把新球队队徽图片放进 `miniprogram/assets/images/teams/`（沿用现有命名规范）。
2. 在 `miniprogram/utils/logo-registry.js` 的 `MANIFEST` 中登记 `league_id → team 名称 → 文件`；
   若供应商队名与本地球队名不一致，在 `TEAM_ALIASES` 里补别名。
3. 本地校验：`npm run logos:check`。
4. 未登记的球队会落到 `PLACEHOLDER` 占位图，不会报错，但界面显示为默认队徽。

---

## 5. 验证副源（`of`）在目标联赛的角色

`sources.ts` 中每个联赛在 `of` 下的五个角色：`schedule` / `kickoff` / `live` / `result` / `reconcile`。

- 五大联赛现状：`result = "secondary"`、`reconcile = "reconcile"`（即 `of` 参与赛果交叉核对与对账）。
- 中超现状：`schedule = "historical"`、`result = "disabled"`、`reconcile = "historical"`
  —— **中超目前没有第二赛果核对源**，只依赖 `bsd` 单源。

R6（中超 `of` 第二核对源）尚未启用，前置条件是：
1. 确认 `openfoot` 已收录 16 支中超球队，并完成 `team_provider_mappings` 的 16 队映射；
2. 把 `sources.ts` 里中超的 `result` 角色从 `disabled` 改为 `secondary`；
3. 用 `[team_mapping_missing]` 告警确认干跑期间没有漏映射；
4. 重启服务后观察 `provider_reconcile` 是否正常产出交叉核对结果。

> 在映射未补齐前**不要**先开 `result = secondary`：交叉核对会大面积静默跳过，等于没有第二源。

---

## 6. 换季检查表（可打印）

| # | 检查项 | 命令 / 位置 | 通过标准 |
|---|---|---|---|
| 1 | 赛季标识已更新 | `src/domain/config.ts` | 五个联赛的 `season_id` 与 `provider_season_refs` 均为新赛季 |
| 2 | 构建与类型检查 | `npm run typecheck && npm run build` | 均无错误 |
| 3 | 全量赛程同步跑通 | `node dist/jobs/tick.js` | 无 `DIAG_PROVIDER_NO_DATA` |
| 4 | 新赛季球队已入库 | `teams` / `team_provider_mappings` | 数量与联赛实际队数一致 |
| 5 | 升班马映射已确认 | `npm run providers:map-teams -- --input ...` | 无 `unmatched`，`review`/`ambiguous` 已人工处理 |
| 6 | 无未映射告警 | 服务日志 | 无 `[team_mapping_missing]` |
| 7 | 小程序队徽齐全 | `npm run logos:check` + `logo-registry.js` | 新球队均有队徽，无占位图 |
| 8 | 副源角色符合预期 | `src/provider/sources.ts` | 五大联赛 `result=secondary`；中超按 R6 进度确认 |
| 9 | 首页默认联赛正确 | 小程序实机 | 休赛期联赛带"休赛"角标，默认落在有赛程的联赛 |

---

## 7. 时间窗口

| 联赛 | 赛程公布 | 换季执行 | 新赛季开赛 |
|---|---|---|---|
| 中超 | 约 2 月下旬 | 2 月底前完成第 1–8 项 | 3 月上旬 |
| 五大联赛 | 约 6 月中下旬 | 7 月中旬前完成第 1–8 项 | 8 月中旬 |
