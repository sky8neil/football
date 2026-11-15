# MVP 2.0 第二轮修复轮完成报告（v1.0）

- 完成时间：2026-09-29（20:35 – 21:37，约 1 小时）
- 依据：《`docs/MVP2.0__CODE_REVIEW_R2__v1.0.md`》（第二轮复审报告；16 严重 / 34 重要 / 9 优化）
- 范围：**16 项 = 主审复核属实 14 项 + 主审标注「先实证」2 项** + 规范文本澄清 1 处
- 工具链：**opencode + commandcode-ai/deepseek/deepseek-v4-flash**（执行器 `run-stage.sh`：停滞看门狗 + 断点续跑 + 并发锁；provider 由 cc-switch 主库注入 opencode 配置；末轮兜底 `sub2api-grok/grok-4.6` 未触发）

## 结果总览

| 阶段 | 内容 | 项数 | 用时 | 结果 |
|---|---|---|---|---|
| R2FIX1 | 群组·分页·合同 | 3 | 10.5 分钟 | ✅ 首跑通过 |
| R2FIX2 | 结算生命周期（item 原子性 / retry 语义 / 队列续跑） | 3 | 21.7 分钟 | ✅ 首跑通过 |
| R2FIX3 | 仓储·Provider（原子插入 / 误冲突 / 逐条容错 / live 窗口） | 4 | 11 分钟 | ✅ 首跑通过 |
| R2FIX4 | 重建·对账（账本门闩 / 排序 / 等级 expected ×2） | 4 | 11 分钟 | ✅ 首跑通过 |

- **14 项 FIXED + 2 项「实证不成立」**（b19F2 排序、b08F1 对账 expected——先补再现用例，实证现实现已正确/被正确逻辑覆盖，遂不改生产代码、固化用例防回归）。
- 四阶段**全部首跑通过**，零返工、零 SKIP。

## 关键修复摘要

- **R2FIX1**：解散群同事务终止全部 active 成员（名额实时回收、幂等可自愈历史数据）；`GET /v1/groups/me` 实现 HMAC 签名 keyset 真分页（`limit` 缺省 20、篡改/越界 422、真实 `has_more/next_cursor`）；`MatchDetailData` 独立 schema 修复 allOf 合同自相矛盾。
- **R2FIX2**：新增 `savepoint` 事务原语（undo 日志分段 + LIFO 回滚）；三结算服务的 item 写入（含 item→applied）整体隔离——**失败项写入不留库、失败记录外层提交**（§15.5）；admin retry 响应按 §30.4 收敛（后续版本成败不回写本次响应）；`correct()` 完成后续跑版本队列（§15.9）。
- **R2FIX3**：`match_results` 插入同步化（check→set 零 await，并发同键恰一成功）；abandoned 同态复推不再误报 blocking 冲突（§33.5/§41）；Provider 批次逐条容错（非法条目以实体级 `PROVIDER_DATA_INVALID` 落证，不弃整包）；live 窗口对齐「T-2h ～ finished」（含已开赛场次，与补查按 id 去重）。
- **R2FIX4**：rebuild 账本加载门闩改为 `activeSettlement → 409`（默认纵深防御 + `skipActiveSettlement` 供 daily consistency 沿用跳过语义）；best_level 采用事实下界口径（可检出下界违约）。

## 门禁与产物

- 每阶段主 agent 独立复跑：TSC / 全量 vitest / build / `git diff --check` 全绿。
- **最终基线：130 个测试文件、1303 项测试全绿**（R2FIX 起点 1276 → 新增 27 个回归用例）。
- 净变更：`src/` 34 个文件；合并 diff `reviews/r2fix-ALL.diff`（2698 行，+1592/-292）；**小程序与 docs 零改动**（除规范澄清）。
- 归档：`snapshots/R2FIX0-pre` … `R2FIX4-after`；`reviews/r2fix-R2FIX1..4.diff`；过程记录 `state.md`。
- 未提交 / 未推送。

## 规范文本澄清（1 处）

- §15.5「item 级原子性」：为 `level 当前值变化 / 必要的 level_history` 两条补注「**等级写入仅发生于周评估 / 修正重评流程（第 17.7、17.9 节）；普通 item 应用不写等级**」——消除前两轮复审反复出现的同一误读（该歧义此前已两度被判为「问题」）。

## 未纳入本轮的项（备忘）

- b03F1 哨兵行（`board_snapshots` head 元数据）：建议「保留机制 + 规范登记 head 约定」，待拍板。
- b22F2 finalize 整对象写回：生产并发面收紧，B1 CloudBase 接线时按最小字段 patch 处理。
- b14F1（401/409 误报，双重实证）、b07F1（回放初态边缘项）。
- R2FIX2 期间新增 SPEC_GAP 备忘 1 条（already_settled 脏状态需推进 `settled_result_version`，范围外）。
