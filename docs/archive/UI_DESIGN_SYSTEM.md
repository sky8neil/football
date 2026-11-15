# 赛事预言家 Design System V1

> **版本**：V1（2026-09-26）——**从当前首页实现反向提炼**，不是「先定规范再让首页迁就」。
> **母版页**：`miniprogram/pages/matches/`（首页）。**首页当前正式实现就是本 Design System 的母版**：
> 规范描述它、抽象它；它不需要为本规范让路。改规范与改首页必须是同一件事。
> **tokens**：`miniprogram/styles/design-tokens.wxss`
> 本文件取代 v1.0（2026-08-18 那版），旧版所有结论一律作废。

---

## 1. Source of Truth 与优先级

**视觉事实来源 = 当前正式实现代码。**

| 优先级 | 来源 | 说明 |
|---:|---|---|
| 1 | **当前实现代码** | `miniprogram/pages/matches/matches.wxml / .wxss / .js`、`miniprogram/styles/design-tokens.wxss`、`miniprogram/app.wxss` |
| 2 | **本文件（V1 冻结规范）** | 描述并抽象上述实现；与代码冲突时以代码为准，且必须立刻修文档 |
| 3 | 历史 HTML 高保真稿 / 旧 README 视觉描述 / 旧 token | 仅作**参考与差异分析**，不得作为实施依据 |

- 历史稿：`docs/design/赛事预言家首页-高保真-v8.6-球场背景玻璃版.html`（参考）、`…-联赛无底.html`（更早的历史稿）
- 首页**无自定义组件**（`miniprogram/components/` 不存在）；页面级实现即母版
- 其余 6 个页面（排行榜 / 我的预测 / 我的 / 解锁 / 详情 / 会话）当前都是白底占位，**不构成规范来源**

## 2. 证据链：规范里的每个值都是量出来的

反向提炼不能靠「看 WXSS 写了什么」——CSS cascade 可能被后面的规则覆盖（本项目真实发生过：
`.match` 先引用 `--shadow-card`，随后被追加块整条覆盖，于是 token「表面在用、实际不生效」）。
所以 V1 的取值一律来自**浏览器里的最终 computed 值**：

```text
① node    docs/design/scripts/home-view-model.mjs --out /tmp/hv
          用 vm 真实执行 matches.js，产出 10 个状态的页面 data（不复制页面逻辑）
② python3 docs/design/scripts/extract-home-visuals.py --views /tmp/hv --out after.json
          WXML+全部 WXSS → DOM（375×812，1rpx=0.5px），Chromium 算 cascade，采 98 个探针 × 70 属性
③ python3 docs/design/scripts/diff-home-visuals.py before.json after.json
          逐采样点比对，输出差异；当前基线 47,780 个采样点
```

- 覆盖状态：列表 / 预测展开 / 提交中 / 提交失败 / 已提交锁定 / 延期取消与 +12、+0 / 加载 / 空 / 错误 / 长昵称+更多
- 基线留档：`docs/design/baselines/`（前后快照 gz + 差异报告 + view model）

## 3. Design Principles（描述现有视觉，不新造审美）

1. **照片底 + 雾白玻璃**：首页底色是烘焙好的球场照片（65% 白蒙层 + 15% 降饱和已烘进图），内容承载在雾白玻璃面上。
2. **白底管可读、模糊管观感**：文字对比度靠**白底遮盖比例**保证，模糊只负责柔化背景纹理。**不许拿 blur 换可读性**。
3. **数据优先、装饰克制**：球队、时间、比分、状态优先于装饰；装饰层不承载业务文字、不影响点击。
4. **状态先于奖励感**：状态用文字 + 颜色共同表达，不使用博彩词汇与赌场式配色。
5. **柔和深度**：阴影为绿色调、低透明度、大模糊半径，不使用硬黑阴影。
6. **母版先于规范**：新页面复制的是**模式**（surface / 状态 / 组件），不是把首页整页复制过去。

## 4. Token 架构

三层，**只允许上层引用下层**（Component → Semantic → Primitive）：

| 层 | 作用 | 例子 |
|---|---|---|
| 1 Primitive | 物理值，无语义 | `--green-400: #7ed56f`、`--space-5: 20rpx`、`--duration-enter: 240ms` |
| 2 Semantic | 用途语义 | `--text-secondary`、`--surface-card`、`--border-glass-strong`、`--shadow-card` |
| 3 Component | 组件独立规范 | `--match-card-radius`、`--cta-height`、`--submit-button-height` |

- 当前规模：**153 个 token**，其中 110 个被页面/组件规则直接引用，43 个是中间层定义。**零死 token**。
- **不做预定义词表**：没有「先定义、等以后页面用」的 token。需要新变体时，在页面落地那一次同时加 —— v1.0 的 89 个闲置 token 就是这么来的，已删除。
- 单位：几何一律 `rpx`（750rpx = 375px，1rpx = 0.5px @375）；顶栏相关是 `px`（跟随微信安全区惯例）；时长 `ms`。

### 4.1 Frozen / Provisional 规则

- **Frozen**：母版页已实装、且被 computed 快照覆盖的值。**V1 全部 153 个 token 均为 Frozen**（每一个都被母版页真实引用，见 §2 证据链）。
- **Provisional**：未经过页面验证的值。**V1 为空集**——本版本刻意不保留预留 token。
  后续页面若需要新变体，按「同一层扩展 + 补快照场景」的方式新增，并在文档里标 Provisional 直到页面验证通过。
- 强制事项：**已冻结的值只允许在 tokens 里定义一次**。禁止页面级覆盖块、禁止同一语义两套命名。

## 5. Colors

### 5.1 Primitive 色板

| token | 值 | 用途锚点 |
|---|---|---|
| `--green-100` | `#d5ead4` | 页面最底 canvas |
| `--green-300` | `#9ee48a` | 品牌 mark 渐变起 / CTA 渐变起 |
| `--green-400` | `#7ed56f` | 品牌主色 |
| `--green-500` | `#62c453` | mark / CTA 渐变止 |
| `--green-700` | `#2f8a3a` | 主色按下态 / 软底上的文字 |
| `--green-800` | `#1a5c26` | 正向分数文字 |
| `--green-900` | `#163024` | 主文字 |
| `--mint-50` / `--mint-100` / `--mint-300` | `#f4fbf0` / `#e8f8df` / `#dcead9` | 实色面渐变 / 品牌软底 / 细边框 |
| `--teal-50` / `--teal-500` / `--teal-700` | `#e8fbf8` / `#3aa37a` / `#0b7f70` | 命中底 / 已提交·成功 / 已锁定 |
| `--orange-50` / `--orange-500` | `#fff1e8` / `#f08a3c` | 进行中标签底 / 进行中 |
| `--red-500` | `#c05621` | 错误文字 |
| `--navy-700` / `--navy-900` | `#1a2b44` / `#122033` | 深色比分块渐变 / 描边 |
| `--slate-200` / `--neutral-700` / `--white` | `#f3f6fb` / `#718096` / `#ffffff` | 中性标签底 / 完场 / 白 |
| `--ink-700` / `--ink-600` | `#3b4f43` / `#42564a` | 次级文字 / 弱文字（照片底上实测 5.0–7.9:1） |
| `--alpha-white-45…88` | `rgba(255,255,255,.45/.48/.50/.54/.58/.60/.66/.72/.82/.88)` | 玻璃 / 描边 / 内高光，只收录在用的档位 |

### 5.2 Semantic 文字色

| token | 值 | 用法 |
|---|---|---|
| `--text-primary` | `#163024` | 标题、比分、队名、日期数字 |
| `--text-secondary` | `#3b4f43` | 次级信息（时间、对阵、说明） |
| `--text-muted` | `#42564a` | 弱信息（队伍角色、提示小字、问候段） |
| `--text-on-brand` | `#163024` | 绿底按钮上的文字 |
| `--text-positive` | `#1a5c26` | 「最近成绩 +K」 |
| `--text-danger` | `#c05621` | 提交错误 |

> **对比度门槛：落在照片或玻璃上的文字必须实测 ≥ 4.5:1。** 首页因此使用加深档文字色；
> v1.0 的 `#5b7166` / `#86a092` 在球场照片上只有 1.1–4.7:1，**已废弃**。

### 5.3 品牌色

| token | 值 | 用法 |
|---|---|---|
| `--color-brand-primary` | `#7ed56f` | 主操作、选中态、状态竖条（可预测） |
| `--color-brand-primary-pressed` | `#2f8a3a` | 主色按下 / 软底上的文字 |
| `--color-brand-soft` | `#e8f8df` | 品牌软底（未开赛标签、chip、步进按钮） |

### 5.4 状态色

| token | 值 | 用法 |
|---|---|---|
| `--color-state-live` / `--color-state-live-soft` | `#f08a3c` / `#fff1e8` | 进行中 |
| `--color-state-done` / `--color-state-done-soft` | `#718096` / `#f3f6fb` | 完场 / 已关闭 / 中性 chip |
| `--color-state-success` | `#3aa37a` | 已提交、提交成功 |
| `--color-state-locked` | `#0b7f70` | 已锁定、`+3` 命中 |
| `--color-state-hit-soft` | `#e8fbf8` | `+3` 命中 chip 底 |

**颜色永远不是唯一信息**：每个状态都同时有文字标签（未开赛 / 已提交 / 进行中 / 完场 / 延期…）。

## 6. Surfaces 与 Glass

### 6.1 分工（V1 定稿）

> **模糊负责柔化背景纹理（观感），白底遮盖负责保证文字对比度（可读性）。**
> 要削弱模糊 → 降 `blur`；要提可读性 → **抬白底**，不要用 blur 换。

### 6.2 Surface 一览

| token | 值 | 适用 |
|---|---|---|
| `--surface-canvas` | `#d5ead4` | 页面最底（`page` 背景） |
| `--surface-page` | 三层渐变（radial ×2 + linear） | `.page` 兜底底色 —— **正常被球场照片盖住**，只在图片加载失败时可见 |
| `--surface-card` | `rgba(255,255,255,.54)` + `blur(36rpx)` | 比赛卡 |
| `--surface-card-strong` | `rgba(255,255,255,.58)` + `blur(36rpx)` | 可预测比赛卡 `.match.is-open` |
| `--surface-pred` | `rgba(255,255,255,.50)`，无 blur | 卡内预测编辑区 |
| `--surface-tray` | `rgba(255,255,255,.48)` + `blur(14rpx)` | 联赛托盘 |
| `--surface-ghost` | `rgba(255,255,255,.72)` | 次级按钮（更多 / 重试） |
| `--surface-date-active` | `#ffffff`（实心） | 日期选中态 |
| `--surface-solid` | `linear-gradient(180deg,#f4fbf0,#e8f8df)` | **比分方块（vs 框）：实色，不参与玻璃化** |
| `--surface-solid-dark` | `linear-gradient(180deg,#1a2b44,#122033)` | 进行中 / 完场的比分方块 |

### 6.3 Blur 档位

| token | 值 | 面 |
|---|---|---|
| `--blur-card` | `36rpx`（= 18px） | 比赛卡（白底比托盘厚、透过来背景少，同样 blur 观感更弱 → 取值更高） |
| `--blur-tray` | `14rpx`（= 7px） | 联赛托盘 |

### 6.4 不允许

- **把比分方块（vs 框）玻璃化**：必须实色 + `backdrop-filter: none`，靠「实色 vs 半透明」与雾白卡面分层；加半透明白底就会与卡面糊在一起（2026-09-26 修过一次）。
- 日期选中态玻璃化（保持实心白）。
- 每个组件都加 `backdrop-filter`。

## 7. Border / Shadow

### 7.1 Border

| token | 值 | 适用 |
|---|---|---|
| `--border-hairline` | `2rpx`（= 1px） | 统一描边宽度 |
| `--border-subtle` | `#dcead9` | 实色面描边（vs 框） |
| `--border-glass-strong` | `rgba(255,255,255,.88)` | 卡面 |
| `--border-glass` | `rgba(255,255,255,.82)` | 联赛托盘 |
| `--border-pred` | `rgba(255,255,255,.66)` | 预测编辑区 |
| `--border-dark` | `#122033` | 深色比分块 |

### 7.2 Shadow

| token | 值 | 适用 |
|---|---|---|
| `--shadow-card` | `0 24rpx 60rpx rgba(23,60,35,.10), inset 0 2rpx 0 rgba(255,255,255,.60)` | 比赛卡（**这就是最终生效值**，见 §11「被覆盖的 token」） |
| `--shadow-floating` | `0 16rpx 32rpx rgba(63,138,72,.22), inset 0 2rpx 0 rgba(255,255,255,.45)` | 主 CTA |
| `--shadow-mark` | `0 16rpx 32rpx rgba(63,138,72,.28), inset 0 2rpx 0 rgba(255,255,255,.45)` | 品牌 mark |
| `--shadow-tray` | `inset 0 2rpx 0 rgba(255,255,255,.82), 0 12rpx 32rpx rgba(47,106,62,.05)` | 联赛托盘 |
| `--shadow-sm` | `0 8rpx 20rpx rgba(63,138,72,.05)` | 日期选中态 |
| `--shadow-bug` | `0 4rpx 12rpx rgba(31,84,45,.08)` | 比分方块 |

规则：一个 surface 通常只有一个 outer shadow；普通文本与列表行无阴影。

## 8. Typography

| 项 | 值 |
|---|---|
| 中文字体 | `--font-family-cn`（系统字体栈，不加载外部字体） |
| 数字字体 | `--font-family-number`（`"Outfit"` → 缺失时回落系统无衬线） |
| 字号 | `--font-18/20/22/24/26/30/32/36`（rpx，共 8 档，全部在用） |
| 字重 | `--weight-regular 400` / `-medium 600` / `-semibold 650` / `-bold 700` / `-heavy 750` |
| 行高 | 按钮用「行高 = 视觉高度」；数字块 `1`~`1.1`；品牌行 `1.2` |

主要映射：品牌行 30rpx/700；日期数字 36rpx/750；比分 32rpx/750；队名 24rpx/650；状态标签 20rpx/650；说明 22rpx；小字 18rpx。
数字一律走 `--font-family-number`；中文正文最多三个字重层级。

## 9. Spacing / Radius

- 间距阶梯：`--space-1…10` = `4 / 8 / 12 / 16 / 20 / 24 / 28 / 32 / 36 / 40 rpx`（只收录在用的档）
- **刻意不在阶梯上的字面量**：`6rpx`（比分块内部 gap、选中下划线 margin）、`120rpx`（loading 上下留白）——单点值，不建 token
- 圆角阶梯：`--radius-xs/sm/md/lg/xl/card/tray/pill` = `16 / 18 / 20 / 24 / 28 / 32 / 40 / 99 rpx`

## 10. Component

### 10.1 页面布局（首页骨架）

| token | 值 | 说明 |
|---|---|---|
| `--topbar-offset` / `--topbar-height` | `40px` / `44px` | 顶栏绝对定位（安全区顶 + 40px），底边 = 84px |
| `--home-spacer-top` | `76px` | `.topbar-spacer`：给绝对定位顶栏让位（含与托盘 8px 叠压） |
| `--home-tray-offset` | `20rpx` | 联赛托盘上间距：托盘顶 86px，与 logo 底 78px 净空 **8px** |
| `--page-padding-inline` | `32rpx` | 页面左右内边距 |
| `--page-padding-bottom` | `calc(68rpx + env(safe-area-inset-bottom))` | 让开原生 tabBar |
| （字面量） | `calc(100vh - 420rpx)` | `.feed` 高度：420rpx 是页头各项高度的**聚合值**，刻意不 token 化 |

层级：背景层 `z-index:0`；`.leagues-wrap / .dates-wrap / .hint` 与 `.results` 必须显式 `position: relative; z-index:1`；顶栏 `z-index:2`。

### 10.2 MatchCard（比赛卡）

| token | 值 |
|---|---|
| `--match-card-radius` | `32rpx` |
| `--match-card-background` / `-strong` | `--surface-card` / `--surface-card-strong` |
| `--match-card-border` | `2rpx solid rgba(255,255,255,.88)` |
| `--match-card-shadow` | `--shadow-card` |
| `--match-card-blur` | `36rpx` |
| `--match-card-gap` | `20rpx`（卡间距） |
| `--match-card-padding` | `24rpx 24rpx 24rpx 28rpx` |
| `--match-card-bar-width` | `6rpx`（左侧状态竖条，上下内缩 24rpx） |

竖条颜色按状态：可预测 → `--color-brand-primary`；已提交 → `--color-state-success`；进行中 → `--color-state-live`；完场 → `--color-state-done`。
内部：`.match-top`（时间 + 状态标签）→ `.faceoff`（主队 · 比分块 · 客队）→ `.foot`（预测文案 / CTA / 结果 chip）→ 可选 `.pred-wrap`。
队徽 `--crest-size: 72rpx`；比分块 `--bug-size: 112rpx` + `--bug-radius: --radius-xl`。

### 10.3 预测与提交状态

| uiState | 表现 |
|---|---|
| `collapsed` | 不渲染 `.pred-wrap`；CTA 为「去预测 →」 |
| `editing` | `.pred-wrap` 展开（`pred-open` 320ms）：比分步进器 + 即时判定 + 奖励说明 + 提交按钮 |
| `submitting` | 提交按钮 loading/disabled（文案「提交中…」） |
| `submitted_locked` | 显示「✓ 预测已提交」；编辑区不渲染；卡片保留原状态竖条 |
| 失败 | `.submit-err` 显示错误文案（`--text-danger`），停留在 editing |

步进器：按钮 `--stepper-button-size 56rpx`、圆角 `--radius-xs`、软底 + `--color-brand-primary-pressed`；队徽 `--stepper-team-logo-size 40rpx`；数值列 `--stepper-value-width 40rpx`。

### 10.4 按钮

| token | 值 | 适用 |
|---|---|---|
| `--cta-height` | `72rpx` | 主 CTA（`--cta-background` 渐变 + `--text-on-brand` + `--shadow-floating`） |
| `--submit-button-height` | `68rpx` | 提交预测（`--color-brand-primary` 实色） |
| `--ghost-button-height` | `64rpx` | 更多 / 重试 / 提交成功条（`--surface-ghost`） |

三个按钮都是「行高 = 视觉高度」，圆角分别为 `--radius-md` / `--radius-sm` / `--radius-sm`。

### 10.5 状态标签与 chip

- `.state` / `.chip`：`--status-chip-height: 40rpx`、`--radius-xs`、20rpx/650、`padding: 0 16rpx`
- 未开赛/已提交标签：`--color-brand-soft` 底 + `--color-brand-primary-pressed` 文字
- 进行中：`--color-state-live-soft` + `--color-state-live`；完场/关闭：`--color-state-done-soft` + `--text-secondary`
- 结果 chip：`+3` → `--color-state-hit-soft` + `--color-state-locked`；`+12` → 品牌软底 + pressed；`+0` → 中性底 + muted
- **已知缺口（实测结论，不是设计意图）**：`.chip.lock` 与 `.state.lock` **没有独立规则** ——
  `.chip.lock` 落到 `.chip` 默认（**透明底** + 继承 `--text-primary`）；`.state.lock`（卡片右上「已提交」）落到 `.state` 默认（品牌软底 + pressed 文字）。
  两者都属未单独设计的现状，改动前先确认。

### 10.6 日期格 / 联赛格 / 品牌 mark

| 组件 | token |
|---|---|
| 日期格 | `--date-width 112rpx`、`--date-height 96rpx`、`--date-radius --radius-xl`、间距 `--space-3`，一屏约 5.5 个（右缘露半格 = 可横滑提示） |
| 联赛格 | `--tray-cell-width 104rpx`、`--tray-cell-height 92rpx`、`--tray-logo-size 56rpx`、托盘 `--tray-radius --radius-tray`、`--tray-min-height 112rpx` |
| 品牌 mark | `--mark-size 64rpx`、`--mark-radius --radius-md`、`--mark-gradient`、球标位图 `--mark-ball-size 36rpx` |

### 10.7 loading / empty / error

`.loading` / `.empty` / `.error`：`padding: 120rpx 40rpx`、`--text-muted`、`--font-24`、`white-space: pre-line`（空态两行文案）。
`.retry` 复用 ghost 按钮，`margin-top: --space-6`。列表切换动效：`.results-enter` / `.results-exit`（见 §11）。

### 10.8 tabBar

微信 tabBar 由 `app.json` 配置、**原生渲染**。当前 `app.json` 只配了 `pagePath` + `text`，**没有颜色/图标/背景配置**，因此 V1 **没有可提炼的 tabBar token**（也没有 `tabbar-height`：高度由微信原生决定）。
给 tabBar 加样式时，应把选中的 `color/selectedColor/backgroundColor/borderStyle` 提升为 token 并补进本文件。

## 11. Motion

| token | 值 | 适用 |
|---|---|---|
| `--duration-shift` | `180ms` | 列表退场 `.results-exit` |
| `--duration-enter` | `240ms` | 列表入场 `.results-enter` |
| `--duration-predict` | `320ms` | 预测区展开 `.pred-wrap` / 提交成功 `.pred-success` |
| `--ease-standard` | `ease` | 列表切换、提交成功 |
| `--ease-emphasized` | `cubic-bezier(.4,0,.2,1)` | 预测区展开 |

关键帧：`content-enter/exit`、`pred-open`、`pred-success-in`，位移量均为 `±8rpx`（**刻意保留字面量**：`@keyframes` 中间态无法被 computed 快照覆盖）。

> **v1.0 的 `--motion-fast 120ms` / `--motion-normal 220ms` 与实装不符，已废弃。** V1 以实装 180/240/320ms 为唯一事实。

## 12. Interaction / Accessibility

**按下态与禁用态（现状，非规范发明）**：
- WXSS **没有定义任何 `:active` / 按下态样式** → 走微信 `<button>` 原生 hover 表现；未定义即未设计，要做需同时补 token 与快照场景。
- disabled（如提交中）同样走微信原生表现，WXSS 未覆写。

**命中区 vs 视觉高度（V1 明确区分）**：
- `--cta-height 72rpx` / `--submit-button-height 68rpx` / `--ghost-button-height 64rpx` 是**视觉高度**，已由人工确认，保持不动。
- **禁止**用可访问性理由把这些视觉高度强行抬到某个「最小触控尺寸」。最小命中区作为独立规则定义：主要操作应位于拇指可达区，交互元素之间不得贴死（现有 `gap` 已保证）。
- v1.0 的 `--tap-target-min: 88rpx` 因被误用为「视觉高度下限」（首页按钮 64–72rpx 全部"不达标"）已废弃。

**对比度**：详见 §5.2 的 ≥4.5:1 门槛。

## 13. 禁止重新引入的旧视觉（v1.0 遗留）

| 禁止 | 为什么 |
|---|---|
| 实心白卡（`background: #fff` 的比赛卡）、白→`#F4FBF0` 渐变卡 | 在球场照片上像贴纸，已被玻璃卡取代 |
| 把三层渐变当首页主背景 | 首页已是球场照片；渐变仅作 `.page` 兜底 |
| 给比分方块（vs 框）加半透明白底 / blur | 会与卡面糊在一起 |
| 旧文字色 `#5b7166` / `#86a092` | 在照片上只有 1.1–4.7:1 |
| `--motion-fast/normal` 120/220ms、`--tap-target-min 88rpx` | 与实装不符 / 概念被误用 |
| 旧 token 名：`--color-surface-card`、`--color-bg-*`、`--match-*`、`--prediction-*`、`--sp-neutral-*`、`--radius-dialog`、`--shadow-elevated` 等 | 已删除；同一语义只保留 V1 一套命名 |
| **被覆盖的 token**：某个选择器先引用 token、又被后面的规则整条覆盖 | 会造成「引用数显示在用、实际 0 生效」的隐形 token（`--shadow-card` 曾如此） |
| 页面级 token 覆盖块（`matches.wxss` 里重定义 `page { --text-* }`） | 同一语义出现两处定义，必然漂移；V1 已合并进 tokens |

## 14. 改动流程（硬性）

```text
1. 改 tokens 或 matches.wxss
2. node    docs/design/scripts/home-view-model.mjs --out /tmp/hv
3. python3 docs/design/scripts/extract-home-visuals.py --views /tmp/hv --out after.json
4. python3 docs/design/scripts/diff-home-visuals.py <baseline>.json after.json
   → 必须「逐项一致 ✅」；出现任何差异都要查明原因（token 错 / cascade 错 / 隐含覆盖），
     不许自行接受
5. python3 docs/design/scripts/verify-home-migration.py   # 结构与不变式（快速，无浏览器）
6. npm run typecheck && npx vitest run && git diff --check
```

**刻意保留的字面量清单**（允许保留，但不得扩散）：

| 位置 | 字面量 | 原因 |
|---|---|---|
| `.decor-arc` | 偏移/尺寸 + `rgba(63,138,72,.12)` | 单点装饰弧线，不成体系 |
| `.league.active text::after` | `24rpx / 4rpx / 6rpx` | 纯装饰下划线几何 |
| `.brand-name` | `letter-spacing: -1rpx`、`line-height: 1.2` | 品牌行专属排版微调 |
| `.league-logo` | `opacity: .72` | 单点观感值 |
| `.feed` | `calc(100vh - 420rpx)` | 页头高度聚合值，token 化会掩盖耦合 |
| `.match::before` | `top/bottom: 24rpx`、`border-radius: 0 6rpx 6rpx 0` | 与卡内边距耦合 |
| `.team` | `width: 34%` | 对阵配比布局约束 |
| `.bug` | `gap: 6rpx` | 不在间距阶梯上 |
| `.foot` | `min-height: 64rpx` | 布局约束（非按钮规范） |
| `.stepper-team text` | `max-width: 150rpx` | 文本截断上限 |
| `.stepper button` | `line-height: 54rpx` | 微信 button 垂直居中经验值（56−2） |
| `.loading/.empty/.error` | `padding: 120rpx` | 单点留白 |
| `@keyframes` | `translateY(±8rpx)` | 中间态无法被快照覆盖 |

## 15. 当前已知缺口（V1 未覆盖，不要当成已定规范）

- **按下态 / 焦点态**：未设计（见 §12）。
- **tabBar**：未配置样式（见 §10.8）。
- **`.chip.lock` / `.state.lock`**：无独立样式（见 §10.5）。
- **宽屏适配**：仅在 375px 宽度下验证过；430px 等未验证。
- **真机验证**：所有结论来自 Chromium 的 computed 快照 + 人工确认的首页视觉；**微信真机表现未逐项复核**（`backdrop-filter` 在部分安卓机型会退化为纯半透明面板，文字对比度仍达标）。
- **昵称端到端**：缓存缺失时回落到「球友」；`<input type="nickname">` 需基础库 2.21.2+，当前 appid 为 `touristappid`（游客模式），真实昵称链路未验证。
- **日期过滤**：首页 11 天共用同一份列表（`dayBounds()` 已定义但未被调用），接真实数据时需补齐。
