# 赛事预言家 MVP 规范反向 Review 发现清单 v1.0

> 评审时间：2026-08-11
> 评审方式：Claude Code + Grok 4.5（high 推理），并行两路覆盖全文
> - Part 1：规范第 0–23 节（领域规则、时间、状态机、计分、账本、修正、排行榜）
> - Part 2：规范第 24–48 节（API Contract、限流、Schema、Provider 同步、验收矩阵、第 48 节冻结决策）
> 评审视角：编码 Agent 仅凭本规范能否无歧义实现；只列高置信问题。
> 结论统计：**歧义 25 条、冲突 11 条、不可测试 12 条**

---

## 一、总览

| 类别 | Part 1（0–23 节） | Part 2（24–48 节） | 合计 |
|---|---|---|---|
| 歧义 AMBIGUOUS | 10 | 15 | 25 |
| 冲突 CONFLICT | 4 | 7 | 11 |
| 不可测试 UNTESTABLE | 5 | 7 | 12 |
| **合计** | 19 | 29 | **48** |

---

## 二、致命问题（不冻结则编码无法正确开工）

### F1. 鉴权/会话契约完全缺失（Part2-A1）

- **涉及小节**：24.1 / 23.x / 36.2
- **原文摘录**：「Auth required」「需要可信微信运行环境」「openid 必须从服务端微信上下文获取」「trusted 微信上下文 -> openid -> user_id」
- **问题**：全规范未定义会话/鉴权载体：`POST /v1/session/init` 是否签发 token、后续请求用什么 Header/Cookie、CloudBase 上下文如何注入、未登录与登录失效的判定边界。
- **影响**：编码 Agent 无法实现任何 `Auth required` 接口；会自行发明 JWT/session/header，直接违反「不得自行改变 API 字段/错误码」。
- **建议**：冻结鉴权传输方式、session 生命周期、401/USER_DELETED 触发条件、init 与后续请求的身份绑定规则。

### F2. 预测拒绝原因/错误码双轨制（Part2-A5/A6/C7）

- **涉及小节**：25.1 / 25.2 / 8.4 / 26.1 / 23.7
- **原文摘录**：GET `can_predict_reason` 枚举 `null/AUTH_REQUIRED/USER_DELETED/ALREADY_SUBMITTED/KICKOFF_UNCONFIRMED/NOT_SCHEDULED/CLOSED`；POST 错误码有 `MATCH_NOT_PREDICTABLE`、`PREDICTION_LOCKED`、`PREDICTION_ALREADY_SUBMITTED` 等。
- **问题**：两套枚举不同集，规范未声明等价关系；`postponed/cancelled/abandoned`、`prediction_deadline_at==null`、仅 `closed_at!=null`、仅超时分别映射到哪个 reason/code 未定义；`CLOSED` 语义过宽。
- **影响**：同一业务拒绝被实现成不同 code；前端与验收矩阵无法稳定断言。
- **建议**：建立统一的「条件 → HTTP → code → can_predict_reason」映射表，注明互斥优先级。

### F3. 状态机硬冲突：11.2 禁止 `settling->correcting`，15.9 却要求它（Part1-C1，已对照代码验证属实）

- **涉及小节**：11.2 vs 15.9
- **原文摘录**：11.2 合法转移仅有 `settling -> settled | failed`，**无** `settling -> correcting`。15.9：某 version `v` finalize 后若 `result_version > v`，则 `matches.settlement_status = correcting`（此时首次结算通常仍处于 `settling`）。
- **问题**：首次结算执行中出现更高 `result_version` 时，15.9 要求的状态迁移被 11.2 明文禁止。
- **已验证**：`src/domain/settlement-state-machine.ts` 的 `ALLOWED_TRANSITIONS` 严格按 11.2 实现，无 `settling->correcting`；而 `settlement-orchestration-service.ts` 已有 correcting 处理逻辑——状态机层与编排层矛盾。
- **影响**：Agent 要么违反状态机，要么无法按 15.9 衔接 correction 队列；部分失败恢复与验收用例互相打架。
- **建议**：在 11.2 增加 `settling -> correcting`（或强制 `settling -> settled` 仅当 `result_version==v`，再 `settled -> correcting`，并改写 15.9 为两步原子转移）。

---

## 三、高风险问题

### H1. 延期 × 截止关闭互相矛盾（Part1-A1/C2）

- **涉及小节**：6.4 vs 6.5
- **问题**：6.4「到点关闭且不可重开」未限定 `match_status==scheduled`；截止前延期进入 `postponed` 后，若墙钟越过旧 `prediction_deadline_at` 是否触发关闭未定义。6.5「截止前延期可在新 kickoff 后重开」与 6.4 直接矛盾。
- **影响**：延期重赛的预测入口对错取决于实现顺序，属于确定性业务分叉。
- **建议**：以产品二选一写死，并加状态×时间真值表（scheduled/postponed × now ? deadline × closed_at）。

### H2. rebuild 验收 oracle 错误（Part2-C3/U7）

- **涉及小节**：44.109 vs 35.2 / 34.x
- **问题**：44.109「rebuild_period_rankings 后与事实 predictions 完全一致」；但 35.2 规定 rebuild 来源是 `status=applied` 的 settlement_items 与 match 归属，不是 raw predictions。验收标准把事实源说成 predictions。
- **影响**：编码 Agent 会按验收误实现 rebuild 输入，或测试与实现互相否定。
- **建议**：将 109 改为「与 applied settlement_items + period_anchor 归属规则完全一致」，并补 fixture→期望聚合金样例。

### H3. 管理端 retry/rebuild/审计契约互相打架（Part2-C2/A11/C6）

- **涉及小节**：30.4 vs 48.5、21.14 / 30.3 / 30.6 / 30.5 / 30.4
- **问题**：audit `reason` required，但 retry-settlement 与 rebuild-users 接口无 reason 输入来源；30.4 允许「存在 failed settlement」即可 retry（不要求 match status），48.5 又用 match status 分支错误码（`409 SETTLEMENT_NOT_READY` / `500`），settling/correcting 时是否允许 retry 两边口径不同。
- **影响**：管理员链路是结算恢复最后手段，实现错了直接制造账本风险。
- **建议**：统一所有管理写接口的 reason 必填契约（或允许系统 reason），合并 retry 为单一决策表：前置条件、目标 settlement 选择、各失败码。

### H4. 48 节与 0.1 的冲突裁决规则本身冲突（Part2-C1）

- **涉及小节**：0.1 vs 48 引言
- **问题**：0.1 说冲突按文档优先级执行；48 说「与正文同优先级；与正文冲突时以更具体的小节为准」——「更具体」无机械化判定。
- **影响**：正文与 48 细节不一致时 Agent 无法决定服从哪边，只能停工或自决。
- **建议**：规定 48.x 对点名接口/枚举/审计字段覆盖正文，其余保留 0.1，并给冲突示例。

### H5. 多个 API 响应 schema 未冻结（Part2-A7/A8/A10）

- **涉及小节**：26.2（predictions 列表）、28.2（unlocks）、30.2（admin anomalies）
- **问题**：只有散文要求，无机器可执行 contract：字段名、嵌套结构、赛果 null 形态、排序规则均未冻结。
- **影响**：Agent 只能 invent 响应形状，OpenAPI 对齐（43/45）无从谈起。
- **建议**：为每个接口补齐完整 Response schema（字段、类型、nullable、排序）。

---

## 四、完整问题清单

### 4.1 歧义（25 条）

| 编号 | 小节 | 问题摘要 | 建议 |
|---|---|---|---|
| P1-A1 | 6.4 / 6.5 | 截止前延期进入 postponed 后，墙钟越过旧 deadline 是否仍触发 6.4 关闭？规范未限定 6.4 仅在 scheduled 触发 | 明确：到点关闭仅在 `match_status==scheduled`（或 kickoff_confirmed 且非 postponed）触发；postponed 期间不得因旧 deadline 关闭；仅 6.5「截止后才发现延期」分支按旧 deadline 关闭 |
| P1-A2 | 13.3 | `settlement_status in [waiting, failed, settled]  // 视首次或修正而定` 未给确定性谓词 | 拆成两条完备规则：首次 `status==waiting` 且保护期到；修正 `status in {settled,failed}` 且有未处理更高版本；写明原子转移 |
| P1-A3 | 15.7 | 修正 0→3/12 或 3→12 且 anchor 更晚时，是否更新 `last_scoring_match_at` 未定义 | 补全修正矩阵：`new_score>0` 时 `max(existing, anchor)`；`new_score==0` 且原 last 来自本场时重算；其余保持 |
| P1-A4 | 13.3 | 「没有 open blocking anomaly」范围未定义（仅本 match？含哪类 type？） | 写死：`exists anomalies where match_id=X AND blocking=true AND status=open` 则禁止结算；并列允许结算的 type 白名单 |
| P1-A5 | 6.5 | 「明确 kickoff」无判定标准；延期中间态字段保持旧值/改 null 未冻结 | 用字段赋值表冻结 postponed 中间态与恢复态 |
| P1-A6 | 14.2 / 15.2 | 「每个需要实际应用的 result_version 建立一个 settlement」与「可跳过中间版本」边界未形式化 | 定义 `needs_settlement(v) <=> v > settled_result_version AND (首次未启动则仅最新 v；已启动后每个 v 连续排队)` |
| P1-A7 | 17.7 | `level_history.reason` 枚举含 `season_start` 但未定义何时写入 | 明确触发点，或 MVP 删除该 reason |
| P1-A8 | 20 | 「取消/未结算/无效比赛不计」无枚举映射 | 改为：仅计入 `match_status==finished` 且 prediction 已 applied 的场次；其余不计 |
| P1-A9 | 11.1 / 14.2 | match 与 settlement 两套同名状态无强制对照表 | 增加状态对照表与双方字段同时满足的 invariant |
| P1-A10 | 7.1 | 周序号是否固定两位（W01 vs W1）、上海转 ISO 的口径未冻结 | 冻结：上海本地日历日 → ISO week-year → 格式 `YYYY-Www`；给跨年边界样例 |
| P2-A1 | 24.1 / 23.x / 36.2 | 鉴权/会话载体完全未定义（见 F1） | 冻结鉴权传输方式、session 生命周期、401/USER_DELETED 触发条件 |
| P2-A2 | 24.1 | 已存在用户再次 init 时 nickname 忽略/覆盖/409？返回旧值还是新值？ | 明确幂等语义与 200 响应字段来源 |
| P2-A3 | 23.3 | `X-Request-Id`「格式合法」无定义 | 给出正则或 ABNF，以及非法时忽略还是 422 |
| P2-A4 | 25.1 | `from/to` 过滤字段、开闭区间、只传一端、90 天计算口径、越界错误码未定义 | 写死过滤字段、区间语义、422 条件与 details |
| P2-A5 | 25.1 / 25.2 / 8.4 | `can_predict_reason` 各失败条件映射不完备（见 F2） | 给出失败条件 → reason 完备映射表与优先级 |
| P2-A6 | 26.1 / 23.7 / 8.4 | 提交失败条件无「条件 → HTTP → code」表（见 F2） | 增加映射表并注明互斥优先级 |
| P2-A7 | 26.2 | predictions 列表无响应 JSON schema | 像 25.1/26.1 一样给出完整 item schema |
| P2-A8 | 28.2 | unlocks 无字段定义、默认资源配置清单缺失 | 冻结完整 Response schema + 默认资源配置清单 |
| P2-A9 | 24.3 / 24.5 / 26.3 | PATCH 成功 status/body、user_id 不存在、favorite_team_id 非法、注销用户访问 `/me` 的错误码均未定义 | 为每个接口补齐成功/失败矩阵与 body |
| P2-A10 | 30.2 / 48.1 | anomalies 列表 item 字段、details 形状、resolved 记录是否含 resolution 未定义 | 补充 response item schema 与 cursor 响应 envelope |
| P2-A11 | 30.4 / 30.5 / 48.2 / 21.14 | retry/rebuild users 的 audit `reason` 从哪来未定义 | 补 reason 请求字段，或明确系统生成模板 |
| P2-A12 | 32.3–32.5 / 32.7 | 调度 `T` 是 kickoff_at 还是 period_anchor_at？postponed 重算窗口？sync lease 时长未定义 | 冻结 T 定义、状态过滤、各 job 频率与默认 lease |
| P2-A13 | 33.1 / 33.6 | 「成功同步」粒度、各 anomaly type 自动 resolve 条件未逐条定义 | 为每个 anomaly type 写 open/resolve 谓词 |
| P2-A14 | 36.4 | public source 标识算法、窗口对齐、429 headers、多中间件叠加规则未定义 | 定义 source key、计数窗口、429 body/headers、叠加规则 |
| P2-A15 | 48.2 | retry 部分成功时 count 口径、outcome 判定未精确定义 | 精确定义计数口径与 outcome 判定 |

### 4.2 冲突（11 条）

| 编号 | 小节 | 冲突双方 | 问题摘要 | 建议 |
|---|---|---|---|---|
| P1-C1 | 11.2 vs 15.9 | `settling->correcting` 被禁止却要求 | 首次结算中出新版本时状态机矛盾（见 F3） | 11.2 增加该转移，或改为两步原子转移 |
| P1-C2 | 6.4 vs 6.5 | 到点关闭不可重开 vs 延期后可重开 | postponed 期间是否按旧 deadline 关闭（见 H1） | 产品二选一 + 状态×时间真值表 |
| P1-C3 | 11.1 vs 11.2/48.6 | `settling`=「首次」语义 vs failed retry 仍进 settling | retry/correction 路径可能选错 match 状态 | 重写 11.1 用 `settled_result_version` 界定 settling/correcting 并与 `is_correction` 绑定 |
| P1-C4 | 9.4 / 11.2 / 11.3 | cancelled ⇒ voided vs 部分状态无 void 路径 | `failed/settling/correcting` 期间变 cancelled 路径未定义 | 补全 cancelled 相对每种 settlement_status 的动作表 |
| P2-C1 | 0.1 vs 48 引言 | 优先级规则 vs 同优先级+更具体 | 冲突裁决规则本身冲突（见 H4） | 规定 48.x 对点名项覆盖正文，其余保留 0.1 |
| P2-C2 | 30.4 vs 48.5 | retry 前置条件 vs 错误码分支 | settling/correcting 是否允许 retry 口径不同（见 H3） | 合并为单一决策表 |
| P2-C3 | 44.109 vs 35.2 | rebuild 事实源：predictions vs settlement_items | 验收 oracle 错误（见 H2） | 改为 applied settlement_items + anchor 归属 |
| P2-C4 | 42.1 vs 22.2 | 分享卡按 season/round 索引查询 vs 索引清单无此索引 | 性能硬要求与索引不匹配 | 22.2 增补所需索引，或改写 42.1 |
| P2-C5 | 23.8 vs 48.1 | cursor 绑定规则列举式未留扩展点 | anomalies 分页规则可能漏实现或复制冲突 | 23.8 改通用规则 + 资源表 |
| P2-C6 | 21.14 / 30.x | audit reason 必填 vs 一半管理接口无输入来源 | 实现违反 schema 或私自加字段（见 H3） | 统一 reason 契约或系统生成 |
| P2-C7 | 25.1 vs 8.4 / 26.1 | can_predict_reason 与提交错误码不同集 | 前后端语义分叉（见 F2） | 建统一枚举或对照表 |

### 4.3 不可测试规则（12 条）

| 编号 | 小节 | 原文摘录 | 问题 | 建议 |
|---|---|---|---|---|
| P1-U1 | 2.3 / 6.3 / 13.2 | 「只允许使用可信服务端时间 `server_now`」 | 未要求 server_now 可注入/可冻结，边界测试只能 flaky | 规范要求领域层只读 `Clock.now()` 端口；验收允许固定 server_now |
| P1-U2 | 3 | `SYNC_RETRY_JITTER_PERCENT = 20` | 随机 jitter 无种子/上界断言 | jitter 改确定性函数（如按 sync_job_id hash）或测试环境 jitter=0 |
| P1-U3 | 10.2 | 「所有跳转仍必须满足 Provider 数据合法性」 | 「合法性」无谓词 | 把合法前置条件写成可执行列表并与 31.x 对齐 |
| P1-U4 | 15.1 | 结算锁「lease 默认 10 分钟，可续租」 | 续租触发条件/周期/失败是否丢锁未定义 | 规定续租时机、lease_until 公式、过期 CAS 接管 |
| P1-U5 | 19.7 | 「周期边界结束后：`is_final = true`」 | 由谁、以何频率、何公式写入未定义 | 内嵌 period_end 公式 + 异步任务时限或引用 32.6 为唯一写入点 |
| P2-U1 | 44.B.14 | 「修改客户端手机时间不能绕过」 | 依赖客户端环境，后端无法构造确定性输入 | 改为纯服务端断言：截止判断只读 server_now |
| P2-U2 | 42.1 | 「正常条件下目标 p95 处理时间 <= 500ms」 | 「正常条件」/采样/负载模型未定义 | 标为非门禁 NFR 或给固定基准环境与阈值口径 |
| P2-U3 | 42.2 | 「finished 后 10 分钟开始；15 分钟内完成」 | 依赖 Provider 到达与外部网络 | 门禁只验证 finish_detected_at+10m 可结算；15 分钟标为 SLO 非 DoD |
| P2-U4 | 32.8 | 「每次加入 ±20% jitter」「最多 5 次」 | 随机源不可注入，重试测试 flaky | 要求可注入 clock/random；断言退避序列落在 [0.8,1.2] 倍区间 |
| P2-U5 | 33.1 / 32.x / 34.4 | 「连续 10 分钟」「每天至少 1 次」 | 依赖真实墙钟与调度器 | anomaly/consistency 逻辑必须接受注入 server_now；调度频率与业务谓词分离测试 |
| P2-U6 | 36.4 / 45 | 限流默认值 + DoD「核心逻辑全部满足」 | 限流是否属 DoD 不明确，窗口边界难断言 | 限流标为基础设施门禁给可重复测试算法，或移出核心 DoD |
| P2-U7 | 44.109 / 45 | 「rebuild…完全一致」「第 44 节最低验收测试全部通过」 | oracle 不唯一（见 H2） | 先修 C3，再补 fixture→期望聚合金样例 |

---

## 五、与现有实现的关系

- 规范 11.2↔15.9 冲突（F3）已在代码中实证：`src/domain/settlement-state-machine.ts` 无 `settling->correcting` 转移，`settlement-orchestration-service.ts` 却包含 correcting 衔接逻辑，两处不一致。
- 其余问题大多属于「规范未冻结、实现时靠 Agent 自决」的范畴；当前 835 个测试全绿不代表这些问题不存在，只代表实现选择了某一种合法解读。

---

## 六、后续动作建议

1. **先冻结 Top 3 致命项**（F1 鉴权契约、F2 预测错误码映射、F3 结算状态机），不冻结则编码继续会踩雷。
2. 中等问题（H2 响应 schema、H3 reason 来源、H5 schema 未冻结）并入下一版冻结决策逐条补。
3. 不可测试项统一要求：领域层 `Clock.now()` 注入、jitter 确定性化、调度频率与业务谓词分离——作为测试基建写入规范。
4. 本文档可作为 44.109/45 等验收条目修订的输入。

---

## 七、产品确认记录（2026-08-11）

已确认并写入 `MVP__v1.0.md` **第 49 节 补充冻结决策 v1.2**：

| 决策 | 冻结内容 | 对应问题 |
|---|---|---|
| 鉴权 | 网关注入可信 openid；后端不发明 JWT/Cookie 登录协议 | F1 |
| 预测失败映射 | 固定优先级表：条件 → can_predict_reason → HTTP/code | F2 |
| 结算状态机 | 允许 `settling → correcting`，与 15.9 对齐 | F3 |
| 延期关闭 | 仅 scheduled 到点关闭；postponed 不因旧 deadline 关死 | H1 |
| rebuild 事实源 | 以 applied settlement_items + period 归属为准 | H2 |

**尚未冻结（仍见本文档）**：H3 管理端 reason/retry、H4 冲突裁决规则、H5 响应 schema、全部 U 类不可测项。

---

> 生成：Claude Code + Grok 4.5 反向 Review（2026-08-11）
> 原始分报告：Part1 歧义10/冲突4/不可测5；Part2 歧义15/冲突7/不可测7
> 产品确认：2026-08-11 已冻结第 49 节 v1.2
