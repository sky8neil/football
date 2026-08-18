# 赛事预言家 Global UI Design System

> **版本：** v1.0（以当前首页 8.6 为视觉基线）  
> **产品：** 赛事预言家微信小程序  
> **视觉 Source of Truth：** `/root/赛事预言家首页/赛事预言家首页-高保真-v8.6-联赛无底.html`  
> **生产落地参考：** `/home/football/miniprogram/pages/matches/`  
> **适用范围：** 比赛、排行榜、我的、历史预测、主队选择、分享战绩卡及全局反馈状态。

这套系统提炼当前首页已经形成的视觉 DNA：浅草绿、清透页面背景、柔和绿色阴影、圆润但克制的 surface、中文系统字体与数字字体分工、以比赛状态为核心的低刺激色彩语义。

它不是把所有页面强行做成首页，也不是要求所有内容都放进白色 Card。页面可以选择 Card、Section、Dense List、Hero、Bottom Sheet、Dialog、Sticky Action 等布局模式，但必须复用同一套 token、状态语义和交互规则。

---

## 1. Design Principles

### 1.1 视觉原则

1. **清透的草坪日光感**：页面以浅绿与白色为底，保留轻微光晕，不使用脏灰或厚重暗底。
2. **数据优先，装饰克制**：球队、时间、比分、预测状态优先于装饰性插画。
3. **状态先于奖励感**：预测状态使用文字、图标/符号和颜色共同表达，不制造博彩、奖金或赌场氛围。
4. **柔和深度**：阴影使用绿色调、低透明度和大模糊半径；不使用硬黑阴影。
5. **分层而非堆卡**：首页可以使用比赛 Card；排行榜和历史预测优先使用 Dense Row / Section，避免所有内容卡片化。
6. **移动优先**：按 390px 设计，兼容 375–430px；所有主要操作进入拇指可达区域。

### 1.2 产品语气

- 中文、简洁、事实导向、轻度鼓励。
- 使用「预测」「成绩」「已提交」「已锁定」「完场」「命中」等产品语言。
- 禁止使用「投注」「下注」「赔率」「盘口」「奖池」「赢取」等博彩词汇。
- 不使用 Emoji 作为正式图标；图标必须具有稳定语义。

### 1.3 视觉签名

**半透明联赛托盘 + 联赛 Logo / 文字上下排列 + 状态色左侧竖条**是当前首页最可识别的组合。它可以复用于筛选和状态区域，但不要求每个页面都复制联赛托盘。

---

## 2. Brand Visual Language

### 2.1 颜色气质

主色不是高饱和竞技绿，而是明亮、柔软的浅草绿。深绿色只承担标题、主要文字和 pressed 状态；橙色只用于进行中或警示；灰蓝只用于完场、禁用和低优先级信息。

### 2.2 透明与玻璃

允许使用轻量的 `surface-glass`：白色 46% 左右不透明度、细白描边、轻微 blur。它主要用于联赛托盘、顶部浮层和非核心筛选容器。

不允许：

- 每个组件都加 backdrop blur。
- 玻璃效果覆盖正文和比赛信息。
- 透明度过低导致文字对比度不足。

### 2.3 装饰背景语言

当前首页背景由三层构成：

1. 右上白色 radial glow；
2. 左侧浅草绿 radial glow；
3. 从浅绿到更浅绿的垂直 linear gradient。

可复用规则：

| 页面 / 区域 | 背景强度 |
|---|---|
| 首页比赛列表 | 强度 100%，允许完整 page recipe |
| 我的 / 排行榜 | 50–70%，降低 glow，保证长列表可读性 |
| Hero / 分享卡 | 可使用完整或增强版 recipe |
| Dense List / 历史预测 | 20–40%，优先平面背景 |
| Dialog / Bottom Sheet | 使用 surface，不带页面装饰背景 |

足球场弧线、微纹理可作为低透明度装饰层使用，但不能成为正文阅读噪音。装饰层不承载业务文字，不影响点击。

---

## 3. Color Tokens

### 3.1 Primitive Colors

仅保留当前页面和后续状态确实需要的 primitive：

| Token | Value | 用途 |
|---|---|---|
| `green-300` | `#9EE48A` | 主按钮高光、品牌 mark 高光 |
| `green-400` | `#7ED56F` | 主色、可预测、选中态 |
| `green-500` | `#62C453` | 主按钮底色 / hover |
| `green-700` | `#2F8A3A` | 深主色、命中、pressed |
| `green-900` | `#163024` | 主文字、深色比分面板 |
| `mint-100` | `#E8F8DF` | 主色浅背景 |
| `mint-200` | `#D7EFD8` | 页面深层背景 |
| `mint-300` | `#DCEAD9` | 边框、分隔线 |
| `neutral-0` | `#FFFFFF` | surface / inverse text |
| `neutral-50` | `#F4FBF1` | 页面浅底 |
| `neutral-100` | `#EEF8EF` | 页面底色 |
| `neutral-500` | `#86A092` | muted text |
| `neutral-600` | `#5B7166` | secondary text |
| `neutral-700` | `#718096` | 完场 / 结果信息 |
| `neutral-900` | `#122033` | 深色比分 surface |
| `teal-500` | `#3AA37A` | 已提交、赛果命中 |
| `teal-700` | `#0B7F70` | 已锁定文字 |
| `orange-500` | `#F08A3C` | 进行中、处理中 |
| `slate-400` | `#A0AEC0` | 未命中、禁用 |

### 3.2 Semantic Colors

使用 semantic token，不在页面直接写 primitive HEX：

```text
color-bg-page             页面默认背景
color-bg-page-soft       弱背景 / Dense List
color-bg-elevated        提升层 / 白色 surface
color-bg-overlay         Dialog 遮罩
color-surface-card       普通比赛 Card
color-surface-card-highlight 可预测 Card
color-surface-card-muted 低优先级 Card / disabled
color-surface-glass      联赛托盘等半透明容器
color-surface-floating   日期选择、浮动控件
color-surface-dialog     Dialog / Bottom Sheet 内容面
color-surface-disabled   禁用 surface
color-text-primary       主文字
color-text-secondary     次要文字
color-text-muted         辅助文字
color-text-inverse       深色 surface 上的文字
color-border             组件边框
color-divider            内容分隔线
color-primary            #7ED56F
color-primary-hover      #62C453
color-primary-pressed    #2F8A3A
color-primary-soft       #E8F8DF
color-success            #3AA37A
color-warning            #F08A3C
color-danger             #C05621
color-info               #0B7F70
color-live               进行中
color-locked             已锁定
color-finished           完场
color-disabled           禁用
```

`/home/football/miniprogram/styles/design-tokens.wxss` 与 `docs/design/tokens.css` 已提供这些 token 的 WXSS / Web 镜像。

---

## 4. Match and Prediction State Colors

颜色不能是唯一信息。每个状态至少同时使用：**文字标签 + 状态样式 + 必要时的 icon / 形状**。

| Token | 文字 | 颜色 | 推荐辅助表达 |
|---|---|---|---|
| `match-scheduled` | 未开赛 | `#7ED56F` | 时间、可预测条件 |
| `match-predictable` | 未开赛 / 去预测 | `#7ED56F` | Primary CTA |
| `match-submitted` | 已提交 | `#3AA37A` | 我的预测比分 |
| `match-locked` | 已锁定 | `#0B7F70` | 锁定 icon、不可修改 |
| `match-live` | 进行中 | `#F08A3C` | LIVE / 实时比分 |
| `match-finished` | 完场 | `#718096` | FT、正式比分 |
| `match-postponed` | 延期 | `#86A092` | 延期 tag、不可操作 |
| `match-cancelled` | 取消 | `#A0AEC0` | 取消 tag、disabled action |
| `prediction-hit-result` | 赛果命中 +3 | `#3AA37A` | 结果 icon + 分数 |
| `prediction-hit-exact` | 精确命中 +12 | `#2F8A3A` | 精确 icon + 分数 |
| `prediction-miss` | +0 | `#A0AEC0` | 中性结果，不用红色刺激 |
| `prediction-processing` | 赛果更新中 | `#F08A3C` | loading / processing icon |

### 4.1 MatchCard 状态模型

```text
collapsed
editing
confirming
submitting
submitted_locked
prediction_closed
live
finished
result_processing
postponed
cancelled
```

业务状态由 API 合同驱动：`match_status`、`can_predict`、`can_predict_reason`。前端不要重复计算截止时间。

### 4.2 原地预测流程

```text
collapsed
  → 点击「去预测」
editing
  → 填写主客队比分
confirming
  → 确认提交
submitting
  → 禁用重复操作
success
  → 短暂成功反馈
submitted_locked
  → 自动收缩，显示「我的预测 2 : 1 / 已预测 / 已锁定」
```

提交失败时保留编辑值，提供明确重试，不把失败伪装成已提交。

---

## 5. Background System

```text
background-page-default  首页完整三层渐变 + 两个 radial glow
background-page-soft     低装饰页面 / Dense List
background-hero          分享卡 / Profile Hero 的可增强版本
background-elevated      白色 surface
background-overlay       rgba(18, 32, 51, .36)
```

背景使用原则：

- 一个页面最多一个主背景 recipe。
- Card 内部可使用非常轻的 highlight gradient，但不得叠多层 glow。
- 复杂数据列表优先平面化，避免每一行重复渐变。
- 分享战绩卡可以增强品牌背景，但必须保证成绩数字与昵称的对比度。

---

## 6. Surface System

| Surface | Background | Border | Shadow | Radius | 适用 |
|---|---|---|---|---|---|
| `surface-page` | page recipe | none | none | 0 | 页面底 |
| `surface-card` | `#FFF` | white 92% | `shadow-card` | `radius-card` | 首页比赛卡 |
| `surface-card-highlight` | white → `#F4FBF0` | white 92% | `shadow-card` | `radius-card` | 可预测比赛 |
| `surface-card-muted` | `#F3F6FB` | `#DCEAD9` | `shadow-sm` | `radius-md` | 低优先级 / 禁用 |
| `surface-glass` | white 46% | white 74% | inset + soft | `radius-dialog` / pill | 联赛托盘 |
| `surface-floating` | white 80% | `#DCEAD9` | `shadow-elevated` | `radius-lg` | 日期 / 浮动操作 |
| `surface-dialog` | white | subtle border | `shadow-dialog` | `radius-dialog` | Dialog / Sheet |
| `surface-disabled` | `#F3F6FB` | `#DCEAD9` | none | `radius-md` | 不可用内容 |

不要将 `surface-card` 作为唯一布局语言：排行榜使用 `RankingRow`，我的页面使用 `Section`，主队选择使用 `SelectableItem`，分享卡使用独立 `ShareCard` surface。

---

## 7. Typography

### 7.1 Font Roles

```text
font-family-cn     -apple-system, BlinkMacSystemFont, "SF Pro Text",
                   "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif
font-family-number "Outfit", -apple-system, BlinkMacSystemFont,
                   "SF Pro Text", sans-serif
```

当前微信小程序实现不依赖外部字体文件；若生产环境无法稳定提供 Outfit，数字应回退到系统无衬线，不引入新的品牌字体。

### 7.2 Type Scale

| Token | WXSS | 用途 |
|---|---:|---|
| `display` | 40rpx | 分享卡大成绩 / Hero 数字 |
| `title-lg` | 34rpx | 页面品牌名 |
| `title-md` | 30rpx | 页面标题、重要 section |
| `title-sm` | 28rpx | 卡片 / section 标题 |
| `body-lg` | 28rpx | 重要正文 |
| `body-md` | 26rpx | 标准正文 |
| `body-sm` | 24rpx | 比赛底部说明 |
| `label-lg` | 24rpx | CTA、关键 label |
| `label-md` | 22rpx | 状态、辅助标签 |
| `label-sm` | 20rpx | 日期小标签、次要说明 |
| `number-lg` | 44rpx | 分享卡积分、排名大数字 |
| `number-md` | 36rpx | 日期数字、核心数据 |
| `number-sm` | 28rpx | 比分、紧凑统计 |

### 7.3 数字排版

比分、排名、积分、准确率、`+3`、`+12`、倒计时必须使用 `font-family-number` 或同等数字 fallback。数字比说明文字更突出，但不得使用金色、筹码、现金等奖励视觉。

中文正文最多使用 3 个主要字重层级：常规、半粗、粗体。不要通过大量字号制造噪音。

---

## 8. Spacing System

来源于当前首页真实 rpx：

```text
space-1   4rpx
space-2   8rpx
space-3   12rpx
space-4   16rpx
space-5   20rpx
space-6   24rpx
space-8   32rpx
space-10  40rpx
space-12  48rpx
space-16  64rpx
```

### 8.1 页面级约定

```text
page-padding-inline  32rpx
section-gap          16rpx
card-gap             20rpx
card-padding         24rpx
card-leading-padding 28rpx
compact-row-gap      12rpx
icon-text-gap        16rpx
button-padding       28rpx
safe-area-top/bottom env(safe-area-inset-*)
```

### 8.2 信息密度

| Density | 用途 | 规则 |
|---|---|---|
| `comfortable` | 首页、我的、Profile Hero | 32rpx 页面边距，24rpx 以上区块内距 |
| `default` | 比赛详情、选择页 | 32rpx 页面边距，16–24rpx 组件间距 |
| `compact` | 排行榜、历史预测 | 32rpx 页面边距，12–16rpx 行间距，减少大面积留白 |

不因为使用 `compact` 就降低触控区域或中文可读性。

---

## 9. Radius

```text
radius-sm       14rpx   小 Logo / 小 surface
radius-md       20rpx   CTA、chip、紧凑控件
radius-lg       28rpx   日期、日历、浮动控件
radius-card     32rpx   比赛卡、主要内容面
radius-pill     999rpx  状态 Tag、胶囊
radius-dialog   40rpx   Bottom Sheet / Dialog
radius-mark     20rpx   品牌 mark
```

页面不得继续出现任意 `11px / 13px / 15px / 17px / 19px` 等无语义半径；需要新半径时先确认是否是现有 token 无法表达的组件需求。

---

## 10. Shadow / Elevation

```text
shadow-none      none
shadow-sm        0 8rpx 20rpx rgba(63,138,72,.05)
shadow-card      0 20rpx 56rpx rgba(63,138,72,.10) + white inset
shadow-elevated  0 20rpx 56rpx rgba(63,138,72,.14)
shadow-floating  0 16rpx 32rpx rgba(63,138,72,.22) + white inset
shadow-dialog    0 28rpx 80rpx rgba(18,32,51,.18)
```

- 普通文本和列表行默认无 shadow。
- 一个 surface 通常只有一个 outer shadow。
- primary button 可以使用 `shadow-floating`，但同屏不要出现大量浮起按钮。
- Dense List 优先 divider，不为每一行加卡片阴影。

---

## 11. Icon System

### 11.1 规范

- 正式图标统一使用线性、圆角、低视觉重量的 SVG / image asset。
- 默认尺寸：`40rpx`；small `32rpx`；medium `48rpx`；large `64rpx`。
- 默认 stroke：约 1.75–2px 等效；active 可使用主色，inactive 使用 muted。
- 不能混用 Emoji、Material Icon、SF Symbol 和随机 SVG。
- 图标旁必须有文字或上下文，不依赖颜色单独传达含义。

### 11.2 业务图标清单

需要统一的 icon key：

```text
icon-time
icon-calendar
icon-lock
icon-live
icon-finished
icon-prediction-hit
icon-prediction-exact
icon-prediction-miss
icon-processing
icon-ranking
icon-level
icon-history
icon-favorite-team
icon-search
icon-chevron
icon-check
icon-close
icon-plus
icon-minus
```

当前页面仓库实现里 `league-logo` / `crest` 使用文字 fallback，日历按钮使用「日」占位文字；这属于现阶段可运行 fallback，不应被当作最终 icon 规范。正式资源应放在 `miniprogram/assets/icons/`，并在补齐后替换 fallback，不改变布局尺寸。

### 11.3 联赛与球队 Logo

Logo 是图像资源，不是通用 icon。使用真实资源时保持原比例和清晰度；缺少资源时可使用明确的文本 fallback，但不能伪造真实队徽。

---

## 12. Button System

| Variant | 用途 | 视觉 |
|---|---|---|
| `button-primary` | 去预测、提交、确认 | 浅草绿渐变，深绿文字，soft shadow |
| `button-secondary` | 次要确认 | 白色 surface，绿色边框 / 文字 |
| `button-tertiary` | 文本级动作 | 无背景，主色文字 |
| `button-ghost` | 返回、关闭、筛选 | transparent，按压时浅色 surface |
| `button-danger` | 取消高风险操作 | 柔和 danger 背景，避免警报红铺满 |
| `button-disabled` | 不可用 | muted surface + muted text |
| `button-loading` | 提交中 | 保留尺寸，loading icon，不重复点击 |

尺寸：

```text
size-sm  min-height 64rpx，紧凑列表
size-md  min-height 72rpx，默认 CTA
size-lg  min-height 88rpx，底部 Sticky Action
```

最小点击区域 `88rpx`。`去预测`是 primary action 的基准，不使用赌场式高饱和红、金币或奖励光效。

---

## 13. Tag / Badge System

```text
tag-default   muted surface + secondary text
 tag-active   primary-soft + primary-deep text
tag-success   teal soft + teal text
tag-live      orange soft + orange text
tag-locked    teal soft + teal-deep text
tag-finished  slate soft + slate text
tag-warning   orange / warm soft
 tag-muted    neutral soft + muted text
```

业务映射：

```text
未开赛     tag-active
已预测     tag-success
已锁定     tag-locked
进行中     tag-live
完场       tag-finished
延期/取消  tag-muted 或 tag-warning
+3 / +12   tag-success；精确命中可使用更深绿色
+0         tag-muted，不使用刺激性红色
```

标签必须同时包含文字；live 可以增加小圆点或 pulse，但动画不是唯一识别手段。

---

## 14. Form / Interactive Controls

### 14.1 通用控件

```text
Input             white surface, border, radius-md
SearchField       white / glass surface, search icon, clear action
Selector          surface-card, selected underline or soft fill
Radio / Checkbox  primary selected, 44px+ hit area
Switch            only for binary settings, not match state
Stepper           score input, fixed-size minus / value / plus
```

### 14.2 Score Stepper

视觉结构：

```text
[ − ]   2   [ + ]
```

规则：

- 每个减号 / 加号至少 `88rpx × 88rpx` 点击区域。
- 数值使用 `number-md`，主队和客队左右对称。
- 到边界时按钮 disabled，不能只靠颜色表达。
- 预测范围服从后端合同，不在 UI 自行扩大范围。
- 推导结果显示为「主胜 / 平局 / 客胜」，不显示赔率。

---

## 15. Match Component System

```text
MatchCard              首页 collapsed / 状态卡
MatchCardExpanded      首页原地 editing / confirming
MatchHistoryItem       历史预测 compact row
MatchResultItem        完场结果与积分
MatchCompactRow        排行榜或历史列表中的最小对阵行
TeamIdentity           Logo + 中文队名 + 主客标识
ScoreDisplay           正式比分 / VS / 待结算
PredictionDisplay      我的预测比分
PredictionEditor       ScoreStepper + 推导结果 + action
PredictionResult       +0 / +3 / +12 / 处理中
MatchStatusTag         未开赛 / 已锁定 / 进行中 / 完场等
```

### 15.1 密度选择

- 首页使用 `MatchCard`：突出球队、时间、状态和 CTA。
- 历史预测使用 `MatchHistoryItem`：日期、对阵、正式比分、预测和积分一行或两行完成。
- 排行榜不使用完整 `MatchCard`，使用 `MatchCompactRow` 或 `RankingRow`。
- 完场详情允许 `MatchResultItem` 增加结果说明，但不扩大为 Dashboard。

### 15.2 首页原地展开

展开前后保持同一张卡的左侧状态竖条、圆角和主层级；只增加 editor 区域，不跳转到独立预测页。展开 / 收缩使用 `motion-normal`，不重排整个列表造成位置跳动。

---

## 16. Ranking Components

```text
RankingHeader
RankingTabs        周榜 / 月榜 / 历史周期
RankingTopThree    Top 1 / 2 / 3
RankingRow         普通密集排名行
RankNumber
AccuracyDisplay
ScoreDisplay
```

Top 1 / 2 / 3 可以使用不同尺寸、轻微主色强调和头像层级，但禁止金色奖杯、筹码、奖金、赌场灯光。普通行以排名、头像、昵称、预测分、准确率和命中次数为主，使用 divider 而不是巨大 Card。

---

## 17. Profile Components

```text
UserIdentity
LevelBadge
StatsGrid
StatItem
CareerPoints
UnlockPreview
SettingRow
SectionHeader
```

Profile 页面层级：

1. `UserIdentity` + 本赛季等级：品牌识别与当前状态。
2. `StatsGrid`：胜平负准确率、有效预测场次、生涯积分、精确命中。
3. `UnlockPreview` / `SettingRow`：次级入口，不抢主视觉。

可以使用 Hero / Section，不要求所有统计都进入白色 Card。

---

## 18. Feedback System

```text
Toast
Dialog
BottomSheet
InlineNotice
Loading
Skeleton
EmptyState
ErrorState
SuccessFeedback
```

### 18.1 状态规则

- `Loading`：保留页面结构，使用低对比 Skeleton，避免闪现空态。
- `EmptyState`：说明当前没有什么，并给出日期 / 联赛 / 重试方向。
- `ErrorState`：显示可理解错误和「重试」，不直接展示内部 code 作为主文案。
- `Offline`：页面可读内容保留，操作按钮 disabled 或提示重新连接。
- `Processing`：按钮保留原尺寸，避免提交时布局跳动。
- `SuccessFeedback`：短暂成功反馈后回到稳定的 `submitted_locked`。

### 18.2 预测提交

```text
editing       editor 可操作
confirming    确认比分与推导结果
submitting    CTA loading + 防重复
success       短暂成功提示
submitted_locked 自动收缩，显示我的预测 / 已预测 / 已锁定
```

---

## 19. Motion

```text
motion-fast    120ms
motion-normal  220ms
motion-slow    320ms
ease           cubic-bezier(0.2, 0.8, 0.2, 1)
```

允许的功能型动画：

- MatchCard 展开 / 收缩
- Button press
- Tag 状态变化
- Bottom Sheet 出入
- Success feedback
- Skeleton shimmer
- live 小圆点 pulse

动画必须可被 reduced-motion 设置关闭；不使用持续炫光、金币飞入、庆祝爆炸等博彩化动效。

---

## 20. Layout Patterns

### Page / Standard

Header → Section / Filter → Content → optional Sticky Action → TabBar。

### Page / Dense List

Compact Header → Tabs / Filter → Divider List → Pagination / Load More。减少 Card shadow，保留 12–16rpx 行间距。

### Page / Profile

UserIdentity Hero → Stats Section → Unlock / History → Settings Rows。

### Page / Selection

Header → SearchField → Grid / List → selected state → Sticky confirm action。

### Page / Detail

Header → Hero / MatchSummary → Prediction / Result Section → Sticky Action。二级页面默认不显示 TabBar。

### Page / Share Card

独立画布比例、强化品牌背景和数字层级；不要求复制 App Card，但必须使用相同的颜色、字体和状态语义。

---

## 21. Bottom Navigation

一级页面固定为：

```text
比赛    排行榜    我的
```

当前仓库 MVP 仍保留历史导航配置；视觉系统以用户产品架构中的三级导航为目标，实际路由变更需单独评审，不在本次 Design System 整理中修改。

规则：

- 当前项使用 `color-primary` + active icon。
- 非当前项使用 `color-text-muted`。
- TabBar 适配 bottom safe area。
- 二级页面默认隐藏 TabBar。
- 导航图标尺寸统一，文字不使用过小字号。

---

## 22. Responsive / Safe Area / Accessibility

目标宽度：375–430px，主要参考 390px。

- 页面横向 padding 默认 32rpx。
- 所有主要按钮、日期、Stepper、Tab 至少 88rpx 点击区域。
- 中文正文不低于 24rpx；辅助文字不低于 20rpx，避免长时间阅读疲劳。
- 队名允许动态内容；优先单行省略，必要时使用两行布局，不覆盖比分区。
- 比分、排名、积分使用数字字体并保持足够对比度。
- 状态不能只靠颜色；必须配合文字 / icon / 形状。
- 顶部和底部使用 `env(safe-area-inset-top/bottom)`。
- 预测、积分、准确率等信息必须支持动态长度，不能依赖固定宽度硬编码。
- 未来多语言时，按钮与状态 Tag 需要允许文本变长 30% 以上。

---

## 23. Component States Matrix

| Component | Default | Active | Disabled | Loading | Success / Result |
|---|---|---|---|---|---|
| MatchCard | collapsed | editing | prediction_closed | submitting | submitted_locked / finished |
| Button | primary | pressed | disabled | loading | success feedback |
| Tag | default | active | muted | processing | hit / exact / miss |
| ScoreStepper | editable | focused | boundary | saving | confirmed |
| RankingRow | normal | current user | unavailable | skeleton | updated |
| SettingRow | normal | pressed | unavailable | loading | saved |
| EmptyState | guidance | CTA focus | — | — | — |

---

## 24. Do / Don’t

### Do

- 复用 semantic token。
- 用文字 + icon / 形状 + 颜色表达状态。
- 首页用 MatchCard，排行榜和历史用 Dense Row。
- 用绿色调 shadow，保持轻盈。
- 保持「用户ID」「今天看哪场？」等真实产品语气。
- 对长队名、无比分、延期和网络错误做真实状态设计。

### Don’t

- 不允许每页重新发明颜色、圆角、shadow。
- 不把所有信息塞进白色 Card。
- 不大量使用渐变按钮或 Glassmorphism。
- 不使用 Emoji 作为正式 UI icon。
- 不使用金币、筹码、赔率、奖金或赌场式倒计时。
- 不用红绿输赢刺激视觉；红色只用于明确错误或危险操作。
- 不让状态只靠颜色传达。
- 不用首页卡片尺寸直接复制排行榜和历史列表。

---

## 25. Token Usage / Extension Rule

新页面开发优先级：

1. 优先复用现有 token。
2. 优先复用现有 Component。
3. 不能表达时增加 Component Variant。
4. 确实无法表达时才增加全局 token。

新增 token 必须在代码 Review 或页面 PR 中说明：

```text
为什么现有系统无法满足？
它是否至少会被两个场景复用？
它属于 primitive 还是 semantic？
是否同时需要 WXSS / Web 镜像？
```

禁止：

```text
--green1
--box2
--bigText
--specialCardColor
```

推荐：

```text
--color-surface-card
--color-text-primary
--match-live
--prediction-hit-exact
--space-6
--radius-card
--shadow-card
--button-primary-bg
```

---

## 26. Current Source Audit

本次整理只新增 token 与文档，没有改变首页视觉。当前首页中已经存在的重复值，后续可以逐步迁移到 token，但必须进行截图回归后再合并：

- 页面绿色、文字绿色、muted 灰绿已归并到 primitive / semantic token。
- 比赛状态竖条已归并到 match state token。
- Card、CTA、日期和联赛托盘的圆角已归并到 radius token。
- Card、CTA、日期的阴影已归并到 elevation token。
- 中文字体与数字字体角色已明确。
- 首页 `league-logo` / `crest` 当前仍有文字 fallback；正式 Logo 资源补齐后应保持尺寸和布局不变。
- 当前首页设计稿中的 Web 字体引用与微信小程序的系统字体策略不同；生产小程序优先保证本地可用和中文稳定显示。

### 已新增文件

```text
/home/football/docs/UI_DESIGN_SYSTEM.md
/home/football/docs/design/tokens.css
/home/football/docs/design/赛事预言家首页-高保真-v8.6-联赛无底.html
/home/football/miniprogram/styles/design-tokens.wxss
```

`miniprogram/app.wxss` 已引入共享 WXSS token；首页现有页面规则保持原样，方便后续逐组件迁移和视觉回归。
