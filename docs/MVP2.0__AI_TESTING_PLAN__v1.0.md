# MVP 2.0 小程序测试分工方案 v1.0(人工 vs AI / Agent)

> 依据:`MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md` 的 §5、§7.10、§10、§15.7、§16.5–16.7,以及仓库内已有的 vitest 与小程序 `*.test.mjs`。
> 目的:尽量减少只能人工手动测试的工作,用 AI / Agent 可以测试的部分代替。
> 注意:`miniprogram-automator` 能否在用户本机运行**尚未验证**,见第六节检测提示词。

## 一、前提

文档 §10.2 已把前端拆成「视图模型纯函数 + 薄薄一层 wxml」,大部分逻辑测试不需要打开界面。剩下需要界面的部分分两类:

- 渲染对不对:元素有没有出现、条件显隐是否正确。
- 好不好看:视觉、手感。

## 二、必须人工测试(不能省,也无法交给 AI)

| 项 | 为什么 AI 做不了 |
|---|---|
| 真实微信登录、真机体验版全链路(§16.7:进入→游客→登录→看榜→预测→重进仍是同一用户) | 需要用户的微信账号、手机和真实 AppID。AI 不能替用户扫码或授权。 |
| 云开发控制台配置(§16.6、§17.3:建环境、建集合和索引、环境变量、云函数上传、隐私指引) | 账号操作,代码做不了。配完后 AI 可通过 `diag` 自检动作帮忙核对。 |
| 真机手感与兼容性(iOS / 安卓各一台:刘海屏安全区、键盘遮挡、滚动手感、弱网) | 开发者工具模拟器与真机有差异。 |
| 视觉验收(S12 换设计稿后「好不好看、像不像设计稿」) | AI 能查明显错位或溢出,不能做审美判断。 |
| 微信审核与合规(隐私指引文案、类目、提审) | 平台流程。 |
| 真实数据源联调的最终确认(football-data、BSD 的真实赛日数据与延迟) | 要等真实比赛日,AI 只能看日志,无法让比赛发生。 |
| 产品决策(文案口吻、§7.11 待确认项) | 用户自己的判断。 |

合计每个版本约为:一次真机冒烟 + 一次视觉验收 + 一次性的账号配置。

## 三、可以省略或降级

- 占位 UI 的像素级视觉测试:`ui-placeholder` 会被 S12 整体替换,现在测是浪费(§10.3 已写占位 wxml 不要求测试)。
- 性能压测、大规模并发:MVP 用户量小,加索引即可,有数据后再说。
- 多机型矩阵、低版本基础库兼容:2 台真机 + 1 个最低基础库版本即可。
- `http` 本地网关的人工点测:`transport=http` 仅用于开发,有回归测试覆盖。
- 安全渗透测试:做一次 §16.5 的「body 带 openid 不能冒充身份」单测即可。

## 四、可以交给 AI / Agent 测试

### 1. 纯逻辑单测(预期效果最好)
- 范围:domain、写路径、快照、API、视图模型(`crowd-view-model`、`rankings-view-model`)、文案文件。
- 做法:AI 按 §5 清单写 vitest 与 `node --test`,自己运行、自己修复。
- 预期:几乎全自动;`npm test` 全绿说明逻辑层无回归。
- 局限:只能证明「和断言一致」。断言写错测试照样绿,所以要让 AI 对照规范写边界用例,并抽查几条。

### 2. 页面逻辑测试(假 `wx` 对象)
- 范围:§15.7 的「未截止不发 crowd 请求(spy)」「失败时表单仍渲染」「过期响应被丢弃」「401 当游客」。
- 做法:在 Node 里用 mock 的 `wx`、`Page()`、`callFunction` 直接驱动页面对象(参考 `matches.workflow.test.mjs`)。
- 预期:全自动,覆盖大部分前端行为问题,不需要界面。

### 3. 云函数 / 后端契约测试
- 范围:`getWXContext` mock、401 / 409 / 422、日志不含完整 openid、openapi 合同。
- 预期:全自动。
- 局限:证明的是代码逻辑,不能证明真实 CloudBase 环境配对了(归人工)。

### 4. 界面自动化:`miniprogram-automator`(微信官方)
- 能力:通过开发者工具 CLI 启动小程序,用脚本跳转页面、读取元素、点击、输入、截图,可 mock `wx` 接口返回。
- 做法:AI 写脚本,用 mock 响应(空榜、少人、20 人以上、游客、赛季交接)逐个进入页面,断言 `.ui-placeholder` 是否出现、tab 数量、「常态下新增块全部不出现」等,同时截图存档。
- 预期:自动回答「这个状态下该出现的块出现了没有」,把 §10.4 的「常态逐像素一致」变成可重复检查。
- 限制:
  - 依赖微信开发者工具,只有 Windows / Mac 版;本机(Linux)不能跑,只能在用户电脑上跑。
  - 需在开发者工具开启服务端口。
  - 登录态用 mock 解决,真实登录仍归人工。
  - 需要一次搭建成本,之后回归才省力。

### 5. 截图让 AI 看并检查
- 做法:把第 4 项截的图交给 AI,检查文字截断、重叠、空白块、错别字,以及与 `docs/design/.../index.html` 设计稿的大致差异。
- 预期:作为第一道筛,筛掉明显错位,让人工视觉验收只看细节。
- 局限:不是像素比对,对微小间距或色差不可靠,不替代审美判断。

### 6. 云环境自检(半自动)
- 做法:用户配好环境后,AI 调用 `diag` 并读取分类后的错误(§17.6–17.7),指出缺哪个索引、哪个环境变量。
- 预期:把排错从手动翻控制台变成 AI 读诊断输出。

### 7. 数据源适配器(§18)
- 做法:用真实 API 返回的样例(fixture)做回放测试(已有 `provider-fixture-loader`)。
- 预期:映射、窗口规则、限流预算全自动;真实联调只需抽样看日志。

## 五、测试节点

| 节点 | 做什么 | 谁来做 |
|---|---|---|
| 每次改代码 | `npm run typecheck` + `npm test` | AI 自动 |
| 每个切片完成 | 加跑 automator 状态走查 + 截图,AI 看图出报告 | AI,用户只看报告 |
| 联调云环境后 | `diag` 自检 | 用户配置,AI 读结果 |
| 提审前 | 真机冒烟、隐私指引、视觉验收 | 用户 |
| S12 换视觉稿后 | AI 截图初筛,用户做最终视觉验收 | 两者结合 |
| 真实比赛日 | 看日志、核对比分同步 | 用户抽样,AI 分析日志 |

## 六、落地建议与 automator 检测提示词

1. 人工工作压到三件事:账号与环境配置、真机冒烟一次、视觉验收一次。
2. 值得投入的是第 4 项(automator):前端状态多(D01–D12、X01–X16),脚本化后每次回归不用再点。
3. 报告里要区分「单测通过」与「真环境验证」(§15.8、§16.7 已有此要求)。

下面的提示词发给用户本地的 AI,先检测 automator 能否使用;能用则继续试点并打包素材,发回核查。

````markdown
# 任务:检测本机能否用 miniprogram-automator 自动化测试本项目小程序;能用则搭建试点并产出可核查的素材包

项目目录:football 仓库根目录(小程序在 `miniprogram/`,后端在 `src/`,开发文档在 `docs/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md`)。
目标:尽量用自动化代替人工点测。本任务只做"能不能用"的检测,以及能用时的一个排行榜页试点。不要改业务逻辑,不要改后端,不要改现有页面的 wxml/wxss/js。

## 总规则

1. 先读后做:先读 `docs/MVP2.0__SEASON_BOARD_DEV_PLAN__v1.0.md` 的 §10(前端占位策略)、§5 和 §7.10(测试清单),再读 `miniprogram/pages/rankings/*`、`miniprogram/utils/rankings-view-model.js`、`miniprogram/services/rankings.js`,弄清排行榜页有哪些状态。
2. 不要编造结果。每一步的命令、输出、报错都要原样记录。做不到的就写"未做到"并说明原因,不要写成成功。
3. 新增文件只放在 `tests/automator/` 目录下(如不存在就创建)。如需新增 npm 依赖,只能加到 devDependencies,并在报告里说明。
4. 不要泄露隐私:截图、日志里不得出现完整 openid、token、AppSecret。出现了就打码或重截。
5. 遇到需要我本人操作的步骤(如在开发者工具里点开关、登录),停下来,把具体步骤写给我,等我确认后再继续。

## 阶段 A:环境检测(逐项给出 通过/不通过 + 证据)

A1. 操作系统与版本。
A2. Node 版本(项目要求 >=18)。
A3. 微信开发者工具是否已安装,记录安装路径和版本号。找不到就停止并告诉我怎么装。
A4. 开发者工具的 CLI 是否可用:
    - Windows 通常在安装目录下的 `cli.bat`,Mac 在 `/Applications/wechatwebdevtools.app/Contents/MacOS/cli`。
    - 运行 `cli --version` 或 `cli open --project <项目绝对路径>`,记录输出。
A5. 开发者工具的"服务端口"是否已开启(设置 → 安全设置 → 服务端口)。没开就停下来,写出让我点哪里。
A6. 项目能否在开发者工具里正常打开:读取 `project.config.json`,确认 AppID 已配置、`miniprogramRoot` 指向 `miniprogram/`。记录开发者工具有没有报编译错误。
A7. 安装 `miniprogram-automator`(devDependency),确认能 `import`。
A8. 写一个最小脚本 `tests/automator/smoke.mjs`:
    - `automator.launch({ projectPath })` 启动并连接;
    - 打开首页,读取当前页面路径;
    - 截一张图保存到 `tests/automator/out/smoke.png`;
    - 关闭连接。

阶段 A 判定:
- **可用**:A3–A8 全部通过。smoke 脚本正常结束,退出码为 0,且 `smoke.png` 存在、大小 > 0、内容不是纯黑或纯白(用图片查看或简单像素统计确认)。
- **不可用**:任一项失败。此时输出:失败的是哪一步、完整报错、你判断的原因、我需要做什么;然后停止,不要进入阶段 B。

## 阶段 B:仅在阶段 A"可用"时执行,排行榜页试点

B1. 摸清页面:列出排行榜页的路径、数据来源(`services/rankings.js` 如何请求),以及需要 mock 的接口。用 automator 的 `mockWxMethod`(或等价方式)mock 请求,不要连接真实后端或云开发环境,也不要使用真实登录态。
B2. 针对下列状态各写一个用例(文件放 `tests/automator/rankings.states.mjs`)。每个状态用一份 mock 响应驱动,响应字段必须符合 `docs/` 里 §2.6、§7.9 的约定;字段拿不准时先问我,不要自己猜:
    1. 空榜(entry_count = 0)
    2. 少人(1–2 人)
    3. 少人(3–19 人)
    4. 常态(≥ 20 人)
    5. 游客(未登录占位)
    6. `available_boards` 不含 season(无"赛季榜"tab)
    7. `available_boards` 含 season
    8. `is_provisional = true`(显示"等待最终确认")
B3. 每个用例都要:
    - 进入页面并等待渲染完成(等待条件要明确,不要只写固定 sleep);
    - 断言文档 §7、§10.3 中该状态应出现或不应出现的元素(如 `.ui-placeholder`、领奖台、tab 数量、提示行);
    - 截图保存为 `tests/automator/out/rankings-<状态名>.png`;
    - 把页面可见文本导出到 `out/rankings-<状态名>.txt`。
B4. "常态不变"断言:状态 4 中,所有新增占位块都不得出现。
B5. 稳定性:整套用例连续运行 3 次,每次结果必须一致。
B6. 反向验证(证明测试有效):临时把一个断言改成故意错误,确认用例会失败;然后还原,并在报告中说明做过。这一步不得遗漏。

## 怎么算测试成功

全部满足才算"成功",缺一项就是"部分成功"或"失败",如实写:
1. 阶段 A 判定为"可用",证据齐全。
2. B2 的 8 个状态用例全部执行,通过数 / 总数写清楚。
3. 连续运行 3 次结果一致(无偶发失败)。
4. B6 反向验证已做:故意写错的断言确实失败了。
5. 每个状态都有截图和文本导出,截图不是空白页。
6. 没有修改任何业务代码;`git status` 显示只新增了 `tests/automator/`、`package.json`/`package-lock.json` 的 devDependency 变化。
7. `npm run typecheck` 和 `npm test` 的结果与开始前一致(先记录开始前的结果作为基线)。
8. 素材中没有完整 openid、token 等敏感信息。

## 阶段 C:仅在阶段 A"可用"时执行,打包素材

在 `tests/automator/out/` 下生成 `automator-report.md` 并打包。

报告必须包含:
1. 环境信息:系统、Node、开发者工具版本、automator 版本。
2. 阶段 A 逐项结果和证据。
3. 阶段 B 每个状态的用例名、mock 数据摘要、断言列表、通过或失败、运行耗时。
4. 3 次重复运行的结果对比。
5. B6 反向验证的做法和结果。
6. "怎么算测试成功"逐条自检表(8 条各写 是/否 + 依据)。
7. 遇到的问题、绕过方法、未解决的问题。
8. 你认为这套方案的局限(例如哪些地方仍需人工)。
9. 新增和修改的文件清单(`git status` 输出)。

打包内容,压缩为 `automator-evidence.zip`,放在仓库根目录之外,如桌面或用户目录,并告诉我完整路径:
- `automator-report.md`
- 所有截图(`rankings-*.png`、`smoke.png`)
- 所有文本导出(`rankings-*.txt`)
- 用例源码(`tests/automator/*.mjs`)
- 三次运行的完整终端输出日志
- 阶段 A 的命令输出日志
- `git status` 和 `git diff --stat` 输出
- 打包前自查敏感信息并说明自查方法

## 最后输出给我的内容

只需要简短总结:
- 结论:可用 / 不可用 / 部分可用;
- 若不可用,我下一步要做什么;
- 若可用,成功判定 8 条里满足几条、素材包路径,以及我需要把哪些文件发给另一位 AI 核查;
- 你认为还需要我人工确认的事项。

不要自行进入后续大规模编写用例的工作,等我核查后再决定。
````

## 七、素材包回传后的核查要点

- 截图是否真的是对应状态。
- 断言是否太松(例如只检查「页面存在」)。
- mock 数据是否符合 §2.6、§7.9 的约定。
- 反向验证是否真的做过。

## 八、S18–S21(多数据源比分同步)测试与 cloud1 验收

> 依据:当前工作区 S18–S21 实现与测试文件、开发计划 §19–§21、`MVP2.0__PROVIDER_VERIFICATION_RESULT__v1.0.md`。本节只做静态盘点,没有运行测试;「测试文件存在」不等于「测试通过」。开发计划 §22(S30)只保留状态追踪,细节以本节为准。
> 原则同前:**能让 AI 做的一律 AI 做,人只做 AI 做不了的**。

### 8.1 AI 全自动:补齐自动化测试(不连真实 API,不碰 cloud1)

使用去掉 key 的固定 fixture。下列为当前缺口,**不代表业务代码不存在**。

| 优先级 | 用例 | 覆盖点 |
|---|---|---|
| 高 | `5d`、OpenFoot、sportapi.ai 适配器(现有 `adapters.test.ts` 只测 fd 与 BSD) | 字段 / 状态 / 比分映射;5d 24 小时窗口与分页;OpenFoot `next_cursor` 与 `partial`;sportapi.ai 联赛过滤、ETag、304 缓存复用;BSD 的 `notstarted`、regular-season 过滤 |
| 高 | 跨源比赛匹配与赛果采信(`provider-cross-source.ts`、`provider-result-adoption.ts`,无专用测试) | 已映射 / 未映射 / 多候选;中超 5 分钟、其它联赛 30 分钟边界;权威源单独采信、非权威双源一致、单源等待、比分冲突、状态冲突 |
| 高 | Provider 的 CloudBase 状态仓储(用量、key 冷却、联赛最近成功,无专用测试) | 预算预留 / 释放;冷却时间;跨实例读写;字段与 `npm run cloudbase:schema` 输出一致 |
| 中 | 请求计划与轮转 | 同节拍只处理一个联赛并按最近成功时间轮转;5d live 全联赛单请求只一次;预算不足时换源;fd 双 key 各自额度 |
| 中 | 诊断报告字段 | 用 mock 额度头与错误核对每源额度、角色、联赛最近成功时间、`sp` 403/1010 |
| 中 | `providers:map-teams`、`logos:check` | 用脱敏球队样例检查候选 ID、别名、缺图报告;脚本不得自动写库 |

预期效果:`npm test` 与 `npm run typecheck` 全绿。报告里分开写「测试代码存在」「本次执行通过」「cloud1 实际验证」三种状态,不由前者推出后两者。

### 8.2 AI 通过腾讯云 API 配置 cloud1(你只需一次性准备凭据)

昨天申请的 SecretId / SecretKey 已被用于批量建集合和索引。是否还能配环境变量、部署云函数、建 Timer,取决于该密钥的 CAM 授权(需含云开发 TCB 与云函数 SCF 相关权限)。**让 AI 先试探权限,做不到的步骤退回 8.3 由你手动做,不要为此扩大授权。**

**凭据交付方式**:新建本地文件 `/home/football/.env.cloud1.local`(已被 `.gitignore` 的 `.env.*` 覆盖,不会入库)。AI 只从该文件读取,不得把值打印到对话、日志、报告或提交里。

```
TENCENTCLOUD_SECRET_ID=
TENCENTCLOUD_SECRET_KEY=
FOOTBALL_PROVIDER_KEY_FD_1=
FOOTBALL_PROVIDER_KEY_FD_2=
FOOTBALL_PROVIDER_KEY_BSD=
FOOTBALL_PROVIDER_KEY_5D=
FOOTBALL_PROVIDER_KEY_OF=
FOOTBALL_PROVIDER_KEY_SP=
```

**云函数 `api` 的环境变量**(位置:CloudBase 控制台 → 云函数 → `api` → 函数配置 → 环境变量;AI 通过 API 写入。更新环境变量通常是整组覆盖,必须一次写全,写前先读取现有值,避免覆盖掉已有项):

| 变量 | 填什么 | 谁填 |
|---|---|---|
| `FOOTBALL_ENVIRONMENT` | `test` | AI |
| `FOOTBALL_REPOSITORY_BACKEND` | `cloudbase` | AI |
| `FOOTBALL_CLOUD_ENVIRONMENT_ID` | `cloud1-d4ga6fvm0c6d4ec01`(开发计划 §16.9,环境 ID 不是密钥) | AI |
| `FOOTBALL_RESOURCE_NAMESPACE` | `football_test` | AI |
| `FOOTBALL_MATCH_CURSOR_SECRET` | AI 本地生成随机串,存入 `.env.cloud1.local`,不入库。**一经使用不要随意更换**,否则已发出的分页游标失效 | AI |
| `FOOTBALL_PROVIDER_SOURCES` | `fd,bsd,5d,of,sp` | AI |
| `FOOTBALL_SYNC_PROFILE` | `test` | AI |
| `FOOTBALL_SYNC_LEAGUES` | `premier_league,la_liga,serie_a,bundesliga,ligue_1,chinese_super_league` | AI |
| `FOOTBALL_PROVIDER_KEY_FD_1/_FD_2/_BSD/_5D/_OF/_SP` | 你在各数据源官网申请的 key,**只写入 `.env.cloud1.local`**,AI 读取后写入云函数 | 你申请并放入文件;AI 写入 |
| `FOOTBALL_MOCK_TRUSTED_OPENID` | 不设置(prod 非空会启动失败) | — |

**其余配置步骤**:

| 步骤 | 做法 | 谁做 |
|---|---|---|
| 集合与索引 | `npm run cloudbase:schema -- --namespace football_test` 输出清单;AI 经 API 建立。**已完成一批,需重新核对**:`provider_usage` 含可空 `league_id`;`provider_key_state`、`provider_league_state` 的唯一索引齐全。核对结果由 AI 读回索引列表对照,不靠肉眼 | AI |
| 构建与部署云函数 | `npm run cloudfunction:build` 后上传 `cloudfunctions/api/`,云端安装依赖;超时调大(同步任务耗时较长) | AI 能经 API 部署则 AI 做,否则你用开发者工具上传 |
| 自检 | 调 `{ "action": "diag" }`,AI 读取并解读输出(配置、集合读写、事务探针、每源诊断);只存脱敏输出 | AI |
| 六联赛赛程同步 | 对每个联赛调用 `{ "action": "sync", "job": "future_schedule", "league": "<league_id>" }`,检查比赛、mapping、snapshot、sync log 写入与分联赛请求计数 | AI |
| Timer 触发器 | 云函数 `api` 增加定时触发器(Type: Timer),每分钟一次,cron 例如 `0 * * * * * *`;代码以 `event.Type === "Timer"` 识别 | AI 经 API 创建;不行则你在控制台 → 云函数 → `api` → 触发管理 → 新建 |
| Timer 观察 | 至少观察一轮:联赛按最近成功时间轮转、同节拍请求错开、无活跃比赛窗口时零请求;AI 读取日志与 `provider_*` 集合核对 | AI |
| 真实响应核对 | 用真实响应核对五源字段、额度头、key 独立额度、预算计数与回退;确认 `sp` 在 cloud1 出口可访问(403/1010)、304 是否计费、BSD / OpenFoot 剩余额度字段。不要为测试刻意耗尽额度 | AI 执行并出报告 |

预期效果:你只需准备好 `.env.cloud1.local`,其余由 AI 完成,并交给你一份脱敏的 `diag` 输出、集合索引核对表和同步日志摘要。

### 8.3 只能你来做(AI 无法代替)

| 编号 | 事项 | 位置 / 做法 |
|---|---|---|
| H1 | 申请六个数据源 key 并放入 `.env.cloud1.local` | 各数据源官网账号;key 不要发给 AI 对话 |
| H2 | **仅当 8.2 中 API 授权不够时**:手动在控制台配环境变量、部署、建 Timer | AI 把需要粘贴的变量名与值(密钥值除外)整理成清单给你 |
| H3 | 比赛日验证:`fd` 比赛中延迟、`5d?status=live` 是否覆盖所有联赛,按开发计划 §21.6 的 R1 / R2 决定 5d 角色 | 需要真实比赛日;AI 可事后读日志出对比表,但你要确认官方比分口径 |
| H4 | 球队映射与队徽:确认 `(provider, provider_team_id)` → 本地球队 ID、别名、缺图项 | AI 跑 `providers:map-teams`、`logos:check` 出候选报告,你只做最终确认 |
| H5 | 微信真机:登录、比赛列表、预测流程;确认体验版身份与 cloud1 一致 | 微信开发者工具 + 真机 |
| H6 | 合规与运营:归档条款邮件、确认队徽资产授权、把 5d 署名阈值提醒放入运营流程 | 开发计划 §21.10 的 V09–V11 |

### 8.4 记录口径

- 每个云端结论附操作时间、云函数版本、脱敏日志或控制台证据;任何报告都不得含 key、SecretKey、完整 openid。
- 真实 API 样例归档前删除认证信息、`keyId` 与用户标识。
- 依赖真实赛事的项(H3)没有比赛日证据时标「待验证」,不得用空响应判定通过。
