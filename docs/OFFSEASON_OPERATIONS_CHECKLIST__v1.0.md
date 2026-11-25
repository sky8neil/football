# 换季运维清单 v1.0

> 最近更新：2026-11-24（同步 R4/R6/S7 收官门禁与 Q-PLAN-2 零重发换季闭环）
> 依据需求：[SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md](./SYNC_RELIABILITY_AND_OFFSEASON_REQUIREMENTS__v1.0.md)、[PRE_LAUNCH_FIX_DEV_PLAN__v4.0.md](./PRE_LAUNCH_FIX_DEV_PLAN__v4.0.md)
> 适用场景：中超每年 12 月末–次年 2 月底、五大联赛每年 6 月中下旬–7 月中旬，新赛季赛程公布后执行

---

## 0. 一句话版本

R4（自动换季）与 Q-PLAN-2（服务端下发升班马 `name_zh`/`logo_url`）落地后，正常换季**无需改代码重发后端或小程序**；运维按顺序做 4 件事：**确认自动换季与跨季探测正常 → 用 `providers:map-teams --apply` 一键补齐升班马副源映射与中文名/队徽 → 确认无未解除阻塞异常 → 验证副源角色与收官状态**。

---

## 1. 确认赛季推导与跨季赛程探测（R4 已实现）

✅ **现状**：R4（赛季自动切换与跨季探测）已实现，**不再需要在每次换季前手动修改 `SUPPORTED_LEAGUES` 硬编码常量并重新发版**。

1. `src/domain/config.ts` 的 `activeLeagueSeason(league, now)` 按 UTC 时间自动推导当前赛季：
   - 五大联赛（跨年 `YYYY_YYYY+1`）：每年 UTC 7/1 00:00 自动从 `(year-1)_year` 推进到 `year_(year+1)`；
   - 中超（自然年 `YYYY`）：每年 UTC 1/1 00:00 自动推进到 `year`。
2. `ProviderFullScheduleVerifyService` 与 `ProviderFutureScheduleService`（`resolveRolloverTargetSeasons`）已支持过渡窗口双季探测：
   - **提前探测新赛季（`nextSeason`）**：五大联赛每年 6 月（`UTC month === 5`）、中超每年 12 月（`UTC month === 11`）同时探测 `nextSeason` 球队与赛程，新赛季一公布即可建档并激活首页 `between_seasons` 倒计时；
   - **旧季补赛保护（`previousSeason`）**：每年 7 月（五大联赛）与 1 月（中超）若上赛季 `league_seasons.completion_status !== "completed"`，继续同步 `previousSeason` 补赛。
3. **常规赛阶段过滤（`A-S7-02` / `D-S7-02`）**：`FootballDataAdapter`（`stage=REGULAR_SEASON`）与 `BsdAdapter`（`stage="regular-season"`）已过滤 `RELEGATION`/`PLAYOFFS` 附加赛场次，避免降级区次级联赛球队污染 `season_teams` 或阻塞 34 轮/306 场德甲/法甲自动收官。

巡检检查项：
- 确认日志中无 `DIAG_PROVIDER_NO_DATA`（若出现且新季尚未开赛，核对上游赛季是否已公布；若已开赛则检查 Provider ref override 环境变量）。

---

## 2. 确认主源自动建队与非阻塞异常告警（`ProviderTeamSyncService`）

主渠道（`fd` / `bsd`）在 `full_schedule_verify` 与 `future_schedule` 同步时会自动通过 `ProviderTeamSyncService.sync` 完成：
1. 为升班马自动创建 `teams`、`team_provider_mappings` 与对应赛季的 `season_teams`（含跨季探测发现的新赛季球队）；
2. 若升班马尚未配置 `name_zh`，会同步写入一条 `blocking: false` 的非阻塞持久化异常（`PROVIDER_DATA_INVALID`，`details.reason = "team_name_zh_missing"`）提醒运营补全，**不会阻塞建队、赛程同步或比赛列表展示**；
3. 更新或重跑同步时**绝不覆盖**人工已维护的 `teams.name_zh` 与 `teams.logo_url`。

触发一轮受控同步排查命令（VPS 侧）：
```bash
cd /home/apps/football_dev   # VPS 上的部署目录
node dist/jobs/tick.js --mode=periodic
```

---

## 3. 处理升班马副源映射与中文名/队徽入库（`providers:map-teams --apply` + `Q-PLAN-2`）

### 3.1 告警来源
1. 服务端日志 `[team_mapping_missing]` 及 `anomalies` 表内 `blocking: false` 持久化告警：
   - 副源缺映射：`details = { entity_type: "team", reason: "team_mapping_missing", provider, provider_team_id, league_id, provider_name }`（同一 `(provider, provider_team_id)` 自动去重更新同一条记录）；
   - 新队缺中文名：`details = { entity_type: "team", reason: "team_name_zh_missing", team_id, league_id, team_name }`。
2. 也可先用离线只读报告模式核对候选：
   ```bash
   npm run providers:map-teams -- --input ./teams-and-provider-samples.json > map-report.json
   ```

| 报告 `status` | 含义 | 处理 |
|---|---|---|
| `confirmed` | 已确认映射（`confirmed_mappings` 命中或 `confirmed_team_id` 指定） | 可直接 `--apply` 入库 |
| `review` | 仅凭名称唯一匹配，需人工确认 | 核对后写入 `confirmed_mappings` |
| `ambiguous` | 同名多支本地球队 | 人工确认后指定唯一 `team_id` |
| `unmatched` | 本地尚无同名候选 | 确认主源已建队或补齐映射规则 |

### 3.2 一键落库命令（`--apply`）
✅ `scripts/providers-map-teams.mjs` 现已支持在保留只读 JSON 报告模式的同时，使用 `--apply` 将确认后的映射及升班马资料一键写入数据库并自动收敛对应告警：

```bash
npm run build
FOOTBALL_DATABASE_URL="postgres://..." \
FOOTBALL_DATABASE_SCHEMA="public" \
FOOTBALL_RESOURCE_NAMESPACE="ft_prod" \
npm run providers:map-teams -- --input ./rollover-apply.json --apply
```

`rollover-apply.json` 格式示例：
```json
{
  "local_teams": [{ "team_id": "<uuid>", "league_id": "premier_league", "name": "Leeds United FC" }],
  "provider_teams": [{ "provider": "openfoot", "provider_team_id": "63", "league_id": "premier_league", "name": "Leeds United" }],
  "confirmed_mappings": [
    { "provider": "openfoot", "provider_team_id": "63", "team_id": "<uuid>" }
  ],
  "team_updates": [
    { "team_id": "<uuid>", "name_zh": "利兹联", "logo_url": "https://cdn.example.com/logos/leeds.png" }
  ]
}
```
> 注：若需重绑已有 `(provider, provider_team_id)` 映射，追加 `--overwrite-mappings`；`logo_url` 仅允许 `https://...` 或 `/` 相对路径，提交前脚本会自动校验并在入库后自动 resolve 对应的 `team_mapping_missing` 与 `team_name_zh_missing` 告警。

### 3.3 小程序端零重发生效机制（`Q-PLAN-2`）
- `/v1/matches` 与 `/v1/predictions/me` 均会在 `home_team` / `away_team` 下发 `name_zh`（`string | null`）与 `logo_url`（`string | null`）；
- 小程序 `miniprogram/utils/team-presentation.js` 按如下优先级渲染，**无需等待重发审核小程序**：
  - **中文名**：服务端下发 `team.name_zh` > 本地 `team-registry.js` > 服务端原名 `team.name` > `"球队资料待补全"`；
  - **队徽**：优先使用小程序包内 114 张离线 PNG 缓存（若命中），未命中本地缓存时使用服务端下发 `team.logo_url`（仅接受 `https://` 或 `/` 相对路径），均无时兜底默认占位图。
- 如后续方便顺带把新队高清静态 PNG 打进包内（非紧急阻断），可按常规流程更新 `miniprogram/assets/logos/` 与 `logo-registry.js` 并跑 `npm run logos:check`。

---

## 4. 验证副源角色（R6 已在中超启用）

✅ **现状**：`src/provider/sources.ts` 中中超（`chinese_super_league`）在 `of` 下的角色**已启用**为：
- `schedule: "historical"`、`result: "secondary"`、`reconcile: "historical"`
- `sp` 作为中超 `live: "fallback"`、`result: "fallback"`、`reconcile: "reconcile"`。
- 五大联赛在 `of` 下保持 `result: "secondary"`、`reconcile: "reconcile"`（`5d` 为 `live: "primary"`、`result: "secondary"`）。

因此中超及五大联赛换季期间均需确保升班马在 `of`（及中超 `sp`）上的 `team_provider_mappings` 已及时通过步骤 3 补齐，避免 `ensureCrossSourceMatchMapping` 因缺失队映射跳过双源结果交叉核对（`anomalies` 表中对应 `team_mapping_missing` 告警应全部清零/resolved）。

---

## 5. 换季检查表（可打印）

| # | 检查项 | 命令 / 位置 | 通过标准 |
|---|---|---|---|
| 1 | 自动换季与跨季探测 | `activeLeagueSeason` / `resolveRolloverTargetSeasons` | 6 月/12 月成功探测新季，7 月/1 月未收官旧季补赛仍可同步，无 `DIAG_PROVIDER_NO_DATA` |
| 2 | 附加赛过滤正常 | `FootballDataAdapter` / `BsdAdapter` | `RELEGATION`/`PLAYOFFS` 不入 `season_teams`，常规赛球队数准确（德甲 18/英超 20/中超 16） |
| 3 | 新赛季球队已入库 | `teams` / `season_teams` / `team_provider_mappings` | 主源球队与参赛名单数量与联赛实际队数一致 |
| 4 | 升班马映射与中文名/队徽已落库 | `npm run providers:map-teams -- --input ... --apply` | 副源 `of`/`5d`/`sp` 映射补齐，升班马 `name_zh` 与合法 `logo_url` 已写入且生效 |
| 5 | 团队类告警清零 | `anomalies` / 日志 `[team_mapping_missing]` | `team_mapping_missing` 与 `team_name_zh_missing` 均已 resolved |
| 6 | 收官门禁状态正确 | `league_seasons` / `GET /v1/leagues/status` | 未收官或存在 `abandoned`/无比分 `finished` 保持 `open`；收官后 `ended_at` 已准确填充 |
| 7 | 小程序零重发验收 | 小程序真机 / 开发者工具 | 升班马直接展示服务端中文名与高清队徽，旧队保留本地离线 PNG 极速加载 |
| 8 | 离线静态资源校验（如有新增包内 PNG） | `npm run logos:check` | 校验全部通过 |

---

## 6. 时间窗口

| 联赛 | 赛程公布（探测窗口） | 换季执行 | 新赛季开赛 / 自动切换 |
|---|---|---|---|
| 中超 | 12 月–2 月（12 月自动开始 `nextSeason` 探测） | 赛程公布后跑通步骤 2–5（无需改代码发版） | 1/1 自动推进自然年赛季；3 月上旬开赛 |
| 五大联赛 | 6 月中下旬（6 月自动开始 `nextSeason` 探测） | 6 月底–7 月中旬跑通步骤 2–5（无需改代码发版） | 7/1 自动推进跨年赛季；8 月中旬开赛 |
