# MVP 2.0 R3 修复记录

日期：2026-10-13。依据：`docs/MVP2.0__REVIEW_R3__v1.0.md`。
本轮处理业务功能和合同一致性，没有扩展安全、防御或性能治理。

## 业务修复

| Review ID | 处理结果 |
|---|---|
| B-01 | 沿用现有配置：五大联赛主源 football_data（fd）、中超 bsd。统一规范 §1.4、§5.2，与 §31 的口径一致。 |
| B-02 | README 等级赛季边界改为北京时间 07-01。小程序原先已先转换北京时间，无需改动。 |
| B-03 | 沿用解散时全体 active 成员（含群主）变为 left、member_count=0 的行为，修正规范 §40。活跃群主仍不能普通退出。 |
| B-04 | 保留 head 元数据，在 §21.20 登记 snapshot_kind 与查询排除规则。 |
| B-05 | history 单步断言只约束 weekly_eval；同周 correction 从 week_base 重评，允许低档回到高档跨 2 级。同步规范和 README。 |
| B-06 | 从 PeriodType 删除 month。旧月周期输入仍返回非法参数；对应拒绝测试使用显式非法输入。 |
| B-07 | rebuild 从 level=1、best_level=1、below_count=0 回放，不再把当前等级缓存作为初态。无首评登记时回到未定级基线；有效历史等级下界仍保留。daily consistency 同样从历史账本回放，避免登记首评后用最新账本重算旧截面。 |
| B-08 | groups schema 登记邀请码 minLength/maxLength=8。 |
| B-09 | 周榜名次只为 valid_predictions>=1 的行累计位置，清零行不占位。重建和结算重排两条路径均修复。 |
| B-10 | 分享卡服务与 get 别名接受 serverNow，API 下传请求时钟，用于计算等级赛季。 |
| B-11 | 详情仅在比赛当前版本已 settled 且预测应用版本一致时展示结算字段；否则积分和命中字段为 null。注销身份仍读取已有预测。 |
| B-13 | 新增 updateSettlementProgress，仅更新结算进度字段；CloudBase 状态更新也改为字段合并。finalize 独立事务，不再整对象覆盖比赛数据。 |
| B-14 | 通过结算锁判断执行权，取得锁后可恢复 running 文档；first 复用原未完成版本，retry 和 correction 均可续跑，admin retry 可选择无持有锁的 running 目标。 |
| B-15 | 宽限时间结束、锁释放均不再代表周评估已完成；检查用户本周评估基线，未完成时延后 correction 重评。 |
| B-16 | 生产 near_match 使用 T-24h 至 T-2h 窗口，调度间隔 30 分钟。 |
| B-17 | 生产 live_match 从 T-2h 开始，live 无开赛后 3h 下界，直到 finished；间隔 3 分钟。HTTP 日期查询覆盖被选中的最早开球日。 |
| B-18 | cancelled 自动作废要求 settled_result_version=0，避免 correction 失败后作废已有历史积分；在 §11.2 登记 cancelled 专用边。 |
| B-19 | 补齐未映射诊断枚举，以及 OpenAPI/collection 的三个 DIAG_PROVIDER_* 枚举。现有未映射观察继续写 provider snapshot。 |
| B-20 | 通用 retry 可处理 failed/running correction，使用 correcting 状态；编排入口对该次 correction 执行等级重评。 |
| B-21 | last_eval_as_of 已超过 correction 截面时直接忽略旧截面，避免每周重新倒放已处理的旧 correction。 |
| B-22 | 新增 runSettlementTimer，接入云函数 Timer 和开发 sync 入口，处理首次结算、失败/遗留 running 恢复以及改判队列。结算推进独立于 Provider 是否有配置来源。 |
| B-23 / B-24 | 准备、单 item、失败记录、榜单重排和 finalize 分开事务。item 失败时整笔回滚后另记失败，不再依赖 CloudBase 嵌套 savepoint。后续榜单/finalize 失败保留已 applied 积分，下一次只补齐未完成阶段。 |
| B-25 | reconcileSettledMatch 从已完成 settlement 补齐 match 结算版本、时间和状态；幂等入口继续推进更高 correction 版本。 |
| B-26 | first/retry/correction 在改积分前检查 open blocking anomaly；admin 和 Timer 使用这些入口。 |
| R2 严重-15 残留 | Provider teams/rounds 过滤单条非法记录，合法条目仍可继续处理。 |
| R2 严重-16 残留 | startFirst/retry 不再以之后 correction 的 outcome 替换本次结果。 |

## API 与小程序

| Review ID | 处理结果 |
|---|---|
| A-01 | README 补 crowd、season。登记 POST alias 后共 23 条路径 / 27 个操作。 |
| A-02 | 保留微信实际使用的 POST /profile/me，在 OpenAPI 登记为 PATCH 的兼容别名，使用相同参数和响应。 |
| A-03 | 排行榜响应始终包含 me。 |
| A-04 | 见 B-19。 |
| A-05 | 带 cursor 时也校验 season_id 必须与 league_id 同时提供。 |
| A-06 | 网关的 levels/me、比赛详情、profile/me GET 拒绝未定义 query。 |
| A-07 | 删除排行榜重复 404 响应定义。 |
| A-08 | RankingData 按 week/season/career+strength 分支限定周期和赛季字段。 |
| F-01 | 排行榜请求序号覆盖 profile/groups/levels/首屏和加载更多；切换榜单或筛选后的旧响应不再覆盖当前页面。 |
| F-02 | 比赛列表不再读取合同外的 my_prediction，已提交但本地无比分时显示“已提交预测 · 查看详情”。 |
| F-03 | 周榜实际绑定并展示“仅显示最近 4 周”文案。 |
| F-04 | 实力榜我的排名显示“第 N 名 · 共 M 人”（20 名外继续使用合同提供的百分位）。 |
| F-05 | levels API 提供最近评估 b_points（尚未评估为 null），个人页圆环和门槛使用 B 分，文案说明评估截面。 |
| F-15 | 个人页主队查找和设置页球队列表读取 page.next_cursor。 |
| F-16 | 最近预测尚未结算时使用 pending 样式。 |
| F-17 | 不再从 RankingMe 读取合同外积分字段；从本人列表项展示数值，无可用数值显示“—”。 |
| F-18 | 群加入/创建按钮绑定现有 copy 字段。 |

旧交付记录是历史归档；本记录与当前代码覆盖其过期描述。详情 crowd 已接入，CloudBase counter 已有实现。

## 验证

- TypeScript typecheck、项目 build、cloudfunction:build 均通过。
- Vitest：164 个文件、1553 个用例通过。
- 新增业务回归：Timer 首次入账→改判→重复执行不重复记分；榜锁冲突保留已 applied 积分，后续 Timer 完成收尾。
- 更新与 R3 修正冲突的旧断言，以及使用错误分页合同的模拟数据。
- 未连接真实 CloudBase 或微信开发者工具；未发布云函数。

## 上线登记项

`LEVEL_FIRST_EVAL_AS_OF` 仍为 null，`RANKING_FIRST_PERIOD_KEY=2026-W31` 仍是开发占位；实际首评日期必须根据上线日期登记，并与首榜周对齐。本轮没有虚构上线日期。未登记时的回放已修复为基线语义，不再保留错误缓存。
