# 赛季榜与 Luna review 修复交付 v1.0

日期：2026-10-09。输入：`MVP2.0__COMPLIANCE_REVIEW__v1.0.md`。以当前业务规范、S14 和用户已确认的产品决定为准，只处理功能缺口；第三方报告保留原文。

## 逐项复核与处置

| Review ID | 核实结论与本轮结果 |
|---|---|
| Z09 | 确认缺陷，已修复。`available_level_seasons` 排除无快照、仅有 head、当前榜仅有已注销用户的赛季；历史终榜保留已注销入榜者，按赛季倒序。新增空榜、空终榜和注销用户回归。 |
| Z09 / Z14 关联缺陷 | 原小程序用选择器第一项代表当前赛季。过滤空赛季后第一项可能是上赛季；改为由 `server_now` 推出当前赛季，历史赛季不显示群入口，切换历史赛季强制全站。新增页面回归。 |
| B02 | 已统一使用 `isSeasonRankEligible`，查询路径不再内联 `>= 1`。 |
| Z12 | 终榜不应随之后的统计修正或当前赛季重建而改变。这是冻结终榜的产品规则，已补专项回归：冻结上赛季 → 改上赛季统计 → 重建当前赛季 → 原终榜逐字段不变。实现无需调整。 |
| M07 | 已修复。群列表、详情的文案全部读取 `rankings-copy.js`，含人数规则、邀请码说明与状态提示。创建成功提示中的“群设置”改为已有的“群详情”。 |
| B-README-tab | 已修复三项 tabBar 总述；同步当前 10 个页面、四榜和比赛页接口数据来源。 |
| A2 / R10 | 保留 `new-season` 临时榜场景，新增 `new-season-final` 终榜场景；分别覆盖 R11 和 R10。种子测试与 HTTP 实测均确认两者不同。 |
| R02 | 空群周榜使用“群里本周还没有人入榜”。 |
| R13-hint | 周榜补充“仅显示最近 4 周”脚注。 |
| R17 | 实力榜已入榜的“我的排行”显示“第 N 名 · 共 M 人”，M 来自 `entry_count`。 |
| Luna-M02 | 个人上赛季回顾补充 `previous_season.valid_predictions`，展示有效预测场次。新增页面测试。 |
| Luna-M03 | 无群状态保留邀请码加入和创建群两个入口；加入进入已有 join 页面，创建调用已有 `POST /v1/groups` 后进入已有详情页。无新增接口。新增页面测试。 |
| Luna-P03 | 最近预测翻尽后显示“没有更早的预测了”；保留有下一页时继续加载的行为。新增翻页回归。 |
| Luna-P04 | 空状态行动文案改为“去预测”。 |
| X10 | 不作为功能缺陷修改。规范 §19.10.8 / 开发计划 F12 明确：请求者窗口 n < 50 时不返回 strength 标签。`below_threshold` 接口状态继续保留，不能为使其 UI 可达而违反标签规则。 |
| R18 | 与用户此前“不隐藏相对更新时间”的决定冲突，沿用该决定。前端继续以 `server_now` 计算相对更新时间；现有接口缺少最近提交预测时间，不能用得分时间或快照时间冒充。本轮未增加合同字段；Luna §0 已标明该差异。 |
| R03 / R04 | 无领奖台和少人分档已实现；第 1 名放大属于纯视觉差异，按本轮只做功能的范围保留现状。 |
| CB-B03 / CB-B05 | 用户已明确延期的 S13 B 段。CloudBase 聚合方法仍保留明确未实现标记；真实 SDK、事务能力确认与降级方案需要真实环境，本轮未进行。 |
| Luna-C / Luna-V1 / Luna-V2 / Luna-V3 | 本文件补齐交付记录、已跑检查、接口缺口、调试命令及各场景“未实测”状态。没有把自动化或 HTTP 检查写成微信开发者工具验收。 |

## 修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/application/ranking-query.ts` / `.test.ts` | 资格函数复用、空赛季过滤及回归 |
| `src/application/rebuild-service.test.ts` | 终榜在统计修正和当前赛季重建后保持不变 |
| `src/gateway/seed.ts` / `.test.ts` | 新增 `new-season-final`，与临时榜分别验证 |
| `src/api/v1/openapi.yaml` | 补充已有 `available_level_seasons` 字段的非空赛季语义，无字段或状态码变更 |
| `miniprogram/utils/rankings-view-model.js` | 向页面提供由服务端时间计算的当前赛季 |
| `miniprogram/utils/rankings-copy.js` | 群文案、回顾场次、翻页结束与周榜脚注 |
| `miniprogram/pages/rankings/rankings.js` / `.wxml` / `.wxss` | 历史赛季范围控制、实力榜人数、周榜脚注 |
| `miniprogram/pages/groups/groups.js` / `.wxml`；`detail.js` / `.wxml` | 页面文案接入 copy |
| `miniprogram/pages/profile/profile.js` / `.wxml` / `.wxss` | 回顾有效预测数、无群创建和加入入口 |
| `miniprogram/pages/my-predictions/my-predictions.js` / `.wxml` / `.wxss` | 翻页结束提示与空状态文案 |
| `miniprogram/pages/match-detail/match-detail.wxml` | crowd 占位注释更新为“后端已完成，前端另开切片” |
| `miniprogram/pages/compliance.workflow.test.mjs` | 历史赛季首选项、个人回顾/群操作、预测翻页回归 |
| `README.md`、`docs/LUNA_MINIPROGRAM_UPDATE__v1.0.md`、`docs/INDEX.md`、本文 | 当前导航、场景、产品决定、交付与验证记录 |

## 自动化与 HTTP 验证

- `npm run typecheck`：通过。
- `npm test`：142 个测试文件、1413 条用例通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 本轮未改首页或全局 token，无需运行首页迁移校验脚本。

通过真实本地 HTTP 请求 `127.0.0.1:8787/v1/rankings?board=season&scope=global` 验证；每个场景启动独立内存网关，完成后关闭，本次实测使用开发身份：

| 场景 | HTTP | entry_count | is_provisional | available_level_seasons |
|---|---|---|---|---|
| `normal` | 200 | 24 | false | `2026_2027`, `2025_2026` |
| `empty` | 200 | 0 | false | `[]`；`available_boards` 不含 season |
| `new-season` | 200 | 24 | true | 仅 `2025_2026` |
| `new-season-final` | 200 | 24 | false | 仅 `2025_2026` |

两个交接场景再显式请求该历史赛季，均返回 200。HTTP 验证不等于微信开发者工具或真实 CloudBase 验证。

## 微信开发者工具走查状态

本环境未打开微信开发者工具，以下各场景 × 页面全部标为 **未实测**。自动化已核对种子数据和部分页面逻辑，不代表渲染或交互走查通过。

| 场景 | 对应页面 / 设计状态 | 开发者工具 |
|---|---|---|
| `normal` | 排行榜 R06；我的 M01 | 未实测 |
| `empty` | 排行榜 R01 | 未实测 |
| `thin1` | 排行榜 R03 | 未实测 |
| `thin2` | 排行榜 R04 | 未实测 |
| `thin5` | 排行榜 R05 | 未实测 |
| `no-group` | 排行榜 R16；我的 M03；群 G01 | 未实测 |
| `first-season` | 排行榜 R08 | 未实测 |
| `new-season` | 排行榜 R11；我的 M02 | 未实测 |
| `new-season-final` | 排行榜 R10；我的 M02 | 未实测 |
| `predictions-long` | 最近预测 P01–P03 | 未实测 |
| 游客（清空 mock 身份） | 排行榜 R07；详情 D10 | 未实测 |
| 其余页面状态 | 排行榜 R02 / R09 / R12–R15 / R17；比赛详情 D01–D12；空预测 P04；群 G02–G03 | 未实测；需在工具内操作或准备相应比赛状态，不能声称现有种子覆盖全部状态 |

R18 沿用上述保留更新时间的产品决定。比赛详情 D03–D12 中 crowd 的部分继续关闭，属于后续前端切片。R03/R04 的放大卡片为已记录视觉偏差。

## 启动与切换

```sh
npm run gateway:dev
FOOTBALL_SEED_SCENARIO=new-season npm run gateway:dev
FOOTBALL_SEED_SCENARIO=new-season-final npm run gateway:dev
FOOTBALL_SEED_SCENARIO=predictions-long npm run gateway:dev
FOOTBALL_MOCK_TRUSTED_OPENID= FOOTBALL_SEED_SCENARIO=normal npm run gateway:dev
```

每次切换前先停止旧网关。微信开发者工具打开 `miniprogram/`，`gatewayOrigin` 使用 `http://127.0.0.1:8787`，勾选“不校验合法域名”。使用现有游客 appid 与开发测试身份。

## 接口缺口与后续范围

- 本轮修复所需的积分、有效预测数、人数与群操作接口均已具备，没有在客户端造字段。
- R18 若改为采用隐藏规则，需要另行确认最近提交预测时间的接口来源；本轮遵循此前决定保留更新时间。
- S14 crowd 后端已完成，详情展示与首页入口尚未接入，仍为后续前端切片。
- S13 B 真实 CloudBase 接线、事务验证与数据回填，以及上线周从 `2026-W31` 同步改为真实上线周，继续按此前决定延期。
