# 成长体系阈值 v3 升级建议

> 状态：**分析稿 / 不可作为编码规范**。本文只对照产品新方案与现行冻结规范，给出落地建议。  
> 对照对象：  
> - **A** = `docs/MVP__v1.0.md`（FROZEN，业务规则唯一来源，含 §48 / §49 / §50）  
> - **B** = 成长体系阈值 v3（`/tmp/level-v3-thresholds.md`，仓库外；关键定义已内联于本文附录）  
> - 冲突时分析以 **A 为准**；结论如实写出 B 要 A 改什么。  
> - 本文不修改 A，不改代码，不 commit。

---

## 1. 摘要

**一句话结论：** B 不是在 A 的「胜平负准确率 + 样本量上限」上调阈值，而是用「收缩场均分（A 线）∧ 累计有效积分（B 线）+ 六级 + 周结算滞后」整套替换 §17，与 A 的双 scope、八级枚举、每场即时重算、`calculate_level(scope, valid_predictions, wdl_hits)` 不可并存。

| 项 | 值 |
|---|---|
| 硬冲突（阻断，规则不可并存） | **13** |
| 需产品澄清后才能写进规范的点 | **12** |
| 推荐落地形态 | **新增大版本规范（建议 `MVP__v2.0.md`）+ 新 `level_rule_version = level_v3`**；不要在 `MVP__v1.0.md` 原地改写 §17 / §47 |
| 最大风险 | 历史 `career_level` / `best_level`（1..8）与 `level_history` 语义切断；周结算与「每场结算即时改等级」双轨并行时一致性校验会误报 |

A 中**不存在**「官方精选池」。B 相对 v2「取消精选池」对 A 不是冲突，只是产品叙事；A 的 MVP 联赛仍是英超单联赛（§1.4），挑场风险本来就在（空关不扣分，§9 / §18 均无惩罚）。

---

## 2. 冲突清单

按严重度排序。每条给出 A 条款、B 章节、为何不可并存。

### 2.1 阻断（规则不可并存）

#### C1. 等级枚举：八级 vs 六级，称号错位

| | |
|---|---|
| **A** | §17.1：`1 青训新人 … 8 足坛巨星`。§21.1 / §21.2 / §21.13：`career_level` / `level` / `from_level` / `to_level` 均为 `int 1..8`。§1.2 第 20–22 项要求本赛季等级、生涯等级、等级样本保护。 |
| **B** | 第三章六级表：`1 青训新人 / 2 初出茅庐 / 3 潜力新星 / 4 稳定主力 / 5 中场核心 / 6 足坛巨星`。 |
| **不可并存** | 同一字段不能既是 1..8 又是 1..6。Lv4–6 称号与 A 的「崭露头角 / 坐稳主力 / 球队核心 / 顶级球星 / 足坛巨星」错位：B 的「足坛巨星」= Lv6，A 的「足坛巨星」= Lv8。历史 `best_level=7/8` 在 B 中无合法值。 |
| **严重级别** | 阻断 |

#### C2. 能力线：胜平负真实准确率 vs 收缩场均分

| | |
|---|---|
| **A** | §17.2：理论等级只看 `wdl_hits / valid_predictions`，整数交叉乘法，禁止用四舍五入显示值。§16.3：事实准确率 = `wdl_hits / valid_predictions`；「等级、排名比较均不得先四舍五入」。§47：「等级：胜平负真实准确率 + 样本量上限」。 |
| **B** | 第一、二章：能力线是收缩场均分 `s = (S + 40 × 1.7) / (n + 40)`，S 为窗口内预测分总和。明确「用场均分而不是胜平负命中率」。 |
| **不可并存** | 同一用户同一批结算事实会算出不同等级。例：全猜对胜平负但零精确 → A 可走高准确率档；B 的场均分上限约 3.0，精确贡献进不来则过不了高档 A 线。 |
| **严重级别** | 阻断 |

#### C3. 参与线：样本量上限 vs 累计有效积分

| | |
|---|---|
| **A** | §17.3 赛季样本上限、§17.4 生涯样本上限，按 **有效预测场次** 封顶（生涯 `<20 => 1`，`>=400 => 8`）。这是「样本保护」，场次不够不许戴高帽。 |
| **B** | 第一章 B 线 = **累计有效积分**（Lv3≥80 / Lv4≥170 / Lv5≥380 / Lv6≥630）。友谊赛只加生涯积分、不计入 B。参考场次只是说明，不是门槛。 |
| **不可并存** | A 的参与门槛是场次，B 的参与门槛是分数。准的人 B 线更快过（B 原文意图）；在 A 里准不准都不改变样本上限。 |
| **严重级别** | 阻断 |

#### C4. 合成公式：`min(准确率档, 样本档)` vs「A∧B 同时满足」

| | |
|---|---|
| **A** | §17.5：`final_level = min(accuracy_level, sample_size_level)`。 |
| **B** | 第一章：「A、B 必须同时满足才能升级」；第五章：一次只升一级；降级只看 A 保级线，B 不导致降级。 |
| **不可并存** | A 的 min() 允许一次跳多档（例如生涯样本从 39→40 且准确率已 ≥70%，可从 2 直接到更高档，受样本档步进限制但准确率档可跨）。B 强制逐步 + 双条件。保级线、滞后降级在 A 中不存在。 |
| **严重级别** | 阻断 |

#### C5. 计算范围：season/career 双 scope vs 滚动窗口 + 永久 B 线

| | |
|---|---|
| **A** | §16.1 career 缓存含 `career_level` / `career_best_level`；§16.2 `user_season_stats.level` / `best_level`；§17 全部函数带 `scope`；§28.1 同时返回 season 与 career；§20 分享卡要「本赛季等级」。 |
| **B** | 窗口 = 最近 300 场有效预测，时间上限 24 个月；B 线永久累计。全文不定义 season 等级，也不定义 career 等级作为两个独立结果。 |
| **不可并存** | A 的 `calculate_level(scope, …)` 与 B 的单套「当前等级」不是同一对象。若只改生涯、保留赛季仍走 §17，则两套规则并存，产品未授权。 |
| **严重级别** | 阻断（若产品坚持双展示，则降为「需澄清」并变成两套实现；见 §6 Q1） |

#### C6. 重算触发：每场即时 vs 每周一次

| | |
|---|---|
| **A** | §17.6：「每场首次结算、赛果修正、人工 rebuild 后重算。当前等级：可以升。可以降。」 |
| **B** | 第五章：每周结算一次（周一凌晨）；升级需 A、B 同时满足，一次只升一级；降级要 A 连续 2 个结算周期低于保级线。 |
| **不可并存** | 同一场结算在 A 立刻改 `career_level`，在 B 只更新窗口统计、等到周一。daily consistency（§34.4 / §49.5）若仍按 A 的即时公式对账，周中必然误报。 |
| **严重级别** | 阻断 |

#### C7. 降级地板与保护期

| | |
|---|---|
| **A** | §17.6 可降，无地板；样本为 0 时最终为 1（§17.2）。§44 L97：correction 后 current level 可以下降。无「上线后 3 个月只升不降」。 |
| **B** | Lv1–2 不降级；最低降回 Lv2；上线后前 3 个月只升不降；巨星掉级保留「前巨星」隐藏标记。 |
| **不可并存** | A 允许 8→1；B 不允许低于 2（Lv1 仅「未评级」）。保护期与 L97 直接打架。 |
| **严重级别** | 阻断 |

#### C8. §0.4 唯一实现入口签名

| | |
|---|---|
| **A** | §0.4 冻结：`calculate_level(scope, valid_predictions, wdl_hits)`。其它模块只能调用，不得复制公式。现行实现：`src/domain/levels.ts` 的 `calculateLevel`。 |
| **B** | 需要窗口内 `(S, n)`、收缩先验、B 线累计有效积分、当前等级、连续低于保级线的周期数、是否在保护期。签名完全不同。 |
| **不可并存** | 保留旧签名无法表达 B；改签名等于改冻结入口。必须新版本函数，并改所有调用方（见 §3.7）。 |
| **严重级别** | 阻断 |

#### C9. Schema 取值域与 `level_history` 快照

| | |
|---|---|
| **A** | §21.1 `career_level` / `career_best_level` `int 1..8`；§21.2 `level` / `best_level` `1..8`；§21.13 `from_level` / `to_level` `1..8`，快照字段只有 `wdl_hits` + `valid_predictions`；`reason ∈ {settlement, correction, rebuild, season_start}`。 |
| **B** | 等级 1..6；定级事实是 `s`、窗口 n、B 积分，不是 WDL 比。周结算 / 保护期结束 / 连续保级失败都不是现有 reason。 |
| **不可并存** | 用旧 history 行无法复现 B 的定级决策；新 reason 不在冻结枚举里（§17.7「自由文本不得作为 reason 枚举」）。 |
| **严重级别** | 阻断 |

#### C10. API 合同（1..8 + 准确率驱动）

| | |
|---|---|
| **A** | §24.2 `career_level` 示例为 6（八级体系下的「球队核心」）；§28.1 返回 season/career 的 `valid_predictions / wdl_hits / wdl_accuracy_percent / level / best_level`；§29.1 `season_level`；OpenAPI `minimum: 1, maximum: 8`（`src/api/v1/openapi.yaml`）。§0.2 禁止自行改变 API 字段名、字段语义。 |
| **B** | 资料页不显示「差 0.05 分」，进度用「再完成 X 场有效预测后重新评估」；展示层把 `s` 叫「预言指数」。需要新字段，旧准确率不再决定 `level`。 |
| **不可并存** | 同一 `level` 字段语义从「准确率∩样本」变成「收缩场均∩积分」。不改合同就是撒谎；改合同必须升规范版本。 |
| **严重级别** | 阻断 |

#### C11. §44 L. 等级验收矩阵整组作废

| | |
|---|---|
| **A** | L92 season `<10` 永远最高 level1；L93 season 10–14 上限 level2；L94 career `<20` 最高 level1；L95 60% 真实准确率理论 level6；L96 显示 60.0% 但业务仍 `<60%`。 |
| **B** | 第七章反例：15 场全中仍未评级（n<20）；400 场场均 1.5 停在 Lv2；60 场场均 2.6 只到 Lv3–4。能力线不是 60% WDL。 |
| **不可并存** | L92–L96 在 B 下全部会失败；必须废止并换成 B 的反例 + 新不变量。L97–L99（可降、best 只增、无变化不写 history）部分可保留，但受 C7 保护期约束。 |
| **严重级别** | 阻断 |

#### C12. §47 冻结结论原文

| | |
|---|---|
| **A** | §47：「等级：胜平负真实准确率 + 样本量上限」。声明「从本版本开始，编码阶段不得再自行设计核心业务规则。」§3：「计分、等级等会影响历史结果的配置必须新建版本。」 |
| **B** | 整套替换该句。 |
| **不可并存** | 在 v1.0 正文里改 §47 等于解冻。只能新版本覆盖。 |
| **严重级别** | 阻断 |

#### C13. 现行唯一实现与调用链写死 A 公式

| | |
|---|---|
| **A** | 代码即 A 的可执行镜像：`calculateLevel` = `min(theoreticalAccuracyLevel, sampleSizeLevel)`，`LEVEL_MAX = 8`。结算 item 应用与 rebuild 当场调用。 |
| **B** | 需要窗口扫描、周任务、保级计数器。 |
| **不可并存** | 不改这些入口就无法落地 B；改了就不再符合 A。见 §3.7 真实路径。 |
| **严重级别** | 阻断 |

### 2.2 需澄清（B 有新规则，A 无对应或语义未定义）

| ID | 主题 | A 现状 | B 主张 | 为何不能直接编码 |
|---|---|---|---|---|
| Q1 | 是否仍保留「本赛季等级」 | §16.2 / §20 / §28.1 双展示 | B 未提 season | 若删 season，分享卡 `season_level` 无来源；若留，要用哪套公式 |
| Q2 | 友谊赛 / 等级白名单 / 多联赛 | §1.3 OUT_OF_SCOPE「多联赛」；§1.4 仅英超 | 友谊赛加生涯积分但不计 B；赛事须在等级白名单 | MVP 没有友谊赛集合。白名单若=英超，则 B 的友谊赛条款无操作对象 |
| Q3 | 挑场 50% 轻量规则 | A 无精选池，空关本来不计分 | 备选：当周该联赛预测场次 ≥ 该联赛当周总场次 50% 才计入窗口 | 「先监控再启用」不是可执行冻结规则 |
| Q4 | 「前巨星」隐藏标记 | 无此字段 | 仅自己可见 | 存哪、API 是否出现、注销用户、rebuild 是否保留 |
| Q5 | 「预言指数」进哪些 API | 无此字段；展示准确率是一位小数百分比 | 展示层叫预言指数并标注已校准 | 是否进 §24.2 / §28.1，还是纯前端文案 |
| Q6 | 排行榜是否跟等级指标对齐 | §19.4 仍按 `period_score` + WDL 准确率 | B 未提排行榜 | 等级看场均分、榜单看准确率，产品是否接受分叉 |
| Q7 | `best_level` 从 8 档映射到 6 档 | 只增不减，表示历史最高 | 六级后「历史最高」含义变了 | 见 §4.2 |
| Q8 | 先验 1.7 与回测 | 无收缩先验 | 「每赛季固定一次」；上线前必须用近几赛季回测；不够再下调 A 线 | 谁冻结 1.7、何时重估、是否新 `level_rule_version` |
| Q9 | 周结算 vs 赛果修正 | correction 当场可降级（L97） | 周一才评；保护期内不降 | 周中 correction 是否立刻影响窗口 S/n，是否允许当周内二次评估 |
| Q10 | `level_history.reason` 新值 | 四值封闭枚举 | 需要周评估 / 保护期结束 / 规则版本切换 | 不扩展枚举就无法审计 |
| Q11 | 窗口 300 / 24 个月与生涯统计展示 | career 永久累计场次/命中 | 能力线只用窗口 | profile 仍展示生涯准确率（§24.2）是否保留；与等级脱钩后文案 |
| Q12 | 进度「再完成 X 场」 | 无进度字段 | 不显示差 0.05 分 | X 的算法（距离 n=20？距离窗口填满？距离 B 线按先验场均换算？）未定义 |

### 2.3 明确不冲突（B 不要求改 A 这些条款）

| A 条款 | 说明 |
|---|---|
| §9.2 计分 `0 / 3 / 12` | B 的场均分 = `3w + 9e`，与「精确 12、胜平负 3、否则 0」代数一致（精确已含胜平负，故多出的 9 分来自精确）。**不要改计分。** |
| §9.4 取消 / §9.5 腰斩 | 与 B「正常完赛才计入窗口」同向。 |
| §18 解锁 30 / 100 / 200 | 仍看 `career_points`；B 的「累计有效积分」是另一条账，不得拿来回收 unlock。§50.1 前端仍不展示装扮。 |
| §19 / §27 / §34 排行榜 | B 未改排序、入榜 3 场、`compare_ranking_entry`。默认**保持 A**，除非 Q6 拍板要对齐。 |
| §48 / §49 鉴权、结算状态机、rebuild 事实源 | 与等级公式正交；rebuild 仍必须以 applied `settlement_items` 为账本（§49.5）。 |
| 「取消精选池」 | A 本来就没有精选池。 |

---

## 3. 影响面清单

### 3.1 领域规则与计算

必须整体替换 §17，并连带改写依赖它的句子。

| 规则点 | A（现行） | B 落地后 |
|---|---|---|
| 理论能力 | `theoreticalAccuracyLevel(valid, wdl)`，阈值 45/50/55/60/65/70% | 收缩场均分 `s=(S+68)/(n+40)`，与六级 A 升级/保级线比较 |
| 样本/参与 | `sampleSizeLevel(scope, valid)` 两张 cap 表 | B 线累计有效积分；Lv2 仅 `n≥20` |
| 合成 | `min(acc, sample)` | 升级：同时过 A 升级线与 B 积分，且一次一级；降级：A 连续 2 周低于保级线 |
| 窗口 | 无；career=全部有效场，season=该赛季全部有效场 | 最近 300 场、24 个月；白名单内、开赛前锁定、正常完赛 |
| 触发 | 每场 settlement / correction / rebuild | 周一凌晨周结算；rebuild 必须能复现同一结果 |
| 先验 | 无 | 1.7，每赛季固定一次 |

`src/domain/levels.ts` 中的 `ACCURACY_THRESHOLDS`、`SEASON_SAMPLE_CAPS`、`CAREER_SAMPLE_CAPS` 全部作废。

建议新纯函数（名称待规范冻结，此处仅为影响面）：

```text
calculate_level_v3(input) -> { level, s, n, eligible_points, can_promote, can_demote }
  input:
    window_score_sum            int >=0     # S
    window_n                    int >=0     # n
    eligible_points             int >=0     # B 线
    current_level               int 1..6
    consecutive_below_hold      int >=0
    in_launch_protection        bool
    prior_mean                  number      # 本赛季冻结的 1.7
    as_of                       date
```

旧 `calculate_level(scope, valid_predictions, wdl_hits)` **保留为 `level_v1` 只读实现**，供历史回放；新代码路径不得再调用它写当前等级。

### 3.2 Schema 新增 / 修改字段（草案，未冻结）

原则：核心文档今天 `schema_version = 1`（§2.5 / §21）。等级规则版本应**另立字段**，不要偷偷把 `schema_version` 改成 2 来表达业务规则（那会与「未知 schema_version Fail Closed」缠在一起）。

#### 建议：`users`（§21.1）

| 字段 | 类型 / 约束草案 | 动作 | 理由 |
|---|---|---|---|
| `career_level` | `int 1..6`（原 1..8） | **改取值域** | C1 |
| `career_best_level` | `int 1..6`（原 1..8） | **改取值域**；迁移见 §4 | C1 / Q7 |
| `level_rule_version` | `string`，默认 `"level_v1"`，新用户/切流后 `"level_v3"` | **新增** | §3 版本化 |
| `level_eligible_points` | `int >=0`，默认 0 | **新增** | B 线；≠ `career_points`（友谊赛 / 非白名单差集） |
| `level_window_n` | `int >=0` | **新增，可重建缓存** | 窗口场次 |
| `level_window_score_sum` | `int >=0` | **新增，可重建缓存** | 窗口 S |
| `level_index` | `string` 或定标小数（**待确认**，禁止当判断真相） | **新增展示缓存可选** | 预言指数；判断必须用整数/有理式，对齐 §16.3 精神 |
| `level_consecutive_below_hold` | `int >=0`，默认 0 | **新增** | 降级滞后 |
| `level_last_eval_at` | `date\|null` | **新增** | 上周结算时间 |
| `former_star` | `bool`，默认 false | **新增，Q4 未决** | 前巨星 |

`career_points` / `career_valid_predictions` / `career_wdl_hits` / `career_exact_hits` **保持**，仍是生涯账本缓存（§16.1 / §35.1）。

#### 建议：`user_season_stats`（§21.2）

取决于 Q1：

- 若 **删除赛季等级**：`level` / `best_level` 停止更新或标记 deprecated，API 不再返回；需规范显式废止。
- 若 **赛季等级改走 v3 窗口但限定本赛季**：同样需要 `eligible_points`、窗口字段、`1..6`。

未决前不要改这张表的取值域。

#### 建议：`level_history`（§21.13）

| 字段 | 草案 | 动作 |
|---|---|---|
| `from_level` / `to_level` | `1..6` | 改取值域（历史行见 §4.3） |
| `wdl_hits` / `valid_predictions` | 保留，v1 行继续有意义 | v3 行可继续填当时生涯/窗口场次，但**不足以降级决策** |
| `window_n` | `int >=0` | 新增 |
| `window_score_sum` | `int >=0` | 新增 |
| `eligible_points` | `int >=0` | 新增 |
| `level_index_s` 或分子分母 | 待确认（避免浮点当真相） | 新增 |
| `level_rule_version` | `string` | 新增 |
| `reason` | 见 §3.3 | 扩枚举 |

#### 建议：`unlocks`（§21.12） / `rankings`（§21.9）

**不改字段。** 解锁继续 `career_points`；排行榜继续 §19。

#### 可重建 vs 事实

§0.5：当前等级字段本就是可重建缓存。v3 的窗口聚合、B 线积分也必须能从 applied `settlement_items` + match 白名单/完赛状态重建。`former_star` 一旦置 true 建议视为只增标记（类似 `best_level`），rebuild 不得抹掉。

### 3.3 枚举与取值域

| 枚举 | A | B 需要 |
|---|---|---|
| 等级范围 | 1..8 | 1..6；Lv1=未评级（n<20） |
| 称号 | §17.1 八个 | 六个；Lv4/5 用新名称 |
| `LevelScope` | `season \| career`（`src/domain/enums.ts` 55–59 行） | 若 Q1=单等级，scope 对当前等级失去意义；history 仍可能要记 |
| `LevelHistoryReason` | `settlement / correction / rebuild / season_start`（enums.ts 106–113 行；§17.7） | 候选新值：`weekly_eval`、`rule_cutover`、`protection_end`（**未决 Q10**）。不得用自由文本。 |
| `ScoringRuleVersion` | `scoring_v1` | **不变** |
| `UnlockConfigVersion` | `unlock_v1` | **不变** |
| 新 `LevelRuleVersion` | 不存在 | `level_v1`（A） / `level_v3`（B） |
| `SyncJobType` | 无周等级任务；已有 `period_finalize`、`daily_consistency` | 需要新 job，例如 `weekly_level_eval`（周一凌晨） |

代码常量：`LEVEL_MIN=1`、`LEVEL_MAX=8`（`src/domain/levels.ts` 13–14 行）必须变成按 `level_rule_version` 分支，或拆成 `LEVEL_MAX_V1=8` / `LEVEL_MAX_V3=6`。

### 3.4 API 合同

| 接口 | A 合同要点 | v3 必须动什么 |
|---|---|---|
| `GET /v1/profile/me`（§24.2） | `career_level`、`career_best_level`、`career_wdl_accuracy_percent` | `level` 语义变更；是否加 `level_index`、进度文案、`former_star`（仅自己）；准确率字段建议**保留但标明不参与定级** |
| `GET /v1/profiles/:user_id`（§24.5） | 公开战绩含 `career_level` | 公开是否露出预言指数 / 前巨星（B：前巨星仅自己可见 → 公开必须隐藏） |
| `POST /v1/session/init`（§24.1） | 返回 `career_level: 1` | 新用户仍是 Lv1 未评级，兼容 |
| `GET /v1/levels/me`（§28.1） | season + career 两块，字段是场次/命中/准确率/level | **合同主战场**。至少要能返回：当前等级、best、窗口 n、B 积分、下次评估时间、进度文案。season 块取决于 Q1 |
| `GET /v1/share-card/me`（§29.1） | `season_level` 1..8 | 分享卡等级用哪套；OpenAPI `maximum: 8` 必须改 |
| `GET /v1/rankings`（§27.1） | 与等级无关 | 默认不动 |
| `GET /v1/unlocks/me`（§28.2 / §49.10） | 与等级无关 | 不动 |
| OpenAPI | `LevelStatsData.level` `minimum 1 maximum 8`（openapi.yaml 1254–1261 行）；`ShareCardData.season_level` 823–826 行；`MyProfileData.career_level` 1211–1218 行 | 全部 8→6，并按新字段升 contract 测试 `src/api/v1/openapi-levels.test.ts` |

§0.2 / §23：字段语义变化必须新规范版本，禁止 silently 改同一字段含义。

### 3.5 §0.4 唯一实现入口：签名变更与调用方

现行冻结入口：

```text
calculate_level(scope, valid_predictions, wdl_hits)
```

实现：`src/domain/levels.ts` `calculateLevel`（103–111 行）=

```text
min(theoreticalAccuracyLevel(valid, wdl), sampleSizeLevel(scope, valid))
```

| 符号 | 文件 | 行号（本次读到） | 行为 |
|---|---|---|---|
| 定义 | `src/domain/levels.ts` | 61–75 `theoreticalAccuracyLevel`；78–98 `sampleSizeLevel`；103–111 `calculateLevel` | A 公式唯一来源 |
| 包装 | `src/application/level-rebuild.ts` | 50–73 `rebuildLevelState` | 调 `calculateLevel`，处理 best 只增、history 是否写入 |
| 结算写等级 | `src/application/settlement-item-application-service.ts` | 415–422 career；444–451 season；537–561 写 `level_history` | **每场 item 应用后即时改等级**（A §17.6） |
| rebuild 写等级 | `src/application/stats-rebuild-service.ts` | 222–229 career；291–298 season | 从 ledger 重算后立刻 `rebuildLevelState` |
| 一致性期望 | `src/application/daily-consistency-snapshot.ts` | 152–156 career；191–195 season；64–65 `to_level` 校验 `1..8` | 期望等级 = 旧 `calculateLevel` |
| 分享卡 | `src/application/share-card.ts` | 157–161 | **不读 season stats，现场用赛季有效场次/命中调用 `calculateLevel(Season, …)`** |
| 只读展示 | `src/application/levels.ts` 74–109；`src/application/profile.ts` | 读缓存，不再计算 | 合同仍暴露旧语义 |
| 新用户 | `src/application/session.ts` | 101–102 | `career_level=1` |
| admin 审计摘要 | `src/application/admin-rebuild-user-stats.ts` | 35–36 | 把 `career_level` / `career_best_level` 写入 audit old/new |

v3 后：

1. §0.4 清单必须改成新签名（或并列 `calculate_level_v1` + `calculate_level_v3`，并写明写路径只许 v3）。
2. `settlement-item-application-service` **停止在每场 item 里写 current level**（可更新窗口缓存 / eligible_points）；改由周任务调用 v3。
3. `share-card.ts` 不得再现场用 WDL 公式算 `season_level`。
4. daily consistency 的 expected level 必须改用 v3，并理解「周中 current_level 允许与即时公式不一致」。

### 3.6 不变量 / 验收矩阵 / 冻结结论

| 位置 | A | v3 |
|---|---|---|
| §40 | 无「等级必须等于 calculate_level(v1)」；有 `career_best_level >= career_level`、unlock 不因积分下降删除 | 保留这两条；新增：B 线单调（仅 correction 可使 eligible_points 下降）、窗口可重建、保护期内 `to_level >= from_level`、Lv≥2 后 current≥2 |
| §21.1 invariant | `career_best_level >= career_level` | 仍成立，但 1..6 |
| §35.1 | `career_best_level = max(现有, history.to_level 最大, 重建后当前)`，普通 rebuild 不允许下降 | 映射后的 6 档同样只增；**禁止**用 v3 当前值把历史 8 档 best 压下去而不做映射 |
| §44 L. 92–99 | 见 C11 | 废止 92–96；97 受保护期/保级滞后约束；98–99 可保留；追加 B 第七章五条反例 |
| §47 | 「等级：胜平负真实准确率 + 样本量上限」 | 新版本改为「收缩场均分 ∧ 累计有效积分（level_v3）」 |
| §1.2 第 22 项 | 「等级样本保护」 | 改为「等级参与量门槛（B 线）+ 收缩校准」 |
| §3 | 无 `LEVEL_*` 配置项 | 必须登记：先验 1.7、窗口 300、24 个月、40 场伪计数、六级阈值、周结算、保护期 3 个月 |

`src/domain/invariants.ts` 35–67 行：career/season 只断言 hits 关系与 `best >= current`，**没有**断言 1..8。取值域目前靠 schema（`src/schema/collections.ts` 47–48、65–66、281–282 行）和 `rebuildLevelState` 的 `LEVEL_MIN..LEVEL_MAX`（`level-rebuild.ts` 34–43 行）。

### 3.7 代码影响面（真实路径，不许猜）

#### 领域

| 文件 | 行号 | 关键行为 |
|---|---|---|
| `src/domain/levels.ts` | 13–14, 23–58, 61–111, 116–128 | `LEVEL_MAX=8`；准确率阈值 70→8 … 45→3，否则 2；赛季/生涯样本 cap；`calculateLevel`；`shouldRecordLevelChange`；`nextBestLevel` |
| `src/domain/enums.ts` | 55–59, 106–113 | `LevelScope`、`LevelHistoryReason` 四值 |
| `src/domain/types.ts` | 62–63, 76–77, 232–243 | User / UserSeasonStats 等级字段；`LevelHistoryEntry` 含 `wdl_hits`+`valid_predictions` |
| `src/domain/config.ts` | 1–6, 9–47 | 注释写明等级变更必须新建版本；**当前没有 `LEVEL_RULE_VERSION`** |
| `src/domain/invariants.ts` | 35–67 | best≥current；不检查 1..8 |
| `src/domain/scoring.ts` | 62–80 | `calculateMatchScore` 0/3/12；v3 **复用**，不要改 |
| `src/domain/ranking.ts` | 29–55 | `compareRankingEntry`；与等级脱钩，默认不动 |

#### 写路径（等级被改的地方）

| 文件 | 行号 | 关键行为 |
|---|---|---|
| `src/application/level-rebuild.ts` | 全文 | 纯函数包装，不写库 |
| `src/application/settlement-item-application-service.ts` | 406–431, 442–458, 537–561 | 用 item delta 更新 career/season 后立刻 `rebuildLevelState`，变化则 insert history（reason=settlement/correction） |
| `src/application/stats-rebuild-service.ts` | 215–256, 280–331 | rebuild 从 applied ledger 重算 hits/points，再 `rebuildLevelState`；best 地板 = max(现有, history.to_level)；reason=rebuild |
| `src/application/session.ts` | 101–102 | 新用户 level=1 |
| `src/gateway/seed.ts` | 82–83 | seed 用户 level=1 |

#### 读路径 / 对账

| 文件 | 行号 | 关键行为 |
|---|---|---|
| `src/application/levels.ts` | 74–109 | `GET /v1/levels/me` 读缓存 |
| `src/application/profile.ts` | 24–35, 57+ | 私有/公开资料带 `career_level` |
| `src/application/share-card.ts` | 123–167 | 从已结算 prediction **重算** `season_level` |
| `src/application/daily-consistency-snapshot.ts` | 54–70, 140–207 | expected 用旧 `calculateLevel`；history `to_level` 必须 1..8 |
| `src/application/daily-consistency.ts` | 比较 career_level 等字段 | 发现差异只报警（§34.4） |
| `src/api/v1/levels.ts` | 30–47 | HTTP 包装 |
| `src/api/v1/openapi.yaml` | 331–342, 809–826, 1146–1218, 1240–1287 | 合同 1..8 |
| `src/schema/collections.ts` | 47–48, 65–66, 275–289 | 存储 1..8、history reason 四值 |
| `src/schema/indexes.ts` | 168–169 | `ix_level_history_user_changed`，索引本身无等级语义 |
| `src/infrastructure/cloudbase-repository.ts` | 62–63, 286–287, 316–317 | 读写 `career_level` / `career_best_level` |
| `src/sync/config.ts` | 21–48 | 无周等级 job；`period_finalize` 1h，`daily_consistency` 24h |
| `miniprogram/services/levels.js` | 3–8 | 前端调 `/v1/levels/me`（不在 `src/`，但是合同消费者） |

周结算：**代码里不存在**「周一凌晨评等级」的 job。B 的第五章是全新调度面，不能塞进现有 `period_finalize`（那是 §19.7 封榜）。

### 3.8 测试影响面（真实断言）

与等级/准确率定级直接相关，v3 后必须改或作废：

| 文件 | 断言要点 |
|---|---|
| `src/domain/levels.test.ts` | 整文件即 §44 L92–L99：season&lt;10→1、10–14→2、career&lt;20→1、60%→理论 6、1499/2500 显示 60.0% 业务 5、correction 可降、best 只增、无变化不写 history；另有 17.2 分档与 17.5 min() |
| `src/application/level-rebuild.test.ts` | career 40 场 30 中 → current=3；season 40/22 → 5 且 best 不降；&lt;20 场保持 1；越界 0 和 9 失败（依赖 `LEVEL_MAX=8`） |
| `src/application/levels.test.ts` | 返回 career.level=6 / best=7、season.level=4；无 season 文档时 level=1、准确率 null |
| `src/api/v1/levels.test.ts` | 200 envelope 形状；rate limit |
| `src/api/v1/openapi-levels.test.ts` | OpenAPI 含 `/levels/me` 与 season+career |
| `src/application/profile.test.ts` | `career_level: 6`、`career_wdl_accuracy_percent: "60.5"` |
| `src/api/v1/profile.test.ts` | 合同含 `career_level` 1 与 6 |
| `src/application/share-card.test.ts` | fixture `career_level: 8`（合法上限） |
| `src/application/rebuild-service.test.ts` | rebuild 后 `career_level: 1`、`career_best_level: 7` 保留；history `from 5 to 6` |
| `src/application/admin-rebuild-user-stats.test.ts` | audit old `career_level: 2` → new `1`，best 仍 2；unlock 不删 |
| `src/application/daily-consistency.test.ts` | 差异字段包含 `career_level` / `career_best_level` |
| `src/application/daily-consistency-snapshot.test.ts` | expected `career_level: 1`；`career_best_level` 保留 6 |
| `src/application/settlement-item-application-service.test.ts` | 一场 exact 后 season `level: 1`（样本保护）；事务内写 history/unlock |
| `src/application/acceptance-44-n-rebuild.test.ts` | N108–N111：ledger 事实源、unlock 不删 |
| `src/domain/invariants.test.ts` | season `best_level < level` 拒绝 |

相关但**公式本身不必改**（除非 Q6）：

| 文件 | 说明 |
|---|---|
| `src/domain/scoring.test.ts` | 0/3/12 与 B 场均分定义一致 |
| `src/domain/ranking.test.ts` / `src/application/ranking-query.test.ts` / `src/api/v1/rankings.test.ts` | 排行榜 |
| `src/application/unlock-decision.test.ts` / `unlocks.test.ts` | 积分解锁，与等级脱钩 |

v3 必须**新增**的测试（现在没有）：

- 收缩公式：`n=0 ⇒ s=1.7`；`S,n` 整数路径禁止用显示四舍五入判断过线。
- 六级 A/B 同时满足；只过 B 不过 A 停在 Lv2（B 反例 2）。
- n&lt;20 未评级（反例 1）。
- 一次只升一级；连续 2 周低于保级才降；Lv2 不降；保护期不降。
- 友谊赛 / 非白名单不计 B（若 Q2 纳入）。
- 窗口 300 场与 24 个月裁剪。
- 周任务幂等：同一周跑两次不重复写 history。
- cutover rebuild：v1 的 7/8 如何落入 v3 best。

---

## 4. 迁移与兼容方案

### 4.1 现有用户当前等级要不要重算

**要重算。** 理由：

- `career_level` 是可重建缓存（§0.5），不是账本。
- 公式整体替换后，旧值没有 v3 语义。
- §35.1 / §49.5 要求从 applied `settlement_items` 重建。

建议 cutover 步骤：

1. 冻结写路径：切流窗口禁止 settlement 与 rebuild 并发（已有 maintenance lock，§35.3）。
2. 全量 `rebuild_user_stats` **先**用 ledger 重建 points/hits（公式不变）。
3. 再按 v3 扫描每用户窗口，写入 `level_*` 缓存与 `level_rule_version=level_v3`。
4. 当前等级按 v3 **一次性落到合法 1..6**（允许跨多档落地，这是规则切换，不是「每周只升一级」；切换本身用 `reason=rule_cutover`，Q10）。
5. 之后才启用「一次只升一级」的周任务。

MVP 尚未对真实用户放量时（赛季 `2026_2027`，今天 2026-09-28，英超赛季若未开打则历史行可能很少），全量重算成本低，但仍要把流程写成可重复、可对账。

### 4.2 `best_level`

A：只增不减，表示「历史曾达到的最高档」（§17.6）。八档与六档**不是单调更名**，不能 `new_best = min(old_best, 6)` 了事：旧 8=足坛巨星，新 6=足坛巨星，旧 6=球队核心 ≠ 新 6。

可选（必须产品拍板，见 Q7）：

| 方案 | 做法 | 影响 |
|---|---|---|
| **G1 切断历史** | cutover 时 `best_level = 重算后的 current_level` | 实现简单；用户失去「我曾经是 7/8 档」；违反「只增不减」的**语义**（数字可能变小） |
| **G2 称号对齐映射** | 按称号不按数字：旧 1–3 对 1–3；旧 4–5 对 4；旧 6–7 对 5；旧 8 对 6，再与 v3 current 取 max | 保留「曾经巨星」；映射表必须写进规范，否则不可执行 |
| **G3 双字段** | 保留 `career_best_level_v1`（1..8 只读），新 `career_best_level` 走 v3 | 兼容最好、API 更胖；公开资料要决定露哪一个 |

**推荐 G2 或 G3，不推荐 G1。** 普通 rebuild 仍不得下降（§35.1）。若选 G2，映射一次写死，之后只在 1..6 上只增。

### 4.3 `level_history` 历史语义

- **禁止改写、禁止删除**旧行（§0.6）。
- 旧行继续表示「在 `level_v1` 下从 a 变到 b」，快照里的 `wdl_hits/valid_predictions` 仍是当时定级输入。
- 新行必须带 `level_rule_version=level_v3` 以及窗口/B 线快照。
- 跨版本的第一条新行用 `rule_cutover`（若产品同意扩枚举），`from_level` 如何填：
  - 若字段已改为 1..6，旧 7/8 **无法原样写入 from_level**；
  - 因此要么 history 取值域暂时保持 1..8（只约束新行 ≤6），要么 cutover 行的 from 用映射后的 1..6，并另存 `from_level_legacy`。
- **这是 schema 决策，必须在编码前冻结。** 推荐：history 的 from/to **暂时保持 1..8** 以容纳旧行，应用层按 `level_rule_version` 解释；当前缓存字段改为 1..6。

### 4.4 已解锁装扮

**保证不受影响。**

- 解锁条件仍是 `career_points >= threshold`（§18.3）。
- `career_points` 仍是有效 `match_score` 之和（§18.1），与 B 线不是同一数字。
- 已解锁永不回收（§18.3 / §40 / L76 / N111 / §50.1）。
- rebuild 只允许补发，不允许删（§35.1）。
- 前端 MVP 本就不展示装扮（§50.1），cutover 无 UI 回归面。

验收：cutover 前后 `unlocks` 集合不变（允许因积分补发新码，不允许消失）。

### 4.5 灰度与回滚

| 阶段 | 行为 |
|---|---|
| 双算 | 写路径仍按 v1 落 `career_level`；同时异步算 v3 到旁路字段（`level_v3_shadow`）或日志。daily consistency 对 v3 只报警。 |
| 灰度 | 按 `user_id` 哈希切 `level_rule_version`。**资料页等级是社交可见的，灰度会造成「同场次不同帽」。** 若尚未公开放量，直接全量更干净。 |
| 回滚 | 保留 `calculate_level` v1 实现；把 `level_rule_version` 打回 `level_v1` 并 rebuild。v3 history 行保留（reason=`rule_cutover` / `weekly_eval`），回滚后 current 再按 v1 算。不要物理删 history。 |
| 失败 | Fail Closed：周任务中途失败不得写一半用户；用 job lock（已有 `job_locks`）。 |

因为等级影响历史观感，§3 要求新版本，**回滚=切回旧版本号**，不是改阈值热补丁。

### 4.6 版本化

| 版本轴 | 现行 | v3 |
|---|---|---|
| 规范文档 | `MVP__v1.0.md` FROZEN | 新大版本，见 §5 |
| 计分 | `scoring_v1` | 不变 |
| 解锁 | `unlock_v1` | 不变 |
| 等级 | **无独立版本字段**（规则写死在 §17） | 新增 `level_rule_version`：`level_v1` \| `level_v3` |
| 文档 schema_version | 固定 1 | 能不加字段就保持 1；新增字段必须在规范里列进 §21 并给默认值，避免旧文档读失败 |
| 先验 1.7 | — | 每赛季一条配置，例如 `level_v3.2026_2027.prior_mean=1.7`；改 1.7 视为新子版本，不得静默改历史周的 s |

`FIXED_CONFIG_V1`（`src/domain/config.ts`）应增加并列的 `LEVEL_RULE_V3` 常量对象，而不是改 v1 表里的数字。

---

## 5. 规范落地形式建议

### 选项

| 形态 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 增补章节**（类比 §48/§49/§50） | 在 `MVP__v1.0.md` 加 §51，声明覆盖 §17 / §0.4 / §44 L / §47 等级句 | 与已有「补充冻结」流程一致；单文件仍是唯一来源 | §48–50 都是**补洞**（鉴权、状态机、合同），不是推翻核心玩法。把八级改六级塞进 v1.0 会让 §17 与 §51 长期双真值，编码 Agent 极易读错 |
| **B. 大版本** `MVP__v2.0.md` | v1.0 整文件冻结留档；v2.0 复制并替换 §17 及相关合同，§0.1 指向 v2.0 | 符合 §3「会影响历史结果的配置必须新建版本」；§47 不被改写；diff 可审 | 两份规范并存期间要写清楚「编码以哪份为准」 |
| **C. 独立《成长体系 v3》规范 + v1.0 仍管其余** | 等级子系统外置 | 文件小 | 违反 v1.0「唯一业务规范」叙事，除非 v1.0 §0.1 明确让位 |

### 推荐

**推荐 B：规范大版本（`docs/MVP__v2.0.md`），外加产品确认用的增补草稿可以先作为本文件的后续修订，但编码入口必须是 v2.0。**

理由：

1. §3 原文：「计分、等级等会影响历史结果的配置必须新建版本。」这不是建议，是冻结规则。
2. §47 已宣布核心规则冻结；§48–50 的前言是「与正文冲突时以更具体小节为准」，适合局部补丁，不适合删除八级表。
3. 冲突是 **13 条阻断级结构替换**，不是调一个数字。
4. `calculate_level` 在 §0.4，改签名属于「编码 Agent 强制规则」层，应在新版 §0.4 显式替换。
5. 保留 v1.0 可让 rollback / 历史 history 行有权威解释。

过渡写法（若必须先在本仓库留下可执行条文）：先用**独立冻结草案**（本文的后续版本）把 Q1–Q12 拍板，再一次性生成 v2.0，避免在 v1.0 上打 13 处补丁。

**明确不推荐：** 在 `MVP__v1.0.md` 里直接改 §17 数字。那会让已通过的 `src/domain/levels.test.ts` 与「FROZEN」声明同时撒谎。

---

## 6. 未决问题（必须产品拍板）

每条给选项与影响。未拍板前编码 Agent 应按 §0.3 Fail Closed，不得自行选。

### Q1. 本赛季等级还在不在？

| 选项 | 影响 |
|---|---|
| **S1 废止 season level** | 改 §16.2 / §20 / §28.1 / 分享卡；`user_season_stats.level` 停写；前端等级页只留一顶帽 |
| **S2 赛季独立走 v3** | 窗口改「本赛季有效场」，B 线是否赛季清零要再拍；实现翻倍 |
| **S3 对外只展示一套「当前等级」= v3 窗口，赛季字段仍返回但标注非定级** | 合同兼容最好，语义最容易被骂「两个数字不一致」 |

B 原文更像 S1。分享卡依赖 S 的选择。

### Q2. MVP 有没有友谊赛 / 非英超白名单？

| 选项 | 影响 |
|---|---|
| **L1 仍仅英超** | B 的「友谊赛不计 B」在 MVP 无操作对象；白名单=`premier_league`；§1.3 多联赛继续 OUT_OF_SCOPE |
| **L2 引入友谊赛或第二联赛** | 直接打破 §1.3 / §1.4 / §47「联赛：英超」；必须进 v2.0 产品边界，工作量远超等级 |

**建议 MVP 选 L1**，把友谊赛条款标成「v3 规则预留，本赛季无此类比赛」。

### Q3. 挑场 50% 规则上线没有？

| 选项 | 影响 |
|---|---|
| **P0 不上，只监控** | 与 A 一致；实现监控指标「预测场均强弱差距」（强弱定义仍缺） |
| **P1 上线计入窗口的门槛** | 周维度扫描每联赛赛程；空关周会让窗口 n 不涨；必须写进可执行规则（哪些联赛、轮次时区、不足 50% 的场是全丢还是按比例） |

B 自己说「建议备选」「若出现大量只挑单边局再启用」。默认 **P0**。

### Q4. 「前巨星」怎么存、谁可见？

| 选项 | 影响 |
|---|---|
| **F0 不做** | 减字段 |
| **F1 `users.former_star` bool，仅 `/v1/levels/me` 与 `/v1/profile/me` 返回，公开 profile 不返回** | 符合 B；rebuild 只增 |
| **F2 用 `best_level==6` 代替** | 不需要新字段，但「曾经是巨星、现在也是 6」与「掉下来」分不清——B 要的是掉级后的隐藏标记，F2 不够 |

### Q5. 预言指数是否进入 API？

| 选项 | 影响 |
|---|---|
| **I0 纯前端文案，API 只给 level + 进度** | 合同小 |
| **I1 API 返回已校准 `level_index` 字符串（一位小数）+ `calibrated: true`，并声明不得用于判断** | 对齐 §16.3 的准确率展示模式 |
| **I2 返回分子分母让前端自己算** | 更诚实，前端易算错 |

判断过线必须在服务端用原始 S、n 做有理比较，禁止对 `s` 四舍五入后再比阈值（沿用 §17.2 精神）。

### Q6. 排行榜要不要改？

| 选项 | 影响 |
|---|---|
| **R0 不改**（推荐默认） | 等级与榜单指标分叉，需在 UI 解释 |
| **R1 周/月榜改按收缩场均** | 推翻 §19.4 / §47 排序；`compare_ranking_entry` 重写；入榜门槛是否仍 3 场 |

B 未要求改榜，**默认 R0**。

### Q7. `best_level` 映射（见 §4.2）

必须三选一：G1 / G2 / G3。推荐 G2 或 G3。

### Q8. 先验 1.7 谁签字？要不要先回测再锁阈值？

B：「这些用户分布是我的假设，上线前必须用近几个赛季的历史赛果回测。若现实中顶尖用户也拿不到 2.4，只下调 A 线，不改结构。」

| 选项 | 影响 |
|---|---|
| **T1 先回测再锁进 v2.0** | 本升级计划停在规范层，等数据 |
| **T2 先按 1.7 与现表冻结，回测后只允许下调 A 线并升 `level_v3.1`** | 可开工；要预留阈值版本 |

A 线数字（1.80 / 1.95 / 2.15 / 2.35 与保级 -0.10）**本文不得改**；回测后的新表是另一个规范版本。

### Q9. 周中 correction 怎么进窗口？

| 选项 | 影响 |
|---|---|
| **W1 只改 S/n/B 缓存，等级等下周一** | 与「一次一周」一致；L97 不再成立 |
| **W2 修正导致 s 跨过保级线时立即评一次** | 更公平，实现接近 A 的即时模型，B 的「连续 2 周期」计数规则要重写 |

保护期 3 个月的起算点（首次生产部署日？赛季 `2026_2027` 开赛日？）也要写死。

### Q10. `level_history.reason` 扩哪些值？

候选：`weekly_eval`、`rule_cutover`、`protection_end`。是否仍用 `settlement` 表示「本周因结算触发的评估」？若周任务统一写 `weekly_eval`，则 §17.7 四值表必须改。

### Q11. profile 上的生涯准确率还展示吗？

B 把能力展示换成预言指数。A 的 `career_wdl_accuracy_percent` 仍是真实统计（§16.3）。

| 选项 | 影响 |
|---|---|
| **D1 两行都展示** | 用户可能用准确率反推「为什么没升级」 |
| **D2 等级页只留预言指数，资料页保留准确率** | 需文案 |
| **D3 去掉准确率展示** | 改 §24.2，信息损失 |

### Q12. 「再完成 X 场有效预测后重新评估」的 X？

未定义。选项：

- 到下周一的剩余天数（那不是「场」）；
- `max(0, 20-n)`（未评级）；
- 填满窗口 300；
- 按当前 s 与先验，估过下一条 A 线还需要的场次（又变成「差 0.05」的变体，B 明确不想要）。

必须给可执行公式，否则前端只能写死「每周一评估」。

---

## 7. 分阶段实施计划

垂直切片，每片可独立验证。**未完成 §6 拍板前不要开始 Slice 2 以后的编码。** 本计划是建议，不是授权。

### Slice 0 — 产品冻结（文档）

- 改动：把 Q1–Q12 决议写进未来的 `MVP__v2.0.md` 草稿（**不是**本文任务）。
- 验收：每条未决只剩一个选项；六级表数字与 B 完全一致。
- 依赖：无。
- 风险：拍板拖延；回测（Q8）可能改 A 线数字。

### Slice 1 — 领域纯函数 `level_v3`（可先写在新文件，旧 `levels.ts` 保留）

- 改动文件（预期）：`src/domain/levels.ts` 或新建 `src/domain/levels-v3.ts`；`src/domain/enums.ts`（`LevelRuleVersion`）；`src/domain/config.ts`（`LEVEL_RULE_V3`）；`src/domain/levels.test.ts` 增补而非删除 v1 用例直到切流。
- 验收：`npx tsc -p tsconfig.json --noEmit`；`npx vitest run src/domain/levels.test.ts src/domain/levels-v3.test.ts`（名称以实作为准）。覆盖 B 第七章反例 1–4；收缩公式 `n=0 ⇒ s=1.7`；一次升级一级；连续 2 周才降；Lv2 地板。
- 依赖：Slice 0 的阈值与保护期定义。
- 风险：浮点比较；必须用分数/定标整数比阈值（沿用 §17.2「禁止用显示值判断」）。

### Slice 2 — Schema 与类型，不切换写路径

- 改动文件：`src/schema/collections.ts`；`src/domain/types.ts`；`src/infrastructure/cloudbase-repository.ts`；migration 测试 `src/infrastructure/schema-migration.ts` / `.test.ts`；`src/schema/indexes.ts` 若要按 `level_last_eval_at` 查。
- 验收：旧文档缺新字段时读取给默认值（`level_rule_version=level_v1`）；`npx vitest run src/schema src/infrastructure/schema-migration.test.ts`。
- 依赖：Slice 1 字段清单。
- 风险：云数据库已有文档无新字段；必须向后兼容读。

### Slice 3 — 窗口与 B 线重建（只算不改帽）

- 改动文件：`src/application/stats-rebuild.ts` / `stats-rebuild-service.ts`；新 helper「从 applied items + matches 滤白名单、按时间取最近 300 场」。
- 验收：与 §49.5 一样只用 applied ledger；友谊赛/取消赛不计 B（若 L1，用夹具模拟非白名单 match）。`npx vitest run src/application/stats-rebuild-service.ts src/application/rebuild-service.test.ts`。
- 依赖：Slice 2。
- 风险：24 个月窗口需要 `match.period_anchor_at` 或 `settled_at` 作为时间（**用哪个必须写进 v2.0**；A 的周期归属用 `period_anchor_at`）。

### Slice 4 — 停止每场改帽，改为更新缓存

- 改动文件：`src/application/settlement-item-application-service.ts`（415–561 行附近）；对应 `.test.ts`。
- 行为：item 应用仍更新 points/hits/rankings/unlocks；**current_level 保持到下周评估**（v3 用户）；v1 用户可继续即时公式直到切流完毕。
- 验收：现有「一场之后 season.level 仍为 1」测试仍过；新增「v3 用户一场 exact 不升到 Lv2+」。`npx vitest run src/application/settlement-item-application-service.test.ts`。
- 依赖：Slice 3。
- 风险：若切流中混用 v1/v3，consistency 必须按版本分支，否则误报。

### Slice 5 — 周评估 job

- 改动文件：`src/domain/enums.ts`（`SyncJobType`）；`src/sync/config.ts`；新建 `src/application/weekly-level-eval-*.ts`；scheduler 注册。
- 验收：同一 `as_of` 跑两次 history 不加倍；保护期不降；连续计数在 s 回到保级线时归零。锁与 `daily_consistency` 错开。
- 依赖：Slice 4。
- 风险：与 settlement 并发（周一凌晨仍可能有英超比赛结算）。必须跳过 `settling/correcting` 用户，类似 §34.4 `skipped_active_settlement`。

### Slice 6 — daily consistency 与 rebuild 对齐 v3

- 改动文件：`src/application/daily-consistency-snapshot.ts`（尤其 64–65、152–195 行）；`src/application/stats-rebuild-service.ts`；`acceptance-44-n-rebuild.test.ts`。
- 验收：expected.current_level = 上周评估结果（或 rebuild 复现的 v3），不是即时 `calculateLevel` v1。`npx vitest run src/application/daily-consistency-snapshot.test.ts src/application/daily-consistency.test.ts src/application/acceptance-44-n-rebuild.test.ts src/application/rebuild-service.test.ts src/application/admin-rebuild-user-stats.test.ts`。
- 依赖：Slice 5。
- 风险：把「周中缓存未评估」当成损坏。

### Slice 7 — API / OpenAPI / 前端只读字段

- 改动文件：`src/application/levels.ts`、`profile.ts`、`share-card.ts`；`src/api/v1/openapi.yaml`；`src/api/v1/levels.test.ts`、`openapi-levels.test.ts`、`profile.test.ts`、`share-card.test.ts`；`miniprogram/services/levels.js` 及资料页（前端不在本次分析强制范围，但合同变了必改）。
- 验收：OpenAPI `maximum` 与示例；公开接口不返回 `former_star`（若 F1）。
- 依赖：Q1/Q4/Q5/Q12；Slice 5。
- 风险：字段语义静默变化导致旧客户端把 Lv6 当成「球队核心」。

### Slice 8 — 历史 cutover

- 改动：一次性维护脚本或 admin rebuild 全用户；写 `rule_cutover` history。
- 验收：unlock 集合不减；`career_points` 不变；所有 `career_level ∈ 1..6`；best 按 Q7 映射；抽检窗口 S 等于最近 ≤300 场白名单完赛 `match_score` 之和。
- 依赖：Slice 6–7、Q7。
- 风险：**最大风险**。映射错误无法靠「再 rebuild 一次」自动发现，除非留下 v1 快照。建议 cutover 前把 `career_level/best_level` 拷到旁路字段保留 1 个赛季。

### Slice 9 — 废止 v1 写路径

- 改动：§0.4 在 v2.0 中替换；测试中 L92–L96 移到 `levels-v1.test.ts` 仅作历史实现锁定，不再作为 §44 门禁。
- 验收：全量 `npx tsc -p tsconfig.json --noEmit`；`npx vitest run`。
- 依赖：Slice 8 稳定后。
- 风险：漏调用方。以 Grep `calculateLevel(` / `theoreticalAccuracyLevel(` / `sampleSizeLevel(` 为零写路径为准。

### 依赖顺序（简图）

```text
0 拍板 → 1 纯函数 → 2 schema → 3 窗口重建
                              → 4 结算不再改帽 → 5 周 job
                              → 6 consistency/rebuild
                              → 7 API
                              → 8 cutover → 9 删除 v1 写路径
```

### 风险总表

| 风险 | 切片 | 缓解 |
|---|---|---|
| 8 档 best 无法逆推 6 档称号 | 8 | Q7 选 G2/G3；cutover 前快照 |
| 周中 consistency 误报 | 4–6 | expected 按 `level_last_eval_at` 而不是即时公式 |
| 浮点 s 与阈值 1.80 比较抖动 | 1 | 定标整数：比较 `(S+68)*100` vs `180*(n+40)` 这类交叉乘法 |
| 挑场漏洞 | 产品 | Q3=P0 + 监控；不在 MVP 编码范围 |
| 先验 1.7 不准 | Q8 | 只下调 A 线，升子版本 |
| 分享卡仍用 WDL 算 season_level | 7 | `share-card.ts:157` 必须改，否则会出现「分享卡 6、资料页 3」 |

---

## 8. 附录：B 原文关键定义与阈值表

以下内联自成长体系阈值 v3，**数字未改**。A 中无这些表。

### 8.1 相对 v2 的一句话

取消官方精选池；积分直接参与定级。

### 8.2 积分如何参与等级

积分用两种方式进入等级，且分工不同：

| 条件 | 指标 | 回答的问题 | 能否靠刷量通过 |
|---|---|---|---|
| A 能力线 | **收缩场均分**（窗口内每场平均预测分，已校准） | 你每场平均能拿多少分 | 不能。这是比率，打得多不会变高 |
| B 参与线 | **累计有效积分**（计入等级的赛事，永久累计） | 你是否已经足够多地在场 | 只能靠量，但过了 B 不等于过 A |

**A、B 必须同时满足才能升级。** 刷量用户 B 很快过，但 A 不过，仍然升不上去。

为什么用「场均分」而不是「胜平负命中率」做能力线：场均分 = 3 × 胜平负率 + 9 × 精确率，一个数就把两种能力都算进去了，不需要再单设精确率门槛，也就不会出现「为过线一律猜 1-0」的问题。

（与 A §9.2 的关系：精确 12、胜平负 3、否则 0 ⇒ 期望分 `3w+9e`。计分表本身不用改。）

### 8.3 收缩公式

```text
s = (S + 40 × 1.7) / (n + 40)
```

- S：窗口内预测分总和；n：窗口内有效场次
- 先验 1.7 ≈ 普通用户场均分（胜平负约 42%、精确约 5%），**每赛季固定一次**
- 窗口：最近 300 场有效预测，时间上限 24 个月
- 有效场次：开赛前锁定、正常完赛、赛事在等级白名单内。友谊赛只加生涯积分，**不计入 B 的累计有效积分**

代数：`40 × 1.7 = 68`，故 `s = (S + 68) / (n + 40)`。过线比较应交叉相乘，避免先四舍五入 `s`。

### 8.4 六级阈值

| Lv | 称号 | A 升级线（收缩场均分） | A 保级线 | B 累计有效积分 | 参考场次 |
|---|---|---|---|---|---|
| 1 | 青训新人 | 未评级（有效场次 &lt;20） | — | — | — |
| 2 | 初出茅庐 | 有效场次 ≥ 20 即得 | 不降级 | — | 20 |
| 3 | 潜力新星 | ≥ 1.80 | ≥ 1.70 | ≥ 80 | 约 50 |
| 4 | 稳定主力 | ≥ 1.95 | ≥ 1.85 | ≥ 170 | 约 90–100 |
| 5 | 中场核心 | ≥ 2.15 | ≥ 2.05 | ≥ 380 | 约 170–200 |
| 6 | 足坛巨星 | ≥ 2.35 | ≥ 2.25 | ≥ 630 | 约 270–300 |

B 取「该级踩线用户预期积分」的约 90%（= 参考场次 × 升级线 × 0.9），所以它是真正的参与量门槛。准的用户积分涨得快，会更早满足 B；不准的用户 B 可能也满足，但被 A 挡住。

### 8.5 达标概率检验（B 的假设，不是 A 的验收门禁）

假设五类用户真实水平（场均分 = 3w + 9e），在参考场次一次评估 A 条件，模拟 2 万次：

| 用户类型 | 胜平负 / 精确 | 真实场均分 | Lv3（n=50） | Lv4（n=100） | Lv5（n=200） | Lv6（n=300） |
|---|---|---|---|---|---|---|
| 普通 | 42% / 5% | 1.71 | 31% | 11% | 0% | 0% |
| 一般 | 46% / 6% | 1.92 | 51% | 31% | 6% | 0% |
| 较好 | 50% / 8% | 2.22 | 76% | 69% | 44% | 12% |
| 很强 | 53% / 9% | 2.40 | 86% | 85% | 74% | 42% |
| 顶尖 | 56% / 11% | 2.67 | 95% | 96% | 96% | 88% |

B 的解读：

- 普通用户基本停在 Lv2–3，Lv5 以上几乎不可能靠运气。
- Lv6 要求真实场均分 2.4 以上，只有很强或顶尖用户能稳定达到。
- 升级是持续滚动评估，不是一次性抽签，实际达标率会略高于上表。
- **这些用户分布是假设**，上线前必须用近几个赛季的历史赛果回测。若现实中顶尖用户也拿不到 2.4，只下调 A 线，不改结构。
- 场均分含精确比分，方差比纯胜平负率大（单场标准差约 3.1）。参考场次下噪声偏高，这也是保级线比升级线低 0.10 的原因。

### 8.6 结算与保护

1. 每周结算一次（周一凌晨），升级需 A、B 同时满足，一次只升一级。
2. 降级：A 连续 2 个结算周期低于保级线才降一级。B 是累计值，不会导致降级。
3. Lv1–2 不降级；最低降回 Lv2。上线后前 3 个月只升不降，方便调阈值。
4. 巨星掉级后保留「前巨星」隐藏标记，仅自己可见。
5. 资料页不显示「差 0.05 分」，进度文案用「再完成 X 场有效预测后重新评估」。
6. 展示层把 s 叫「预言指数」并标注已校准，避免与战报对不上。

### 8.7 取消精选池后的遗留风险

用户可以只挑强弱悬殊的比赛预测，「空关不扣分」放大了这个问题。这个漏洞没有被堵住，只是被削弱：

- 场均分里包含精确比分（12 分），只挑热门的用户精确命中率不会明显提升，削弱了一部分收益。
- 建议备选一个轻量规则，**不是精选池**：某联赛当周你预测的场次 ≥ 该联赛当周总场次的 50%，这一周该联赛的预测才计入等级窗口（积分照常累计）。它不限定比赛，只要求不挑场。
- 上线后监控：用户「预测的比赛平均强弱差距」分布。若出现大量只挑单边局的账号，再启用上述规则。

A 侧对应事实：MVP 只有英超，本就没有精选池；不预测本来就不计分（§9 / §18 无空关惩罚）。

### 8.8 验收反例（B）

1. 只猜 15 场且全中：n&lt;20，未评级。
2. 猜 400 场但场均分只有 1.5：B 早已满足，A 始终低于 1.80，停在 Lv2。
3. 猜 60 场、场均分 2.6：A 与 B 均可满足，可到 Lv3–4（受收缩限制不会直接到 Lv5）。
4. 靠友谊赛刷积分：不计入 B。
5. 用历史赛果回测三种模板策略（永远主队 1-0、永远 1-1、永远热门 2-1），Lv5 以上不应有模板策略。

反例 1 与 A 的 L94（生涯 &lt;20 最高 level1）**场次门槛同向**，但「全中仍未评级」在 A 里同样成立；反例 2 在 A 里 400 场且准确率低会停在准确率档 2，**结果可能碰巧类似，机制不同**；反例 3 在 A 里 60 场生涯样本上限是 4，100% 准确可到 4，与 B 的「收缩拦住 Lv5」不同。

### 8.9 A 现行八级表（对照用，勿与 B 混用）

§17.1 称号：

```text
1 青训新人
2 初出茅庐
3 潜力新星
4 崭露头角
5 坐稳主力
6 球队核心
7 顶级球星
8 足坛巨星
```

§17.2 准确率理论等级：`<45%=>2`，`≥45%=>3` … `≥70%=>8`。

§17.3 赛季样本：`<10=>1`，`10-14=>2`，… `≥70=>8`。

§17.4 生涯样本：`<20=>1`，`20-39=>2`，… `≥400=>8`。

§17.5：`final_level = min(accuracy_level, sample_size_level)`。

---

## 9. 分析范围与未读到的声明

- B 全文已读（`/tmp/level-v3-thresholds.md`，86 行）。仓库内无 v2 阈值文档；「相对 v2 取消精选池」无法与仓库文件逐条对照，只与 A 对照。
- A 的 §48 / §49 / §50 已通读：无等级公式补丁。
- 代码引用均来自本次 Grep/Read；若后续文件移动，以仓库为准。
- 本文**不是**编码授权。按 A §0.2 / §46.10，在 v2.0 冻结前实现 B 属于自行扩展需求。

---

## 10. 产品决策记录（2026-09-28 产品答复）

> 本节由产品逐条答复 §6 未决问题，并追加两项新决定（六级命名、排行榜重构）。**本节是决策记录，不是编码授权**；在规范新版本冻结前不得据此改代码。

### 10.1 六级命名（覆盖 B 原文六级表）

| Lv | 称号 | A 升级线（收缩场均分） | A 保级线 | B 累计有效积分 | 参考场次 |
|---|---|---|---|---|---|
| 1 | 青训新人 | 未评级（有效场次 < 20） | — | — | — |
| 2 | 潜力新星 | 有效场次 ≥ 20 即得 | 不降级 | — | 20 |
| 3 | 崭露头角 | ≥ 1.80 | ≥ 1.70 | ≥ 80 | 约 50 |
| 4 | 坐稳主力 | ≥ 1.95 | ≥ 1.85 | ≥ 170 | 约 90–100 |
| 5 | 球队核心 | ≥ 2.15 | ≥ 2.05 | ≥ 380 | 约 170–200 |
| 6 | 顶级球星 | ≥ 2.35 | ≥ 2.25 | ≥ 630 | 约 270–300 |

命名来源：沿用 A §17.1 的现有称号，去掉「初出茅庐」与「足坛巨星」，保留的六个依次上移；**「顶级球星」成为最高级**。不再使用 B 原文的「稳定主力 / 中场核心 / 足坛巨星」。
逐级阈值（A/B/保级/参考场次）沿用 B 原文数值，未做改动。

### 10.2 §6 未决问题的答复

| ID | 决策 | 备注 |
|---|---|---|
| Q1 本赛季等级 | **保留，且按新算法** | 赛季版窗口与 B 线定义待补，见 §10.4 |
| Q2 友谊赛 / 白名单 | **没有友谊赛；赛事范围 = 五大联赛 + 中超** | 打破 A §1.3「多联赛 OUT_OF_SCOPE」与 §1.4「仅英超」；等级白名单即这六个联赛 |
| Q3 挑场 50% 规则 | **先忽略**，不写进规范 | 上线后监控，必要时再启用 |
| Q4 「前巨星」标记 | **本期不做，记录到文档、以后再实现** | 见 §10.5 |
| Q5 预言指数 | **先忽略**（不作为对外字段/命名） | 与实力榜按 s 排序的张力见 §10.4 第 8 条 |
| Q6 排行榜 | **按 §10.3 重构** | |
| Q7 历史最高等级 | **按六级** | |
| Q8 先验 1.7 | **先冻结**，不等回测 | |
| Q9 周中修正 | **周一评级；随后若发生赛果修正，立即结算更新** | 混合节奏：周期评估 + 修正即时触发 |
| Q10 换规则版本记录 | **不记录**（旧版本未上线） | 同时意味着无存量用户迁移，见 §10.6 |
| Q11 生涯准确率展示 | **不显示** | |
| Q12「再完成 X 场」 | **不显示、忽略** | 与 §10.3 实力榜空状态文案的张力见 §10.4 第 8 条 |

### 10.3 排行榜重构：一个入口、三个榜

| Tab | 排序依据 | 门槛 | 含义 | 默认 |
|---|---|---|---|---|
| 本周榜 | 本周预测分 | 无 | 谁这周状态好 | ✅ 默认 |
| 生涯榜 | 生涯积分 | 无 | 谁来得久、贡献多 | |
| 实力榜 | 预言指数（s） | 有效场次 ≥ 50 | 谁预测得最准 | |

- 范围切换：**全站 / 我的群**。群榜由「分享到群 + 邀请码」建立；**放弃微信好友关系链**（小程序拿不到）。
- 「我的名次」固定底部、不用滚动；排名靠后用**百分位**表达（如「前 35%」），不显示绝对名次，也不出现「垫底」字样。
- 实力榜未满 50 场：显示进榜引导。
- 展示：只显示前 20 名，每次加载 10 条、下拉加载更多；顶部显示**更新时间**。
- 并列规则（写在榜单说明、不在主界面）：本周榜 / 生涯榜 = 分数 → 精确比分次数 → 有效场次 → 先达到该分的时间；实力榜 = 预言指数 → 有效场次。
- 未开赛的预测不进榜单（防抄作业）；点击某行进入对方主页（布局与本人一致）。
- 明确避免：裸胜率做榜；把「预测场次」当排序键（只展示、不排序）；一个榜里混排积分与指数；对落后用户显示「垫底」。

### 10.4 由此新增的待办（必须在规范里写清，否则编码无法唯一实现）

1. **赛季版窗口与 B 线定义**：窗口是否改为「本赛季有效预测」？B 线是否赛季重置？
2. **B 线是否复用现有 `career_points`**：既然无友谊赛、六个联赛全算，B 线口径可能等同 `career_points`；还需定义「赛果修正使积分下降时 B 线是否回退」（建议只增不减，与「B 不导致降级」一致）。
3. **跨联赛的 s 是否混算**：英超与中超场均分不在同一尺度；建议先混算并在规范里标注已知偏差。
4. **准确率的去留**：定级、排序、展示三处均不再使用（§10.2 Q11 + §10.3），需决定 `wdl_hits` / `wdl_accuracy` 是否继续维护（建议保留统计、对外不展示）。
5. **排行榜合同**：门槛取值、排序键、百分位字段、更新时间、生涯榜数据来源；实力榜需窗口预聚合（受 A §42.1「Top20 必须走索引/预聚合」约束）。
6. **群榜**：全新功能，需要群 / 成员 / 邀请码的存储与接口，A 中完全没有对应条款。
7. **多联赛**：A §1.3 / §1.4 / §47「联赛：英超」需整体改写；赛程同步、Provider 映射、赛季 ID 都要扩到六个联赛。
8. **实力榜空状态文案 vs Q12**：Q12 要求不显示「再完成 X 场」，而 §10.3 的实力榜空状态用了同一句话，需确认两处是否都保留。

### 10.5 遗留项（以后实现）

| 项 | 状态 | 说明 |
|---|---|---|
| 「前巨星」隐藏标记 | 本期不做 | 仅自己可见；需定义存储、接口可见性、注销与 rebuild 保留策略 |
| 「只挑强弱悬殊比赛」的 50% 轻量规则 | 先忽略 | 上线后监控「预测比赛的强弱差距」分布，必要时再启用 |
| 「预言指数」对外命名与展示 | 先忽略 | 实力榜仍按 s 排序 |

### 10.6 因旧版本未上线而**免除**的工作

- 无存量用户等级迁移；`career_level` / `career_best_level` 不需要 1..8 → 1..6 的映射（§4.1 / §4.2 的迁移分支作废）。
- `level_history` 不需要新增「规则版本切换」类 reason（§10.2 Q10）。
- 但仍需规范版本化：A §3 要求「计分、等级等会影响历史结果的配置必须新建版本」，A §47 已声明冻结；八级表与六级表不得在同一份 v1.0 中长期并存。
