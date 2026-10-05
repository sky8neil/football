# MVP 2.0 代码审查修复轮完成报告（v1.0）

- 完成时间：2026-09-29（12:29 – 15:50，约 3 小时 20 分）
- 依据：《`docs/MVP2.0__CODE_REVIEW__v1.0.md`》审查报告（21 批 · 62 条发现：严重 14 / 重要 43 / 优化 5）
- 处理口径：**58 条进入代码修复**；4 条另行处理（2 条经主审复核为误报/不成立不动代码；2 条为规范文本遗留，改由规范文本修订处理）

## 执行方式

- 工具链：**Codex CLI + cc-switch → sub2api → OpenAI gpt-6-luna（max 推理）**；执行器 `run-stage-codex.sh`（含停滞看门狗、自动续跑、单并发锁）
- 分 6 个阶段顺序执行（对应报告顺序，按模块成组以降低回归风险）；每阶段流程：
  1. 编码 agent 按任务书修复 → 自跑门禁 → 输出修复台账（STAGE_STATUS）
  2. **主 agent 独立复跑门禁**（tsc + 全量测试 + build + diff 检查）并对净 diff 逐段复核
  3. 归档 `snapshots/FIX*-after` + `reviews/fix-FIX*.diff`，更新 `state.md`

## 结果总览

| 阶段 | 内容 | 条数 | 用时 | 结果 |
|---|---|---|---|---|
| FIX1 | 等级核心与时序（修正重评/周评估/invariants） | 6 | 30 分钟 | ✅ 首跑通过 |
| FIX2 | 排行榜/快照/每日对账 | 11 | 28 分钟 | ✅ 首跑通过 |
| FIX3 | 结算账本/编排/重建支撑 | 6 | 22 分钟 | ✅ 首跑通过 |
| FIX4 | 仓储/类型/Schema | 9 | 15 分钟 | ✅ 首跑通过 |
| FIX5 | API/群组/查询/资料/小程序 | 20 | 48 分钟 | ✅ 首跑通过（附注见下） |
| FIX6 | Provider/网关/seed/触发器 | 6 | 43 分钟 | ✅ 首跑通过 |

- **58/58 全部落实，零 SKIP**；六个阶段全部首跑通过（无返工轮）。

## 门禁与产物

- 每阶段独立复跑：TSC / 全量 vitest / build / `git diff --check` 全绿；小程序改动附 `node --check`。
- **最终基线：130 个测试文件、1276 项测试全绿**（修复轮起点 1248 → 新增 **28** 个回归用例）。
- 修复轮净变更：`src/` 内 **91 个文件**（生产 + 测试）；合并 diff `reviews/fix-ALL.diff`（6064 行，+2300/-767）。
- 小程序：`pages/rankings/rankings.js/.wxml`、`services/rankings.js`（三榜字段映射 + `me` 状态卡片；最少 UI 增量，无新样式）。
- 归档：`snapshots/R0-pre-fix`、`FIX1-after` … `FIX6-after`；`reviews/fix-FIX1..6.diff`；过程记录 `state.md`。
- 未提交 / 未推送（沿用工程约定）。

## 规范文本修订（3 处，随修复轮落账）

1. §15.5 item 原子性列表：删除遗留的「month ranking 用户聚合增量」（月榜已在 v2.0 取消，与 §19.1 对齐）。
2. §15.8：删除「重算受影响 month rank」，改「重算完成后才能进入 finalize」（同上）。
3. §32.9 `weekly_level_eval`：「10:05」→「10:10」（与 §17.6.2「as_of + 10 分钟」及实现一致；§17 表与验收清单中的「10:05 applied」是场景叙述时间，指截止后 applied，非触发时刻，保持不变）。

## 复核说明（主审）

- 全部 14 条「严重」在修复前已逐条对照规范+代码复核：10 条属实修复；2 条为规范文本遗留（本轮已修订）；1 条主论点不成立、1 条误报（不动代码）。
- FIX5 报告存在两处文件归因失准（`match-query.ts`/`session.ts` 实际未被改动）：经行为合同逐一复核，**无功能缺口**（90 天窗口在服务层强制并新增回归测试；grapheme 口径修复在 openapi 合同）。
- 两个新增错误码 `USER_STATS_REBUILD_ALREADY_RUNNING`、`RANKING_REBUILD_ALREADY_RUNNING`：规范 §23.5 未单列（SPEC_GAP 备忘，如后续对外暴露需登记）。

## 遗留提醒（不变）

- 小程序改动建议真机/开发者工具目检（含新增三榜切换与「我的排行」卡片）。
- 既有遗留：Q1 `LEVEL_FIRST_EVAL_AS_OF` 上线周登记；L112 模板回测门禁；B1 CloudBase 真实库接线；部署 ACL 环境侧确认。
